#!/usr/bin/env node
// register-opencode-mcp.mjs — записывает локальные MCP-серверы проекта в opencode.json
//
//   node register-opencode-mcp.mjs            — добавить/обновить 1c-ask, 1c-search, 1c-bsl
//   node register-opencode-mcp.mjs --remove   — удалить их из opencode.json
//   node register-opencode-mcp.mjs --config <путь>   — другой конфиг OpenCode

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const SERVERS = [
  {
    key: '1c-ask',
    file: 'ask-user.mjs',
    timeout: 600,
  },
  {
    key: '1c-search',
    file: 'code-search.mjs',
    timeout: 600,
  },
  {
    key: '1c-bsl',
    file: 'bsl-ls.mjs',
    timeout: 300,
  },
];

function opencodeConfigPath(env = process.env) {
  const root = env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(root, 'opencode', 'opencode.json');
}

function readConfig(path) {
  if (!existsSync(path)) {
    return { $schema: 'https://opencode.ai/config.json', mcp: {} };
  }
  const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '').trim();
  if (!text) {
    return { $schema: 'https://opencode.ai/config.json', mcp: {} };
  }
  const parsed = JSON.parse(text);
  if (!parsed.$schema) parsed.$schema = 'https://opencode.ai/config.json';
  if (!parsed.mcp || typeof parsed.mcp !== 'object' || Array.isArray(parsed.mcp)) {
    parsed.mcp = {};
  }
  return parsed;
}

function serverConfig(mcpDir, item) {
  return {
    type: 'local',
    command: ['node', join(mcpDir, item.file)],
    enabled: true,
    timeout: item.timeout,
  };
}

function updateConfig(config, mcpDir, { remove = false } = {}) {
  const next = structuredClone(config);
  if (!next.mcp || typeof next.mcp !== 'object' || Array.isArray(next.mcp)) {
    next.mcp = {};
  }
  for (const item of SERVERS) {
    if (remove) {
      delete next.mcp[item.key];
    } else {
      next.mcp[item.key] = serverConfig(mcpDir, item);
    }
  }
  return next;
}

function main() {
  const argv = process.argv.slice(2);
  const remove = argv.includes('--remove');
  const ci = argv.indexOf('--config');
  const cfg = ci >= 0 ? resolve(argv[ci + 1]) : opencodeConfigPath();
  const beforeText = existsSync(cfg) ? readFileSync(cfg, 'utf8') : '';
  const before = readConfig(cfg);
  const after = updateConfig(before, HERE, { remove });
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
    : `MCP-серверы 1С (${SERVERS.map((e) => e.key).join(', ')}) записаны в ${cfg}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}
