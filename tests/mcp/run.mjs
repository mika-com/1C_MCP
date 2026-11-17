#!/usr/bin/env node
// Тесты прокси 1c-bsl (mcp/bsl-ls.mjs) на поддельном BSL LS: дерево процессов гасится при EOF stdin,
// SIGTERM, смерти родителя и при запуске второго экземпляра; таймаут вызова; roots/list не отдаёт корень проекта.
//   node tests/mcp/run.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { createProxy, findNarrowWorkspaceDir } from '../../mcp/bsl-ls.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const proxyPath = resolve(here, '..', '..', 'mcp', 'bsl-ls.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
let passed = 0; let failed = 0;
const ok = (cond, name) => { if (cond) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name}`); } };

if (process.platform === 'win32') { console.log('Тесты рассчитаны на Linux/macOS (POSIX-сигналы).'); process.exit(0); }

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'bslproxy-'));
  const fake = join(dir, 'bsl-language-server');
  writeFileSync(fake, `#!/bin/sh\nexec "${process.execPath}" "${join(here, 'fake-bsl-ls.mjs')}" "$@"\n`);
  chmodSync(fake, 0o755);
  const pids = join(dir, 'pids.txt');
  writeFileSync(pids, '');
  const env = { ...process.env, BSL_LS_PATH: fake, FAKE_PIDS: pids, BSL_LS_LOCK_DIR: join(dir, 'locks'), BSL_LS_TIMEOUT_MS: '5000' };
  delete env.BSL_LS_ROOT;
  return { dir, env, pids };
}

function startProxy(env, cwd, { viaParent = false } = {}) {
  if (viaParent) {
    // промежуточный родитель, которого убьём SIGKILL
    const p = spawn(process.execPath, ['-e',
      `const c=require('child_process').spawn(process.execPath,[${JSON.stringify(proxyPath)}],{stdio:['pipe','ignore','ignore']});` +
      'console.log(c.pid); setInterval(()=>{},1000);'], { env, cwd, stdio: ['ignore', 'pipe', 'inherit'] });
    return p;
  }
  return spawn(process.execPath, [proxyPath], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
}

const readPids = (f) => readFileSync(f, 'utf8').split('\n').filter((l) => /^\d+$/.test(l)).map(Number);
async function waitFor(fn, ms = 8000) { const t = Date.now() + ms; while (Date.now() < t) { if (fn()) return true; await sleep(200); } return fn(); }

function rpc(proc) {
  const lines = [];
  createInterface({ input: proc.stdout }).on('line', (l) => lines.push(JSON.parse(l)));
  return {
    send: (m) => proc.stdin.write(JSON.stringify(m) + '\n'),
    wait: (pred, ms = 10000) => waitFor(() => lines.find(pred), ms).then(() => lines.find(pred)),
    lines,
  };
}

console.log('1c-bsl proxy:');

// 1. EOF stdin
{
  const { env, pids, dir } = setup();
  const p = startProxy(env, dir);
  await waitFor(() => readPids(pids).length >= 2);
  const tree = readPids(pids);
  ok(tree.length === 2 && tree.every(alive), 'дерево запущено (BSL LS + внук)');
  p.stdin.end();
  ok(await waitFor(() => !tree.some(alive) && p.exitCode !== null), 'EOF stdin → всё дерево завершено');
}

// 2. SIGTERM
{
  const { env, pids, dir } = setup();
  const p = startProxy(env, dir);
  await waitFor(() => readPids(pids).length >= 2);
  const tree = readPids(pids);
  p.kill('SIGTERM');
  ok(await waitFor(() => !tree.some(alive)), 'SIGTERM прокси → всё дерево завершено');
}

// 3. смерть родителя (SIGKILL промежуточного процесса)
{
  const { env, pids, dir } = setup();
  const parent = startProxy(env, dir, { viaParent: true });
  const proxyPid = await new Promise((r) => createInterface({ input: parent.stdout }).once('line', (l) => r(Number(l))));
  await waitFor(() => readPids(pids).length >= 2);
  const tree = readPids(pids);
  parent.kill('SIGKILL');
  ok(await waitFor(() => !tree.some(alive) && !alive(proxyPid), 10000), 'родитель убит SIGKILL → прокси и дерево завершены');
}

// 4. таймаут вызова, поздний ответ отброшен, roots/list пустой
{
  const { env, pids, dir } = setup();
  const p = startProxy(env, dir);
  const c = rpc(p);
  c.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: { roots: {} } } });
  await c.wait((m) => m.id === 1);
  ok(!c.lines.some((m) => m.method === 'roots/list'), 'roots/list не доходит до клиента');
  await waitFor(() => /roots:/.test(readFileSync(pids, 'utf8')));
  ok(/roots:\[\]/.test(readFileSync(pids, 'utf8')), 'BSL LS получил пустой список корней (проект целиком не индексируется)');
  c.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'fast', arguments: {} } });
  const fast = await c.wait((m) => m.id === 2, 3000);
  ok(fast?.result?.content?.[0]?.text === 'ok fast', 'быстрый вызов проходит');
  const t0 = Date.now();
  c.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'slow', arguments: {} } });
  const slow = await c.wait((m) => m.id === 3, 9000);
  ok(slow?.result?.isError === true && /не ответил/.test(slow.result.content[0].text) && Date.now() - t0 < 7000,
    'медленный вызов → понятная ошибка по таймауту');
  await sleep(4000);
  ok(c.lines.filter((m) => m.id === 3).length === 1, 'поздний ответ отброшен (ответ ровно один)');
  const tree = readPids(pids);
  p.stdin.end();
  await waitFor(() => !tree.some(alive));
}

// 5. BSL_LS_ROOT отдаёт узкую папку
{
  const { env, pids, dir } = setup();
  const p = startProxy({ ...env, BSL_LS_ROOT: dir }, dir);
  const c = rpc(p);
  c.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: { roots: {} } } });
  await waitFor(() => /roots:/.test(readFileSync(pids, 'utf8')));
  ok(readFileSync(pids, 'utf8').includes(`file://${dir}`), 'BSL_LS_ROOT → BSL LS получает только заданную папку');
  const tree = readPids(pids);
  p.stdin.end();
  await waitFor(() => !tree.some(alive));
}

// 6. второй экземпляр в том же проекте гасит первый
{
  const { env, pids, dir } = setup();
  const p1 = startProxy(env, dir);
  await waitFor(() => readPids(pids).length >= 2);
  const tree1 = readPids(pids);
  const p2 = startProxy(env, dir);
  await waitFor(() => readPids(pids).length >= 4);
  ok(await waitFor(() => !tree1.some(alive) && p1.exitCode !== null), 'второй экземпляр → первый и его дерево завершены');
  const tree2 = readPids(pids).slice(2);
  ok(tree2.every(alive), 'второй экземпляр работает');
  ok(existsSync(join(dir, 'locks')), 'lock-файл создан');
  p2.stdin.end();
  ok(await waitFor(() => !tree2.some(alive)), 'второй экземпляр закрыт без сирот');
}

// 7. run-supervised (vrunner-mcp и др.): EOF stdin гасит дерево
{
  const { env, pids, dir } = setup();
  const p = spawn(process.execPath, [resolve(here, '..', '..', 'mcp', 'run-supervised.mjs'), env.BSL_LS_PATH], { env, cwd: dir, stdio: ['pipe', 'ignore', 'ignore'] });
  await waitFor(() => readPids(pids).length >= 2);
  const tree = readPids(pids);
  p.stdin.end();
  ok(await waitFor(() => !tree.some(alive)), 'run-supervised: EOF stdin → дерево завершено');
}

// 8. Авто-регистрация узкой рабочей папки и нормализация относительного пути при вызове файлового инструмента
{
  const dir = mkdtempSync(join(tmpdir(), 'bsl-autows-'));
  const extDir = join(dir, 'src', 'doc-ext', 'ИнтеграцияSD');
  const modDir = join(extDir, 'CommonModules', 'SD_Уведомление', 'Ext');
  mkdirSync(modDir, { recursive: true });
  writeFileSync(join(extDir, 'Configuration.xml'), '<MetaDataObject><Configuration><Properties><Name>ИнтеграцияSD</Name><ObjectPrefix>SD_</ObjectPrefix></Properties></Configuration></MetaDataObject>');
  const bslFile = join(modDir, 'Module.bsl');
  writeFileSync(bslFile, 'Процедура Тест() Экспорт\nКонецПроцедуры\n');

  ok(findNarrowWorkspaceDir(bslFile) === extDir, 'findNarrowWorkspaceDir: находит корень расширения CFE (где Configuration.xml)');

  const toChildMsgs = [];
  const toClientMsgs = [];
  const proxy = createProxy({
    toChild: (l) => toChildMsgs.push(JSON.parse(l)),
    toClient: (l) => toClientMsgs.push(JSON.parse(l)),
    timeoutMs: 5000,
    roots: [],
    baseDir: dir,
  });

  proxy.fromClient(JSON.stringify({
    jsonrpc: '2.0',
    id: 10,
    method: 'tools/call',
    params: { name: 'analyze_file', arguments: { file: 'src/doc-ext/ИнтеграцияSD/CommonModules/SD_Уведомление/Ext/Module.bsl' } },
  }));

  const wsChange = toChildMsgs.find((m) => m.method === 'workspace/didChangeWorkspaceFolders');
  const rootsChanged = toChildMsgs.find((m) => m.method === 'notifications/roots/list_changed');
  const forwardedCall = toChildMsgs.find((m) => m.id === 10 && m.method === 'tools/call');

  ok(Boolean(wsChange && rootsChanged) && wsChange.params.event.added[0].uri === pathToFileURL(extDir).href,
     'createProxy: автоматически регистрирует узкую папку расширения при вызове analyze_file');
  ok(forwardedCall?.params?.arguments?.file === bslFile,
     'createProxy: автоматически преобразует относительный путь файла в абсолютный');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
