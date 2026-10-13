#!/usr/bin/env node
// bsl-lsp.mjs — запуск BSL Language Server в режиме LSP (stdio) для секции "lsp" конфига OpenCode.
// Ищет BSL LS так же, как MCP-сервер 1c-bsl (mcp/bsl-ls.mjs) и навык bsl-check:
// BSL_LS_PATH → ~/.config/opencode/tools/bsl-language-server → ~/.agents/tools/bsl-language-server.
// Настройки диагностик BSL LS сам берёт из .bsl-language-server.json в текущем каталоге (корень проекта).
// Память JVM — BSL_LS_XMX. При закрытии stdin, сигнале или смерти родителя убивается всё дерево процессов.
//
// ВАЖНО: OpenCode v2 принимает и сохраняет секцию "lsp", но сам языковые серверы не запускает
// (docs: Migrate from V1). Секция работает в OpenCode 1.x и пригодится, когда v2 вернёт LSP.
// Диагностику в v2 даёт MCP 1c-bsl и навык bsl-check.

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { spawnSupervised } from '../mcp/lib/proc-tree.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const locator = [join(here, '..', 'skills', 'bsl-check', 'scripts', 'bsl-ls.mjs'),
  join(here, '..', 'own-skills', 'bsl-check', 'scripts', 'bsl-ls.mjs')].find((p) => existsSync(p));
if (!locator) {
  process.stderr.write('[bsl-lsp] не найден skills/bsl-check/scripts/bsl-ls.mjs рядом с lsp/\n');
  process.exit(1);
}
const { findBslLs, bslEnv, INSTALL_HINT } = await import(pathToFileURL(locator).href);

const found = findBslLs();
if (!found) {
  process.stderr.write(`[bsl-lsp] ${INSTALL_HINT}\n`);
  process.exit(1);
}
// stdin пробрасываем через pipe, чтобы заметить его закрытие и погасить дерево
const { child } = spawnSupervised(found.cmd, [...found.args, 'lsp'], {
  tag: 'bsl-lsp', stdio: ['pipe', 'inherit', 'inherit'], env: bslEnv(), watchStdin: true,
});
process.stdin.pipe(child.stdin);
child.stdin.on('error', () => { /* */ });
