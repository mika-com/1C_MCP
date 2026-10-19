// bsl-autocheck.mjs v1.0 — плагин OpenCode v2: проверка BSL после каждой правки.
//
// После инструментов edit / write / patch, изменивших файлы .bsl / .os, запускает BSL Language Server
// (`analyze`) только по этим файлам и дописывает к результату инструмента краткий список ошибок и
// предупреждений (сначала ошибки, не больше N строк) — модель видит их сразу и исправляет.
//
// Как устроено:
// - Правки, пришедшие почти одновременно (параллельные вызовы, patch по нескольким файлам), собираются
//   в одну пачку (debounce) — один запуск JVM на пачку; каждый результат получает замечания своего файла.
// - Файлы копируются во временный каталог пользователя (%TEMP% / $TMPDIR) с сохранением пути внутри
//   проекта (тип модуля BSL LS определяет по пути); .bsl-language-server.json проекта передаётся через -c.
// - Таймаут на пачку (30 с по умолчанию): по нему дерево процессов BSL LS гасится (proc-tree.killTree).
//   Процессы — только свои; общих lock-файлов нет, поэтому несколько пользователей RDP друг другу не мешают.
// - Нет BSL LS — одна подсказка за сеанс OpenCode, дальше молча.
//
// Настройки (переменные среды важнее .v8-project.json, тот — важнее options плагина):
//   BSL_AUTOCHECK=0                    выключить          | .v8-project.json: "bslAutocheck": { "enabled": false }
//   BSL_AUTOCHECK_SEVERITY=Error       порог (Error|Warning|Information|Hint, по умолчанию Warning) | "severity"
//   BSL_AUTOCHECK_TIMEOUT_MS=30000     таймаут пачки, мс                                           | "timeoutMs"
//   BSL_AUTOCHECK_LIMIT=20             сколько строк замечаний показывать                          | "limit"
//   BSL_AUTOCHECK_MAX_KB=1024          файлы больше — не проверять                                 | "maxKb"
//   BSL_AUTOCHECK_DEBOUNCE_MS=300      окно сбора пачки, мс                                        | "debounceMs"
// Перед загрузкой в базу всё равно проверяй каталог целиком навыком bsl-check.

import { spawn } from 'node:child_process';
import { existsSync, statSync, readFileSync, mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, dirname, isAbsolute, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBslLs, bslEnv } from '../own-skills/bsl-check/scripts/bsl-ls.mjs';
import { killTree } from '../mcp/lib/proc-tree.mjs';
import { writeAutocheckState } from '../mcp/lib/agent-meta.mjs';

const IS_WIN = process.platform === 'win32';
export const EDIT_TOOLS = new Set(['edit', 'write', 'patch', 'apply_patch', 'multiedit']);
export const BSL_EXT = /\.(bsl|os)$/i;
const LEVELS = ['Error', 'Warning', 'Information', 'Hint'];
const LEVEL_RU = { Error: 'ошибка', Warning: 'предупреждение', Information: 'замечание', Hint: 'подсказка' };
const TAG = '[bsl-autocheck]';
const ACTIVE = Symbol.for('1c-agent.bsl-autocheck.active');
export const DEFAULTS = { enabled: true, severity: 'Warning', timeoutMs: 30000, limit: 20, maxKb: 1024, debounceMs: 300 };

// ---------- настройки ----------

function stripJsonComments(text) {
  let out = ''; let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { out += c; if (c === '\\') out += text[++i] ?? ''; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i + 2); if (i < 0) break; i++; continue; }
    out += c;
  }
  return out.replace(/,\s*([}\]])/g, '$1');
}

const level = (v) => LEVELS.find((l) => l.toLowerCase() === String(v || '').toLowerCase());
const num = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v));
const bool = (v) => (v === undefined || v === null || v === '' ? undefined : !/^(0|false|no|off|нет)$/i.test(String(v)));

export function loadSettings(dir, env = process.env, options = {}) {
  let project = {};
  try {
    const f = join(dir, '.v8-project.json');
    if (existsSync(f)) project = JSON.parse(stripJsonComments(readFileSync(f, 'utf8').replace(/^\uFEFF/, ''))).bslAutocheck || {};
    if (project === false) project = { enabled: false };
  } catch { project = {}; }
  const pick = (envKey, key, conv) => [env[envKey], project[key], options?.[key]].map(conv).find((v) => v !== undefined) ?? DEFAULTS[key];
  return {
    enabled: pick('BSL_AUTOCHECK', 'enabled', bool),
    severity: pick('BSL_AUTOCHECK_SEVERITY', 'severity', level),
    timeoutMs: Math.max(1000, pick('BSL_AUTOCHECK_TIMEOUT_MS', 'timeoutMs', num)),
    limit: Math.max(1, pick('BSL_AUTOCHECK_LIMIT', 'limit', num)),
    maxKb: pick('BSL_AUTOCHECK_MAX_KB', 'maxKb', num),
    debounceMs: Math.max(0, pick('BSL_AUTOCHECK_DEBOUNCE_MS', 'debounceMs', num)),
  };
}

// ---------- какие файлы изменены ----------

// Пути из входа и результата инструмента: edit/write — path (filePath в v1), patch — заголовки
// «*** Add File:» / «*** Update File:» / «*** Move to:» и output.applied; удалённые файлы не проверяем.
export function editedFiles(event, baseDir) {
  const found = new Set();
  const add = (p) => { if (typeof p === 'string' && p.trim()) found.add(resolve(baseDir, p.trim())); };
  const input = event.input && typeof event.input === 'object' ? event.input : {};
  add(input.path); add(input.filePath); add(input.file_path);
  const patch = input.patchText || input.patch || input.input;
  if (typeof patch === 'string') {
    for (const m of patch.matchAll(/^\*\*\* (?:Add File|Update File|Move to):\s*(.+?)\s*$/gm)) add(m[1]);
  }
  const out = event.result?.output;
  if (out && typeof out === 'object') {
    if (typeof out.target === 'string' && out.operation === 'write') add(out.target);
    for (const a of Array.isArray(out.applied) ? out.applied : []) if (a && a.type !== 'delete') add(a.target);
  }
  return [...found].filter((f) => BSL_EXT.test(f));
}

// ---------- запуск BSL LS ----------

const running = new Set();   // pid запущенных BSL LS — гасим при выгрузке плагина

function uriToPath(uri) {
  const s = String(uri);
  if (s.startsWith('file:')) { try { return resolve(fileURLToPath(s)); } catch { /* ниже */ } }
  let p = decodeURIComponent(s.replace(/^file:\/\//, ''));
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  return resolve(p);
}

const sameFile = (a, b) => (IS_WIN ? a.toLowerCase() === b.toLowerCase() : a === b);

// Анализ пачки файлов → { status: 'ok', diags: Map<файл, [{lvl, line, col, code, msg}]> } | missing | timeout | failed
export async function bslAnalyze(files, { root = process.cwd(), timeoutMs = DEFAULTS.timeoutMs, find = findBslLs, env } = {}) {
  const found = find();
  if (!found) return { status: 'missing' };
  const work = mkdtempSync(join(tmpdir(), 'bsl-autocheck-'));
  const src = join(work, 'src'); const out = join(work, 'out');
  mkdirSync(out, { recursive: true });
  const back = new Map();
  files.forEach((f, i) => {
    const rel = relative(root, f);
    const parts = !rel || rel.startsWith('..') || isAbsolute(rel) ? ['_external', String(i), basename(f)] : rel.split(/[\\/]+/);
    const dst = join(src, ...parts);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(f, dst);
    back.set(resolve(dst), f);
  });
  const args = [...found.args, 'analyze', '-s', src, '-r', 'json', '-o', out, '-q'];
  const cfg = join(root, '.bsl-language-server.json');
  if (existsSync(cfg)) args.push('-c', cfg);
  try {
    const res = await new Promise((done) => {
      let child;
      try {
        child = spawn(found.cmd, args, { cwd: work, env: env || bslEnv(), stdio: ['ignore', 'ignore', 'pipe'], detached: !IS_WIN, windowsHide: true });
      } catch (e) { done({ status: 'failed', message: e.message }); return; }
      if (child.pid) running.add(child.pid);
      let err = '';
      child.stderr?.on('data', (d) => { err = (err + d).slice(-4000); });
      const timer = setTimeout(() => { killTree(child.pid); done({ status: 'timeout' }); }, timeoutMs);
      child.on('error', (e) => { clearTimeout(timer); running.delete(child.pid); done({ status: 'failed', message: e.message }); });
      child.on('exit', (code) => {
        clearTimeout(timer); running.delete(child.pid);
        done({ status: 'exit', code, err });
      });
    });
    if (res.status !== 'exit') return res;
    const report = join(out, 'bsl-json.json');
    if (!existsSync(report)) {
      const tail = String(res.err || '').split('\n').filter((s) => /error|exception|ошибк/i.test(s)).slice(-2).join(' ').slice(0, 300);
      return { status: 'failed', message: `BSL LS не сформировал отчёт (код ${res.code})${tail ? ': ' + tail : ''}` };
    }
    const data = JSON.parse(readFileSync(report, 'utf8').replace(/^\uFEFF/, ''));
    const diags = new Map(files.map((f) => [f, []]));
    for (const fi of data.fileinfos || []) {
      const copied = uriToPath(fi.path);
      const orig = [...back.entries()].find(([k]) => sameFile(k, copied))?.[1];
      if (!orig) continue;
      for (const d of fi.diagnostics || []) {
        const lvl = LEVELS.includes(d.severity) ? d.severity : 'Information';
        let msg = String(d.message || '').split('\n')[0].replace(/\.?\s*Ожидался один из следующих токенов:.*$/u, ' — синтаксическая ошибка');
        if (msg.length > 200) msg = msg.slice(0, 199) + '…';
        diags.get(orig).push({ lvl, line: (d.range?.start?.line ?? 0) + 1, col: (d.range?.start?.character ?? 0) + 1, code: d.code || '', msg });
      }
    }
    return { status: 'ok', diags };
  } finally {
    try { rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* антивирус держит файл — останется в TEMP */ }
  }
}

export function killRunning() { for (const pid of running) killTree(pid); running.clear(); }

// ---------- UTF-8 в оболочке (Windows PowerShell по умолчанию пишет в OEM/cp866) ----------

// Хук OpenCode v2: ctx.shell.hook('create.before', …). В этой среде живой OpenCode не запускался —
// контракт сверен с документацией v2 (event.command / event.shell / event.env).
export const PS_UTF8_PREAMBLE = '$OutputEncoding = [Console]::InputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; ';

export function applyShellUtf8(event) {
  if (!event || typeof event.command !== 'string' || !event.command) return false;
  const shell = String(event.shell || '');
  if (event.env && typeof event.env === 'object') {
    if (!event.env.PYTHONIOENCODING) event.env.PYTHONIOENCODING = 'utf-8';
    if (!event.env.PYTHONUTF8) event.env.PYTHONUTF8 = '1';
  }
  const shellPs = /powershell|pwsh/i.test(shell);
  const shellCmd = /(^|[\\/])cmd(\.exe)?$/i.test(shell.trim()) || /^cmd(\.exe)?$/i.test(shell.trim());
  if (shellPs) {
    if (/UTF8Encoding \$false/.test(event.command) || /\[Console\]::OutputEncoding\s*=/.test(event.command)) return false;
    event.command = PS_UTF8_PREAMBLE + event.command;
    return true;
  }
  if (shellCmd) {
    if (/chcp\s+65001/i.test(event.command)) return false;
    event.command = 'chcp 65001 >nul & ' + event.command;
    return true;
  }
  return false;
}

async function registerShellUtf8(ctx) {
  const run = (event) => { try { applyShellUtf8(event); } catch { /* команда без command */ } };
  if (ctx.shell && typeof ctx.shell.hook === 'function') {
    try { await ctx.shell.hook('create.before', run); } catch { /* хост без shell-хука */ }
  }
  if (ctx.tool && typeof ctx.tool.hook === 'function') {
    await ctx.tool.hook('execute.before', (event) => {
      if (!event?.input || typeof event.input !== 'object') return;
      const shell = event.shell || event.input.shell;
      if (!shell) return;
      const key = typeof event.input.command === 'string' ? 'command' : (typeof event.input.cmd === 'string' ? 'cmd' : null);
      if (!key) return;
      const fake = { command: event.input[key], shell, env: event.env || event.input.env };
      if (applyShellUtf8(fake)) event.input[key] = fake.command;
    });
  }
}

// ---------- пачки ----------

// check(file) → Promise<{ status, diags: [...] }>. Файлы, пришедшие в окне debounceMs, — одна пачка;
// пока пачка выполняется, новые копятся в следующую.
export function createChecker({ analyze, debounceMs = DEFAULTS.debounceMs }) {
  let pending = new Map();
  let timer = null; let busy = false; let disposed = false;
  const schedule = () => {
    if (timer || busy || disposed || !pending.size) return;
    timer = setTimeout(flush, debounceMs);
  };
  async function flush() {
    timer = null; busy = true;
    const batch = pending; pending = new Map();
    let res;
    try { res = await analyze([...batch.keys()]); } catch (e) { res = { status: 'failed', message: e.message }; }
    busy = false;
    for (const [file, waiters] of batch) {
      const r = { status: res.status, message: res.message, diags: res.diags?.get(file) || [] };
      for (const w of waiters) w(r);
    }
    schedule();
  }
  return {
    check(file) {
      if (disposed) return Promise.resolve({ status: 'disposed', diags: [] });
      return new Promise((r) => {
        if (!pending.has(file)) pending.set(file, []);
        pending.get(file).push(r);
        schedule();
      });
    },
    dispose() {
      disposed = true; if (timer) clearTimeout(timer); timer = null;
      for (const [, ws] of pending) for (const w of ws) w({ status: 'disposed', diags: [] });
      pending.clear();
    },
  };
}

// ---------- вывод ----------

const plural = (n, one, few, many) => {
  const m10 = n % 10; const m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};

// results: [{ file, status, diags, message }] → текст для модели или '' (нечего сказать)
export function formatResults(results, { root, severity = 'Warning', limit = 20, timeoutMs = 30000, state = {} } = {}) {
  const max = LEVELS.indexOf(level(severity) || 'Warning');
  const rel = (f) => { const r = relative(root || process.cwd(), f); return (r.startsWith('..') || isAbsolute(r) ? f : r).split(sep).join('/'); };
  state.hadIssues ||= new Set();
  const lines = [];
  let budget = limit;
  const sorted = [...results].sort((a, b) => a.file.localeCompare(b.file));
  for (const r of sorted) {
    if (r.status === 'missing') {
      if (!state.missingHinted) {
        state.missingHinted = true;
        lines.push(`${TAG} BSL Language Server не найден — автопроверка .bsl после правок не выполняется (подсказка показывается один раз). ` +
          'Установка: node own-skills/bsl-check/scripts/bsl-check.mjs -Install или переменная BSL_LS_PATH; отключить: BSL_AUTOCHECK=0.');
      }
      continue;
    }
    if (r.status === 'timeout') { lines.push(`${TAG} ${rel(r.file)}: BSL LS не уложился в ${Math.round(timeoutMs / 1000)} с — не проверено; проверь навыком bsl-check -Path.`); continue; }
    if (r.status === 'failed') { lines.push(`${TAG} ${rel(r.file)}: проверка не выполнена — ${r.message || 'ошибка BSL LS'}.`); continue; }
    if (r.status === 'skipped') { lines.push(`${TAG} ${rel(r.file)}: не проверен — ${r.message}.`); continue; }
    if (r.status !== 'ok') continue;
    const rows = (r.diags || []).filter((d) => LEVELS.indexOf(d.lvl) <= max)
      .sort((a, b) => LEVELS.indexOf(a.lvl) - LEVELS.indexOf(b.lvl) || a.line - b.line || a.col - b.col);
    const seen = new Set();
    const uniq = rows.filter((d) => { const k = `${d.line}|${d.code}|${d.msg}`; return !seen.has(k) && seen.add(k); });
    if (!uniq.length) {
      if (state.hadIssues.has(r.file)) { state.hadIssues.delete(r.file); lines.push(`${TAG} ${rel(r.file)}: замечаний уровня «${LEVEL_RU[LEVELS[max]]}» и выше больше нет.`); }
      continue;
    }
    state.hadIssues.add(r.file);
    const errors = uniq.filter((d) => d.lvl === 'Error').length;
    const other = uniq.length - errors;
    lines.push(`${TAG} ${rel(r.file)}: ${errors} ${plural(errors, 'ошибка', 'ошибки', 'ошибок')}, ${other} ${plural(other, 'предупреждение', 'предупреждения', 'предупреждений')}` +
      (errors ? ' — исправь перед продолжением:' : ':'));
    const shown = uniq.slice(0, Math.max(0, budget));
    for (const d of shown) lines.push(`  стр. ${d.line}:${d.col} ${LEVEL_RU[d.lvl]}${d.code ? ` [${d.code}]` : ''} ${d.msg}`);
    budget -= shown.length;
    if (uniq.length > shown.length) lines.push(`  … ещё ${uniq.length - shown.length} (полный список: навык bsl-check -Path ${rel(r.file)})`);
  }
  return lines.join('\n');
}

export function appendToResult(result, text) {
  if (!text) return result;
  const block = `\n\n${text}`;
  const content = result?.content;
  if (typeof content === 'string') return { ...result, content: content + block };
  if (Array.isArray(content)) return { ...result, content: [...content, { type: 'text', text: text }] };
  const base = result?.output === undefined ? '' : typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
  return { ...result, content: base ? base + block : text };
}

// ---------- плагин ----------

export function createPlugin({ analyze = bslAnalyze, env = process.env } = {}) {
  return {
    id: '1c-agent.bsl-autocheck',
    async setup(ctx) {
      const root = ctx?.location?.directory || process.cwd();
      // Плагин подключён и глобально, и в проекте — проверяем один раз на каталог.
      const active = (globalThis[ACTIVE] ||= new Set());
      const key = IS_WIN ? resolve(root).toLowerCase() : resolve(root);
      if (active.has(key)) return undefined;
      active.add(key);
      writeAutocheckState(root, env);
      await registerShellUtf8(ctx);
      const state = {};
      let settings = loadSettings(root, env, ctx?.options);
      const checker = createChecker({
        analyze: (files) => analyze(files, { root, timeoutMs: settings.timeoutMs }),
        debounceMs: settings.debounceMs,
      });
      await ctx.tool.hook('execute.after', async (event) => {
        if (event.status !== 'completed' || !EDIT_TOOLS.has(event.tool)) return;
        settings = loadSettings(root, env, ctx?.options);
        if (!settings.enabled) return;
        const files = editedFiles(event, root);
        if (!files.length) return;
        const results = await Promise.all(files.map(async (file) => {
          let st;
          try { st = statSync(file); } catch { return { file, status: 'gone', diags: [] }; }
          if (!st.isFile()) return { file, status: 'gone', diags: [] };
          if (settings.maxKb && st.size > settings.maxKb * 1024) {
            return { file, status: 'skipped', diags: [], message: `${Math.round(st.size / 1024)} КБ больше лимита ${settings.maxKb} КБ (BSL_AUTOCHECK_MAX_KB)` };
          }
          if (state.missingHinted) return { file, status: 'missing', diags: [] };
          return { file, ...(await checker.check(file)) };
        }));
        const text = formatResults(results, { root, severity: settings.severity, limit: settings.limit, timeoutMs: settings.timeoutMs, state });
        if (text) event.result = appendToResult(event.result, text);
      });
      return () => { active.delete(key); checker.dispose(); killRunning(); };
    },
  };
}

export default createPlugin();
