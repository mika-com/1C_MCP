// query-validator.mjs — статический анализатор и валидатор запросов 1С по XML-индексу метаданных.
// Проверяет существование таблиц, табличных частей, виртуальных таблиц регистров (СрезПоследних, Остатки, Обороты и др.),
// реквизитов, измерений, ресурсов, стандартных и общих реквизитов, цепочек разыменования через точку (Т.Поле1.Поле2),
// литералов ЗНАЧЕНИЕ(Перечисление.Х.У), временных таблиц пакета (ПОМЕСТИТЬ / УНИЧТОЖИТЬ) и вложенных подзапросов.

const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');

// Виды объектов в языке запросов 1С (единственное число рус/англ → каталог выгрузки)
const QUERY_TABLE_TYPES = new Map([
  ['справочник', 'Catalogs'], ['catalog', 'Catalogs'],
  ['документ', 'Documents'], ['document', 'Documents'],
  ['журналдокументов', 'DocumentJournals'], ['documentjournal', 'DocumentJournals'],
  ['перечисление', 'Enums'], ['enum', 'Enums'],
  ['константа', 'Constants'], ['constant', 'Constants'],
  ['регистрсведений', 'InformationRegisters'], ['informationregister', 'InformationRegisters'],
  ['регистрнакопления', 'AccumulationRegisters'], ['accumulationregister', 'AccumulationRegisters'],
  ['регистрбухгалтерии', 'AccountingRegisters'], ['accountingregister', 'AccountingRegisters'],
  ['регистррасчета', 'CalculationRegisters'], ['calculationregister', 'CalculationRegisters'],
  ['планвидовхарактеристик', 'ChartsOfCharacteristicTypes'], ['chartofcharacteristictypes', 'ChartsOfCharacteristicTypes'],
  ['плансчетов', 'ChartsOfAccounts'], ['chartofaccounts', 'ChartsOfAccounts'],
  ['планвидоврасчета', 'ChartsOfCalculationTypes'], ['chartofcalculationtypes', 'ChartsOfCalculationTypes'],
  ['бизнеспроцесс', 'BusinessProcesses'], ['businessprocess', 'BusinessProcesses'],
  ['задача', 'Tasks'], ['task', 'Tasks'],
  ['планобмена', 'ExchangePlans'], ['exchangeplan', 'ExchangePlans'],
  ['последовательность', 'Sequences'], ['sequence', 'Sequences'],
  ['критерийотбора', 'FilterCriteria'], ['filtercriterion', 'FilterCriteria'],
  ['внешнийисточникданных', 'ExternalDataSources'], ['externaldatasource', 'ExternalDataSources'],
]);

// Ссылочный тип реквизита → каталог выгрузки
const REF_PREFIX_TO_DIR = new Map([
  ['справочникссылка', 'Catalogs'], ['catalogref', 'Catalogs'],
  ['документссылка', 'Documents'], ['documentref', 'Documents'],
  ['перечислениессылка', 'Enums'], ['enumref', 'Enums'],
  ['планвидовхарактеристикссылка', 'ChartsOfCharacteristicTypes'], ['пвхссылка', 'ChartsOfCharacteristicTypes'], ['chartofcharacteristictypesref', 'ChartsOfCharacteristicTypes'],
  ['плансчетовссылка', 'ChartsOfAccounts'], ['chartofaccountsref', 'ChartsOfAccounts'],
  ['планвидоврасчетассылка', 'ChartsOfCalculationTypes'], ['пврссылка', 'ChartsOfCalculationTypes'], ['chartofcalculationtypesref', 'ChartsOfCalculationTypes'],
  ['планобменассылка', 'ExchangePlans'], ['exchangeplanref', 'ExchangePlans'],
  ['бизнеспроцессссылка', 'BusinessProcesses'], ['businessprocessref', 'BusinessProcesses'],
  ['задачассылка', 'Tasks'], ['taskref', 'Tasks'],
]);

const DIR_TO_RU = {
  Catalogs: 'Справочник', Documents: 'Документ', DocumentJournals: 'ЖурналДокументов',
  Enums: 'Перечисление', Constants: 'Константа', InformationRegisters: 'РегистрСведений',
  AccumulationRegisters: 'РегистрНакопления', AccountingRegisters: 'РегистрБухгалтерии',
  CalculationRegisters: 'РегистрРасчета', ChartsOfCharacteristicTypes: 'ПланВидовХарактеристик',
  ChartsOfAccounts: 'ПланСчетов', ChartsOfCalculationTypes: 'ПланВидовРасчета',
  BusinessProcesses: 'БизнесПроцесс', Tasks: 'Задача', ExchangePlans: 'ПланОбмена',
  Sequences: 'Последовательность', FilterCriteria: 'КритерийОтбора', DefinedTypes: 'ОпределяемыйТип',
};

const DIR_TO_REF_RU = {
  Catalogs: 'СправочникСсылка', Documents: 'ДокументСсылка', Enums: 'ПеречислениеСсылка',
  ChartsOfCharacteristicTypes: 'ПланВидовХарактеристикСсылка', ChartsOfAccounts: 'ПланСчетовСсылка',
  ChartsOfCalculationTypes: 'ПланВидовРасчетаСсылка', ExchangePlans: 'ПланОбменаСсылка',
  BusinessProcesses: 'БизнесПроцессСсылка', Tasks: 'ЗадачаСсылка',
};

// Ключевые слова и функции языка запросов 1С, которые не являются именами полей
const QUERY_KEYWORDS = new Set([
  'выбрать', 'select', 'разрешенные', 'allowed', 'различные', 'distinct', 'первые', 'top',
  'как', 'as', 'поместить', 'into', 'уничтожить', 'drop', 'из', 'from',
  'левое', 'left', 'правое', 'right', 'полное', 'full', 'внутреннее', 'inner',
  'внешнее', 'outer', 'соединение', 'join', 'по', 'on', 'где', 'where',
  'сгруппировать', 'group', 'упорядочить', 'order', 'by', 'имеющие', 'having',
  'объединить', 'union', 'все', 'all', 'итоги', 'totals', 'общие', 'overall',
  'только', 'only', 'иерархия', 'hierarchy', 'периодами', 'periods',
  'автоупорядочивание', 'autoorder', 'индексировать', 'index', 'для', 'for', 'изменения', 'update',
  'и', 'and', 'или', 'or', 'не', 'not', 'в', 'in', 'между', 'between', 'подобно', 'like',
  'спецсимвол', 'escape', 'есть', 'is', 'null', 'истина', 'true', 'ложь', 'false', 'неопределено', 'undefined',
  'выбор', 'case', 'когда', 'when', 'тогда', 'then', 'иначе', 'else', 'конец', 'end',
  'возр', 'asc', 'убыв', 'desc', 'выразить', 'cast', 'тип', 'type', 'значение', 'value',
  // Встроенные функции запросов
  'естьnull', 'isnull', 'представление', 'presentation', 'представлениессылки', 'refpresentation',
  'типзначения', 'valuetype', 'датавремя', 'datetime', 'год', 'year', 'квартал', 'quarter',
  'месяц', 'month', 'деньгода', 'dayofyear', 'день', 'day', 'неделя', 'week', 'деньнедели', 'weekday',
  'час', 'hour', 'минута', 'minute', 'секунда', 'second', 'началопериода', 'beginofperiod',
  'конецпериода', 'endofperiod', 'добавитькдате', 'dateadd', 'разностьдат', 'datediff',
  'сумма', 'sum', 'количество', 'count', 'максимум', 'max', 'минимум', 'min', 'среднее', 'avg',
  'подстрока', 'substring', 'длинастроки', 'stringlength', 'стрнайти', 'strfind',
  'врегистр', 'upper', 'нрегистр', 'lower', 'сокрлп', 'trimall', 'сокрл', 'triml', 'сокрп', 'trimr',
  'стршаблон', 'strtemplate', 'стрзаменить', 'strreplace', 'уникальныйидентификатор', 'uuid',
  'окр', 'round', 'цел', 'int', 'log', 'log10', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'exp', 'pow', 'sqrt',
  'размерхранимыхданных', 'storedatasize', 'строка', 'string', 'число', 'number', 'дата', 'date', 'булево', 'boolean',
  // Литералы периодов
  'секунда', 'минута', 'час', 'день', 'неделя', 'декада', 'ten_days', 'месяц', 'квартал', 'полугодие', 'halfyear', 'год',
]);

// Очистка текста запроса от BSL-кавычек, символов переноса строки «|» и комментариев
export function cleanQueryText(raw) {
  let text = String(raw || '').trim();
  // Если передан строковый литерал 1С в кавычках целиком
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    text = text.slice(1, -1).replace(/""/g, '"');
  }
  const lines = text.split(/\r?\n/).map((line) => {
    // Убираем ведущий символ продолжения строки BSL «|»
    const stripped = line.replace(/^\s*\|/, '');
    // Убираем строковые комментарии // (вне строковых литералов)
    let out = '';
    let inStr = false;
    for (let i = 0; i < stripped.length; i++) {
      const ch = stripped[i];
      if (ch === '"') inStr = !inStr;
      if (!inStr && ch === '/' && stripped[i + 1] === '/') break;
      out += ch;
    }
    return out;
  });
  return lines.join('\n');
}

// Расстояние Левенштейна для подсказки похожих имён полей/объектов
function editDistance(a, b) {
  a = norm(a); b = norm(b);
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let j = 1; j <= b.length; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const tmp = dp[i];
      dp[i] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[i], dp[i - 1]);
      prev = tmp;
    }
  }
  return dp[a.length];
}

function suggestSimilar(target, candidates, max = 3) {
  const tn = norm(target);
  if (!tn) return [];
  const scored = [];
  for (const c of candidates) {
    const cn = norm(c);
    if (cn === tn) continue;
    let score = editDistance(tn, cn);
    if (cn.includes(tn) || tn.includes(cn)) score = Math.min(score, 2);
    else if (cn.slice(0, 4) === tn.slice(0, 4) && tn.length >= 4) score = Math.min(score, 3);
    const maxDist = Math.max(3, Math.floor(Math.max(tn.length, cn.length) * 0.45));
    if (score <= maxDist) scored.push({ c, score });
  }
  scored.sort((a, b) => a.score - b.score || a.c.length - b.c.length);
  return [...new Set(scored.map((x) => x.c))].slice(0, max);
}

// Собирает объединённое описание объекта метаданных из основной конфигурации и расширений
function buildSchemaIndex(idx) {
  const byTypeAndName = new Map(); // `${dir}|${norm(name)}` → merged object
  const definedTypes = new Map();  // norm(name) → string[] of types
  const commonAttrs = [];          // { name, types, autoUse, content: Map<norm('Dir.Name'), bool> }

  for (const o of idx.objects) {
    if (o.type === 'DefinedTypes') {
      const prev = definedTypes.get(norm(o.name)) || [];
      definedTypes.set(norm(o.name), [...new Set([...prev, ...(o.types || [])])]);
    }
    if (o.type === 'CommonAttributes') {
      commonAttrs.push(o);
    }
    const key = `${o.type}|${norm(o.name)}`;
    const existing = byTypeAndName.get(key);
    if (!existing) {
      byTypeAndName.set(key, {
        ...o,
        attrs: [...(o.attrs || [])],
        ts: (o.ts || []).map((t) => ({ ...t, attrs: [...(t.attrs || [])] })),
        types: [...(o.types || [])],
        owners: [...(o.owners || [])],
      });
    } else {
      // Дополняем реквизитами и ТЧ из расширений
      const seenAttrs = new Set(existing.attrs.map((a) => norm(a[0])));
      for (const a of o.attrs || []) {
        if (!seenAttrs.has(norm(a[0]))) { existing.attrs.push(a); seenAttrs.add(norm(a[0])); }
      }
      const tsByName = new Map(existing.ts.map((t) => [norm(t.name), t]));
      for (const t of o.ts || []) {
        const et = tsByName.get(norm(t.name));
        if (!et) {
          const copy = { ...t, attrs: [...(t.attrs || [])] };
          existing.ts.push(copy);
          tsByName.set(norm(t.name), copy);
        } else {
          const seenTsAttrs = new Set(et.attrs.map((a) => norm(a[0])));
          for (const a of t.attrs || []) {
            if (!seenTsAttrs.has(norm(a[0]))) { et.attrs.push(a); seenTsAttrs.add(norm(a[0])); }
          }
        }
      }
      if (!existing.hierarchical && o.hierarchical) existing.hierarchical = true;
      if (existing.codeLength === undefined && o.codeLength !== undefined) existing.codeLength = o.codeLength;
      if (existing.descriptionLength === undefined && o.descriptionLength !== undefined) existing.descriptionLength = o.descriptionLength;
      if (existing.numberLength === undefined && o.numberLength !== undefined) existing.numberLength = o.numberLength;
      if (!existing.periodicity && o.periodicity) existing.periodicity = o.periodicity;
      if (!existing.writeMode && o.writeMode) existing.writeMode = o.writeMode;
      if (!existing.registerType && o.registerType) existing.registerType = o.registerType;
    }
  }

  return { byTypeAndName, definedTypes, commonAttrs, allObjects: idx.objects };
}

// Раскрывает список типов реквизита (включая ОпределяемыйТип.Х) до конечных типов
function expandTypes(types, schema, visited = new Set()) {
  const out = [];
  for (const t of types || []) {
    const m = String(t).match(/^(?:ОпределяемыйТип|DefinedType)\.(.+)$/i);
    if (m) {
      const dtKey = norm(m[1]);
      if (visited.has(dtKey)) continue;
      visited.add(dtKey);
      const dtTypes = schema.definedTypes.get(dtKey) || [];
      out.push(...expandTypes(dtTypes, schema, visited));
    } else {
      out.push(t);
    }
  }
  return [...new Set(out)];
}

// Возвращает список целевых объектов метаданных из массива типов реквизита
function resolveTargetObjects(types, schema) {
  const expanded = expandTypes(types, schema);
  const targets = [];
  let anyRef = false;
  let primitiveOnly = expanded.length > 0;

  for (const t of expanded) {
    const tn = norm(t);
    if (tn === 'любаяссылка' || tn === 'любаяссылкаиб' || tn.endsWith('(все)') || tn.startsWith('характеристика.') || tn === 'определяемыйтип') {
      anyRef = true;
      primitiveOnly = false;
      continue;
    }
    const m = String(t).match(/^([A-Za-zА-Яа-яЁё]+)\.(.+)$/);
    if (m) {
      const dir = REF_PREFIX_TO_DIR.get(norm(m[1])) || QUERY_TABLE_TYPES.get(norm(m[1]));
      if (dir) {
        primitiveOnly = false;
        const obj = schema.byTypeAndName.get(`${dir}|${norm(m[2])}`);
        if (obj) targets.push(obj);
        else anyRef = true; // Ссылка на объект, которого нет в частичной выгрузке
        continue;
      }
    }
    if (!/^(строка|число|булево|дата|время|датавремя|уникальныйидентификатор|хранилищезначения|двоичныеданные|null)/i.test(tn)) {
      primitiveOnly = false;
    }
  }
  return { targets, anyRef, primitiveOnly, expanded };
}

// Строит словарь доступных полей для объекта метаданных (или виртуальной таблицы / ТЧ)
function getObjectFields(obj, schema, { tsName = null, virtualTable = null } = {}) {
  const fields = new Map(); // norm(fieldName) → { name, types, kind, isTs }
  const add = (name, types = [], kind = 'attr', isTs = false) => {
    const k = norm(name);
    if (!fields.has(k)) fields.set(k, { name, types, kind, isTs });
  };

  const selfRef = DIR_TO_REF_RU[obj.type] ? [`${DIR_TO_REF_RU[obj.type]}.${obj.name}`] : [];

  // Если это обращение к табличной части (Документ.Заказ.Товары)
  if (tsName) {
    const ts = (obj.ts || []).find((t) => norm(t.name) === norm(tsName));
    if (!ts) return null;
    add('Ссылка', selfRef, 'std');
    add('Ref', selfRef, 'std');
    add('НомерСтроки', ['Число'], 'std');
    add('LineNumber', ['Число'], 'std');
    for (const [an, , atypes] of ts.attrs || []) {
      add(an, atypes || [], 'ts_attr');
    }
    return { fields, title: `${DIR_TO_RU[obj.type] || obj.type}.${obj.name}.${ts.name}`, obj, ts };
  }

  // Стандартные реквизиты ссылочных объектов
  if (selfRef.length) {
    add('Ссылка', selfRef, 'std');
    add('Ref', selfRef, 'std');
    add('ПометкаУдаления', ['Булево'], 'std');
    add('DeletionMark', ['Булево'], 'std');
    add('Представление', ['Строка'], 'std');
    add('Presentation', ['Строка'], 'std');
    add('ВерсияДанных', ['Строка'], 'std');
    add('DataVersion', ['Строка'], 'std');
    add('Предопределенный', ['Булево'], 'std');
    add('Predefined', ['Булево'], 'std');
    add('ИмяПредопределенныхДанных', ['Строка'], 'std');
    add('PredefinedDataName', ['Строка'], 'std');
  }

  if (obj.type === 'Catalogs' || obj.type === 'ChartsOfCharacteristicTypes' || obj.type === 'ChartsOfAccounts' ||
      obj.type === 'ChartsOfCalculationTypes' || obj.type === 'ExchangePlans') {
    if (obj.codeLength !== 0) { add('Код', ['Строка'], 'std'); add('Code', ['Строка'], 'std'); }
    if (obj.descriptionLength !== 0) { add('Наименование', ['Строка'], 'std'); add('Description', ['Строка'], 'std'); }
    if (obj.hierarchical !== false) {
      add('Родитель', selfRef, 'std'); add('Parent', selfRef, 'std');
      add('ЭтоГруппа', ['Булево'], 'std'); add('IsFolder', ['Булево'], 'std');
    }
    if (obj.type === 'Catalogs') {
      const ownerTypes = (obj.owners || []).map((ow) => {
        const m = String(ow).match(/^(\w+)\.(.+)$/);
        if (m) {
          const dir = QUERY_TABLE_TYPES.get(norm(m[1]));
          if (dir && DIR_TO_REF_RU[dir]) return `${DIR_TO_REF_RU[dir]}.${m[2]}`;
        }
        return ow;
      });
      add('Владелец', ownerTypes.length ? ownerTypes : ['ЛюбаяСсылка'], 'std');
      add('Owner', ownerTypes.length ? ownerTypes : ['ЛюбаяСсылка'], 'std');
    }
    if (obj.type === 'ChartsOfCharacteristicTypes') {
      add('ТипЗначения', ['ОписаниеТипов'], 'std');
      add('ValueType', ['ОписаниеТипов'], 'std');
    }
    if (obj.type === 'ExchangePlans') {
      add('ЭтотУзел', ['Булево'], 'std');
      add('НомерОтправленного', ['Число'], 'std');
      add('НомерПринятого', ['Число'], 'std');
    }
    if (obj.type === 'ChartsOfAccounts') {
      add('Вид', ['Число'], 'std');
      add('Забалансовый', ['Булево'], 'std');
      add('Порядок', ['Строка'], 'std');
    }
  }

  if (obj.type === 'Documents' || obj.type === 'BusinessProcesses' || obj.type === 'Tasks') {
    add('Дата', ['ДатаВремя'], 'std'); add('Date', ['ДатаВремя'], 'std');
    if (obj.numberLength !== 0) { add('Номер', ['Строка'], 'std'); add('Number', ['Строка'], 'std'); }
    if (obj.type === 'Documents') {
      add('Проведен', ['Булево'], 'std'); add('Posted', ['Булево'], 'std');
      add('МоментВремени', ['МоментВремени'], 'std'); add('PointInTime', ['МоментВремени'], 'std');
    }
    if (obj.type === 'BusinessProcesses') {
      add('Стартован', ['Булево'], 'std');
      add('Завершен', ['Булево'], 'std');
      add('ГлавнаяЗадача', ['ЗадачаСсылка'], 'std');
      add('ВедущаяЗадача', ['ЗадачаСсылка'], 'std');
    }
    if (obj.type === 'Tasks') {
      if (obj.descriptionLength !== 0) { add('Наименование', ['Строка'], 'std'); add('Description', ['Строка'], 'std'); }
      add('Выполнена', ['Булево'], 'std');
      add('БизнесПроцесс', ['БизнесПроцессСсылка'], 'std');
      add('ТочкаМаршрута', ['Строка'], 'std');
    }
  }

  if (obj.type === 'Enums') {
    add('Порядок', ['Число'], 'std'); add('Order', ['Число'], 'std');
  }

  if (obj.type === 'Constants') {
    add('Значение', obj.types || [], 'std'); add('Value', obj.types || [], 'std');
  }

  if (obj.type === 'DocumentJournals') {
    add('Ссылка', ['ЛюбаяСсылка'], 'std');
    add('Дата', ['ДатаВремя'], 'std');
    add('Номер', ['Строка'], 'std');
    add('Проведен', ['Булево'], 'std');
    add('ПометкаУдаления', ['Булево'], 'std');
    add('Тип', ['Тип'], 'std');
  }

  // Регистры и их виртуальные таблицы
  const isRegister = obj.type.endsWith('Registers');
  if (isRegister) {
    const dims = (obj.attrs || []).filter((a) => a[2] === 'Dimension');
    const resources = (obj.attrs || []).filter((a) => a[2] === 'Resource');
    const regAttrs = (obj.attrs || []).filter((a) => a[2] === 'Attribute');

    for (const [dn, , , dtypes] of dims) add(dn, dtypes || [], 'dimension');

    const vt = norm(virtualTable || '');
    if (!vt) {
      // Физическая таблица регистра
      for (const [rn, , , rtypes] of resources) add(rn, rtypes || [], 'resource');
      for (const [an, , , atypes] of regAttrs) add(an, atypes || [], 'attr');
      add('Период', ['ДатаВремя'], 'std'); add('Period', ['ДатаВремя'], 'std');
      add('Регистратор', ['ЛюбаяСсылка'], 'std'); add('Recorder', ['ЛюбаяСсылка'], 'std');
      add('НомерСтроки', ['Число'], 'std'); add('LineNumber', ['Число'], 'std');
      add('Активность', ['Булево'], 'std'); add('Active', ['Булево'], 'std');
      if (obj.type === 'AccumulationRegisters') {
        add('ВидДвижения', ['ВидДвиженияНакопления'], 'std'); add('RecordType', ['ВидДвиженияНакопления'], 'std');
      }
      if (obj.type === 'AccountingRegisters') {
        add('Счет', ['ПланСчетовСсылка'], 'std'); add('Account', ['ПланСчетовСсылка'], 'std');
        add('КорСчет', ['ПланСчетовСсылка'], 'std'); add('BalancedAccount', ['ПланСчетовСсылка'], 'std');
        for (let i = 1; i <= 3; i++) {
          add(`Субконто${i}`, ['ЛюбаяСсылка'], 'std');
          add(`КорСубконто${i}`, ['ЛюбаяСсылка'], 'std');
        }
      }
      if (obj.type === 'CalculationRegisters') {
        add('ВидРасчета', ['ПланВидовРасчетаСсылка'], 'std');
        add('ПериодДействия', ['ДатаВремя'], 'std');
        add('ПериодДействияНачало', ['ДатаВремя'], 'std');
        add('ПериодДействияКонец', ['ДатаВремя'], 'std');
        add('ПериодРегистрации', ['ДатаВремя'], 'std');
        add('БазовыйПериодНачало', ['ДатаВремя'], 'std');
        add('БазовыйПериодКонец', ['ДатаВремя'], 'std');
        add('Сторно', ['Булево'], 'std');
      }
    } else if (vt === 'срезпоследних' || vt === 'slicelast' || vt === 'срезпервых' || vt === 'slicefirst') {
      for (const [rn, , , rtypes] of resources) add(rn, rtypes || [], 'resource');
      for (const [an, , , atypes] of regAttrs) add(an, atypes || [], 'attr');
      add('Период', ['ДатаВремя'], 'std'); add('Period', ['ДатаВремя'], 'std');
      add('Регистратор', ['ЛюбаяСсылка'], 'std'); add('Recorder', ['ЛюбаяСсылка'], 'std');
      add('НомерСтроки', ['Число'], 'std'); add('Активность', ['Булево'], 'std');
    } else if (vt === 'остатки' || vt === 'balance') {
      for (const [rn, , , rtypes] of resources) {
        add(`${rn}Остаток`, rtypes || ['Число'], 'vt_resource');
        add(`${rn}Balance`, rtypes || ['Число'], 'vt_resource');
        if (obj.type === 'AccountingRegisters') {
          add(`${rn}ОстатокДт`, rtypes || ['Число'], 'vt_resource');
          add(`${rn}ОстатокКт`, rtypes || ['Число'], 'vt_resource');
          add(`${rn}РазвернутыйОстатокДт`, rtypes || ['Число'], 'vt_resource');
          add(`${rn}РазвернутыйОстатокКт`, rtypes || ['Число'], 'vt_resource');
        }
      }
      if (obj.type === 'AccountingRegisters') {
        add('Счет', ['ПланСчетовСсылка'], 'std');
        for (let i = 1; i <= 3; i++) add(`Субконто${i}`, ['ЛюбаяСсылка'], 'std');
      }
    } else if (vt === 'обороты' || vt === 'turnovers') {
      for (const [rn, , , rtypes] of resources) {
        add(`${rn}Оборот`, rtypes || ['Число'], 'vt_resource');
        add(`${rn}Turnover`, rtypes || ['Число'], 'vt_resource');
        if (obj.type !== 'AccumulationRegisters' || obj.registerType !== 'Turnovers') {
          add(`${rn}Приход`, rtypes || ['Число'], 'vt_resource');
          add(`${rn}Receipt`, rtypes || ['Число'], 'vt_resource');
          add(`${rn}Расход`, rtypes || ['Число'], 'vt_resource');
          add(`${rn}Expense`, rtypes || ['Число'], 'vt_resource');
        }
        if (obj.type === 'AccountingRegisters') {
          add(`${rn}ОборотДт`, rtypes || ['Число'], 'vt_resource');
          add(`${rn}ОборотКт`, rtypes || ['Число'], 'vt_resource');
        }
      }
      for (const p of ['Период', 'ПериодСекунда', 'ПериодМинута', 'ПериодЧас', 'ПериодДень', 'ПериодНеделя', 'ПериодДекада', 'ПериодМесяц', 'ПериодКвартал', 'ПериодПолугодие', 'ПериодГод', 'Регистратор']) {
        add(p, p === 'Регистратор' ? ['ЛюбаяСсылка'] : ['ДатаВремя'], 'std');
      }
      if (obj.type === 'AccountingRegisters') {
        add('Счет', ['ПланСчетовСсылка'], 'std'); add('КорСчет', ['ПланСчетовСсылка'], 'std');
        for (let i = 1; i <= 3; i++) { add(`Субконто${i}`, ['ЛюбаяСсылка'], 'std'); add(`КорСубконто${i}`, ['ЛюбаяСсылка'], 'std'); }
      }
    } else if (vt === 'остаткииобороты' || vt === 'balanceandturnovers') {
      for (const [rn, , , rtypes] of resources) {
        for (const suf of ['НачальныйОстаток', 'КонечныйОстаток', 'Оборот', 'Приход', 'Расход', 'OpeningBalance', 'ClosingBalance', 'Turnover', 'Receipt', 'Expense']) {
          add(`${rn}${suf}`, rtypes || ['Число'], 'vt_resource');
        }
        if (obj.type === 'AccountingRegisters') {
          for (const suf of ['НачальныйОстатокДт', 'НачальныйОстатокКт', 'КонечныйОстатокДт', 'КонечныйОстатокКт', 'НачальныйРазвернутыйОстатокДт', 'НачальныйРазвернутыйОстатокКт', 'КонечныйРазвернутыйОстатокДт', 'КонечныйРазвернутыйОстатокКт', 'ОборотДт', 'ОборотКт']) {
            add(`${rn}${suf}`, rtypes || ['Число'], 'vt_resource');
          }
        }
      }
      for (const p of ['Период', 'ПериодСекунда', 'ПериодМинута', 'ПериодЧас', 'ПериодДень', 'ПериодНеделя', 'ПериодДекада', 'ПериодМесяц', 'ПериодКвартал', 'ПериодПолугодие', 'ПериодГод', 'Регистратор']) {
        add(p, p === 'Регистратор' ? ['ЛюбаяСсылка'] : ['ДатаВремя'], 'std');
      }
      if (obj.type === 'AccountingRegisters') {
        add('Счет', ['ПланСчетовСсылка'], 'std');
        for (let i = 1; i <= 3; i++) add(`Субконто${i}`, ['ЛюбаяСсылка'], 'std');
      }
    } else {
      // Прочие ВТ регистров (ДвиженияССубконто, ОборотыДтКт, ДанныеГрафика, База и т.п.)
      for (const [rn, , , rtypes] of resources) add(rn, rtypes || [], 'resource');
      for (const [an, , , atypes] of regAttrs) add(an, atypes || [], 'attr');
      add('Период', ['ДатаВремя'], 'std'); add('Регистратор', ['ЛюбаяСсылка'], 'std');
      add('НомерСтроки', ['Число'], 'std'); add('Активность', ['Булево'], 'std');
    }
  } else {
    // Обычные реквизиты и табличные части объекта
    for (const [an, , tag, atypes] of obj.attrs || []) {
      if (tag === 'EnumValue') continue;
      add(an, atypes || [], 'attr');
    }
    for (const ts of obj.ts || []) {
      add(ts.name, [], 'ts', true);
    }
  }

  // Общие реквизиты, применимые к этому объекту
  const fullEngName = `${ (Object.entries(DIR_TO_RU).find(([d]) => d === obj.type) || [''])[0].replace(/s$/, '') }.${obj.name}`;
  for (const ca of schema.commonAttrs) {
    const useMap = ca.contentUse || {};
    const key1 = norm(`${DIR_TO_RU[obj.type]}.${obj.name}`);
    const key2 = norm(fullEngName);
    const explicit = useMap[key1] ?? useMap[key2];
    if (explicit === true || (explicit === undefined && ca.autoUse)) {
      add(ca.name, ca.types || [], 'common_attr');
    }
  }

  const title = `${DIR_TO_RU[obj.type] || obj.type}.${obj.name}${virtualTable ? `.${virtualTable}` : ''}`;
  return { fields, title, obj };
}

// Проверяет корректность имени виртуальной таблицы для конкретного регистра
function validateVirtualTable(obj, vtName) {
  const vt = norm(vtName);
  if (obj.type === 'InformationRegisters') {
    if (vt === 'срезпоследних' || vt === 'slicelast' || vt === 'срезпервых' || vt === 'slicefirst') {
      if (obj.periodicity === 'Nonperiodical') {
        return `РегистрСведений.${obj.name} является непериодическим — виртуальная таблица «${vtName}» для него недоступна.`;
      }
      return null;
    }
    return `У РегистрСведений.${obj.name} нет виртуальной таблицы «${vtName}» (доступны: СрезПоследних, СрезПервых).`;
  }
  if (obj.type === 'AccumulationRegisters') {
    if (vt === 'остатки' || vt === 'balance' || vt === 'остаткииобороты' || vt === 'balanceandturnovers') {
      if (obj.registerType === 'Turnovers') {
        return `РегистрНакопления.${obj.name} — оборотный регистр (Turnovers), виртуальная таблица «${vtName}» недоступна (используйте «Обороты»).`;
      }
      return null;
    }
    if (vt === 'обороты' || vt === 'turnovers') return null;
    return `У РегистрНакопления.${obj.name} нет виртуальной таблицы «${vtName}» (доступны: Остатки, Обороты, ОстаткиИОбороты).`;
  }
  if (obj.type === 'AccountingRegisters') {
    const ok = new Set(['остатки', 'balance', 'обороты', 'turnovers', 'остаткииобороты', 'balanceandturnovers', 'движенияссубконто', 'оборотыдткт', 'субконто']);
    if (!ok.has(vt)) return `У РегистрБухгалтерии.${obj.name} нет виртуальной таблицы «${vtName}».`;
    return null;
  }
  if (obj.type === 'CalculationRegisters') {
    const ok = new Set(['данныеграфика', 'база', 'фактическийпериоддействия', 'перерасчет']);
    if (!ok.has(vt) && !vt.startsWith('база')) return `У РегистрРасчета.${obj.name} неизвестная виртуальная таблица «${vtName}».`;
    return null;
  }
  return `Объект ${DIR_TO_RU[obj.type] || obj.type}.${obj.name} не поддерживает виртуальную таблицу «${vtName}».`;
}

// Проверяет цепочку полей A.B.C относительно источника sourceInfo
function validateFieldChain(chainParts, sourceInfo, schema, issues) {
  let curInfo = sourceInfo;
  for (let i = 0; i < chainParts.length; i++) {
    const part = chainParts[i];
    const pn = norm(part);
    if (!curInfo || curInfo.anyDynamic) return;

    // Если предыдущий шаг был табличной частью (например Док.Товары.Номенклатура)
    if (curInfo.isTsNode) {
      const tsField = curInfo.tsFields.fields.get(pn);
      if (!tsField) {
        const similar = suggestSimilar(part, [...curInfo.tsFields.fields.keys()].map((k) => curInfo.tsFields.fields.get(k).name));
        issues.push({
          severity: 'error',
          message: `Поле «${part}» не найдено в табличной части «${curInfo.tsFields.title}»` +
            (similar.length ? `. Похожие поля: ${similar.join(', ')}` : ''),
        });
        return;
      }
      if (i + 1 < chainParts.length) {
        curInfo = stepIntoFieldTypes(tsField.types, `${curInfo.tsFields.title}.${tsField.name}`, schema, issues);
      }
      continue;
    }

    // Обычный шаг по объекту (или списку возможных целевых объектов составного типа)
    const candidateInfos = curInfo.multiInfos || [curInfo];
    let matchedFields = [];
    for (const info of candidateInfos) {
      if (!info.fields) continue;
      const f = info.fields.get(pn);
      if (f) matchedFields.push({ f, info });
    }

    if (!matchedFields.length) {
      const allFieldNames = [];
      for (const info of candidateInfos) {
        if (info.fields) for (const v of info.fields.values()) allFieldNames.push(v.name);
      }
      const titles = candidateInfos.map((x) => x.title).join(' | ');
      const similar = suggestSimilar(part, allFieldNames);
      issues.push({
        severity: 'error',
        message: `Поле «${part}» не найдено в «${titles}»` +
          (similar.length ? `. Похожие поля: ${similar.join(', ')}` : ''),
      });
      return;
    }

    // Если это обращение к табличной части через точку (Док.Товары.Номенклатура)
    const tsMatch = matchedFields.find((m) => m.f.isTs);
    if (tsMatch && tsMatch.info.obj) {
      const tsFields = getObjectFields(tsMatch.info.obj, schema, { tsName: part });
      if (tsFields) {
        curInfo = { isTsNode: true, tsFields };
        continue;
      }
    }

    if (i + 1 < chainParts.length) {
      const combinedTypes = [...new Set(matchedFields.flatMap((m) => m.f.types || []))];
      const fieldLabel = `${candidateInfos[0].title}.${matchedFields[0].f.name}`;
      curInfo = stepIntoFieldTypes(combinedTypes, fieldLabel, schema, issues);
    }
  }
}

function stepIntoFieldTypes(types, fieldLabel, schema, issues) {
  if (!types || !types.length) return { anyDynamic: true };
  const { targets, anyRef, primitiveOnly, expanded } = resolveTargetObjects(types, schema);
  if (primitiveOnly) {
    issues.push({
      severity: 'error',
      message: `Обращение через точку от примитивного поля «${fieldLabel}» (тип: ${expanded.join(' | ')}) недопустимо.`,
    });
    return null;
  }
  if (anyRef && !targets.length) return { anyDynamic: true };
  const multiInfos = targets.map((t) => getObjectFields(t, schema)).filter(Boolean);
  if (!multiInfos.length) return { anyDynamic: true };
  return multiInfos.length === 1 ? multiInfos[0] : { multiInfos, title: multiInfos.map((m) => m.title).join(' | ') };
}

// Проверка литералов ЗНАЧЕНИЕ(...) / VALUE(...)
function validateValueLiterals(queryText, schema, issues) {
  const rx = /(?<![\wА-Яа-яЁё])(?:ЗНАЧЕНИЕ|VALUE)\s*\(\s*([A-Za-zА-Яа-яЁё0-9_.]+)\s*\)/gi;
  for (const m of queryText.matchAll(rx)) {
    const arg = m[1];
    const parts = arg.split('.');
    if (parts.length < 3) {
      issues.push({
        severity: 'error',
        message: `Некорректный аргумент ЗНАЧЕНИЕ(${arg}): ожидается ВидОбъекта.ИмяОбъекта.Значение (или .ПустаяСсылка).`,
      });
      continue;
    }
    const [kind, objName, valName] = parts;
    const dir = QUERY_TABLE_TYPES.get(norm(kind));
    if (!dir) continue;
    const obj = schema.byTypeAndName.get(`${dir}|${norm(objName)}`);
    if (!obj) {
      const candidates = schema.allObjects.filter((o) => o.type === dir).map((o) => o.name);
      const similar = suggestSimilar(objName, candidates);
      issues.push({
        severity: 'error',
        message: `В ЗНАЧЕНИЕ(${arg}): объект «${kind}.${objName}» не найден в метаданных` +
          (similar.length ? `. Похожие: ${similar.join(', ')}` : ''),
      });
      continue;
    }
    const vn = norm(valName);
    if (vn === 'пустаяссылка' || vn === 'emptyref') continue;
    if (dir === 'Enums') {
      const enumVals = (obj.attrs || []).filter((a) => a[2] === 'EnumValue').map((a) => a[0]);
      if (!enumVals.some((ev) => norm(ev) === vn)) {
        const similar = suggestSimilar(valName, enumVals);
        issues.push({
          severity: 'error',
          message: `В ЗНАЧЕНИЕ(${arg}): значение перечисления «${valName}» не найдено в «Перечисление.${obj.name}»` +
            (similar.length ? `. Похожие: ${similar.join(', ')}` : enumVals.length ? ` (значения: ${enumVals.slice(0, 10).join(', ')})` : ''),
        });
      }
    }
  }
}

// Извлекает колонки секции ВЫБРАТЬ (для временных таблиц ПОМЕСТИТЬ и подзапросов)
function parseSelectColumns(selectClause, aliasMap, schema) {
  const fields = new Map();
  // Убираем ключевые слова РАЗРЕШЕННЫЕ, РАЗЛИЧНЫЕ, ПЕРВЫЕ N и секцию ПОМЕСТИТЬ <ИмяВТ>
  let body = selectClause
    .replace(/(?<![\wА-Яа-яЁё])(?:ПОМЕСТИТЬ|INTO)\s+[A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё]*/gi, '')
    .replace(/^\s*(?:ВЫБРАТЬ|SELECT)(?![\wА-Яа-яЁё])/i, '')
    .replace(/(?<![\wА-Яа-яЁё])(?:РАЗРЕШЕННЫЕ|ALLOWED|РАЗЛИЧНЫЕ|DISTINCT)(?![\wА-Яа-яЁё])/gi, '')
    .replace(/(?<![\wА-Яа-яЁё])(?:ПЕРВЫЕ|TOP)\s+\d+/gi, '')
    .trim();

  // Разбиваем по запятым верхнего уровня (вне скобок)
  const items = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      items.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) items.push(cur.trim());

  let hasWildcard = false;
  for (const item of items) {
    if (!item) continue;
    if (item === '*' || /\.\*\s*$/.test(item)) {
      hasWildcard = true;
      const prefixMatch = item.match(/^([A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё]*)\.\*$/);
      if (prefixMatch) {
        const src = aliasMap.get(norm(prefixMatch[1]));
        if (src && src.fields) {
          for (const [k, v] of src.fields.entries()) fields.set(k, v);
        }
      } else if (aliasMap.size === 1) {
        const [src] = aliasMap.values();
        if (src && src.fields) {
          for (const [k, v] of src.fields.entries()) fields.set(k, v);
        }
      }
      continue;
    }

    let colAlias = null;
    let expr = item;
    // Явный алиас через КАК / AS на верхнем уровне скобок
    const asMatch = item.match(/^([\s\S]+?)\s+(?:КАК|AS)\s+([A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё]*)\s*$/i);
    if (asMatch) {
      expr = asMatch[1].trim();
      colAlias = asMatch[2].trim();
    } else {
      // Без КАК: имя колонки — последний идентификатор цепочки (например Т.Номенклатура.Наименование → НоменклатураНаименование или Поле)
      const chainMatch = item.match(/^([A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё]*(?:\.[A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё]*)*)$/);
      if (chainMatch) {
        const parts = chainMatch[1].split('.');
        if (parts.length === 1) colAlias = parts[0];
        else if (aliasMap.has(norm(parts[0]))) colAlias = parts.slice(1).join('');
        else colAlias = parts.join('');
        // Также добавляем по последнему сегменту, так как 1С иногда именует Поле без префикса таблицы
        if (parts.length === 2 && aliasMap.has(norm(parts[0]))) {
          colAlias = parts[1];
        }
      }
    }

    if (colAlias) {
      // Пытаемся определить тип выражения, если это простая ссылка на поле
      let inferredTypes = [];
      const chainMatch = expr.match(/^([A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё]*(?:\.[A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё]*)*)$/);
      if (chainMatch) {
        const parts = chainMatch[1].split('.');
        let src = aliasMap.get(norm(parts[0]));
        let fieldParts = parts.slice(1);
        if (!src && aliasMap.size === 1) {
          src = [...aliasMap.values()][0];
          fieldParts = parts;
        }
        if (src && src.fields && fieldParts.length === 1) {
          const f = src.fields.get(norm(fieldParts[0]));
          if (f) inferredTypes = f.types || [];
        }
      }
      fields.set(norm(colAlias), { name: colAlias, types: inferredTypes, kind: 'col' });
    }
  }
  return { fields, anyDynamic: hasWildcard && fields.size === 0 };
}

// Заменяет круглые скобки параметров виртуальных таблиц в секции ИЗ на пробелы, но предварительно проверяет условия внутри них
function stripAndValidateVtParams(fromSection, schema, issues, outerAliases) {
  let out = '';
  let i = 0;
  while (i < fromSection.length) {
    if (fromSection[i] === '(') {
      // Находим предшествующее имя таблицы перед «(»
      const before = out.trimEnd();
      const tblMatch = before.match(/([A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё]*(?:\.[A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё]*)+)\s*$/);
      let depth = 1;
      let j = i + 1;
      while (j < fromSection.length && depth > 0) {
        if (fromSection[j] === '(') depth++;
        else if (fromSection[j] === ')') depth--;
        j++;
      }
      const inside = fromSection.slice(i + 1, j - 1);
      if (tblMatch) {
        const parts = tblMatch[1].split('.');
        if (parts.length === 3) {
          const dir = QUERY_TABLE_TYPES.get(norm(parts[0]));
          const obj = dir ? schema.byTypeAndName.get(`${dir}|${norm(parts[1])}`) : null;
          if (obj) {
            const regInfo = getObjectFields(obj, schema, { virtualTable: parts[2] });
            if (regInfo) {
              validateVirtualTableParamsExpr(inside, regInfo, outerAliases, schema, issues);
            }
          }
        }
      }
      out += ' ';
      i = j;
    } else {
      out += fromSection[i];
      i++;
    }
  }
  return out;
}

// Валидирует поля в параметрах виртуальной таблицы регистра (например СрезПоследних(&Период, Валюта = &Валюта))
function validateVirtualTableParamsExpr(paramsText, regInfo, outerAliases, schema, issues) {
  // Разбиваем параметры ВТ по запятым верхнего уровня; условие отбора всегда последний параметр (начиная со 2-го)
  const args = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < paramsText.length; i++) {
    const ch = paramsText[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { args.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) args.push(cur.trim());
  if (args.length < 2) return;
  const filterExpr = args[args.length - 1];
  const cleaned = filterExpr.replace(/"[^"]*"/g, '""').replace(/(?<![\wА-Яа-яЁё])(?:ЗНАЧЕНИЕ|VALUE|ТИП|TYPE)\s*\([^)]*\)/gi, ' ');
  const chainRx = /(?<![&\wА-Яа-яЁё])([A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё]*(?:\.[A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё]*)*)/g;
  for (const m of cleaned.matchAll(chainRx)) {
    const token = m[1];
    const parts = token.split('.');
    const first = norm(parts[0]);
    if (QUERY_KEYWORDS.has(first) || /^\d/.test(parts[0]) || /^__subq_\d+__$/i.test(first)) continue;
    if (outerAliases && outerAliases.has(first) && parts.length > 1) {
      validateFieldChain(parts.slice(1), outerAliases.get(first), schema, issues);
      continue;
    }
    validateFieldChain(parts, regInfo, schema, issues);
  }
}

// Разбор одной выборки (без UNION и без вложенных (ВЫБРАТЬ ...))
function validateSingleSelect(stmt, schema, tempTables, outerAliases, issues, stats) {
  // Отрезаем строковые литералы для безопасного разбора структуры
  const maskStrings = (s) => s.replace(/"(?:""|[^"])*"/g, '""');
  const masked = maskStrings(stmt);

  // Проверяем наличие ПОМЕСТИТЬ <ИмяВТ>
  let intoTable = null;
  const intoMatch = masked.match(/(?<![\wА-Яа-яЁё])(?:ПОМЕСТИТЬ|INTO)\s+([A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё]*)/i);
  if (intoMatch) intoTable = intoMatch[1];

  // Выделяем секцию ВЫБРАТЬ ... до ИЗ (или до конца, если запроса без ИЗ)
  const fromMatch = masked.match(/(?<![\wА-Яа-яЁё.])(?:ИЗ|FROM)(?![\wА-Яа-яЁё])/i);
  const selectClause = fromMatch ? masked.slice(0, fromMatch.index) : masked;
  const afterFrom = fromMatch ? masked.slice(fromMatch.index + fromMatch[0].length) : '';

  // Выделяем секцию источников (от ИЗ до ГДЕ / СГРУППИРОВАТЬ / УПОРЯДОЧИТЬ / ИМЕЮЩИЕ / ИТОГИ / АВТОУПОРЯДОЧИВАНИЕ / ИНДЕКСИРОВАТЬ)
  const tailMatch = afterFrom.match(/(?<![\wА-Яа-яЁё.])(?:ГДЕ|WHERE|СГРУППИРОВАТЬ|GROUP|УПОРЯДОЧИТЬ|ORDER|ИМЕЮЩИЕ|HAVING|ИТОГИ|TOTALS|АВТОУПОРЯДОЧИВАНИЕ|AUTOORDER|ИНДЕКСИРОВАТЬ|INDEX)(?![\wА-Яа-яЁё])/i);
  const rawFromSection = tailMatch ? afterFrom.slice(0, tailMatch.index) : afterFrom;

  const aliasMap = new Map();
  if (outerAliases) {
    for (const [k, v] of outerAliases.entries()) aliasMap.set(k, v);
  }
  const localAliases = new Map();

  if (rawFromSection.trim()) {
    const cleanFrom = stripAndValidateVtParams(rawFromSection, schema, issues, aliasMap);
    // Разбиваем по СОЕДИНЕНИЕ / JOIN или запятым, извлекая источники таблиц до ключевого слова ПО / ON
    // Шаблон источника: <Таблица> [КАК|AS] [Алиас]
    const sourceSegments = cleanFrom.split(/(?<![\wА-Яа-яЁё])(?:(?:ЛЕВОЕ|ПРАВОЕ|ПОЛНОЕ|ВНУТРЕННЕЕ|ВНЕШНЕЕ|LEFT|RIGHT|FULL|INNER|OUTER)\s+)*(?:СОЕДИНЕНИЕ|JOIN)(?![\wА-Яа-яЁё])|,/i);
    for (const seg of sourceSegments) {
      // Отсекаем условие соединения ПО / ON ...
      const onSplit = seg.split(/(?<![\wА-Яа-яЁё.])(?:ПО|ON)(?![\wА-Яа-яЁё])/i);
      const tableSpec = onSplit[0].trim();
      if (!tableSpec) continue;

      const tm = tableSpec.match(/^([A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё]*(?:\.[A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё]*)*)(?:\s+(?:(?:КАК|AS)\s+)?([A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё]*))?/i);
      if (!tm) continue;
      const rawTableName = tm[1];
      let alias = tm[2];
      if (alias && QUERY_KEYWORDS.has(norm(alias))) alias = null;

      const resolved = resolveTableSource(rawTableName, schema, tempTables, issues);
      stats.tablesChecked++;
      if (resolved) {
        const defaultAlias = rawTableName.replace(/\./g, '');
        const finalAlias = alias || partsDefaultAlias(rawTableName) || defaultAlias;
        localAliases.set(norm(finalAlias), resolved);
        aliasMap.set(norm(finalAlias), resolved);
        // В 1С к таблице без явного КАК можно обращаться и по последнему сегменту, и по склеенному имени ВидИмя
        if (!alias) {
          const lastSeg = rawTableName.split('.').pop();
          localAliases.set(norm(lastSeg), resolved);
          aliasMap.set(norm(lastSeg), resolved);
          localAliases.set(norm(defaultAlias), resolved);
          aliasMap.set(norm(defaultAlias), resolved);
        }
      } else if (alias) {
        // Таблица не найдена — регистрируем пустую заглушку, чтобы не сыпать каскадными ошибками по алиасу
        const dummy = { anyDynamic: true, title: rawTableName };
        localAliases.set(norm(alias), dummy);
        aliasMap.set(norm(alias), dummy);
      }
    }
  }

  // Извлекаем выходные колонки ВЫБРАТЬ
  const selectCols = parseSelectColumns(selectClause, localAliases.size ? localAliases : aliasMap, schema);
  if (intoTable) {
    tempTables.set(norm(intoTable), {
      fields: selectCols.fields,
      anyDynamic: selectCols.anyDynamic,
      title: `ВТ «${intoTable}»`,
    });
  }

  // Проверяем все обращения вида Алиас.Поле1.Поле2 во всём тексте запроса (кроме секции имен таблиц в ИЗ и литералов ЗНАЧЕНИЕ/ТИП)
  // Чтобы не принимать само имя таблицы «Справочник.Номенклатура» в секции ИЗ за обращение к полю, вырежем имена таблиц из rawFromSection
  const cleanedForChains = masked
    .replace(/(?<![\wА-Яа-яЁё])(?:ЗНАЧЕНИЕ|VALUE|ТИП|TYPE)\s*\([^)]*\)/gi, ' ')
    .replace(/(?<![\wА-Яа-яЁё])(?:ПОМЕСТИТЬ|INTO)\s+[A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё]*/gi, ' ');

  // Собираем диапазоны символов, где стоят сами имена таблиц после ИЗ / СОЕДИНЕНИЕ
  const tableNameSpans = [];
  const tblDeclRx = /(?<![\wА-Яа-яЁё.])(?:ИЗ|FROM|СОЕДИНЕНИЕ|JOIN)\s+([A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё]*(?:\.[A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё]*)*)/gi;
  for (const m of cleanedForChains.matchAll(tblDeclRx)) {
    const start = m.index + m[0].length - m[1].length;
    tableNameSpans.push([start, start + m[1].length]);
  }
  const inTableDecl = (pos) => tableNameSpans.some(([s, e]) => pos >= s && pos < e);

  // 1) Проверяем квалифицированные цепочки (Алиас.Поле1[.Поле2...])
  const dotChainRx = /(?<![&\wА-Яа-яЁё.])([A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё]*(?:\.[A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё]*)+)/g;
  for (const m of cleanedForChains.matchAll(dotChainRx)) {
    if (inTableDecl(m.index)) continue;
    const parts = m[1].split('.');
    const first = norm(parts[0]);
    if (QUERY_KEYWORDS.has(first) || /^\d/.test(parts[0])) continue;

    if (aliasMap.has(first)) {
      stats.fieldsChecked++;
      validateFieldChain(parts.slice(1), aliasMap.get(first), schema, issues);
    } else if (localAliases.size === 1) {
      // В запросе с одной таблицей «Договор.Валюта» может начинаться сразу с поля единственной таблицы!
      const [onlySource] = localAliases.values();
      stats.fieldsChecked++;
      validateFieldChain(parts, onlySource, schema, issues);
    } else if (localAliases.size > 1) {
      // Проверим, не является ли parts[0] полем ровно одной из таблиц запроса
      const matchingSources = [...localAliases.values()].filter((s) => s.fields && s.fields.has(first));
      if (matchingSources.length === 1) {
        stats.fieldsChecked++;
        validateFieldChain(parts, matchingSources[0], schema, issues);
      } else if (!QUERY_TABLE_TYPES.has(first)) {
        const similar = suggestSimilar(parts[0], [...localAliases.keys()]);
        issues.push({
          severity: 'error',
          message: `Неизвестный псевдоним таблицы (или поле) «${parts[0]}» в выражении «${m[1]}»` +
            (similar.length ? `. Доступные псевдонимы: ${[...localAliases.keys()].join(', ')}` : ''),
        });
      }
    }
  }

  // 2) Если в запросе ровно одна таблица в ИЗ (и она не динамическая), проверяем также простые (неквалифицированные) поля в ВЫБРАТЬ и ГДЕ
  if (localAliases.size === 1) {
    const [onlySource] = localAliases.values();
    if (onlySource && onlySource.fields && !onlySource.anyDynamic) {
      // Собираем алиасы колонок ВЫБРАТЬ (... КАК АлиасКолонки), чтобы не ругаться на них в УПОРЯДОЧИТЬ ПО / СГРУППИРОВАТЬ ПО
      const colAliases = new Set(selectCols.fields.keys());
      // Проверяем простые поля в списке ВЫБРАТЬ (до КАК)
      const selectBody = selectClause
        .replace(/(?<![\wА-Яа-яЁё])(?:ПОМЕСТИТЬ|INTO)\s+[A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё]*/gi, '')
        .replace(/^\s*(?:ВЫБРАТЬ|SELECT)(?![\wА-Яа-яЁё])/i, '')
        .replace(/(?<![\wА-Яа-яЁё])(?:РАЗРЕШЕННЫЕ|ALLOWED|РАЗЛИЧНЫЕ|DISTINCT)(?![\wА-Яа-яЁё])/gi, '')
        .replace(/(?<![\wА-Яа-яЁё])(?:ПЕРВЫЕ|TOP)\s+\d+/gi, '');
      const items = selectBody.split(',');
      for (const rawItem of items) {
        const expr = rawItem.replace(/\s+(?:КАК|AS)\s+[A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё]*\s*$/i, '').trim();
        if (/^[A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё]*$/.test(expr)) {
          const fn = norm(expr);
          if (!QUERY_KEYWORDS.has(fn) && !aliasMap.has(fn) && !onlySource.fields.has(fn)) {
            stats.fieldsChecked++;
            const similar = suggestSimilar(expr, [...onlySource.fields.values()].map((v) => v.name));
            issues.push({
              severity: 'error',
              message: `Поле «${expr}» не найдено в «${onlySource.title}»` +
                (similar.length ? `. Похожие поля: ${similar.join(', ')}` : ''),
            });
          } else if (onlySource.fields.has(fn)) {
            stats.fieldsChecked++;
          }
        }
      }
      // Проверяем левые части простых условий в ГДЕ
      const whereMatch = afterFrom.match(/(?<![\wА-Яа-яЁё.])(?:ГДЕ|WHERE)(?![\wА-Яа-яЁё])([\s\S]*?)(?:(?<![\wА-Яа-яЁё.])(?:СГРУППИРОВАТЬ|GROUP|УПОРЯДОЧИТЬ|ORDER|ИМЕЮЩИЕ|HAVING|ИТОГИ|TOTALS|АВТОУПОРЯДОЧИВАНИЕ|AUTOORDER|ИНДЕКСИРОВАТЬ|INDEX)(?![\wА-Яа-яЁё])|$)/i);
      if (whereMatch) {
        const whereBody = maskStrings(whereMatch[1]).replace(/(?<![\wА-Яа-яЁё])(?:ЗНАЧЕНИЕ|VALUE|ТИП|TYPE)\s*\([^)]*\)/gi, ' ');
        const bareCondRx = /(?<![.&\wА-Яа-яЁё])([A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё]*)\s*(?:=|<>|<=|>=|<|>|(?<![\wА-Яа-яЁё])(?:В|IN|МЕЖДУ|BETWEEN|ПОДОБНО|LIKE|ЕСТЬ|IS)(?![\wА-Яа-яЁё]))/gi;
        for (const cm of whereBody.matchAll(bareCondRx)) {
          const ident = cm[1];
          const fn = norm(ident);
          if (QUERY_KEYWORDS.has(fn) || colAliases.has(fn) || aliasMap.has(fn) || /^\d/.test(ident) || /^__subq_\d+__$/i.test(fn)) continue;
          stats.fieldsChecked++;
          if (!onlySource.fields.has(fn)) {
            const similar = suggestSimilar(ident, [...onlySource.fields.values()].map((v) => v.name));
            issues.push({
              severity: 'error',
              message: `Поле «${ident}» в условии ГДЕ не найдено в «${onlySource.title}»` +
                (similar.length ? `. Похожие поля: ${similar.join(', ')}` : ''),
            });
          }
        }
      }
    }
  }

  return selectCols;
}

function partsDefaultAlias(rawTableName) {
  const parts = rawTableName.split('.');
  if (parts.length === 2) return `${parts[0]}${parts[1]}`;
  if (parts.length === 3) return `${parts[0]}${parts[1]}${parts[2]}`;
  return parts[0];
}

// Разрешает имя таблицы из секции ИЗ / СОЕДИНЕНИЕ в структуру полей
function resolveTableSource(rawTableName, schema, tempTables, issues) {
  const parts = rawTableName.split('.');
  const first = norm(parts[0]);

  // 1. Временная таблица или уже свёрнутый подзапрос __SUBQ_N__
  if (parts.length === 1) {
    if (tempTables.has(first)) return tempTables.get(first);
    const similarTemp = suggestSimilar(parts[0], [...tempTables.keys()]);
    issues.push({
      severity: 'error',
      message: `Временная таблица (или источник) «${rawTableName}» не найдена в пакете запросов` +
        (similarTemp.length ? `. Доступные ВТ: ${similarTemp.join(', ')}` : ''),
    });
    return null;
  }

  // 2. Временная таблица с обращением к табличной части? Нет, это объект метаданных Вид.Имя[.ТЧ_или_ВТ]
  const dir = QUERY_TABLE_TYPES.get(first);
  if (!dir) {
    // Возможно это обращение к ТЧ временной таблицы или опечатка в виде метаданных
    const similarKinds = suggestSimilar(parts[0], [
      'Справочник', 'Документ', 'РегистрСведений', 'РегистрНакопления', 'РегистрБухгалтерии',
      'РегистрРасчета', 'Перечисление', 'ПланВидовХарактеристик', 'ПланСчетов', 'ПланВидовРасчета',
      'Константа', 'БизнесПроцесс', 'Задача', 'ПланОбмена', 'ЖурналДокументов',
    ]);
    issues.push({
      severity: 'error',
      message: `Неизвестный вид таблицы метаданных «${parts[0]}» в «${rawTableName}»` +
        (similarKinds.length ? `. Возможно имелось в виду: ${similarKinds.join(', ')}` : ''),
    });
    return null;
  }

  const objName = parts[1];
  const obj = schema.byTypeAndName.get(`${dir}|${norm(objName)}`);
  if (!obj) {
    const candidates = schema.allObjects.filter((o) => o.type === dir).map((o) => o.name);
    const similar = suggestSimilar(objName, candidates);
    issues.push({
      severity: 'error',
      message: `Объект метаданных «${DIR_TO_RU[dir] || parts[0]}.${objName}» не найден в конфигурации` +
        (similar.length ? `. Похожие объекты: ${similar.join(', ')}` : ''),
    });
    return null;
  }

  if (parts.length === 2) {
    return getObjectFields(obj, schema);
  }

  // parts.length >= 3: либо виртуальная таблица регистра, либо табличная часть объекта, либо табличная часть + виртуальная
  const subName = parts[2];
  if (dir.endsWith('Registers')) {
    const vtErr = validateVirtualTable(obj, subName);
    if (vtErr) {
      issues.push({ severity: 'error', message: vtErr });
      return getObjectFields(obj, schema);
    }
    return getObjectFields(obj, schema, { virtualTable: subName });
  }

  // Табличная часть объекта (Документ.ЗаказКлиента.Товары)
  const tsInfo = getObjectFields(obj, schema, { tsName: subName });
  if (!tsInfo) {
    const tsNames = (obj.ts || []).map((t) => t.name);
    const similar = suggestSimilar(subName, tsNames);
    issues.push({
      severity: 'error',
      message: `Табличная часть «${subName}» не найдена в объекте «${DIR_TO_RU[dir] || parts[0]}.${obj.name}»` +
        (similar.length ? `. Доступные ТЧ: ${tsNames.join(', ')}` : tsNames.length ? ` (доступные ТЧ: ${tsNames.join(', ')})` : ' (у объекта нет табличных частей)'),
    });
    return null;
  }
  return tsInfo;
}

// Обрабатывает пакетный запрос (с поддержкой ОБЪЕДИНИТЬ и вложенных подзапросов)
function validateBatchStatement(stmt, schema, tempTables, issues, stats) {
  const trimmed = stmt.trim();
  if (!trimmed) return;

  // УНИЧТОЖИТЬ <ИмяВТ> / DROP <TempTable>
  const dropMatch = trimmed.match(/^\s*(?:УНИЧТОЖИТЬ|DROP)\s+([A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё]*)\s*$/i);
  if (dropMatch) {
    const tn = norm(dropMatch[1]);
    if (!tempTables.has(tn)) {
      issues.push({
        severity: 'warning',
        message: `УНИЧТОЖИТЬ ${dropMatch[1]}: временная таблица «${dropMatch[1]}» ранее не создавалась в этом пакете.`,
      });
    } else {
      tempTables.delete(tn);
    }
    return;
  }

  // Проверяем ЗНАЧЕНИЕ(...) во всём запросе пакета
  validateValueLiterals(trimmed, schema, issues);

  // Рекурсивно сворачиваем вложенные подзапросы (ВЫБРАТЬ ...) от самых внутренних к внешним
  let work = trimmed;
  let subqCounter = 0;
  const subqRx = /\(\s*((?:ВЫБРАТЬ|SELECT)(?![\wА-Яа-яЁё])[^()]*)\)/i;
  while (subqRx.test(work) && subqCounter < 50) {
    work = work.replace(subqRx, (_, innerSelect) => {
      subqCounter++;
      const subName = `__SUBQ_${subqCounter}__`;
      const cols = validateUnionQuery(innerSelect, schema, tempTables, null, issues, stats);
      tempTables.set(norm(subName), {
        fields: cols ? cols.fields : new Map(),
        anyDynamic: cols ? cols.anyDynamic : true,
        title: `Подзапрос #${subqCounter}`,
      });
      return ` ${subName} `;
    });
  }

  validateUnionQuery(work, schema, tempTables, null, issues, stats);
}

function validateUnionQuery(queryText, schema, tempTables, outerAliases, issues, stats) {
  const parts = queryText.split(/(?<![\wА-Яа-яЁё])(?:ОБЪЕДИНИТЬ(?:\s+ВСЕ)?|UNION(?:\s+ALL)?)(?![\wА-Яа-яЁё])/i);
  let firstCols = null;
  for (const p of parts) {
    const cols = validateSingleSelect(p, schema, tempTables, outerAliases, issues, stats);
    if (!firstCols && cols) firstCols = cols;
  }
  return firstCols;
}

export function validateQuery(idx, { query }) {
  const cleaned = cleanQueryText(query);
  if (!cleaned.trim()) return 'Пустой текст запроса.';

  const schema = buildSchemaIndex(idx);
  const tempTables = new Map();
  const issues = [];
  const stats = { statements: 0, tablesChecked: 0, fieldsChecked: 0 };

  // Разбиваем пакет запросов по «;» вне кавычек
  const statements = [];
  let cur = '';
  let inStr = false;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === '"') inStr = !inStr;
    if (ch === ';' && !inStr) {
      if (cur.trim()) statements.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) statements.push(cur.trim());

  for (const stmt of statements) {
    stats.statements++;
    validateBatchStatement(stmt, schema, tempTables, issues, stats);
  }

  const errors = issues.filter((x) => x.severity === 'error');
  const warnings = issues.filter((x) => x.severity === 'warning');

  if (!errors.length && !warnings.length) {
    return `[OK] Запрос корректен по схеме метаданных (пакетов: ${stats.statements}, проверено таблиц: ${stats.tablesChecked}, обращений к полям: ${stats.fieldsChecked}).`;
  }

  const lines = [
    `Результат проверки запроса: ошибок — ${errors.length}, предупреждений — ${warnings.length} ` +
      `(пакетов: ${stats.statements}, проверено таблиц: ${stats.tablesChecked}, полей: ${stats.fieldsChecked}).`,
  ];
  for (const e of errors) lines.push(`[ОШИБКА] ${e.message}`);
  for (const w of warnings) lines.push(`[ПРЕДУПРЕЖДЕНИЕ] ${w.message}`);
  return lines.join('\n');
}
