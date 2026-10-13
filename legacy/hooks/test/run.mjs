// run.mjs — тесты goose-хука support-guard на синтетических выгрузках.
// Запуск: node hooks/test/run.mjs
import { processInput } from '../support-guard.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'support-guard.mjs');
const OBJ = '11111111-2222-3333-4444-555555555555';
const CFG = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
}

// Выгрузка конфигурации: G — флаг «изменение выключено», f1 — правило объекта (0 — на замке).
function makeConfig(root, G, f1) {
  mkdirSync(join(root, 'Ext'), { recursive: true });
  mkdirSync(join(root, 'Catalogs', 'Товары', 'Ext'), { recursive: true });
  writeFileSync(join(root, 'Configuration.xml'), `<MetaDataObject><Configuration uuid="${CFG}"/></MetaDataObject>`);
  writeFileSync(join(root, 'Catalogs', 'Товары.xml'), `<MetaDataObject><Catalog uuid="${OBJ}"/></MetaDataObject>`);
  writeFileSync(join(root, 'Catalogs', 'Товары', 'Ext', 'ObjectModule.bsl'), '');
  writeFileSync(join(root, 'Ext', 'ParentConfigurations.bin'),
    `{6,${G},1,{"vendor"},${f1},0,${OBJ},0,0,${CFG},` + ' '.repeat(40) + '}');
}

const tmp = mkdtempSync(join(tmpdir(), 'goose-1c-guard-'));
try {
  const locked = join(tmp, 'locked');  makeConfig(locked, 0, 0);
  const free = join(tmp, 'free');      makeConfig(free, 0, 1);
  const ro = join(tmp, 'ro');          makeConfig(ro, 1, 1);
  const mod = (r) => join(r, 'Catalogs', 'Товары', 'Ext', 'ObjectModule.bsl');

  let r = processInput({ tool_name: 'edit', tool_input: { path: mod(locked) }, working_dir: tmp });
  check('edit объекта на замке → block', r.stdout && JSON.parse(r.stdout).decision === 'block', r.stdout);
  check('reason предлагает cfe-borrow', /cfe-borrow/.test(r.stdout));

  r = processInput({ tool_name: 'write', tool_input: { path: 'locked/Catalogs/Товары.xml' }, working_dir: tmp });
  check('write по относительному пути → block', r.stdout.includes('"block"'), r.stdout);

  r = processInput({ tool_name: 'edit', tool_input: { path: mod(free) }, working_dir: tmp });
  check('объект редактируемый → allow', r.stdout === '', r.stdout);

  r = processInput({ tool_name: 'edit', tool_input: { path: mod(ro) }, working_dir: tmp });
  check('конфигурация read-only → block с Capability on', /-Capability on/.test(r.stdout), r.stdout);

  r = processInput({ tool_name: 'text_editor', tool_input: { command: 'view', path: mod(locked) }, working_dir: tmp });
  check('text_editor view → allow', r.stdout === '');

  r = processInput({ tool_name: 'developer__text_editor', tool_input: { command: 'str_replace', path: mod(locked) }, working_dir: tmp });
  check('developer__text_editor str_replace → block', r.stdout.includes('"block"'));

  writeFileSync(join(tmp, '.v8-project.json'), JSON.stringify({ editingAllowedCheck: 'warn' }));
  r = processInput({ tool_name: 'edit', tool_input: { path: mod(locked) }, working_dir: tmp });
  check('editingAllowedCheck=warn → allow + stderr', r.stdout === '' && /ПРЕДУПРЕЖДЕНИЕ/.test(r.stderr));
  writeFileSync(join(tmp, '.v8-project.json'), JSON.stringify({ editingAllowedCheck: 'off' }));
  r = processInput({ tool_name: 'edit', tool_input: { path: mod(locked) }, working_dir: tmp });
  check('editingAllowedCheck=off → allow', r.stdout === '' && r.stderr === '');
  rmSync(join(tmp, '.v8-project.json'));

  r = processInput({ tool_name: 'edit', tool_input: { path: join(tmp, 'nowhere.txt') }, working_dir: tmp });
  check('файл вне выгрузки → allow', r.stdout === '');

  // Сквозной прогон процесса, как его запускает goose (sh -c, payload в stdin).
  const out = execFileSync('node', [HOOK], {
    input: JSON.stringify({ event: 'PreToolUse', session_id: 's', tool_name: 'edit',
      tool_input: { path: mod(locked) }, working_dir: tmp }),
  }).toString('utf8');
  check('процесс: stdout начинается с { и decision=block', out.startsWith('{') && JSON.parse(out).decision === 'block', out);
  const none = execFileSync('node', [HOOK], { input: 'не json' }).toString('utf8');
  check('процесс: мусор в stdin → пустой stdout', none === '');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
