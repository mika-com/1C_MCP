#!/usr/bin/env node
// bsl-ls.mjs — MCP-сервер 1c-bsl: прокси к `bsl-language-server mcp` для OpenCode.
// Инструменты BSL LS: analyze_file, document_symbols, definition, find_references, call_hierarchy, hover,
// type_info, global_member_info, register_workspace_folder и др.
//
// Защита от зависаний на больших конфигурациях (тысячи .bsl):
//   * Область индексации. BSL LS индексирует каждую рабочую папку целиком (на 6–7 тыс. модулей — 15–30 мин).
//     По умолчанию прокси НЕ отдаёт ему корень проекта (запрос roots/list отвечается пустым списком), и папку
//     нужно зарегистрировать явно — `register_workspace_folder` с узким каталогом (расширение, обработка).
//     BSL_LS_ROOT=<каталог>[;<каталог>] — отдать эти папки сразу; BSL_LS_ROOT=auto — старое поведение (корни клиента).
//   * Таймаут вызова. Если BSL LS не ответил за BSL_LS_TIMEOUT_MS (по умолчанию 90000), клиент сразу получает
//     понятную ошибку, а поздний ответ отбрасывается. Агент не висит.
//   * Дерево процессов. При EOF stdin, SIGTERM/SIGINT, смерти родителя или выходе убивается всё дерево
//     BSL LS (Windows — taskkill /T /F). Один экземпляр на каталог проекта: предыдущий (или осиротевший) гасится
//     (BSL_LS_SINGLETON=0 — отключить).
//   * Память JVM: BSL_LS_XMX (например 4g) — передаётся как -Xmx.
// BSL_LS_MCP=off или BSL LS не установлен — маленький сервер-заглушка с подсказкой.

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve, basename } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { startServer } from './lib/stdio-server.mjs';
import { agentVersion, instructionSuffix, agentBanner } from './lib/agent-meta.mjs';
import { spawnSupervised, killTree, isAlive, processCommandLine, isOwnProcess } from './lib/proc-tree.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;

async function loadLocator() {
  const p = [join(here, '..', 'skills', 'bsl-check', 'scripts', 'bsl-ls.mjs'),
    join(here, '..', 'own-skills', 'bsl-check', 'scripts', 'bsl-ls.mjs')].find((x) => existsSync(x));
  return p ? import(pathToFileURL(p).href) : null;
}

// ---- один экземпляр на каталог проекта ----
// Каталог lock-файлов — у каждого пользователя свой: %LOCALAPPDATA%\1c-opencode\bsl-ls (Windows),
// $XDG_RUNTIME_DIR или /tmp/1c-bsl-ls-<uid> (POSIX). Ключ — пользователь + корень проекта, поэтому один и тот же
// проект, открытый двумя пользователями (RDP), не конфликтует.
export function lockDir() {
  if (env.BSL_LS_LOCK_DIR) return env.BSL_LS_LOCK_DIR;
  if (process.platform === 'win32') return join(env.LOCALAPPDATA || tmpdir(), '1c-opencode', 'bsl-ls');
  if (env.XDG_RUNTIME_DIR) return join(env.XDG_RUNTIME_DIR, '1c-bsl-ls');
  return join(tmpdir(), `1c-bsl-ls-${process.getuid()}`);
}

export function currentUserName() {
  try { return userInfo().username.toLowerCase(); } catch { return (env.USERNAME || env.USER || 'user').toLowerCase(); }
}

export function lockPath(root, user = currentUserName()) {
  const h = createHash('sha1').update(`${user}\n${resolve(root).toLowerCase()}`).digest('hex').slice(0, 12);
  return join(lockDir(), `${h}.json`);
}

export function takeOverLock(root, { log = () => {} } = {}) {
  const file = lockPath(root);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  if (existsSync(file)) {
    try {
      const old = JSON.parse(readFileSync(file, 'utf8'));
      // Гасим, только если процесс жив, это наш прокси / BSL LS (PID мог достаться другому) и он принадлежит
      // ТЕКУЩЕМУ пользователю в ТЕКУЩЕМ сеансе — процессы других пользователей RDP не трогаем никогда.
      const ours = (pid, re) => isAlive(pid) && re.test(processCommandLine(pid)) && isOwnProcess(pid);
      if (old.pid && old.pid !== process.pid && ours(old.pid, /bsl-ls\.mjs/i)) {
        log(`гашу предыдущий экземпляр (pid ${old.pid})`);
        killTree(old.pid, { graceMs: 3000 });   // даём ему погасить своё дерево, затем добиваем
      }
      if (old.childPid && ours(old.childPid, /bsl-language-server|bsl-ls|java/i)) {
        log(`гашу осиротевший BSL LS (pid ${old.childPid})`);
        killTree(old.childPid);
      }
    } catch { /* битый lock — перезапишем */ }
  }
  return file;
}

function writeLock(file, data) {
  try { writeFileSync(file, JSON.stringify({ ...data, root: process.cwd(), started: new Date().toISOString() })); } catch { /* */ }
}

function releaseLock(file) {
  try {
    const cur = JSON.parse(readFileSync(file, 'utf8'));
    if (cur.pid === process.pid) rmSync(file, { force: true });
  } catch { /* */ }
}

// ---- область индексации ----
export function configuredRoots(value = env.BSL_LS_ROOT) {
  if (!value) return [];
  if (value.trim().toLowerCase() === 'auto') return null;   // null — пропускать запрос к клиенту
  return value.split(/[;\n]/).map((s) => s.trim()).filter(Boolean).map((p) => resolve(p))
    .filter((p) => existsSync(p)).map((p) => ({ uri: pathToFileURL(p).href, name: basename(p) }));
}

// ---- прокси JSON-RPC (по строке на сообщение) с таймаутами ----
export function createProxy({ toChild, toClient, timeoutMs, roots, log = () => {} }) {
  const pending = new Map();   // id запроса клиента → { timer, method, tool }
  const dropped = new Set();   // id, по которым клиент уже получил ошибку таймаута

  const key = (id) => JSON.stringify(id);

  function fromClient(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { toChild(line); return; }
    if (msg && msg.id !== undefined && msg.method) {
      const tool = msg.method === 'tools/call' ? msg.params?.name : undefined;
      const t = setTimeout(() => {
        if (!pending.delete(key(msg.id))) return;
        dropped.add(key(msg.id));
        const sec = Math.round(timeoutMs / 1000);
        const text = `BSL LS не ответил за ${sec} с (${tool || msg.method}). Скорее всего идёт индексация большой ` +
          'рабочей папки. Не ждите и не повторяйте в цикле: проверьте код навыком bsl-check с узким -Path ' +
          '(каталог расширения/объекта), или зарегистрируйте узкую папку register_workspace_folder и повторите позже. ' +
          'Таймаут — переменная BSL_LS_TIMEOUT_MS.';
        log(`таймаут ${tool || msg.method} (id ${key(msg.id)})`);
        if (msg.method === 'tools/call') {
          toClient(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }], isError: true } }));
        } else {
          toClient(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32001, message: text } }));
        }
      }, timeoutMs);
      t.unref?.();
      pending.set(key(msg.id), { timer: t, method: msg.method });
    }
    toChild(line);
  }

  function fromChild(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { toClient(line); return; }
    // запрос сервера к клиенту за корнями — отвечаем сами, если область задана не auto
    if (msg && msg.method === 'roots/list' && msg.id !== undefined && roots !== null) {
      log(`roots/list → ${roots.length ? roots.map((r) => r.uri).join(', ') : 'пусто'}`);
      toChild(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { roots } }));
      return;
    }
    if (msg && msg.id !== undefined && !msg.method) {
      const k = key(msg.id);
      if (dropped.delete(k)) { log(`поздний ответ id ${k} отброшен`); return; }
      const p = pending.get(k);
      if (p) { clearTimeout(p.timer); pending.delete(k); }
      if (p?.method === 'initialize' && msg.result && typeof msg.result === 'object') {
        const prev = typeof msg.result.instructions === 'string' ? msg.result.instructions : '';
        const note = instructionSuffix().trim();
        msg.result.instructions = prev ? `${prev} ${note}` : note;
        msg.result.serverInfo = { ...(msg.result.serverInfo && typeof msg.result.serverInfo === 'object' ? msg.result.serverInfo : {}), agent: agentBanner() };
        toClient(JSON.stringify(msg));
        return;
      }
    }
    toClient(line);
  }

  return { fromClient, fromChild, pending, dropped };
}

async function main() {
  const loc = await loadLocator();
  const found = env.BSL_LS_MCP === 'off' || !loc ? null : loc.findBslLs();
  if (!found) {
    const off = env.BSL_LS_MCP === 'off';
    const stubText = off ? '' : 'BSL Language Server не установлен: проверка и навигация по BSL-коду недоступны.';
    startServer({
      name: 'bsl-ls-stub',
      version: agentVersion(),
      instructions: `${stubText}${instructionSuffix()}`.trim(),
      tools: [{
        name: 'bsl_ls_status',
        description: 'Состояние BSL Language Server (проверка BSL-кода): как установить, если он не установлен.',
        inputSchema: { type: 'object', properties: {} },
      }],
      onCall: () => (off ? 'BSL LS отключён переменной BSL_LS_MCP=off.' : (loc?.INSTALL_HINT || 'BSL LS не найден')),
    });
    return;
  }

  const log = (m) => process.stderr.write(`[1c-bsl] ${m}\n`);
  const lock = env.BSL_LS_SINGLETON === '0' ? null : takeOverLock(process.cwd(), { log });
  const timeoutMs = Math.max(5000, Number(env.BSL_LS_TIMEOUT_MS) || 90000);
  const roots = configuredRoots();

  const { child } = spawnSupervised(found.cmd, [...found.args, 'mcp'], {
    tag: '1c-bsl', stdio: ['pipe', 'pipe', 'inherit'], env: loc.bslEnv(), watchStdin: true,
    onCleanup: () => { if (lock) releaseLock(lock); },
  });
  if (lock) writeLock(lock, { pid: process.pid, childPid: child.pid });

  const proxy = createProxy({
    toChild: (l) => { if (child.stdin.writable) child.stdin.write(l + '\n'); },
    toClient: (l) => process.stdout.write(l + '\n'),
    timeoutMs, roots, log,
  });
  createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (l) => { if (l.trim()) proxy.fromClient(l); });
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (l) => { if (l.trim()) proxy.fromChild(l); });
  child.stdin.on('error', () => { /* ребёнок умер — обработает exit */ });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
