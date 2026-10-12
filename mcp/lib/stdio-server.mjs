// stdio-server.mjs v1.0 — минимальный MCP-сервер на stdio (JSON-RPC 2.0, по строке на сообщение)
// без зависимостей. Поддерживает tools, MCP roots (рабочая папка сеанса goose) и запросы к клиенту.

import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export function startServer({ name, version = '1.0.0', instructions = '', tools = [], onCall }) {
  let nextId = 1;
  const pending = new Map();
  const state = { roots: [], clientCaps: {} };

  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  const request = (method, params) => {
    const id = `${name}-${nextId++}`;
    send({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => { if (pending.delete(id)) reject(new Error('timeout')); }, 30000).unref();
    });
  };

  async function refreshRoots() {
    if (!state.clientCaps.roots) return;
    try {
      const res = await request('roots/list', {});
      state.roots = (res?.roots || []).map((r) => r.uri).filter((u) => /^file:/.test(u)).map((u) => fileURLToPath(u));
    } catch { /* клиент не ответил — останемся на cwd */ }
  }

  const ctx = {
    state,
    request,
    // Рабочая папка: аргумент инструмента → MCP root от goose → текущий каталог процесса.
    root: (arg) => arg || state.roots[0] || process.cwd(),
    refreshRoots,
  };

  async function handle(msg) {
    if (msg.id !== undefined && msg.method === undefined) {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || 'ошибка клиента')); else p.resolve(msg.result);
      }
      return;
    }
    const { id, method, params } = msg;
    const reply = (result) => send({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
    switch (method) {
      case 'initialize':
        state.clientCaps = params?.capabilities || {};
        reply({ protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} },
          serverInfo: { name, version }, instructions });
        return;
      case 'notifications/initialized':
      case 'notifications/roots/list_changed':
        refreshRoots();
        return;
      case 'ping': reply({}); return;
      case 'tools/list': reply({ tools }); return;
      case 'tools/call': {
        const tool = tools.find((t) => t.name === params?.name);
        if (!tool) return fail(-32602, `Неизвестный инструмент: ${params?.name}`);
        if (!state.roots.length) await refreshRoots();
        try {
          const text = await onCall(params.name, params.arguments || {}, ctx);
          reply({ content: [{ type: 'text', text: String(text) }], isError: false });
        } catch (e) {
          reply({ content: [{ type: 'text', text: `Ошибка: ${e.message}` }], isError: true });
        }
        return;
      }
      default:
        if (id !== undefined) fail(-32601, `Метод не поддерживается: ${method}`);
    }
  }

  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { process.stderr.write(`[${name}] не JSON\n`); return; }
    handle(msg).catch((e) => process.stderr.write(`[${name}] ${e.stack || e}\n`));
  });
  rl.on('close', () => process.exit(0));
  return ctx;
}
