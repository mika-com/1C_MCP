#!/usr/bin/env node
// run-supervised.mjs — запустить внешний MCP-сервер (например vrunner-mcp) так, чтобы при закрытии stdin,
// сигнале или смерти OpenCode убивалось всё дерево его процессов (Windows — taskkill /T /F).
//   node run-supervised.mjs <команда> [аргументы...]
import { spawnSupervised } from './lib/proc-tree.mjs';

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) { process.stderr.write('Использование: node run-supervised.mjs <команда> [аргументы]\n'); process.exit(2); }
const { child } = spawnSupervised(cmd, args, {
  tag: cmd, stdio: ['pipe', 'inherit', 'inherit'], watchStdin: true,
  shell: process.platform === 'win32',   // vrunner-mcp на Windows — .cmd/.bat
});
process.stdin.pipe(child.stdin);
child.stdin.on('error', () => { /* */ });
