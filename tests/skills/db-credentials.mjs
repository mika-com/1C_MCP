#!/usr/bin/env node
// Учётные данные базы: .v8-project.json и V8_DB_*, явный -Password важнее, секрет не печатается.
//   node tests/skills/db-credentials.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const epf = resolve(here, '..', '..', 'skills', 'epf-build', 'scripts', 'epf-build.py');
const py = spawnSync('python3', ['--version']).status === 0 ? 'python3' : 'python';
const dir = mkdtempSync(join(tmpdir(), 'db-cred-'));
const base = join(dir, 'base');
writeFileSync(join(dir, '.v8-project.json'), JSON.stringify({
  databases: [
    { id: 'dev', path: base, user: 'Admin', password: 'secret-from-file' },
    { id: 'empty', path: join(dir, 'empty'), user: 'FromFile', password: '' },
    { id: 'srv', server: 'srv01', ref: 'accounting', user: 'SrvUser', password: 'srv-secret' },
  ],
}));

let passed = 0; let failed = 0;
const ok = (cond, name, extra) => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? '\n       ' + String(extra).slice(0, 400) : ''}`); }
};

function run(code, env = {}) {
  const src = `
import importlib.util, json, os
from types import SimpleNamespace
os.chdir(${JSON.stringify(dir)})
spec = importlib.util.spec_from_file_location('epf_build', ${JSON.stringify(epf)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
args = SimpleNamespace(**json.loads(${JSON.stringify(JSON.stringify(code))}))
mod.apply_db_credentials(args)
print(json.dumps({'UserName': args.UserName, 'Password': args.Password, 'InfoBasePath': getattr(args, 'InfoBasePath', '')}))
`;
  const r = spawnSync(py, ['-c', src], { encoding: 'utf8', env: { ...process.env, ...env } });
  const lines = (r.stdout || '').trim().split('\n');
  const payload = lines.filter((l) => l.startsWith('{')).pop();
  const scriptOut = [...lines.filter((l) => !l.startsWith('{')), r.stderr || ''].join('\n');
  let data = null;
  try { data = JSON.parse(payload); } catch { /* ниже */ }
  return { code: r.status, data, out: scriptOut, all: `${r.stdout || ''}\n${r.stderr || ''}` };
}

const fromFile = run({ InfoBasePath: base, InfoBaseServer: '', InfoBaseRef: '', UserName: '', Password: '' });
ok(fromFile.code === 0 && fromFile.data?.UserName === 'Admin' && fromFile.data?.Password === 'secret-from-file',
  'пустые аргументы заполняются из .v8-project.json', fromFile.out);
ok(fromFile.out.includes('password from .v8-project.json') && !fromFile.out.includes('secret-from-file'),
  'источник пароля печатается, само значение — нет', fromFile.all);

const explicit = run({ InfoBasePath: base, InfoBaseServer: '', InfoBaseRef: '', UserName: 'Other', Password: 'explicit' });
ok(explicit.data?.UserName === 'Other' && explicit.data?.Password === 'explicit' && !/password from/.test(explicit.out),
  'явные -UserName и -Password не перезаписываются', explicit.out);

const quoted = run({ InfoBasePath: `"${base}"`, InfoBaseServer: '', InfoBaseRef: '', UserName: '', Password: '' });
ok(quoted.data?.Password === 'secret-from-file' && quoted.data?.InfoBasePath === base,
  'кавычки вокруг пути снимаются до поиска записи', quoted.out);

const missing = run(
  { InfoBasePath: join(dir, 'no-such'), InfoBaseServer: '', InfoBaseRef: '', UserName: '', Password: '' },
  { V8_DB_USER: 'EnvUser', V8_DB_PASSWORD: 'env-secret' },
);
ok(missing.data?.UserName === 'EnvUser' && missing.data?.Password === 'env-secret' && !missing.out.includes('env-secret'),
  'нет записи — V8_DB_USER / V8_DB_PASSWORD, секрет не в выводе скрипта', missing.all);

const emptyPwd = run(
  { InfoBasePath: join(dir, 'empty'), InfoBaseServer: '', InfoBaseRef: '', UserName: '', Password: '' },
  { V8_DB_PASSWORD: 'env-only' },
);
ok(emptyPwd.data?.UserName === 'FromFile' && emptyPwd.data?.Password === 'env-only',
  'пустой пароль в файле не затирает V8_DB_PASSWORD', emptyPwd.out);

const server = run({ InfoBasePath: '', InfoBaseServer: 'SRV01', InfoBaseRef: 'Accounting', UserName: '', Password: '' });
ok(server.data?.UserName === 'SrvUser' && server.data?.Password === 'srv-secret',
  'серверная база сопоставляется по server+ref без учёта регистра', server.out);

rmSync(dir, { recursive: true, force: true });
console.log(`\ndb credentials: ${passed} ok, ${failed} fail`);
process.exit(failed ? 1 : 0);
