#!/usr/bin/env node
// Тесты долгоживущего сеанса web-test (OpenCode): `open` один раз → много `exec` в том же браузере;
// сеанс переживает конец вызова shell (и SIGKILL группы процессов вызова), повторный `open` берёт открытый,
// токен (чужой пользователь на 127.0.0.1 получает 403), файл сеанса 0600, остановка по простою (exec не
// обрывается), смена адреса, ошибка запуска, гонка двух `open`, устаревший файл сеанса; файлы порта в навыке
// совпадают с skill-overlays/. Браузер и Playwright подменены (fake-browser.mjs через хук загрузчика).
//   node tests/web-test/session.mjs
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const RUN = join(repo, 'skills', 'web-test', 'scripts', 'run.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
let passed = 0; let failed = 0;
const ok = (c, n) => { if (c) { passed++; console.log(`  ok   ${n}`); } else { failed++; console.log(`  FAIL ${n}`); } };

// --- файлы порта в навыке web-test ---
console.log('web-test overlays:');
for (const rel of ['web-test/scripts/cli/commands/open.mjs', 'web-test/scripts/cli/keepalive.mjs', 'web-test/scripts/engine/forms/frame-text.mjs']) {
  const inSkill = join(repo, 'skills', rel);
  ok(existsSync(inSkill) && statSync(inSkill).size > 0, `skills/${rel} присутствует`);
}
const skillMd = readFileSync(join(repo, 'skills', 'web-test', 'SKILL.md'), 'utf-8');
ok(/node \$RUN open <url>/.test(skillMd) && /Never call `run` once per step/.test(skillMd), 'SKILL.md: open + exec, не run на каждый шаг');
const runSrc = readFileSync(RUN, 'utf-8');
ok(/case 'open':/.test(runSrc), 'run.mjs: команда open подключена');
const serverSrc = readFileSync(join(repo, 'skills', 'web-test', 'scripts', 'cli', 'server.mjs'), 'utf-8');
ok(/authorize\(req\)/.test(serverSrc) && /trackRequest\(\)/.test(serverSrc), 'server.mjs: токен и учёт активности');
for (const c of ['exec', 'shot', 'stop', 'status']) {
  const src = readFileSync(join(repo, 'skills', 'web-test', 'scripts', 'cli', 'commands', `${c}.mjs`), 'utf-8');
  ok(/sess\.token/.test(src), `${c}.mjs: запрос с токеном`);
}

// --- keepalive: модульные проверки ---
console.log('web-test keepalive:');
const ka = await import(pathToFileURL(join(repo, 'skills', 'web-test', 'scripts', 'cli', 'keepalive.mjs')).href);
{
  const req = { url: `/${ka.SESSION_TOKEN}/exec` };
  ok(ka.authorize(req) && req.url === '/exec', 'authorize: верный токен, путь без токена');
  ok(!ka.authorize({ url: '/exec' }), 'authorize: без токена — отказ');
  ok(!ka.authorize({ url: `/${'0'.repeat(ka.SESSION_TOKEN.length)}/exec` }), 'authorize: чужой токен — отказ');
  ok(ka.sameUrl('http://LOCALHOST:8081/demo/', 'http://localhost:8081/demo'), 'sameUrl: «/» в конце и регистр хоста');
  ok(!ka.sameUrl('http://localhost:8081/demo', 'http://localhost:8081/demo2'), 'sameUrl: разные базы');
  ok(ka.idleMinutes({}) === 30 && ka.idleMinutes({ WEB_TEST_IDLE_MIN: '0' }) === 0 && ka.idleMinutes({ WEB_TEST_IDLE_MIN: 'x' }) === 30, 'idleMinutes: 30 по умолчанию, 0 — без ограничения');
}

if (process.platform === 'win32') {
  console.log('Сценарии сеанса рассчитаны на Linux/macOS (группы процессов, сигналы).');
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// --- сценарии на поддельном браузере ---
console.log('web-test session:');
function setup(extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'webtest-sess-'));
  const env = { ...process.env, WEB_TEST_SESSION_DIR: dir, FAKE_BROWSER_LOG: join(dir, 'events.log'),
    NODE_OPTIONS: `--import=${pathToFileURL(join(here, 'register.mjs')).href}`, ...extraEnv };
  delete env.WEB_TEST_IDLE_MIN;
  Object.assign(env, extraEnv);
  return { dir, env };
}
function cli(env, args, input) {
  const r = spawnSync(process.execPath, [RUN, ...args], { env, input, encoding: 'utf-8', timeout: 60000, cwd: repo });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch {}
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}
const events = (dir) => { try { return readFileSync(join(dir, 'events.log'), 'utf-8').trim().split('\n').filter(Boolean); } catch { return []; } };
const sessionFile = (dir) => readdirSync(dir).find((f) => /^web-test-session-.*\.json$/.test(f));
async function waitDead(pid, ms = 10000) { const t = Date.now(); while (alive(pid) && Date.now() - t < ms) await sleep(100); return !alive(pid); }

const cleanupPids = [];
try {
  // 1. open → exec × 3 → open ещё раз: один браузер, один вход в 1С
  {
    const { dir, env } = setup();
    const o1 = cli(env, ['open', 'http://localhost:8081/demo']);
    ok(o1.code === 0 && o1.json?.ok && o1.json.started, 'open: сеанс открыт');
    const pid = o1.json?.pid; cleanupPids.push(pid);
    const outs = [];
    for (let i = 0; i < 3; i++) outs.push(cli(env, ['exec', '-'], 'console.log((await getFormState()).pid)'));
    ok(outs.every((r) => r.code === 0 && r.json?.ok && r.json.output === String(pid)), 'exec × 3 — в том же процессе браузера');
    const o2 = cli(env, ['open', 'http://localhost:8081/demo/']);
    ok(o2.json?.reused === true && o2.json.pid === pid, 'повторный open с тем же адресом — тот же сеанс');
    ok(events(dir).filter((e) => e.startsWith('connect')).length === 1, 'в 1С вошли один раз');

    // токен и права
    const sf = join(dir, sessionFile(dir));
    const sess = JSON.parse(readFileSync(sf, 'utf-8'));
    ok((statSync(sf).mode & 0o077) === 0, 'файл сеанса доступен только владельцу (0600)');
    const r403 = await fetch(`http://127.0.0.1:${sess.port}/status`);
    ok(r403.status === 403, 'запрос без токена (другой пользователь на 127.0.0.1) — 403');
    const rExec = await fetch(`http://127.0.0.1:${sess.port}/exec`, { method: 'POST', body: 'console.log(1)' });
    ok(rExec.status === 403, 'exec без токена — 403');
    const st = cli(env, ['status']);
    ok(st.code === 0 && st.json?.ready && !('token' in st.json), 'status: сеанс жив, токен не печатается');

    const s = cli(env, ['stop']);
    ok(s.code === 0 && await waitDead(pid), 'stop: процесс браузера завершён');
    ok(events(dir).includes(`disconnect ${pid}`) && !sessionFile(dir), 'stop: выход из 1С, файл сеанса удалён');
    const e = cli(env, ['exec', '-'], 'console.log(1)');
    ok(e.code !== 0 && /open <url>/.test(e.stderr), 'exec без сеанса — подсказка про open');
  }

  // 2. сеанс переживает конец вызова shell: группа процессов вызова убита SIGKILL
  {
    const { dir, env } = setup();
    const shell = spawn('/bin/sh', ['-c', `"${process.execPath}" "${RUN}" open http://localhost:8081/demo; sleep 30`],
      { env, detached: true, stdio: ['ignore', 'pipe', 'ignore'], cwd: repo });
    let buf = '';
    shell.stdout.on('data', (d) => { buf += d; });
    const t0 = Date.now();
    while (!/"pid"/.test(buf) && Date.now() - t0 < 20000) await sleep(100);
    let pid = 0; try { pid = JSON.parse(buf).pid; } catch {}
    cleanupPids.push(pid);
    try { process.kill(-shell.pid, 'SIGKILL'); } catch {}
    await sleep(800);
    ok(pid && alive(pid), 'вызов shell убит (SIGKILL группы) — браузер жив');
    const ex = cli(env, ['exec', '-'], 'console.log((await getFormState()).pid)');
    ok(ex.json?.ok && ex.json.output === String(pid), 'следующий exec — в том же сеансе');
    cli(env, ['stop']);
    await waitDead(pid);
  }

  // 3. простой: сеанс закрывается сам; идущий exec не обрывается
  {
    const { dir, env } = setup();
    const o = cli(env, ['open', 'http://localhost:8081/demo', '--idle-min=0.02']);   // 1,2 с
    const pid = o.json?.pid; cleanupPids.push(pid);
    ok(o.json?.ok && o.json.idleMin === 0.02, 'open --idle-min');
    const ex = cli(env, ['exec', '-'], 'await new Promise((r) => setTimeout(r, 2500)); console.log("done")');
    ok(ex.json?.ok && ex.json.output === 'done' && alive(pid), 'exec дольше лимита простоя не обрывается');
    ok(await waitDead(pid, 8000), 'после простоя процесс завершился');
    ok(events(dir).includes(`disconnect ${pid}`) && !sessionFile(dir), 'простой: выход из 1С, файл сеанса удалён');
  }

  // 4. другой адрес → старый сеанс закрыт, открыт новый
  {
    const { dir, env } = setup();
    const a = cli(env, ['open', 'http://localhost:8081/demo']);
    cleanupPids.push(a.json?.pid);
    const b = cli(env, ['open', 'http://localhost:8082/other']);
    cleanupPids.push(b.json?.pid);
    ok(b.json?.started && b.json.restartedFrom === 'http://localhost:8081/demo' && b.json.pid !== a.json?.pid, 'другой адрес — новый сеанс');
    ok(await waitDead(a.json?.pid) && events(dir).includes(`disconnect ${a.json?.pid}`), 'старый сеанс закрыт с выходом из 1С');
    cli(env, ['stop']);
    await waitDead(b.json?.pid);
  }

  // 5. ошибка запуска (нет лицензии и т. п.) — понятный ответ, без файла сеанса и блокировки
  {
    const { dir, env } = setup();
    const f = cli(env, ['open', 'http://localhost:8081/fail']);
    ok(f.code === 1 && f.json?.ok === false && /лицензии/.test(f.json.output || ''), 'ошибка запуска — сообщение из лога start');
    ok(!sessionFile(dir) && !readdirSync(dir).some((x) => x.endsWith('.lock')), 'после ошибки нет файла сеанса и блокировки');
  }

  // 6. устаревший файл сеанса (процесс умер) — open начинает заново
  {
    const { dir, env } = setup();
    const o = cli(env, ['open', 'http://localhost:8081/demo']);
    const pid = o.json?.pid; cleanupPids.push(pid);
    const sf = join(dir, sessionFile(dir));
    const keep = readFileSync(sf, 'utf-8');
    process.kill(pid, 'SIGKILL');
    await waitDead(pid);
    writeFileSync(sf, keep);
    const o2 = cli(env, ['open', 'http://localhost:8081/demo']);
    cleanupPids.push(o2.json?.pid);
    ok(o2.json?.started && o2.json.pid !== pid, 'файл от умершего процесса — новый сеанс');
    cli(env, ['stop']);
    await waitDead(o2.json?.pid);
  }

  // 7. два open одновременно — один браузер
  {
    const { dir, env } = setup();
    const run = () => new Promise((res) => {
      const p = spawn(process.execPath, [RUN, 'open', 'http://localhost:8081/slow'], { env, cwd: repo });
      let out = ''; p.stdout.on('data', (d) => { out += d; });
      p.on('exit', () => { try { res(JSON.parse(out)); } catch { res(null); } });
    });
    const [r1, r2] = await Promise.all([run(), run()]);
    cleanupPids.push(r1?.pid, r2?.pid);
    ok(r1?.ok && r2?.ok && r1.pid === r2.pid, 'два одновременных open — один сеанс');
    ok(events(dir).filter((e) => e.startsWith('connect')).length === 1, 'в 1С вошли один раз');
    cli(env, ['stop']);
    await waitDead(r1?.pid);
  }
} finally {
  for (const pid of cleanupPids) if (pid && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
