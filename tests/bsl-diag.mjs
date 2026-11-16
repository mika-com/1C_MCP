#!/usr/bin/env node
// Поправки диагностик расширения: QueryToMissingMetadata не ошибка, сравнение с "" в запросе.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adjustForExtension, findStringLength, isExtensionFile, queryStringCompares } from '../own-skills/bsl-check/scripts/bsl-diag.mjs';
import { formatResults } from '../plugins/bsl-autocheck.mjs';

let passed = 0; let failed = 0;
const ok = (c, n, extra) => { if (c) { passed++; console.log(`  ok   ${n}`); } else { failed++; console.log(`  FAIL ${n}${extra ? ' — ' + extra : ''}`); } };

const src = [
  'Функция Характер()',
  '\tЗапрос.Текст =',
  '\t|ВЫБРАТЬ',
  '\t|\tДействия.РезультатДействияТекстом КАК Текст',
  '\t|ГДЕ',
  '\t|\tДействия.РезультатДействияТекстом <> ""',
  '\t|\tИ Код = ""',
  '\t|',
  '\t|;',
  '\tЕсли Поле = "" Тогда',
  '\t\tВозврат 1;',
  '\tКонецЕсли;',
  'КонецФункции',
].join('\n');

console.log('сравнения в запросе:');
{
  const hits = queryStringCompares(src);
  ok(hits.map((h) => h.field).join(',') === 'РезультатДействияТекстом,Код', 'только строки запроса', hits.map((h) => h.field).join(','));
  ok(!hits.some((h) => h.field === 'Поле'), 'обычное Если Поле = "" не берём');
}

const dir = mkdtempSync(join(tmpdir(), 'bsl-diag-'));
const extMod = join(dir, 'src', 'doc-ext', 'Расш', 'CommonModules', 'М', 'Ext', 'Module.bsl');
const cfMod = join(dir, 'src', 'cf', 'CommonModules', 'М', 'Ext', 'Module.bsl');
mkdirSync(join(extMod, '..'), { recursive: true });
mkdirSync(join(cfMod, '..'), { recursive: true });
writeFileSync(join(dir, '.v8-project.json'), '{}\n');
writeFileSync(join(dir, 'src', 'doc-ext', 'Расш', 'Configuration.xml'),
  '<MetaDataObject><Configuration><Properties><Name>Расш</Name><NamePrefix>Расш_</NamePrefix></Properties></Configuration></MetaDataObject>');
writeFileSync(join(dir, 'src', 'cf', 'Configuration.xml'),
  '<MetaDataObject><Configuration><Properties><Name>К</Name></Properties></Configuration></MetaDataObject>');
mkdirSync(join(dir, 'src', 'cf', 'Documents'), { recursive: true });
writeFileSync(join(dir, 'src', 'cf', 'Documents', 'Действие.xml'), [
  '<Name>РезультатДействияТекстом</Name>',
  '<v8:Type>xs:string</v8:Type><v8:StringQualifiers><v8:Length>0</v8:Length></v8:StringQualifiers>',
  '<Name>Код</Name>',
  '<v8:Type>xs:string</v8:Type><v8:StringQualifiers><v8:Length>10</v8:Length></v8:StringQualifiers>',
].join('\n'));

console.log('расширение и длина строки:');
{
  ok(isExtensionFile(extMod), 'выгрузка с NamePrefix — расширение');
  ok(!isExtensionFile(cfMod), 'основная конфигурация — не расширение');
  ok(findStringLength(dir, 'РезультатДействияТекстом') === 0, 'длина 0');
  ok(findStringLength(dir, 'Код') === 10, 'длина 10');
  const ext = adjustForExtension(extMod, [
    { lvl: 'Error', line: 1, col: 1, code: 'QueryToMissingMetadata', msg: 'нет Документ.ДействиеЗадачи' },
    { lvl: 'Error', line: 2, col: 1, code: 'ParseError', msg: 'синтаксис' },
  ], { source: src, lookup: (name) => findStringLength(dir, name) });
  ok(ext.hiddenMissing === 1 && !ext.rows.some((r) => r.code === 'QueryToMissingMetadata'), 'QueryToMissingMetadata скрыт');
  ok(ext.rows.some((r) => r.code === 'ParseError' && r.lvl === 'Error'), 'настоящая ошибка остаётся');
  const unlimited = ext.rows.find((r) => r.field === undefined && r.code === 'UnlimitedStringCompare');
  ok(unlimited && unlimited.lvl === 'Error' && /РезультатДействияТекстом/.test(unlimited.msg), 'неограниченная строка — ошибка', JSON.stringify(ext.rows.map((r) => r.code)));
  ok(!ext.rows.some((r) => r.code === 'UnlimitedStringCompare' && /Код/.test(r.msg)), 'ограниченная строка не ошибка');
  const cf = adjustForExtension(cfMod, [
    { lvl: 'Error', line: 1, col: 1, code: 'QueryToMissingMetadata', msg: 'нет' },
  ], { source: '' });
  ok(cf.hiddenMissing === 0 && cf.rows.length === 1, 'вне расширения QueryToMissingMetadata остаётся ошибкой');
  const warn = adjustForExtension(extMod, [], { source: src });
  ok(warn.rows.some((r) => r.code === 'StringCompareInQuery') && !warn.rows.some((r) => r.code === 'UnlimitedStringCompare'), 'без метаданных — предупреждение');
  const text = formatResults([{ file: extMod, status: 'ok', diags: [], hiddenMissing: 2 }], { root: dir, limit: 20 });
  ok(/QueryToMissingMetadata не показаны \(2\)/.test(text), 'автопроверка объясняет, почему код скрыт', text);
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} ok, ${failed} fail`);
process.exit(failed ? 1 : 0);
