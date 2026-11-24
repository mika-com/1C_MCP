#!/usr/bin/env node
// Права агентов: схема OpenCode v2 (action/resource/effect), последнее совпадение, секреты закрыты.
//   node tests/agents/permissions.mjs
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(here, '..', '..', '.opencode', 'agents');
let passed = 0; let failed = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ''}`); }
};

function rulesOf(file) {
  const text = readFileSync(file, 'utf8');
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  if (/\npermission:\s*\n/.test(fm[1])) return { mixed: true, rules: [] };
  const block = fm[1].split('\npermissions:\n')[1];
  if (!block) return { mixed: false, rules: [] };
  const rules = [];
  let cur = null;
  for (const line of block.split('\n')) {
    const action = line.match(/^\s*-\s+action:\s*(.+)\s*$/);
    if (action) { cur = { action: action[1].trim() }; rules.push(cur); continue; }
    const resource = line.match(/^\s+resource:\s*(.+)\s*$/);
    if (resource && cur) cur.resource = resource[1].trim().replace(/^"|"$/g, '');
    const effect = line.match(/^\s+effect:\s*(.+)\s*$/);
    if (effect && cur) cur.effect = effect[1].trim();
  }
  return { mixed: false, rules };
}

function last(rules, action, resource) {
  let found = null;
  for (const rule of rules) {
    if (rule.action === action && rule.resource === resource) found = rule.effect;
  }
  return found;
}

const files = readdirSync(dir).filter((n) => n.endsWith('.md'));
ok(files.includes('1c.md') && files.includes('1c-deployer.md') && files.includes('1c-explorer.md'), 'агенты на месте');

for (const name of files) {
  const parsed = rulesOf(join(dir, name));
  ok(parsed && !parsed.mixed && parsed.rules.length > 0 && parsed.rules.every((r) => r.action && r.resource && ['allow', 'ask', 'deny'].includes(r.effect)),
    `${name}: правила v2 action/resource/effect`, JSON.stringify(parsed?.rules?.slice(0, 2)));
  const rules = parsed.rules;
  const envDeny = rules.findIndex((r) => r.action === 'read' && r.resource === '*.env.*' && r.effect === 'deny');
  const example = rules.findIndex((r) => r.action === 'read' && r.resource === '*.env.example' && r.effect === 'allow');
  ok(envDeny >= 0 && example > envDeny, `${name}: .env.example разрешён после запрета .env.*`);
  ok(last(rules, 'read', '*.v8-project.json') === 'deny', `${name}: read .v8-project.json deny`);
  ok(last(rules, 'read', '*opencode.db') === 'deny', `${name}: read opencode.db deny`);
}

const deployer = rulesOf(join(dir, '1c-deployer.md')).rules;
const explorer = rulesOf(join(dir, '1c-explorer.md')).rules;
const main = rulesOf(join(dir, '1c.md')).rules;
ok(last(deployer, 'edit', '*') === 'deny', 'deployer не правит файлы');
ok(last(deployer, 'shell', '*db-load-*') === 'ask', 'deployer спрашивает перед db-load');
ok(last(main, 'shell', '*db-load-*') === 'deny', 'агент 1c не грузит базу');
ok(last(main, 'skill', 'db-install-agentquery') === 'deny', 'агент 1c не ставит AgentQuery сам');
ok(last(explorer, 'edit', '*') === 'deny' && last(explorer, 'execute', '*') === 'deny', 'исследователь без правок и Code Mode');
ok(last(explorer, 'skill', 'db-*') === 'deny', 'исследователь без навыков db-*');
ok(last(explorer, 'shell', 'git diff *') === 'allow' && last(explorer, 'shell', '*') === 'ask', 'исследователю git diff можно, прочий shell спрашивает');
ok(!files.some((n) => /permission:\s/.test(readFileSync(join(dir, n), 'utf8').split('\npermissions:')[0] || '')), 'старый ключ permission не смешан с v2');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
