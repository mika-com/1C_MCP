#!/usr/bin/env node
// help.mjs v1.0 — MCP-сервер «синтакс-помощник» (1c-help): поиск и описание типов, методов, свойств,
// событий, конструкторов, операторов встроенного языка и языка запросов по справке УСТАНОВЛЕННОЙ платформы 1С
// (shcntx_<lang>.hbk, shlang_<lang>.hbk, shquery_<lang>.hbk в каталоге bin). Справка 1С в репозиторий не входит.
//
// Где ищется платформа (первое найденное):
//   1) V8_HELP_PATH — файл .hbk, каталог с .hbk или каталог bin платформы;
//   2) v8path из .v8-project.json проекта (каталог bin или путь к 1cv8.exe/ibcmd.exe);
//   3) самая новая установленная: %ProgramFiles%\1cv8\<версия>\bin, %ProgramFiles(x86)%\1cv8\…,
//      %LOCALAPPDATA%\Programs\1cv8\…; Linux: /opt/1cv8/x86_64/<версия>, /opt/1cv8/<версия>, /opt/1C/v8.3/x86_64.
// Язык справки — V8_HELP_LANG (ru по умолчанию; en → *_root.hbk).
// Индекс (только оглавление: имена, вид, владелец, путь к странице) строится один раз в дочернем процессе
// с таймаутом (HELP_BUILD_TIMEOUT_MS, 120 с) и кэшируется у пользователя: %LOCALAPPDATA%\1c-opencode\help-cache
// (Windows) или $XDG_CACHE_HOME|~/.cache/1c-opencode/help-cache; ключ — версия платформы и язык.
// Страницы читаются из .hbk по запросу. При завершении сервера дерево процессов сборки гасится.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readContainer, readZipIndex, readZipEntry, readFirstZipEntry, parseToc, parsePage, decodeHtml, normalizePath } from './lib/hbk.mjs';
import { killTree } from './lib/proc-tree.mjs';
import { agentVersion, instructionSuffix } from './lib/agent-meta.mjs';


const SELF = fileURLToPath(import.meta.url);
const IS_WIN = process.platform === 'win32';
export const INDEX_VERSION = 1;
export const HELP_FILES = { cntx: 'shcntx', lang: 'shlang', query: 'shquery' };
const KIND_RU = { type: 'тип', method: 'метод', property: 'свойство', event: 'событие', ctor: 'конструктор',
  lang: 'встроенный язык', query: 'язык запросов', page: 'раздел' };
const KIND_ALIASES = { type: 'type', тип: 'type', method: 'method', метод: 'method', methods: 'method', методы: 'method',
  property: 'property', свойство: 'property', properties: 'property', свойства: 'property', event: 'event', событие: 'event',
  events: 'event', события: 'event', ctor: 'ctor', constructor: 'ctor', конструктор: 'ctor', constructors: 'ctor',
  конструкторы: 'ctor', lang: 'lang', language: 'lang', язык: 'lang', query: 'query', запрос: 'query', page: 'page' };
const GROUPS = { методы: 'method', methods: 'method', свойства: 'property', properties: 'property', события: 'event',
  events: 'event', конструкторы: 'ctor', constructors: 'ctor', значения: 'property', values: 'property' };
const GLOBAL_RE = /^(глобальный контекст|global context)$/i;

// ---------- платформа ----------

const VER_RE = /(\d+\.\d+\.\d+\.\d+)/;
export function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map(Number); const pb = String(b || '0').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };

export function helpFilesIn(dir, lang = 'ru') {
  const files = {};
  for (const [kind, prefix] of Object.entries(HELP_FILES)) {
    for (const l of lang === 'en' ? ['root', 'en'] : [lang, 'root']) {
      const f = join(dir, `${prefix}_${l}.hbk`);
      if (isFile(f)) { files[kind] = f; break; }
    }
  }
  return files;
}

function dirWithHelp(p, lang) {
  if (!p) return null;
  let dir = p;
  if (isFile(p) || (!isDir(p) && /(\.(exe|hbk)|[\\/](1cv8[cs]?|ibcmd|ibsrv|rac|ras))$/i.test(p))) dir = dirname(p);
  for (const d of [dir, join(dir, 'bin')]) {
    const files = helpFilesIn(d, lang);
    if (files.cntx || files.lang || files.query) return { dir: d, files };
  }
  return null;
}

function stripJsonComments(text) {
  let out = ''; let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { out += c; if (c === '\\') { out += text[++i] ?? ''; } else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i + 2); if (i < 0) break; i++; continue; }
    out += c;
  }
  return out.replace(/,\s*([}\]])/g, '$1');
}

export function projectV8Path(root) {
  const f = join(root || process.cwd(), '.v8-project.json');
  if (!isFile(f)) return null;
  try { return JSON.parse(stripJsonComments(readFileSync(f, 'utf8').replace(/^\uFEFF/, ''))).v8path || null; } catch { return null; }
}

export function installBases(env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    const roots = [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean).map((r) => join(r, '1cv8'));
    if (env.LOCALAPPDATA) roots.push(join(env.LOCALAPPDATA, 'Programs', '1cv8'));
    return [...new Set(roots)];
  }
  if (platform === 'darwin') return ['/Applications/1cv8.localized', '/opt/1cv8'];
  return ['/opt/1cv8/x86_64', '/opt/1cv8/aarch64', '/opt/1cv8/i386', '/opt/1cv8', '/opt/1C/v8.3/x86_64', '/opt/1C/v8.3/i386'];
}

export function installedPlatforms({ env = process.env, lang = 'ru', bases = installBases(env) } = {}) {
  const found = [];
  for (const base of bases) {
    if (!isDir(base)) continue;
    const direct = dirWithHelp(base, lang);
    if (direct) found.push({ version: base.match(VER_RE)?.[1] || '', ...direct, source: 'установка' });
    let names = [];
    try { names = readdirSync(base); } catch { /* */ }
    for (const n of names) {
      if (!VER_RE.test(n)) continue;
      const hit = dirWithHelp(join(base, n), lang);
      if (hit) found.push({ version: n.match(VER_RE)[1], ...hit, source: 'установка' });
    }
  }
  const seen = new Set();
  return found.filter((p) => !seen.has(p.dir) && seen.add(p.dir)).sort((a, b) => compareVersions(b.version, a.version));
}

// Выбор платформы: V8_HELP_PATH → .v8-project.json → самая новая установленная (или запрошенная версия).
export function resolvePlatform({ root, version, lang = process.env.V8_HELP_LANG || 'ru', env = process.env, bases } = {}) {
  if (env.V8_HELP_PATH) {
    const hit = dirWithHelp(env.V8_HELP_PATH, lang);
    if (!hit) return { error: `V8_HELP_PATH=${env.V8_HELP_PATH}: файлы справки (shcntx_${lang}.hbk и др.) не найдены` };
    return { version: env.V8_HELP_PATH.match(VER_RE)?.[1] || '', lang, ...hit, source: 'V8_HELP_PATH' };
  }
  const all = installedPlatforms({ env, lang, bases });
  if (version) {
    const p = all.find((x) => x.version === version || x.version.startsWith(version));
    if (p) return { ...p, lang };
  }
  const v8 = projectV8Path(root);
  if (v8 && !version) {
    const hit = dirWithHelp(v8, lang);
    if (hit) return { version: v8.match(VER_RE)?.[1] || '', lang, ...hit, source: '.v8-project.json (v8path)' };
  }
  if (all.length) return { ...all[0], lang };
  return { error: 'платформа 1С со справкой не найдена. Укажите V8_HELP_PATH (каталог bin платформы или файл shcntx_ru.hbk) ' +
    'или v8path в .v8-project.json.', searched: installBases(env) };
}

// ---------- индекс ----------

export function cacheDir(env = process.env) {
  if (env.HELP_CACHE_DIR) return env.HELP_CACHE_DIR;
  if (IS_WIN) return join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), '1c-opencode', 'help-cache');
  return join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), '1c-opencode', 'help-cache');
}

export function cacheKey(platform) {
  const ver = platform.version || createHash('sha1').update(resolve(platform.dir)).digest('hex').slice(0, 12);
  return `${ver}-${platform.lang || 'ru'}.json`;
}

function fileStamp(f) { const s = statSync(f); return { path: f, size: s.size, mtimeMs: Math.round(s.mtimeMs) }; }

// Оглавление всех файлов → плоский список записей { ru, en, k, o, p, f, c }.
export function buildIndex(files) {
  const meta = []; const entries = [];
  for (const [kind, file] of Object.entries(files)) {
    if (!file) continue;
    const fi = meta.length;
    meta.push({ kind, ...fileStamp(file) });
    const container = readContainer(readFileSync(file));
    const pack = container.get('PackBlock');
    if (!pack) continue;
    const nodes = parseToc(readFirstZipEntry(pack).toString('utf8'));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const groupOf = (n) => GROUPS[(n.ru || '').toLowerCase()] || GROUPS[(n.en || '').toLowerCase()] || null;
    const isType = (n) => kind === 'cntx' && n.children.some((c) => byId.has(c) && groupOf(byId.get(c)));
    const entryOf = new Map();
    const ancestors = (n) => { const a = []; let p = byId.get(n.parent); let g = 0; while (p && g++ < 64) { a.push(p); p = byId.get(p.parent); } return a; };
    for (const n of nodes) {
      const grp = groupOf(n);
      const type = isType(n);
      if (grp && !type) continue;           // «Методы»/«Свойства» — только группировка
      if (!n.path && !type) continue;
      let k = 'page';
      if (kind === 'lang') k = 'lang';
      else if (kind === 'query') k = 'query';
      else if (/\/methods\//i.test(n.path)) k = 'method';
      else if (/\/properties\//i.test(n.path)) k = 'property';
      else if (/\/events\//i.test(n.path)) k = 'event';
      else if (/\/ctors?\//i.test(n.path)) k = 'ctor';
      else if (type) k = 'type';
      else { const pg = byId.get(n.parent); if (pg && groupOf(pg)) k = groupOf(pg); }
      const anc = ancestors(n);
      const cat = anc.filter((a) => !groupOf(a) && a.parent !== undefined).map((a) => a.ru).filter(Boolean).reverse().slice(-3).join(' / ');
      entryOf.set(n.id, entries.length);
      entries.push({ ru: n.ru, en: n.en, k, o: -1, p: n.path, f: fi, c: cat, _n: n.id });
    }
    for (const e of entries) {
      if (e.f !== fi || !['method', 'property', 'event', 'ctor'].includes(e.k)) continue;
      const n = byId.get(e._n);
      const owner = ancestors(n).find((a) => !groupOf(a) || isType(a));
      if (owner) {
        let oi = entryOf.get(owner.id);
        if (oi === undefined) { oi = entries.length; entryOf.set(owner.id, oi); entries.push({ ru: owner.ru, en: owner.en, k: 'type', o: -1, p: owner.path, f: fi, c: '', _n: owner.id }); }
        e.o = oi;
      }
    }
  }
  for (const e of entries) delete e._n;
  return { version: INDEX_VERSION, files: meta, entries, built: Date.now() };
}

function indexValid(idx, files) {
  if (!idx || idx.version !== INDEX_VERSION) return false;
  const want = Object.values(files).filter(Boolean).sort();
  const have = idx.files.map((f) => f.path).sort();
  if (want.join('|') !== have.join('|')) return false;
  return idx.files.every((f) => { try { const s = fileStamp(f.path); return s.size === f.size && s.mtimeMs === f.mtimeMs; } catch { return false; } });
}

const loaded = new Map();     // путь кэша → индекс
const building = new Map();   // путь кэша → Promise
const builders = new Set();   // pid дочерних процессов сборки

process.on('exit', () => { for (const pid of builders) killTree(pid); });

function runBuilder(cacheFile, files, timeoutMs) {
  return new Promise((resolveP, reject) => {
    const args = [SELF, '--build', cacheFile, ...Object.entries(files).filter(([, f]) => f).map(([k, f]) => `${k}=${f}`)];
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: !IS_WIN, windowsHide: true });
    builders.add(child.pid);
    let err = '';
    child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    const timer = setTimeout(() => { killTree(child.pid); reject(new Error(`сборка индекса справки дольше ${Math.round(timeoutMs / 1000)} с — прервана (HELP_BUILD_TIMEOUT_MS)`)); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); builders.delete(child.pid); reject(e); });
    child.on('exit', (code) => {
      clearTimeout(timer); builders.delete(child.pid);
      if (code === 0) resolveP(); else reject(new Error(`сборка индекса справки завершилась с кодом ${code}: ${err.trim().split('\n').pop() || ''}`));
    });
  });
}

export async function ensureIndex(platform, { env = process.env } = {}) {
  const file = join(cacheDir(env), cacheKey(platform));
  const mem = loaded.get(file);
  if (mem && indexValid(mem, platform.files)) return { idx: mem, file };
  if (existsSync(file)) {
    try { const idx = JSON.parse(readFileSync(file, 'utf8')); if (indexValid(idx, platform.files)) { loaded.set(file, idx); return { idx, file }; } } catch { /* пересоберём */ }
  }
  if (!building.has(file)) {
    mkdirSync(dirname(file), { recursive: true });
    const timeout = Number(env.HELP_BUILD_TIMEOUT_MS) || 120000;
    building.set(file, runBuilder(file, platform.files, timeout).finally(() => building.delete(file)));
  }
  await building.get(file);
  const idx = JSON.parse(readFileSync(file, 'utf8'));
  loaded.set(file, idx);
  return { idx, file };
}

// ---------- поиск ----------

export const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\(\)/g, '').replace(/[\s_]+/g, '');

function lev(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

function nameScore(q, name) {
  if (!q || !name) return 0;
  if (name === q) return 100;
  if (name.startsWith(q)) return 80 - Math.min(20, (name.length - q.length) / 2);
  if (q.length >= 3 && name.includes(q)) return 60 - Math.min(20, (name.length - q.length) / 3);
  if (q.length >= 4) { const max = Math.max(1, Math.floor(q.length / 5)); const d = lev(q, name, max); if (d <= max) return 50 - d * 5; }
  return 0;
}

const ownerOf = (idx, e) => (e.o >= 0 ? idx.entries[e.o] : null);
export function qualified(idx, e, lang = 'ru') {
  const o = ownerOf(idx, e);
  const own = lang === 'en' ? e.en : e.ru;
  if (!o || GLOBAL_RE.test(o.ru) || GLOBAL_RE.test(o.en)) return own;
  return `${lang === 'en' ? o.en : o.ru}.${own}`;
}

export function search(idx, query, { kind, limit = 10, owner } = {}) {
  const k = kind ? KIND_ALIASES[String(kind).toLowerCase()] || kind : null;
  const raw = String(query || '').trim();
  const dot = raw.lastIndexOf('.');
  const qOwner = norm(owner || (dot > 0 ? raw.slice(0, dot) : ''));
  const q = norm(dot > 0 ? raw.slice(dot + 1) : raw);
  const res = [];
  idx.entries.forEach((e, i) => {
    if (k && e.k !== k) return;
    let s = Math.max(nameScore(q, norm(e.ru)), nameScore(q, norm(e.en)));
    if (!q && qOwner) s = 1;
    if (!s) return;
    if (qOwner) {
      const o = ownerOf(idx, e);
      const so = o ? Math.max(nameScore(qOwner, norm(o.ru)), nameScore(qOwner, norm(o.en))) : 0;
      if (!so) return;
      s = (s + so) / 2 + 5;
    } else if (e.k === 'type' || e.k === 'lang' || e.k === 'query') s += 3;
    else if (ownerOf(idx, e) && GLOBAL_RE.test(ownerOf(idx, e).ru)) s += 2;
    res.push({ i, s });
  });
  res.sort((a, b) => b.s - a.s || idx.entries[a.i].ru.length - idx.entries[b.i].ru.length);
  return res.slice(0, Math.min(Number(limit) || 10, 50)).map(({ i, s }) => ({ id: i, score: Math.round(s), e: idx.entries[i] }));
}

function line(idx, id) {
  const e = idx.entries[id];
  const ru = qualified(idx, e, 'ru'); const en = qualified(idx, e, 'en');
  const glob = ownerOf(idx, e) && GLOBAL_RE.test(ownerOf(idx, e).ru) ? ', глобальный контекст' : '';
  return `- \`${ru}\`${en && en !== ru ? ` (${en})` : ''} — ${KIND_RU[e.k] || e.k}${glob}${e.c && e.k === 'type' ? ` · ${e.c}` : ''} [id ${id}]`;
}

// ---------- страницы ----------

const storages = new Map();   // путь .hbk → { zip, files, lower }
function storage(path) {
  let s = storages.get(path);
  if (!s) {
    const fs = readContainer(readFileSync(path)).get('FileStorage');
    if (!fs) throw new Error(`${basename(path)}: нет FileStorage`);
    const files = readZipIndex(fs);
    const lower = new Map([...files.keys()].map((k) => [k.toLowerCase(), k]));
    s = { zip: fs, files, lower };
    if (storages.size > 3) storages.delete(storages.keys().next().value);
    storages.set(path, s);
  }
  return s;
}

export function readPage(idx, e) {
  const file = idx.files[e.f]?.path;
  if (!file || !e.p) return null;
  const s = storage(file);
  const p = normalizePath(e.p);
  const key = [p, `${p}.html`, p.replace(/\.html?$/i, '')].find((x) => s.files.has(x)) || s.lower.get(p.toLowerCase());
  if (!key) return null;
  return parsePage(decodeHtml(readZipEntry(s.zip, s.files.get(key))));
}

const SECTION_ORDER = ['синтаксис', 'вариант синтаксиса', 'параметры', 'возвращаемое значение', 'использование', 'описание',
  'доступность', 'версия', 'использование в версии', 'замечание', 'примечание', 'пример', 'см. также'];

export function renderEntry(idx, id, { maxChars = 6000, examples = true } = {}) {
  const e = idx.entries[id];
  const head = `## ${qualified(idx, e)}${e.en && e.en !== e.ru ? ` (${qualified(idx, e, 'en')})` : ''}`;
  const src = idx.files[e.f];
  const metaLine = `*${KIND_RU[e.k] || e.k}${ownerOf(idx, e) && !GLOBAL_RE.test(ownerOf(idx, e).ru) ? ` типа ${ownerOf(idx, e).ru}` : ''}` +
    `${ownerOf(idx, e) && GLOBAL_RE.test(ownerOf(idx, e).ru) ? ' глобального контекста' : ''}${e.c ? ` · ${e.c}` : ''} · ${basename(src?.path || '')}*`;
  const out = [head, metaLine];
  let page = null;
  try { page = readPage(idx, e); } catch (err) { out.push(`(страница не прочитана: ${err.message})`); }
  if (page) {
    const secs = [...page.sections].sort((a, b) => {
      const ia = SECTION_ORDER.findIndex((n) => a.name.toLowerCase().startsWith(n));
      const ib = SECTION_ORDER.findIndex((n) => b.name.toLowerCase().startsWith(n));
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    for (const sec of secs) {
      if (!sec.text) continue;
      if (/^(методы|свойства|события|конструкторы|methods|properties|events|constructors)$/i.test(sec.name)) {
        out.push(`**${sec.name}:** ${sec.text.split('\n').filter(Boolean).length} шт. — список: \`help_members\``);
        continue;
      }
      if (sec.code) { if (examples) out.push(`**${sec.name}:**\n\`\`\`bsl\n${sec.text}\n\`\`\``); continue; }
      const t = sec.text.includes('\n') ? `\n${sec.text}` : ` ${sec.text}`;
      out.push(/^синтаксис/i.test(sec.name) && !sec.text.includes('\n') ? `**${sec.name}:** \`${sec.text}\`` : `**${sec.name}:**${t}`);
    }
  } else if (e.k !== 'type') out.push('(страница справки не найдена)');
  if (e.k === 'type') {
    const counts = {};
    idx.entries.forEach((m) => { if (m.o === id) counts[m.k] = (counts[m.k] || 0) + 1; });
    const c = Object.entries(counts).map(([k, n]) => `${KIND_RU[k]}: ${n}`).join(', ');
    if (c) out.push(`**Состав:** ${c} — \`help_members\``);
  }
  let text = out.join('\n\n');
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…(обрезано, увеличьте max_chars)';
  return text;
}

export function members(idx, typeName, { kind, limit = 300 } = {}) {
  const k = kind ? KIND_ALIASES[String(kind).toLowerCase()] || kind : null;
  let typeId = Number.isInteger(typeName) ? typeName : -1;
  if (typeId < 0) {
    const q = norm(typeName);
    const owners = new Set(idx.entries.map((e) => e.o).filter((o) => o >= 0));
    let best = -1; let bestS = 0;
    for (const o of owners) {
      const e = idx.entries[o];
      const s = Math.max(nameScore(q, norm(e.ru)), nameScore(q, norm(e.en)));
      if (s > bestS || (s === bestS && best >= 0 && e.ru.length < idx.entries[best].ru.length)) { bestS = s; best = o; }
    }
    typeId = best;
  }
  if (typeId < 0) return null;
  const list = idx.entries.map((e, i) => ({ e, i })).filter(({ e }) => e.o === typeId && (!k || e.k === k));
  return { typeId, list: list.slice(0, limit), total: list.length };
}

// ---------- MCP ----------

const NAME_ARG = { type: 'string', description: 'Имя (рус. или англ.), можно «Тип.Метод»: «ТаблицаЗначений.Добавить», «СтрНайти», «ValueTable»' };
const COMMON = {
  version: { type: 'string', description: 'Версия платформы (по умолчанию — из .v8-project.json или самая новая установленная)' },
  root: { type: 'string', description: 'Корень проекта (для .v8-project.json; по умолчанию — рабочая папка OpenCode)' },
};
export const TOOLS = [
  { name: 'help_search', description: 'Поиск в синтакс-помощнике платформы: типы, методы, свойства, события, конструкторы, операторы языка и языка запросов. Нечёткий поиск по рус./англ. имени.',
    inputSchema: { type: 'object', properties: { query: NAME_ARG, kind: { type: 'string', description: 'type|method|property|event|ctor|lang|query' }, limit: { type: 'number' }, ...COMMON }, required: ['query'] } },
  { name: 'help_get', description: 'Полное описание из синтакс-помощника: синтаксис, параметры, возвращаемое значение, доступность (клиент/сервер), версия, примеры, см. также.',
    inputSchema: { type: 'object', properties: { name: NAME_ARG, id: { type: 'number', description: 'id из help_search' }, kind: { type: 'string' }, examples: { type: 'boolean' }, max_chars: { type: 'number' }, ...COMMON } } },
  { name: 'help_members', description: 'Состав типа платформы: методы, свойства, события, конструкторы (например ТаблицаЗначений, Запрос, HTTPСоединение).',
    inputSchema: { type: 'object', properties: { type: { type: 'string', description: 'Имя типа (рус./англ.)' }, kind: { type: 'string', description: 'method|property|event|ctor' }, ...COMMON }, required: ['type'] } },
  { name: 'help_status', description: 'Какая платформа и какие файлы справки используются, состояние индекса.',
    inputSchema: { type: 'object', properties: { refresh: { type: 'boolean', description: 'пересобрать индекс' }, ...COMMON } } },
];

const INSTRUCTIONS = 'Синтакс-помощник установленной платформы 1С. Перед использованием незнакомого или неочевидного метода, ' +
  'свойства, конструктора или функции глобального контекста проверь его здесь: help_search → help_get (синтаксис, параметры, ' +
  'доступность на клиенте/сервере, версия). Не придумывай методы: если в справке нет — так и скажи.' + instructionSuffix();

export async function handleCall(name, a, ctx = { root: (r) => r || process.cwd() }, env = process.env) {
  const platform = resolvePlatform({ root: ctx.root(a.root), version: a.version, env });
  if (platform.error) {
    return `Справка недоступна: ${platform.error}${platform.searched ? `\nИскал в: ${platform.searched.join(', ')}` : ''}`;
  }
  const head = `Платформа ${platform.version || '?'} (${platform.source}), ${platform.dir}`;
  if (name === 'help_status' && a.refresh) {
    const f = join(cacheDir(env), cacheKey(platform));
    loaded.delete(f);
    try { writeFileSync(f, '{}'); } catch { /* */ }
  }
  const { idx, file } = await ensureIndex(platform, { env });
  switch (name) {
    case 'help_status': {
      const byKind = {};
      for (const e of idx.entries) byKind[e.k] = (byKind[e.k] || 0) + 1;
      return [`1C-Agent ${agentVersion()}`, head, `Файлы: ${idx.files.map((f) => basename(f.path)).join(', ')}`, `Записей: ${idx.entries.length} (` +
        Object.entries(byKind).map(([k, n]) => `${KIND_RU[k] || k} ${n}`).join(', ') + ')',
      `Индекс: ${file} (собран ${new Date(idx.built).toISOString()})`].join('\n');
    }
    case 'help_search': {
      const r = search(idx, a.query, { kind: a.kind, limit: a.limit });
      if (!r.length) return `Ничего не найдено по «${a.query}». Такого имени в справке платформы ${platform.version || ''} нет — не используй его без проверки.`;
      return [`Найдено по «${a.query}» (${platform.version || '?'}):`, ...r.map((x) => line(idx, x.id))].join('\n');
    }
    case 'help_get': {
      let id = Number.isInteger(a.id) ? a.id : -1;
      let alts = [];
      if (id < 0) {
        if (!a.name) throw new Error('нужно name или id');
        const r = search(idx, a.name, { kind: a.kind, limit: 6 });
        if (!r.length) return `«${a.name}» в справке платформы ${platform.version || ''} не найдено — не используй без проверки.`;
        id = r[0].id;
        alts = r.slice(1).filter((x) => x.score >= r[0].score - 15);
        if (r[0].score < 100) alts = r.slice(1);
      }
      if (!idx.entries[id]) throw new Error(`нет записи с id ${id}`);
      let text = renderEntry(idx, id, { maxChars: Number(a.max_chars) || 6000, examples: a.examples !== false });
      if (alts.length) text += `\n\nПохожие:\n${alts.map((x) => line(idx, x.id)).join('\n')}`;
      return text;
    }
    case 'help_members': {
      const m = members(idx, a.type, { kind: a.kind });
      if (!m) return `Тип «${a.type}» не найден в справке платформы ${platform.version || ''}.`;
      const t = idx.entries[m.typeId];
      const groups = {};
      for (const { e } of m.list) (groups[e.k] ||= []).push(`${e.ru}${e.en && e.en !== e.ru ? ` (${e.en})` : ''}`);
      return [`## ${t.ru}${t.en && t.en !== t.ru ? ` (${t.en})` : ''} — ${m.total} шт.`,
        ...Object.entries(groups).map(([k, names]) => `**${KIND_RU[k] || k}:** ${names.join(', ')}`)].join('\n');
    }
    default: throw new Error(`неизвестный инструмент ${name}`);
  }
}

// ---------- точка входа ----------

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  if (process.argv[2] === '--build') {
    // дочерний процесс сборки индекса
    const out = process.argv[3];
    const files = Object.fromEntries(process.argv.slice(4).map((s) => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)]; }));
    try {
      const idx = buildIndex(files);
      const tmp = `${out}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(idx));
      renameSync(tmp, out);
      process.exit(0);
    } catch (e) {
      process.stderr.write(`[1c-help] ${e.stack || e}\n`);
      process.exit(1);
    }
  } else {
    for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => process.exit(0)); // → 'exit' гасит сборку
    const { startServer } = await import('./lib/stdio-server.mjs');
    startServer({ name: '1c-help', version: agentVersion(), instructions: INSTRUCTIONS, tools: TOOLS, onCall: (name, a, ctx) => handleCall(name, a, ctx) });
  }
}
