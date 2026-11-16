#!/usr/bin/env node
// register-opencode-mcp.mjs — записывает MCP-серверы 1С в конфиг OpenCode v2 (mcp.servers).
//
//   node register-opencode-mcp.mjs                  — добавить/обновить 1c-search, 1c-bsl, 1c-help (+ vrunner выключенным)
//   node register-opencode-mcp.mjs --vrunner        — то же, но vrunner-mcp включён (нужен vanessa-runner 3.x)
//   node register-opencode-mcp.mjs --remove         — удалить серверы 1С из конфига
//   node register-opencode-mcp.mjs --config <путь>  — другой конфиг (по умолчанию ~/.config/opencode/opencode.json)
//   node register-opencode-mcp.mjs --no-default-agent — не прописывать default_agent
//
// Формат OpenCode v2: серверы лежат в mcp.servers, отключение — "disabled": true (не "enabled"),
// таймауты — объект в миллисекундах { startup, catalog, execution }.
// Записи формата v1 (серверы прямо под mcp) и устаревший сервер вопросов 1c-ask из ранних установок
// удаляются: в v2 вопросы пользователю задаются встроенным инструментом question.
//
// Миграция: секция lsp.bsl, которую писали ранние версии (lsp/bsl-lsp.mjs), удаляется — OpenCode v2 LSP не
// запускает, проверку после правок делает плагин plugins/bsl-autocheck.mjs. Чужие LSP-серверы не трогаем.
//
// default_agent: "1c" — агент по умолчанию в новых сессиях. Пишется, только если default_agent ещё не задан
// (значение пользователя не перезаписываем); --remove удаляет его, только если он равен "1c". Если агента 1c
// в каком-то проекте нет, OpenCode v2 сам откатывается на build.

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const SERVERS = [
  // BSL LS поднимает JVM (~2 с и больше) — даём запас на startup (исправление из PR #7, в мс).
  // семантический поиск: эмбеддинг запроса (SEMANTIC_TIMEOUT_MS, 15 с) + реранк (SEMANTIC_RERANK_TIMEOUT_MS, 45 с), semantic_index ждёт до 50 с.
  { key: '1c-search', file: 'code-search.mjs', timeout: { startup: 10000, catalog: 10000, execution: 120000 } },
  // execution больше собственного таймаута прокси (BSL_LS_TIMEOUT_MS, 90 с): ошибку отдаёт прокси, а не обрыв.
  { key: '1c-bsl', file: 'bsl-ls.mjs', timeout: { startup: 30000, catalog: 30000, execution: 120000 } },
  // синтакс-помощник: первый вызов строит индекс справки платформы (HELP_BUILD_TIMEOUT_MS, 120 с) — запас сверху.
  { key: '1c-help', file: 'help.mjs', timeout: { startup: 10000, catalog: 10000, execution: 150000 } },
];
// vrunner-mcp запускается через run-supervised.mjs: при закрытии сеанса гасится всё дерево процессов.
export const VRUNNER = { key: 'vrunner', command: ['vrunner-mcp'], timeout: { startup: 30000, catalog: 30000 } };
export const V1_KEYS = ['1c-ask', '1c-search', '1c-bsl'];
export const STALE_SERVERS = ['1c-ask'];
export const LSP_KEY = 'bsl';
export const DEFAULT_AGENT = '1c';

// Наша ли запись lsp.bsl (ранние версии писали node …/lsp/bsl-lsp.mjs)
export function isOwnLsp(entry) {
  const cmd = Array.isArray(entry?.command) ? entry.command.join(' ') : String(entry?.command || '');
  return /bsl-lsp\.mjs/i.test(cmd);
}

// Убрать нашу запись lsp.bsl; пустую секцию lsp — целиком.
export function removeOwnLsp(config) {
  if (!config.lsp || typeof config.lsp !== 'object' || Array.isArray(config.lsp)) return config;
  if (isOwnLsp(config.lsp[LSP_KEY])) delete config.lsp[LSP_KEY];
  if (!Object.keys(config.lsp).length) delete config.lsp;
  return config;
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

// default_agent: добавить, если не задан (сразу после $schema), убрать при удалении, только если он наш.
export function applyDefaultAgent(config, { remove = false } = {}) {
  if (remove) {
    if (config.default_agent === DEFAULT_AGENT) delete config.default_agent;
    return config;
  }
  if (config.default_agent !== undefined && config.default_agent !== null && config.default_agent !== '') return config;
  const { $schema, default_agent: _drop, ...rest } = config;
  for (const k of Object.keys(config)) delete config[k];
  return Object.assign(config, $schema === undefined ? {} : { $schema }, { default_agent: DEFAULT_AGENT }, rest);
}

export function updateConfig(config, mcpDir, { remove = false, vrunner = false, defaultAgent = true } = {}) {
  const next = structuredClone(config);
  if (!next.mcp || typeof next.mcp !== 'object' || Array.isArray(next.mcp)) next.mcp = {};
  // миграция v1: серверы 1С прямо под mcp
  for (const k of V1_KEYS) delete next.mcp[k];
  if (!next.mcp.servers || typeof next.mcp.servers !== 'object') next.mcp.servers = {};
  const servers = next.mcp.servers;
  for (const k of STALE_SERVERS) delete servers[k];
  for (const s of SERVERS) {
    if (remove) delete servers[s.key];
    else if (s.key === '1c-search') {
      // Обёртка переживает падение процесса (код 134, нехватка памяти) и поднимает сервер снова (с кучей 8 ГБ).
      servers[s.key] = { type: 'local', command: ['node', join(mcpDir, 'restart-stdio.mjs'), join(mcpDir, s.file)], timeout: s.timeout };
    } else servers[s.key] = { type: 'local', command: ['node', join(mcpDir, s.file)], timeout: s.timeout };
  }
  if (remove) delete servers[VRUNNER.key];
  else {
    servers[VRUNNER.key] = { type: 'local', command: ['node', join(mcpDir, 'run-supervised.mjs'), ...VRUNNER.command], timeout: VRUNNER.timeout };
    if (!vrunner) servers[VRUNNER.key].disabled = true;
  }
  removeOwnLsp(next);
  if (defaultAgent || remove) applyDefaultAgent(next, { remove });
  return next;
}

function main() {
  const argv = process.argv.slice(2);
  const remove = argv.includes('--remove');
  const vrunner = argv.includes('--vrunner');
  const defaultAgent = !argv.includes('--no-default-agent');
  const ci = argv.indexOf('--config');
  const cfg = ci >= 0 ? resolve(argv[ci + 1]) : opencodeConfigPath();
  const beforeText = existsSync(cfg) ? readFileSync(cfg, 'utf8') : '';
  const after = updateConfig(parseConfig(beforeText), HERE, { remove, vrunner, defaultAgent });
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
    : `MCP-серверы 1С (1c-search, 1c-bsl, 1c-help, vrunner${vrunner ? '' : ' — выключен'}) записаны в ${cfg}`
      + (after.default_agent === DEFAULT_AGENT ? '; агент по умолчанию — 1c' : `; агент по умолчанию оставлен: ${after.default_agent ?? 'build'}`));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}
