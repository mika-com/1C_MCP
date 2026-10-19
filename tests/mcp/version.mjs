#!/usr/bin/env node
// Версия 1C-Agent в MCP: instructions, serverInfo, index_status и отметка плагина bsl-autocheck.
//   node tests/mcp/version.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { agentVersion } from '../../mcp/lib/agent-meta.mjs';
import { createProxy } from '../../mcp/bsl-ls.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const search = join(repo, 'mcp', 'code-search.mjs');
const help = join(repo, 'mcp', 'help.mjs');
const ver = agentVersion();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0; let failed = 0;
const ok = (cond, name, extra) => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? '\n       ' + String(extra).slice(0, 400) : ''}`); }
};

function session(script, cwd, env) {
  const p = spawn(process.execPath, [script], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  createInterface({ input: p.stdout }).on('line', (l) => { try { lines.push(JSON.parse(l)); } catch { /* не JSON */ } });
  const send = (m) => p.stdin.write(JSON.stringify(m) + '\n');
  const wait = async (id, ms = 15000) => {
    const t = Date.now() + ms;
    while (Date.now() < t) {
      const m = lines.find((x) => x.id === id);
      if (m) return m;
      await sleep(40);
    }
    return null;
  };
  return { p, send, wait, err: () => err, close: () => { p.stdin.end(); return new Promise((r) => p.on('close', r)); } };
}

const root = mkdtempSync(join(tmpdir(), '1c-ver-'));
writeFileSync(join(root, 'Configuration.xml'), '<MetaDataObject version="2.17"/>\n');
const state = join(root, 'autocheck.json');
const baseEnv = { ...process.env, BSL_AUTOCHECK_STATE: state, SEMANTIC_SEARCH: '0' };

console.log('1c-search:');
{
  const s = session(search, root, baseEnv);
  s.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
  const init = await s.wait(1);
  ok(init?.result?.serverInfo?.version === ver && init.result.instructions.includes(`Версия 1C-Agent: ${ver}`),
    'initialize: serverInfo.version и instructions', init?.result?.instructions);
  s.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'index_status', arguments: {} } });
  const st = await s.wait(2);
  const text = st?.result?.content?.[0]?.text || '';
  ok(text.startsWith(`1C-Agent ${ver}`) && /Плагин bsl-autocheck: не активен/.test(text), 'index_status: версия и плагин не активен', text);
  await s.close();
}
writeFileSync(state, JSON.stringify({ version: ver, at: '2026-10-19T00:00:00.000Z', pid: 1, root }));
{
  const s = session(search, root, baseEnv);
  s.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {} } });
  await s.wait(1);
  s.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'index_status', arguments: {} } });
  const text = (await s.wait(2))?.result?.content?.[0]?.text || '';
  ok(new RegExp(`Плагин bsl-autocheck: активен \\(версия ${ver.replace(/\./g, '\\.')}`).test(text), 'index_status: плагин активен', text);
  await s.close();
}
writeFileSync(state, JSON.stringify({ version: '0.0.1', at: '2020-01-01T00:00:00.000Z' }));
{
  const s = session(search, root, baseEnv);
  s.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {} } });
  await s.wait(1);
  s.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'index_status', arguments: {} } });
  const text = (await s.wait(2))?.result?.content?.[0]?.text || '';
  ok(/отмечен старой версией 0\.0\.1/.test(text) && text.includes(ver), 'index_status: устаревшая отметка плагина', text);
  await s.close();
}

console.log('1c-help:');
{
  const s = session(help, root, baseEnv);
  s.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {} } });
  const init = await s.wait(1);
  ok(init?.result?.serverInfo?.name === '1c-help' && init.result.serverInfo.version === ver
    && init.result.instructions.includes(`Версия 1C-Agent: ${ver}`), 'initialize 1c-help несёт версию агента', init?.result?.serverInfo);
  await s.close();
}

console.log('прокси 1c-bsl:');
{
  const out = [];
  const proxy = createProxy({ toChild: () => {}, toClient: (l) => out.push(JSON.parse(l)), timeoutMs: 1000, roots: [] });
  proxy.fromClient(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'initialize', params: {} }));
  proxy.fromChild(JSON.stringify({
    jsonrpc: '2.0', id: 7,
    result: { protocolVersion: '2025-06-18', serverInfo: { name: 'bsl', version: '0.24.0' }, instructions: 'child hint' },
  }));
  const r = out[0]?.result;
  ok(r?.serverInfo?.version === '0.24.0' && r.serverInfo.agent === `1C-Agent ${ver}`
    && r.instructions.startsWith('child hint') && r.instructions.includes(`Версия 1C-Agent: ${ver}`),
  'initialize BSL LS: версия сервера сохранена, версия агента дописана', JSON.stringify(r));
  ok(readFileSync(join(repo, 'VERSION'), 'utf8').trim().split(/\s+/)[0] === ver, 'VERSION — источник agentVersion()');
}

rmSync(root, { recursive: true, force: true });
console.log(`\nversion: ${passed} ok, ${failed} fail`);
process.exit(failed ? 1 : 0);
