// query-db.mjs — чтение данных информационной базы 1С инструментом query_db.
//
// Только ВЫБРАТЬ (SELECT). Текст сначала проверяет validate_query по XML-выгрузке.
// Лимит строк и таймаут обязательны и не отключаются: лимит вшивается в финальную выборку
// (ПЕРВЫЕ / TOP) и ещё раз обрезает ответ, таймаут обрывает HTTP-вызов.
//
// Транспорт — HTTP-сервис публикации, запрос из процесса MCP (fetch). Пароль уходит
// заголовком Authorization и не попадает в командную строку дочернего процесса: дочерний
// процесс не запускается. COM, интерактивный 1cv8 и /P на командной строке для этого
// инструмента не используются — в сессиях агента пароль из .v8-project.json оказывался
// в argv именно так, а ibcmd не выполняет язык запросов и тоже требует --password в argv.
//
// Живая база: модуль mcp/query-db/AgentQuery.bsl (корневой URL agentquery, POST query).
// Его ставят в конфигурацию или расширение навыком db-* и публикуют (webUrl или queryUrl).
// Без публикации инструмент отказывается, а не ищет обход через COM.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateQuery, cleanQueryText } from './query-validator.mjs';

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 500;
export const DEFAULT_TIMEOUT_SEC = 30;
export const MAX_TIMEOUT_SEC = 120;
const CELL_MAX = 400;

function stripJsonComments(text) {
  let out = ''; let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { out += c; if (c === '\\') out += text[++i] ?? ''; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i + 2); if (i < 0) break; i++; continue; }
    out += c;
  }
  return out.replace(/,\s*([}\]])/g, '$1');
}

export function clampLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(n)));
}

export function clampTimeoutSec(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_TIMEOUT_SEC;
  return Math.min(MAX_TIMEOUT_SEC, Math.max(1, Math.floor(n)));
}

export function splitStatements(cleaned) {
  const statements = [];
  let cur = '';
  let inStr = false;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === '"') inStr = !inStr;
    if (ch === ';' && !inStr) {
      if (cur.trim()) statements.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) statements.push(cur.trim());
  return statements;
}

// \b в JS не видит кириллицу: после «ВЫБРАТЬ» и пробела границы слова нет.
const KW_BEFORE = '(?<![A-Za-zА-Яа-яЁё0-9_])';
const KW_AFTER = '(?![A-Za-zА-Яа-яЁё0-9_])';
const SELECT_START = new RegExp(`^(?:ВЫБРАТЬ|SELECT)${KW_AFTER}`, 'i');
const INTO_RE = new RegExp(`${KW_BEFORE}(?:ПОМЕСТИТЬ|INTO)${KW_AFTER}`, 'i');
const SELECT_HEAD = new RegExp(
  `^(\\s*)(ВЫБРАТЬ|SELECT)${KW_AFTER}(\\s+РАЗРЕШЕННЫЕ|\\s+ALLOWED)?(\\s+РАЗЛИЧНЫЕ|\\s+DISTINCT)?(\\s+(?:ПЕРВЫЕ|TOP)\\s+(\\d+))?`,
  'i',
);
const UNION_SPLIT = new RegExp(`(${KW_BEFORE}ОБЪЕДИНИТЬ(?:\\s+ВСЕ)?${KW_AFTER}|${KW_BEFORE}UNION(?:\\s+ALL)?${KW_AFTER})`, 'i');

export function assertReadOnlyQuery(raw) {
  const cleaned = cleanQueryText(raw);
  if (!cleaned.trim()) return { ok: false, message: 'Пустой текст запроса.' };
  if (/ДЛЯ\s+ИЗМЕНЕНИЯ/i.test(cleaned) || new RegExp(`${KW_BEFORE}FOR\\s+UPDATE${KW_AFTER}`, 'i').test(cleaned)) {
    return { ok: false, message: 'Запрос только на чтение: ДЛЯ ИЗМЕНЕНИЯ и FOR UPDATE запрещены.' };
  }
  const statements = splitStatements(cleaned);
  if (!statements.length) return { ok: false, message: 'Пустой текст запроса.' };
  let selects = 0;
  for (const stmt of statements) {
    if (SELECT_START.test(stmt)) { selects += 1; continue; }
    if (/^УНИЧТОЖИТЬ\s+[A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё]*\s*$/i.test(stmt)) continue;
    if (/^DROP\s+[A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё]*\s*$/i.test(stmt)) continue;
    const preview = stmt.replace(/\s+/g, ' ').slice(0, 120);
    return { ok: false, message: `Разрешён только ВЫБРАТЬ (SELECT). Нельзя выполнить: ${preview}` };
  }
  if (!selects) return { ok: false, message: 'В пакете нет оператора ВЫБРАТЬ.' };
  return { ok: true, cleaned, statements };
}

function capHead(fragment, limit) {
  return fragment.replace(SELECT_HEAD, (full, sp, kw, allowed, distinct, _top, topN) => {
    if (topN && Number(topN) <= limit) return full;
    const word = /^select$/i.test(kw) ? 'TOP' : 'ПЕРВЫЕ';
    return `${sp}${kw}${allowed || ''}${distinct || ''} ${word} ${limit}`;
  });
}

function capStatement(stmt, limit) {
  const trimmed = stmt.trim();
  if (!SELECT_START.test(trimmed)) return stmt;
  // Промежуточная выборка во временную таблицу не урезается: иначе изменятся итоги пакета.
  if (INTO_RE.test(stmt)) return stmt;
  const parts = stmt.split(UNION_SPLIT);
  return parts.map((part, i) => (i % 2 === 0 ? capHead(part, limit) : part)).join('');
}

// Лимит ставится на финальную выборку. Временные таблицы пакета не режутся.
export function applyRowLimit(cleaned, limit) {
  const statements = splitStatements(cleaned);
  if (!statements.length) return cleaned;
  let lastSelect = -1;
  for (let i = 0; i < statements.length; i++) {
    if (SELECT_START.test(statements[i]) && !INTO_RE.test(statements[i])) lastSelect = i;
  }
  if (lastSelect < 0) lastSelect = statements.length - 1;
  statements[lastSelect] = capStatement(statements[lastSelect], limit);
  return statements.join(';\n');
}

export function redactSecrets(text, secrets = []) {
  let s = String(text ?? '');
  s = s.replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic ***');
  s = s.replace(/(Pwd\s*=\s*")[^"]*(")/gi, '$1***$2');
  s = s.replace(/(\/P\s*")[^"]*(")/gi, '$1***$2');
  s = s.replace(/(\/P)(?!")\S+/gi, '$1***');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) s = s.split(secret).join('***');
  }
  return s;
}

export function loadProject(root) {
  const file = join(root, '.v8-project.json');
  if (!existsSync(file)) return { error: 'В проекте нет .v8-project.json. Базу регистрируют навыком db-list.' };
  try {
    const proj = JSON.parse(stripJsonComments(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')));
    return { proj };
  } catch (e) {
    return { error: `Не читается .v8-project.json: ${e.message}` };
  }
}

export function resolveDatabase(proj, id) {
  const dbs = Array.isArray(proj?.databases) ? proj.databases : [];
  const ids = dbs.map((d) => d && d.id).filter(Boolean);
  const q = String(id || '').trim();
  if (!q) {
    return { error: `Укажите database — id базы из .v8-project.json${ids.length ? ` (${ids.join(', ')})` : ''}.` };
  }
  const found = dbs.find((d) => String(d?.id || '').toLowerCase() === q.toLowerCase());
  if (!found) {
    return { error: `База с id «${q}» не найдена в .v8-project.json${ids.length ? `. Доступны id: ${ids.join(', ')}` : ''}.` };
  }
  return { db: found };
}

export function endpointOf(db) {
  const explicit = String(db.queryUrl || '').trim();
  const web = String(db.webUrl || '').trim().replace(/\/+$/, '');
  const raw = explicit || (web ? `${web}/hs/agentquery/query` : '');
  if (!raw) {
    return { error: `У базы «${db.id}» не задан queryUrl и нет webUrl. Опубликуйте HTTP-сервис AgentQuery (mcp/query-db/AgentQuery.bsl) навыком db-* и укажите webUrl или queryUrl. COM и интерактивный запуск платформы для чтения не используются.` };
  }
  let url;
  try { url = new URL(raw); } catch {
    return { error: `queryUrl базы «${db.id}» не является адресом HTTP.` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: `queryUrl базы «${db.id}» должен быть http или https.` };
  }
  url.username = '';
  url.password = '';
  return { url: url.toString() };
}

function cell(value) {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'string' ? value : (typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value));
  return s.length > CELL_MAX ? `${s.slice(0, CELL_MAX - 1)}…` : s;
}

function formatTable(columns, rows) {
  const head = columns.length ? columns.join(' | ') : '(нет колонок)';
  const body = rows.map((r) => (Array.isArray(r) ? r : [r]).map(cell).join(' | '));
  return [head, ...body].join('\n');
}

async function defaultFetch(url, init) {
  if (typeof globalThis.fetch !== 'function') throw new Error('В этой версии Node нет fetch');
  return globalThis.fetch(url, init);
}

export async function queryDb(idx, args = {}, deps = {}) {
  const root = idx?.root;
  if (!root) return 'query_db: не передан корень проекта.';
  if (!idx.configs?.length) {
    return `В ${root} не найдено выгрузок 1С (Configuration.xml). query_db не выполняет запрос, пока validate_query не по чему проверять текст.`;
  }
  const loaded = loadProject(root);
  if (loaded.error) return redactSecrets(loaded.error);
  const resolved = resolveDatabase(loaded.proj, args.database);
  if (resolved.error) return resolved.error;
  const db = resolved.db;
  const secrets = [db.password, db.user && db.password ? Buffer.from(`${db.user}:${db.password}`, 'utf8').toString('base64') : ''].filter(Boolean);

  const check = assertReadOnlyQuery(args.query);
  if (!check.ok) return check.message;

  const verdict = validateQuery(idx, { query: check.cleaned, isAllowedPath: args.isAllowedPath || null });
  if (verdict.includes('[ОШИБКА]') || /^Пустой текст/.test(verdict)) {
    return `query_db не выполняет запрос: validate_query нашёл ошибки.\n${verdict}`;
  }

  const limit = clampLimit(args.limit);
  const timeoutSec = clampTimeoutSec(args.timeout_sec ?? args.timeoutSec);
  const limited = applyRowLimit(check.cleaned, limit);
  const ep = endpointOf(db);
  if (ep.error) return ep.error;

  const fetchImpl = deps.fetchImpl || defaultFetch;
  const user = db.user == null ? '' : String(db.user);
  const password = db.password == null ? '' : String(db.password);
  const token = Buffer.from(`${user}:${password}`, 'utf8').toString('base64');
  const timeoutMs = timeoutSec * 1000;
  let response;
  try {
    response = await fetchImpl(ep.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Accept: 'application/json',
        Authorization: `Basic ${token}`,
      },
      body: JSON.stringify({ query: limited, limit, timeoutSec }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const aborted = e?.name === 'TimeoutError' || e?.name === 'AbortError' || /timeout|aborted/i.test(String(e?.message || ''));
    if (aborted) {
      return redactSecrets(`query_db: база «${db.id}», таймаут ${timeoutSec} с — ответ не получен. Запрос только на чтение, повтор сам не запускается.`, secrets);
    }
    return redactSecrets(`query_db: нет ответа HTTP-сервиса базы «${db.id}» (${e.message}). Проверьте публикацию AgentQuery. Пароль в вывод не попадает.`, secrets);
  }

  let raw = '';
  try { raw = await response.text(); } catch (e) {
    return redactSecrets(`query_db: ответ базы «${db.id}» не прочитан (${e.message}).`, secrets);
  }
  raw = redactSecrets(raw, secrets);
  let data = null;
  try { data = JSON.parse(raw); } catch { data = null; }
  if (!response.ok) {
    const err = data && typeof data.error === 'string' ? data.error : raw.slice(0, 500);
    return redactSecrets(`query_db: HTTP ${response.status} от базы «${db.id}».\n${err}`, secrets);
  }
  if (!data || !Array.isArray(data.rows)) {
    return redactSecrets(`query_db: база «${db.id}» вернула не JSON с полем rows.\n${raw.slice(0, 500)}`, secrets);
  }
  const columns = Array.isArray(data.columns) ? data.columns.map((c) => String(c)) : [];
  const rows = data.rows.slice(0, limit);
  const truncated = Boolean(data.truncated) || data.rows.length > limit;
  const lines = [
    `query_db: база «${db.id}», строк ${rows.length}${truncated ? `, показаны первые ${limit}` : ''}, лимит ${limit}, таймаут ${timeoutSec} с.`,
    verdict.startsWith('[OK]') ? verdict : `проверка: ${verdict.split('\n')[0]}`,
    formatTable(columns, rows),
  ];
  return redactSecrets(lines.join('\n'), secrets);
}
