// make-hbk.mjs — сборка СИНТЕТИЧЕСКОГО .hbk для тестов 1c-help (вымышленный тип «Виджет»; содержимого справки 1С нет).
import { deflateRawSync } from 'node:zlib';

const SPLITTER = 0x7fffffff;
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

// files: [[имя, Buffer|string]]; central=false — без центрального каталога; dataDescriptor — флаг бита 3.
export function makeZip(files, { central = true, dataDescriptor = false } = {}) {
  const parts = []; const cd = []; let off = 0;
  for (const [name, content] of files) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const comp = deflateRawSync(data); const nameB = Buffer.from(name, 'utf8'); const crc = crc32(data);
    const flags = 0x800 | (dataDescriptor ? 0x08 : 0);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(dataDescriptor ? 0 : crc, 14); lh.writeUInt32LE(dataDescriptor ? 0 : comp.length, 18);
    lh.writeUInt32LE(dataDescriptor ? 0 : data.length, 22); lh.writeUInt16LE(nameB.length, 26);
    const dd = dataDescriptor ? Buffer.alloc(16) : Buffer.alloc(0);
    if (dataDescriptor) { dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(crc, 4); dd.writeUInt32LE(comp.length, 8); dd.writeUInt32LE(data.length, 12); }
    parts.push(lh, nameB, comp, dd);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameB.length, 28);
    ch.writeUInt32LE(off, 42);
    cd.push(ch, nameB);
    off += 30 + nameB.length + comp.length + dd.length;
  }
  if (central) {
    const cdBuf = Buffer.concat(cd); const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(off, 16);
    parts.push(cdBuf, eocd);
  }
  return Buffer.concat(parts);
}

const hex8 = (n) => n.toString(16).padStart(8, '0');
function blocksFor(size, page) { return Math.max(1, Math.ceil(size / page)); }

// Контейнер 1С 8: elements — [[имя, Buffer]]; pageSize — размер страницы блока (маленький → цепочки блоков).
export function makeContainer(elements, { pageSize = 512 } = {}) {
  const docs = [];
  const header = (name) => { const n = Buffer.from(name, 'utf16le'); const h = Buffer.alloc(20 + n.length + 4); n.copy(h, 20); return h; };
  const table = Buffer.alloc(12 * elements.length);
  docs.push(table);
  for (const [name, body] of elements) { docs.push(header(name)); docs.push(body); }
  const pos = []; let p = 16;
  for (const d of docs) { pos.push(p); p += blocksFor(d.length, pageSize) * (31 + pageSize); }
  elements.forEach((_, i) => { table.writeInt32LE(pos[1 + 2 * i], 12 * i); table.writeInt32LE(pos[2 + 2 * i], 12 * i + 4); table.writeInt32LE(SPLITTER, 12 * i + 8); });
  const out = [Buffer.alloc(16)];
  out[0].writeInt32LE(SPLITTER, 0); out[0].writeInt32LE(pageSize, 4);
  docs.forEach((d, di) => {
    const n = blocksFor(d.length, pageSize);
    for (let b = 0; b < n; b++) {
      const next = b + 1 < n ? pos[di] + (b + 1) * (31 + pageSize) : SPLITTER;
      out.push(Buffer.from(`\r\n${hex8(b === 0 ? d.length : 0)} ${hex8(pageSize)} ${hex8(next)} \r\n`, 'latin1'));
      const page = Buffer.alloc(pageSize); d.copy(page, 0, b * pageSize, Math.min(d.length, (b + 1) * pageSize)); out.push(page);
    }
  });
  return Buffer.concat(out);
}

const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
// nodes: [{ id, parent, ru, en, path, children:[] }] → текст оглавления (UTF-8 с BOM)
export function makeToc(nodes) {
  const chunk = (n) => `{${n.id},${n.parent},${n.children.length}${n.children.map((c) => `,${c}`).join('')},` +
    `{1,0,{2,0,{"ru",${q(n.ru)}},{"en",${q(n.en)}}},${q(n.path || '')}}}`;
  return '\uFEFF{' + nodes.length + ',\n' + nodes.map(chunk).join(',\n') + '\n}';
}

const page = (title, body) => `<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"></head><body>` +
  `<h1 class="V8SH_pagetitle">${title}</h1>${body}<HR></body></html>`;

// Вымышленный мини-синтакс-помощник.
export function sampleCntx() {
  const nodes = [
    { id: 1, parent: 0, ru: 'Общие объекты', en: 'Common objects', path: '' },
    { id: 2, parent: 1, ru: 'Виджет', en: 'Widget', path: 'objects/Test/Widget.html' },
    { id: 3, parent: 2, ru: 'Методы', en: 'Methods', path: '' },
    { id: 4, parent: 3, ru: 'Добавить', en: 'Add', path: 'objects/Test/Widget/methods/Add.html' },
    { id: 5, parent: 3, ru: 'НайтиЭлемент', en: 'FindItem', path: 'objects/Test/Widget/methods/FindItem.html' },
    { id: 6, parent: 2, ru: 'Свойства', en: 'Properties', path: '' },
    { id: 7, parent: 6, ru: 'Количество', en: 'Count', path: 'objects/Test/Widget/properties/Count.html' },
    { id: 8, parent: 2, ru: 'События', en: 'Events', path: '' },
    { id: 9, parent: 8, ru: 'ПриИзменении', en: 'OnChange', path: 'objects/Test/Widget/events/OnChange.html' },
    { id: 10, parent: 2, ru: 'Конструкторы', en: 'Constructors', path: '' },
    { id: 11, parent: 10, ru: 'По умолчанию', en: 'Default', path: 'objects/Test/Widget/ctors/Default.html' },
    { id: 12, parent: 0, ru: 'Глобальный контекст', en: 'Global context', path: 'objects/Global context.html' },
    { id: 13, parent: 12, ru: 'Методы', en: 'Methods', path: '' },
    { id: 14, parent: 13, ru: 'СтрокаВиджета', en: 'WidgetString', path: 'objects/Global context/methods/WidgetString.html' },
  ];
  for (const n of nodes) n.children = nodes.filter((c) => c.parent === n.id).map((c) => c.id);
  const pages = [
    ['objects/Test/Widget.html', page('Виджет (Widget)', '<p>Вымышленный тестовый тип.</p><p class="V8SH_chapter">Методы:</p><a href="v8help://SyntaxHelperContext/objects/Test/Widget/methods/Add.html">Добавить (Add)</a><br><a>НайтиЭлемент</a>')],
    ['objects/Test/Widget/methods/Add.html', page('Виджет.Добавить (Widget.Add)',
      '<p class="V8SH_chapter">Синтаксис:</p>Добавить(&lt;Имя&gt;, &lt;Вес&gt;)' +
      '<p class="V8SH_chapter">Параметры:</p><div class="V8SH_rubric">&lt;Имя&gt; (обязательный)</div>Тип: Строка.<br>Имя элемента.' +
      '<div class="V8SH_rubric">&lt;Вес&gt; (необязательный)</div>Тип: Число.<br>Значение по умолчанию: 1.' +
      '<p class="V8SH_chapter">Возвращаемое значение:</p>Тип: Булево.' +
      '<p class="V8SH_chapter">Описание:</p>Добавляет элемент в виджет.' +
      '<p class="V8SH_chapter">Доступность:</p>Сервер, толстый клиент, внешнее соединение.' +
      '<p class="V8SH_chapter">Пример:</p><table><tr><td><pre>Виджет = Новый Виджет;\nВиджет.Добавить("А", 2);</pre></td></tr></table>' +
      '<p class="V8SH_chapter">См. также:</p><a href="v8help://SyntaxHelperContext/objects/Test/Widget/methods/FindItem.html">НайтиЭлемент</a>' +
      '<div class="__SINCE_SHOW_STYLE__"><p>Доступен, начиная с версии 8.3.99.</p></div>')],
    ['objects/Test/Widget/methods/FindItem.html', page('Виджет.НайтиЭлемент (Widget.FindItem)', '<p class="V8SH_chapter">Синтаксис:</p>НайтиЭлемент(&lt;Имя&gt;)<p class="V8SH_chapter">Возвращаемое значение:</p>Тип: Строка; Неопределено.')],
    ['objects/Test/Widget/properties/Count.html', page('Виджет.Количество (Widget.Count)', '<p class="V8SH_chapter">Использование:</p>Только чтение.<p class="V8SH_chapter">Описание:</p>Тип: Число.')],
    ['objects/Test/Widget/events/OnChange.html', page('Виджет.ПриИзменении (Widget.OnChange)', '<p class="V8SH_chapter">Синтаксис:</p>ПриИзменении()')],
    ['objects/Test/Widget/ctors/Default.html', page('Виджет.По умолчанию', '<p class="V8SH_chapter">Синтаксис:</p>Новый Виджет')],
    ['objects/Global context/methods/WidgetString.html', page('СтрокаВиджета (WidgetString)', '<p class="V8SH_chapter">Синтаксис:</p>СтрокаВиджета(&lt;Виджет&gt;)<p class="V8SH_chapter">Доступность:</p>Тонкий клиент, сервер.')],
  ];
  return { nodes, pages };
}

export function sampleLang() {
  const nodes = [
    { id: 1, parent: 0, ru: 'Операторы', en: 'Statements', path: 'lang/statements.html' },
    { id: 2, parent: 1, ru: 'Повторять', en: 'Repeat', path: 'lang/Repeat.html' },
  ];
  for (const n of nodes) n.children = nodes.filter((c) => c.parent === n.id).map((c) => c.id);
  const pages = [['lang/Repeat.html', page('Повторять (Repeat)', '<p class="V8SH_chapter">Синтаксис:</p>Повторять … КонецПовтора;')]];
  return { nodes, pages };
}

export function makeHbk({ nodes, pages }, { central = true, dataDescriptor = false, pageSize = 128 } = {}) {
  const pack = makeZip([['toc', makeToc(nodes)]], { central: false });
  const storage = makeZip(pages, { central, dataDescriptor });
  return makeContainer([['PackBlock', pack], ['FileStorage', storage], ['Book', Buffer.from('{}')]], { pageSize });
}
