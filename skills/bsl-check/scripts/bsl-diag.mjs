// bsl-diag.mjs — поправки к диагностикам BSL Language Server для проверки расширения.
//
// QueryToMissingMetadata в каталоге расширения — не ошибка: сервер не видит метаданные
// основной конфигурации и просит «исправить» рабочий запрос. Сравнение с "" в тексте
// запроса, если поле в метаданных — строка неограниченной длины, платформа роняет уже
// в рантайме («Нельзя сравнивать поля неограниченной длины»).

import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const extRoot = new Map();

export function isExtensionFile(file) {
  let dir = dirname(file);
  for (let i = 0; i < 12; i++) {
    if (extRoot.has(dir)) {
      const known = extRoot.get(dir);
      if (known !== undefined) return known;
    } else {
      const cfg = join(dir, 'Configuration.xml');
      if (existsSync(cfg)) {
        let head = '';
        try { head = readHead(cfg, 20000); } catch { head = ''; }
        const ext = /<ConfigurationExtensionPurpose>|<NamePrefix>/.test(head);
        extRoot.set(dir, ext);
        return ext;
      }
      extRoot.set(dir, undefined);
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return /(?:^|[\\/])cfe(?:[\\/]|$)|[\\/][^\\/]*-ext[\\/]/i.test(String(file));
}

export function projectRoot(file) {
  let dir = dirname(file);
  for (let i = 0; i < 14; i++) {
    if (existsSync(join(dir, '.v8-project.json')) || existsSync(join(dir, 'src'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function readHead(file, max) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(max);
    const n = readSync(fd, buf, 0, max, 0);
    return new StringDecoder('utf8').end(buf.subarray(0, n));
  } finally { closeSync(fd); }
}

const SKIP_WALK = new Set(['Ext', 'Forms', 'Templates', 'node_modules', '.git', 'Help', 'build']);
const FIRST_DIRS = ['Documents', 'Catalogs', 'Tasks', 'BusinessProcesses', 'InformationRegisters',
  'ChartsOfCharacteristicTypes', 'DefinedTypes', 'Reports', 'DataProcessors', 'CommonAttributes'];

function walkXml(dir, acc, state) {
  if (state.files >= state.maxFiles || Date.now() > state.deadline) return;
  let list;
  try { list = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  const dirs = [];
  for (const e of list) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_WALK.has(e.name)) dirs.push(e.name); }
    else if (e.name.endsWith('.xml')) acc.push(p);
  }
  dirs.sort((a, b) => {
    const ia = FIRST_DIRS.indexOf(a);
    const ib = FIRST_DIRS.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  for (const name of dirs) {
    walkXml(join(dir, name), acc, state);
    if (state.files >= state.maxFiles || Date.now() > state.deadline) return;
  }
}

// Длина строкового реквизита с этим именем: 0 — неограниченная, >0 — ограниченная, null — не нашли.
export function findStringLength(root, fieldName, { maxFiles = 8000, timeoutMs = 15000 } = {}) {
  if (!root || !fieldName || !/^[\wА-Яа-яЁё]+$/u.test(fieldName)) return null;
  const files = [];
  const state = { files: 0, maxFiles, deadline: Date.now() + timeoutMs };
  const src = existsSync(join(root, 'src')) ? join(root, 'src') : root;
  walkXml(src, files, state);
  const needle = `<Name>${fieldName}</Name>`;
  let found = null;
  for (const file of files) {
    state.files++;
    if (state.files > maxFiles || Date.now() > state.deadline) break;
    let size = 0;
    try { size = statSync(file).size; } catch { continue; }
    if (size > 8 * 1024 * 1024) continue;
    const len = lengthNearName(file, needle);
    if (len == null) continue;
    if (len === 0) return 0;
    found = found == null ? len : Math.min(found, len);
  }
  return found;
}

function lengthNearName(file, needle) {
  const fd = openSync(file, 'r');
  const buf = Buffer.alloc(64 * 1024);
  const dec = new StringDecoder('utf8');
  let carry = '';
  let found = null;
  const take = (eof) => {
    let at = carry.indexOf(needle);
    while (at >= 0) {
      if (!eof && at + 1600 > carry.length) break;
      const window = carry.slice(at, at + 1600);
      if (/xs:string|cfg:string/i.test(window)) {
        const m = window.match(/<(?:v8:)?Length>(\d+)<\/(?:v8:)?Length>/);
        if (m) {
          const len = Number(m[1]);
          if (len === 0) return 0;
          found = found == null ? len : Math.min(found, len);
        }
      }
      at = carry.indexOf(needle, at + needle.length);
    }
    return null;
  };
  try {
    while (true) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      carry += dec.write(buf.subarray(0, n));
      if (take(false) === 0) return 0;
      if (carry.length > 8000) carry = carry.slice(-3600);
    }
    carry += dec.end();
    if (take(true) === 0) return 0;
  } finally { closeSync(fd); }
  return found;
}

// Строки запроса с сравнением поля и пустой строки. Обычный код `Если X = ""` не берём.
export function queryStringCompares(source) {
  const hits = [];
  const lines = String(source || '').split(/\r?\n/);
  const cmp = /(?:^|[^\wА-Яа-яЁё])([A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё]*)(?:\.([A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё]*))?\s*(<>|=)\s*"{2,}/u;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('|') && !/ВЫБРАТЬ|SELECT/i.test(line)) continue;
    const m = cmp.exec(line);
    if (!m) continue;
    const field = m[2] || m[1];
    if (/^(И|ИЛИ|НЕ|AND|OR|NOT|ГДЕ|WHERE|ВЫБРАТЬ|SELECT)$/i.test(field)) continue;
    hits.push({ line: i + 1, col: m.index + 1, field });
  }
  return hits;
}

const EXTENSION_FALSE_POSITIVES = new Set([
  'QueryToMissingMetadata',
  'CommonModuleInvalidType',
]);

export function adjustForExtension(file, diags, { source = '', lookup = null } = {}) {
  const ext = isExtensionFile(file);
  let hiddenMissing = 0;
  const rows = [];
  for (const d of diags || []) {
    if (ext && EXTENSION_FALSE_POSITIVES.has(d.code)) { hiddenMissing++; continue; }
    rows.push(d);
  }
  if (source) {
    for (const hit of queryStringCompares(source)) {
      let len;
      try { len = lookup ? lookup(hit.field) : undefined; } catch { len = undefined; }
      if (typeof len === 'number' && len > 0) continue;
      const confirmed = len === 0;
      rows.push({
        lvl: confirmed ? 'Error' : 'Warning',
        line: hit.line,
        col: hit.col,
        code: confirmed ? 'UnlimitedStringCompare' : 'StringCompareInQuery',
        msg: confirmed
          ? `Поле «${hit.field}» — строка неограниченной длины. Сравнение с "" в запросе падает: «Нельзя сравнивать поля неограниченной длины». Сравнивай через ВЫРАЗИТЬ(${hit.field} КАК СТРОКА(N)) или убери сравнение.`
          : `В запросе сравнение с пустой строкой (${hit.field}). Если поле неограниченной длины, платформа выбросит «Нельзя сравнивать поля неограниченной длины». Перед загрузкой проверь метаданные; для неограниченной строки — ВЫРАЗИТЬ(${hit.field} КАК СТРОКА(N)).`,
      });
    }
  }
  return { rows, hiddenMissing };
}
