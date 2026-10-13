#!/usr/bin/env node
// allure-to-junit.mjs — собрать JUnit XML из каталога результатов Allure (*-result.json).
//   node allure-to-junit.mjs <каталог-allure> <out.xml> [имя-набора]
// Нужен, чтобы из одного прогона web-test (--format=allure) получить и Allure, и JUnit для CI.
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const [dir, out, suiteName = 'web-test'] = process.argv.slice(2);
if (!dir || !out) {
  console.error('Использование: node allure-to-junit.mjs <каталог-allure> <out.xml> [имя-набора]');
  process.exit(2);
}
const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]))
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

export function convert(results, name) {
  const by = new Map();
  for (const r of results) {
    const suite = (r.labels || []).find((l) => l.name === 'suite' || l.name === 'parentSuite')?.value || name;
    if (!by.has(suite)) by.set(suite, []);
    by.get(suite).push(r);
  }
  let total = 0, failures = 0, errors = 0, skipped = 0, time = 0;
  const suites = [];
  for (const [suite, rs] of by) {
    const cases = rs.map((r) => {
      const t = Math.max(0, ((r.stop || 0) - (r.start || 0)) / 1000);
      time += t; total++;
      const msg = r.statusDetails?.message || '';
      const trace = r.statusDetails?.trace || '';
      let body = '';
      if (r.status === 'failed') { failures++; body = `<failure message="${esc(msg)}">${esc(trace || msg)}</failure>`; }
      else if (r.status === 'broken') { errors++; body = `<error message="${esc(msg)}">${esc(trace || msg)}</error>`; }
      else if (r.status === 'skipped' || r.status === 'unknown') { skipped++; body = '<skipped/>'; }
      const att = (r.attachments || []).map((a) => `[[ATTACHMENT|${a.source}]]`).join('\n');
      if (att) body += `<system-out>${esc(att)}</system-out>`;
      return `    <testcase classname="${esc(suite)}" name="${esc(r.name)}" time="${t.toFixed(3)}">${body}</testcase>`;
    });
    suites.push(`  <testsuite name="${esc(suite)}" tests="${rs.length}">\n${cases.join('\n')}\n  </testsuite>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="${esc(name)}" tests="${total}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${time.toFixed(3)}">\n${suites.join('\n')}\n</testsuites>\n`;
}

const results = readdirSync(dir).filter((f) => f.endsWith('-result.json'))
  .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, convert(results, suiteName));
const failed = results.filter((r) => r.status === 'failed' || r.status === 'broken').length;
console.log(`JUnit: ${out} — тестов ${results.length}, упало ${failed}`);
