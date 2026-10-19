#!/usr/bin/env node
// render-png.mjs — скриншот HTML-предпросмотра макета в PNG через Playwright (Chromium, headless).
//   node render-png.mjs <in.html> <out.png>
// Playwright ищется там же, куда его ставит web-test: <проект>/.opencode, ~/.config/opencode.
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

const [inHtml, outPng] = process.argv.slice(2);
if (!inHtml || !outPng) { console.error('Использование: node render-png.mjs <in.html> <out.png>'); process.exit(2); }
const here = dirname(fileURLToPath(import.meta.url));
const prefixes = [join(process.cwd(), '.opencode'), join(homedir(), '.config', 'opencode'),
  resolve(here, '..', '..', '..'), process.cwd()];
let pw = null;
for (const p of prefixes) {
  try { pw = createRequire(join(p, 'noop.js'))('playwright'); break; } catch { /* дальше */ }
}
if (!pw) {
  console.error('Playwright не найден. Установите: npm install --prefix "$HOME/.config/opencode" --no-fund --no-audit "playwright@^1.50.0" && npx --prefix "$HOME/.config/opencode" playwright install chromium');
  process.exit(3);
}
const browser = await pw.chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 1.5 });
  await page.goto(pathToFileURL(resolve(inHtml)).href);
  mkdirSync(dirname(resolve(outPng)), { recursive: true });
  await page.screenshot({ path: resolve(outPng), fullPage: true });
} finally {
  await browser.close();
}
