#!/usr/bin/env node
// Тесты query_db: только ВЫБРАТЬ, validate_query, лимит, таймаут, пароль не в выводе и не в URL.
// Живая 1С не нужна: HTTP-сервис подменяется локальным сервером.
//   node tests/mcp/query-db.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { validateQuery } from '../../mcp/lib/query-validator.mjs';
import {
  assertReadOnlyQuery, applyRowLimit, clampLimit, clampTimeoutSec, queryDb, redactSecrets, endpointOf,
} from '../../mcp/lib/query-db.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(here, '..', '..', 'mcp', 'code-search.mjs');
const SRC = resolve(here, '..', '..', 'mcp', 'lib', 'query-db.mjs');
let passed = 0; let failed = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? `\n       ${String(extra).split('\n').join('\n       ')}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PASSWORD = 'S3cret-Long-Password';
const root = mkdtempSync(join(tmpdir(), 'query-db-'));
mkdirSync(join(root, 'Catalogs'), { recursive: true });
const idx = {
  root,
  configs: [{ dir: root, rel: '.', name: 'Тест', isExt: false }],
  objects: [{
    type: 'Catalogs', name: 'Номенклатура', syn: 'Номенклатура',
    file: join(root, 'Catalogs', 'Номенклатура.xml'),
    attrs: [['Артикул', 'Артикул', 'Attribute', ['Строка']]], ts: [],
  }],
  databases: [{ id: 'dev', name: 'Разработка', prefixes: [] }],
};

function project(queryUrl) {
  writeFileSync(join(root, '.v8-project.json'), JSON.stringify({
    v8path: 'C:\\Program Files\\1cv8\\8.3.27.1688\\bin',
    default: 'dev',
    databases: [{
      id: 'dev', name: 'Разработка', type: 'server', server: 'srv', ref: 'dev',
      user: 'Администратор', password: PASSWORD, queryUrl,
    }],
  }));
}

console.log('только чтение и лимит:');
{
  ok(!assertReadOnlyQuery('').ok, 'пустой запрос');
  ok(!assertReadOnlyQuery('УДАЛИТЬ ИЗ Справочник.Номенклатура').ok, 'не ВЫБРАТЬ');
  ok(!assertReadOnlyQuery('ВЫБРАТЬ Ссылка ИЗ Справочник.Номенклатура ДЛЯ ИЗМЕНЕНИЯ').ok, 'ДЛЯ ИЗМЕНЕНИЯ');
  ok(!assertReadOnlyQuery('SELECT Ref FROM Catalog.X FOR UPDATE').ok, 'FOR UPDATE');
  ok(!assertReadOnlyQuery('DROP TABLE Номенклатура').ok, 'DROP TABLE');
  const pack = assertReadOnlyQuery('ВЫБРАТЬ Артикул ПОМЕСТИТЬ ВТ ИЗ Справочник.Номенклатура;\nВЫБРАТЬ Артикул ИЗ ВТ;\nУНИЧТОЖИТЬ ВТ');
  ok(pack.ok && pack.statements.length === 3, 'пакет с временной таблицей и УНИЧТОЖИТЬ');
  ok(clampLimit(undefined) === 100 && clampLimit(0) === 1 && clampLimit(99999) === 500, 'лимит обязателен и зажат в 1…500');
  ok(clampTimeoutSec(undefined) === 30 && clampTimeoutSec(0) === 1 && clampTimeoutSec(999) === 120, 'таймаут обязателен и зажат в 1…120');
  const capped = applyRowLimit('ВЫБРАТЬ Артикул ИЗ Справочник.Номенклатура', 20);
  ok(/^ВЫБРАТЬ ПЕРВЫЕ 20\b/.test(capped), 'ПЕРВЫЕ дописывается', capped);
  const kept = applyRowLimit('ВЫБРАТЬ ПЕРВЫЕ 5 Артикул ИЗ Справочник.Номенклатура', 20);
  ok(/ПЕРВЫЕ 5\b/.test(kept) && !/ПЕРВЫЕ 20/.test(kept), 'более жёсткий ПЕРВЫЕ не раздувается', kept);
  const shrunk = applyRowLimit('SELECT TOP 400 Code FROM Catalog.Items', 50);
  ok(/TOP 50\b/.test(shrunk), 'слишком большой TOP уменьшается', shrunk);
  const batch = applyRowLimit('ВЫБРАТЬ Артикул ПОМЕСТИТЬ ВТ ИЗ Справочник.Номенклатура;\nВЫБРАТЬ Артикул ИЗ ВТ', 10);
  ok(/ПОМЕСТИТЬ ВТ ИЗ/.test(batch) && /ВЫБРАТЬ ПЕРВЫЕ 10 Артикул ИЗ ВТ/.test(batch), 'ПЕРВЫЕ только у финальной выборки', batch);
  ok(redactSecrets(`Pwd="${PASSWORD}" /P"${PASSWORD}" Basic abc`, [PASSWORD]) === 'Pwd="***" /P"***" Basic ***', 'слоты пароля маскируются');
  const ep = endpointOf({ id: 'dev', queryUrl: `http://Администратор:${PASSWORD}@127.0.0.1/hs/agentquery/query` });
  ok(ep.url === 'http://127.0.0.1/hs/agentquery/query', 'userinfo из queryUrl вырезается', ep.url);
}

console.log('исполнение на подставном HTTP:');
{
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    const body = JSON.parse(init.body);
    if (String(url).includes(PASSWORD) || JSON.stringify(init.headers).includes(PASSWORD) === false && !init.headers.Authorization) {
      throw new Error('auth missing');
    }
    return {
      ok: true, status: 200,
      async text() {
        return JSON.stringify({
          columns: ['Артикул'],
          rows: [[PASSWORD], ['A-1']],
          truncated: false,
          echo: body.query,
        });
      },
    };
  };
  project('http://127.0.0.1:9/hs/agentquery/query');
  const bad = await queryDb(idx, { database: 'dev', query: 'УДАЛИТЬ ИЗ Справочник.Номенклатура' }, { fetchImpl });
  ok(/только ВЫБРАТЬ/.test(bad) && seen.length === 0, 'не-SELECT не уходит в HTTP', bad);
  const unknown = await queryDb(idx, { database: 'нет-такой', query: 'ВЫБРАТЬ 1' }, { fetchImpl });
  ok(/не найдена/.test(unknown) && seen.length === 0, 'неизвестный id базы', unknown);
  const invalid = await queryDb(idx, { database: 'dev', query: 'ВЫБРАТЬ Артикул ИЗ Справочник.НетТакогоОбъекта' }, { fetchImpl });
  ok(/validate_query/.test(invalid) && /\[ОШИБКА\]/.test(invalid) && seen.length === 0, 'ошибка validate_query останавливает вызов', invalid);
  const text = await queryDb(idx, { database: 'dev', query: 'ВЫБРАТЬ Артикул ИЗ Справочник.Номенклатура', limit: 20, timeout_sec: 5 }, { fetchImpl });
  ok(seen.length === 1, 'успешный SELECT вызывает HTTP один раз');
  const sent = JSON.parse(seen[0].init.body);
  ok(/ПЕРВЫЕ 20/.test(sent.query) && sent.limit === 20 && sent.timeoutSec === 5, 'в сервис уходит запрос с лимитом и таймаут', sent.query);
  ok(seen[0].init.headers.Authorization.startsWith('Basic ') && !seen[0].url.includes(PASSWORD), 'пароль в заголовке, не в URL');
  ok(!text.includes(PASSWORD) && text.includes('A-1') && text.includes('база «dev»'), 'пароль вырезан из ответа, данные на месте', text);
  ok(seen[0].init.signal && typeof seen[0].init.signal.aborted === 'boolean', 'у вызова есть signal таймаута');

  const hanging = async (_url, init) => new Promise((_resolve, reject) => {
    const t = setTimeout(() => reject(new Error('fetch не оборвался по таймауту')), 4000);
    init.signal.addEventListener('abort', () => { clearTimeout(t); const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
  });
  const slow = await queryDb(idx, { database: 'dev', query: 'ВЫБРАТЬ Артикул ИЗ Справочник.Номенклатура', timeout_sec: 1 }, { fetchImpl: hanging });
  ok(/таймаут 1 с/.test(slow) && !slow.includes(PASSWORD), 'таймаут обрывает ожидание', slow);

  const src = readFileSync(SRC, 'utf8');
  ok(!src.includes('child_process') && !src.includes('spawn('), 'модуль query_db не запускает процессы');
  ok(validateQuery(idx, { query: 'ВЫБРАТЬ Артикул ИЗ Справочник.Номенклатура' }).startsWith('[OK]'), 'эталонный запрос проходит validate_query');
}

console.log('готовность сервиса:');
{
  project('http://127.0.0.1:9/hs/agentquery/query');
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (String(url).endsWith('/missing')) {
      return { ok: false, status: 404, async text() { return 'not found'; } };
    }
    if (init.method === 'GET') {
      return { ok: true, status: 200, async text() { return JSON.stringify({ service: 'AgentQuery', ok: true, readOnly: true }); } };
    }
    return { ok: false, status: 500, async text() { return 'no'; } };
  };
  const ready = await queryDb(idx, { database: 'dev', action: 'status' }, { fetchImpl });
  ok(/готова/.test(ready) && calls[0]?.init?.method === 'GET' && !calls[0].init.body, 'status делает GET и не шлёт тело', ready);
  ok(!ready.includes(PASSWORD) && calls[0].init.headers.Authorization.startsWith('Basic '), 'status: пароль только в заголовке', ready);
  const missing = await queryDb({ root, configs: [{ dir: root }] }, { database: 'dev', action: 'status' }, {
    fetchImpl: async () => ({ ok: false, status: 404, async text() { return 'missing'; } }),
  });
  ok(/404/.test(missing) && /db-install-agentquery/.test(missing) && !missing.includes(PASSWORD), '404 просит поставить расширение', missing);
  const denied = await queryDb(idx, { database: 'dev', action: 'status' }, {
    fetchImpl: async () => ({ ok: false, status: 401, async text() { return PASSWORD; } }),
  });
  ok(/401/.test(denied) && !denied.includes(PASSWORD), '401 не печатает пароль из тела', denied);
  const html = await queryDb(idx, { database: 'dev', action: 'status' }, {
    fetchImpl: async () => ({ ok: true, status: 200, async text() { return '<!DOCTYPE html><html><body>web</body></html>'; } }),
  });
  ok(/HTML/.test(html), 'HTML вместо сервиса — неверный URL', html);
  const down = await queryDb(idx, { database: 'dev', action: 'status' }, {
    fetchImpl: async () => { const e = new Error('connect ECONNREFUSED'); throw e; },
  });
  ok(/не отвечает/.test(down) && !down.includes(PASSWORD), 'нет соединения — отдельная причина', down);
}

console.log('MCP stdio:');
{
  const port = await new Promise((resolvePort) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        server.__body = body;
        server.__method = req.method;
        server.__auth = req.headers.authorization || '';
        server.__url = req.url;
        res.setHeader('Content-Type', 'application/json');
        if (req.method === 'GET') res.end(JSON.stringify({ service: 'AgentQuery', ok: true, readOnly: true }));
        else res.end(JSON.stringify({ columns: ['Артикул'], rows: [['A-1']], truncated: false }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolvePort(server));
  });
  const httpServer = port;
  const address = httpServer.address();
  const cf = join(root, 'src', 'cf');
  mkdirSync(join(cf, 'Catalogs'), { recursive: true });
  writeFileSync(join(cf, 'Configuration.xml'), '<MetaDataObject><Configuration><Properties><Name>Тест</Name></Properties><ChildObjects/></Configuration></MetaDataObject>');
  writeFileSync(join(cf, 'Catalogs', 'Номенклатура.xml'), '<MetaDataObject><Catalog><Properties><Name>Номенклатура</Name><DescriptionLength>100</DescriptionLength></Properties><ChildObjects/></Catalog></MetaDataObject>');
  writeFileSync(join(root, '.v8-project.json'), JSON.stringify({
    databases: [{ id: 'dev', user: 'Администратор', password: PASSWORD, configSrc: 'src/cf', queryUrl: `http://127.0.0.1:${address.port}/hs/agentquery/query` }],
  }));
  const p = spawn(process.execPath, [SERVER], { cwd: root, stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, SEMANTIC_SEARCH: '0' } });
  const lines = [];
  createInterface({ input: p.stdout }).on('line', (l) => { try { lines.push(JSON.parse(l)); } catch { /* не JSON */ } });
  const send = (m) => p.stdin.write(JSON.stringify(m) + '\n');
  const wait = async (id, ms = 20000) => {
    const t = Date.now() + ms;
    while (Date.now() < t) { const m = lines.find((x) => x.id === id); if (m) return m; await sleep(30); }
    return null;
  };
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
  const init = await wait(1);
  ok(/query_db\(database, query\)/.test(init?.result?.instructions || ''), 'instructions упоминают query_db');
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const list = await wait(2);
  const tool = (list?.result?.tools || []).find((t) => t.name === 'query_db');
  ok(tool?.annotations?.readOnlyHint === true && tool.annotations.destructiveHint === false, 'у query_db стоит readOnlyHint', JSON.stringify(tool?.annotations));
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'query_db', arguments: { database: 'dev', query: 'УДАЛИТЬ ИЗ Справочник.Номенклатура' } } });
  const denied = await wait(3);
  const deniedText = denied?.result?.content?.[0]?.text || '';
  ok(/только ВЫБРАТЬ/.test(deniedText) && !httpServer.__body, 'stdio: не-SELECT не доходит до HTTP', deniedText);
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'query_db', arguments: { database: 'dev', query: 'ВЫБРАТЬ Наименование ИЗ Справочник.Номенклатура', limit: 7 } } });
  const live = await wait(4);
  const liveText = live?.result?.content?.[0]?.text || '';
  ok(liveText.includes('A-1') && !liveText.includes(PASSWORD), 'stdio: строки получены, пароля в ответе нет', liveText);
  ok(httpServer.__auth.startsWith('Basic ') && !httpServer.__auth.includes(PASSWORD) && !String(httpServer.__url).includes(PASSWORD), 'stdio: пароль не в URL и не открытым текстом в заголовке');
  const sentQuery = JSON.parse(httpServer.__body || '{}').query || '';
  ok(/ПЕРВЫЕ 7/.test(sentQuery), 'stdio: в сервис ушёл запрос с ПЕРВЫЕ', sentQuery);
  ok(httpServer.__method === 'POST', 'stdio: чтение идёт методом POST');
  send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'query_db', arguments: { database: 'dev', action: 'status' } } });
  const status = await wait(5);
  const statusText = status?.result?.content?.[0]?.text || '';
  ok(/готова/.test(statusText) && !statusText.includes(PASSWORD), 'stdio: action status', statusText);
  const odata = (list?.result?.tools || []).find((t) => t.name === 'odata_get');
  ok(odata?.annotations?.readOnlyHint === true, 'в каталоге есть odata_get', JSON.stringify(odata?.annotations));
  p.stdin.end();
  await new Promise((r) => p.on('close', r));
  await new Promise((r) => httpServer.close(r));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
