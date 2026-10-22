#!/usr/bin/env node
// Обёртка MCP переживает падение дочернего процесса и отвечает на незакрытый запрос.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const wrapper = join(here, '..', '..', 'mcp', 'restart-stdio.mjs');
const dir = mkdtempSync(join(tmpdir(), 'restart-stdio-'));
const counter = join(dir, 'n.txt');
const fake = join(dir, 'fake.mjs');
writeFileSync(counter, '0');
writeFileSync(fake, `
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
const counter = process.argv[2];
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined || !msg.method) return;
  if (msg.method === 'tools/call') {
    const n = Number(readFileSync(counter, 'utf8') || '0');
    writeFileSync(counter, String(n + 1));
    if (n === 0) process.exit(134);
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true } }) + '\\n');
});
`);

const child = spawn(process.execPath, [wrapper, fake, counter], { stdio: ['pipe', 'pipe', 'inherit'] });
const rl = createInterface({ input: child.stdout });
const got = [];
rl.on('line', (line) => { try { got.push(JSON.parse(line)); } catch { /* */ } });

const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_code' } });

const wait = (pred, ms) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const tick = () => {
    if (pred()) return resolve();
    if (Date.now() - t0 > ms) return reject(new Error('timeout ' + JSON.stringify(got)));
    setTimeout(tick, 30);
  };
  tick();
});

let failed = 0;
try {
  await wait(() => got.some((m) => m.id === 2 && m.error), 5000);
  const err = got.find((m) => m.id === 2);
  if (!/перезапущен/.test(err.error.message) || !/path_filter/.test(err.error.message)) {
    failed++; console.log('  FAIL текст ошибки', err.error.message);
  } else console.log('  ok   падение кода 134 → ошибка запроса, процесс жив');
  if (!got.some((m) => m.id === 1 && m.result)) {
    failed++; console.log('  FAIL initialize не ответил');
  } else console.log('  ok   initialize до падения');
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_code' } });
  await wait(() => got.some((m) => m.id === 3 && m.result && m.result.ok), 5000);
  console.log('  ok   следующий вызов идёт в поднятый заново сервер');
} catch (e) {
  failed++; console.log('  FAIL', e.message);
}
child.kill();
rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
