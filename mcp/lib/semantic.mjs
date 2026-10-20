// semantic.mjs v1.0 — семантический поиск для 1c-search: эмбеддинги фрагментов BSL (процедура/функция) и объектов
// метаданных через OpenAI-совместимый /v1/embeddings (LM Studio, llama-server, …), локальное векторное хранилище,
// переранжирование (Qwen3-Reranker через logprobs в /v1/responses LM Studio или /v1/rerank).
// Без зависимостей. Всё сетевое — с таймаутами; при любой ошибке вызывающий код уходит в поиск по ключевым словам.
//
// Хранилище (по умолчанию у пользователя: %LOCALAPPDATA%\1c-opencode\semantic, Linux ~/.cache/1c-opencode/semantic):
//   vectors/<модель>-d<размерность>/seg-*.vec — векторы по хэшу текста фрагмента (content-addressed): один и тот же
//     код в разных клонах/у разных пользователей считается один раз; файлы пишутся целиком во временный и
//     переименовываются (атомарно), читатели видят только готовые сегменты;
//   vectors/<…>/build.lock — один построитель на хранилище (heartbeat; брошенная блокировка снимается через 2 мин);
//   projects/<хэш корня>.json — манифест проекта: файлы (mtime/размер) → фрагменты (хэш, метод, строки).
// Общий каталог для всех пользователей сервера — SEMANTIC_STORE_DIR / semanticSearch.storeDir.

import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, statSync, unlinkSync, openSync, closeSync,
  writeSync, utimesSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, hostname, userInfo } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';

export const CHUNK_FORMAT = 1;
const MANIFEST_VERSION = 1;
const IS_WIN = process.platform === 'win32';
const MAGIC = Buffer.from('1CSVEC01', 'ascii');
export const LOCK_STALE_MS = 120000;
const HEARTBEAT_MS = 20000;

export const DEFAULTS = {
  enabled: 'auto',
  baseUrl: 'http://127.0.0.1:1234/v1',
  apiKeyEnv: 'LMSTUDIO_API_KEY',
  embedModel: 'qwen3-embedding-4b',
  dimensions: 1024,
  // Qwen3-Embedding: пулинг по последнему токену, который должен быть <|endoftext|>; многие GGUF не ставят
  // tokenizer.ggml.add_eos_token, и llama.cpp/LM Studio его не добавляют (предупреждение «last token … is not SEP»).
  // auto — дописывать для моделей qwen3-embedding; true/false — всегда/никогда.
  appendEos: 'auto',
  eosToken: '<|endoftext|>',
  rerankBackend: 'lmstudio-logprobs',
  rerankModel: 'qwen3-reranker-4b',
  rerankBaseUrl: '',
  rerankTopN: 30,
  rerankConcurrency: 4,
  topK: 10,
  batchSize: 16,
  maxChunkChars: 2000,
  includeObjects: true,
  autoBuild: true,
  storeDir: '',
  timeoutMs: 15000,
  buildTimeoutMs: 120000,
  rerankTimeoutMs: 45000,
  queryInstruction: 'Given a description of functionality in a 1C:Enterprise configuration, retrieve the BSL procedures, ' +
    'functions and metadata objects that implement it',
  rerankInstruction: 'Given a search query about a 1C:Enterprise configuration, judge whether the BSL code fragment or ' +
    'metadata object implements or directly answers the query',
};
export const RERANK_BACKENDS = ['lmstudio-logprobs', 'rerank-api', 'none'];
export const RERANK_SYSTEM = 'Judge whether the Document meets the requirements based on the Query and the Instruct provided. ' +
  'Note that the answer can only be "yes" or "no".';

// ---------------------------------------------------------------------------
// Настройки: переменные среды → .v8-project.json (semanticSearch) → по умолчанию
// ---------------------------------------------------------------------------
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

const num = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v));
const bool = (v) => (v === undefined || v === null || v === '' ? undefined : !/^(0|false|no|off|нет)$/i.test(String(v)));
const str = (v) => (v === undefined || v === null || String(v).trim() === '' ? undefined : String(v).trim());
const enabledVal = (v) => (v === undefined || v === null || v === '' ? undefined : /^auto$/i.test(String(v)) ? 'auto' : bool(v));

export function defaultStoreDir(env = process.env) {
  if (IS_WIN) return join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), '1c-opencode', 'semantic');
  return join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), '1c-opencode', 'semantic');
}

export function readProjectSection(root) {
  try {
    const f = join(root, '.v8-project.json');
    if (!existsSync(f)) return {};
    const j = JSON.parse(stripJsonComments(readFileSync(f, 'utf8').replace(/^\uFEFF/, '')));
    const s = j.semanticSearch;
    if (s === false) return { enabled: false };
    return s && typeof s === 'object' ? s : {};
  } catch { return {}; }
}

export function loadConfig(root, env = process.env) {
  const p = readProjectSection(root);
  const notes = [];
  if (p.apiKey) notes.push('semanticSearch.apiKey в .v8-project.json игнорируется — токен задаётся только переменной среды LMSTUDIO_API_KEY');
  const pick = (envKeys, key, conv) => [...envKeys.map((k) => env[k]), p[key]].map(conv).find((v) => v !== undefined) ?? DEFAULTS[key];
  const cfg = {
    enabled: pick(['SEMANTIC_SEARCH'], 'enabled', enabledVal),
    baseUrl: pick(['SEMANTIC_BASE_URL', 'LMSTUDIO_BASE_URL'], 'baseUrl', str).replace(/\/+$/, ''),
    apiKeyEnv: str(p.apiKeyEnv) || DEFAULTS.apiKeyEnv,
    embedModel: pick(['SEMANTIC_EMBED_MODEL'], 'embedModel', str),
    dimensions: Math.max(32, Math.round(pick(['SEMANTIC_EMBED_DIM'], 'dimensions', num))),
    appendEos: pick(['SEMANTIC_EMBED_APPEND_EOS'], 'appendEos', enabledVal),
    eosToken: pick(['SEMANTIC_EMBED_EOS_TOKEN'], 'eosToken', str),
    rerankBackend: pick(['SEMANTIC_RERANK_BACKEND'], 'rerankBackend', str),
    rerankModel: pick(['SEMANTIC_RERANK_MODEL'], 'rerankModel', str),
    rerankBaseUrl: pick(['SEMANTIC_RERANK_URL'], 'rerankBaseUrl', str),
    rerankTopN: Math.max(1, Math.round(pick(['SEMANTIC_RERANK_TOPN'], 'rerankTopN', num))),
    rerankConcurrency: Math.min(16, Math.max(1, Math.round(pick(['SEMANTIC_RERANK_CONCURRENCY'], 'rerankConcurrency', num)))),
    topK: Math.max(1, Math.round(pick(['SEMANTIC_TOPK'], 'topK', num))),
    batchSize: Math.min(256, Math.max(1, Math.round(pick(['SEMANTIC_BATCH'], 'batchSize', num)))),
    maxChunkChars: Math.max(200, Math.round(pick(['SEMANTIC_MAX_CHUNK_CHARS'], 'maxChunkChars', num))),
    includeObjects: pick(['SEMANTIC_INCLUDE_OBJECTS'], 'includeObjects', bool),
    autoBuild: pick(['SEMANTIC_AUTOBUILD'], 'autoBuild', bool),
    storeDir: pick(['SEMANTIC_STORE_DIR'], 'storeDir', str) || defaultStoreDir(env),
    timeoutMs: Math.max(500, pick(['SEMANTIC_TIMEOUT_MS'], 'timeoutMs', num)),
    buildTimeoutMs: Math.max(1000, pick(['SEMANTIC_BUILD_TIMEOUT_MS'], 'buildTimeoutMs', num)),
    rerankTimeoutMs: Math.max(1000, pick(['SEMANTIC_RERANK_TIMEOUT_MS'], 'rerankTimeoutMs', num)),
    queryInstruction: str(p.queryInstruction) || DEFAULTS.queryInstruction,
    rerankInstruction: str(p.rerankInstruction) || DEFAULTS.rerankInstruction,
    notes,
  };
  if (!cfg.rerankBaseUrl) cfg.rerankBaseUrl = cfg.baseUrl;
  cfg.rerankBaseUrl = cfg.rerankBaseUrl.replace(/\/+$/, '');
  if (!RERANK_BACKENDS.includes(cfg.rerankBackend)) {
    notes.push(`неизвестный rerankBackend «${cfg.rerankBackend}» — переранжирование выключено (допустимо: ${RERANK_BACKENDS.join(', ')})`);
    cfg.rerankBackend = 'none';
  }
  // токен — только из среды, в объект настроек не попадает при выводе статуса
  Object.defineProperty(cfg, 'apiKey', { value: env.SEMANTIC_API_KEY || env[cfg.apiKeyEnv] || '', enumerable: false });
  return cfg;
}

// ---------------------------------------------------------------------------
// HTTP с таймаутом
// ---------------------------------------------------------------------------
const short = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

export async function httpJson(url, { method = 'GET', body, apiKey, timeoutMs = 10000, signal } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const onOuter = () => ac.abort();
  if (signal) { if (signal.aborted) ac.abort(); else signal.addEventListener('abort', onOuter, { once: true }); }
  try {
    const headers = { 'content-type': 'application/json' };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ac.signal });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = undefined; }
    if (!res.ok) {
      const msg = json?.error?.message || (typeof json?.error === 'string' ? json.error : '') || text;
      const err = new Error(`HTTP ${res.status}${msg ? `: ${short(msg, 240)}` : ''}`);
      err.status = res.status; err.body = String(text || '');
      throw err;
    }
    if (json === undefined) throw new Error(`ответ не JSON: ${short(text, 120)}`);
    return json;
  } catch (e) {
    if (e.name === 'AbortError' || ac.signal.aborted) {
      const err = new Error(signal?.aborted ? 'отменено' : `нет ответа за ${Math.round(timeoutMs / 100) / 10} с`);
      err.timeout = true;
      throw err;
    }
    if (e.status) throw e;
    const cause = e.cause?.code || e.cause?.message || e.message;
    const err = new Error(`соединение не установлено (${cause})`);
    err.network = true;
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onOuter);
  }
}

// Доступен ли сервер: GET /models (3 с), результат кэшируется на 30 с
const probes = new Map();
export async function probe(cfg, { fresh = false } = {}) {
  const key = cfg.baseUrl;
  const c = probes.get(key);
  if (!fresh && c && Date.now() - c.at < 30000) return c;
  let r;
  try {
    const j = await httpJson(`${cfg.baseUrl}/models`, { apiKey: cfg.apiKey, timeoutMs: 3000 });
    r = { ok: true, models: (j.data || []).map((m) => m.id).filter(Boolean) };
  } catch (e) {
    r = { ok: false, error: e.status === 401 || e.status === 403
      ? `${e.message} — нужен токен API: переменная среды ${cfg.apiKeyEnv}` : e.message };
  }
  r.at = Date.now();
  probes.set(key, r);
  return r;
}
export function resetProbes() { probes.clear(); }

// ---------------------------------------------------------------------------
// Эмбеддинги
// ---------------------------------------------------------------------------
export function normalize(v, dim) {
  const out = new Float32Array(dim);
  let n = 0;
  for (let i = 0; i < dim; i++) { out[i] = v[i]; n += v[i] * v[i]; }
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < dim; i++) out[i] /= n;
  return out;
}

// Qwen3-Embedding: инструкция только у запроса; документы — как есть (карточка модели)
export function queryText(cfg, q) { return `Instruct: ${cfg.queryInstruction}\nQuery: ${q}`; }

// Токен конца, который дописывается к каждому входу эмбеддингов ('' — не дописывать).
// Qwen3-Embedding-GGUF: «Qwen3 Embedding models default to using the last token as <|endoftext|>, so you need to
// manually append this token to the end of your own input context» (карточка Qwen/Qwen3-Embedding-4B-GGUF);
// llama.cpp: https://github.com/ggml-org/llama.cpp/issues/14252
export const QWEN3_EMBED_RE = /qwen3[-_. ]?embedding/i;
export function embedEos(cfg) {
  const tok = cfg.eosToken || DEFAULTS.eosToken;
  if (cfg.appendEos === 'auto' || cfg.appendEos === undefined) return QWEN3_EMBED_RE.test(cfg.embedModel || '') ? tok : '';
  return cfg.appendEos ? tok : '';
}
// Усечение делается раньше (фрагменты, повтор с половиной текста), EOS дописывается последним — всегда в конце
export function withEos(text, eos) {
  if (!eos) return text;
  const t = String(text).replace(/\s+$/, '');
  return t.endsWith(eos) ? t : t + eos;
}
export function eosLabel(cfg) {
  const e = embedEos(cfg);
  return e ? `EOS ${e} (${cfg.appendEos === true ? 'включено явно' : 'авто'})` : `без EOS${cfg.appendEos === false ? ' (выключено явно)' : ''}`;
}

export async function embed(cfg, texts, { timeoutMs, signal } = {}) {
  const eos = embedEos(cfg);
  const j = await httpJson(`${cfg.baseUrl}/embeddings`, {
    method: 'POST', apiKey: cfg.apiKey, timeoutMs: timeoutMs || cfg.timeoutMs, signal,
    body: { model: cfg.embedModel, input: texts.map((t) => withEos(t, eos)), encoding_format: 'float' },
  });
  const data = Array.isArray(j.data) ? [...j.data] : [];
  if (data.length !== texts.length) throw new Error(`сервер вернул ${data.length} векторов вместо ${texts.length}`);
  data.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return data.map((d) => {
    const v = d.embedding;
    if (!Array.isArray(v) || !v.length) throw new Error('пустой вектор в ответе /embeddings');
    // MRL: Qwen3-Embedding допускает усечение размерности с последующей нормализацией
    if (v.length < cfg.dimensions) throw new Error(`модель вернула ${v.length} измерений, меньше dimensions=${cfg.dimensions}`);
    return normalize(v, cfg.dimensions);
  });
}

// ---------------------------------------------------------------------------
// Векторное хранилище
// ---------------------------------------------------------------------------
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, '_').slice(0, 80);
// Набор векторов = модель + размерность + EOS: векторы без EOS и с EOS разные и не смешиваются
const eosTag = (eos) => (eos ? `-eos${createHash('sha1').update(eos).digest('hex').slice(0, 6)}` : '');
export const vectorDir = (cfg) => join(cfg.storeDir, 'vectors', `${slug(cfg.embedModel)}-d${cfg.dimensions}${eosTag(embedEos(cfg))}`);
export const manifestFile = (cfg, root) =>
  join(cfg.storeDir, 'projects', `${createHash('sha1').update(resolve(root).toLowerCase()).digest('hex').slice(0, 16)}.json`);
// Хэш фрагмента учитывает EOS: без EOS — прежний формат (старые векторы других моделей остаются годными)
export const hashText = (text, eos = '') => createHash('sha1').update(`${CHUNK_FORMAT}\n${eos ? `eos:${eos}\n` : ''}${text}`).digest('hex');

function quantize(v) {
  let max = 0;
  for (let i = 0; i < v.length; i++) { const a = Math.abs(v[i]); if (a > max) max = a; }
  const scale = max / 127 || 1;
  const q = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) q[i] = Math.round(v[i] / scale);
  return { q, scale };
}

function uniqueName(prefix, ext) {
  return `${prefix}-${Date.now().toString(36)}-${process.pid}-${randomBytes(4).toString('hex')}${ext}`;
}

// Атомарная запись: во временный файл в том же каталоге, затем rename
export function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, data);
  try { renameSync(tmp, file); } catch (e) {
    // Windows: целевой файл открыт читателем — одна повторная попытка
    try { renameSync(tmp, file); } catch { try { unlinkSync(tmp); } catch { /* */ } throw e; }
  }
}

export class VectorStore {
  constructor(dir, dim) {
    this.dir = dir; this.dim = dim;
    this.map = new Map();          // хэш → { q: Int8Array, s: число }
    this.loaded = new Set();       // имена прочитанных сегментов
    this.refreshedAt = 0;
  }
  get recordSize() { return 20 + 4 + this.dim; }
  segments() {
    try { return readdirSync(this.dir).filter((f) => f.startsWith('seg-') && f.endsWith('.vec')); } catch { return []; }
  }
  refresh({ maxAgeMs = 0 } = {}) {
    if (maxAgeMs && Date.now() - this.refreshedAt < maxAgeMs) return this;
    this.refreshedAt = Date.now();
    for (const f of this.segments()) {
      if (this.loaded.has(f)) continue;
      let buf;
      try { buf = readFileSync(join(this.dir, f)); } catch { continue; }   // удалён при уплотнении — пропускаем
      this.loaded.add(f);
      if (buf.length < 16 || !buf.subarray(0, 8).equals(MAGIC) || buf.readUInt32LE(8) !== this.dim) continue;
      const count = buf.readUInt32LE(12);
      if (buf.length !== 16 + count * this.recordSize) continue;
      for (let i = 0, off = 16; i < count; i++, off += this.recordSize) {
        const h = buf.toString('hex', off, off + 20);
        if (this.map.has(h)) continue;
        const s = buf.readFloatLE(off + 20);
        const q = new Int8Array(this.dim);
        q.set(new Int8Array(buf.buffer, buf.byteOffset + off + 24, this.dim));
        this.map.set(h, { q, s });
      }
    }
    return this;
  }
  has(h) { return this.map.has(h); }
  get size() { return this.map.size; }
  encode(entries) {
    const buf = Buffer.alloc(16 + entries.length * this.recordSize);
    MAGIC.copy(buf, 0); buf.writeUInt32LE(this.dim, 8); buf.writeUInt32LE(entries.length, 12);
    let off = 16;
    for (const e of entries) {
      buf.write(e.h, off, 20, 'hex');
      buf.writeFloatLE(e.s, off + 20);
      Buffer.from(e.q.buffer, e.q.byteOffset, this.dim).copy(buf, off + 24);
      off += this.recordSize;
    }
    return buf;
  }
  // entries: [{ h, v: Float32Array }]
  append(entries) {
    const recs = [];
    for (const { h, v } of entries) {
      if (this.map.has(h)) continue;
      const { q, scale } = quantize(v);
      this.map.set(h, { q, s: scale });
      recs.push({ h, q, s: scale });
    }
    if (!recs.length) return 0;
    mkdirSync(this.dir, { recursive: true });
    const name = uniqueName('seg', '.vec');
    atomicWrite(join(this.dir, name), this.encode(recs));
    this.loaded.add(name);
    return recs.length;
  }
  // Сливает сегменты в один (под блокировкой построителя). Удаляет только те, что слил.
  compact(minSegments = 48) {
    const segs = this.segments();
    if (segs.length < minSegments) return 0;
    this.refresh();
    const recs = [...this.map.entries()].map(([h, { q, s }]) => ({ h, q, s }));
    const name = uniqueName('seg', '.vec');
    atomicWrite(join(this.dir, name), this.encode(recs));
    this.loaded.add(name);
    let removed = 0;
    for (const f of segs) { try { unlinkSync(join(this.dir, f)); removed++; } catch { /* читатель держит файл — удалим в следующий раз */ } }
    return removed;
  }
  score(qv, h) {
    const e = this.map.get(h);
    if (!e) return null;
    const { q, s } = e;
    let dot = 0;
    for (let i = 0; i < q.length; i++) dot += qv[i] * q[i];
    return dot * s;
  }
}

const stores = new Map();
export function getStore(cfg) {
  const dir = vectorDir(cfg);
  let s = stores.get(dir);
  if (!s) { s = new VectorStore(dir, cfg.dimensions); stores.set(dir, s); }
  return s;
}
export function resetStores() { stores.clear(); manifests.clear(); }

// ---------------------------------------------------------------------------
// Блокировка построителя: lock-файл (wx) + heartbeat (mtime); брошенный (старше 2 мин) снимается
// ---------------------------------------------------------------------------
function whoami() { try { return userInfo().username; } catch { return process.env.USERNAME || process.env.USER || '?'; } }

export function readLock(file) {
  try {
    const st = statSync(file);
    let info = {};
    try { info = JSON.parse(readFileSync(file, 'utf8')); } catch { /* пишется */ }
    return { ...info, ageMs: Date.now() - st.mtimeMs, stale: Date.now() - st.mtimeMs > LOCK_STALE_MS };
  } catch { return null; }
}

export function acquireLock(file, { staleMs = LOCK_STALE_MS } = {}) {
  mkdirSync(join(file, '..'), { recursive: true });
  const token = `${process.pid}-${randomBytes(8).toString('hex')}`;
  const info = JSON.stringify({ token, pid: process.pid, user: whoami(), host: hostname(), started: new Date().toISOString() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx');
      try { writeSync(fd, info); } finally { closeSync(fd); }
    } catch (e) {
      if (e.code !== 'EEXIST') return null;
      try {
        const st = statSync(file);
        if (Date.now() - st.mtimeMs > staleMs) { unlinkSync(file); continue; }
      } catch { continue; }
      return null;
    }
    const mine = () => { try { return JSON.parse(readFileSync(file, 'utf8')).token === token; } catch { return false; } };
    if (!mine()) return null;
    return {
      token,
      beat() { if (!mine()) return false; try { const t = new Date(); utimesSync(file, t, t); } catch { return false; } return true; },
      release() { if (mine()) { try { unlinkSync(file); } catch { /* */ } } },
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Манифест проекта
// ---------------------------------------------------------------------------
const manifests = new Map();   // файл → { mtimeMs, data }
export function loadManifest(cfg, root) {
  const f = manifestFile(cfg, root);
  let st;
  try { st = statSync(f); } catch { manifests.delete(f); return null; }
  const c = manifests.get(f);
  if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.data;
  try {
    const data = JSON.parse(readFileSync(f, 'utf8'));
    if (data.version !== MANIFEST_VERSION || data.format !== CHUNK_FORMAT || data.model !== cfg.embedModel || data.dim !== cfg.dimensions ||
      (data.eos || '') !== embedEos(cfg)) return null;   // сменилась модель/размерность/EOS — индекс строится заново
    manifests.set(f, { mtimeMs: st.mtimeMs, size: st.size, data });
    return data;
  } catch { return null; }
}
// Почему манифест не подходит (для статуса): '' — подходит или его нет
export function manifestMismatch(cfg, root) {
  let data;
  try { data = JSON.parse(readFileSync(manifestFile(cfg, root), 'utf8')); } catch { return ''; }
  if (data.model !== cfg.embedModel || data.dim !== cfg.dimensions) return `построен для ${data.model} d=${data.dim}`;
  if ((data.eos || '') !== embedEos(cfg)) return data.eos ? `построен с EOS ${data.eos}` : 'построен без EOS (до исправления пулинга Qwen3-Embedding)';
  if (data.version !== MANIFEST_VERSION || data.format !== CHUNK_FORMAT) return 'старый формат';
  return '';
}
function saveManifest(cfg, root, files, extra = {}) {
  const f = manifestFile(cfg, root);
  mkdirSync(join(f, '..'), { recursive: true });
  const data = { version: MANIFEST_VERSION, format: CHUNK_FORMAT, model: cfg.embedModel, dim: cfg.dimensions, eos: embedEos(cfg),
    root: resolve(root), updated: new Date().toISOString(), ...extra, files };
  atomicWrite(f, JSON.stringify(data));
  manifests.delete(f);
}

// ---------------------------------------------------------------------------
// Фрагменты
// ---------------------------------------------------------------------------
// source: { kind:'module', file, rel, moduleId, objTitle?, objSyn?, methods } | { kind:'object', file, rel, title, syn, attrs, ts }
function clip(s, n) { return s.length > n ? `${s.slice(0, n)}\n// … (обрезано)` : s; }

export function moduleChunks(text, src, maxChars, eos = '') {
  const lines = text.split(/\r?\n/);
  const out = [];
  const head = `Модуль: ${src.moduleId}` + (src.objSyn ? `\nОбъект: ${src.objTitle} «${src.objSyn}»` : '');
  for (const m of src.methods || []) {
    const from = m.line - 1;
    // комментарий и директива компиляции над методом (в любом порядке)
    const comments = [];
    for (let i = from - 1; i >= 0 && comments.length < 16; i--) {
      const t = lines[i].trim();
      if (t.startsWith('//') || t.startsWith('&')) comments.unshift(t); else break;
    }
    const body = lines.slice(from, Math.min(lines.length, m.end)).join('\n');
    const textOut = clip(`${head}\n${comments.length ? comments.join('\n') + '\n' : ''}${body}`, maxChars);
    out.push({ h: hashText(textOut, eos), text: textOut, k: m.kind === 'Функция' ? 'f' : 'p', n: m.name, l: m.line, e: m.end,
      x: m.export ? 1 : 0 });
  }
  return out;
}

export function objectChunk(src, maxChars, eos = '') {
  const parts = [`${src.title}${src.syn && src.syn !== src.name ? ` «${src.syn}»` : ''}`];
  const fmt = ([n, s]) => (s && s !== n ? `${n} «${s}»` : n);
  if (src.attrs?.length) parts.push(`Реквизиты: ${src.attrs.map(fmt).join(', ')}`);
  for (const t of src.ts || []) parts.push(`Табличная часть ${fmt([t.name, t.syn])}: ${t.attrs.map(fmt).join(', ')}`);
  const text = clip(parts.join('\n'), maxChars);
  return { h: hashText(text, eos), text, k: 'o', n: src.title, l: 1, e: 1, x: 0 };
}

export function chunkSource(src, maxChars, readText, eos = '') {
  if (src.kind === 'object') return [objectChunk(src, maxChars, eos)];
  return moduleChunks(readText(src.file), src, maxChars, eos);
}

// ---------------------------------------------------------------------------
// Построение индекса (фоновое, инкрементальное)
// ---------------------------------------------------------------------------
const builds = new Map();   // root → состояние
export function buildState(root) { return builds.get(resolve(root)) || null; }

const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Запуск без ожидания: повторный вызов во время построения возвращает текущее состояние
export function startBuild(root, sourcesFn, cfg, opts = {}) {
  root = resolve(root);
  const cur = builds.get(root);
  if (cur?.running) return cur;
  const state = { running: true, phase: 'подготовка', done: 0, total: 0, files: 0, changed: 0, failed: 0,
    startedAt: Date.now(), finishedAt: 0, error: '', lockedBy: null, promise: null };
  builds.set(root, state);
  state.promise = runBuild(root, sourcesFn, cfg, state, opts)
    .catch((e) => { state.error = e.message || String(e); })
    .finally(() => { state.running = false; state.finishedAt = Date.now(); state.phase = state.error ? 'ошибка' : state.lockedBy ? 'занято' : 'готово'; });
  return state;
}

async function embedWithRetry(cfg, texts, state, signal) {
  let delay = 2000;
  for (let attempt = 0; ; attempt++) {
    try { return await embed(cfg, texts, { timeoutMs: cfg.buildTimeoutMs, signal }); } catch (e) {
      if (e.status && e.status >= 400 && e.status < 500) throw e;          // запрос не годится — повтор не поможет
      if (attempt >= 2 || signal?.aborted) throw e;
      state.phase = `повтор после ошибки: ${e.message}`;
      await sleep(delay); delay *= 2.5;
    }
  }
}

async function runBuild(root, sourcesFn, cfg, state, { force = false, readText, log } = {}) {
  const store = getStore(cfg);
  mkdirSync(store.dir, { recursive: true });
  const lockFile = join(store.dir, 'build.lock');
  const lock = acquireLock(lockFile);
  if (!lock) { state.lockedBy = readLock(lockFile); state.phase = 'занято'; return; }
  const ac = new AbortController();
  const hb = setInterval(() => { if (!lock.beat()) ac.abort(); }, HEARTBEAT_MS);
  hb.unref?.();
  try {
    store.refresh();
    const old = (!force && loadManifest(cfg, root)) || { files: {} };
    const sources = sourcesFn();
    state.files = sources.length;
    state.phase = 'разбор файлов';
    const files = {};
    const pending = new Map();   // хэш → текст
    let n = 0;
    for (const src of sources) {
      if (++n % 50 === 0) await tick();
      let st;
      try { st = statSync(src.file); } catch { continue; }
      const prev = old.files[src.rel];
      const same = prev && prev.m === st.mtimeMs && prev.s === st.size && prev.id === (src.moduleId || src.title);
      if (same && prev.c.every((c) => store.has(c[0]))) { files[src.rel] = prev; continue; }
      let chunks;
      try { chunks = chunkSource(src, cfg.maxChunkChars, readText, embedEos(cfg)); } catch { continue; }
      if (!same) state.changed++;
      files[src.rel] = { m: st.mtimeMs, s: st.size, id: src.moduleId || src.title, c: chunks.map((c) => [c.h, c.k, c.n, c.l, c.e, c.x]) };
      for (const c of chunks) if (!store.has(c.h)) pending.set(c.h, c.text);
    }
    const all = new Set();
    for (const f of Object.values(files)) for (const c of f.c) all.add(c[0]);
    state.total = all.size;
    state.done = all.size - pending.size;
    const changedSet = Object.keys(files).length !== Object.keys(old.files).length || state.changed > 0 || force;
    if (changedSet || !existsSync(manifestFile(cfg, root))) saveManifest(cfg, root, files, { chunks: all.size });
    state.phase = pending.size ? 'вычисление эмбеддингов' : 'готово';
    log?.(`фрагментов ${all.size}, новых ${pending.size}, изменённых файлов ${state.changed}`);
    let buf = [];
    const flush = () => { if (buf.length) { store.append(buf); buf = []; } };
    const items = [...pending.entries()];
    for (let i = 0; i < items.length; i += cfg.batchSize) {
      if (ac.signal.aborted) throw new Error('потеряна блокировка построителя');
      const batch = items.slice(i, i + cfg.batchSize);
      let vecs;
      try {
        vecs = await embedWithRetry(cfg, batch.map((b) => b[1]), state, ac.signal);
      } catch (e) {
        if (!(e.status >= 400 && e.status < 500)) throw e;
        // 4xx на пачке: по одному, слишком длинные — с усечением; совсем негодные пропускаем
        vecs = [];
        for (const [, text] of batch) {
          let v = null;
          for (const t of [text, text.slice(0, Math.floor(text.length / 2))]) {
            try { [v] = await embedWithRetry(cfg, [t], state, ac.signal); break; } catch (e2) { if (!(e2.status >= 400 && e2.status < 500)) throw e2; }
          }
          if (!v) state.failed++;
          vecs.push(v);
        }
        state.phase = 'вычисление эмбеддингов';
      }
      batch.forEach(([h], j) => { if (vecs[j]) buf.push({ h, v: vecs[j] }); });
      state.done += batch.length;
      if (buf.length >= 1024) flush();
      log?.(`${state.done}/${state.total}`);
    }
    flush();
    store.compact();
    state.phase = 'готово';
  } finally {
    clearInterval(hb);
    lock.release();
  }
}

// ---------------------------------------------------------------------------
// Векторный поиск
// ---------------------------------------------------------------------------
// → { hits: [{ rel, k, n, l, e, x, id, score }], coverage: { total, embedded } }
export async function vectorSearch(cfg, root, query, { limit = 200, filter } = {}) {
  const man = loadManifest(cfg, root);
  if (!man) return { hits: [], coverage: { total: 0, embedded: 0 }, noIndex: true };
  const store = getStore(cfg).refresh({ maxAgeMs: 10000 });
  const [qv] = await embed(cfg, [queryText(cfg, query)], { timeoutMs: cfg.timeoutMs });
  const hits = [];
  let total = 0; let embedded = 0;
  for (const [rel, f] of Object.entries(man.files)) {
    if (filter && !filter(rel, f.id)) continue;
    for (const c of f.c) {
      total++;
      const s = store.score(qv, c[0]);
      if (s === null) continue;
      embedded++;
      hits.push({ rel, h: c[0], k: c[1], n: c[2], l: c[3], e: c[4], x: c[5], id: f.id, score: s });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return { hits: hits.slice(0, limit), coverage: { total, embedded } };
}

// Reciprocal Rank Fusion: lists — массивы ключей по убыванию релевантности
export function rrf(lists, k = 60) {
  const score = new Map();
  for (const list of lists) list.forEach((key, i) => score.set(key, (score.get(key) || 0) + 1 / (k + i + 1)));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([key, s]) => ({ key, s }));
}

// ---------------------------------------------------------------------------
// Переранжирование
// ---------------------------------------------------------------------------
const rerankState = new Map();   // baseUrl|model → { maxOut, disabledUntil, reason }
function rState(cfg) {
  const key = `${cfg.rerankBackend}|${cfg.rerankBaseUrl}|${cfg.rerankModel}`;
  let s = rerankState.get(key);
  if (!s) { s = { maxOut: 1, disabledUntil: 0, reason: '' }; rerankState.set(key, s); }
  return s;
}
export function resetRerank() { rerankState.clear(); }

const logAddExp = (a, b) => (a === null ? b : b === null ? a : Math.max(a, b) + Math.log1p(Math.exp(-Math.abs(a - b))));

// Первый сгенерированный токен и его кандидаты из ответа /v1/responses
export function firstTokenLogprobs(resp) {
  for (const item of resp?.output || []) {
    if (item?.type === 'reasoning') return { thinking: true };
    if (item?.type !== 'message') continue;
    for (const c of item.content || []) {
      if (Array.isArray(c?.logprobs) && c.logprobs.length) return { first: c.logprobs[0], text: c.text || '' };
      if (typeof c?.text === 'string') return { first: null, text: c.text };
    }
  }
  return { first: null, text: '' };
}

// P(yes) = softmax(yes, no) по logprobs первого токена; отсутствующий — −10 (как в примере vLLM из карточки модели)
export function yesNoScore(first) {
  const seen = new Set();
  let ly = null; let ln = null;
  for (const e of [first, ...(first?.top_logprobs || [])]) {
    if (!e || typeof e.token !== 'string' || typeof e.logprob !== 'number') continue;
    if (seen.has(e.token)) continue;
    seen.add(e.token);
    const t = e.token.trim().toLowerCase();
    if (t === 'yes') ly = logAddExp(ly, e.logprob);
    else if (t === 'no') ln = logAddExp(ln, e.logprob);
  }
  const found = ly !== null || ln !== null;
  ly = ly ?? -10; ln = ln ?? -10;
  return { score: 1 / (1 + Math.exp(ln - ly)), found };
}

export function rerankUserMessage(cfg, query, doc) {
  return `<Instruct>: ${cfg.rerankInstruction}\n<Query>: ${query}\n<Document>: ${doc}`;
}

export function responsesBody(cfg, query, doc, maxOut) {
  return {
    model: cfg.rerankModel,
    input: [{ role: 'system', content: RERANK_SYSTEM }, { role: 'user', content: rerankUserMessage(cfg, query, doc) }],
    temperature: 0, max_output_tokens: maxOut, top_logprobs: 20,
    include: ['message.output_text.logprobs'], store: false,
  };
}

class RerankFatal extends Error {}

async function scoreLogprobs(cfg, st, query, doc, signal, timeoutMs) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let resp;
    const used = st.maxOut;
    try {
      resp = await httpJson(`${cfg.rerankBaseUrl}/responses`, { method: 'POST', apiKey: cfg.apiKey, timeoutMs, signal,
        body: responsesBody(cfg, query, doc, used) });
    } catch (e) {
      // сервер требует max_output_tokens ≥ 16 (как OpenAI) — дальше просим 16, нужен всё равно только первый токен
      if (e.status === 400 && used === 1 && /max_output_tokens|max.?tokens|minimum|at least/i.test(e.body || e.message)) { st.maxOut = 16; continue; }
      if (e.status === 404 || (e.status === 400 && /model/i.test(e.body || ''))) throw new RerankFatal(`модель ${cfg.rerankModel} недоступна (${e.message})`);
      if (e.status === 401 || e.status === 403) throw new RerankFatal(`${e.message} — нужен токен API (${cfg.apiKeyEnv})`);
      throw e;
    }
    const { first, thinking, text } = firstTokenLogprobs(resp);
    if (thinking || /^\s*<think/i.test(text || '') || /^\s*<think/i.test(first?.token || '')) {
      throw new RerankFatal('реранкер начинает ответ с <think> — в LM Studio не задан шаблон реранкера (docs/semantic-search.md, шаг «Шаблон»)');
    }
    if (!first) throw new RerankFatal('LM Studio не вернул logprobs — обновите LM Studio и движок: lms runtime update llama.cpp');
    const { score, found } = yesNoScore(first);
    if (!found) throw new RerankFatal(`первый токен «${short(first.token, 20)}», а не yes/no — проверьте шаблон и модель реранкера`);
    return score;
  }
  throw new Error('сервер отверг max_output_tokens');
}

async function rerankApi(cfg, query, docs, signal) {
  let j;
  try {
    j = await httpJson(`${cfg.rerankBaseUrl}/rerank`, { method: 'POST', apiKey: cfg.apiKey, timeoutMs: cfg.rerankTimeoutMs, signal,
      body: { model: cfg.rerankModel, query, documents: docs, top_n: docs.length } });
  } catch (e) {
    if (e.status === 404 || e.status === 501) throw new RerankFatal(`${cfg.rerankBaseUrl}/rerank не поддерживается (${e.message})`);
    throw e;
  }
  const res = j.results || j.data || [];
  const scores = new Array(docs.length).fill(null);
  for (const r of res) {
    const s = r.relevance_score ?? r.score;
    if (Number.isInteger(r.index) && r.index >= 0 && r.index < docs.length && typeof s === 'number') scores[r.index] = s;
  }
  return scores;
}

// → { scores: (число|null)[], note }
export async function rerank(cfg, query, docs) {
  const empty = (note) => ({ scores: new Array(docs.length).fill(null), note });
  if (cfg.rerankBackend === 'none' || !docs.length) return empty('');
  const st = rState(cfg);
  if (Date.now() < st.disabledUntil) return empty(`переранжирование пропущено: ${st.reason}`);
  const ac = new AbortController();
  const deadline = setTimeout(() => ac.abort(), cfg.rerankTimeoutMs);
  try {
    if (cfg.rerankBackend === 'rerank-api') {
      const scores = await rerankApi(cfg, query, docs, ac.signal);
      return { scores, note: '' };
    }
    const scores = new Array(docs.length).fill(null);
    let next = 0; let fatal = null; let lastErr = null;
    const worker = async () => {
      while (!fatal && !ac.signal.aborted) {
        const i = next++;
        if (i >= docs.length) return;
        try { scores[i] = await scoreLogprobs(cfg, st, query, docs[i], ac.signal, Math.min(20000, cfg.rerankTimeoutMs)); } catch (e) {
          if (e instanceof RerankFatal) { fatal = e; ac.abort(); return; }
          lastErr = e;
          if (e.network) { fatal = e; ac.abort(); return; }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(cfg.rerankConcurrency, docs.length) }, worker));
    if (fatal) {
      st.disabledUntil = Date.now() + 60000; st.reason = fatal.message;
      return empty(`переранжирование не выполнено: ${fatal.message}`);
    }
    const n = scores.filter((s) => s !== null).length;
    if (n < docs.length) {
      return { scores, note: `переранжировано ${n} из ${docs.length}${ac.signal.aborted ? ` (лимит ${Math.round(cfg.rerankTimeoutMs / 1000)} с)` : ''}` +
        `${lastErr ? `: ${lastErr.message}` : ''}` };
    }
    return { scores, note: '' };
  } catch (e) {
    if (e instanceof RerankFatal) { st.disabledUntil = Date.now() + 60000; st.reason = e.message; }
    return empty(`переранжирование не выполнено: ${e.message}`);
  } finally {
    clearTimeout(deadline);
  }
}
