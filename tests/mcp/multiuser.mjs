#!/usr/bin/env node
// Тесты многопользовательской безопасности (несколько пользователей RDP на одном сервере):
// свои/чужие процессы, lock-файлы по пользователю, отбор целей в kill-bsl-ls.
//   node tests/mcp/multiuser.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { isOwnProcess, currentOwner, isAlive } from '../../mcp/lib/proc-tree.mjs';
import { lockPath, lockDir, takeOverLock } from '../../mcp/bsl-ls.mjs';
import { selectTargets } from '../../scripts/kill-bsl-ls.mjs';

let passed = 0; let failed = 0;
const ok = (c, n) => { if (c) { passed++; console.log(`  ok   ${n}`); } else { failed++; console.log(`  FAIL ${n}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
console.log('multi-user:');

// владелец процесса
ok(isOwnProcess(process.pid), 'свой процесс распознан как свой');
if (process.platform !== 'win32' && process.getuid() !== 0) ok(!isOwnProcess(1), 'процесс другого пользователя (PID 1, root) — чужой');
const me = currentOwner();
const fakeMe = process.platform === 'win32' ? { user: 'dom\\ivan', sessionId: 3 } : { uid: 1000 };
const owner = (o) => () => o;
if (process.platform === 'win32') {
  ok(!isOwnProcess(123, { owner: owner({ user: 'dom\\petr', sessionId: 3 }), me: fakeMe }), 'другой пользователь — чужой');
  ok(!isOwnProcess(123, { owner: owner({ user: 'dom\\ivan', sessionId: 5 }), me: fakeMe }), 'тот же пользователь в другом сеансе — чужой');
  ok(isOwnProcess(123, { owner: owner({ user: 'dom\\ivan', sessionId: 3 }), me: fakeMe }), 'тот же пользователь и сеанс — свой');
} else {
  ok(!isOwnProcess(123, { owner: owner({ uid: 1001 }), me: fakeMe }), 'другой uid — чужой');
  ok(isOwnProcess(123, { owner: owner({ uid: 1000 }), me: fakeMe }), 'тот же uid — свой');
}
ok(!isOwnProcess(123, { owner: () => null, me }), 'нет данных о владельце — не трогаем');

// lock-файлы
const root = '/srv/1c/project';
ok(lockPath(root, 'ivan') !== lockPath(root, 'petr'), 'один проект у двух пользователей — разные lock-файлы');
ok(lockPath(root, 'ivan') === lockPath(root, 'ivan'), 'ключ стабилен');
delete process.env.BSL_LS_LOCK_DIR;
const ld = lockDir();
ok(process.platform === 'win32' ? /1c-opencode/.test(ld) : new RegExp(`${process.getuid()}|XDG|1c-bsl-ls`).test(ld), `каталог lock-файлов пользовательский (${ld})`);

// singleton не гасит чужие / не наши процессы
{
  const dir = mkdtempSync(join(tmpdir(), 'mu-'));
  process.env.BSL_LS_LOCK_DIR = join(dir, 'locks');
  const victim = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });  // свой, но не BSL LS
  await sleep(300);
  const lf = lockPath(dir);
  mkdirSync(dirname(lf), { recursive: true });
  writeFileSync(lf, JSON.stringify({ pid: victim.pid, childPid: victim.pid }));
  takeOverLock(dir);
  await sleep(500);
  ok(isAlive(victim.pid), 'lock указывает на постороннюю программу (PID переиспользован) — не тронута');
  victim.kill('SIGKILL');
  if (process.platform !== 'win32' && process.getuid() !== 0) {
    writeFileSync(lf, JSON.stringify({ pid: 1, childPid: 1 }));
    takeOverLock(dir);
    ok(isAlive(1), 'lock указывает на процесс другого пользователя — не тронут');
  }
}

// отбор целей kill-bsl-ls
{
  const list = [
    { pid: 10, own: true, cmd: 'C:\\Users\\ivan\\.config\\opencode\\tools\\bsl-language-server\\bsl-language-server.exe mcp' },
    { pid: 11, own: false, cmd: 'C:\\Users\\petr\\.config\\opencode\\tools\\bsl-language-server\\bsl-language-server.exe mcp' },
    { pid: 12, own: true, cmd: 'node C:\\ProgramData\\1c-opencode\\repo\\mcp\\bsl-ls.mjs' },
    { pid: 13, own: true, cmd: 'node something-else.mjs' },
    { pid: 14, own: false, cmd: 'java -jar bsl-language-server.jar lsp' },
  ];
  const a = selectTargets(list, { selfPid: 1 });
  ok(a.targets.map((p) => p.pid).join() === '10,12' && a.skipped === 2, 'по умолчанию — только свои BSL LS, чужие пропущены');
  const b = selectTargets(list, { allUsers: true, selfPid: 1 });
  ok(b.targets.map((p) => p.pid).join() === '10,11,12,14', '--all-users — все BSL LS (только с правами администратора)');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
