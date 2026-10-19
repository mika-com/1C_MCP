#!/usr/bin/env node
// Тесты 1c-help (mcp/help.mjs, mcp/lib/hbk.mjs) на СИНТЕТИЧЕСКИХ .hbk (tests/mcp/lib/make-hbk.mjs):
// контейнер с цепочками блоков, FileStorage с центральным каталогом и без, PackBlock; выбор платформы;
// кэш индекса; таймаут сборки и уборка дочернего процесса; MCP через stdio.
//   node tests/mcp/help.mjs
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { makeHbk, sampleCntx, sampleLang } from './lib/make-hbk.mjs';
import * as hbk from '../../mcp/lib/hbk.mjs';
import * as help from '../../mcp/help.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const server = resolve(here, '..', '..', 'mcp', 'help.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0; let failed = 0;
const ok = (cond, name) => { if (cond) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name}`); } };

const tmp = mkdtempSync(join(tmpdir(), '1c-help-'));
const base = join(tmp, '1cv8');
const binOld = join(base, '8.3.9.100', 'bin');
const binNew = join(base, '8.3.24.1500', 'bin');
for (const d of [binOld, binNew]) mkdirSync(d, { recursive: true });
writeFileSync(join(binNew, 'shcntx_ru.hbk'), makeHbk(sampleCntx(), { pageSize: 96 }));
writeFileSync(join(binNew, 'shlang_ru.hbk'), makeHbk(sampleLang(), { central: false, dataDescriptor: true }));
writeFileSync(join(binOld, 'shcntx_ru.hbk'), makeHbk(sampleCntx()));

console.log('hbk:');
{
  const c = hbk.readContainer(readFileSync(join(binNew, 'shcntx_ru.hbk')));
  ok(['PackBlock', 'FileStorage', 'Book'].every((n) => c.has(n)), 'элементы контейнера');
  const toc = hbk.parseToc(hbk.readFirstZipEntry(c.get('PackBlock')).toString('utf8'));
  ok(toc.length === 14 && toc[1].en === 'Widget' && toc[1].children.length === 4, 'оглавление разобрано');
  const z = c.get('FileStorage');
  const idx = hbk.readZipIndex(z);
  ok(idx.size === 7, 'FileStorage: центральный каталог (данные в цепочке блоков)');
  const page = hbk.parsePage(hbk.decodeHtml(hbk.readZipEntry(z, idx.get('objects/Test/Widget/methods/Add.html'))));
  const sec = Object.fromEntries(page.sections.map((s) => [s.name, s]));
  ok(sec['Синтаксис']?.text === 'Добавить(<Имя>, <Вес>)' && /<Вес> \(необязательный\)/.test(sec['Параметры']?.text || ''), 'страница: синтаксис и параметры');
  ok(sec['Пример']?.code && /Виджет\.Добавить\("А", 2\);/.test(sec['Пример'].text) && /8\.3\.99/.test(sec['Версия']?.text || ''), 'страница: пример и версия');
  const l = hbk.readContainer(readFileSync(join(binNew, 'shlang_ru.hbk'))).get('FileStorage');
  const li = hbk.readZipIndex(l);
  ok(/КонецПовтора/.test(hbk.readZipEntry(l, li.get('lang/Repeat.html')).toString('utf8')), 'FileStorage без каталога, бит 3 (перебор сигнатур)');
  ok(hbk.normalizePath('v8help://SyntaxHelperContext/objects/A.html#x') === 'objects/A.html', 'нормализация ссылок v8help://');
}

console.log('платформа:');
{
  const p = help.resolvePlatform({ env: {}, bases: [base] });
  ok(p.version === '8.3.24.1500' && p.dir === binNew, 'самая новая установленная');
  ok(help.resolvePlatform({ env: {}, bases: [base], version: '8.3.9' }).dir === binOld, 'явная версия');
  ok(help.resolvePlatform({ env: { V8_HELP_PATH: join(binOld, 'shcntx_ru.hbk') }, bases: [base] }).dir === binOld, 'V8_HELP_PATH (файл .hbk)');
  ok(help.resolvePlatform({ env: { V8_HELP_PATH: join(tmp, 'нет') } }).error, 'V8_HELP_PATH без справки — ошибка');
  const proj = join(tmp, 'proj'); mkdirSync(proj);
  writeFileSync(join(proj, '.v8-project.json'), `{\n  // комментарий\n  "v8path": ${JSON.stringify(join(binOld, '1cv8'))},\n  "databases": [],\n}\n`);
  const pp = help.resolvePlatform({ env: {}, bases: [base], root: proj });
  ok(pp.dir === binOld && /v8-project/.test(pp.source), '.v8-project.json v8path (с комментариями)');
  ok(help.installBases({}, 'linux').includes('/opt/1cv8/x86_64'), 'пути Linux /opt/1cv8');
  ok(help.installBases({ ProgramFiles: 'C:\\Program Files' }, 'win32').some((b) => /1cv8$/.test(b)), 'пути Windows Program Files\\1cv8');
  ok(help.helpFilesIn(binNew).cntx && help.helpFilesIn(binNew).lang && !help.helpFilesIn(binNew).query, 'файлы справки в bin');
}

function rpc(proc) {
  const lines = [];
  createInterface({ input: proc.stdout }).on('line', (l) => { try { lines.push(JSON.parse(l)); } catch { /* */ } });
  let id = 0;
  const call = async (name, args, ms = 20000) => {
    const my = ++id;
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: my, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    const t = Date.now() + ms;
    while (Date.now() < t) { const m = lines.find((x) => x.id === my); if (m) return m.result; await sleep(50); }
    return null;
  };
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { capabilities: {} } }) + '\n');
  return { call, lines };
}
const text = (r) => r?.content?.[0]?.text || '';
const start = (env) => spawn(process.execPath, [server], { env, cwd: tmp, stdio: ['pipe', 'pipe', 'pipe'] });
const builderPids = () => {
  if (process.platform === 'win32') return [];
  try { return execFileSync('pgrep', ['-f', `help.mjs --build ${tmp}`], { encoding: 'utf8' }).split('\n').filter(Boolean); } catch { return []; }
};

console.log('MCP 1c-help:');
{
  const cache = join(tmp, 'cache');
  const env = { ...process.env, HELP_CACHE_DIR: cache, V8_HELP_PATH: binNew };
  const proc = start(env);
  const { call, lines } = rpc(proc);
  const st = text(await call('help_status', {}));
  ok(/8\.3\.24\.1500/.test(st) && /shcntx_ru\.hbk/.test(st), 'help_status: платформа и файлы');
  const cacheFile = join(cache, '8.3.24.1500-ru.json');
  ok(existsSync(cacheFile), 'индекс в кэше по версии платформы');
  ok(lines.find((l) => l.id === 0)?.result?.serverInfo?.name === '1c-help', 'initialize');
  ok(/`Виджет\.Добавить` \(Widget\.Add\)/.test(text(await call('help_search', { query: 'Виджет.Добавть' }))), 'help_search: опечатка + Тип.Метод');
  ok(/Widget\.FindItem/.test(text(await call('help_search', { query: 'finditem' }))), 'help_search: англ. имя');
  ok(/Ничего не найдено/.test(text(await call('help_search', { query: 'ПридуманныйМетод' }))), 'help_search: несуществующее');
  const g = text(await call('help_get', { name: 'Widget.Add' }));
  ok(/\*\*Синтаксис:\*\*/.test(g) && /\*\*Параметры:\*\*/.test(g) && /\*\*Возвращаемое значение:\*\*/.test(g) &&
    /\*\*Доступность:\*\* Сервер/.test(g) && /```bsl\n/.test(g), 'help_get: синтаксис/параметры/возврат/доступность/пример');
  ok(/глобального контекста/.test(text(await call('help_get', { name: 'СтрокаВиджета' }))), 'help_get: глобальный контекст');
  ok(/КонецПовтора/.test(text(await call('help_get', { name: 'Повторять' }))), 'help_get: встроенный язык');
  const m = text(await call('help_members', { type: 'Виджет' }));
  ok(/Добавить \(Add\)/.test(m) && /Количество \(Count\)/.test(m) && /ПриИзменении/.test(m) && /По умолчанию/.test(m), 'help_members: методы, свойства, события, конструкторы');
  ok(!/Добавить/.test(text(await call('help_members', { type: 'widget', kind: 'properties' }))), 'help_members: фильтр по виду');
  const built = JSON.parse(readFileSync(cacheFile, 'utf8')).built;
  proc.stdin.end();
  await new Promise((r) => proc.on('exit', r));
  const p2 = start(env); const c2 = rpc(p2);
  await c2.call('help_status', {});
  ok(JSON.parse(readFileSync(cacheFile, 'utf8')).built === built, 'повторный запуск берёт индекс из кэша');
  await c2.call('help_status', { refresh: true });
  ok(JSON.parse(readFileSync(cacheFile, 'utf8')).built !== built, 'refresh пересобирает индекс');
  p2.stdin.end();
  await new Promise((r) => p2.on('exit', r));
  ok(!readdirSync(cache).some((f) => f.endsWith('.tmp')), 'нет временных файлов');
}

{
  const env = { ...process.env, HELP_CACHE_DIR: join(tmp, 'cache2'), V8_HELP_PATH: binNew, HELP_BUILD_TIMEOUT_MS: '1' };
  const proc = start(env);
  const { call } = rpc(proc);
  const r = await call('help_status', {});
  ok(r?.isError && /прервана/.test(text(r)), 'таймаут сборки индекса');
  await sleep(300);
  ok(builderPids().length === 0, 'процесс сборки убит по таймауту');
  proc.stdin.end();
  await new Promise((res) => proc.on('exit', res));
}

{
  const env = { ...process.env, HELP_CACHE_DIR: join(tmp, 'cache3'), V8_HELP_PATH: join(tmp, 'нет') };
  const proc = start(env);
  const { call } = rpc(proc);
  ok(/Справка недоступна/.test(text(await call('help_search', { query: 'x' }))), 'нет платформы — понятное сообщение');
  proc.kill();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
