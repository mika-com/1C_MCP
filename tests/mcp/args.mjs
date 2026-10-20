#!/usr/bin/env node
// Тесты аргументов инструментов 1c-search (mcp/code-search.mjs): синонимы главного аргумента
// (find_object {"name": …} вместо {"query": …} и т. п.), схема не отклоняет синоним на стороне клиента,
// понятная ошибка без аргумента, MCP stdio.
//   node tests/mcp/args.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { normalizeArgs, ARG_ALIASES } from '../../mcp/code-search.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(here, '..', '..', 'mcp', 'code-search.mjs');
let passed = 0; let failed = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name}${extra ? `\n       ${String(extra).split('\n').join('\n       ')}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const throws = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

const MOD = `Процедура ЗаполнитьУчастников(Объект) Экспорт
КонецПроцедуры

Процедура ПриЗаписи(Отказ)
	ЗаполнитьУчастников(ЭтотОбъект);
КонецПроцедуры
`;
const CATALOG = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns:v8="http://v8.1c.ru/8.1/data/core"><Catalog><Properties><Name>ЗадачиМне</Name>
<Synonym><v8:item><v8:lang>ru</v8:lang><v8:content>Задачи мне</v8:content></v8:item></Synonym></Properties>
<ChildObjects/></Catalog></MetaDataObject>`;

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'args-proj-'));
  const cf = join(root, 'src', 'cf');
  mkdirSync(join(cf, 'CommonModules', 'Участники', 'Ext'), { recursive: true });
  mkdirSync(join(cf, 'Catalogs'), { recursive: true });
  writeFileSync(join(cf, 'Configuration.xml'), '<MetaDataObject><Configuration><Properties><Name>Тест</Name></Properties></Configuration></MetaDataObject>');
  writeFileSync(join(cf, 'CommonModules', 'Участники', 'Ext', 'Module.bsl'), MOD);
  writeFileSync(join(cf, 'Catalogs', 'ЗадачиМне.xml'), CATALOG);
  return root;
}

console.log('args: normalizeArgs');
{
  ok(normalizeArgs('find_object', { name: 'ЗадачиМне' }).query === 'ЗадачиМне', 'find_object: name → query');
  ok(normalizeArgs('find_object', { object: 'Справочник.ЗадачиМне' }).query === 'Справочник.ЗадачиМне', 'find_object: object → query');
  ok(normalizeArgs('find_object', { query: 'А', name: 'Б' }).query === 'А', 'find_object: query важнее синонима');
  ok(normalizeArgs('find_object', { query: '', name: 'Б' }).query === 'Б', 'find_object: пустой query — берётся синоним');
  ok(normalizeArgs('find_method', { method: 'ПриЗаписи', object: 'Документ.Задача' }).name === 'ПриЗаписи' &&
    normalizeArgs('find_method', { method: 'ПриЗаписи', object: 'Документ.Задача' }).object === 'Документ.Задача',
  'find_method: method → name, object остаётся фильтром');
  ok(normalizeArgs('find_usages', { query: 'ПриЗаписи' }).name === 'ПриЗаписи', 'find_usages: query → name');
  ok(normalizeArgs('module_methods', { object: 'Документ.Задача' }).module === 'Документ.Задача', 'module_methods: object → module');
  ok(normalizeArgs('search_code', { query: 'Записать(' }).pattern === 'Записать(', 'search_code: query → pattern');
  ok(normalizeArgs('semantic_search', { text: 'где лимит', object: 'ОбщийМодуль.Продажи' }).object === 'ОбщийМодуль.Продажи',
    'semantic_search: object не считается синонимом query');
  ok(normalizeArgs('index_status', { refresh: true }).refresh === true, 'index_status: аргументы без изменений');
  const e = throws(() => normalizeArgs('find_object', {}));
  ok(e && /find_object/.test(e) && /«query»/.test(e) && /ЗадачиМне/.test(e), 'find_object без аргумента — понятная ошибка с примером', e);
  const e2 = throws(() => normalizeArgs('search_code', { pattern: '   ' }));
  ok(e2 && /«pattern»/.test(e2), 'search_code с пустым pattern — ошибка', e2);
}

console.log('args: MCP stdio');
{
  const root = makeProject();
  const p = spawn(process.execPath, [SERVER], { cwd: root, stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, SEMANTIC_SEARCH: '0' } });
  const lines = [];
  createInterface({ input: p.stdout }).on('line', (l) => { try { lines.push(JSON.parse(l)); } catch { /* не JSON */ } });
  const send = (m) => p.stdin.write(JSON.stringify(m) + '\n');
  const wait = async (id, ms = 15000) => { const t = Date.now() + ms; while (Date.now() < t) { const m = lines.find((x) => x.id === id); if (m) return m; await sleep(30); } return null; };
  let id = 10;
  const call = async (name, args) => { const n = ++id; send({ jsonrpc: '2.0', id: n, method: 'tools/call', params: { name, arguments: args } }); const r = await wait(n); return { text: r?.result?.content?.[0]?.text || '', isError: r?.result?.isError }; };

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
  const init = await wait(1);
  ok(/find_object\(query\)/.test(init?.result?.instructions || ''), 'instructions называют аргумент find_object(query)', init?.result?.instructions);
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const tools = (await wait(2))?.result?.tools || [];
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  // клиент (OpenCode) проверяет аргументы по схеме до вызова: синоним не должен падать на required
  for (const [tool, spec] of Object.entries(ARG_ALIASES)) {
    const sch = byName[tool]?.inputSchema;
    ok(!!sch, `${tool}: есть в tools/list`);
    if (!sch) continue;
    for (const [canonical, aliases] of Object.entries(spec)) {
      ok(sch.properties?.[canonical]?.type === 'string', `${tool}: канонический аргумент ${canonical} в схеме`);
      const declared = aliases.filter((k) => sch.properties?.[k]);
      if (declared.length) ok(!(sch.required || []).includes(canonical), `${tool}: ${canonical} не required, раз есть синонимы в схеме (${declared.join(', ')})`);
    }
  }
  ok(byName.find_object?.inputSchema?.properties?.name && byName.find_object?.inputSchema?.properties?.object, 'find_object: синонимы name и object объявлены в схеме');

  const r1 = await call('find_object', { name: 'ЗадачиМне' });
  ok(!r1.isError && /ЗадачиМне/.test(r1.text) && /Найдено/.test(r1.text), 'find_object {"name": "ЗадачиМне"} находит объект', r1.text);
  const r2 = await call('find_object', { query: 'ЗадачиМне' });
  ok(!r2.isError && /ЗадачиМне/.test(r2.text), 'find_object {"query": …} по-прежнему работает', r2.text);
  const r3 = await call('find_object', {});
  ok(r3.isError && /«query»/.test(r3.text), 'find_object {} — isError с подсказкой', r3.text);
  const r4 = await call('find_method', { method: 'ЗаполнитьУчастников', with_code: false });
  ok(!r4.isError && /ЗаполнитьУчастников/.test(r4.text), 'find_method {"method": …}', r4.text);
  const r5 = await call('find_usages', { query: 'ЗаполнитьУчастников' });
  ok(!r5.isError && /Вызовов: 1/.test(r5.text), 'find_usages {"query": …}', r5.text);
  const r6 = await call('module_methods', { object: 'ОбщийМодуль.Участники' });
  ok(!r6.isError && /ПриЗаписи/.test(r6.text), 'module_methods {"object": …}', r6.text);
  const r7 = await call('search_code', { query: 'ЗаполнитьУчастников(ЭтотОбъект' });
  ok(!r7.isError && /Module\.bsl:5/.test(r7.text), 'search_code {"query": …}', r7.text);
  p.stdin.end();
  await new Promise((r) => p.on('close', r));
}

console.log(`\n${passed} ok, ${failed} fail`);
process.exit(failed ? 1 : 0);
