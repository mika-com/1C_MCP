#!/usr/bin/env node
// kill-bsl-ls.mjs — найти и завершить зависшие процессы BSL Language Server и их прокси (1c-bsl, bsl-lsp).
//   node scripts/kill-bsl-ls.mjs           — завершить
//   node scripts/kill-bsl-ls.mjs --dry-run — только показать
// Windows: taskkill /T /F по каждому найденному PID. Linux/macOS: SIGKILL.
// Чистит и lock-файлы 1c-bsl (%TEMP%\1c-bsl-ls). Запущенный OpenCode пересоздаст 1c-bsl при следующем вызове.
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const IS_WIN = process.platform === 'win32';
const dry = process.argv.includes('--dry-run');
const PATTERN = /bsl-language-server|[\\/]mcp[\\/]bsl-ls\.mjs|[\\/]lsp[\\/]bsl-lsp\.mjs/i;

function list() {
  if (IS_WIN) {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | ForEach-Object { "$($_.ProcessId)`t$([math]::Round($_.WorkingSetSize/1MB))`t$($_.CommandLine)" }'],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    return (r.stdout || '').split(/\r?\n/).map((l) => l.split('\t')).filter((a) => a.length >= 3)
      .map(([pid, mb, ...cmd]) => ({ pid: Number(pid), mb: Number(mb), cmd: cmd.join('\t') }));
  }
  const r = spawnSync('ps', ['-eo', 'pid=,rss=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return (r.stdout || '').split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .map(([, pid, rss, cmd]) => ({ pid: Number(pid), mb: Math.round(Number(rss) / 1024), cmd }));
}

const found = list().filter((p) => p.pid !== process.pid && PATTERN.test(p.cmd) && !/kill-bsl-ls/.test(p.cmd));
if (!found.length) {
  console.log('Процессов BSL LS не найдено.');
} else {
  const total = found.reduce((s, p) => s + (p.mb || 0), 0);
  console.log(`Найдено процессов BSL LS: ${found.length}, память ~${total} МБ`);
  for (const p of found) console.log(`  ${p.pid}\t${p.mb} МБ\t${p.cmd.slice(0, 140)}`);
  if (!dry) {
    for (const p of found) {
      if (IS_WIN) spawnSync('taskkill', ['/T', '/F', '/PID', String(p.pid)], { stdio: 'ignore', windowsHide: true });
      else { try { process.kill(p.pid, 'SIGKILL'); } catch { /* уже завершён */ } }
    }
    console.log('Завершены.');
  }
}
if (!dry) rmSync(join(process.env.BSL_LS_LOCK_DIR || join(tmpdir(), '1c-bsl-ls')), { recursive: true, force: true });
