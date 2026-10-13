#!/usr/bin/env node
// code-search.mjs v1.0 — MCP-сервер поиска по XML-выгрузке 1С для OpenCode: объекты метаданных по смыслу
// (имя, синоним, реквизиты), методы с кодом, список методов модуля, места вызова, поиск по коду.
// Заменяет grep/sed по выгрузке: ответы короткие и не забивают контекст модели.
// Без зависимостей. Индекс строится при первом вызове и кэшируется во временном каталоге
// (обновляются только изменённые файлы). Папку проекта берёт из MCP roots (рабочая папка сеанса), иначе — рабочий каталог процесса.

import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, relative, sep, resolve, basename } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startServer } from './lib/stdio-server.mjs';

const INDEX_VERSION = 3;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.agents', '.opencode', '.goose', 'build', 'base', 'tools', 'test-tmp', '.v8-xsd']);

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

const MODULE_KINDS = {
  ObjectModule: 'МодульОбъекта', ManagerModule: 'МодульМенеджера', RecordSetModule: 'МодульНабораЗаписей',
  ValueManagerModule: 'МодульМенеджераЗначения', CommandModule: 'МодульКоманды', Module: 'Модуль',
  ManagedApplicationModule: 'МодульУправляемогоПриложения', SessionModule: 'МодульСеанса',
  ExternalConnectionModule: 'МодульВнешнегоСоединения', OrdinaryApplicationModule: 'МодульОбычногоПриложения',
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

function readText(file) {
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

// Объект метаданных: имя, синоним, реквизиты, табличные части и их реквизиты, признак заимствования
export function parseObjectXml(text) {
  const name = (text.match(RX_NAME) || [])[1];
  if (!name) return null;
  const head = text.slice(0, text.indexOf('<ChildObjects>') > 0 ? text.indexOf('<ChildObjects>') : text.length);
  const obj = { name, syn: unescapeXml(synonymOf(head)), adopted: /<ObjectBelonging>Adopted<\/ObjectBelonging>/.test(head), attrs: [], ts: [] };
  const child = text.indexOf('<ChildObjects>') > 0 ? text.slice(text.indexOf('<ChildObjects>')) : '';
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
      if (an) ts.attrs.push([an, unescapeXml(synonymOf(a[1]))]);
    }
    obj.ts.push(ts);
    rest = rest.replace(m[0], '');
  }
  for (const tag of ['Attribute', 'Dimension', 'Resource', 'AccountingFlag', 'ExtDimensionAccountingFlag', 'AddressingAttribute', 'EnumValue']) {
    const rx = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'g');
    for (const a of rest.matchAll(rx)) {
      const an = (a[1].match(RX_NAME) || [])[1];
      if (an) obj.attrs.push([an, unescapeXml(synonymOf(a[1])), tag]);
    }
  }
  return obj;
}

const RX_METHOD_START = /^\s*(Процедура|Функция|Procedure|Function)\s+([A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё]*)\s*\(/i;
// \b в JS не работает с кириллицей — границу слова проверяем явно
const RX_METHOD_END = /^\s*(КонецПроцедуры|КонецФункции|EndProcedure|EndFunction)(?![\wА-Яа-яЁё])/i;
const RX_EXPORT = /\)\s*(Экспорт|Export)(?![\wА-Яа-яЁё])/i;

// Методы модуля: имя, строки начала/конца, экспорт, директива компиляции, сигнатура
export function parseMethods(text) {
  const lines = text.split(/\r?\n/);
  const methods = [];
  let cur = null;
  let directive = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!cur) {
      const t = line.trim();
      if (t.startsWith('&')) { directive = t; continue; }
      const m = line.match(RX_METHOD_START);
      if (m) {
        // сигнатура может занимать несколько строк — до закрывающей скобки
        let sig = line.trim();
        let j = i;
        while (!sig.includes(')') && j < i + 30 && j + 1 < lines.length) { j++; sig += ' ' + lines[j].trim(); }
        cur = { name: m[2], kind: /^(Функция|Function)$/i.test(m[1]) ? 'Функция' : 'Процедура', line: i + 1,
          export: RX_EXPORT.test(sig), dir: directive };
      } else if (t && !t.startsWith('//') && !t.startsWith('#')) directive = '';
    } else if (RX_METHOD_END.test(line)) {
      cur.end = i + 1;
      methods.push(cur);
      cur = null;
      directive = '';
    }
  }
  if (cur) { cur.end = lines.length; methods.push(cur); }
  return methods;
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

function listBsl(dir, acc = []) {
  let list;
  try { list = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of list) {
    const p = join(dir, e.name);
    if (e.isDirectory()) listBsl(p, acc);
    else if (e.name.endsWith('.bsl')) acc.push(p);
  }
  return acc;
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

const indexes = new Map();   // root → { built, configs, objects, modules }

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
    return { dir, rel: relative(root, dir).split(sep).join('/') || '.', name, isExt };
  });

  const objects = [];
  const modules = [];
  for (const c of configs) {
    for (const typeDir of Object.keys(TYPES)) {
      const d = join(c.dir, typeDir);
      let list;
      try { list = readdirSync(d); } catch { continue; }
      for (const f of list) {
        if (!f.endsWith('.xml')) continue;
        const o = take(join(d, f), parseObjectXml);
        if (o) objects.push({ ...o, type: typeDir, cfg: c.rel, file: join(d, f) });
      }
    }
    for (const f of listBsl(c.dir)) {
      const methods = take(f, parseMethods) || [];
      modules.push({ file: f, cfg: c.rel, id: moduleId(relative(c.dir, f)), methods });
    }
  }
  const idx = { built: Date.now(), root, configs, objects, modules, parsed, ms: Date.now() - started };
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

function scoreText(qStems, qFull, name, syn, weight) {
  const ws = new Set([...words(name), ...words(syn)].map(stem));
  let hit = 0;
  for (const q of qStems) if ([...ws].some((w) => w.startsWith(q) || q.startsWith(w))) hit++;
  let s = qStems.length ? (hit / qStems.length) * weight : 0;
  if (qFull && (norm(name) === qFull || norm(syn) === qFull)) s += weight;
  return s;
}

export function findObject(idx, { query, type, limit = 10 }) {
  const qn = norm(query).trim();
  // «Документ.Задача» / «Справочник Номенклатура» — тип в запросе
  let typeFilter = type ? TYPE_ALIASES.get(norm(type).replace(/\s+/g, '')) : null;
  let q = qn;
  const m = qn.match(/^([a-zа-я]+)[.\s]+(.+)$/);
  if (m && TYPE_ALIASES.has(m[1])) { typeFilter = typeFilter || TYPE_ALIASES.get(m[1]); q = m[2]; }
  const qStems = words(q).map(stem);
  const qFull = norm(q).replace(/\s+/g, '');
  const res = [];
  for (const o of idx.objects) {
    if (typeFilter && o.type !== typeFilter) continue;
    let s = scoreText(qStems, qFull, o.name, o.syn, 10);
    let why = '';
    if (norm(o.name) === qFull) s += 20;
    if (s < 10) {
      // совпадение по реквизиту или табличной части
      let best = 0;
      for (const [an, as] of o.attrs) {
        const sa = scoreText(qStems, qFull, an, as, 6);
        if (sa > best) { best = sa; why = `реквизит ${an}${as && as !== an ? ` «${as}»` : ''}`; }
      }
      for (const t of o.ts) {
        const st = scoreText(qStems, qFull, t.name, t.syn, 6);
        if (st > best) { best = st; why = `табличная часть ${t.name}`; }
        for (const [an, as] of t.attrs) {
          const sa = scoreText(qStems, qFull, an, as, 5);
          if (sa > best) { best = sa; why = `реквизит ТЧ ${t.name}.${an}${as && as !== an ? ` «${as}»` : ''}`; }
        }
      }
      if (best > s) s = best; else why = '';
    }
    if (s >= 3) res.push({ o, s, why });
  }
  res.sort((a, b) => b.s - a.s || a.o.name.length - b.o.name.length);
  if (!res.length) return `Ничего не найдено по «${query}». Объектов в индексе: ${idx.objects.length}.`;
  const out = res.slice(0, limit).map(({ o, why }) =>
    `- ${objTitle(o)}${o.syn && o.syn !== o.name ? ` — «${o.syn}»` : ''}${o.adopted ? ' (заимствован)' : ''}` +
    `${cfgMark(idx, o.cfg)}${why ? `; совпало: ${why}` : ''}\n  ${rel(idx, o.file)}; реквизитов ${o.attrs.length}, ТЧ ${o.ts.length}`);
  return `Найдено ${res.length}${res.length > limit ? `, показаны первые ${limit}` : ''}:\n${out.join('\n')}\n` +
    'Подробная структура объекта — навык meta-info.';
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

function selectModules(idx, spec) {
  if (!spec) return idx.modules;
  const exact = idx.modules.filter((m) => isExactModule(m, spec));
  return exact.length ? exact : idx.modules.filter((m) => moduleMatches(m, spec));
}

function methodCode(file, m, maxLines) {
  const lines = readText(file).split(/\r?\n/);
  const from = Math.max(0, m.line - 1 - (m.dir ? 1 : 0));
  const to = Math.min(lines.length, m.end, from + maxLines);
  const body = lines.slice(from, to).join('\n');
  return to < m.end ? `${body}\n// … ещё ${m.end - to} строк (до ${m.end})` : body;
}

export function findMethod(idx, { name, object, with_code = true, limit = 5, max_lines = 150 }) {
  const qn = norm(name);
  const exact = [];
  const partial = [];
  for (const mod of selectModules(idx, object)) {
    for (const m of mod.methods) {
      const n = norm(m.name);
      if (n === qn) exact.push({ mod, m });
      else if (n.includes(qn)) partial.push({ mod, m });
    }
  }
  const found = exact.length ? exact : partial;
  if (!found.length) return `Метод «${name}» не найден${object ? ` в «${object}»` : ''}. Модулей в индексе: ${idx.modules.length}.`;
  const showCode = with_code && found.length <= 3;
  const out = [];
  for (const { mod, m } of found.slice(0, showCode ? 3 : Math.max(limit, 20))) {
    out.push(`- ${mod.id}${cfgMark(idx, mod.cfg)} → ${m.kind} ${m.name}${m.export ? ' Экспорт' : ''}${m.dir ? ` ${m.dir}` : ''}\n  ${rel(idx, mod.file)}:${m.line}-${m.end}`);
    if (showCode) out.push('```bsl\n' + methodCode(mod.file, m, max_lines) + '\n```');
  }
  const more = found.length > (showCode ? 3 : Math.max(limit, 20)) ? `\n… ещё ${found.length - out.length}` : '';
  const hint = !showCode && with_code ? '\nСовпадений много — уточните object (например «ОбщийМодуль.Имя»), чтобы получить код.' : '';
  return `${exact.length ? 'Найдено' : 'Точного совпадения нет, похожие'}: ${found.length}\n${out.join('\n')}${more}${hint}`;
}

export function moduleMethods(idx, { module, exported_only = false }) {
  let mods = idx.modules.filter((m) => moduleMatches(m, module) || norm(rel(idx, m.file)).includes(norm(module)));
  const exact = mods.filter((m) => isExactModule(m, module));
  if (exact.length) mods = exact;
  if (!mods.length) return `Модули «${module}» не найдены. Пример: «Документ.Задача», «ОбщийМодуль.ОбщегоНазначения».`;
  const out = [];
  for (const mod of mods.slice(0, 15)) {
    const ms = mod.methods.filter((m) => !exported_only || m.export);
    out.push(`${mod.id}${cfgMark(idx, mod.cfg)} — ${rel(idx, mod.file)} (методов ${ms.length})`);
    for (const m of ms) out.push(`  ${m.line}: ${m.kind} ${m.name}${m.export ? ' Экспорт' : ''}${m.dir ? ` ${m.dir}` : ''}`);
  }
  if (mods.length > 15) out.push(`… ещё модулей: ${mods.length - 15} — уточните запрос.`);
  return out.join('\n');
}

function escapeRx(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function findUsages(idx, { name, object, limit = 40 }) {
  const rx = new RegExp(`(^|[^\\wА-Яа-яЁё])${escapeRx(name)}\\s*\\(`, 'i');
  const defRx = new RegExp(`^\\s*(Процедура|Функция|Procedure|Function)\\s+${escapeRx(name)}\\s*\\(`, 'i');
  const hits = [];
  const perModule = new Map();
  let total = 0;
  for (const mod of selectModules(idx, object)) {
    let text;
    try { text = readText(mod.file); } catch { continue; }
    if (!norm(text).includes(norm(name))) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (!rx.test(l) || defRx.test(l) || /^\s*\/\//.test(l)) continue;
      total++;
      perModule.set(mod.id, (perModule.get(mod.id) || 0) + 1);
      if (hits.length < limit) {
        const owner = mod.methods.find((m) => m.line <= i + 1 && i + 1 <= m.end);
        hits.push(`- ${rel(idx, mod.file)}:${i + 1}${owner ? ` (${owner.name})` : ''}: ${short(l.trim(), 160)}`);
      }
    }
  }
  if (!total) return `Вызовы «${name}» не найдены.`;
  const summary = [...perModule.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([m, n]) => `${m} ×${n}`).join(', ');
  return `Вызовов: ${total} в ${perModule.size} модулях. По модулям: ${summary}\n${hits.join('\n')}` +
    (total > hits.length ? `\n… показаны первые ${hits.length}` : '');
}

function short(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

export function searchCode(idx, { pattern, regex = false, path_filter, include_xml = false, limit = 40 }) {
  let rx;
  try { rx = new RegExp(regex ? pattern : escapeRx(pattern), 'i'); } catch (e) { return `Неверное регулярное выражение: ${e.message}`; }
  const filter = path_filter ? norm(path_filter) : null;
  const files = idx.modules.map((m) => m.file);
  if (include_xml) for (const o of idx.objects) files.push(o.file);
  const hits = [];
  let total = 0;
  const perFile = new Map();
  for (const f of files) {
    const r = rel(idx, f);
    if (filter && !norm(r).includes(filter)) continue;
    let text;
    try { text = readText(f); } catch { continue; }
    if (!regex && !norm(text).includes(norm(pattern))) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!rx.test(lines[i])) continue;
      total++;
      perFile.set(r, (perFile.get(r) || 0) + 1);
      if (hits.length < limit) hits.push(`- ${r}:${i + 1}: ${short(lines[i].trim(), 160)}`);
    }
  }
  if (!total) return `Совпадений нет.`;
  return `Совпадений: ${total} в ${perFile.size} файлах.\n${hits.join('\n')}` + (total > hits.length ? `\n… показаны первые ${hits.length}; сузьте path_filter` : '');
}

export function indexStatus(idx) {
  const methods = idx.modules.reduce((n, m) => n + m.methods.length, 0);
  const cfgs = idx.configs.map((c) => `${c.rel} (${c.isExt ? 'расширение' : 'конфигурация'} ${c.name})`).join('; ') || 'не найдены';
  return `Корень: ${idx.root}\nВыгрузки: ${cfgs}\nОбъектов: ${idx.objects.length}, модулей: ${idx.modules.length}, методов: ${methods}\n` +
    `Индекс: ${idx.ms} мс, разобрано файлов заново: ${idx.parsed}`;
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------
const ROOT_ARG = { type: 'string', description: 'Корень проекта (по умолчанию — рабочая папка OpenCode)' };
const TOOLS = [
  { name: 'find_object', description: 'Найти объект метаданных 1С по смыслу: по имени, синониму, реквизиту или табличной части. ' +
      'Пример: «история задач», «Документ.Задача», «номенклатура вес». Используй вместо grep по XML.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, type: { type: 'string', description: 'Вид объекта: Справочник, Документ, РегистрСведений…' }, limit: { type: 'number' }, root: ROOT_ARG }, required: ['query'] } },
  { name: 'find_method', description: 'Найти процедуру/функцию по имени и сразу получить её код (если совпадений до 3). ' +
      'object сужает поиск: «ОбщийМодуль.Имя», «Документ.Задача», «Документ.Задача.Форма.ФормаДокумента».',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, object: { type: 'string' }, with_code: { type: 'boolean' }, max_lines: { type: 'number' }, root: ROOT_ARG }, required: ['name'] } },
  { name: 'module_methods', description: 'Список процедур и функций модулей объекта или общего модуля со строками, экспортом и директивами.',
    inputSchema: { type: 'object', properties: { module: { type: 'string', description: '«Документ.Задача», «ОбщийМодуль.ОбщегоНазначения» или часть пути' }, exported_only: { type: 'boolean' }, root: ROOT_ARG }, required: ['module'] } },
  { name: 'find_usages', description: 'Где вызывается метод: файлы и строки вызовов с именем вызывающего метода, сводка по модулям.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, object: { type: 'string' }, limit: { type: 'number' }, root: ROOT_ARG }, required: ['name'] } },
  { name: 'search_code', description: 'Поиск строки (или регулярного выражения) по BSL-модулям выгрузки с ограниченным выводом.',
    inputSchema: { type: 'object', properties: { pattern: { type: 'string' }, regex: { type: 'boolean' }, path_filter: { type: 'string' }, include_xml: { type: 'boolean' }, limit: { type: 'number' }, root: ROOT_ARG }, required: ['pattern'] } },
  { name: 'index_status', description: 'Какие выгрузки найдены в проекте и сколько объектов/методов в индексе. refresh=true — пересобрать.',
    inputSchema: { type: 'object', properties: { refresh: { type: 'boolean' }, root: ROOT_ARG } } },
];

const INSTRUCTIONS = 'Поиск по XML-выгрузке 1С. Для поиска объектов, методов и вызовов используй эти инструменты, а не grep/sed/cat ' +
  'по файлам выгрузки: ответы короткие. find_object — объект по смыслу; find_method — метод с кодом; module_methods — состав модуля; ' +
  'find_usages — кто вызывает; search_code — строка в коде.';

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  startServer({
    name: '1c-code-search',
    instructions: INSTRUCTIONS,
    tools: TOOLS,
    onCall: (name, a, ctx) => {
      const root = ctx.root(a.root);
      if (!existsSync(root)) throw new Error(`каталог не найден: ${root}`);
      const idx = buildIndex(root, { force: name === 'index_status' && a.refresh });
      if (!idx.configs.length) {
        return `В ${root} не найдено выгрузок 1С (Configuration.xml). Запустите OpenCode из папки проекта или передайте root.`;
      }
      switch (name) {
        case 'find_object': return findObject(idx, a);
        case 'find_method': return findMethod(idx, a);
        case 'module_methods': return moduleMethods(idx, a);
        case 'find_usages': return findUsages(idx, a);
        case 'search_code': return searchCode(idx, a);
        case 'index_status': return indexStatus(idx);
        default: throw new Error(`неизвестный инструмент ${name}`);
      }
    },
  });
}
