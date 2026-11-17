#!/usr/bin/env node
// code-search.mjs v1.1 — MCP-сервер поиска и статического анализа по XML-выгрузке 1С для OpenCode:
// объекты метаданных по смыслу (имя, синоним, реквизиты, типы), граф связей объекта (object_refs: подписки,
// движения регистров, перехваты CFE, где используется как тип), методы с кодом и перехватами, список методов модуля,
// места вызова (включая Form.xml, подписки, регламентные задания, HTTP/Web-сервисы), статическая валидация запросов
// по схеме метаданных (validate_query) и чтение Журнала регистрации 1Cv8.lgd / *.lgp со стек-трейсами (event_log).
// CLI: node code-search.mjs --semantic-build [--root DIR] [--force] | --semantic-status [--root DIR]

import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { join, relative, sep, resolve, basename } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { startServer } from './lib/stdio-server.mjs';
import { agentVersion, instructionSuffix, agentBanner, autocheckStatusText } from './lib/agent-meta.mjs';
import * as sem from './lib/semantic.mjs';
import { validateQuery } from './lib/query-validator.mjs';
import { readEventLog } from './lib/event-log.mjs';

const INDEX_VERSION = 5;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.agents', '.opencode', 'build', 'base', 'tools', 'test-tmp', '.v8-xsd']);

// Каталог выгрузки → вид объекта (рус.) и англ. синоним вида для поиска
export const TYPES = {
  Catalogs: ['Справочник', 'Catalog'], Documents: ['Документ', 'Document'], DocumentJournals: ['ЖурналДокументов', 'DocumentJournal'],
  Enums: ['Перечисление', 'Enum'], Reports: ['Отчет', 'Report'], DataProcessors: ['Обработка', 'DataProcessor'],
  InformationRegisters: ['РегистрСведений', 'InformationRegister'], AccumulationRegisters: ['РегистрНакопления', 'AccumulationRegister'],
  AccountingRegisters: ['РегистрБухгалтерии', 'AccountingRegister'], CalculationRegisters: ['РегистрРасчета', 'CalculationRegister'],
  ChartsOfCharacteristicTypes: ['ПланВидовХарактеристик', 'ChartOfCharacteristicTypes'], ChartsOfAccounts: ['ПланСчетов', 'ChartOfAccounts'],
  ChartsOfCalculationTypes: ['ПланВидовРасчета', 'ChartOfCalculationTypes'], BusinessProcesses: ['БизнесПроцесс', 'BusinessProcess'],
  Tasks: ['Задача', 'Task'], ExchangePlans: ['ПланОбмена', 'ExchangePlan'], Constants: ['Константа', 'Constant'],
  CommonModules: ['ОбщийМодуль', 'CommonModule'], CommonForms: ['ОбщаяФорма', 'CommonForm'], CommonCommands: ['ОбщаяКоманда', 'CommonCommand'],
  Subsystems: ['Подсистема', 'Subsystem'], Roles: ['Роль', 'Role'], DefinedTypes: ['ОпределяемыйТип', 'DefinedType'],
  FilterCriteria: ['КритерийОтбора', 'FilterCriterion'], SettingsStorages: ['ХранилищеНастроек', 'SettingsStorage'],
  HTTPServices: ['HTTPСервис', 'HTTPService'], WebServices: ['WebСервис', 'WebService'], EventSubscriptions: ['ПодпискаНаСобытие', 'EventSubscription'],
  ScheduledJobs: ['РегламентноеЗадание', 'ScheduledJob'], CommonTemplates: ['ОбщийМакет', 'CommonTemplate'],
  CommonAttributes: ['ОбщийРеквизит', 'CommonAttribute'], FunctionalOptions: ['ФункциональнаяОпция', 'FunctionalOption'],
  SessionParameters: ['ПараметрСеанса', 'SessionParameter'], XDTOPackages: ['ПакетXDTO', 'XDTOPackage'], Sequences: ['Последовательность', 'Sequence'],
};
const TYPE_ALIASES = new Map();
for (const [dir, [ru, en]] of Object.entries(TYPES)) {
  for (const k of [dir, ru, en, ru + 'ы', ru + 'и']) TYPE_ALIASES.set(k.toLowerCase(), dir);
}
TYPE_ALIASES.set('справочники', 'Catalogs'); TYPE_ALIASES.set('документы', 'Documents');
TYPE_ALIASES.set('общиемодули', 'CommonModules'); TYPE_ALIASES.set('обработки', 'DataProcessors');
TYPE_ALIASES.set('отчеты', 'Reports'); TYPE_ALIASES.set('регистрысведений', 'InformationRegisters');
TYPE_ALIASES.set('регистрынакопления', 'AccumulationRegisters'); TYPE_ALIASES.set('перечисления', 'Enums');
TYPE_ALIASES.set('регистрыбухгалтерии', 'AccountingRegisters'); TYPE_ALIASES.set('регистрырасчета', 'CalculationRegisters');
TYPE_ALIASES.set('определяемыетипы', 'DefinedTypes'); TYPE_ALIASES.set('подпискинасобытия', 'EventSubscriptions');
TYPE_ALIASES.set('регламентныезадания', 'ScheduledJobs'); TYPE_ALIASES.set('пвх', 'ChartsOfCharacteristicTypes');
TYPE_ALIASES.set('плансчетов', 'ChartsOfAccounts'); TYPE_ALIASES.set('пвр', 'ChartsOfCalculationTypes');

const MODULE_KINDS = {
  ObjectModule: 'МодульОбъекта', ManagerModule: 'МодульМенеджера', RecordSetModule: 'МодульНабораЗаписей',
  ValueManagerModule: 'МодульМенеджераЗначения', CommandModule: 'МодульКоманды', Module: 'Модуль',
  ManagedApplicationModule: 'МодульУправляемогоПриложения', SessionModule: 'МодульСеанса',
  ExternalConnectionModule: 'МодульВнешнегоСоединения', OrdinaryApplicationModule: 'МодульОбычногоПриложения',
};

const REF_TYPE_MAP = {
  CatalogRef: 'СправочникСсылка', DocumentRef: 'ДокументСсылка', EnumRef: 'ПеречислениеСсылка',
  ChartOfAccountsRef: 'ПланСчетовСсылка', ChartOfCharacteristicTypesRef: 'ПланВидовХарактеристикСсылка',
  ChartOfCalculationTypesRef: 'ПланВидовРасчетаСсылка', ExchangePlanRef: 'ПланОбменаСсылка',
  BusinessProcessRef: 'БизнесПроцессСсылка', TaskRef: 'ЗадачаСсылка',
};

const OBJECT_TYPE_MAP = {
  CatalogObject: 'СправочникОбъект', DocumentObject: 'ДокументОбъект',
  ChartOfAccountsObject: 'ПланСчетовОбъект', ChartOfCharacteristicTypesObject: 'ПланВидовХарактеристикОбъект',
  ChartOfCalculationTypesObject: 'ПланВидовРасчетаОбъект', BusinessProcessObject: 'БизнесПроцессОбъект',
  TaskObject: 'ЗадачаОбъект', ExchangePlanObject: 'ПланОбменаОбъект',
  InformationRegisterRecordSet: 'НаборЗаписейРегистраСведений', AccumulationRegisterRecordSet: 'НаборЗаписейРегистраНакопления',
  AccountingRegisterRecordSet: 'НаборЗаписейРегистраБухгалтерии', CalculationRegisterRecordSet: 'НаборЗаписейРегистраРасчета',
  SequenceRecordSet: 'НаборЗаписейПоследовательности',
  CatalogManager: 'СправочникМенеджер', DocumentManager: 'ДокументМенеджер',
  DocumentJournalManager: 'ЖурналДокументовМенеджер', EnumManager: 'ПеречислениеМенеджер',
  ConstantValueManager: 'КонстантаМенеджерЗначения', InformationRegisterManager: 'РегистрСведенийМенеджер',
  AccumulationRegisterManager: 'РегистрНакопленияМенеджер', AccountingRegisterManager: 'РегистрБухгалтерииМенеджер',
  CalculationRegisterManager: 'РегистрРасчетаМенеджер', ChartOfAccountsManager: 'ПланСчетовМенеджер',
  ChartOfCharacteristicTypesManager: 'ПланВидовХарактеристикМенеджер', ChartOfCalculationTypesManager: 'ПланВидовРасчетаМенеджер',
  ExchangePlanManager: 'ПланОбменаМенеджер', BusinessProcessManager: 'БизнесПроцессМенеджер',
  TaskManager: 'ЗадачаМенеджер', DataProcessorManager: 'ОбработкаМенеджер', ReportManager: 'ОтчетМенеджер',
};

const SOURCE_PREFIX_TO_DIR = {
  СправочникОбъект: 'Catalogs', СправочникМенеджер: 'Catalogs', СправочникСсылка: 'Catalogs',
  ДокументОбъект: 'Documents', ДокументМенеджер: 'Documents', ДокументСсылка: 'Documents',
  ПланСчетовОбъект: 'ChartsOfAccounts', ПланСчетовМенеджер: 'ChartsOfAccounts', ПланСчетовСсылка: 'ChartsOfAccounts',
  ПланВидовХарактеристикОбъект: 'ChartsOfCharacteristicTypes', ПланВидовХарактеристикМенеджер: 'ChartsOfCharacteristicTypes', ПланВидовХарактеристикСсылка: 'ChartsOfCharacteristicTypes',
  ПланВидовРасчетаОбъект: 'ChartsOfCalculationTypes', ПланВидовРасчетаМенеджер: 'ChartsOfCalculationTypes', ПланВидовРасчетаСсылка: 'ChartsOfCalculationTypes',
  БизнесПроцессОбъект: 'BusinessProcesses', БизнесПроцессМенеджер: 'BusinessProcesses', БизнесПроцессСсылка: 'BusinessProcesses',
  ЗадачаОбъект: 'Tasks', ЗадачаМенеджер: 'Tasks', ЗадачаСсылка: 'Tasks',
  ПланОбменаОбъект: 'ExchangePlans', ПланОбменаМенеджер: 'ExchangePlans', ПланОбменаСсылка: 'ExchangePlans',
  НаборЗаписейРегистраСведений: 'InformationRegisters', РегистрСведенийМенеджер: 'InformationRegisters',
  НаборЗаписейРегистраНакопления: 'AccumulationRegisters', РегистрНакопленияМенеджер: 'AccumulationRegisters',
  НаборЗаписейРегистраБухгалтерии: 'AccountingRegisters', РегистрБухгалтерииМенеджер: 'AccountingRegisters',
  НаборЗаписейРегистраРасчета: 'CalculationRegisters', РегистрРасчетаМенеджер: 'CalculationRegisters',
  НаборЗаписейПоследовательности: 'Sequences', КонстантаМенеджерЗначения: 'Constants',
  ПеречислениеСсылка: 'Enums', ПеречислениеМенеджер: 'Enums',
  ОпределяемыйТип: 'DefinedTypes', Характеристика: 'ChartsOfCharacteristicTypes',
};

const EVENT_MAP_RU = {
  BeforeWrite: 'ПередЗаписью', OnWrite: 'ПриЗаписи', AfterWrite: 'ПослеЗаписи',
  BeforeDelete: 'ПередУдалением', Posting: 'ОбработкаПроведения', UndoPosting: 'ОбработкаУдаленияПроведения',
  OnReadAtServer: 'ПриЧтенииНаСервере', FillCheckProcessing: 'ОбработкаПроверкиЗаполнения',
  Filling: 'ОбработкаЗаполнения', OnCopy: 'ПриКопировании', OnSetNewCode: 'ПриУстановкеНовогоКода',
  OnSetNewNumber: 'ПриУстановкеНовогоНомера',
};

// ---------------------------------------------------------------------------
// Текст
// ---------------------------------------------------------------------------
const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');
// «ИсторияЗадачПользователя» → история задач пользователя; «ИИА_Диалоги» → ииа диалоги
function words(s) {
  return norm(String(s || '')
    .replace(/([а-яёa-z0-9])([А-ЯЁA-Z])/g, '$1 $2')
    .replace(/([A-ZА-ЯЁ]+)([A-ZА-ЯЁ][а-яёa-z])/g, '$1 $2'))
    .split(/[^a-zа-я0-9]+/).filter((w) => w.length > 1);
}
// Простое «стеммирование»: сравниваем по основе (без окончания), чтобы «задачи» находило «задача»
const stem = (w) => (w.length > 5 ? w.slice(0, w.length - 2) : w.length > 3 ? w.slice(0, w.length - 1) : w);

export function readText(file) {
  return readFileSync(file, 'utf8').replace(/^﻿/, '');
}

// ---------------------------------------------------------------------------
// Разбор
// ---------------------------------------------------------------------------
const RX_NAME = /<Properties>\s*<Name>([^<]+)<\/Name>/;
const RX_SYN_ITEM = /<v8:lang>([^<]*)<\/v8:lang>\s*<v8:content>([^<]*)<\/v8:content>/g;

function synonymOf(block) {
  const m = block.match(/<Synonym>([\s\S]*?)<\/Synonym>/);
  if (!m) return '';
  let first = '';
  for (const it of m[1].matchAll(RX_SYN_ITEM)) {
    if (!first) first = it[2];
    if (it[1] === 'ru') return it[2];
  }
  return first;
}

function unescapeXml(s) {
  return String(s).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function formatSingleXmlType(raw, typeBlock, isTypeSet = false) {
  raw = String(raw || '').trim().replace(/^d\d+p\d+:/, 'cfg:');
  if (!raw) return '';
  if (isTypeSet) {
    let m = raw.match(/^cfg:DefinedType\.(.+)$/);
    if (m) return `ОпределяемыйТип.${m[1]}`;
    m = raw.match(/^cfg:Characteristic\.(.+)$/);
    if (m) return `Характеристика.${m[1]}`;
    if (raw === 'cfg:AnyRef') return 'ЛюбаяСсылка';
    if (raw === 'cfg:AnyIBRef') return 'ЛюбаяСсылкаИБ';
    m = raw.match(/^cfg:(\w+Ref)$/);
    if (m && REF_TYPE_MAP[m[1]]) return `${REF_TYPE_MAP[m[1]]} (все)`;
    m = raw.match(/^cfg:(\w+)$/);
    if (m && OBJECT_TYPE_MAP[m[1]]) return `${OBJECT_TYPE_MAP[m[1]]} (все)`;
    return raw.replace(/^cfg:/, '');
  }
  if (raw === 'xs:string') {
    const len = (typeBlock.match(/<v8:Length>(\d+)<\/v8:Length>/) || [])[1];
    return len && len !== '0' ? `Строка(${len})` : 'Строка';
  }
  if (raw === 'xs:decimal') {
    const d = (typeBlock.match(/<v8:Digits>(\d+)<\/v8:Digits>/) || [])[1];
    const f = (typeBlock.match(/<v8:FractionDigits>(\d+)<\/v8:FractionDigits>/) || [])[1] || '0';
    return d ? `Число(${d},${f})` : 'Число';
  }
  if (raw === 'xs:boolean') return 'Булево';
  if (raw === 'xs:dateTime') {
    const df = (typeBlock.match(/<v8:DateFractions>([^<]+)<\/v8:DateFractions>/) || [])[1];
    if (df === 'Date') return 'Дата';
    if (df === 'Time') return 'Время';
    return 'ДатаВремя';
  }
  if (raw === 'v8:ValueStorage') return 'ХранилищеЗначения';
  if (raw === 'v8:UUID') return 'УникальныйИдентификатор';
  if (raw === 'xs:base64Binary') return 'ДвоичныеДанные';
  if (raw === 'v8:Null') return 'Null';
  let m = raw.match(/^cfg:(\w+Ref)\.(.+)$/);
  if (m && REF_TYPE_MAP[m[1]]) return `${REF_TYPE_MAP[m[1]]}.${m[2]}`;
  m = raw.match(/^cfg:DefinedType\.(.+)$/);
  if (m) return `ОпределяемыйТип.${m[1]}`;
  m = raw.match(/^cfg:Characteristic\.(.+)$/);
  if (m) return `Характеристика.${m[1]}`;
  m = raw.match(/^cfg:(\w+)\.(.+)$/);
  if (m && OBJECT_TYPE_MAP[m[1]]) return `${OBJECT_TYPE_MAP[m[1]]}.${m[2]}`;
  m = raw.match(/^cfg:(\w+)$/);
  if (m && OBJECT_TYPE_MAP[m[1]]) return OBJECT_TYPE_MAP[m[1]];
  return raw.replace(/^cfg:/, '');
}

export function parseTypesXml(block, tag = 'Type') {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  if (!m) return [];
  const inner = m[1];
  const out = [];
  for (const tm of inner.matchAll(/<v8:(Type|TypeSet)>([^<]+)<\/v8:\1>/g)) {
    const formatted = formatSingleXmlType(tm[2], inner, tm[1] === 'TypeSet');
    if (formatted) out.push(formatted);
  }
  return out;
}

// Нормализует английское имя ссылки на метаданные ("AccumulationRegister.Товары" → "РегистрНакопления.Товары")
function normalizeMdRef(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^([A-Za-zА-Яа-яЁё]+)\.(.+)$/);
  if (!m) return s;
  const dir = TYPE_ALIASES.get(norm(m[1]));
  if (dir && TYPES[dir]) return `${TYPES[dir][0]}.${m[2]}`;
  return s;
}

// Объект метаданных: имя, синоним, реквизиты с типами, табличные части, движения, подписки, регламентные задания и др.
export function parseObjectXml(text) {
  const name = (text.match(RX_NAME) || [])[1];
  if (!name) return null;
  const childIdx = text.indexOf('<ChildObjects>');
  const head = text.slice(0, childIdx > 0 ? childIdx : text.length);
  const obj = {
    name,
    syn: unescapeXml(synonymOf(head)),
    adopted: /<ObjectBelonging>Adopted<\/ObjectBelonging>/.test(head),
    attrs: [],
    ts: [],
  };

  // Типы самого объекта (для DefinedType, Constant, ChartOfCharacteristicTypes, CommonAttribute)
  const headTypes = parseTypesXml(head, 'Type');
  if (headTypes.length) obj.types = headTypes;

  // Иерархия, длина кода/наименования/номера, периодичность и вид регистра
  if (/<Hierarchical>true<\/Hierarchical>/.test(head)) obj.hierarchical = true;
  else if (/<Hierarchical>false<\/Hierarchical>/.test(head)) obj.hierarchical = false;
  const codeLen = (head.match(/<CodeLength>(\d+)<\/CodeLength>/) || [])[1];
  if (codeLen !== undefined) obj.codeLength = Number(codeLen);
  const descLen = (head.match(/<DescriptionLength>(\d+)<\/DescriptionLength>/) || [])[1];
  if (descLen !== undefined) obj.descriptionLength = Number(descLen);
  const numLen = (head.match(/<NumberLength>(\d+)<\/NumberLength>/) || [])[1];
  if (numLen !== undefined) obj.numberLength = Number(numLen);

  const per = (head.match(/<InformationRegisterPeriodicity>([^<]+)<\/InformationRegisterPeriodicity>/) || [])[1];
  if (per) obj.periodicity = per;
  const wm = (head.match(/<WriteMode>([^<]+)<\/WriteMode>/) || [])[1];
  if (wm) obj.writeMode = wm;
  const rt = (head.match(/<RegisterType>([^<]+)<\/RegisterType>/) || [])[1];
  if (rt) obj.registerType = rt;

  // Владельцы справочника (<Owners>)
  const ownersBlock = (head.match(/<Owners>([\s\S]*?)<\/Owners>/) || [])[1];
  if (ownersBlock) {
    const owners = [...ownersBlock.matchAll(/<xr:Item\b[^>]*>([^<]+)<\/xr:Item>/g)].map((m) => normalizeMdRef(m[1]));
    if (owners.length) obj.owners = owners;
  }

  // Движения документа по регистрам (<RegisterRecords>)
  const regRecBlock = (head.match(/<RegisterRecords>([\s\S]*?)<\/RegisterRecords>/) || [])[1];
  if (regRecBlock) {
    const recs = [...regRecBlock.matchAll(/<xr:Item\b[^>]*>([^<]+)<\/xr:Item>/g)].map((m) => normalizeMdRef(m[1]));
    if (recs.length) obj.registerRecords = recs;
  }

  // Ввод на основании (<BasedOn>)
  const basedOnBlock = (head.match(/<BasedOn>([\s\S]*?)<\/BasedOn>/) || [])[1];
  if (basedOnBlock) {
    const based = [...basedOnBlock.matchAll(/<xr:Item\b[^>]*>([^<]+)<\/xr:Item>/g)].map((m) => normalizeMdRef(m[1]));
    if (based.length) obj.basedOn = based;
  }

  // Подписка на событие (EventSubscription): <Event>, <Handler>, <Source>
  const evMatch = (head.match(/<Event>([^<]+)<\/Event>/) || [])[1];
  const handlerMatch = (head.match(/<Handler>([^<]+)<\/Handler>/) || [])[1];
  if (evMatch || handlerMatch) {
    const sources = parseTypesXml(head, 'Source');
    if (evMatch || sources.length) {
      obj.subscription = {
        event: EVENT_MAP_RU[evMatch] || evMatch || '',
        rawEvent: evMatch || '',
        handler: normalizeMdRef(handlerMatch || ''),
        sources,
      };
    }
  }

  // Регламентное задание (ScheduledJob): <MethodName>
  const sjMethod = (head.match(/<MethodName>([^<]+)<\/MethodName>/) || [])[1];
  if (sjMethod) {
    obj.scheduledJob = {
      methodName: normalizeMdRef(sjMethod),
      use: /<Use>true<\/Use>/.test(head),
    };
  }

  // Функциональная опция (FunctionalOption): <Location>, <Content>
  const foLoc = (head.match(/<Location>([^<]+)<\/Location>/) || [])[1];
  if (foLoc) obj.location = normalizeMdRef(foLoc);
  const contentBlock = (head.match(/<Content>([\s\S]*?)<\/Content>/) || [])[1];
  if (contentBlock) {
    const foObjs = [...contentBlock.matchAll(/<xr:Object>([^<]+)<\/xr:Object>/g)].map((m) => normalizeMdRef(m[1]));
    if (foObjs.length) obj.foContent = foObjs;
    // Для CommonAttribute: <xr:Item><xr:Metadata>...</xr:Metadata><xr:Use>Use|DontUse</xr:Use></xr:Item>
    const caItems = [...contentBlock.matchAll(/<xr:Item>[\s\S]*?<xr:Metadata>([^<]+)<\/xr:Metadata>[\s\S]*?<xr:Use>([^<]+)<\/xr:Use>[\s\S]*?<\/xr:Item>/g)];
    if (caItems.length) {
      obj.contentUse = {};
      for (const it of caItems) {
        obj.contentUse[norm(normalizeMdRef(it[1]))] = it[2] === 'Use';
      }
    }
  }
  if (/<AutoUse>Use<\/AutoUse>/.test(head)) obj.autoUse = true;

  const child = childIdx > 0 ? text.slice(childIdx) : '';

  // HTTPService: шаблоны URL и обработчики методов
  if (child.includes('<URLTemplate')) {
    const httpMethods = [];
    for (const tm of child.matchAll(/<URLTemplate\b[^>]*>([\s\S]*?)<\/URLTemplate>/g)) {
      const tplName = (tm[1].match(RX_NAME) || [])[1] || '';
      const tplPath = (tm[1].match(/<Template>([^<]*)<\/Template>/) || [])[1] || '';
      for (const mm of tm[1].matchAll(/<Method\b[^>]*>([\s\S]*?)<\/Method>/g)) {
        const mName = (mm[1].match(RX_NAME) || [])[1] || '';
        const httpVerb = (mm[1].match(/<HTTPMethod>([^<]+)<\/HTTPMethod>/) || [])[1] || '';
        const hnd = (mm[1].match(/<Handler>([^<]+)<\/Handler>/) || [])[1] || '';
        if (hnd) httpMethods.push({ template: tplPath || tplName, name: mName, httpMethod: httpVerb, handler: hnd });
      }
    }
    if (httpMethods.length) obj.httpMethods = httpMethods;
  }

  // WebService: операции и ProcedureName
  if (child.includes('<Operation')) {
    const wsOps = [];
    for (const om of child.matchAll(/<Operation\b[^>]*>([\s\S]*?)<\/Operation>/g)) {
      const opName = (om[1].match(RX_NAME) || [])[1] || '';
      const proc = (om[1].match(/<ProcedureName>([^<]+)<\/ProcedureName>/) || [])[1] || '';
      if (proc) wsOps.push({ name: opName, handler: proc });
    }
    if (wsOps.length) obj.wsOperations = wsOps;
  }

  // Табличные части — отдельно, чтобы их реквизиты не смешались с реквизитами объекта
  const tsRx = /<TabularSection\b[^>]*>([\s\S]*?)<\/TabularSection>/g;
  let rest = child;
  for (const m of child.matchAll(tsRx)) {
    const tname = (m[1].match(RX_NAME) || [])[1];
    if (!tname) continue;
    const tsHead = m[1].slice(0, m[1].indexOf('<ChildObjects>') > 0 ? m[1].indexOf('<ChildObjects>') : m[1].length);
    const ts = { name: tname, syn: unescapeXml(synonymOf(tsHead)), attrs: [] };
    for (const a of m[1].matchAll(/<Attribute\b[^>]*>([\s\S]*?)<\/Attribute>/g)) {
      const an = (a[1].match(RX_NAME) || [])[1];
      if (an) {
        const req = /<FillChecking>ShowError<\/FillChecking>/.test(a[1]);
        ts.attrs.push(req
          ? [an, unescapeXml(synonymOf(a[1])), parseTypesXml(a[1], 'Type'), true]
          : [an, unescapeXml(synonymOf(a[1])), parseTypesXml(a[1], 'Type')]);
      }
    }
    obj.ts.push(ts);
    rest = rest.replace(m[0], '');
  }
  for (const tag of ['Attribute', 'Dimension', 'Resource', 'AccountingFlag', 'ExtDimensionAccountingFlag', 'AddressingAttribute', 'EnumValue']) {
    const rx = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'g');
    for (const a of rest.matchAll(rx)) {
      const an = (a[1].match(RX_NAME) || [])[1];
      if (an) {
        const req = /<FillChecking>ShowError<\/FillChecking>/.test(a[1]);
        obj.attrs.push(req
          ? [an, unescapeXml(synonymOf(a[1])), tag, tag === 'EnumValue' ? [] : parseTypesXml(a[1], 'Type'), true]
          : [an, unescapeXml(synonymOf(a[1])), tag, tag === 'EnumValue' ? [] : parseTypesXml(a[1], 'Type')]);
      }
    }
  }
  return obj;
}

// Разбор управляемой формы (Ext/Form.xml): события формы, события элементов и обработчики команд
export function parseFormXml(text) {
  const events = [];
  const commands = [];
  // Команды формы: <Command name="..."><Action ...>Обработчик</Action>
  const cmdsBlock = (text.match(/<Commands>([\s\S]*?)<\/Commands>/) || [])[1] || '';
  for (const cm of cmdsBlock.matchAll(/<Command\b[^>]*\bname="([^"]+)"[^>]*>([\s\S]*?)<\/Command>/g)) {
    const cmdName = cm[1];
    for (const am of cm[2].matchAll(/<Action\b[^>]*>([^<]+)<\/Action>/g)) {
      const handler = am[1].trim();
      if (handler) commands.push([cmdName, handler]);
    }
  }
  // Все блоки <Events><Event name="...">Обработчик</Event></Events>
  for (const em of text.matchAll(/<Event\b[^>]*\bname="([^"]+)"[^>]*>([^<]+)<\/Event>/g)) {
    const evtName = em[1].trim();
    const handler = em[2].trim();
    if (handler) events.push([evtName, handler]);
  }
  return { events, commands };
}

const RX_METHOD_START = /^\s*(?:Асинх\s+|Async\s+)?(Процедура|Функция|Procedure|Function)\s+([A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё]*)\s*\(/i;
// \b в JS не работает с кириллицей — границу слова проверяем явно
const RX_METHOD_END = /^\s*(КонецПроцедуры|КонецФункции|EndProcedure|EndFunction)(?![\wА-Яа-яЁё])/i;
const RX_EXPORT = /\)\s*(Экспорт|Export)(?![\wА-Яа-яЁё])/i;
const RX_INTERCEPTOR = /^&\s*(Перед|После|Вместо|ИзменениеИКонтроль|Before|After|Around|ChangeAndValidate)\s*\(\s*"([^"]+)"\s*\)/i;
const INTERCEPT_NORM = {
  перед: 'Перед', before: 'Перед',
  после: 'После', after: 'После',
  вместо: 'Вместо', around: 'Вместо',
  изменениеиконтроль: 'ИзменениеИКонтроль', changeandvalidate: 'ИзменениеИКонтроль',
};

// Методы модуля: имя, строки начала/конца, экспорт, директива компиляции, аннотация перехвата CFE,
// плюс список вызываемых в модуле имён процедур/функций (calls) для мгновенного find_usages без полного сканирования диска.
const RX_CALL_TOKEN = /([A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё]*)\s*\(/g;
const CALL_STOP = new Set([
  'процедура', 'функция', 'procedure', 'function', 'если', 'if', 'пока', 'while', 'для', 'for',
  'вызватьисключение', 'raise', 'возврат', 'return', 'новый', 'new', 'тип', 'type', 'типзнч', 'typeof',
  'формат', 'format', 'нстр', 'nstr', 'стрдлина', 'strlen', 'сокрлп', 'trimall', 'сокрл', 'triml', 'сокрп', 'trimr',
  'лев', 'left', 'прав', 'right', 'сред', 'mid', 'стрнайти', 'strfind', 'врегистр', 'upper', 'нрегистр', 'lower',
  'стрзаменить', 'strreplace', 'стршаблон', 'strtemplate', 'число', 'number', 'строка', 'string', 'дата', 'date',
  'булево', 'boolean', 'значениезаполнено', 'valueisfilled', 'объединитьстроки', 'strconcat', 'стрразделить', 'strsplit',
]);

export function parseModuleInfo(text) {
  const lines = text.split(/\r?\n/);
  const methods = [];
  const callSet = new Set();
  let cur = null;
  let directives = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (!t.startsWith('//')) {
      for (const cm of line.matchAll(RX_CALL_TOKEN)) {
        const cn = norm(cm[1]);
        if (cn.length > 2 && !CALL_STOP.has(cn)) callSet.add(cn);
      }
    }
    if (!cur) {
      if (t.startsWith('&')) { directives.push(t); continue; }
      const m = line.match(RX_METHOD_START);
      if (m) {
        // сигнатура может занимать несколько строк — до закрывающей скобки
        let sig = t;
        let j = i;
        while (!sig.includes(')') && j < i + 30 && j + 1 < lines.length) { j++; sig += ' ' + lines[j].trim(); }
        let intercept = null;
        for (const d of directives) {
          const im = d.match(RX_INTERCEPTOR);
          if (im) intercept = { kind: INTERCEPT_NORM[im[1].toLowerCase()] || im[1], target: im[2] };
        }
        cur = {
          name: m[2],
          kind: /^(Функция|Function)$/i.test(m[1]) ? 'Функция' : 'Процедура',
          line: i + 1,
          export: RX_EXPORT.test(sig),
          dir: directives.join(' '),
          ...(intercept ? { intercept } : {}),
        };
      } else if (t && !t.startsWith('//') && !t.startsWith('#')) directives = [];
    } else if (RX_METHOD_END.test(line)) {
      cur.end = i + 1;
      methods.push(cur);
      cur = null;
      directives = [];
    }
  }
  if (cur) { cur.end = lines.length; methods.push(cur); }
  return { methods, calls: [...callSet] };
}

export function parseMethods(text) {
  return parseModuleInfo(text).methods;
}

// Модуль по пути относительно корня конфигурации: «Документ.Задача.МодульОбъекта», «ОбщийМодуль.Х»
export function moduleId(relPath) {
  const p = relPath.split(/[\\/]/);
  const file = basename(relPath, '.bsl');
  const kind = MODULE_KINDS[file] || file;
  if (p[0] === 'Ext') return kind;                                   // модули приложения/сеанса
  const type = TYPES[p[0]];
  if (!type) return relPath;
  const obj = `${type[0]}.${p[1]}`;
  if (p[0] === 'CommonModules') return obj;
  const iForm = p.indexOf('Forms');
  if (iForm >= 0 && p[iForm + 1]) return `${obj}.Форма.${p[iForm + 1]}`;
  if (p[0] === 'CommonForms') return obj;
  const iCmd = p.indexOf('Commands');
  if (iCmd >= 0 && p[iCmd + 1]) return `${obj}.Команда.${p[iCmd + 1]}`;
  return `${obj}.${kind}`;
}

export function formId(relPath) {
  const p = relPath.split(/[\\/]/);
  const type = TYPES[p[0]];
  if (!type) return relPath;
  const obj = `${type[0]}.${p[1]}`;
  if (p[0] === 'CommonForms') return obj;
  const iForm = p.indexOf('Forms');
  if (iForm >= 0 && p[iForm + 1]) return `${obj}.Форма.${p[iForm + 1]}`;
  return obj;
}

// ---------------------------------------------------------------------------
// Индекс
// ---------------------------------------------------------------------------
function findConfigRoots(root) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 5) return;
    let list;
    try { list = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (list.some((e) => e.isFile() && e.name === 'Configuration.xml')) { out.push(dir); return; }
    for (const e of list) if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(join(dir, e.name), depth + 1);
  };
  walk(root, 0);
  return out;
}

function listFilesByExt(dir, bslAcc = [], formXmlAcc = []) {
  let list;
  try { list = readdirSync(dir, { withFileTypes: true }); } catch { return { bslAcc, formXmlAcc }; }
  for (const e of list) {
    const p = join(dir, e.name);
    if (e.isDirectory()) listFilesByExt(p, bslAcc, formXmlAcc);
    else if (e.name.endsWith('.bsl')) bslAcc.push(p);
    else if (e.name === 'Form.xml') formXmlAcc.push(p);
  }
  return { bslAcc, formXmlAcc };
}

// Кэш — свой у каждого пользователя (на Linux /tmp общий; на Windows %TEMP% и так у каждого свой).
function cacheDir() {
  let user = 'user';
  try { user = userInfo().username.replace(/[^\w.-]/g, '_'); } catch { /* */ }
  return join(tmpdir(), `opencode-1c-search-${user}`);
}

function cacheFile(root) {
  const h = createHash('sha1').update(resolve(root)).digest('hex').slice(0, 16);
  return join(cacheDir(), `${h}.json`);
}

const indexes = new Map();   // root → { built, configs, objects, modules, forms }

function readDatabasesMap(root) {
  const v8ProjPath = join(root, '.v8-project.json');
  if (!existsSync(v8ProjPath)) return [];
  try {
    const proj = JSON.parse(readFileSync(v8ProjPath, 'utf8').replace(/^\uFEFF/, ''));
    const dbs = Array.isArray(proj.databases) ? proj.databases : [];
    return dbs.map((db) => {
      const prefixes = [];
      const addP = (p) => {
        if (!p) return;
        const r = relative(root, resolve(root, p)).split(sep).join('/');
        if (r && !r.startsWith('..')) prefixes.push(norm(r));
      };
      addP(db.configSrc);
      for (const ext of Array.isArray(db.extensions) ? db.extensions : []) {
        addP(ext.src || ext.path);
      }
      return {
        id: db.id || '',
        name: db.name || '',
        ref: db.ref || '',
        aliases: Array.isArray(db.aliases) ? db.aliases : [],
        prefixes: [...new Set(prefixes)],
      };
    });
  } catch {
    return [];
  }
}

export function buildIndex(root, { force = false } = {}) {
  root = resolve(root);
  const mem = indexes.get(root);
  if (mem && !force && Date.now() - mem.built < 20000) return mem;
  const started = Date.now();
  let cache = { version: INDEX_VERSION, files: {} };
  const cf = cacheFile(root);
  if (!force) {
    try {
      const c = JSON.parse(readFileSync(cf, 'utf8'));
      if (c.version === INDEX_VERSION) cache = c;
    } catch { /* нет кэша */ }
  }
  const files = {};
  let parsed = 0;
  const take = (file, parse) => {
    let st;
    try { st = statSync(file); } catch { return null; }
    const old = cache.files[file];
    if (old && old.m === st.mtimeMs && old.s === st.size) { files[file] = old; return old.d; }
    let d = null;
    try { d = parse(readText(file)); } catch { d = null; }
    parsed++;
    files[file] = { m: st.mtimeMs, s: st.size, d };
    return d;
  };

  const configs = findConfigRoots(root).map((dir) => {
    const cfgXml = (() => { try { return readText(join(dir, 'Configuration.xml')).slice(0, 20000); } catch { return ''; } })();
    const props = cfgXml.slice(cfgXml.indexOf('<Properties>'));
    const name = (props.match(/<Name>([^<]+)<\/Name>/) || [])[1] || basename(dir);
    const isExt = /<ConfigurationExtensionPurpose>|<NamePrefix>/.test(cfgXml);
    const prefix = (props.match(/<NamePrefix>([^<]+)<\/NamePrefix>/) || [])[1] || '';
    return { dir, rel: relative(root, dir).split(sep).join('/') || '.', name, isExt, prefix };
  });

  const objects = [];
  const modules = [];
  const forms = [];
  for (const c of configs) {
    for (const typeDir of Object.keys(TYPES)) {
      const d = join(c.dir, typeDir);
      let list;
      try { list = readdirSync(d); } catch { continue; }
      for (const f of list) {
        if (!f.endsWith('.xml')) continue;
        const o = take(join(d, f), parseObjectXml);
        if (o) objects.push({ ...o, type: typeDir, cfg: c.rel, isExt: c.isExt, file: join(d, f) });
      }
    }
    const { bslAcc, formXmlAcc } = listFilesByExt(c.dir);
    for (const f of bslAcc) {
      const modInfo = take(f, parseModuleInfo) || { methods: [], calls: [] };
      const methods = Array.isArray(modInfo) ? modInfo : (modInfo.methods || []);
      const calls = Array.isArray(modInfo) ? null : new Set(modInfo.calls || []);
      modules.push({ file: f, cfg: c.rel, isExt: c.isExt, id: moduleId(relative(c.dir, f)), methods, calls });
    }
    for (const f of formXmlAcc) {
      const fm = take(f, parseFormXml);
      if (fm && (fm.events.length || fm.commands.length)) {
        forms.push({ file: f, cfg: c.rel, id: formId(relative(c.dir, f)), events: fm.events, commands: fm.commands });
      }
    }
  }
  const databases = readDatabasesMap(root);
  const idx = { built: Date.now(), root, configs, objects, modules, forms, databases, parsed, ms: Date.now() - started };
  indexes.set(root, idx);
  if (parsed) {
    try {
      mkdirSync(cacheDir(), { recursive: true });
      writeFileSync(cf, JSON.stringify({ version: INDEX_VERSION, files }));
    } catch { /* кэш необязателен */ }
  }
  return idx;
}

// ---------------------------------------------------------------------------
// Инструменты
// ---------------------------------------------------------------------------
const rel = (idx, file) => relative(idx.root, file).split(sep).join('/');
const objTitle = (o) => `${TYPES[o.type][0]}.${o.name}`;
const cfgMark = (idx, cfg) => (idx.configs.length > 1 ? ` [${cfg}]` : '');

// Преобразует 32-символьный hex из навигационной ссылки 1С (e1cib/data/Вид.Имя?ref=...) в стандартный UUID 1С
export function refHexToUuid(hex) {
  const h = String(hex || '').trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(h)) return null;
  // В навигационной ссылке 1С первые 16 символов (8 байт) — это вторая половина UUID (data4),
  // а последние 16 символов — это первые 8 байт UUID (time_low, time_mid, time_hi_and_version).
  const p2 = h.slice(0, 16);
  const p1 = h.slice(16, 32);
  return `${p1.slice(0, 8)}-${p1.slice(8, 12)}-${p1.slice(12, 16)}-${p2.slice(0, 4)}-${p2.slice(4, 16)}`;
}

export function parseE1cibUrl(str) {
  const s = String(str || '').trim();
  const m = s.match(/(?:e1cib\/data\/)?([A-Za-zА-Яа-яЁё]+\.[A-Za-zА-Яа-яЁё0-9_]+)\?ref=([0-9a-fA-F]{32})/i);
  if (!m) return null;
  const objSpec = m[1];
  const refHex = m[2].toLowerCase();
  const uuid = refHexToUuid(refHex);
  return { objSpec, refHex, uuid };
}

// Строит фильтр путей по параметрам path_filter и/или database (из .v8-project.json)
export function makePathFilter(idx, { path_filter, database } = {}) {
  const pf = path_filter ? norm(String(path_filter).trim()).replace(/\\/g, '/') : '';
  const dbQ = database ? norm(String(database).trim()) : '';
  if (!pf && !dbQ) return () => true;

  let dbPrefixes = null;
  if (dbQ) {
    const dbs = idx.databases || [];
    const matched = dbs.find((d) => norm(d.id) === dbQ) ||
      dbs.find((d) => norm(d.ref) === dbQ) ||
      dbs.find((d) => d.aliases.some((a) => norm(a) === dbQ)) ||
      dbs.find((d) => norm(d.name).includes(dbQ)) ||
      dbs.find((d) => d.prefixes.some((p) => p.includes(dbQ)));
    if (matched && matched.prefixes.length) {
      dbPrefixes = matched.prefixes;
    } else {
      // Fallback: если база не описана в .v8-project.json, ищем по вхождению имени в путь (например src/DOC_20072026)
      dbPrefixes = [dbQ];
    }
  }

  return (fileOrRel) => {
    const r = norm(fileOrRel.includes(sep) || fileOrRel.startsWith('/') ? rel(idx, fileOrRel) : fileOrRel).replace(/\\/g, '/');
    if (pf && !r.includes(pf)) return false;
    if (dbPrefixes && !dbPrefixes.some((p) => r === p || r.startsWith(p + '/') || r.includes(p))) return false;
    return true;
  };
}

function scoreText(qStems, qFull, name, syn, weight) {
  const ws = new Set([...words(name), ...words(syn)].map(stem));
  let hit = 0;
  for (const q of qStems) if ([...ws].some((w) => w.startsWith(q) || q.startsWith(w))) hit++;
  let s = qStems.length ? (hit / qStems.length) * weight : 0;
  if (qFull && (norm(name) === qFull || norm(syn) === qFull)) s += weight;
  return s;
}

export function findObject(idx, { query, type, path_filter, database, limit = 10 }) {
  const e1cib = parseE1cibUrl(query);
  const effectiveQuery = e1cib ? e1cib.objSpec : query;
  const e1cibBanner = e1cib
    ? `[Навигационная ссылка 1С] Объект: ${e1cib.objSpec} · ref=${e1cib.refHex} → УникальныйИдентификатор: ${e1cib.uuid}\n` +
      `В BSL: ${e1cib.objSpec.replace(/^Справочник\./i, 'Справочники.').replace(/^Документ\./i, 'Документы.')}.ПолучитьСсылку(Новый УникальныйИдентификатор("${e1cib.uuid}"))\n\n`
    : '';
  const allowPath = makePathFilter(idx, { path_filter, database });
  const qn = norm(effectiveQuery).trim();
  // «Документ.Задача» / «Справочник Номенклатура» — тип в запросе
  let typeFilter = type ? TYPE_ALIASES.get(norm(type).replace(/\s+/g, '')) : null;
  let q = qn;
  const m = qn.match(/^([a-zа-я]+)[.\s]+(.+)$/);
  if (m && TYPE_ALIASES.has(m[1])) { typeFilter = typeFilter || TYPE_ALIASES.get(m[1]); q = m[2]; }
  const qStems = words(q).map(stem);
  const qFull = norm(q).replace(/\s+/g, '');
  const res = [];
  for (const o of idx.objects) {
    if (!allowPath(o.file)) continue;
    if (typeFilter && o.type !== typeFilter) continue;
    let s = scoreText(qStems, qFull, o.name, o.syn, 10);
    let why = '';
    if (norm(o.name) === qFull) s += 20;
    if (s < 10) {
      // совпадение по реквизиту или табличной части
      let best = 0;
      for (const [an, as, , , req] of o.attrs) {
        const sa = scoreText(qStems, qFull, an, as, 6);
        if (sa > best) { best = sa; why = `реквизит ${an}${as && as !== an ? ` «${as}»` : ''}${req ? ' [обяз.]' : ''}`; }
      }
      for (const t of o.ts) {
        const st = scoreText(qStems, qFull, t.name, t.syn, 6);
        if (st > best) { best = st; why = `табличная часть ${t.name}`; }
        for (const [an, as, , req] of t.attrs) {
          const sa = scoreText(qStems, qFull, an, as, 5);
          if (sa > best) { best = sa; why = `реквизит ТЧ ${t.name}.${an}${as && as !== an ? ` «${as}»` : ''}${req ? ' [обяз.]' : ''}`; }
        }
      }
      if (best > s) s = best; else why = '';
    }
    if (s >= 3) res.push({ o, s, why });
  }
  res.sort((a, b) => b.s - a.s || a.o.name.length - b.o.name.length);
  if (!res.length) return `${e1cibBanner}Ничего не найдено по «${query}». Объектов в индексе: ${idx.objects.length}.`;
  const out = res.slice(0, limit).map(({ o, why }) => {
    const regNote = o.registerRecords?.length ? `, движений ${o.registerRecords.length}` : '';
    const reqCount = (o.attrs || []).filter((a) => a[4]).length;
    const reqNote = reqCount ? ` (обяз. ${reqCount})` : '';
    return `- ${objTitle(o)}${o.syn && o.syn !== o.name ? ` — «${o.syn}»` : ''}${o.adopted ? ' (заимствован)' : ''}` +
      `${cfgMark(idx, o.cfg)}${why ? `; совпало: ${why}` : ''}\n  ${rel(idx, o.file)}; реквизитов ${o.attrs.length}${reqNote}, ТЧ ${o.ts.length}${regNote}`;
  });
  return `${e1cibBanner}Найдено ${res.length}${res.length > limit ? `, показаны первые ${limit}` : ''}:\n${out.join('\n')}\n` +
    'Подробная структура объекта — навык meta-info; граф связей (подписки, движения, перехваты CFE, где используется как тип) — object_refs.';
}

function moduleMatches(mod, objectFilter) {
  if (!objectFilter) return true;
  const f = norm(objectFilter).replace(/\s+/g, '');
  const parts = f.split('.');
  if (parts.length > 1 && TYPE_ALIASES.has(parts[0])) {
    const [ru] = TYPES[TYPE_ALIASES.get(parts[0])];
    const rest = parts.slice(1).join('.');
    return norm(mod.id).startsWith(norm(`${ru}.${rest}`));
  }
  return norm(mod.id).includes(f);
}

// «ОбщийМодуль.Имя» / «Документ.Задача» — модуль ровно этого объекта, а не всех с таким началом имени
function isExactModule(mod, spec) {
  const f = norm(spec).replace(/\s+/g, '');
  const parts = f.split('.');
  let target = f;
  if (parts.length > 1 && TYPE_ALIASES.has(parts[0])) target = norm(`${TYPES[TYPE_ALIASES.get(parts[0])][0]}.${parts.slice(1).join('.')}`);
  const id = norm(mod.id);
  return id === target || id.startsWith(target + '.');
}

function selectModules(idx, spec, { path_filter, database } = {}) {
  const allowPath = makePathFilter(idx, { path_filter, database });
  const base = (path_filter || database) ? idx.modules.filter((m) => allowPath(m.file)) : idx.modules;
  if (!spec) return base;
  const exact = base.filter((m) => isExactModule(m, spec));
  return exact.length ? exact : base.filter((m) => moduleMatches(m, spec));
}

function methodCode(file, m, maxLines) {
  const lines = readText(file).split(/\r?\n/);
  const dirCount = m.dir ? m.dir.split(/\s+(?=&)/).length : 0;
  const from = Math.max(0, m.line - 1 - dirCount);
  const to = Math.min(lines.length, m.end, from + maxLines);
  const body = lines.slice(from, to).join('\n');
  return to < m.end ? `${body}\n// … ещё ${m.end - to} строк (до ${m.end})` : body;
}

export function findMethod(idx, { name, object, path_filter, database, with_code = true, limit = 5, max_lines = 150 }) {
  const allowPath = makePathFilter(idx, { path_filter, database });
  const qn = norm(name);
  const exact = [];
  const partial = [];
  for (const mod of selectModules(idx, object, { path_filter, database })) {
    for (const m of mod.methods) {
      const n = norm(m.name);
      const t = m.intercept ? norm(m.intercept.target) : '';
      if (n === qn || t === qn) exact.push({ mod, m });
      else if (n.includes(qn) || (t && t.includes(qn))) partial.push({ mod, m });
    }
  }
  const found = exact.length ? exact : partial;
  if (!found.length) return `Метод «${name}» не найден${object ? ` в «${object}»` : ''}. Модулей в индексе: ${idx.modules.length}.`;

  // Дополнительно находим перехваты в расширениях для найденных базовых методов (если они ещё не в списке)
  const seenKeys = new Set(found.map(({ mod, m }) => `${mod.file}:${m.line}`));
  for (const { mod, m } of [...found]) {
    if (mod.isExt) continue;
    for (const extMod of idx.modules) {
      if (!extMod.isExt || !allowPath(extMod.file) || norm(extMod.id) !== norm(mod.id)) continue;
      for (const em of extMod.methods) {
        if (em.intercept && norm(em.intercept.target) === norm(m.name)) {
          const k = `${extMod.file}:${em.line}`;
          if (!seenKeys.has(k)) {
            seenKeys.add(k);
            found.push({ mod: extMod, m: em });
          }
        }
      }
    }
  }

  const showCode = with_code && found.length <= 3;
  const out = [];
  for (const { mod, m } of found.slice(0, showCode ? 3 : Math.max(limit, 20))) {
    const interceptBadge = m.intercept ? ` [перехват &${m.intercept.kind}("${m.intercept.target}")]` : '';
    out.push(`- ${mod.id}${cfgMark(idx, mod.cfg)} → ${m.kind} ${m.name}${m.export ? ' Экспорт' : ''}${m.dir ? ` ${m.dir}` : ''}${interceptBadge}\n  ${rel(idx, mod.file)}:${m.line}-${m.end}`);
    if (showCode) out.push('```bsl\n' + methodCode(mod.file, m, max_lines) + '\n```');
  }
  const more = found.length > (showCode ? 3 : Math.max(limit, 20)) ? `\n… ещё ${found.length - out.length}` : '';
  const hint = !showCode && with_code ? '\nСовпадений много — уточните object, path_filter или database, чтобы получить код.' : '';
  return `${exact.length ? 'Найдено' : 'Точного совпадения нет, похожие'}: ${found.length}\n${out.join('\n')}${more}${hint}`;
}

export function moduleMethods(idx, { module, path_filter, database, exported_only = false }) {
  const allowPath = makePathFilter(idx, { path_filter, database });
  let mods = idx.modules.filter((m) => allowPath(m.file) && (moduleMatches(m, module) || norm(rel(idx, m.file)).includes(norm(module))));
  const exact = mods.filter((m) => isExactModule(m, module));
  if (exact.length) mods = exact;
  if (!mods.length) return `Модули «${module}» не найдены. Пример: «Документ.Задача», «ОбщийМодуль.ОбщегоНазначения».`;
  const out = [];
  for (const mod of mods.slice(0, 15)) {
    const ms = mod.methods.filter((m) => !exported_only || m.export);
    out.push(`${mod.id}${cfgMark(idx, mod.cfg)} — ${rel(idx, mod.file)} (методов ${ms.length})`);
    for (const m of ms) {
      const interceptBadge = m.intercept ? ` [перехват &${m.intercept.kind}("${m.intercept.target}")]` : '';
      out.push(`  ${m.line}: ${m.kind} ${m.name}${m.export ? ' Экспорт' : ''}${m.dir ? ` ${m.dir}` : ''}${interceptBadge}`);
    }
  }
  if (mods.length > 15) out.push(`… ещё модулей: ${mods.length - 15} — уточните запрос.`);
  return out.join('\n');
}

function escapeRx(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function findUsages(idx, { name, object, path_filter, database, limit = 40, budgetBytes } = {}) {
  const allowPath = makePathFilter(idx, { path_filter, database });
  const rx = new RegExp(`(^|[^\\wА-Яа-яЁё])${escapeRx(name)}\\s*\\(`, 'i');
  const defRx = new RegExp(`^\\s*(?:Асинх\\s+|Async\\s+)?(Процедура|Функция|Procedure|Function)\\s+${escapeRx(name)}\\s*\\(`, 'i');
  const hits = [];
  const perModule = new Map();
  let total = 0;
  const qn = norm(name);
  // Благодаря индексу вызовов mod.calls сканируем только те модули, где реально встречается вызов `name(`,
  // что ускоряет поиск на 60 000+ модулях в сотни раз и не упирается в лимит 128 МБ!
  const candidateMods = selectModules(idx, object, { path_filter, database })
    .filter((mod) => !mod.calls || CALL_STOP.has(qn) || qn.length <= 2 || mod.calls.has(qn));
  const scan = scanFiles(candidateMods.map((mod) => ({ file: mod.file, mod })), { budgetBytes });
  for (const { file, mod } of scan.files) {
    forEachLine(file, (line, lineNo) => {
      const l = line.length > 500 ? line.slice(0, 500) : line;
      if (!norm(l).includes(qn) || !rx.test(l) || defRx.test(l) || /^\s*\/\//.test(l)) return;
      total++;
      perModule.set(mod.id, (perModule.get(mod.id) || 0) + 1);
      if (hits.length < limit) {
        const owner = mod.methods.find((m) => m.line <= lineNo && lineNo <= m.end);
        hits.push(`- ${rel(idx, file)}:${lineNo}${owner ? ` (${owner.name})` : ''}: ${short(l.trim(), 160)}`);
      }
    });
  }
  // Привязки в метаданных (подписки на события, регламентные задания, HTTP/Web-сервисы), формах (Form.xml) и перехватах CFE
  const metaUsages = [];
  for (const o of idx.objects) {
    if (!allowPath(o.file)) continue;
    if (object && !norm(objTitle(o)).includes(norm(object))) continue;
    if (o.subscription && o.subscription.handler) {
      const hParts = o.subscription.handler.split('.');
      if (norm(hParts[hParts.length - 1]) === qn || norm(o.subscription.handler) === qn) {
        metaUsages.push(`- [ПодпискаНаСобытие.${o.name}] событие ${o.subscription.event} → ${o.subscription.handler} (${rel(idx, o.file)})`);
      }
    }
    if (o.scheduledJob && o.scheduledJob.methodName) {
      const mParts = o.scheduledJob.methodName.split('.');
      if (norm(mParts[mParts.length - 1]) === qn || norm(o.scheduledJob.methodName) === qn) {
        metaUsages.push(`- [РегламентноеЗадание.${o.name}] метод → ${o.scheduledJob.methodName} (${rel(idx, o.file)})`);
      }
    }
    for (const hm of o.httpMethods || []) {
      if (norm(hm.handler) === qn) {
        metaUsages.push(`- [HTTPСервис.${o.name}] ${hm.httpMethod} ${hm.template} → ${hm.handler} (${rel(idx, o.file)})`);
      }
    }
    for (const op of o.wsOperations || []) {
      if (norm(op.handler) === qn) {
        metaUsages.push(`- [WebСервис.${o.name}] операция ${op.name} → ${op.handler} (${rel(idx, o.file)})`);
      }
    }
  }
  for (const fm of idx.forms || []) {
    if (!allowPath(fm.file)) continue;
    if (object && !moduleMatches({ id: fm.id }, object)) continue;
    for (const [evtName, handler] of fm.events) {
      if (norm(handler) === qn) {
        metaUsages.push(`- [${fm.id}] событие формы/элемента ${evtName} → ${handler} (${rel(idx, fm.file)})`);
      }
    }
    for (const [cmdName, handler] of fm.commands) {
      if (norm(handler) === qn) {
        metaUsages.push(`- [${fm.id}] команда формы ${cmdName} → ${handler} (${rel(idx, fm.file)})`);
      }
    }
  }
  for (const mod of selectModules(idx, object, { path_filter, database })) {
    for (const m of mod.methods) {
      if (m.intercept && norm(m.intercept.target) === qn) {
        metaUsages.push(`- [Перехват CFE в ${mod.id}${cfgMark(idx, mod.cfg)}] &${m.intercept.kind}("${m.intercept.target}") → ${m.name} (${rel(idx, mod.file)}:${m.line})`);
      }
    }
  }

  if (!total && !metaUsages.length && !scan.stopped) return `Вызовы «${name}» не найдены.`;
  const parts = [];
  if (total || scan.stopped) {
    const summary = [...perModule.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([m, n]) => `${m} ×${n}`).join(', ');
    const head = total ? `Вызовов: ${total} в ${perModule.size} модулях. По модулям: ${summary}` : `Вызовы «${name}» в просмотренной части не найдены.`;
    parts.push(head + (hits.length ? `\n${hits.join('\n')}` : '') +
      (total > hits.length ? `\n… показаны первые ${hits.length}` : '') + scan.note);
  } else {
    parts.push(`Прямых вызовов в коде .bsl: 0.`);
  }
  if (metaUsages.length) {
    parts.push(`Привязки в метаданных, формах и расширениях (${metaUsages.length}):\n${metaUsages.slice(0, limit).join('\n')}`);
  }
  return parts.join('\n\n');
}

function short(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// ---------------------------------------------------------------------------
// Граф связей и зависимостей объекта метаданных (object_refs)
// ---------------------------------------------------------------------------
function resolveTargetObject(idx, query, allowPath = () => true) {
  const e1cib = parseE1cibUrl(query);
  const qn = norm(e1cib ? e1cib.objSpec : query).trim();
  let typeFilter = null;
  let objName = qn;
  const m = qn.match(/^([a-zа-я]+)[.\s]+(.+)$/);
  if (m && TYPE_ALIASES.has(m[1])) {
    typeFilter = TYPE_ALIASES.get(m[1]);
    objName = m[2].trim();
  }
  const pool = idx.objects.filter((o) => allowPath(o.file));
  const exact = pool.filter((o) => (!typeFilter || o.type === typeFilter) && norm(o.name) === objName);
  if (exact.length) {
    // Предпочитаем объект основной конфигурации как базовый, но собираем и все экземпляры из расширений
    const base = exact.find((o) => !o.isExt) || exact[0];
    return { base, all: exact, e1cib };
  }
  const partial = pool.filter((o) => (!typeFilter || o.type === typeFilter) && (norm(o.name).includes(objName) || norm(o.syn).includes(objName)));
  if (partial.length) {
    const first = partial.find((o) => !o.isExt) || partial[0];
    const allSame = pool.filter((o) => o.type === first.type && norm(o.name) === norm(first.name));
    return { base: first, all: allSame, e1cib };
  }
  return null;
}

export function objectRefs(idx, { object, path_filter, database, limit = 40 }) {
  const allowPath = makePathFilter(idx, { path_filter, database });
  const resolved = resolveTargetObject(idx, object, allowPath);
  if (!resolved) {
    return `Объект «${object}» не найден в индексе (всего объектов: ${idx.objects.length}). Используйте find_object для поиска.`;
  }
  const { base, all, e1cib } = resolved;
  const title = objTitle(base);
  const titleNorm = norm(title);
  const out = [];

  if (e1cib) {
    out.push(`[Навигационная ссылка 1С] Объект: ${e1cib.objSpec} · ref=${e1cib.refHex} → УникальныйИдентификатор: ${e1cib.uuid}`);
  }

  // 1. Заголовок и сводка по файлам (база + расширения)
  const filesLine = all.map((o) => `${rel(idx, o.file)}${o.adopted ? ' (заимствован в расширении)' : ''}${cfgMark(idx, o.cfg)}`).join(', ');
  out.push(`=== ${title}${base.syn && base.syn !== base.name ? ` — «${base.syn}»` : ''} ===`);
  out.push(`Файлы: ${filesLine}`);

  // Собираем карту ОпределяемыхТипов: какие ОпределяемыеТипы включают наш объект
  const definedTypesContainingObj = new Set();
  const refPrefix = {
    Catalogs: 'СправочникСсылка', Documents: 'ДокументСсылка', Enums: 'ПеречислениеСсылка',
    ChartsOfCharacteristicTypes: 'ПланВидовХарактеристикСсылка', ChartsOfAccounts: 'ПланСчетовСсылка',
    ChartsOfCalculationTypes: 'ПланВидовРасчетаСсылка', ExchangePlans: 'ПланОбменаСсылка',
    BusinessProcesses: 'БизнесПроцессСсылка', Tasks: 'ЗадачаСсылка',
  }[base.type];
  const objPrefix = {
    Catalogs: 'СправочникОбъект', Documents: 'ДокументОбъект',
    ChartsOfCharacteristicTypes: 'ПланВидовХарактеристикОбъект', ChartsOfAccounts: 'ПланСчетовОбъект',
    ChartsOfCalculationTypes: 'ПланВидовРасчетаОбъект', ExchangePlans: 'ПланОбменаОбъект',
    BusinessProcesses: 'БизнесПроцессОбъект', Tasks: 'ЗадачаОбъект',
    InformationRegisters: 'НаборЗаписейРегистраСведений', AccumulationRegisters: 'НаборЗаписейРегистраНакопления',
    AccountingRegisters: 'НаборЗаписейРегистраБухгалтерии', CalculationRegisters: 'НаборЗаписейРегистраРасчета',
  }[base.type];
  const mgrPrefix = {
    Catalogs: 'СправочникМенеджер', Documents: 'ДокументМенеджер', Enums: 'ПеречислениеМенеджер',
    InformationRegisters: 'РегистрСведенийМенеджер', AccumulationRegisters: 'РегистрНакопленияМенеджер',
    AccountingRegisters: 'РегистрБухгалтерииМенеджер', CalculationRegisters: 'РегистрРасчетаМенеджер',
    Constants: 'КонстантаМенеджерЗначения',
  }[base.type];

  const matchTypeTargets = new Set([titleNorm]);
  if (refPrefix) matchTypeTargets.add(norm(`${refPrefix}.${base.name}`));
  if (objPrefix) matchTypeTargets.add(norm(`${objPrefix}.${base.name}`));
  if (mgrPrefix) matchTypeTargets.add(norm(`${mgrPrefix}.${base.name}`));

  const scopedObjects = idx.objects.filter((o) => allowPath(o.file));
  for (const dt of scopedObjects) {
    if (dt.type !== 'DefinedTypes') continue;
    if ((dt.types || []).some((t) => matchTypeTargets.has(norm(t)))) {
      definedTypesContainingObj.add(norm(`ОпределяемыйТип.${dt.name}`));
    }
  }

  // Если сам исследуемый объект — ОпределяемыйТип, покажем его состав
  const mergedTypes = [...new Set(all.flatMap((o) => o.types || []))];
  if (mergedTypes.length) {
    out.push(`Тип / Состав типов (${mergedTypes.length}): ${mergedTypes.join(' | ')}`);
  }

  // 1.5. Обязательные реквизиты (FillChecking = ShowError) и состав реквизитов/ТЧ
  const reqAttrs = [];
  const seenReq = new Set();
  for (const o of all) {
    for (const [an, , , atypes, req] of o.attrs || []) {
      if (req && !seenReq.has(norm(an))) {
        seenReq.add(norm(an));
        reqAttrs.push(`${an}${atypes?.length ? ` (${atypes.join('|')})` : ''}`);
      }
    }
    for (const t of o.ts || []) {
      for (const [an, , atypes, req] of t.attrs || []) {
        const key = `${norm(t.name)}.${norm(an)}`;
        if (req && !seenReq.has(key)) {
          seenReq.add(key);
          reqAttrs.push(`ТЧ ${t.name}.${an}${atypes?.length ? ` (${atypes.join('|')})` : ''}`);
        }
      }
    }
  }
  if (reqAttrs.length) {
    out.push(`Обязательные реквизиты (FillChecking=ShowError, ${reqAttrs.length}): ${reqAttrs.slice(0, limit).join(', ')}`);
  }

  // 2. Движения по регистрам (для документа — какие регистры двигает; для регистра — какие документы его двигают)
  const regRecords = [...new Set(all.flatMap((o) => o.registerRecords || []))];
  if (regRecords.length) {
    out.push(`\nДвижения документа по регистрам (${regRecords.length}):`);
    for (const r of regRecords) out.push(`  - ${r}`);
  }
  if (base.type.endsWith('Registers')) {
    const recorders = [];
    for (const o of scopedObjects) {
      if ((o.registerRecords || []).some((r) => norm(r) === titleNorm)) {
        recorders.push(`${objTitle(o)}${cfgMark(idx, o.cfg)}`);
      }
    }
    const uniqRecorders = [...new Set(recorders)];
    out.push(`\nРегистраторы (документы, двигающие регистр) (${uniqRecorders.length}):`);
    if (uniqRecorders.length) {
      for (const r of uniqRecorders.slice(0, limit)) out.push(`  - ${r}`);
    } else {
      out.push('  (нет документов в RegisterRecords)');
    }
  }

  // 3. Ввод на основании (BasedOn) и Владельцы справочников (Owners)
  const basedOn = [...new Set(all.flatMap((o) => o.basedOn || []))];
  const basedOnReverse = scopedObjects
    .filter((o) => (o.basedOn || []).some((b) => norm(b) === titleNorm))
    .map((o) => objTitle(o));
  if (basedOn.length || basedOnReverse.length) {
    if (basedOn.length) out.push(`\nВводится на основании: ${basedOn.join(', ')}`);
    if (basedOnReverse.length) out.push(`На основании него вводятся: ${[...new Set(basedOnReverse)].join(', ')}`);
  }

  const owners = [...new Set(all.flatMap((o) => o.owners || []))];
  const subordinates = scopedObjects
    .filter((o) => (o.owners || []).some((ow) => norm(ow) === titleNorm))
    .map((o) => objTitle(o));
  if (owners.length || subordinates.length) {
    if (owners.length) out.push(`\nВладельцы справочника: ${owners.join(', ')}`);
    if (subordinates.length) out.push(`Подчинённые справочники: ${[...new Set(subordinates)].join(', ')}`);
  }

  // 4. Подписки на события (EventSubscriptions), срабатывающие на этот объект
  const classWildcards = new Set();
  if (objPrefix) classWildcards.add(norm(`${objPrefix} (все)`));
  if (mgrPrefix) classWildcards.add(norm(`${mgrPrefix} (все)`));

  const subscriptions = [];
  for (const o of scopedObjects) {
    if (o.type !== 'EventSubscriptions' || !o.subscription) continue;
    const sub = o.subscription;
    let via = null;
    for (const src of sub.sources || []) {
      const sn = norm(src);
      if (matchTypeTargets.has(sn)) { via = 'прямая привязка'; break; }
      if (definedTypesContainingObj.has(sn)) { via = `через ${src}`; break; }
      if (classWildcards.has(sn)) { via = `на все объекты вида (${src})`; break; }
    }
    if (via) {
      subscriptions.push(`  - ПодпискаНаСобытие.${o.name}${cfgMark(idx, o.cfg)}: событие «${sub.event}» → ${sub.handler} (${via})`);
    }
  }
  out.push(`\nПодписки на события (${subscriptions.length}):`);
  if (subscriptions.length) {
    out.push(...subscriptions.slice(0, limit));
  } else {
    out.push('  (подписок на этот объект не найдено)');
  }

  // 5. Перехваты и доработки в расширениях (CFE)
  const cfeLines = [];
  for (const o of all) {
    if (!o.isExt) continue;
    const ownAttrs = (o.attrs || []).map((a) => a[0]);
    const ownTs = (o.ts || []).map((t) => t.name);
    cfeLines.push(`  - Заимствован в расширении [${o.cfg}] (${rel(idx, o.file)})` +
      (ownAttrs.length ? `; реквизиты в расширении: ${ownAttrs.join(', ')}` : '') +
      (ownTs.length ? `; ТЧ в расширении: ${ownTs.join(', ')}` : ''));
  }
  for (const mod of idx.modules) {
    if (!allowPath(mod.file) || !mod.isExt || !isExactModule(mod, title)) continue;
    for (const m of mod.methods) {
      if (m.intercept) {
        cfeLines.push(`  - Перехват метода в [${mod.cfg}] ${mod.id}: &${m.intercept.kind}("${m.intercept.target}") → ${m.kind} ${m.name} (${rel(idx, mod.file)}:${m.line})`);
      } else {
        cfeLines.push(`  - Собственный метод в [${mod.cfg}] ${mod.id}: ${m.kind} ${m.name}${m.export ? ' Экспорт' : ''} (${rel(idx, mod.file)}:${m.line})`);
      }
    }
  }
  if (cfeLines.length) {
    out.push(`\nДоработки и перехваты в расширениях CFE (${cfeLines.length}):`);
    out.push(...cfeLines.slice(0, limit));
  }

  // 6. Где объект используется как тип данных (Where Used)
  const whereUsed = [];
  const checkTypeMatch = (types) => {
    for (const t of types || []) {
      const tn = norm(t);
      if (matchTypeTargets.has(tn)) return t;
      if (definedTypesContainingObj.has(tn)) return `через ${t}`;
    }
    return null;
  };

  for (const o of scopedObjects) {
    if (o.type === base.type && norm(o.name) === norm(base.name)) continue;
    const objHit = checkTypeMatch(o.types);
    if (objHit) {
      whereUsed.push(`  - ${objTitle(o)}${cfgMark(idx, o.cfg)} (${objHit})`);
    }
    for (const [an, , tag, atypes] of o.attrs || []) {
      const hit = checkTypeMatch(atypes);
      if (hit) {
        const tagRu = { Dimension: 'измерение', Resource: 'ресурс', Attribute: 'реквизит' }[tag] || 'реквизит';
        whereUsed.push(`  - ${objTitle(o)}.${an} (${tagRu}, тип: ${hit})`);
      }
    }
    for (const t of o.ts || []) {
      for (const [an, , atypes] of t.attrs || []) {
        const hit = checkTypeMatch(atypes);
        if (hit) {
          whereUsed.push(`  - ${objTitle(o)}.${t.name}.${an} (реквизит ТЧ, тип: ${hit})`);
        }
      }
    }
  }
  out.push(`\nГде используется как тип (${whereUsed.length}):`);
  if (whereUsed.length) {
    out.push(...whereUsed.slice(0, limit));
    if (whereUsed.length > limit) out.push(`  … ещё ${whereUsed.length - limit}`);
  } else {
    out.push('  (ссылок на этот тип в реквизитах/измерениях не найдено)');
  }

  // 7. Общие реквизиты и Функциональные опции
  const commonAttrs = [];
  const funcOptions = [];
  for (const o of scopedObjects) {
    if (o.type === 'CommonAttributes') {
      const explicit = o.contentUse?.[titleNorm];
      if (explicit === true || (explicit === undefined && o.autoUse)) {
        commonAttrs.push(o.name);
      }
    } else if (o.type === 'FunctionalOptions') {
      if (norm(o.location) === titleNorm || (o.foContent || []).some((c) => norm(c) === titleNorm)) {
        funcOptions.push(o.name);
      }
    }
  }
  if (commonAttrs.length) out.push(`\nОбщие реквизиты объекта: ${[...new Set(commonAttrs)].join(', ')}`);
  if (funcOptions.length) out.push(`Функциональные опции: ${[...new Set(funcOptions)].join(', ')}`);

  // 8. Механизм БСП «Дополнительные реквизиты и сведения»
  const bspNotes = [];
  const allTs = all.flatMap((o) => o.ts || []);
  const dopTs = allTs.find((t) => norm(t.name) === 'дополнительныереквизиты');
  if (dopTs) {
    const tsCols = (dopTs.attrs || []).map((a) => `${a[0]}${a[2]?.length ? ` (${a[2].join('|')})` : ''}`).join(', ');
    bspNotes.push(`  - ТЧ «ДополнительныеРеквизиты» присутствует (${tsCols || 'стандартная структура БСП: Свойство, Значение, ТекстоваяСтрока'})`);
  }
  const bspDefTypes = [];
  for (const dt of scopedObjects) {
    if (dt.type !== 'DefinedTypes') continue;
    const dn = norm(dt.name);
    if ((dn.includes('дополнительныхреквизитов') || dn.includes('дополнительныхсведений')) &&
        (dt.types || []).some((t) => matchTypeTargets.has(norm(t)))) {
      bspDefTypes.push(`ОпределяемыйТип.${dt.name}`);
    }
  }
  if (bspDefTypes.length) {
    bspNotes.push(`  - Входит в определяемые типы БСП: ${[...new Set(bspDefTypes)].join(', ')}`);
  }
  const hasDopSvedReg = scopedObjects.some((o) => o.type === 'InformationRegisters' && norm(o.name) === 'дополнительныесведения');
  if (bspDefTypes.some((d) => norm(d).includes('сведений')) && hasDopSvedReg) {
    bspNotes.push('  - Хранение доп. сведений: РегистрСведений.ДополнительныеСведения (измерения: Объект, Свойство; ресурс: Значение)');
  }
  if (dopTs || bspDefTypes.length) {
    bspNotes.push('  - Работа в запросах и коде БСП: соединение через `.ДополнительныеРеквизиты КАК ДопРеквизиты ПО ДопРеквизиты.Свойство = &Свойство` (`ПланВидовХарактеристик.ДополнительныеРеквизитыИСведения`), модуль `УправлениеСвойствами` / `УправлениеСвойствамиСлужебный`');
    out.push(`\nДополнительные реквизиты и сведения БСП:\n${bspNotes.join('\n')}`);
  }

  return out.join('\n');
}

// Сколько байт search_code/find_usages читают за один вызов. Дальше — ответ с просьбой сузить
// path_filter, а не падение процесса (на Документообороте чтение всех модулей целиком роняло
// Node с кодом 134, и OpenCode вычёркивал сервер до конца сеанса).
export const SEARCH_BUDGET_BYTES = 128 * 1024 * 1024;

// Первый файл читаем всегда. Следующий — только если он помещается в остаток бюджета.
export function withinBudget(read, size, budget) {
  if (budget == null) return true;
  if (read === 0) return true;
  return read + size <= budget;
}

// Построчно, без readFileSync всего модуля: пик памяти — буфер, а не размер файла.
export function forEachLine(file, fn) {
  let fd;
  try { fd = openSync(file, 'r'); } catch { return; }
  const buf = Buffer.alloc(64 * 1024);
  const dec = new StringDecoder('utf8');
  let carry = '';
  let lineNo = 1;
  try {
    while (true) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      carry += dec.write(buf.subarray(0, n));
      let nl;
      while ((nl = carry.indexOf('\n')) >= 0) {
        const line = carry.slice(0, nl).replace(/\r$/, '');
        carry = carry.slice(nl + 1);
        fn(line, lineNo++);
      }
      if (carry.length > 8192) {
        fn(carry.slice(0, 8192), lineNo++);
        carry = '';
      }
    }
    carry += dec.end();
    if (carry) fn(carry.replace(/\r$/, ''), lineNo);
  } finally { closeSync(fd); }
}

function scanFiles(items, { budgetBytes = SEARCH_BUDGET_BYTES } = {}) {
  const files = [];
  let read = 0;
  let stopped = false;
  for (const item of items) {
    let size = 0;
    try { size = statSync(item.file).size; } catch { continue; }
    if (!withinBudget(read, size, budgetBytes)) { stopped = true; break; }
    read += size;
    files.push(item);
  }
  const note = stopped
    ? `\n[!] поиск остановлен, чтобы не уронить сервер: просмотрено ${files.length} из ${items.length} файлов. Повтори вызов с path_filter (каталог объекта или расширения), а не поиском по всей выгрузке.`
    : '';
  return { files, stopped, note };
}

export function searchCode(idx, { pattern, regex = false, path_filter, database, include_xml = false, limit = 40, budgetBytes } = {}) {
  if (regex && String(pattern).length > 180) return 'Регулярное выражение длиннее 180 символов — сузь pattern, иначе поиск может зависнуть.';
  let rx;
  try { rx = new RegExp(regex ? pattern : escapeRx(pattern), 'i'); } catch (e) { return `Неверное регулярное выражение: ${e.message}`; }
  const allowPath = makePathFilter(idx, { path_filter, database });
  const items = [];
  for (const m of idx.modules) items.push({ file: m.file });
  if (include_xml) for (const o of idx.objects) items.push({ file: o.file });
  const selected = items.filter((it) => allowPath(it.file));
  const scan = scanFiles(selected, { budgetBytes });
  const hits = [];
  let total = 0;
  const perFile = new Map();
  const needle = regex ? null : norm(pattern);
  for (const { file } of scan.files) {
    const r = rel(idx, file);
    forEachLine(file, (line, lineNo) => {
      const sample = line.length > 500 ? line.slice(0, 500) : line;
      if (needle && !norm(sample).includes(needle)) return;
      if (!rx.test(sample)) return;
      total++;
      perFile.set(r, (perFile.get(r) || 0) + 1);
      if (hits.length < limit) hits.push(`- ${r}:${lineNo}: ${short(sample.trim(), 160)}`);
    });
  }
  if (!total && !scan.stopped) return 'Совпадений нет.';
  const head = total ? `Совпадений: ${total} в ${perFile.size} файлах.` : 'В просмотренной части совпадений нет.';
  return head + (hits.length ? `\n${hits.join('\n')}` : '') +
    (total > hits.length ? `\n… показаны первые ${hits.length}; сузьте path_filter или database` : '') + scan.note;
}

export function indexStatus(idx) {
  const methods = idx.modules.reduce((n, m) => n + m.methods.length, 0);
  const cfgs = idx.configs.map((c) => `${c.rel} (${c.isExt ? 'расширение' : 'конфигурация'} ${c.name})`).join('; ') || 'не найдены';
  const dbLine = idx.databases?.length
    ? `\nБазы в .v8-project.json: ${idx.databases.map((d) => `${d.id} (${d.prefixes.join(', ') || 'без путей'})`).join('; ')}`
    : '';
  return `Корень: ${idx.root}\nВыгрузки: ${cfgs}${dbLine}\nОбъектов: ${idx.objects.length}, модулей: ${idx.modules.length}, методов: ${methods}\n` +
    `Индекс: ${idx.ms} мс, разобрано файлов заново: ${idx.parsed}`;
}

// ---------------------------------------------------------------------------
// Семантический и гибридный поиск
// ---------------------------------------------------------------------------
const STOP = new Set(['где', 'как', 'что', 'это', 'для', 'при', 'или', 'кто', 'чем', 'того', 'если', 'чтобы', 'который', 'которая',
  'которые', 'которое', 'реализован', 'реализована', 'реализовано', 'реализуется', 'реализация', 'находится', 'происходит',
  'выполняется', 'делается', 'код', 'коде', 'метод', 'методе', 'процедура', 'функция', 'модуль', 'модуле', 'есть', 'нужно', 'надо',
  'where', 'what', 'how', 'the', 'and', 'for', 'is', 'in', 'of']);

const methodKey = (idx, mod, m) => `${rel(idx, mod.file)}|${m.name}`;
const objectKey = (idx, o) => `${rel(idx, o.file)}|${objTitle(o)}`;

// Источники фрагментов для семантического индекса: методы модулей и (по настройке) объекты метаданных
export function semanticSources(idx, cfg) {
  const byTitle = new Map(idx.objects.map((o) => [`${o.cfg}|${objTitle(o)}`, o]));
  const out = [];
  for (const mod of idx.modules) {
    if (!mod.methods.length) continue;
    const title = mod.id.split('.').slice(0, 2).join('.');
    const o = byTitle.get(`${mod.cfg}|${title}`);
    out.push({ kind: 'module', file: mod.file, rel: rel(idx, mod.file), moduleId: mod.id, objTitle: title,
      objSyn: o && o.syn && o.syn !== o.name ? o.syn : '', methods: mod.methods });
  }
  if (cfg.includeObjects) {
    for (const o of idx.objects) {
      out.push({ kind: 'object', file: o.file, rel: rel(idx, o.file), title: objTitle(o), name: o.name, syn: o.syn, attrs: o.attrs, ts: o.ts });
    }
  }
  return out;
}

// Ключевые слова: имя метода и модуля, имя/синоним объекта, идентификаторы из запроса в теле кода
export function keywordRank(idx, query, { object, path_filter, database, timeBudgetMs = 3000 } = {}) {
  const allowPath = makePathFilter(idx, { path_filter, database });
  const qStems = words(query).filter((w) => !STOP.has(w)).map(stem);
  const qFull = norm(query).replace(/\s+/g, '');
  const res = new Map();
  const add = (key, s, item) => { const cur = res.get(key); if (cur) cur.s += s; else res.set(key, { key, s, ...item }); };
  const mods = selectModules(idx, object, { path_filter, database });
  if (qStems.length) {
    for (const mod of mods) {
      const modStems = [...new Set(words(mod.id).map(stem))];
      const modHit = qStems.filter((q) => modStems.some((w) => w.startsWith(q) || q.startsWith(w))).length / qStems.length;
      for (const m of mod.methods) {
        const s = scoreText(qStems, qFull, m.name, '', 10) + modHit * 3;
        if (s >= 4) add(methodKey(idx, mod, m), s, { mod, m });
      }
    }
    if (!object) {
      for (const o of idx.objects) {
        if (!allowPath(o.file)) continue;
        const s = scoreText(qStems, qFull, o.name, o.syn, 10);
        if (s >= 5) add(objectKey(idx, o), s, { o });
      }
    }
  }
  // Идентификаторы (ПроверитьЛимит, Контрагент_Код) — ищем в теле методов, с ограничением по времени
  const ids = [...new Set((query.match(/[A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё]{4,}/g) || [])
    .filter((t) => /[a-zа-яё][A-ZА-ЯЁ]|_/.test(t)))].slice(0, 5);
  if (ids.length) {
    const started = Date.now();
    const nids = ids.map(norm);
    for (const mod of mods) {
      if (Date.now() - started > timeBudgetMs) break;
      let text;
      try { text = readText(mod.file); } catch { continue; }
      const nt = norm(text);
      if (!nids.some((id) => nt.includes(id))) continue;
      const lines = nt.split(/\r?\n/);
      for (const m of mod.methods) {
        const body = lines.slice(m.line - 1, m.end).join('\n');
        let hit = 0;
        for (const id of nids) if (body.includes(id)) hit++;
        if (hit) add(methodKey(idx, mod, m), hit * 6, { mod, m });
      }
    }
  }
  return [...res.values()].sort((a, b) => b.s - a.s).slice(0, 200);
}

const autoBuildAt = new Map();
function maybeAutoBuild(idx, cfg) {
  if (!cfg.autoBuild) return null;
  const st = sem.buildState(idx.root);
  if (st?.running) return st;
  const last = autoBuildAt.get(idx.root) || 0;
  if (Date.now() - last < 5 * 60000) return st;
  autoBuildAt.set(idx.root, Date.now());
  return sem.startBuild(idx.root, () => semanticSources(buildIndex(idx.root), cfg), cfg, { readText });
}

function buildingNote(st) {
  if (!st) return '';
  if (st.running) return ` (строится в фоне: ${st.done}/${st.total || '?'})`;
  if (st.lockedBy) return ` (индекс строит другой процесс: ${st.lockedBy.user || '?'}, pid ${st.lockedBy.pid || '?'})`;
  return st.error ? ` (последнее построение: ошибка — ${st.error})` : '';
}

function chunkTextFor(idx, cfg, cand, cache) {
  if (cand.o) {
    return sem.objectChunk({ title: objTitle(cand.o), name: cand.o.name, syn: cand.o.syn, attrs: cand.o.attrs, ts: cand.o.ts }, cfg.maxChunkChars).text;
  }
  let text = cache.get(cand.mod.file);
  if (text === undefined) { try { text = readText(cand.mod.file); } catch { text = ''; } cache.set(cand.mod.file, text); }
  const [src] = semanticSources({ ...idx, modules: [{ ...cand.mod, methods: [cand.m] }], objects: idx.objects }, { includeObjects: false });
  return sem.moduleChunks(text, src, cfg.maxChunkChars)[0]?.text || '';
}

function firstComment(text, m) {
  const lines = text.split(/\r?\n/);
  for (let i = m.line - 2, n = 0; i >= 0 && n < 15; i--, n++) {
    const t = lines[i].trim();
    if (t.startsWith('&')) continue;
    if (!t.startsWith('//')) break;
    const c = t.replace(/^\/\/\s*/, '');
    if (c && !/^[-=/*]+$/.test(c) && !/^(Параметры|Возвращаемое значение|Пример)/i.test(c)) {
      // поднимаемся к началу комментария — первая содержательная строка
      let j = i; let best = c;
      while (j - 1 >= 0 && lines[j - 1].trim().startsWith('//')) {
        j--;
        const cc = lines[j].trim().replace(/^\/\/\s*/, '');
        if (cc && !/^[-=/*]+$/.test(cc) && !/^(Параметры|Возвращаемое значение|Пример)/i.test(cc)) best = cc;
      }
      return best;
    }
  }
  return '';
}

export async function semanticSearch(idx, a, { env = process.env } = {}) {
  const query = String(a.query || '').trim();
  if (!query) return 'Пустой запрос.';
  const allowPath = makePathFilter(idx, { path_filter: a.path_filter, database: a.database });
  const hasPathScope = Boolean(a.path_filter || a.database);
  const cfg = sem.loadConfig(idx.root, env);
  const limit = Math.min(50, Math.max(1, Math.round(Number(a.limit) || cfg.topK)));
  let mode = ['hybrid', 'semantic', 'keyword'].includes(a.mode) ? a.mode : 'hybrid';
  const notes = [...cfg.notes];
  let vec = null;
  let reachable = false;
  if (cfg.enabled === false) {
    if (mode !== 'keyword') notes.push('семантический поиск выключен (SEMANTIC_SEARCH=0 или semanticSearch.enabled=false) — только ключевые слова');
    mode = 'keyword';
  } else {
    const p = await sem.probe(cfg);
    reachable = p.ok;
    if (!p.ok) {
      if (mode !== 'keyword') notes.push(`семантика недоступна (${cfg.baseUrl}: ${p.error}) — только ключевые слова`);
      mode = 'keyword';
    } else if (mode !== 'keyword') {
      const st = maybeAutoBuild(idx, cfg);
      const filter = (a.object || hasPathScope)
        ? (relPath, id) => (!hasPathScope || allowPath(relPath)) && (!a.object || moduleMatches({ id }, a.object))
        : null;
      try {
        vec = await sem.vectorSearch(cfg, idx.root, query, { limit: 200, filter });
      } catch (e) {
        notes.push(`семантика недоступна (эмбеддинги ${cfg.embedModel}: ${e.message}) — только ключевые слова`);
        vec = null; mode = 'keyword';
      }
      if (vec?.noIndex) {
        const why = sem.manifestMismatch(cfg, idx.root);
        notes.push(`семантический индекс ${why ? `устарел (${why})` : 'ещё не построен'}${buildingNote(sem.buildState(idx.root) || st) || ' — запустите semantic_index action=build'}; пока только ключевые слова`);
        vec = null; mode = 'keyword';
      } else if (vec && vec.coverage.embedded < vec.coverage.total) {
        notes.push(`семантический индекс неполный: ${vec.coverage.embedded} из ${vec.coverage.total} фрагментов${buildingNote(sem.buildState(idx.root))}`);
      }
    }
  }

  const kw = mode === 'semantic' ? [] : keywordRank(idx, query, { object: a.object, path_filter: a.path_filter, database: a.database });
  // ключ → кандидат (из актуального индекса: строки методов могли сдвинуться)
  const byRel = new Map(idx.modules.map((m) => [rel(idx, m.file), m]));
  const objByRel = new Map(idx.objects.map((o) => [rel(idx, o.file), o]));
  const cands = new Map();
  for (const k of kw) cands.set(k.key, { key: k.key, mod: k.mod, m: k.m, o: k.o, kw: k.s });
  for (const h of vec?.hits || []) {
    const key = `${h.rel}|${h.n}`;
    let c = cands.get(key);
    if (!c) {
      if (h.k === 'o') { const o = objByRel.get(h.rel); if (!o) continue; c = { key, o }; }
      else {
        const mod = byRel.get(h.rel);
        const m = mod?.methods.find((x) => x.name === h.n);
        if (!m) continue;
        c = { key, mod, m };
      }
      cands.set(key, c);
    }
    c.vec = Math.max(c.vec ?? -1, h.score);
  }
  const lists = [];
  if (vec?.hits.length) lists.push(vec.hits.map((h) => `${h.rel}|${h.n}`).filter((k) => cands.has(k)));
  if (kw.length) lists.push(kw.map((k) => k.key));
  const fused = sem.rrf(lists).map(({ key, s }) => ({ ...cands.get(key), rrf: s })).filter((c) => c.key);
  if (!fused.length) {
    return [...notes.map((n) => `[!] ${n}`), `Ничего не найдено по «${query}». Попробуйте другие слова, find_object или search_code.`].join('\n');
  }

  // Переранжирование верхних кандидатов
  let reranked = false;
  let rerankNote = '';
  const top = fused.slice(0, Math.max(limit, cfg.rerankTopN));
  if (a.rerank !== false && reachable && cfg.rerankBackend !== 'none' && top.length > 1) {
    const cache = new Map();
    const pool = top.slice(0, cfg.rerankTopN);
    const docs = pool.map((c) => chunkTextFor(idx, cfg, c, cache));
    const r = await sem.rerank(cfg, query, docs);
    rerankNote = r.note;
    r.scores.forEach((s, i) => { if (s !== null) pool[i].rr = s; });
    reranked = r.scores.some((s) => s !== null);
  }
  if (rerankNote) notes.push(rerankNote);
  const ordered = reranked
    ? [...top.filter((c) => c.rr !== undefined).sort((x, y) => y.rr - x.rr), ...top.filter((c) => c.rr === undefined)]
    : top;

  const label = { hybrid: 'гибридный (векторы + ключевые слова)', semantic: 'семантический', keyword: 'по ключевым словам' }[mode];
  const head = [`Режим: ${label}${reranked ? ` · переранжирование: ${cfg.rerankModel}` : ''}`, ...notes.map((n) => `[!] ${n}`)];
  const out = [];
  const textCache = new Map();
  const codeN = a.with_code ? 3 : 0;
  ordered.slice(0, limit).forEach((c, i) => {
    const marks = [c.rr !== undefined ? `rerank ${c.rr.toFixed(2)}` : '', c.vec !== undefined ? `вектор ${c.vec.toFixed(2)}` : '',
      c.kw !== undefined ? 'слова' : ''].filter(Boolean).join(' · ');
    if (c.o) {
      out.push(`${i + 1}. ${objTitle(c.o)}${c.o.syn && c.o.syn !== c.o.name ? ` «${c.o.syn}»` : ''} (объект метаданных)${cfgMark(idx, c.o.cfg)}\n` +
        `   ${rel(idx, c.o.file)} · ${marks}`);
      return;
    }
    let text = textCache.get(c.mod.file);
    if (text === undefined) { try { text = readText(c.mod.file); } catch { text = ''; } textCache.set(c.mod.file, text); }
    const cm = text ? firstComment(text, c.m) : '';
    out.push(`${i + 1}. ${c.mod.id}${cfgMark(idx, c.mod.cfg)} → ${c.m.kind} ${c.m.name}${c.m.export ? ' Экспорт' : ''}${c.m.dir ? ` ${c.m.dir}` : ''}\n` +
      `   ${rel(idx, c.mod.file)}:${c.m.line}-${c.m.end} · ${marks}${cm ? `\n   // ${short(cm, 140)}` : ''}`);
    if (i < codeN) { try { out.push('```bsl\n' + methodCode(c.mod.file, c.m, 80) + '\n```'); } catch { /* */ } }
  });
  return `${head.join('\n')}\n${out.join('\n')}\n` +
    (codeN ? '' : 'Код метода — find_method (name, object) или semantic_search с with_code=true.');
}

function fmtAge(ms) { const s = Math.round(ms / 1000); return s < 120 ? `${s} с` : `${Math.round(s / 60)} мин`; }

export async function semanticIndex(idx, a = {}, { env = process.env } = {}) {
  const cfg = sem.loadConfig(idx.root, env);
  const action = ['status', 'build', 'rebuild'].includes(a.action) ? a.action : 'status';
  const lines = [];
  lines.push(`Сервер: ${cfg.baseUrl} · эмбеддинги: ${cfg.embedModel} (d=${cfg.dimensions}, ${sem.eosLabel(cfg)}) · переранжирование: ${cfg.rerankBackend}` +
    `${cfg.rerankBackend !== 'none' ? ` (${cfg.rerankModel}${cfg.rerankBaseUrl !== cfg.baseUrl ? `, ${cfg.rerankBaseUrl}` : ''})` : ''}`);
  lines.push(`Включено: ${cfg.enabled === 'auto' ? 'авто (если сервер отвечает)' : cfg.enabled ? 'да' : 'нет'} · токен API: ${cfg.apiKey ? `задан (${cfg.apiKeyEnv})` : 'не задан'}`);
  lines.push(`Хранилище: ${cfg.storeDir}`);
  for (const n of cfg.notes) lines.push(`[!] ${n}`);
  let p = { ok: false, error: 'выключено' };
  if (cfg.enabled !== false) {
    p = await sem.probe(cfg, { fresh: true });
    if (p.ok) {
      const wanted = [cfg.embedModel, cfg.rerankBackend === 'lmstudio-logprobs' ? cfg.rerankModel : null].filter(Boolean);
      const miss = wanted.filter((m) => p.models.length && !sem.matchModelId(m, p.models));
      const aliased = wanted
        .map((m) => { const actual = sem.matchModelId(m, p.models); return actual && actual !== m ? `${m} → ${actual}` : ''; })
        .filter(Boolean);
      lines.push(`Сервер отвечает; моделей в /models: ${p.models.length}` +
        `${aliased.length ? ` · сопоставлены: ${aliased.join(', ')}` : ''}` +
        `${miss.length ? ` · [!] нет идентификаторов: ${miss.join(', ')} (загрузите: scripts\\lmstudio-load.ps1)` : ''}`);
    } else lines.push(`[!] Сервер недоступен: ${p.error}`);
  }
  if ((action === 'build' || action === 'rebuild') && cfg.enabled !== false) {
    if (!p.ok) lines.push('[!] Построение не запущено: сервер эмбеддингов недоступен.');
    else {
      const st = sem.startBuild(idx.root, () => semanticSources(buildIndex(idx.root), cfg), cfg, { force: action === 'rebuild', readText });
      autoBuildAt.set(idx.root, Date.now());
      const wait = Math.min(50, Math.max(0, Number(a.wait_seconds) || 0)) * 1000;
      if (wait && st.running) await Promise.race([st.promise, new Promise((r) => setTimeout(r, wait))]);
      lines.push(st.running ? 'Построение запущено в фоне — можно продолжать работу; ход — semantic_index (status).' : 'Построение завершено.');
    }
  }
  const store = sem.getStore(cfg).refresh();
  const man = sem.loadManifest(cfg, idx.root);
  if (man) {
    let total = 0; let have = 0;
    const seen = new Set();
    for (const f of Object.values(man.files)) for (const c of f.c) { if (seen.has(c[0])) continue; seen.add(c[0]); total++; if (store.has(c[0])) have++; }
    lines.push(`Индекс проекта: ${have} из ${total} фрагментов с векторами (${total ? Math.round((have / total) * 100) : 0}%), файлов ${Object.keys(man.files).length}, обновлён ${man.updated}${man.adaptedFrom ? ` (подхвачен из ${man.adaptedFrom})` : ''}`);
  } else {
    const why = sem.manifestMismatch(cfg, idx.root);
    lines.push(why ? `Индекс проекта: [!] ${why} — устарел, строится заново (semantic_index build или автоматически при поиске).` : 'Индекс проекта: ещё не построен.');
  }
  lines.push(`Векторов в хранилище: ${store.size}`);
  const st = sem.buildState(idx.root);
  if (st) {
    if (st.running) lines.push(`Построение: ${st.phase}, ${st.done}/${st.total || '?'}, идёт ${fmtAge(Date.now() - st.startedAt)}${st.failed ? `, пропущено ${st.failed}` : ''}`);
    else if (st.lockedBy) lines.push(`Построение: занято другим процессом (${st.lockedBy.user || '?'}@${st.lockedBy.host || '?'}, pid ${st.lockedBy.pid || '?'}, ${fmtAge(st.lockedBy.ageMs || 0)} назад обновлял блокировку)`);
    else lines.push(`Последнее построение: ${st.error ? `ошибка — ${st.error}` : `готово за ${fmtAge(st.finishedAt - st.startedAt)}`}${st.failed ? `, пропущено фрагментов ${st.failed}` : ''}`);
  } else {
    const lk = sem.readLock(join(sem.vectorDir(cfg), 'build.lock'));
    if (lk && !lk.stale) lines.push(`Построение идёт в другом процессе (${lk.user || '?'}, pid ${lk.pid || '?'}).`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------
// Модели нередко путают имя главного аргумента (find_object вызывают с {"name": …}, как find_method).
// Поэтому основной аргумент не помечен required в схеме (иначе OpenCode отклоняет вызов до сервера),
// синонимы объявлены в схеме (чтобы клиент их не отбросил), а сервер сам приводит их к каноническому имени
// и с понятной ошибкой отказывает, если нет ни того, ни другого.
export const ARG_ALIASES = {
  semantic_search: { query: ['text', 'q', 'question'] },
  find_object: { query: ['name', 'object', 'text', 'q'] },
  object_refs: { object: ['query', 'name', 'target'] },
  find_method: { name: ['method', 'method_name', 'query'] },
  module_methods: { module: ['object', 'name', 'query'] },
  find_usages: { name: ['method', 'method_name', 'query'] },
  search_code: { pattern: ['query', 'text', 'string'] },
  validate_query: { query: ['text', 'sql', 'q'] },
};
const ARG_EXAMPLES = {
  semantic_search: '{"query": "где проверяется кредитный лимит"}', find_object: '{"query": "ЗадачиМне"}',
  object_refs: '{"object": "Документ.ЗаказКлиента"}',
  find_method: '{"name": "ПриЗаписи", "object": "Документ.Задача"}', module_methods: '{"module": "Документ.Задача"}',
  find_usages: '{"name": "ПриЗаписи"}', search_code: '{"pattern": "ЗаписатьИзменения("}',
  validate_query: '{"query": "ВЫБРАТЬ Ссылка ИЗ Справочник.Номенклатура"}',
};

function aliasProps(canonical, names) {
  return Object.fromEntries(names.map((n) => [n, { type: 'string', description: `Устаревший синоним ${canonical} — передавайте ${canonical}` }]));
}

const present = (v) => (typeof v === 'string' ? v.trim() !== '' : typeof v === 'number' && Number.isFinite(v));

// Приводит синонимы к каноническим именам. Синоним, совпадающий с собственным аргументом инструмента
// (object у find_method/find_usages/semantic_search), здесь не участвует — он есть только там, где его нет в схеме.
export function normalizeArgs(tool, a = {}) {
  const spec = ARG_ALIASES[tool];
  if (!spec) return a;
  const out = { ...a };
  for (const [canonical, aliases] of Object.entries(spec)) {
    if (!present(out[canonical])) {
      const from = aliases.find((k) => present(out[k]));
      if (from) { out[canonical] = out[from]; delete out[from]; }
    }
    if (!present(out[canonical])) {
      throw new Error(`${tool}: не передан обязательный аргумент «${canonical}» (строка). Пример: ${ARG_EXAMPLES[tool]}` +
        (aliases.length ? `. Также принимается: ${aliases.join(', ')}.` : '.'));
    }
    out[canonical] = String(out[canonical]).trim();
  }
  return out;
}

const ROOT_ARG = { type: 'string', description: 'Корень проекта (по умолчанию — рабочая папка OpenCode)' };
const PATH_FILTER_ARG = { type: 'string', description: 'Сузить поиск по подстроке пути (например «src/doc», «src/ERP_02112026_R», «ИнтеграцияSD»)' };
const DATABASE_ARG = { type: 'string', description: 'Сузить поиск по базе из .v8-project.json — автоматически включает configSrc и все расширения этой базы (например «HotDoc», «ERP_02112026_R»)' };
const TOOLS = [
  { name: 'semantic_search', description: 'Поиск кода и объектов 1С ПО СМЫСЛУ: «где реализовано/проверяется/рассчитывается X», ' +
      '«как устроено Y», когда точного имени метода не знаешь. Гибрид: векторы (эмбеддинги LM Studio) + ключевые слова, ' +
      'затем переранжирование. Без LM Studio — только ключевые слова (в ответе будет пометка [!]). ' +
      'Возвращает модуль, метод, файл:строки, первую строку комментария; with_code=true — код трёх первых.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', description: 'Описание на естественном языке, например «где проверяется кредитный лимит контрагента»' },
      mode: { type: 'string', enum: ['hybrid', 'semantic', 'keyword'], description: 'hybrid (по умолчанию), semantic — только векторы, keyword — только слова' },
      object: { type: 'string', description: 'Сузить: «ОбщийМодуль.Продажи», «Документ.ЗаказКлиента»' },
      path_filter: PATH_FILTER_ARG, database: DATABASE_ARG,
      limit: { type: 'number', description: 'Сколько результатов (по умолчанию 10)' },
      rerank: { type: 'boolean', description: 'Переранжировать реранкером (по умолчанию да)' },
      with_code: { type: 'boolean' }, root: ROOT_ARG }, required: ['query'] } },
  { name: 'semantic_index', description: 'Состояние семантического индекса (status) или запуск построения в фоне (build — только изменённые файлы, ' +
      'rebuild — заново разобрать все файлы; уже посчитанные векторы переиспользуются). Индекс обновляется и сам при semantic_search.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['status', 'build', 'rebuild'] },
      wait_seconds: { type: 'number', description: 'Подождать завершения до N секунд (не больше 50)' }, root: ROOT_ARG } } },
  { name: 'find_object', description: 'Найти объект метаданных 1С по смыслу: по имени, синониму, реквизиту, табличной части или навигационной ссылке e1cib/data/Вид.Имя?ref=HEX (раскодирует ref в УникальныйИдентификатор). ' +
      'Аргумент — query (строка): {"query": "ЗадачиМне"}. Пример query: «история задач», «Документ.Задача», «номенклатура вес». ' +
      'Используй вместо grep по XML.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', description: 'Обязательно. Имя, синоним, реквизит, «Вид.Имя» или ссылка e1cib/data/...?ref=...' },
      type: { type: 'string', description: 'Вид объекта: Справочник, Документ, РегистрСведений…' },
      path_filter: PATH_FILTER_ARG, database: DATABASE_ARG, limit: { type: 'number' }, root: ROOT_ARG,
      ...aliasProps('query', ['name', 'object']) } } },
  { name: 'object_refs', description: 'Граф связей и зависимостей объекта метаданных 1С: обязательные реквизиты (FillChecking=ShowError), подписки на события (EventSubscriptions), ' +
      'движения документа по регистрам (RegisterRecords) или регистраторы регистра, перехваты методов и заимствования в расширениях (CFE), ' +
      'ввод на основании (BasedOn), где объект используется как тип реквизита/измерения/ресурса (where used), общие реквизиты и функциональные опции. Понимает ссылки e1cib/data/...?ref=...',
    inputSchema: { type: 'object', properties: {
      object: { type: 'string', description: 'Обязательно. «Вид.Имя», имя объекта или навигационная ссылка e1cib/data/...?ref=...' },
      path_filter: PATH_FILTER_ARG, database: DATABASE_ARG,
      limit: { type: 'number', description: 'Максимум элементов в каждой секции (по умолчанию 40)' }, root: ROOT_ARG,
      ...aliasProps('object', ['query', 'name', 'target']) } } },
  { name: 'find_method', description: 'Найти процедуру/функцию по имени и сразу получить её код (если совпадений до 3). ' +
      'Автоматически показывает и перехваты этого метода в расширениях CFE (&Перед, &После, &Вместо, &ИзменениеИКонтроль). ' +
      'Аргументы: name — имя метода (обязательно); object сужает поиск: «ОбщийМодуль.Имя», «Документ.Задача», «Документ.Задача.Форма.ФормаДокумента».',
    inputSchema: { type: 'object', properties: {
      name: { type: 'string', description: 'Обязательно. Имя процедуры/функции или его часть' },
      object: { type: 'string', description: 'Сузить поиск: «ОбщийМодуль.Имя», «Документ.Задача»' },
      path_filter: PATH_FILTER_ARG, database: DATABASE_ARG,
      with_code: { type: 'boolean' }, max_lines: { type: 'number' }, root: ROOT_ARG, ...aliasProps('name', ['method']) } } },
  { name: 'module_methods', description: 'Список процедур и функций модулей объекта или общего модуля со строками, экспортом, директивами и перехватами CFE. ' +
      'Аргумент — module: {"module": "Документ.Задача"}.',
    inputSchema: { type: 'object', properties: {
      module: { type: 'string', description: 'Обязательно. «Документ.Задача», «ОбщийМодуль.ОбщегоНазначения» или часть пути' },
      path_filter: PATH_FILTER_ARG, database: DATABASE_ARG,
      exported_only: { type: 'boolean' }, root: ROOT_ARG, ...aliasProps('module', ['object', 'name']) } } },
  { name: 'find_usages', description: 'Где вызывается или привязан метод: вызовы в .bsl (по индексу вызовов без остановки по объёму), обработчики событий и команд в Form.xml, ' +
      'подписки на события, регламентные задания, HTTP/Web-сервисы и перехваты в расширениях CFE. ' +
      'Аргументы: name — имя метода (обязательно), object — сузить по модулю, path_filter / database — сузить по каталогу или базе.',
    inputSchema: { type: 'object', properties: {
      name: { type: 'string', description: 'Обязательно. Точное имя вызываемой процедуры/функции' },
      object: { type: 'string', description: 'Искать вызовы только в модулях этого объекта' },
      path_filter: PATH_FILTER_ARG, database: DATABASE_ARG,
      limit: { type: 'number' }, root: ROOT_ARG, ...aliasProps('name', ['method']) } } },
  { name: 'validate_query', description: 'Статическая проверка текста запроса 1С по схеме метаданных конфигурации и стандартам производительности ИТС (без запуска 1С): ' +
      'проверяет существование таблиц, табличных частей, виртуальных таблиц регистров (СрезПоследних, Остатки, Обороты и др.), ' +
      'реквизитов, измерений, ресурсов, стандартных и общих реквизитов, цепочек через точку (Т.Договор.Валюта), ' +
      'литералов ЗНАЧЕНИЕ(Перечисление.Х.У), временных таблиц пакета (ПОМЕСТИТЬ), а также антипаттерны ИТС (отбор по измерению ВТ в ГДЕ, соединения с подзапросами, ВТ без ИНДЕКСИРОВАТЬ ПО, точки от составных типов).',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', description: 'Обязательно. Текст запроса 1С («ВЫБРАТЬ ... ИЗ ...», допускается с символами «|» из модуля .bsl)' },
      path_filter: PATH_FILTER_ARG, database: DATABASE_ARG,
      root: ROOT_ARG, ...aliasProps('query', ['text', 'sql', 'q']) } } },
  { name: 'event_log', description: 'Чтение Журнала регистрации 1С (SQLite 1Cv8.lgd, текстовый *.lgp + 1Cv8.lgf) и Технологического журнала 1С (ТЖ *.log: EXCP, TDEADLOCK, TTIMEOUT, TLOCK, SDBL) без запуска конфигуратора. ' +
      'Возвращает последние ошибки выполнения, взаимоблокировки, таймауты, медленные запросы и автоматически ' +
      'привязывает серверный стек-трейс BSL ({Модуль(Строка)} и Context ТЖ Модуль : Строка) к файлам и строкам проекта.',
    inputSchema: { type: 'object', properties: {
      database: { type: 'string', description: 'ID, имя или алиас базы из .v8-project.json (по умолчанию берётся default)' },
      log_path: { type: 'string', description: 'Явный путь к файлу 1Cv8.lgd, папке 1Cv8Log, файлу/папке ТЖ (*.log) или каталогу базы' },
      errors_only: { type: 'boolean', description: 'Только ошибки (по умолчанию true; передайте false для всех событий)' },
      search: { type: 'string', description: 'Фильтр по тексту ошибки/комментария, объекту метаданных или пользователю' },
      event: { type: 'string', description: 'Фильтр по виду события (например «Проведение», «PerformError», «TDEADLOCK», «TTIMEOUT», «SDBL», «EXCP»)' },
      since_minutes: { type: 'number', description: 'Только записи за последние N минут' },
      limit: { type: 'number', description: 'Количество записей (по умолчанию 20, максимум 100)' },
      with_code: { type: 'boolean', description: 'Показывать фрагмент кода .bsl вокруг строки ошибки из стек-трейса (по умолчанию true)' },
      root: ROOT_ARG } } },
  { name: 'search_code', description: 'Поиск строки (или регулярного выражения) по BSL-модулям выгрузки с ограниченным выводом. ' +
      'Аргумент — pattern: {"pattern": "ЗаписатьИзменения("}. На большой выгрузке без path_filter/database чтение обрывается ' +
      '(ответ начинается с «[!] поиск остановлен») — повтори один раз с path_filter или database, не сканируй файлы через shell.',
    inputSchema: { type: 'object', properties: {
      pattern: { type: 'string', description: 'Обязательно. Подстрока (или регулярное выражение при regex=true)' },
      regex: { type: 'boolean' }, path_filter: PATH_FILTER_ARG, database: DATABASE_ARG, include_xml: { type: 'boolean' }, limit: { type: 'number' }, root: ROOT_ARG,
      ...aliasProps('pattern', ['query', 'text']) } } },
  { name: 'index_status', description: 'Какие выгрузки найдены в проекте и сколько объектов/методов в индексе. refresh=true — пересобрать.',
    inputSchema: { type: 'object', properties: { refresh: { type: 'boolean' }, root: ROOT_ARG } } },
];

const INSTRUCTIONS = 'Поиск и статический анализ по XML-выгрузке 1С. Для поиска объектов, связей, методов и вызовов используй эти инструменты, а не grep/sed/cat ' +
  'по файлам выгрузки: ответы короткие. semantic_search(query) — где реализовано X (по смыслу, когда имя неизвестно); ' +
  'find_object(query) — объект по имени/синониму/реквизиту; object_refs(object) — граф связей объекта (подписки на события, движения регистров, перехваты CFE, где используется как тип); ' +
  'find_method(name, object?) — метод с кодом и перехватами CFE; module_methods(module) — состав модуля; ' +
  'find_usages(name, object?) — кто вызывает (включая Form.xml, подписки, регл. задания); ' +
  'validate_query(query) — проверить таблицы и поля запроса 1С по метаданным; event_log() — прочитать ошибки и стек-трейсы из Журнала регистрации 1С; ' +
  'search_code(pattern) — строка в коде.' + instructionSuffix();

function semanticStatusLine(idx) {
  try {
    const cfg = sem.loadConfig(idx.root);
    if (cfg.enabled === false) return 'Семантический поиск: выключен';
    const man = sem.loadManifest(cfg, idx.root);
    const st = sem.buildState(idx.root);
    return `Семантический поиск: ${cfg.baseUrl}, ${cfg.embedModel}; индекс ${man ? `есть (${man.chunks ?? '?'} фрагментов)` : 'не построен'}` +
      `${st?.running ? `, строится ${st.done}/${st.total || '?'}` : ''} — подробно: semantic_index`;
  } catch (e) { return `Семантический поиск: ${e.message}`; }
}

async function handleCall(name, a, root) {
  a = normalizeArgs(name, a || {});
  if (!existsSync(root)) throw new Error(`каталог не найден: ${root}`);
  const idx = buildIndex(root, { force: name === 'index_status' && a.refresh });
  if (name === 'event_log') return readEventLog(idx, a);
  if (!idx.configs.length) {
    const msg = `В ${root} не найдено выгрузок 1С (Configuration.xml). Запустите OpenCode из папки проекта или передайте root.`;
    if (name === 'index_status') return `${agentBanner()}\n${msg}\n${autocheckStatusText()}`;
    return msg;
  }
  switch (name) {
    case 'semantic_search': return semanticSearch(idx, a);
    case 'semantic_index': return semanticIndex(idx, a);
    case 'find_object': return findObject(idx, a);
    case 'object_refs': return objectRefs(idx, a);
    case 'find_method': return findMethod(idx, a);
    case 'module_methods': return moduleMethods(idx, a);
    case 'find_usages': return findUsages(idx, a);
    case 'validate_query': return validateQuery(idx, {
      ...a,
      isAllowedPath: (a.path_filter || a.database) ? makePathFilter(idx, { path_filter: a.path_filter, database: a.database }) : null,
    });
    case 'search_code': return searchCode(idx, a);
    case 'index_status': return `${agentBanner()}\n${indexStatus(idx)}\n${semanticStatusLine(idx)}\n${autocheckStatusText()}`;
    default: throw new Error(`неизвестный инструмент ${name}`);
  }
}

// CLI: долгое первое построение удобно запустить из консоли, не из сеанса OpenCode
async function cli(argv) {
  const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const root = resolve(val('--root') || process.cwd());
  const idx = buildIndex(root);
  if (!idx.configs.length) { console.error(`В ${root} не найдено выгрузок 1С (Configuration.xml). Укажите --root.`); return 2; }
  if (argv.includes('--semantic-status')) { console.log(await semanticIndex(idx, { action: 'status' })); return 0; }
  const cfg = sem.loadConfig(root);
  if (cfg.enabled === false) { console.error('Семантический поиск выключен (SEMANTIC_SEARCH=0 / semanticSearch.enabled=false).'); return 3; }
  const p = await sem.probe(cfg, { fresh: true });
  if (!p.ok) { console.error(`Сервер эмбеддингов недоступен: ${cfg.baseUrl} — ${p.error}`); return 3; }
  console.log(`Построение индекса ${root} → ${cfg.storeDir} (${cfg.embedModel}, d=${cfg.dimensions}, ${sem.eosLabel(cfg)})`);
  let lastLog = 0;
  const st = sem.startBuild(root, () => semanticSources(idx, cfg), cfg, { force: argv.includes('--force'), readText,
    log: (m) => { if (Date.now() - lastLog > 5000 || !/^\d+\/\d+$/.test(m)) { lastLog = Date.now(); console.log(`  ${m}`); } } });
  await st.promise;
  console.log(await semanticIndex(idx, { action: 'status' }));
  if (st.lockedBy) { console.error('Индекс сейчас строит другой процесс — повторите позже.'); return 4; }
  return st.error ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  if (argv.includes('--semantic-build') || argv.includes('--build-vectors') || argv.includes('--semantic-status') || argv.includes('--status')) {
    cli(argv).then((code) => process.exit(code), (e) => { console.error(e.stack || e.message); process.exit(1); });
  } else {
    startServer({
      name: '1c-code-search',
      version: agentVersion(),
      instructions: INSTRUCTIONS,
      tools: TOOLS,
      onCall: (name, a, ctx) => handleCall(name, a, ctx.root(a.root)),
    });
  }
}
