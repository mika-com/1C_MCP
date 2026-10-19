// hbk.mjs v1.0 — чтение файлов справки платформы 1С (*.hbk) без зависимостей.
// Собственная реализация по открытому описанию формата (контейнер 1С 8 — тот же, что у .cf/.epf):
//   заголовок 16 байт → блоки с ASCII-шапкой 31 байт ("\r\n<размер> <страница> <следующий> \r\n", hex)
//   → таблица элементов (адрес заголовка, адрес тела, 0x7fffffff) → элементы:
//   FileStorage (ZIP со страницами HTML), PackBlock (одна deflate-запись ZIP без каталога — оглавление
//   в скобочном формате 1С), IndexPackBlock, PackLookup, MainData, IndexMainData, Book.
// Содержимое справки 1С в репозитории не хранится: всё читается из установленной у пользователя платформы.

import { inflateRawSync, constants as Z } from 'node:zlib';

const SPLITTER = 0x7fffffff;
const BLOCK_HEADER = 31;

// ---------- контейнер ----------

function readBlockHeader(buf, pos) {
  if (pos < 0 || pos + BLOCK_HEADER > buf.length || buf[pos] !== 0x0d || buf[pos + 1] !== 0x0a) {
    throw new Error(`hbk: нет заголовка блока по смещению ${pos}`);
  }
  const hex = (o) => parseInt(buf.toString('latin1', pos + o, pos + o + 8), 16);
  return { dataSize: hex(2), pageSize: hex(11), next: hex(20), start: pos + BLOCK_HEADER };
}

// Документ контейнера: цепочка блоков; размер данных берётся из первого блока.
export function readDocument(buf, pos) {
  const first = readBlockHeader(buf, pos);
  const out = Buffer.alloc(first.dataSize);
  let block = first; let off = 0; let guard = 0;
  for (;;) {
    const len = Math.min(block.pageSize, first.dataSize - off, buf.length - block.start);
    if (len > 0) { buf.copy(out, off, block.start, block.start + len); off += len; }
    if (off >= first.dataSize || block.next === SPLITTER || ++guard > 1e6) break;
    block = readBlockHeader(buf, block.next);
  }
  return off === out.length ? out : out.subarray(0, off);
}

// Элементы контейнера: имя → смещение тела.
export function readContainer(buf) {
  if (buf.length < 16 + BLOCK_HEADER) throw new Error('hbk: файл слишком мал');
  const table = readDocument(buf, 16);
  const entries = new Map();
  for (let i = 0; i + 12 <= table.length; i += 12) {
    const headerAddr = table.readInt32LE(i);
    const bodyAddr = table.readInt32LE(i + 4);
    if (table.readInt32LE(i + 8) !== SPLITTER) break;
    const header = readDocument(buf, headerAddr);
    // дата создания (8) + дата изменения (8) + атрибуты (4) + имя UTF-16LE + 4 нулевых байта
    let name = header.toString('utf16le', 20, header.length - (header.length >= 24 ? 4 : 0));
    name = name.replace(/\0+$/, '');
    if (bodyAddr !== SPLITTER) entries.set(name, bodyAddr);
  }
  return {
    names: [...entries.keys()],
    has: (n) => entries.has(n),
    get: (n) => (entries.has(n) ? readDocument(buf, entries.get(n)) : null),
  };
}

// ---------- ZIP ----------

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

function inflate(data) {
  return inflateRawSync(data, { finishFlush: Z.Z_SYNC_FLUSH });
}

function entryData(zip, localOff, method, csize) {
  if (zip.readUInt32LE(localOff) !== SIG_LOCAL) throw new Error('zip: битая локальная запись');
  const nameLen = zip.readUInt16LE(localOff + 26);
  const extraLen = zip.readUInt16LE(localOff + 28);
  const start = localOff + 30 + nameLen + extraLen;
  const raw = csize > 0 ? zip.subarray(start, start + csize) : zip.subarray(start);
  if (method === 0) return Buffer.from(raw);
  if (method === 8) return inflate(raw);
  throw new Error(`zip: метод сжатия ${method} не поддерживается`);
}

function decodeName(b, utf8) {
  return utf8 || !/[\x80-\xff]/.test(b.toString('latin1')) ? b.toString('utf8') : new TextDecoder('ibm866').decode(b);
}

// Каталог архива: имя → { off, method, csize }. Сначала центральный каталог (EOCD); если его нет
// или он битый — перебор всех сигнатур локальных записей (так устроены часть FileStorage и PackBlock).
export function readZipIndex(zip) {
  const files = new Map();
  const min = Math.max(0, zip.length - 22 - 0xffff);
  for (let p = zip.length - 22; p >= min; p--) {
    if (zip.readUInt32LE(p) !== SIG_EOCD) continue;
    const count = zip.readUInt16LE(p + 10);
    let c = zip.readUInt32LE(p + 16);
    try {
      for (let i = 0; i < count; i++) {
        if (zip.readUInt32LE(c) !== SIG_CENTRAL) throw new Error('cd');
        const flags = zip.readUInt16LE(c + 8);
        const method = zip.readUInt16LE(c + 10);
        const csize = zip.readUInt32LE(c + 20);
        const nl = zip.readUInt16LE(c + 28); const el = zip.readUInt16LE(c + 30); const cl = zip.readUInt16LE(c + 32);
        const off = zip.readUInt32LE(c + 42);
        const name = decodeName(zip.subarray(c + 46, c + 46 + nl), flags & 0x800);
        files.set(normalizePath(name), { off, method, csize });
        c += 46 + nl + el + cl;
      }
      if (files.size) return files;
    } catch { files.clear(); }
    break;
  }
  for (let p = zip.indexOf('PK\x03\x04', 0, 'latin1'); p >= 0 && p + 30 <= zip.length; p = zip.indexOf('PK\x03\x04', p + 4, 'latin1')) {
    const flags = zip.readUInt16LE(p + 6);
    const method = zip.readUInt16LE(p + 8);
    const csize = zip.readUInt32LE(p + 18);
    const nl = zip.readUInt16LE(p + 26);
    if (p + 30 + nl > zip.length || (method !== 0 && method !== 8)) continue;
    const name = decodeName(zip.subarray(p + 30, p + 30 + nl), flags & 0x800);
    if (!name || /[\x00-\x1f]/.test(name)) continue;
    const key = normalizePath(name);
    if (!files.has(key)) files.set(key, { off: p, method, csize: flags & 0x08 ? 0 : csize });
  }
  return files;
}

export function readZipEntry(zip, info) {
  return entryData(zip, info.off, info.method, info.csize);
}

// PackBlock: первая локальная запись ZIP (каталога нет).
export function readFirstZipEntry(zip) {
  const p = zip.indexOf('PK\x03\x04', 0, 'latin1');
  if (p < 0) return inflate(zip);
  const flags = zip.readUInt16LE(p + 6);
  return entryData(zip, p, zip.readUInt16LE(p + 8), flags & 0x08 ? 0 : zip.readUInt32LE(p + 18));
}

export function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^v8help:\/\/[^/]+\//, '').replace(/^\/+/, '').replace(/#.*$/, '');
}

// ---------- оглавление (скобочный формат 1С) ----------

export function tokenize(text) {
  const tokens = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '{' || ch === '}') { tokens.push(ch); i++; continue; }
    if (ch === ',' || ch === '\uFEFF' || /\s/.test(ch)) { i++; continue; }
    if (ch === '"') {
      let s = ''; i++;
      while (i < n) {
        if (text[i] === '"') { if (text[i + 1] === '"') { s += '"'; i += 2; continue; } i++; break; }
        s += text[i++];
      }
      tokens.push({ s });
      continue;
    }
    let j = i;
    while (j < n && !/[\s{},"]/.test(text[j])) j++;
    tokens.push(text.slice(i, j));
    i = j;
  }
  return tokens;
}

// Разбор произвольного значения: число/строка/список.
function parseValue(tokens, pos) {
  const t = tokens[pos];
  if (t === '{') {
    const list = []; pos++;
    while (pos < tokens.length && tokens[pos] !== '}') { const r = parseValue(tokens, pos); list.push(r.v); pos = r.pos; }
    return { v: list, pos: pos + 1 };
  }
  if (t && typeof t === 'object') return { v: t.s, pos: pos + 1 };
  return { v: t === undefined ? undefined : (/^-?\d+$/.test(t) ? Number(t) : t), pos: pos + 1 };
}

// Узел: {id, parent, childCount, child1..childN, {n, n, {n, n, {"ru","Имя"}, {"en","Name"}}, "путь.html"}}
export function parseToc(text) {
  const tokens = tokenize(text);
  const { v: root } = parseValue(tokens, 0);
  if (!Array.isArray(root)) throw new Error('hbk: оглавление не разобрано');
  const nodes = [];
  for (const item of root.slice(1)) {
    if (!Array.isArray(item) || item.length < 4) continue;
    const [id, parent, childCount] = item;
    const cc = Number(childCount) || 0;
    const children = item.slice(3, 3 + cc);
    const props = item[3 + cc];
    let ru = ''; let en = ''; let path = '';
    if (Array.isArray(props)) {
      const names = props.find((x) => Array.isArray(x));
      if (Array.isArray(names)) {
        for (const nm of names) {
          if (!Array.isArray(nm) || nm.length < 2) continue;
          if (/^ru/i.test(nm[0]) || (!ru && nm[0] === '#')) ru = String(nm[1]); else if (/^en/i.test(nm[0])) en = String(nm[1]); else if (!ru) ru = String(nm[1]);
        }
      }
      const last = props[props.length - 1];
      if (typeof last === 'string') path = normalizePath(last);
    }
    nodes.push({ id: Number(id), parent: Number(parent), children: children.map(Number), ru: ru || en, en: en || ru, path });
  }
  return nodes;
}

// ---------- страницы HTML ----------

const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…', copy: '©' };
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const c = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(c) ? String.fromCodePoint(c) : m; }
    return ENT[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html, { code = false } = {}) {
  let s = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<div[^>]*class="?V8SH_rubric"?[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d|table)>/gi, '\n')
    .replace(/<(p|tr|li)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s).replace(/\r/g, '');
  if (code) return s.split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').replace(/^\n+|\n+$/g, '').replace(/\n{3,}/g, '\n\n');
  return s.split('\n').map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim()).filter((l, i, a) => l || (a[i - 1] && a[i - 1] !== ''))
    .join('\n').replace(/\n{2,}/g, '\n').replace(/\n- \n/g, '\n- ').trim();
}

export function decodeHtml(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.subarray(3).toString('utf8');
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  const head = bytes.subarray(0, 512).toString('latin1');
  const m = head.match(/charset=["']?([\w-]+)/i);
  const cs = (m?.[1] || 'utf-8').toLowerCase();
  try { return new TextDecoder(cs).decode(bytes); } catch { return bytes.toString('utf8'); }
}

// Страница → { title, sections: [{ name, text, code }] }.
export function parsePage(html) {
  let body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
  // сведения о версии («Доступен, начиная с версии …») — отдельной секцией
  const since = [];
  body = body.replace(/<div[^>]*class="?__SINCE_SHOW_STYLE__"?[^>]*>([\s\S]*?)<\/div>/gi, (m, t) => { since.push(htmlToText(t)); return ''; })
    .replace(/<p[^>]*class="?V8SH_versionInfo"?[^>]*>([\s\S]*?)<\/p>/gi, (m, t) => { since.push(htmlToText(t)); return ''; });
  const title = htmlToText(body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '');
  const re = /<p[^>]*class="?V8SH_chapter"?[^>]*>([\s\S]*?)<\/p>/gi;
  const marks = [];
  let m;
  while ((m = re.exec(body))) marks.push({ name: htmlToText(m[1]).replace(/:\s*$/, '').trim(), start: m.index, end: re.lastIndex });
  const sections = [];
  const firstStart = marks.length ? marks[0].start : body.length;
  const intro = body.slice(0, firstStart).replace(/<h1[\s\S]*?<\/h1>/i, '').replace(/<p[^>]*class="?V8SH_(title|heading)"?[^>]*>[\s\S]*?<\/p>/gi, '');
  const introText = htmlToText(intro);
  if (introText) sections.push({ name: 'Описание', text: introText });
  marks.forEach((mk, i) => {
    let chunk = body.slice(mk.end, i + 1 < marks.length ? marks[i + 1].start : body.length);
    chunk = chunk.replace(/<hr[^>]*>[\s\S]*$/i, '');
    const isCode = /^(пример|example)/i.test(mk.name);
    const text = htmlToText(chunk, { code: isCode });
    if (text || mk.name) sections.push({ name: mk.name, text, code: isCode });
  });
  const ver = since.filter(Boolean).join('\n');
  if (ver && !sections.some((x) => /^использование в версии/i.test(x.name))) sections.push({ name: 'Версия', text: ver });
  return { title, sections };
}
