#!/usr/bin/env node
// Тесты плагина bsl-autocheck (plugins/bsl-autocheck.mjs) на поддельном BSL LS и миграции lsp.bsl.
//   node tests/plugins/bsl-autocheck.mjs
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as P from '../../plugins/bsl-autocheck.mjs';
import { updateConfig, removeOwnLsp } from '../../mcp/register-opencode-mcp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const fake = join(here, 'fake-bsl-analyze.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
let passed = 0; let failed = 0;
const ok = (cond, name) => { if (cond) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name}`); } };

const fakeFind = () => ({ cmd: process.execPath, args: [fake], path: fake });
function project(files) {
  const dir = mkdtempSync(join(tmpdir(), 'bsl-autocheck-test-'));
  for (const [rel, text] of Object.entries(files)) { const f = join(dir, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text); }
  return dir;
}
async function load(dir, { env = {}, find = fakeFind, log } = {}) {
  const e = { ...env, BSL_AUTOCHECK_STATE: env.BSL_AUTOCHECK_STATE || join(dir, 'autocheck-state.json') }; if (log) e.FAKE_LOG = log;
  Object.assign(process.env, log ? { FAKE_LOG: log } : {});
  const plugin = P.createPlugin({ env: e, analyze: (files, o) => P.bslAnalyze(files, { ...o, find, env: { ...process.env, ...e } }) });
  const hooks = {};
  const dispose = await plugin.setup({ location: { directory: dir }, options: {}, tool: { hook: async (name, cb) => { hooks[name] = cb; return { dispose() {} }; } } });
  const run = async (tool, input, result = { content: 'Edited file (1 replacement)' }) => {
    const ev = { tool, sessionID: 's', agent: '1c', messageID: 'm', id: 'c', input, status: 'completed', result };
    await hooks['execute.after']?.(ev);
    return ev;
  };
  return { hooks, run, dispose };
}
const text = (ev) => (typeof ev.result.content === 'string' ? ev.result.content : JSON.stringify(ev.result.content));

console.log('разбор:');
{
  const base = '/p';
  const f = P.editedFiles({ tool: 'patch', input: { patchText: '*** Begin Patch\n*** Add File: src/A/Ext/Module.bsl\n+x\n*** Update File: src/B.bsl\n*** Move to: src/C.bsl\n*** Delete File: src/D.bsl\n*** Update File: README.md\n*** End Patch' } }, base);
  ok(f.join(',') === ['/p/src/A/Ext/Module.bsl', '/p/src/B.bsl', '/p/src/C.bsl'].map((x) => resolve(x)).join(','), 'patch: Add/Update/Move, без Delete и не-BSL');
  ok(P.editedFiles({ tool: 'edit', input: { path: 'x/Module.bsl' } }, base)[0] === resolve('/p/x/Module.bsl'), 'edit: относительный path');
  ok(P.editedFiles({ tool: 'write', input: { filePath: '/q/s.os' }, result: { output: { operation: 'write', target: '/q/s.os' } } }, base).length === 1, 'write: filePath (v1) и output.target, без дублей');
  const dir = project({ '.v8-project.json': '{\n // комм.\n "bslAutocheck": { "severity": "Error", "limit": 5, },\n}' });
  const s = P.loadSettings(dir, {});
  ok(s.severity === 'Error' && s.limit === 5 && s.enabled && s.timeoutMs === 30000, '.v8-project.json bslAutocheck (с комментариями)');
  const s2 = P.loadSettings(dir, { BSL_AUTOCHECK: '0', BSL_AUTOCHECK_SEVERITY: 'hint', BSL_AUTOCHECK_TIMEOUT_MS: '5000' });
  ok(!s2.enabled && s2.severity === 'Hint' && s2.timeoutMs === 5000, 'переменные среды важнее .v8-project.json');
  ok(P.appendToResult({ content: 'a' }, 'b').content === 'a\n\nb' && P.appendToResult({ content: [{ type: 'text', text: 'a' }] }, 'b').content[1].text === 'b' &&
    /"target"/.test(P.appendToResult({ output: { target: 'x' } }, 'b').content), 'дописывание к content: строка / массив / только output');
  const rows = Array.from({ length: 30 }, (_, i) => ({ lvl: i % 3 ? 'Warning' : 'Error', line: 30 - i, col: 1, code: 'C', msg: `m${i}` }));
  const out = P.formatResults([{ file: '/p/M.bsl', status: 'ok', diags: rows }], { root: '/p', limit: 8 });
  const ls = out.split('\n');
  ok(/M\.bsl: 10 ошибок, 20 предупреждений/.test(ls[0]) && ls.slice(1, 9).every((l, i) => (i < 8 ? /ошибка/.test(l) : true)) && /… ещё 22/.test(out), 'вывод: сначала ошибки, лимит строк, остаток');
  ok(P.formatResults([{ file: '/p/M.bsl', status: 'ok', diags: rows }], { root: '/p', severity: 'Error', limit: 50 }).split('\n').length === 11, 'порог Error скрывает предупреждения');
}

console.log('плагин на поддельном BSL LS:');
{
  const dir = project({
    'src/CommonModules/Общий/Ext/Module.bsl': 'Процедура А()\n  ПРЕДУПРЕЖДЕНИЕ\n  ОШИБКА\nКонецПроцедуры\n',
    'src/Two/Ext/Module.bsl': 'Процедура Б()\nКонецПроцедуры\n',
    'readme.txt': 'ОШИБКА',
  });
  const log = join(dir, 'fake.log'); writeFileSync(log, '');
  const p = await load(dir, { log });
  const e1 = await p.run('edit', { path: 'src/CommonModules/Общий/Ext/Module.bsl' });
  const t1 = text(e1);
  ok(t1.startsWith('Edited file') && /\[bsl-autocheck\] src\/CommonModules\/Общий\/Ext\/Module\.bsl: 1 ошибка, 1 предупреждение — исправь/.test(t1), 'ошибки дописаны к результату edit (кириллический путь)');
  ok(t1.indexOf('ошибка [ParseError]') < t1.indexOf('предупреждение [LineLength]') && /стр\. 3:5 ошибка \[ParseError\] Ошибка разбора — синтаксическая ошибка/.test(t1), 'ошибки раньше предупреждений, строка/колонка, сокращение сообщения парсера');
  const e2 = await p.run('edit', { path: 'readme.txt' });
  ok(e2.result.content === 'Edited file (1 replacement)', 'не-BSL файл не проверяется');
  const err = { tool: 'edit', input: { path: 'src/Two/Ext/Module.bsl' }, status: 'error', error: { message: 'x' } };
  await p.hooks['execute.after'](err);
  ok(!err.result, 'неудачный вызов инструмента не трогаем');
  writeFileSync(log, '');
  const [a, b] = await Promise.all([
    p.run('write', { path: 'src/CommonModules/Общий/Ext/Module.bsl' }),
    p.run('edit', { path: 'src/Two/Ext/Module.bsl' }),
  ]);
  ok(readFileSync(log, 'utf8').trim().split('\n').length === 1, 'две параллельные правки — один запуск BSL LS (пачка)');
  ok(/1 ошибка/.test(text(a)) && text(b) === 'Edited file (1 replacement)', 'каждый результат получает только свои замечания (чистый файл — без шума)');
  writeFileSync(join(dir, 'src/CommonModules/Общий/Ext/Module.bsl'), 'Процедура А()\nКонецПроцедуры\n');
  ok(/больше нет/.test(text(await p.run('edit', { path: 'src/CommonModules/Общий/Ext/Module.bsl' }))), 'после исправления — короткое «замечаний больше нет»');
  const multi = await p.run('patch', { patchText: '*** Begin Patch\n*** Update File: src/Two/Ext/Module.bsl\n*** Update File: src/CommonModules/Общий/Ext/Module.bsl\n*** End Patch' }, { content: 'Success. Updated', output: { applied: [] } });
  ok(multi.result.content === 'Success. Updated', 'patch по двум чистым файлам — без вывода');
  await p.dispose?.();
  const p2 = await load(dir, { log });
  ok(p2.hooks['execute.after'], 'после выгрузки плагин регистрируется снова');
  const p3 = await load(dir, { log });
  ok(!p3.hooks['execute.after'], 'второй экземпляр на тот же каталог (глобальный + проектный) хук не ставит');
  await p2.dispose?.();
  const left = readdirSync(tmpdir()).filter((n) => n.startsWith('bsl-autocheck-') && !n.startsWith('bsl-autocheck-test-'));
  ok(left.length === 0, 'временные каталоги удалены');
}

{
  const dir = project({ 'M.bsl': 'ОШИБКА\n', 'Big.bsl': 'А'.repeat(3000) });
  const off = await load(dir, { env: { BSL_AUTOCHECK: '0' } });
  ok(!(await off.run('edit', { path: 'M.bsl' })).result.content.includes('bsl-autocheck'), 'BSL_AUTOCHECK=0 — выключено');
  await off.dispose?.();
  const big = await load(dir, { env: { BSL_AUTOCHECK_MAX_KB: '1' } });
  ok(/не проверен — \d+ КБ больше лимита 1 КБ/.test(text(await big.run('edit', { path: 'Big.bsl' }))), 'большой файл пропущен с пояснением');
  await big.dispose?.();
  const none = await load(dir, { find: () => null });
  const h1 = text(await none.run('edit', { path: 'M.bsl' }));
  const h2 = text(await none.run('edit', { path: 'M.bsl' }));
  ok(/BSL Language Server не найден/.test(h1) && h2 === 'Edited file (1 replacement)', 'нет BSL LS — одна подсказка, дальше без шума');
  await none.dispose?.();
}

if (process.platform !== 'win32') {
  const dir = project({ 'Hang.bsl': 'SLEEP\n' });
  const pids = join(dir, 'pids'); writeFileSync(pids, ''); process.env.FAKE_PIDS = pids;
  const p = await load(dir, { env: { BSL_AUTOCHECK_TIMEOUT_MS: '1500' } });
  const t0 = Date.now();
  const r = text(await p.run('edit', { path: 'Hang.bsl' }));
  ok(/не уложился в 2 с — не проверено/.test(r) && Date.now() - t0 < 6000, 'таймаут пачки — понятное сообщение');
  await sleep(500);
  const list = readFileSync(pids, 'utf8').split('\n').filter(Boolean).map(Number);
  ok(list.length === 2 && list.every((x) => !alive(x)), 'по таймауту погашено дерево BSL LS (процесс и потомок)');
  await p.dispose?.();
  delete process.env.FAKE_PIDS;
} else console.log('  (таймаут/дерево процессов — только POSIX в этом тесте)');

console.log('кодировка оболочки и отметка плагина:');
{
  const ev = { command: 'Get-ChildItem', shell: 'powershell.exe', env: {} };
  ok(P.applyShellUtf8(ev) && ev.command.startsWith(P.PS_UTF8_PREAMBLE) && ev.env.PYTHONUTF8 === '1' && ev.env.PYTHONIOENCODING === 'utf-8', 'powershell: преамбула UTF-8 и PYTHONUTF8');
  ok(P.applyShellUtf8(ev) === false && ev.command.indexOf('UTF8Encoding $false') === ev.command.lastIndexOf('UTF8Encoding $false'), 'powershell: повтор не дублирует преамбулу');
  const cmd = { command: 'dir', shell: 'C:\\Windows\\System32\\cmd.exe', env: {} };
  ok(P.applyShellUtf8(cmd) && cmd.command.startsWith('chcp 65001 >nul & '), 'cmd: chcp 65001');
  ok(P.applyShellUtf8(cmd) === false, 'cmd: повтор не дублирует chcp');
  const bash = { command: 'ls', shell: 'bash', env: {} };
  ok(P.applyShellUtf8(bash) === false && bash.command === 'ls' && bash.env.PYTHONIOENCODING === 'utf-8', 'bash: команда без изменений, Python в UTF-8');
  const dir = project({ 'M.bsl': 'Процедура А()\nКонецПроцедуры\n' });
  const state = join(dir, 'autocheck-state.json');
  const hooks = {};
  const plugin = P.createPlugin({ env: { BSL_AUTOCHECK_STATE: state }, analyze: async () => ({ status: 'ok', diags: new Map() }) });
  const dispose = await plugin.setup({
    location: { directory: dir },
    tool: { hook: async (name, cb) => { hooks[name] = cb; return { dispose() {} }; } },
    shell: { hook: async (name, cb) => { hooks['shell:' + name] = cb; return { dispose() {} }; } },
  });
  const ver = readFileSync(join(repo, 'VERSION'), 'utf8').trim().split(/\s+/)[0];
  const data = JSON.parse(readFileSync(state, 'utf8'));
  ok(data.version === ver && data.root === resolve(dir), 'setup пишет отметку версии плагина');
  const sh = { command: 'echo hi', shell: 'pwsh', env: {} };
  await hooks['shell:create.before'](sh);
  ok(sh.command.startsWith(P.PS_UTF8_PREAMBLE), 'shell.create.before дописывает UTF-8');
  const toolEv = { input: { command: 'echo x', shell: 'powershell' }, env: {} };
  await hooks['execute.before'](toolEv);
  ok(toolEv.input.command.startsWith(P.PS_UTF8_PREAMBLE), 'tool.execute.before для команды оболочки');
  const editEv = { input: { path: 'M.bsl' } };
  await hooks['execute.before'](editEv);
  ok(editEv.input.path === 'M.bsl' && editEv.input.command === undefined, 'execute.before без оболочки не трогает edit');
  await dispose?.();
}

console.log('миграция LSP:');
{
  const own = { command: ['node', 'C:\\1c\\agent\\lsp\\bsl-lsp.mjs'], extensions: ['.bsl', '.os'] };
  const c1 = updateConfig({ $schema: 'x', mcp: { servers: {} }, lsp: { bsl: own } }, '/r/mcp');
  ok(!('lsp' in c1) && c1.mcp.servers['1c-search'], 'наша запись lsp.bsl удалена, пустая секция lsp — тоже');
  const c2 = updateConfig({ mcp: { servers: {} }, lsp: { bsl: own, typescript: { command: ['tsls'] } } }, '/r/mcp');
  ok(c2.lsp && !c2.lsp.bsl && c2.lsp.typescript, 'чужие LSP-серверы сохранены');
  const c3 = updateConfig({ mcp: { servers: {} }, lsp: { bsl: { command: ['my-bsl-ls'] } } }, '/r/mcp');
  ok(c3.lsp.bsl.command[0] === 'my-bsl-ls', 'собственный lsp.bsl пользователя не трогаем');
  ok(!('lsp' in updateConfig({ mcp: { servers: {} } }, '/r/mcp')) && updateConfig({ lsp: false }, '/r/mcp').lsp === false, 'lsp не создаётся; lsp: false сохраняется');
  ok(!('lsp' in updateConfig({ mcp: { servers: {} }, lsp: { bsl: own } }, '/r/mcp', { remove: true })), '--remove тоже убирает lsp.bsl');
  ok(removeOwnLsp({ lsp: {} }).lsp === undefined, 'removeOwnLsp: пустой объект');
  const oc = JSON.parse(readFileSync(join(repo, 'opencode.json'), 'utf8'));
  ok(!('lsp' in oc) && !existsSync(join(repo, 'lsp')), 'в репозитории нет lsp/ и секции lsp');
}

console.log('default_agent:');
{
  const c1 = updateConfig({ $schema: 'x', mcp: { servers: {} } }, '/r/mcp');
  ok(c1.default_agent === '1c' && Object.keys(c1)[1] === 'default_agent', 'не задан — пишется "1c" (сразу после $schema)');
  ok(updateConfig({ default_agent: 'build' }, '/r/mcp').default_agent === 'build', 'значение пользователя не перезаписывается');
  ok(!('default_agent' in updateConfig({}, '/r/mcp', { defaultAgent: false })), 'defaultAgent: false — не пишется');
  ok(!('default_agent' in updateConfig({ default_agent: '1c' }, '/r/mcp', { remove: true })), '--remove убирает "1c"');
  ok(updateConfig({ default_agent: 'plan' }, '/r/mcp', { remove: true }).default_agent === 'plan', '--remove не трогает чужое значение');
  const dir = mkdtempSync(join(tmpdir(), 'oc-cfg-'));
  const cfgPath = join(dir, 'opencode.json');
  const reg = join(repo, 'mcp', 'register-opencode-mcp.mjs');
  const run = (...a) => spawnSync(process.execPath, [reg, '--config', cfgPath, ...a], { encoding: 'utf8' });
  run();
  const first = readFileSync(cfgPath, 'utf8');
  ok(JSON.parse(first).default_agent === '1c', 'CLI: новый конфиг получает default_agent "1c"');
  ok(JSON.parse(first).mcp.servers['1c-search'].command.some((p) => String(p).endsWith('restart-stdio.mjs')), 'CLI: 1c-search запускается через restart-stdio');
  ok(/Без изменений/.test(run().stdout) && readFileSync(cfgPath, 'utf8') === first, 'CLI: повторный запуск ничего не меняет');
  run('--remove');
  const removed = JSON.parse(readFileSync(cfgPath, 'utf8'));
  ok(!('default_agent' in removed) && !removed.mcp.servers['1c-search'], 'CLI: --remove убирает серверы и default_agent');
  writeFileSync(cfgPath, JSON.stringify({ default_agent: 'build' }));
  run();
  ok(JSON.parse(readFileSync(cfgPath, 'utf8')).default_agent === 'build', 'CLI: свой default_agent пользователя сохранён');
  rmSync(dir, { recursive: true, force: true });
}

console.log('установка плагина:');
{
  const py = spawnSync('python3', ['--version']).status === 0 ? 'python3' : 'python';
  const proj = project({ 'Configuration.xml': '<x/>' });
  const r = spawnSync(py, [join(repo, 'scripts', 'opencode_port.py'), 'install', '--project-dir', proj, '--no-mcp'], { encoding: 'utf8' });
  const shim = join(proj, '.opencode', 'plugins', 'bsl-autocheck.js');
  ok(r.status === 0 && existsSync(shim), 'install кладёт .opencode/plugins/bsl-autocheck.js');
  const mod = await import(pathToFileURL(shim).href);
  ok(mod.default?.id === '1c-agent.bsl-autocheck' && typeof mod.default.setup === 'function', 'переходник загружается: default { id, setup } (формат плагина v2)');
  ok(readFileSync(join(proj, '.opencode', '.1c-opencode'), 'utf8').includes('plugins/bsl-autocheck.js'), 'плагин записан в список установленного');
  spawnSync(py, [join(repo, 'scripts', 'opencode_port.py'), 'uninstall', '--project-dir', proj, '--no-mcp'], { encoding: 'utf8' });
  ok(!existsSync(shim), 'uninstall удаляет плагин');
  spawnSync(py, [join(repo, 'scripts', 'opencode_port.py'), 'install', '--project-dir', proj, '--no-mcp', '--no-autocheck'], { encoding: 'utf8' });
  ok(!existsSync(shim), '--no-autocheck — без плагина');
  const repoShim = await import(pathToFileURL(join(repo, '.opencode', 'plugins', 'bsl-autocheck.js')).href);
  ok(repoShim.default?.id === '1c-agent.bsl-autocheck', 'переходник репозитория .opencode/plugins/bsl-autocheck.js');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
