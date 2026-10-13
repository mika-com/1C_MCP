#!/usr/bin/env node
// preflight.mjs — проверка окружения перед web-test: Playwright, Chromium, дисплей, доступность webUrl.
//   node preflight.mjs [id-базы|URL] [--json]
// Ничего не устанавливает: печатает, что не так и какой командой исправить. Код выхода 0 — всё готово.
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, platform } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const target = args.find((a) => !a.startsWith('--')) || '';
const root = process.cwd();
const here = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = join('build', 'reports', 'web');

const checks = [];
const add = (name, ok, detail, fix) => checks.push({ name, ok, detail, ...(fix && !ok ? { fix } : {}) });

// 1. URL базы
let url = /^https?:\/\//i.test(target) ? target : '';
let db = null;
const cfgPath = join(root, '.v8-project.json');
if (!url) {
  if (existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''));
      const dbs = cfg.databases || [];
      db = dbs.find((d) => d.id === target || (d.aliases || []).includes(target) || d.name === target)
        || dbs.find((d) => d.id === cfg.default) || dbs[0] || null;
      if (db) url = db.webUrl || `http://localhost:8081/${db.id}`;
    } catch (e) {
      add('.v8-project.json', false, `не читается: ${e.message}`, 'Исправьте JSON или пересоздайте навыком db-list');
    }
  }
}
add('URL базы', !!url, url || 'не определён', 'Укажите webUrl базы в .v8-project.json (навык db-list) или передайте URL аргументом');

// 2. Playwright: ищем в тех же префиксах, куда его ставит навык web-test
const prefixes = [join(root, '.opencode'), join(homedir(), '.config', 'opencode'), resolve(here, '..', '..', '..'), join(homedir(), '.agents'), root];
let pw = null, pwFrom = '';
for (const p of prefixes) {
  try {
    const req = createRequire(join(p, 'noop.js'));
    pw = req('playwright');
    pwFrom = p;
    break;
  } catch { /* дальше */ }
}
const npmPrefix = existsSync(join(root, '.opencode', 'skills', 'web-test')) ? '.opencode' : '"$HOME/.config/opencode"';
const installCmd = `npm install --prefix ${npmPrefix} --no-fund --no-audit "playwright@^1.50.0" && npx --prefix ${npmPrefix} playwright install chromium`;
add('Playwright', !!pw, pw ? `найден в ${pwFrom}` : 'не установлен', installCmd);

// 3. Chromium
if (pw) {
  let exe = '';
  try { exe = pw.chromium.executablePath(); } catch { /* нет */ }
  add('Chromium', !!exe && existsSync(exe), exe && existsSync(exe) ? exe : `не скачан (${exe || '?'})`, `npx --prefix ${npmPrefix} playwright install chromium`);
}

// 4. Дисплей: 1С не работает в headless, на Linux нужен X/Wayland или xvfb-run
if (platform() === 'linux') {
  const hasDisplay = !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  add('Дисплей', hasDisplay, hasDisplay ? (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) : 'нет DISPLAY',
    'Запускайте через xvfb-run -a node run.mjs ... (пакет xvfb) — web-test работает только с видимым браузером');
}

// 5. Доступность веб-клиента
if (url) {
  let ok = false, detail = '';
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    const res = await fetch(url, { signal: ctl.signal, redirect: 'manual' });
    clearTimeout(t);
    ok = res.status < 500 && res.status !== 404;
    detail = `HTTP ${res.status}`;
  } catch (e) {
    detail = e.name === 'AbortError' ? 'таймаут 8 с' : (e.cause?.code || e.message);
  }
  add('Веб-клиент', ok, `${url} — ${detail}`,
    `База не опубликована или веб-сервер не запущен: навык web-publish${db ? ` (/web-publish ${db.id})` : ''}`);
}

// 6. Каталог отчётов
try { mkdirSync(join(root, REPORT_DIR), { recursive: true }); add('Каталог отчётов', true, REPORT_DIR); }
catch (e) { add('Каталог отчётов', false, e.message); }

const ready = checks.every((c) => c.ok);
if (asJson) {
  console.log(JSON.stringify({ ready, url, reportDir: REPORT_DIR, checks }, null, 2));
} else {
  for (const c of checks) console.log(`${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}${c.fix ? `\n    → ${c.fix}` : ''}`);
  console.log(ready ? '\nГотово к web-test.' : '\nЕсть проблемы — исправьте перед запуском web-test.');
}
process.exitCode = ready ? 0 : 1;
