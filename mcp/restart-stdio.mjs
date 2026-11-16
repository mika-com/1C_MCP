#!/usr/bin/env node
// restart-stdio.mjs — обёртка MCP-сервера на stdio. Дочерний процесс говорит JSON-RPC.
// Если он падает (код 134 — нехватка памяти у Node), незакрытым запросам уходит ошибка,
// процесс поднимается снова, а сама обёртка не завершается: OpenCode иначе вычёркивает
// сервер из каталога до конца сеанса. Дочернему процессу даётся отдельная куча
// (SEARCH_MAX_OLD_SPACE_MB, по умолчанию 4096).
//
//   node restart-stdio.mjs <script.mjs> [аргументы...]

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const script = process.argv[2];
const extra = process.argv.slice(3);
if (!script) {
  process.stderr.write('Использование: node restart-stdio.mjs <script.mjs> [аргументы]\n');
  process.exit(2);
}

const heap = String(process.env.SEARCH_MAX_OLD_SPACE_MB || '8192').replace(/[^\d]/g, '') || '8192';
const nodeArgs = [`--max-old-space-size=${heap}`, script, ...extra];

let child = null;
let stdinClosed = false;
let spawning = false;
const pending = new Map(); // id → исходный id запроса клиента
const queue = [];
const crashes = [];

function childAlive() {
  return child && child.exitCode == null && !child.killed && child.stdin?.writable;
}

function flushQueue() {
  if (!childAlive()) return;
  while (queue.length && childAlive()) child.stdin.write(queue.shift());
}

function failPending(why) {
  for (const id of pending.values()) {
    const body = {
      jsonrpc: '2.0', id,
      error: {
        code: -32000,
        message: `Сервер поиска перезапущен после падения (${why}). Повтори вызов один раз. ` +
          'Для search_code передай path_filter — без него читается вся выгрузка и процессу снова может не хватить памяти. ' +
          'Не переходи на поиск по файлам выгрузки через shell.',
      },
    };
    process.stdout.write(JSON.stringify(body) + '\n');
  }
  pending.clear();
}

function spawnChild() {
  if (stdinClosed || spawning) return;
  spawning = true;
  child = spawn(process.execPath, nodeArgs, { stdio: ['pipe', 'pipe', 'inherit'] });
  spawning = false;
  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    process.stdout.write(line + '\n');
    try {
      const msg = JSON.parse(line);
      if (msg && msg.id !== undefined && msg.method === undefined) pending.delete(msg.id);
    } catch { /* уже переслали как есть */ }
  });
  child.on('exit', (code, signal) => {
    rl.close();
    if (stdinClosed) { process.exit(code ?? 0); return; }
    const now = Date.now();
    while (crashes.length && now - crashes[0] > 60000) crashes.shift();
    crashes.push(now);
    failPending(signal ? `сигнал ${signal}` : `код ${code}`);
    if (crashes.length > 5) {
      process.stderr.write('[restart-stdio] больше 5 падений за минуту, сервер остановлен\n');
      process.exit(code || 1);
      return;
    }
    setTimeout(spawnChild, 50);
  });
  flushQueue();
}

function writeLine(line) {
  try {
    const msg = JSON.parse(line);
    if (msg && msg.id !== undefined && msg.method) pending.set(msg.id, msg.id);
  } catch { /* не запрос — просто пересылаем */ }
  if (childAlive()) child.stdin.write(line + '\n');
  else if (queue.length < 20) queue.push(line + '\n');
}

const input = createInterface({ input: process.stdin });
input.on('line', writeLine);
input.on('close', () => {
  stdinClosed = true;
  if (childAlive()) child.kill();
  else process.exit(0);
});

spawnChild();
