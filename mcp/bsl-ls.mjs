#!/usr/bin/env node
// bsl-ls.mjs — запуск BSL Language Server в режиме MCP для OpenCode.
// Если BSL LS установлен (~/.config/opencode/tools/bsl-language-server, ~/.agents/tools/... или BSL_LS_PATH) — передаёт
// stdio ему: инструменты analyze_file, document_symbols, definition, find_references,
// call_hierarchy, type_info, global_member_info и др.
// Если не установлен или выключен (BSL_LS_MCP=off) — маленький сервер-заглушка с подсказкой,
// чтобы OpenCode не показывал ошибку запуска сервера в каждом сеансе.

import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { startServer } from './lib/stdio-server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// Навыки лежат в ../skills/ (клон репозитория); bsl-ls-locate.mjs рядом — запасной вариант.
const locator = [join(here, '..', 'skills', 'bsl-check', 'scripts', 'bsl-ls.mjs'), join(here, 'bsl-ls-locate.mjs')]
  .find((p) => existsSync(p));
const { findBslLs, bslEnv, INSTALL_HINT } = await import(pathToFileURL(locator).href);

const found = process.env.BSL_LS_MCP === 'off' ? null : findBslLs();

if (found) {
  const child = spawn(found.cmd, [...found.args, 'mcp'], { stdio: 'inherit', env: bslEnv() });
  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (e) => { process.stderr.write(`[bsl-ls] ${e.message}\n`); process.exit(1); });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
} else {
  const off = process.env.BSL_LS_MCP === 'off';
  startServer({
    name: 'bsl-ls-stub',
    instructions: off ? '' : 'BSL Language Server не установлен: проверка и навигация по BSL-коду недоступны.',
    tools: [{
      name: 'bsl_ls_status',
      description: 'Состояние BSL Language Server (проверка BSL-кода): как установить, если он не установлен.',
      inputSchema: { type: 'object', properties: {} },
    }],
    onCall: () => (off ? 'BSL LS отключён переменной BSL_LS_MCP=off.' : INSTALL_HINT),
  });
}
