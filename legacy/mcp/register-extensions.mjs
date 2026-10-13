#!/usr/bin/env node
// register-extensions.mjs v1.0 — legacy-скрипт: регистрирует MCP-серверы плагина 1С как обычные расширения goose
// (раздел extensions в config.yaml). Так они видны в goose Desktop на экране «Расширения» с
// переключателями и работают в любой версии goose — в том числе там, где MCP-серверы из плагинов
// не подключаются.
//
//   node register-extensions.mjs            — добавить/обновить расширения 1c-ask, 1c-search, 1c-bsl
//   node register-extensions.mjs --remove   — удалить их из config.yaml
//   node register-extensions.mjs --config <путь к config.yaml>   — другой файл настроек
//
// Правит только свои записи; остальной config.yaml не трогает. Перед записью делает копию
// config.yaml.bak. goose после этого нужно перезапустить.

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const EXTENSIONS = [
  { key: '1c-ask', file: 'ask-user.mjs', timeout: 600,
    description: '1С: уточняющие вопросы формой (ask_user)' },
  { key: '1c-search', file: 'code-search.mjs', timeout: 600,
    description: '1С: поиск по выгрузке — объекты по смыслу, методы с кодом, вызовы' },
  { key: '1c-bsl', file: 'bsl-ls.mjs', timeout: 300,
    description: '1С: BSL Language Server — проверка кода, символы, ссылки, справка по типам' },
];

export function goosConfigPath(env = process.env) {
  if (env.GOOSE_PATH_ROOT) return join(env.GOOSE_PATH_ROOT, 'config', 'config.yaml');
  if (process.platform === 'win32') return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Block', 'goose', 'config', 'config.yaml');
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'goose', 'config.yaml');
}

const q = (s) => JSON.stringify(String(s));   // строка в двойных кавычках — валидный YAML

export function extensionBlock(mcpDir, disabled = new Set()) {
  const lines = [];
  for (const e of EXTENSIONS) {
    lines.push(
      `  ${e.key}:`,
      `    enabled: ${!disabled.has(e.key)}`,
      '    type: stdio',
      `    name: ${q(e.key)}`,
      `    description: ${q(e.description)}`,
      `    cmd: ${q('node')}`,
      `    args: [${q(join(mcpDir, e.file))}]`,
      '    envs: {}',
      '    env_keys: []',
      `    timeout: ${e.timeout}`,
      '    bundled: false',
    );
  }
  return lines;
}

// Удалить свои записи из раздела extensions (запись = строка «  ключ:» и всё глубже 2 пробелов).
// Запоминает, какие из них пользователь выключил в goose, — переустановка их не включит.
export function stripOwn(lines, disabled = new Set()) {
  const keys = new Set(EXTENSIONS.map((e) => e.key));
  const out = [];
  let inExt = false;
  let skipping = null;
  for (const line of lines) {
    if (/^\S/.test(line)) { inExt = /^extensions:\s*(\{\s*\})?\s*$/.test(line); skipping = null; out.push(line); continue; }
    if (inExt) {
      const m = line.match(/^ {2}(["']?)([^"':\s]+)\1:\s*$/);
      if (m) skipping = keys.has(m[2]) ? m[2] : null;
      else if (/^ {0,2}\S/.test(line)) skipping = null;
      if (skipping) {
        if (/^ {4}enabled:\s*false\s*$/.test(line)) disabled.add(skipping);
        continue;
      }
    }
    out.push(line);
  }
  return out;
}

export function updateConfig(text, mcpDir, { remove = false } = {}) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let lines = text.length ? text.split(/\r?\n/) : [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const disabled = new Set();
  lines = stripOwn(lines, disabled);
  const i = lines.findIndex((l) => /^extensions:\s*(\{\s*\})?\s*$/.test(l));
  if (remove) {
    // раздел опустел — пишем {}, иначе YAML прочитает его как null
    if (i >= 0 && !/^ /.test(lines[i + 1] ?? '')) lines[i] = 'extensions: {}';
  } else {
    const block = extensionBlock(mcpDir, disabled);
    if (i >= 0) {
      lines[i] = 'extensions:';
      lines.splice(i + 1, 0, ...block);
    } else {
      lines.push('extensions:', ...block);
    }
  }
  return lines.join(eol) + eol;
}

function main() {
  const argv = process.argv.slice(2);
  const remove = argv.includes('--remove');
  const ci = argv.indexOf('--config');
  const cfg = ci >= 0 ? resolve(argv[ci + 1]) : goosConfigPath();
  const mcpDir = HERE;
  const before = existsSync(cfg) ? readFileSync(cfg, 'utf8').replace(/^﻿/, '') : '';
  const after = updateConfig(before, mcpDir, { remove });
  if (after === before) { console.log(`Без изменений: ${cfg}`); return 0; }
  mkdirSync(dirname(cfg), { recursive: true });
  if (before) copyFileSync(cfg, cfg + '.bak');
  writeFileSync(cfg, after, 'utf8');
  console.log(remove
    ? `Расширения 1С удалены из ${cfg}`
    : `Расширения 1С (${EXTENSIONS.map((e) => e.key).join(', ')}) записаны в ${cfg}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}
