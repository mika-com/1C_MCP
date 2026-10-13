#!/usr/bin/env node
// register-opencode-mcp.mjs — записывает MCP-серверы 1С в конфиг OpenCode v2 (mcp.servers).
//
//   node register-opencode-mcp.mjs                  — добавить/обновить 1c-search, 1c-bsl (+ vrunner выключенным)
//   node register-opencode-mcp.mjs --vrunner        — то же, но vrunner-mcp включён (нужен vanessa-runner 3.x)
//   node register-opencode-mcp.mjs --remove         — удалить серверы 1С (и LSP bsl) из конфига
//   node register-opencode-mcp.mjs --no-lsp         — не записывать секцию lsp.bsl
//   node register-opencode-mcp.mjs --config <путь>  — другой конфиг (по умолчанию ~/.config/opencode/opencode.json)
//
// Формат OpenCode v2: серверы лежат в mcp.servers, отключение — "disabled": true (не "enabled"),
// таймауты — объект в миллисекундах { startup, catalog, execution }.
// Старые записи v1 (mcp["1c-ask"], mcp["1c-search"]…) и сервер 1c-ask удаляются: в v2 вопросы
// пользователю задаются встроенным инструментом question.
//
// Дополнительно пишется lsp.bsl — BSL Language Server как языковой сервер (.bsl, .os) через lsp/bsl-lsp.mjs,
// который ищет BSL LS так же, как 1c-bsl. OpenCode v2 эту секцию принимает и сохраняет, но LSP не запускает
// (docs «Migrate from V1»); она работает в OpenCode 1.x. В v2 диагностику даёт MCP 1c-bsl / навык bsl-check.

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const SERVERS = [
  // BSL LS поднимает JVM (~2 с и больше) — даём запас на startup (исправление из PR #7, в мс).
  { key: '1c-search', file: 'code-search.mjs', timeout: { startup: 10000, catalog: 10000 } },
  { key: '1c-bsl', file: 'bsl-ls.mjs', timeout: { startup: 30000, catalog: 30000 } },
];
export const VRUNNER = { key: 'vrunner', command: ['vrunner-mcp'], timeout: { startup: 30000, catalog: 30000 } };
export const LEGACY_KEYS = ['1c-ask', '1c-search', '1c-bsl'];
export const LSP_KEY = 'bsl';
export const LSP_EXTENSIONS = ['.bsl', '.os'];

export function lspConfig(mcpDir) {
  return { command: ['node', join(mcpDir, '..', 'lsp', 'bsl-lsp.mjs')], extensions: LSP_EXTENSIONS };
}

export function opencodeConfigPath(env = process.env) {
  const root = env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(root, 'opencode', 'opencode.json');
}

function emptyConfig() {
  return { $schema: 'https://opencode.ai/config.json', mcp: { servers: {} } };
}

export function parseConfig(text) {
  text = (text || '').replace(/^\uFEFF/, '').trim();
  if (!text) return emptyConfig();
  const parsed = JSON.parse(text);
  if (!parsed.$schema) parsed.$schema = 'https://opencode.ai/config.json';
  return parsed;
}

export function updateConfig(config, mcpDir, { remove = false, vrunner = false, lsp = true } = {}) {
  const next = structuredClone(config);
  if (!next.mcp || typeof next.mcp !== 'object' || Array.isArray(next.mcp)) next.mcp = {};
  // миграция v1: серверы 1С прямо под mcp
  for (const k of LEGACY_KEYS) delete next.mcp[k];
  if (!next.mcp.servers || typeof next.mcp.servers !== 'object') next.mcp.servers = {};
  const servers = next.mcp.servers;
  delete servers['1c-ask'];
  for (const s of SERVERS) {
    if (remove) delete servers[s.key];
    else servers[s.key] = { type: 'local', command: ['node', join(mcpDir, s.file)], timeout: s.timeout };
  }
  if (remove) delete servers[VRUNNER.key];
  else {
    servers[VRUNNER.key] = { type: 'local', command: VRUNNER.command, timeout: VRUNNER.timeout };
    if (!vrunner) servers[VRUNNER.key].disabled = true;
  }
  // lsp: true/false/отсутствует — превращаем в объект, не теряя чужие серверы
  if (remove) {
    if (next.lsp && typeof next.lsp === 'object') delete next.lsp[LSP_KEY];
  } else if (lsp && next.lsp !== false) {
    if (!next.lsp || typeof next.lsp !== 'object') next.lsp = {};
    next.lsp[LSP_KEY] = lspConfig(mcpDir);
  }
  return next;
}

function main() {
  const argv = process.argv.slice(2);
  const remove = argv.includes('--remove');
  const vrunner = argv.includes('--vrunner');
  const lsp = !argv.includes('--no-lsp');
  const ci = argv.indexOf('--config');
  const cfg = ci >= 0 ? resolve(argv[ci + 1]) : opencodeConfigPath();
  const beforeText = existsSync(cfg) ? readFileSync(cfg, 'utf8') : '';
  const after = updateConfig(parseConfig(beforeText), HERE, { remove, vrunner, lsp });
  const afterText = JSON.stringify(after, null, 2) + '\n';
  if (beforeText.replace(/^\uFEFF/, '') === afterText) {
    console.log(`Без изменений: ${cfg}`);
    return 0;
  }
  mkdirSync(dirname(cfg), { recursive: true });
  if (existsSync(cfg)) copyFileSync(cfg, cfg + '.bak');
  writeFileSync(cfg, afterText, 'utf8');
  console.log(remove
    ? `MCP-серверы 1С удалены из ${cfg}`
    : `MCP-серверы 1С (1c-search, 1c-bsl, vrunner${vrunner ? '' : ' — выключен'})${lsp ? ' и LSP bsl' : ''} записаны в ${cfg}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}
