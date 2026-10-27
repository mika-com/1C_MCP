// event-log.mjs — чтение Журнала регистрации 1С (SQLite 1Cv8.lgd и текстовый формат 1Cv8.lgf + *.lgp)
// без запуска 1С. Автоматически находит путь к базе из .v8-project.json, извлекает ошибки,
// комментарии и привязывает стек-трейс BSL ({Модуль(Строка)}) к реальным файлам .bsl в рабочей папке.

import { existsSync, readFileSync, readdirSync, statSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, relative, sep, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');

const SEVERITY_MAP = {
  1: 'Информация',
  2: 'Предупреждение',
  3: 'Ошибка',
  4: 'Примечание',
  I: 'Информация',
  W: 'Предупреждение',
  E: 'Ошибка',
  N: 'Примечание',
};

const EVENT_NAMES_RU = {
  '_$PerformError$_': 'Ошибка выполнения',
  '_$Data$_.Post': 'Проведение документа',
  '_$Data$_.Unpost': 'Отмена проведения',
  '_$Data$_.Write': 'Запись данных',
  '_$Data$_.Delete': 'Удаление данных',
  '_$Job$_.Fail': 'Ошибка фонового задания',
  '_$Job$_.Start': 'Запуск фонового задания',
  '_$Job$_.Terminate': 'Принудительное завершение фонового задания',
  '_$Session$_.Start': 'Начало сеанса',
  '_$Session$_.Finish': 'Завершение сеанса',
  '_$Session$_.AuthenticationError': 'Ошибка аутентификации',
  '_$InfoBase$_.ConfigExtensionApplyError': 'Ошибка применения расширения',
  '_$InfoBase$_.DBConfigUpdate': 'Обновление конфигурации БД',
  '_$Transaction$_.RollBack': 'Отмена транзакции',
};

// Секунд от 0001-01-01 00:00:00 до 1970-01-01 00:00:00 (григорианский календарь 1С)
const SEC_0001_TO_1970 = 62135596800;

export function format1CDate(val) {
  if (val === null || val === undefined || val === '') return '';
  const s = String(val).trim();
  // Формат текстового .lgp: YYYYMMDDHHMMSS
  const m14 = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (m14) return `${m14[1]}-${m14[2]}-${m14[3]} ${m14[4]}:${m14[5]}:${m14[6]}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.replace('T', ' ').replace(/\.\d+Z?$/, '');

  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0) return s;

  let unixMs;
  if (n > 1e13) {
    // Тики 1С в 1Cv8.lgd: 100 микросекунд (1e-4 сек) от 0001-01-01 00:00:00
    unixMs = Math.round(n / 10) - SEC_0001_TO_1970 * 1000;
  } else if (n > 5e10 && n < 1e12) {
    // Секунды от 0001-01-01 00:00:00
    unixMs = (n - SEC_0001_TO_1970) * 1000;
  } else if (n > 1e12) {
    // Unix миллисекунды
    unixMs = n;
  } else {
    // Unix секунды
    unixMs = n * 1000;
  }
  const d = new Date(unixMs);
  if (Number.isNaN(d.getTime())) return s;
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

// Поиск пути к каталогу 1Cv8Log или файлу 1Cv8.lgd по аргументам и .v8-project.json
export function resolveLogLocation(root, { log_path, database } = {}) {
  const candidates = [];

  if (log_path) {
    const p = resolve(root, log_path);
    candidates.push({ path: p, label: log_path });
  }

  // Читаем .v8-project.json, если есть
  const v8ProjPath = join(root, '.v8-project.json');
  let serverDbNotice = null;
  if (existsSync(v8ProjPath)) {
    try {
      const proj = JSON.parse(readFileSync(v8ProjPath, 'utf8').replace(/^\uFEFF/, ''));
      const dbs = Array.isArray(proj.databases) ? proj.databases : [];
      let selected = null;
      if (database) {
        const q = norm(database);
        selected = dbs.find((d) => norm(d.id) === q) ||
          dbs.find((d) => Array.isArray(d.aliases) && d.aliases.some((a) => norm(a) === q)) ||
          dbs.find((d) => norm(d.name).includes(q));
      }
      if (!selected && proj.default) {
        selected = dbs.find((d) => d.id === proj.default);
      }
      const ordered = selected ? [selected, ...dbs.filter((d) => d !== selected)] : dbs;
      for (const db of ordered) {
        if (db.path) {
          const dbDir = resolve(root, db.path);
          candidates.push({ path: join(dbDir, '1Cv8Log'), label: `база «${db.name || db.id}» (${db.path})` });
          candidates.push({ path: dbDir, label: `база «${db.name || db.id}» (${db.path})` });
        } else if (db.type === 'server' && (selected === db || !candidates.length)) {
          serverDbNotice = `База «${db.name || db.id}» (${db.server}/${db.ref}) — серверная. ` +
            'Для чтения её журнала укажите log_path (путь к каталогу 1Cv8Log кластера 1С или выгруженному файлу 1Cv8.lgd).';
        }
      }
    } catch { /* некорректный .v8-project.json */ }
  }

  // Стандартные локальные пути сборки в проекте
  for (const sub of ['1Cv8Log', 'build/ib/1Cv8Log', 'ib/1Cv8Log', 'base/1Cv8Log', 'tmp/ib/1Cv8Log']) {
    candidates.push({ path: join(root, sub), label: sub });
  }

  for (const c of candidates) {
    const found = inspectLogTarget(c.path);
    if (found) return { ...found, label: c.label };
  }

  return { error: serverDbNotice || 'Журнал регистрации (1Cv8.lgd или *.lgp) не найден. Передайте log_path (путь к 1Cv8.lgd, папке 1Cv8Log или каталогу файловой базы) либо настройте путь к файловой базе в .v8-project.json.' };
}

function inspectLogTarget(targetPath) {
  if (!existsSync(targetPath)) return null;
  let st;
  try { st = statSync(targetPath); } catch { return null; }

  if (st.isFile()) {
    if (targetPath.toLowerCase().endsWith('.lgd')) return { kind: 'lgd', file: targetPath, dir: dirname(targetPath) };
    if (targetPath.toLowerCase().endsWith('.lgp')) return { kind: 'lgp', files: [targetPath], lgf: join(dirname(targetPath), '1Cv8.lgf'), dir: dirname(targetPath) };
    return null;
  }

  if (st.isDirectory()) {
    // 1. Прямо внутри папки лежит 1Cv8.lgd или 1Cv8Log/1Cv8.lgd
    for (const dir of [targetPath, join(targetPath, '1Cv8Log')]) {
      if (!existsSync(dir)) continue;
      const lgd = join(dir, '1Cv8.lgd');
      if (existsSync(lgd)) return { kind: 'lgd', file: lgd, dir };
      try {
        const lgps = readdirSync(dir)
          .filter((f) => f.toLowerCase().endsWith('.lgp'))
          .sort()
          .map((f) => join(dir, f));
        if (lgps.length) return { kind: 'lgp', files: lgps, lgf: join(dir, '1Cv8.lgf'), dir };
      } catch { /* */ }
    }
  }
  return null;
}

// Выполняет SQL-запрос к SQLite-файлу 1Cv8.lgd через встроенный node:sqlite (или sqlite3 CLI)
async function querySqliteLgd(lgdFile, sql, params = []) {
  // Копируем во временную папку, если есть -wal/-shm или чтобы не блокировать монопольный доступ 1С
  const tmp = mkdtempSync(join(tmpdir(), '1c-lgd-'));
  const copyPath = join(tmp, '1Cv8.lgd');
  try {
    copyFileSync(lgdFile, copyPath);
    for (const suf of ['-wal', '-shm', '-journal']) {
      if (existsSync(lgdFile + suf)) {
        try { copyFileSync(lgdFile + suf, copyPath + suf); } catch { /* */ }
      }
    }
    try {
      const sqlite = await import('node:sqlite');
      const db = new sqlite.DatabaseSync(copyPath, { readOnly: true });
      try {
        const stmt = db.prepare(sql);
        return stmt.all(...params);
      } finally {
        db.close();
      }
    } catch (err) {
      // Fallback на системную утилиту sqlite3, если node:sqlite недоступен
      const out = execFileSync('sqlite3', ['-json', copyPath, sql], { encoding: 'utf8', timeout: 10000 });
      return out.trim() ? JSON.parse(out) : [];
    }
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  }
}

async function readSqliteEvents(lgdFile, { errorsOnly, limit, search, eventFilter, sinceMinutes }) {
  // Узнаем список таблиц и колонок в 1Cv8.lgd (схема может слегка отличаться между версиями 8.3)
  const tables = await querySqliteLgd(lgdFile, "SELECT name FROM sqlite_master WHERE type='table'");
  const tableSet = new Set(tables.map((t) => t.name.toLowerCase()));
  if (!tableSet.has('eventlog')) {
    throw new Error(`В файле ${basename(lgdFile)} отсутствует таблица EventLog.`);
  }

  const colsInfo = await querySqliteLgd(lgdFile, 'PRAGMA table_info(EventLog)');
  const colSet = new Set(colsInfo.map((c) => c.name.toLowerCase()));

  const hasUser = tableSet.has('usercodes') && colSet.has('usercode');
  const hasApp = tableSet.has('appcodes') && colSet.has('appcode');
  const hasEvent = tableSet.has('eventcodes') && colSet.has('eventcode');
  const hasMetaTable = tableSet.has('eventlogmetadata') && tableSet.has('metadatacodes');
  const hasMetaCol = colSet.has('metadatacodes') && tableSet.has('metadatacodes');

  const selectParts = [
    'e.RowID AS rowId',
    'e.Date AS date',
    colSet.has('severity') ? 'e.Severity AS severity' : '3 AS severity',
    colSet.has('comment') ? 'e.Comment AS comment' : "'' AS comment",
    colSet.has('datapresentation') ? 'e.DataPresentation AS dataPresentation' : "'' AS dataPresentation",
    colSet.has('session') ? 'e.Session AS session' : '0 AS session',
    colSet.has('transactionstatus') ? 'e.TransactionStatus AS transactionStatus' : '0 AS transactionStatus',
    hasUser ? 'u.Name AS userName' : "'' AS userName",
    hasApp ? 'a.Name AS appName' : "'' AS appName",
    hasEvent ? 'ev.Name AS eventName' : "'' AS eventName",
  ];

  if (hasMetaTable) {
    selectParts.push('(SELECT GROUP_CONCAT(m.Name, \', \') FROM EventLogMetadata elm JOIN MetadataCodes m ON m.Code = elm.MetadataCode WHERE elm.EventLogID = e.RowID) AS metadataName');
  } else if (hasMetaCol) {
    selectParts.push('(SELECT m.Name FROM MetadataCodes m WHERE m.Code = CAST(e.MetadataCodes AS INTEGER) LIMIT 1) AS metadataName');
  } else {
    selectParts.push("'' AS metadataName");
  }

  const joins = [];
  if (hasUser) joins.push('LEFT JOIN UserCodes u ON u.Code = e.UserCode');
  if (hasApp) joins.push('LEFT JOIN AppCodes a ON a.Code = e.AppCode');
  if (hasEvent) joins.push('LEFT JOIN EventCodes ev ON ev.Code = e.EventCode');

  const where = [];
  if (errorsOnly && colSet.has('severity')) {
    where.push('e.Severity = 3');
  }
  const fetchLimit = Math.max(limit * 5, 200);
  const sql = `SELECT ${selectParts.join(', ')} FROM EventLog e ${joins.join(' ')}` +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ` ORDER BY e.RowID DESC LIMIT ${Number(fetchLimit)}`;

  const rows = await querySqliteLgd(lgdFile, sql);
  return filterAndNormalizeEvents(rows, { errorsOnly, limit, search, eventFilter, sinceMinutes });
}

// Чтение текстового журнала регистрации (1Cv8.lgf + *.lgp)
function parseLgfDictionaries(lgfFile) {
  const dicts = { 1: new Map(), 2: new Map(), 3: new Map(), 4: new Map(), 5: new Map() };
  if (!lgfFile || !existsSync(lgfFile)) return dicts;
  let text = '';
  try { text = readFileSync(lgfFile, 'utf8').replace(/^\uFEFF/, ''); } catch { return dicts; }
  // Записи справочника в 1Cv8.lgf имеют вид: {Тип, "UUID_или_Имя", "Имя", Код} или {Тип, "Имя", Код}
  const rx = /\{\s*(\d+)\s*,\s*"([^"]*)"(?:\s*,\s*"([^"]*)")?\s*,\s*(\d+)\s*\}/g;
  for (const m of text.matchAll(rx)) {
    const type = Number(m[1]);
    const name = m[3] !== undefined ? (m[3] || m[2]) : m[2];
    const code = Number(m[4]);
    if (dicts[type]) dicts[type].set(code, name);
  }
  return dicts;
}

function readLgpEvents(files, lgfFile, { errorsOnly, limit, search, eventFilter, sinceMinutes }) {
  const dicts = parseLgfDictionaries(lgfFile);
  const rows = [];
  // Читаем файлы с конца (от самых свежих)
  for (const file of [...files].reverse()) {
    let text = '';
    try { text = readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); } catch { continue; }
    // Находим блоки записей, начинающиеся с {ГГГГММДДЧЧММСС,
    const recStarts = [...text.matchAll(/\{(\d{14}),([A-Z]),/g)];
    for (let i = recStarts.length - 1; i >= 0; i--) {
      const startIdx = recStarts[i].index;
      const endIdx = i + 1 < recStarts.length ? recStarts[i + 1].index : text.length;
      const block = text.slice(startIdx, endIdx).trim();
      const parsed = parseSingleLgpRecord(block, dicts, rows.length + 1);
      if (parsed) rows.push(parsed);
      if (rows.length >= Math.max(limit * 5, 200)) break;
    }
    if (rows.length >= Math.max(limit * 5, 200)) break;
  }
  return filterAndNormalizeEvents(rows, { errorsOnly, limit, search, eventFilter, sinceMinutes });
}

function parseSingleLgpRecord(block, dicts, rowId) {
  // Формат: {20261024223015,N,{0,0},UserCode,ComputerCode,AppCode,Connection,EventCode,Severity,"Comment",...}
  const m = block.match(/^\{\s*(\d{14})\s*,\s*([A-Z])\s*,\s*\{[^}]*\}\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([IWEN])\s*,\s*"((?:""|[^"])*)"/s);
  if (!m) return null;
  const [, dateStr, txStatus, userCode, , appCode, session, eventCode, sevChar, rawComment] = m;
  const severity = { I: 1, W: 2, E: 3, N: 4 }[sevChar] || 1;
  const comment = rawComment.replace(/""/g, '"');
  return {
    rowId,
    date: dateStr,
    severity,
    comment,
    dataPresentation: '',
    session: Number(session) || 0,
    transactionStatus: txStatus,
    userName: dicts[1].get(Number(userCode)) || '',
    appName: dicts[3].get(Number(appCode)) || '',
    eventName: dicts[4].get(Number(eventCode)) || '',
    metadataName: '',
  };
}

function filterAndNormalizeEvents(rows, { errorsOnly, limit, search, eventFilter, sinceMinutes }) {
  const q = search ? norm(search) : '';
  const evQ = eventFilter ? norm(eventFilter) : '';
  const minTimeMs = sinceMinutes ? Date.now() - Number(sinceMinutes) * 60000 : null;
  const out = [];

  for (const r of rows) {
    if (errorsOnly && Number(r.severity) !== 3 && r.severity !== 'E') continue;
    const dateFormatted = format1CDate(r.date);
    if (minTimeMs && dateFormatted) {
      const parsedMs = Date.parse(dateFormatted.replace(' ', 'T') + 'Z');
      if (Number.isFinite(parsedMs) && parsedMs < minTimeMs) continue;
    }
    const evRaw = String(r.eventName || '').replace(/^"|"$/g, '');
    const evRu = EVENT_NAMES_RU[evRaw] || evRaw;
    if (evQ && !norm(evRaw).includes(evQ) && !norm(evRu).includes(evQ)) continue;

    const comment = String(r.comment || '');
    const meta = String(r.metadataName || '');
    const dataPres = String(r.dataPresentation || '');
    if (q) {
      const hay = norm(`${comment} ${evRaw} ${evRu} ${meta} ${dataPres} ${r.userName || ''}`);
      if (!hay.includes(q)) continue;
    }

    out.push({
      rowId: r.rowId,
      date: dateFormatted,
      severity: SEVERITY_MAP[r.severity] || String(r.severity),
      isError: Number(r.severity) === 3 || r.severity === 'E',
      event: evRu ? (evRu !== evRaw ? `${evRu} (${evRaw})` : evRu) : 'Событие',
      user: r.userName || '',
      app: r.appName || '',
      metadata: meta,
      dataPresentation: dataPres,
      comment,
    });
    if (out.length >= limit) break;
  }
  return out;
}

// Извлекает из текста ошибки 1С ссылки на модули вида {ОбщийМодуль.Имя.Модуль(123)} или {Документ.Заказ.МодульОбъекта(45)}
// и находит соответствующие файлы .bsl и процедуры в индексе проекта
export function resolveStackLocations(comment, idx, { withCode = true } = {}) {
  if (!comment || !idx || !Array.isArray(idx.modules) || !idx.modules.length) return [];
  const rx = /\{([^{}\r\n]+?)\((\d+)\)\}/g;
  const results = [];
  const seen = new Set();

  for (const m of comment.matchAll(rx)) {
    const rawMod = m[1].trim();
    const lineNum = Number(m[2]);
    const key = `${rawMod}:${lineNum}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const matchedMod = matchModuleInIndex(rawMod, idx);
    if (!matchedMod) {
      results.push({ raw: `${rawMod}(${lineNum})`, line: lineNum, resolved: false });
      continue;
    }

    const relFile = relative(idx.root, matchedMod.file).split(sep).join('/');
    const method = (matchedMod.methods || []).find((fn) => fn.line <= lineNum && lineNum <= fn.end);
    let snippet = '';
    if (withCode) {
      try {
        const lines = readFileSync(matchedMod.file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
        const from = Math.max(0, lineNum - 3);
        const to = Math.min(lines.length, lineNum + 2);
        snippet = lines.slice(from, to).map((l, i) => {
          const ln = from + i + 1;
          return `${ln === lineNum ? '>>' : '  '} ${ln}: ${l}`;
        }).join('\n');
      } catch { /* */ }
    }
    results.push({
      raw: `${rawMod}(${lineNum})`,
      line: lineNum,
      resolved: true,
      file: relFile,
      moduleId: matchedMod.id,
      cfg: matchedMod.cfg,
      method: method ? `${method.kind} ${method.name}` : null,
      snippet,
    });
  }
  return results;
}

function matchModuleInIndex(rawMod, idx) {
  // Примеры rawMod в 1С:
  // "ОбщийМодуль.ПродажиСервер.Модуль" → в индексе id: "ОбщийМодуль.ПродажиСервер"
  // "Документ.ЗаказКлиента.МодульОбъекта" → в индексе id: "Документ.ЗаказКлиента.МодульОбъекта"
  // "Документ.ЗаказКлиента.Форма.ФормаДокумента.Форма" → в индексе id: "Документ.ЗаказКлиента.Форма.ФормаДокумента"
  // "МоёРасширение ОбщийМодуль.ПродажиСервер.Модуль" → префикс расширения перед именем модуля
  let cleaned = rawMod.trim();
  let extPrefix = null;
  if (cleaned.includes(' ')) {
    const sp = cleaned.split(/\s+/);
    extPrefix = norm(sp[0]);
    cleaned = sp.slice(1).join('');
  }
  const candIds = [
    cleaned,
    cleaned.replace(/\.(?:Модуль|Форма|Module|Form)$/i, ''),
  ].map(norm);

  const candidates = idx.modules.filter((m) => candIds.includes(norm(m.id)));
  if (!candidates.length) return null;
  if (extPrefix) {
    const extMatch = candidates.find((m) => norm(m.cfg).includes(extPrefix));
    if (extMatch) return extMatch;
  }
  return candidates[0];
}

export async function readEventLog(idx, args = {}) {
  const errorsOnly = args.errors_only !== false;
  const limit = Math.min(100, Math.max(1, Number(args.limit) || 20));
  const withCode = args.with_code !== false;

  const loc = resolveLogLocation(idx.root, { log_path: args.log_path, database: args.database });
  if (loc.error) return loc.error;

  let events = [];
  try {
    if (loc.kind === 'lgd') {
      events = await readSqliteEvents(loc.file, {
        errorsOnly,
        limit,
        search: args.search,
        eventFilter: args.event,
        sinceMinutes: args.since_minutes,
      });
    } else {
      events = readLgpEvents(loc.files, loc.lgf, {
        errorsOnly,
        limit,
        search: args.search,
        eventFilter: args.event,
        sinceMinutes: args.since_minutes,
      });
    }
  } catch (e) {
    return `Ошибка чтения журнала регистрации (${loc.file || loc.dir}): ${e.message}`;
  }

  const srcTitle = loc.kind === 'lgd' ? relative(idx.root, loc.file) || loc.file : relative(idx.root, loc.dir) || loc.dir;
  if (!events.length) {
    return `В журнале регистрации (${srcTitle}${loc.label ? `, ${loc.label}` : ''}) ` +
      `${errorsOnly ? 'ошибок' : 'событий по заданному фильтру'} не найдено.`;
  }

  const out = [
    `Журнал регистрации: ${srcTitle}${loc.label ? ` (${loc.label})` : ''} — показано записей: ${events.length}`,
  ];

  events.forEach((ev, i) => {
    const metaPart = [ev.metadata, ev.dataPresentation].filter(Boolean).join(' · ');
    const userPart = [ev.user, ev.app].filter(Boolean).join(' / ');
    out.push(
      `\n${i + 1}. [${ev.severity}] ${ev.date} — ${ev.event}` +
      `${metaPart ? ` | ${metaPart}` : ''}${userPart ? ` (${userPart})` : ''}`
    );
    if (ev.comment) {
      out.push(`   ${ev.comment.trim().split(/\r?\n/).join('\n   ')}`);
      const stack = resolveStackLocations(ev.comment, idx, { withCode: withCode && i < 5 });
      for (const st of stack) {
        if (st.resolved) {
          out.push(`   → Файл в проекте: ${st.file}:${st.line}${st.method ? ` (${st.method})` : ''}`);
          if (st.snippet) {
            out.push('   ```bsl\n   ' + st.snippet.split('\n').join('\n   ') + '\n   ```');
          }
        }
      }
    }
  });

  return out.join('\n');
}
