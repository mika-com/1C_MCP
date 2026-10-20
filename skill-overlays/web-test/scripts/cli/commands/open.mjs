// web-test cli/commands/open — OpenCode: открыть сеанс браузера или взять уже открытый.
// Файл порта (skill-overlays/), в upstream cc-1c-skills его нет.
//
// Зачем: shell OpenCode завершает процессы, запущенные обычным вызовом, когда вызов закончился (или по
// таймауту 2 мин), а `run` по построению открывает браузер, выполняет скрипт и закрывает браузер. Если агент
// работает по шагам, каждый шаг открывал 1С заново. `open` запускает `start` отдельным (detached) процессом,
// ждёт готовности 1С и возвращается; процесс браузера живёт дальше — между вызовами `exec`, после конца
// вызова shell и без флага background. Повторный `open` с тем же адресом возвращает живой сеанс.
// Закрывается сеанс командой `stop` или сам после простоя (WEB_TEST_IDLE_MIN, по умолчанию 30 мин).
//
// Несколько пользователей RDP: файл сеанса — свой у каждого пользователя (временный каталог), сервер
// принимает запросы только с токеном из этого файла, а `open` завершает только процесс, который сам запустил.
import { spawn, spawnSync } from 'child_process';
import { existsSync, readFileSync, openSync, closeSync, unlinkSync, statSync, writeSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { out } from '../util.mjs';
import { SESSION_FILE } from '../session.mjs';
import { tokenPrefix, sameUrl, idleMinutes } from '../keepalive.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUN_SCRIPT = resolve(__dirname, '..', '..', 'run.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function logFileFor(sessionFile) {
  return sessionFile.replace(/\.json$/i, '') + '.log';
}

function readSession(file) {
  try { return JSON.parse(readFileSync(file, 'utf-8')); } catch { return null; }
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

async function probe(sess, timeoutMs = 3000) {
  if (!sess || !sess.port) return { reachable: false };
  try {
    const resp = await fetch(`http://127.0.0.1:${sess.port}${tokenPrefix(sess)}/status`,
      { signal: AbortSignal.timeout(timeoutMs) });
    if (!resp.ok) return { reachable: true, connected: false, status: resp.status };
    const body = await resp.json();
    return { reachable: true, connected: !!body.connected };
  } catch {
    return { reachable: false };
  }
}

async function stopServer(sess, timeoutMs = 60000) {
  try {
    const resp = await fetch(`http://127.0.0.1:${sess.port}${tokenPrefix(sess)}/stop`,
      { method: 'POST', signal: AbortSignal.timeout(timeoutMs) });
    if (!resp.ok) return;   // не наш сервер (порт занят другим процессом) — не ждём и не трогаем
  } catch {}
  const t0 = Date.now();
  while (sess.pid && alive(sess.pid) && Date.now() - t0 < timeoutMs) await sleep(250);
}

function killOwnChild(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
  }
}

function tail(file, max = 2000) {
  try { const s = readFileSync(file, 'utf-8'); return s.length > max ? s.slice(-max) : s; } catch { return ''; }
}

/** Исключить два одновременных `open` одного пользователя (два браузера, две лицензии). */
function takeLock(lockFile, staleMs) {
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(lockFile, 'wx', 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let holder = 0; let age = 0;
      try { holder = Number(readFileSync(lockFile, 'utf-8')) || 0; age = Date.now() - statSync(lockFile).mtimeMs; } catch {}
      if ((holder && !alive(holder)) || age > staleMs) { try { unlinkSync(lockFile); } catch {} continue; }
      return false;
    }
  }
  return false;
}

/**
 * Открыть сеанс или вернуть открытый.
 * opts: sessionFile, runScript, startArgs (доп. флаги для start), timeoutMs, idleMin, cwd, env.
 */
export async function openSession(url, opts = {}) {
  const sessionFile = opts.sessionFile || SESSION_FILE;
  const runScript = opts.runScript || RUN_SCRIPT;
  const timeoutMs = opts.timeoutMs ?? 180000;
  const env = { ...(opts.env || process.env) };
  const idleMin = opts.idleMin ?? idleMinutes(env);
  const logFile = logFileFor(sessionFile);
  const lockFile = sessionFile + '.lock';

  // 1. Уже открытый сеанс
  let restartedFrom = null;
  const existing = readSession(sessionFile);
  if (existing) {
    const p = await probe(existing);
    if (p.reachable && p.connected && (!url || sameUrl(existing.url, url))) {
      return { ok: true, reused: true, message: 'Session already open — reuse it with exec', url: existing.url,
        pid: existing.pid, port: existing.port, startedAt: existing.startedAt, idleMin: existing.idleMin };
    }
    if (p.reachable) {
      // Другая база или браузер закрыт вручную — штатно закрываем свой сервер (выход из 1С)
      if (p.connected) restartedFrom = existing.url;
      await stopServer(existing);
    }
    try { unlinkSync(sessionFile); } catch {}
  }
  if (!url) return { ok: false, error: 'No active session. Usage: node run.mjs open <url>' };

  // 2. Блокировка: второй `open` ждёт первый и берёт его сеанс
  if (!takeLock(lockFile, timeoutMs + 30000)) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await sleep(500);
      const s = readSession(sessionFile);
      if (s && (await probe(s)).connected && sameUrl(s.url, url)) {
        return { ok: true, reused: true, message: 'Session opened by a parallel call — reuse it with exec',
          url: s.url, pid: s.pid, port: s.port, startedAt: s.startedAt, idleMin: s.idleMin };
      }
      if (!existsSync(lockFile)) return openSession(url, opts);
    }
    return { ok: false, error: `Another "open" is still starting the browser (lock ${lockFile})` };
  }

  try {
    // 3. Отдельный процесс start: не дочерний для shell OpenCode, переживает конец вызова
    const logFd = openSync(logFile, 'w', 0o600);
    let child;
    try {
      child = spawn(process.execPath, [runScript, 'start', url, ...(opts.startArgs || [])], {
        cwd: opts.cwd || process.cwd(),
        env: { ...env, WEB_TEST_IDLE_MIN: String(idleMin) },
        detached: true,
        stdio: ['ignore', logFd, logFd],
        windowsHide: false,   // браузер 1С — видимое окно (headless 1С не поддерживает)
      });
    } finally {
      closeSync(logFd);
    }
    let exited = null;
    child.on('exit', (code, signal) => { exited = { code, signal }; });
    child.on('error', (e) => { exited = { error: e.message }; });
    child.unref();

    // 4. Ждём, пока сервер запишет файл сеанса и 1С загрузится
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await sleep(500);
      if (exited) {
        return { ok: false, error: 'Browser session failed to start', exit: exited, log: logFile, output: tail(logFile) };
      }
      const s = readSession(sessionFile);
      if (s && s.pid === child.pid && (await probe(s)).connected) {
        return { ok: true, started: true, ...(restartedFrom ? { restartedFrom } : {}),
          message: 'Browser ready. Session stays open between exec calls; close it with stop',
          url: s.url, pid: s.pid, port: s.port, startedAt: s.startedAt, idleMin, log: logFile };
      }
    }
    killOwnChild(child.pid);
    return { ok: false, error: `1C web client did not become ready in ${Math.round(timeoutMs / 1000)} s`,
      log: logFile, output: tail(logFile) };
  } finally {
    try { unlinkSync(lockFile); } catch {}
  }
}

export async function cmdOpen(url, rawArgs = []) {
  const num = (name) => {
    const a = rawArgs.find((x) => x.startsWith(`--${name}=`));
    if (!a) return undefined;
    const n = Number(a.slice(name.length + 3));
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const startArgs = rawArgs.filter((a) => a === '--no-preserve-clipboard');
  const openTimeout = num('open-timeout');
  const result = await openSession(url, {
    startArgs,
    idleMin: num('idle-min'),
    timeoutMs: openTimeout !== undefined ? openTimeout * 1000 : undefined,
  });
  out(result);
  if (!result.ok) process.exit(1);
}
