// proc-tree.mjs — запуск дочернего процесса так, чтобы при любом завершении родителя
// (EOF stdin, SIGTERM/SIGINT/SIGHUP, смерть родителя, выход) убивалось всё дерево процессов.
//
// Windows: taskkill /T /F /PID <pid> (bsl-language-server.exe порождает java и вложенные процессы).
// Linux/macOS: ребёнок в своей группе процессов (detached), убиваем группу: SIGTERM, через 2 с SIGKILL.

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';

const IS_WIN = process.platform === 'win32';

export function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Командная строка процесса ('' если не удалось узнать) — защита от повторно занятых PID.
export function processCommandLine(pid) {
  try {
    if (IS_WIN) {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 });
      return (r.stdout || '').trim();
    }
    if (process.platform === 'linux') return readFileSync(`/proc/${Number(pid)}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
    const r = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
    return (r.stdout || '').trim();
  } catch { return ''; }
}

// Владелец и сеанс процесса. Windows: Win32_Process.GetOwner + SessionId; POSIX: uid.
// Возвращает { user, sessionId, uid } или null (процесса нет / нет доступа).
export function processOwner(pid) {
  try {
    if (IS_WIN) {
      const ps = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}"; if ($p) { ` +
        '$o = Invoke-CimMethod -InputObject $p -MethodName GetOwner; ' +
        '"$($o.Domain)\\$($o.User)`t$($p.SessionId)" }';
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
        { encoding: 'utf8', windowsHide: true, timeout: 20000 });
      const [user, sid] = (r.stdout || '').trim().split('\t');
      if (!user || user === '\\') return null;
      return { user: user.toLowerCase(), sessionId: Number(sid) };
    }
    if (process.platform === 'linux') {
      const m = readFileSync(`/proc/${Number(pid)}/status`, 'utf8').match(/^Uid:\s+(\d+)/m);
      return m ? { uid: Number(m[1]) } : null;
    }
    const r = spawnSync('ps', ['-o', 'uid=', '-p', String(pid)], { encoding: 'utf8' });
    const uid = Number((r.stdout || '').trim());
    return Number.isFinite(uid) && (r.stdout || '').trim() ? { uid } : null;
  } catch { return null; }
}

let selfOwner;
export function currentOwner() {
  if (selfOwner !== undefined) return selfOwner;
  if (IS_WIN) {
    selfOwner = processOwner(process.pid) || {
      user: `${process.env.USERDOMAIN || ''}\\${process.env.USERNAME || userInfo().username}`.toLowerCase(), sessionId: NaN,
    };
  } else {
    selfOwner = { uid: process.getuid() };
  }
  return selfOwner;
}

// Процесс принадлежит текущему пользователю И текущему сеансу (RDP)? Только такие процессы можно гасить.
export function isOwnProcess(pid, { owner = processOwner, me = currentOwner() } = {}) {
  const o = owner(pid);
  if (!o) return false;
  if (IS_WIN) return o.user === me.user && o.sessionId === me.sessionId;
  return o.uid === me.uid;
}

// Синхронно убить дерево процессов с корнем pid (без ожиданий, годится для обработчика exit).
// Вызывающий отвечает за то, что pid — свой (isOwnProcess); для собственного ребёнка это верно по построению.
export function killTree(pid, { graceMs = 0 } = {}) {
  if (!pid) return;
  if (IS_WIN) {
    spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    return;
  }
  const sig = (s) => { try { process.kill(-pid, s); } catch { try { process.kill(pid, s); } catch { /* уже нет */ } } };
  sig('SIGTERM');
  if (graceMs > 0) {
    const until = Date.now() + graceMs;
    const nap = new Int32Array(new SharedArrayBuffer(4));
    while (Date.now() < until && isAlive(pid)) Atomics.wait(nap, 0, 0, 100);
  }
  sig('SIGKILL');
}

/**
 * Запустить ребёнка под надзором.
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} opts  опции spawn + { tag, onCleanup, watchStdin, parentPollMs }
 *   watchStdin — завершаться по EOF/закрытию нашего stdin (для stdio-прокси с stdin: 'pipe' ребёнку);
 *   parentPollMs — интервал проверки, жив ли родитель (0 — не проверять).
 */
export function spawnSupervised(cmd, args, opts = {}) {
  const { tag = 'proc', onCleanup, watchStdin = false, parentPollMs = 2000, ...spawnOpts } = opts;
  const child = spawn(cmd, args, { ...spawnOpts, detached: !IS_WIN, windowsHide: true });
  let done = false;
  const cleanup = (reason, code = 0) => {
    if (done) return;
    done = true;
    if (process.env.BSL_LS_DEBUG) process.stderr.write(`[${tag}] завершение: ${reason}\n`);
    try { onCleanup?.(reason); } catch { /* */ }
    if (child.exitCode === null && child.signalCode === null) killTree(child.pid, { graceMs: IS_WIN ? 0 : 1500 });
    process.exit(code);
  };

  child.on('exit', (code, signal) => cleanup(`ребёнок завершился (${code ?? signal})`, code ?? (signal ? 1 : 0)));
  child.on('error', (e) => { process.stderr.write(`[${tag}] ${e.message}\n`); cleanup('ошибка запуска', 1); });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try { process.on(sig, () => cleanup(sig, 0)); } catch { /* сигнал не поддерживается на платформе */ }
  }
  process.on('exit', () => { if (!done && child.exitCode === null) killTree(child.pid); });
  process.on('uncaughtException', (e) => { process.stderr.write(`[${tag}] ${e.stack || e}\n`); cleanup('исключение', 1); });

  if (watchStdin) {
    process.stdin.on('end', () => cleanup('EOF stdin', 0));
    process.stdin.on('close', () => cleanup('stdin закрыт', 0));
  }
  if (parentPollMs > 0) {
    const ppid = process.ppid;
    const t = setInterval(() => {
      // родитель умер: ppid сменился (переподвешены к init) или процесс не отвечает
      if (process.ppid !== ppid || !isAlive(ppid)) cleanup('родительский процесс завершился', 0);
    }, parentPollMs);
    t.unref();
  }
  return { child, cleanup };
}
