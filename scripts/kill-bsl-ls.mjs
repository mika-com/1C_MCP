#!/usr/bin/env node
// kill-bsl-ls.mjs — завершить зависшие процессы BSL Language Server (1c-bsl, bsl-lsp) ТЕКУЩЕГО пользователя
// в ТЕКУЩЕМ сеансе. Процессы других пользователей (RDP) не трогаются, даже если запущено от администратора.
//   node scripts/kill-bsl-ls.mjs              — завершить свои
//   node scripts/kill-bsl-ls.mjs --dry-run    — только показать
//   node scripts/kill-bsl-ls.mjs --all-users  — все пользователи (только администратор / root, явно)
// Windows: taskkill /T /F по каждому PID. Linux/macOS: SIGKILL.
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { lockDir } from '../mcp/bsl-ls.mjs';

const IS_WIN = process.platform === 'win32';
export const PATTERN = /bsl-language-server|[\\/]mcp[\\/]bsl-ls\.mjs|[\\/]lsp[\\/]bsl-lsp\.mjs/i;

function isAdmin() {
  if (!IS_WIN) return process.getuid() === 0;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'],
  { encoding: 'utf8', windowsHide: true });
  return /true/i.test(r.stdout || '');
}

// Список процессов с владельцем: { pid, mb, cmd, own }
export function listProcesses() {
  if (IS_WIN) {
    const ps = '$me=[Security.Principal.WindowsIdentity]::GetCurrent().Name.ToLowerInvariant(); ' +
      '$s=[Diagnostics.Process]::GetCurrentProcess().SessionId; ' +
      "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'bsl-language-server|bsl-ls\\.mjs|bsl-lsp\\.mjs' } | ForEach-Object { " +
      '$o = Invoke-CimMethod -InputObject $_ -MethodName GetOwner -ErrorAction SilentlyContinue; ' +
      '$n = if ($o.User) { "$($o.Domain)\\$($o.User)".ToLowerInvariant() } else { "" }; ' +
      '$own = ($n -eq $me -and $_.SessionId -eq $s); ' +
      '"$($_.ProcessId)`t$([math]::Round($_.WorkingSetSize/1MB))`t$own`t$($_.CommandLine)" }';
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    return (r.stdout || '').split(/\r?\n/).map((l) => l.split('\t')).filter((a) => a.length >= 4)
      .map(([pid, mb, own, ...cmd]) => ({ pid: Number(pid), mb: Number(mb), own: /true/i.test(own), cmd: cmd.join('\t') }));
  }
  const uid = process.getuid();
  const r = spawnSync('ps', ['-eo', 'pid=,uid=,rss=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return (r.stdout || '').split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .map(([, pid, u, rss, cmd]) => ({ pid: Number(pid), mb: Math.round(Number(rss) / 1024), own: Number(u) === uid, cmd }));
}

export function selectTargets(list, { allUsers = false, selfPid = process.pid } = {}) {
  const match = list.filter((p) => p.pid !== selfPid && PATTERN.test(p.cmd) && !/kill-bsl-ls/.test(p.cmd));
  return { targets: match.filter((p) => allUsers || p.own), skipped: match.filter((p) => !allUsers && !p.own).length };
}

function main() {
  const dry = process.argv.includes('--dry-run');
  const allUsers = process.argv.includes('--all-users');
  if (allUsers && !isAdmin()) {
    console.error('--all-users требует прав администратора (root). Без флага завершаются только ваши процессы.');
    return 1;
  }
  const { targets, skipped } = selectTargets(listProcesses(), { allUsers });
  if (!targets.length) console.log('Ваших процессов BSL LS не найдено.');
  else {
    console.log(`Найдено процессов BSL LS: ${targets.length}, память ~${targets.reduce((s, p) => s + (p.mb || 0), 0)} МБ`);
    for (const p of targets) console.log(`  ${p.pid}\t${p.mb} МБ\t${p.cmd.slice(0, 140)}`);
    if (!dry) {
      for (const p of targets) {
        if (IS_WIN) spawnSync('taskkill', ['/T', '/F', '/PID', String(p.pid)], { stdio: 'ignore', windowsHide: true });
        else { try { process.kill(p.pid, 'SIGKILL'); } catch { /* уже завершён */ } }
      }
      console.log('Завершены.');
    }
  }
  if (skipped) console.log(`Процессов других пользователей/сеансов: ${skipped} — не тронуты.`);
  if (!dry) rmSync(lockDir(), { recursive: true, force: true });
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) process.exitCode = main();
