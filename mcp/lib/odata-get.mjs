// odata-get.mjs — чтение стандартного OData опубликованной базы. Только GET.
//
// Учётные данные берутся из databases[] .v8-project.json и уходят заголовком
// Authorization внутри процесса MCP. В URL, в argv и в текст ответа пароль не попадает.
// Произвольный URL модели не принимается: хост только из odataUrl или webUrl.

import { loadProject, resolveDatabase, redactSecrets, diagnoseHttp, clampTimeoutSec } from './query-db.mjs';

export const DEFAULT_TOP = 100;
export const MAX_TOP = 500;
export const MAX_BODY = 1_500_000;
const CELL_MAX = 400;
const FILTER_MAX = 2000;

const ENTITY_RE = /^(?:\$metadata|[A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_]*)$/;
const SELECT_RE = /^[A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_]*(?:\s*,\s*[A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_]*)*$/;
const ORDER_RE = /^[A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_]*(?:\s+(?:asc|desc))?(?:\s*,\s*[A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_]*(?:\s+(?:asc|desc))?)*$/i;
const FILTER_RE = /^[\w\sА-Яа-яЁё.,()'"=<>!:+\-/*]*$/u;

export function isStatusAction(args) {
  const action = String(args?.action || '').trim().toLowerCase();
  return action === 'status' || args?.status === true;
}

export function clampTop(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_TOP;
  return Math.min(MAX_TOP, Math.max(1, Math.floor(n)));
}

export function serviceRoot(db) {
  const explicit = String(db?.odataUrl || '').trim();
  const web = String(db?.webUrl || '').trim().replace(/\/+$/, '');
  const raw = explicit || (web ? `${web}/odata/standard.odata` : '');
  if (!raw) {
    return { error: `odata_get: у базы «${db?.id || '?'}» не задан odataUrl и нет webUrl. `
      + `Стандартный OData публикует навык web-publish: <webUrl>/odata/standard.odata. `
      + `Пароль в URL не пишут.` };
  }
  let url;
  try { url = new URL(raw); } catch {
    return { error: `odata_get: odataUrl базы «${db.id}» не является адресом HTTP.` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: `odata_get: odataUrl базы «${db.id}» должен быть http или https.` };
  }
  url.username = '';
  url.password = '';
  url.hash = '';
  url.search = '';
  return { url: url.toString().replace(/\/+$/, '') };
}

function rejectEntity(entity) {
  const name = String(entity || '').trim();
  if (!name) return 'odata_get: укажите entity — набор сущностей, например Catalog_Номенклатура, или $metadata.';
  if (!ENTITY_RE.test(name) || name.includes('..') || name.includes('/') || name.includes('\\')) {
    return `odata_get: имя набора «${name.slice(0, 80)}» не подходит. Допустимо $metadata или имя вроде Catalog_Номенклатура, Document_Заказ, InformationRegister_Курсы.`;
  }
  if (name.startsWith('$') && name !== '$metadata') {
    return 'odata_get: из служебных имён разрешён только $metadata. Запись через $batch не выполняется.';
  }
  return '';
}

export function buildODataUrl(root, args = {}) {
  const status = isStatusAction(args);
  const entity = String(args.entity || '').trim();
  if (!status) {
    const bad = rejectEntity(entity);
    if (bad) return { error: bad };
  }
  const base = String(root || '').replace(/\/+$/, '');
  const top = clampTop(args.top ?? args.$top);
  const params = new URLSearchParams();
  if (status || entity !== '$metadata') params.set('$format', 'json');
  if (!status && entity !== '$metadata') {
    params.set('$top', String(top));
    const filter = String(args.filter ?? args.$filter ?? '').trim();
    const select = String(args.select ?? args.$select ?? '').trim();
    const orderby = String(args.orderby ?? args.$orderby ?? '').trim();
    const skipRaw = args.skip ?? args.$skip;
    if (filter) {
      if (filter.length > FILTER_MAX || !FILTER_RE.test(filter)) {
        return { error: 'odata_get: $filter содержит недопустимые символы или длиннее 2000. Это значение одного параметра, не строка запроса целиком.' };
      }
      params.set('$filter', filter);
    }
    if (select) {
      if (!SELECT_RE.test(select)) return { error: 'odata_get: $select — список имён полей через запятую.' };
      params.set('$select', select);
    }
    if (orderby) {
      if (orderby.length > 300 || !ORDER_RE.test(orderby)) return { error: 'odata_get: $orderby — поля и необязательные asc/desc.' };
      params.set('$orderby', orderby);
    }
    if (skipRaw !== undefined && skipRaw !== null && String(skipRaw).trim() !== '') {
      const skip = Math.max(0, Math.min(10000, Math.floor(Number(skipRaw))));
      if (!Number.isFinite(skip)) return { error: 'odata_get: $skip должен быть числом.' };
      if (skip) params.set('$skip', String(skip));
    }
  }
  const segment = entity === '$metadata' ? '$metadata' : encodeURIComponent(entity);
  const path = status ? base : `${base}/${segment}`;
  // Ключи $format/$top не кодируем: платформа ждёт символ «$», а не %24.
  const qs = [...params.entries()].map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  return { url: qs ? `${path}?${qs}` : path, top, metadata: entity === '$metadata' };
}

function cell(value) {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'string' ? value : (typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value));
  return s.length > CELL_MAX ? `${s.slice(0, CELL_MAX - 1)}…` : s;
}

function formatObjects(rows) {
  const keys = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    for (const key of Object.keys(row)) {
      if (key.startsWith('@') || key === 'odata.metadata') continue;
      if (!keys.includes(key)) keys.push(key);
    }
  }
  const shown = keys.slice(0, 12);
  const head = shown.join(' | ') || '(пустая строка)';
  const body = rows.map((row) => shown.map((key) => cell(row?.[key])).join(' | '));
  const more = keys.length > shown.length ? `\n… ещё колонок: ${keys.length - shown.length}` : '';
  return head + (body.length ? `\n${body.join('\n')}` : '') + more;
}

function explain(code, db, url, detail = '') {
  const id = db?.id || '?';
  const where = url ? ` Адрес: ${url}.` : '';
  if (code === 'auth') {
    return `odata_get: база «${id}» — аутентификация не прошла (HTTP ${detail || '401'}).${where} `
      + `Проверьте user и password в .v8-project.json. Пароль в ответ не выводится.`;
  }
  if (code === 'not_published') {
    return `odata_get: база «${id}» — HTTP 404, стандартный OData по этому адресу не опубликован.${where} `
      + `Навык web-publish включает <standardOdata enable="true"/>. Если публикация чужая — включите OData в default.vrd.`;
  }
  if (code === 'unreachable') {
    return `odata_get: база «${id}» — адрес не отвечает${detail ? ` (${detail})` : ''}.${where} Проверьте webUrl или odataUrl и что веб-сервер запущен.`;
  }
  if (code === 'wrong_url') {
    return `odata_get: база «${id}» — по URL пришла HTML-страница, а не OData.${where} Ожидается <webUrl>/odata/standard.odata.`;
  }
  if (code === 'redirect') {
    return `odata_get: база «${id}» — HTTP ${detail || '3xx'}, редирект не выполняется.${where}`;
  }
  if (code === 'timeout') {
    return `odata_get: база «${id}» — таймаут, ответ не получен.${where}`;
  }
  return `odata_get: база «${id}» — не удалось прочитать OData (${code}${detail ? `, ${detail}` : ''}).${where}`;
}

async function defaultFetch(url, init) {
  if (typeof globalThis.fetch !== 'function') throw new Error('В этой версии Node нет fetch');
  return globalThis.fetch(url, init);
}

export async function odataGet(root, args = {}, deps = {}) {
  if (!root) return 'odata_get: не передан корень проекта.';
  const loaded = loadProject(root);
  if (loaded.error) return redactSecrets(loaded.error);
  const resolved = resolveDatabase(loaded.proj, args.database);
  if (resolved.error) return `odata_get: ${resolved.error}`;
  const db = resolved.db;
  const secrets = [db.password, db.user && db.password ? Buffer.from(`${db.user}:${db.password}`, 'utf8').toString('base64') : ''].filter(Boolean);
  const rootUrl = serviceRoot(db);
  if (rootUrl.error) return redactSecrets(rootUrl.error, secrets);
  const built = buildODataUrl(rootUrl.url, args);
  if (built.error) return built.error;

  const status = isStatusAction(args);
  const timeoutSec = clampTimeoutSec(args.timeout_sec ?? args.timeoutSec);
  const user = db.user == null ? '' : String(db.user);
  const password = db.password == null ? '' : String(db.password);
  const token = Buffer.from(`${user}:${password}`, 'utf8').toString('base64');
  const fetchImpl = deps.fetchImpl || defaultFetch;
  let response;
  try {
    response = await fetchImpl(built.url, {
      method: 'GET',
      headers: {
        Accept: built.metadata ? 'application/xml, application/json' : 'application/json',
        Authorization: `Basic ${token}`,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutSec * 1000),
    });
  } catch (e) {
    const kind = diagnoseHttp({ error: e });
    const code = kind?.code === 'timeout' ? 'timeout' : 'unreachable';
    return redactSecrets(explain(code, db, built.url, kind?.code === 'timeout' ? '' : e.message), secrets);
  }
  let raw = '';
  try { raw = await response.text(); } catch (e) {
    return redactSecrets(`odata_get: ответ базы «${db.id}» не прочитан (${e.message}).`, secrets);
  }
  if (raw.length > MAX_BODY) raw = `${raw.slice(0, MAX_BODY)}\n… ответ обрезан`;
  raw = redactSecrets(raw, secrets);
  const kind = diagnoseHttp({ status: response.status, body: raw });
  if (kind) return redactSecrets(explain(kind.code === 'upstream' ? 'upstream' : kind.code, db, rootUrl.url, kind.detail), secrets);
  if (!response.ok) {
    return redactSecrets(`odata_get: HTTP ${response.status} от базы «${db.id}».\n${raw.slice(0, 500)}`, secrets);
  }
  if (status) {
    return redactSecrets(
      `odata_get: база «${db.id}» — стандартный OData отвечает. Корень: ${rootUrl.url}. `
      + `Набор задаётся entity (Catalog_Имя, Document_Имя), дальше $filter, $select, $top, $orderby. Только GET.`,
      secrets,
    );
  }
  if (built.metadata) {
    const lines = raw.split(/\r?\n/).slice(0, 80).join('\n');
    return redactSecrets(`odata_get: база «${db.id}», $metadata, показано не больше 80 строк.\n${lines}`, secrets);
  }
  let data = null;
  try { data = JSON.parse(raw); } catch { data = null; }
  const rows = Array.isArray(data?.value) ? data.value : (Array.isArray(data) ? data : null);
  if (!rows) {
    return redactSecrets(`odata_get: база «${db.id}» вернула не JSON с полем value.\n${raw.slice(0, 500)}`, secrets);
  }
  const shown = rows.slice(0, built.top);
  const truncated = rows.length > built.top;
  return redactSecrets([
    `odata_get: база «${db.id}», строк ${shown.length}${truncated ? `, показаны первые ${built.top}` : ''}, $top ${built.top}, таймаут ${timeoutSec} с. Только GET.`,
    formatObjects(shown),
  ].join('\n'), secrets);
}
