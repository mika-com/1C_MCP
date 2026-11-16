#!/usr/bin/env node
// Текст фрейма формы: свёртка пробелов и чтение через Playwright-подобный page.
import { collapseText, readFrameTexts } from '../../skills/web-test/scripts/engine/forms/frame-text.mjs';

let passed = 0; let failed = 0;
const ok = (c, n, extra) => { if (c) { passed++; console.log(`  ok   ${n}`); } else { failed++; console.log(`  FAIL ${n}${extra ? ' — ' + extra : ''}`); } };

ok(collapseText('  А\u00a0Б  \n\n\n  В  ') === 'А Б\n\nВ', 'свёртка неразрывных пробелов и пустых строк', JSON.stringify(collapseText('  А\u00a0Б  \n\n\n  В  ')));

const page = {
  async $$() {
    return [
      {
        async evaluate(fn, prefix) {
          const node = { id: 'form2_html', offsetWidth: 400, offsetHeight: 200, parentElement: { id: 'form2_group', parentElement: null } };
          return fn(node, prefix);
        },
        async contentFrame() {
          return { async evaluate(fn) { globalThis.document = { body: { innerText: '● Согласование\n    └── Русаков' } }; return fn(); } };
        },
      },
      {
        async evaluate(fn, prefix) {
          const node = { id: 'form0_other', offsetWidth: 10, offsetHeight: 10, parentElement: null };
          return fn(node, prefix);
        },
        async contentFrame() { return null; },
      },
    ];
  },
};

const frames = await readFrameTexts(page, { formNum: 2, maxChars: 8 });
ok(frames.length === 1 && frames[0].text === '● Соглас' && frames[0].truncated, 'берётся фрейм этой формы, текст обрезается', JSON.stringify(frames));
console.log(`\n${passed} ok, ${failed} fail`);
process.exit(failed ? 1 : 0);
