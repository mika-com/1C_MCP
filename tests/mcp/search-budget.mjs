#!/usr/bin/env node
// search_code не читает выгрузку целиком: построчно и с бюджетом, чтобы не ронять процесс.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIndex, searchCode, withinBudget } from '../../mcp/code-search.mjs';

let passed = 0; let failed = 0;
const ok = (c, n, extra) => { if (c) { passed++; console.log(`  ok   ${n}`); } else { failed++; console.log(`  FAIL ${n}${extra ? ' — ' + extra : ''}`); } };

ok(withinBudget(0, 999999, 1) && !withinBudget(10, 5, 12) && withinBudget(10, 2, 12), 'первый файл всегда, дальше — по остатку бюджета');

const root = mkdtempSync(join(tmpdir(), 'search-budget-'));
const a = join(root, 'cfg', 'CommonModules', 'А', 'Ext');
const b = join(root, 'cfg', 'CommonModules', 'Б', 'Ext');
mkdirSync(a, { recursive: true });
mkdirSync(b, { recursive: true });
writeFileSync(join(root, 'cfg', 'Configuration.xml'), '<MetaDataObject><Properties><Name>К</Name></Properties></MetaDataObject>');
writeFileSync(join(a, 'Module.bsl'), 'Процедура П()\n  // МЕТКА_ПОИСКА\nКонецПроцедуры\n');
writeFileSync(join(b, 'Module.bsl'), 'х'.repeat(4000) + '\n// МЕТКА_ВТОРАЯ\n');
const idx = buildIndex(root);
const hit = searchCode(idx, { pattern: 'МЕТКА_ПОИСКА' });
ok(/МЕТКА_ПОИСКА/.test(hit) && /Module\.bsl:2/.test(hit), 'строка находится построчным чтением', hit);
const stopped = searchCode(idx, { pattern: 'нет-такого', budgetBytes: 1 });
ok(/поиск остановлен/.test(stopped) && /path_filter/.test(stopped), 'бюджет обрывает просмотр и просит path_filter', stopped);
ok(/длиннее 180/.test(searchCode(idx, { pattern: 'a'.repeat(181), regex: true })), 'слишком длинное регулярное выражение не запускается');
rmSync(root, { recursive: true, force: true });
console.log(`\n${passed} ok, ${failed} fail`);
process.exit(failed ? 1 : 0);
