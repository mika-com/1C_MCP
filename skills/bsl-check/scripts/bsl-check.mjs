#!/usr/bin/env node
// bsl-check.mjs v1.0 — проверка BSL-модулей выгрузки 1С через BSL Language Server.
// Печатает короткую сводку замечаний (по умолчанию — ошибки и предупреждения), чтобы ловить
// синтаксические ошибки до загрузки в базу. Код выхода: 0 — ошибок нет, 1 — есть ошибки,
// 2 — проверка не выполнена.
//
//   node bsl-check.mjs -Path src/cfe/МоёРасширение [-Severity Error|Warning|Information|Hint] [-Limit 60]
//   node bsl-check.mjs -Status        — где BSL LS и какая версия
//   node bsl-check.mjs -Install       — скачать/обновить BSL LS (~170 МБ) в ~/.config/opencode/tools

import { existsSync, statSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve, relative, dirname, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findBslLs, installBslLs, bslEnv, bslVersion, INSTALL_HINT } from './bsl-ls.mjs';
import { adjustForExtension, findStringLength, projectRoot } from './bsl-diag.mjs';

const LEVELS = ['Error', 'Warning', 'Information', 'Hint'];
const LEVEL_RU = { Error: 'ошибка', Warning: 'предупреждение', Information: 'замечание', Hint: 'подсказка' };

function parseArgs(argv) {
  const a = { path: null, severity: 'Warning', limit: 60, status: false, install: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^-+/, '').toLowerCase();
    const v = argv[i + 1];
    if (k === 'path' || k === 'p') { a.path = v; i++; }
    else if (k === 'severity' || k === 's') { a.severity = v; i++; }
    else if (k === 'limit' || k === 'l') { a.limit = parseInt(v, 10) || a.limit; i++; }
    else if (k === 'status') a.status = true;
    else if (k === 'install') a.install = true;
    else if (!a.path && !argv[i].startsWith('-')) a.path = argv[i];
  }
  const lvl = LEVELS.find((l) => l.toLowerCase() === String(a.severity).toLowerCase());
  a.maxLevel = LEVELS.indexOf(lvl || 'Warning');
  return a;
}

function uriToPath(uri) {
  let p = decodeURIComponent(String(uri).replace(/^file:\/\//, ''));
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);           // file:///C:/...
  return resolve(p);
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.install) {
    try {
      const f = installBslLs();
      console.log(`BSL LS установлен: ${f.path} (версия ${bslVersion(f)})`);
      return 0;
    } catch (e) {
      console.log(`Ошибка установки BSL LS: ${e.message}`);
      return 2;
    }
  }

  const found = findBslLs();
  if (!found) { console.log(INSTALL_HINT); return 2; }
  if (args.status) { console.log(`BSL LS: ${found.path}\nВерсия: ${bslVersion(found)}`); return 0; }

  if (!args.path) {
    console.log('Укажите -Path: каталог выгрузки (например src/cfe/МоёРасширение) или файл модуля .bsl');
    return 2;
  }
  const target = resolve(args.path);
  if (!existsSync(target)) { console.log(`Не найдено: ${target}`); return 2; }
  const isFile = statSync(target).isFile();
  const srcDir = isFile ? dirname(target) : target;

  const outDir = mkdtempSync(join(tmpdir(), 'bsl-check-'));
  const cmdArgs = [...found.args, 'analyze', '-s', srcDir, '-r', 'json', '-o', outDir, '-q'];
  const cfg = resolve('.bsl-language-server.json');
  if (existsSync(cfg)) cmdArgs.push('-c', cfg);
  const started = Date.now();
  const r = spawnSync(found.cmd, cmdArgs, { encoding: 'utf8', env: bslEnv(), timeout: 20 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
  const report = join(outDir, 'bsl-json.json');
  if (!existsSync(report)) {
    const tail = `${r.stderr || ''}\n${r.stdout || ''}`.split('\n').filter((s) => /error|exception|ошибк/i.test(s)).slice(-5).join('\n');
    console.log(`BSL LS не сформировал отчёт (код ${r.status}).${tail ? '\n' + tail : ''}`);
    rmSync(outDir, { recursive: true, force: true });
    return 2;
  }
  const data = JSON.parse(readFileSync(report, 'utf8').replace(/^\uFEFF/, ''));
  rmSync(outDir, { recursive: true, force: true });

  const counts = { Error: 0, Warning: 0, Information: 0, Hint: 0 };
  const rows = [];
  let files = 0;
  let hiddenMissing = 0;
  const root = projectRoot(target);
  const lengths = new Map();
  const lookup = (name) => {
    if (!root) return null;
    if (lengths.has(name)) return lengths.get(name);
    const len = findStringLength(root, name);
    lengths.set(name, len);
    return len;
  };
  for (const fi of data.fileinfos || []) {
    const file = uriToPath(fi.path);
    if (isFile && resolve(file) !== target) continue;
    files++;
    const diags = [];
    for (const d of fi.diagnostics || []) {
      const lvl = LEVELS.includes(d.severity) ? d.severity : 'Information';
      let msg = String(d.message || '').split('\n')[0];
      // Перечень ожидаемых токенов парсера модели не помогает — сокращаем.
      msg = msg.replace(/\.?\s*Ожидался один из следующих токенов:.*$/u, ' — синтаксическая ошибка');
      if (msg.length > 200) msg = msg.slice(0, 199) + '…';
      diags.push({ lvl, line: (d.range?.start?.line ?? 0) + 1, col: (d.range?.start?.character ?? 0) + 1, code: d.code, msg });
    }
    let source = '';
    try { source = readFileSync(file, 'utf8'); } catch { source = ''; }
    const adjusted = adjustForExtension(file, diags, { source, lookup });
    hiddenMissing += adjusted.hiddenMissing;
    for (const row of adjusted.rows) {
      counts[row.lvl] = (counts[row.lvl] || 0) + 1;
      if (LEVELS.indexOf(row.lvl) <= args.maxLevel) rows.push({ file, ...row });
    }
  }
  rows.sort((a, b) => LEVELS.indexOf(a.lvl) - LEVELS.indexOf(b.lvl) || a.file.localeCompare(b.file) || a.line - b.line);
  // Одинаковые замечания в одной строке (парсер иногда дублирует) — один раз.
  const seen = new Set();
  for (let i = rows.length - 1; i >= 0; i--) {
    const k = `${rows[i].file}|${rows[i].line}|${rows[i].code}|${rows[i].msg}`;
    if (seen.has(k)) rows.splice(i, 1); else seen.add(k);
  }

  const secs = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`BSL LS: проверено модулей ${files} за ${secs} с — ошибок ${counts.Error}, предупреждений ${counts.Warning}, ` +
    `замечаний ${counts.Information + counts.Hint}. Показаны уровни до «${LEVEL_RU[LEVELS[args.maxLevel]]}».`);
  if (hiddenMissing) {
    console.log(`QueryToMissingMetadata скрыто: ${hiddenMissing} — в расширении это метаданные основной конфигурации, не ошибка. Запрос из-за этого кода не переписывай.`);
  }
  if (counts.Warning && rows.some((r) => r.code === 'StringCompareInQuery')) {
    console.log('StringCompareInQuery — не стиль: перед загрузкой подтверди длину поля. Неограниченная строка в сравнении с "" роняет запрос в рантайме.');
  }
  let shown = 0;
  let lastFile = null;
  for (const row of rows) {
    if (shown >= args.limit) break;
    if (row.file !== lastFile) {
      const rel = relative(process.cwd(), row.file);
      console.log(`\n${rel.startsWith('..') ? row.file : rel.split(sep).join('/')}`);
      lastFile = row.file;
    }
    console.log(`  стр. ${row.line}:${row.col} ${LEVEL_RU[row.lvl]} [${row.code}] ${row.msg}`);
    shown++;
  }
  if (rows.length > shown) console.log(`\n… ещё ${rows.length - shown} не показано (увеличьте -Limit или сузьте -Path).`);
  if (!rows.length) console.log('Замечаний этого уровня нет.');
  return counts.Error ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}
