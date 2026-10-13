#!/usr/bin/env node
// Поддельный BSL LS для тестов: порождает «внука» (как bsl-language-server.exe → java), пишет PID-ы в файл,
// отвечает на MCP по stdio. tools/call slow — отвечает через 8 с; при initialize спрашивает у клиента roots/list.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const grand = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' });
appendFileSync(process.env.FAKE_PIDS, `${process.pid}\n${grand.pid}\n`);
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: 'srv-1', method: 'roots/list', params: {} });
    send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake' } } });
  } else if (m.id === 'srv-1') {
    appendFileSync(process.env.FAKE_PIDS, `roots:${JSON.stringify(m.result.roots)}\n`);
  } else if (m.method === 'tools/call') {
    const delay = m.params.name === 'slow' ? 8000 : 10;
    setTimeout(() => send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `ok ${m.params.name}` }] } }), delay);
  }
});
// stdin закрыт — НЕ выходим (как зависший BSL LS): дерево должен погасить прокси
setInterval(() => {}, 1000);
