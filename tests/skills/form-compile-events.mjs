#!/usr/bin/env node
// form-compile: незнакомое событие — ошибка, известное (в том числе расшифровка СКД) — успех.
//   node tests/skills/form-compile-events.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, '..', '..', 'skills', 'form-compile', 'scripts', 'form-compile.py');
const py = spawnSync('python3', ['--version']).status === 0 ? 'python3' : 'python';
const dir = mkdtempSync(join(tmpdir(), 'form-events-'));
let passed = 0; let failed = 0;
const ok = (cond, name, extra) => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? '\n       ' + String(extra).slice(0, 500) : ''}`); }
};

function compile(name, json, env = {}) {
  const jsonPath = join(dir, `${name}.json`);
  const out = join(dir, `${name}.xml`);
  writeFileSync(jsonPath, JSON.stringify(json));
  const r = spawnSync(py, [script, '-JsonPath', jsonPath, '-OutputPath', out], {
    encoding: 'utf8', cwd: dir, env: { ...process.env, ...env },
  });
  const text = `${r.stdout || ''}\n${r.stderr || ''}`;
  let xml = '';
  try { xml = readFileSync(out, 'utf8'); } catch { /* нет файла */ }
  return { code: r.status, text, xml };
}

const bad = compile('decryption', { title: 'Тест', events: { DecryptionProcessing: 'Расшифровка' } });
ok(bad.code !== 0 && /\[ERROR\] Unknown form event 'DecryptionProcessing'/.test(bad.text), 'событие формы DecryptionProcessing — ошибка', bad.text);

const good = compile('create', { title: 'Тест', events: { OnCreateAtServer: 'ПриСозданииНаСервере' } });
ok(good.code === 0 && /OnCreateAtServer/.test(good.xml) && !/\[ERROR\]/.test(good.text), 'OnCreateAtServer собирается', good.text);

const input = compile('input', {
  title: 'Тест',
  elements: [{ input: 'Ссылка', path: 'Объект.Ссылка', events: { DecryptionProcessing: 'Расшифровка' } }],
});
ok(input.code !== 0 && /\[ERROR\] Unknown input event 'DecryptionProcessing'/.test(input.text), 'событие поля DecryptionProcessing — ошибка', input.text);

const sheet = compile('sheet', {
  title: 'Тест',
  elements: [{ spreadsheet: 'Результат', path: 'Результат', events: { DetailProcessing: 'РезультатОбработкаРасшифровки' } }],
});
ok(sheet.code === 0 && /DetailProcessing/.test(sheet.xml) && !/Unknown/.test(sheet.text), 'DetailProcessing у табличного документа — штатная расшифровка', sheet.text);

const allow = compile('allow', { title: 'Тест', events: { DecryptionProcessing: 'Расшифровка' } }, { FORM_COMPILE_ALLOW_UNKNOWN_EVENTS: '1' });
ok(allow.code === 0 && /\[WARN\]/.test(allow.text) && /DecryptionProcessing/.test(allow.xml), 'FORM_COMPILE_ALLOW_UNKNOWN_EVENTS=1 — предупреждение и сборка', allow.text);

rmSync(dir, { recursive: true, force: true });
console.log(`\nform-compile events: ${passed} ok, ${failed} fail`);
process.exit(failed ? 1 : 0);
