#!/usr/bin/env node
// Поддельный `bsl-language-server analyze -s <src> -r json -o <out>` для тестов bsl-autocheck.
// Строки с «ОШИБКА» → Error, «ПРЕДУПРЕЖДЕНИЕ» → Warning, «ЗАМЕТКА» → Information.
// «SLEEP» в файле — зависнуть (с дочерним процессом-внуком, его PID пишется в FAKE_PIDS).
import { readdirSync, statSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const arg = (k) => argv[argv.indexOf(k) + 1];
const src = arg('-s'); const out = arg('-o');
if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${process.pid}\n`);
const files = [];
const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else files.push(p); } };
walk(src);
const texts = files.map((f) => readFileSync(f, 'utf8'));
if (texts.some((t) => t.includes('SLEEP'))) {
  const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  if (process.env.FAKE_PIDS) appendFileSync(process.env.FAKE_PIDS, `${process.pid}\n${g.pid}\n`);
  setInterval(() => {}, 1000);
} else {
  const fileinfos = files.map((f, i) => ({
    path: pathToFileURL(f).href,
    diagnostics: texts[i].split('\n').flatMap((line, n) => {
      const d = [];
      if (line.includes('ПРЕДУПРЕЖДЕНИЕ')) d.push({ severity: 'Warning', code: 'LineLength', message: 'Длина строки превышает 120', range: { start: { line: n, character: 0 } } });
      if (line.includes('ОШИБКА')) d.push({ severity: 'Error', code: 'ParseError', message: "Ошибка разбора. Ожидался один из следующих токенов: ';'", range: { start: { line: n, character: 4 } } });
      if (line.includes('ЗАМЕТКА')) d.push({ severity: 'Information', code: 'Typo', message: 'Опечатка', range: { start: { line: n, character: 1 } } });
      return d;
    }),
  }));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'bsl-json.json'), '\uFEFF' + JSON.stringify({ fileinfos }));
}
