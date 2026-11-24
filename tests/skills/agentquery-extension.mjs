#!/usr/bin/env node
// Расширение AgentQuery: состав выгрузки и подготовка языка под базу. Платформа не запускается.
//   node tests/skills/agentquery-extension.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const ext = join(repo, 'skills', 'db-install-agentquery', 'extension');
const py = spawnSync('python3', ['--version']).status === 0 ? 'python3' : 'python';
let passed = 0; let failed = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? `\n       ${String(extra).slice(0, 500)}` : ''}`); }
};

function text(path) {
  return readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
}

console.log('шаблон:');
{
  const cfg = text(join(ext, 'Configuration.xml'));
  const http = text(join(ext, 'HTTPServices', 'AgentQuery.xml'));
  const rights = text(join(ext, 'Roles', 'AQ_ОсновнаяРоль', 'Ext', 'Rights.xml'));
  const mod = text(join(ext, 'HTTPServices', 'AgentQuery', 'Ext', 'Module.bsl'));
  const canon = text(join(repo, 'mcp', 'query-db', 'AgentQuery.bsl'));
  ok(cfg.includes('<Name>AgentQuery</Name>') && cfg.includes('<ConfigurationExtensionPurpose>AddOn</ConfigurationExtensionPurpose>'), 'имя и назначение AddOn');
  ok(cfg.includes('Role.AQ_ОсновнаяРоль') && cfg.includes('<HTTPService>AgentQuery</HTTPService>'), 'роль по умолчанию и сервис в составе');
  ok(http.includes('<RootURL>agentquery</RootURL>') && http.includes('<Template>/query</Template>'), 'корневой URL и шаблон');
  ok(http.includes('<HTTPMethod>POST</HTTPMethod>') && http.includes('<Handler>QueryPOST</Handler>'), 'POST QueryPOST');
  ok(http.includes('<HTTPMethod>GET</HTTPMethod>') && http.includes('<Handler>QueryGET</Handler>'), 'GET QueryGET');
  ok(rights.includes('HTTPService.AgentQuery.URLTemplate.query.Method.POST') && rights.includes('<name>Use</name>'), 'право Use на POST');
  ok(rights.includes('Method.GET') && !rights.includes('<name>Delete</name>'), 'право Use на GET, без лишних прав');
  ok(mod.includes('Функция QueryGET') && mod.includes('Функция QueryPOST') && mod.includes('ПроверитьТолькоЧтение'), 'модуль читает и отвечает на GET');
  ok(mod.replace(/\r\n/g, '\n').trim() === canon.replace(/\r\n/g, '\n').trim(), 'модуль расширения совпадает с mcp/query-db/AgentQuery.bsl');
  ok(!/password|Пароль\s*=/i.test(cfg + http + rights + mod), 'в расширении нет пароля');
}

console.log('подготовка под выгрузку базы:');
{
  const dir = mkdtempSync(join(tmpdir(), 'agentquery-prep-'));
  const base = join(dir, 'cf');
  const langUuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  writeFileSync(join(dir, '.v8-project.json'), JSON.stringify({
    databases: [{ id: 'dev', path: join(dir, 'db'), user: 'Admin', password: 'secret-from-file', configSrc: 'cf' }],
  }));
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(base, 'Languages'), { recursive: true });
  writeFileSync(join(base, 'Configuration.xml'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20">\n'
    + '\t<Configuration uuid="11111111-2222-4333-8444-555555555555">\n\t\t<ChildObjects>\n\t\t\t<Language>Русский</Language>\n'
    + '\t\t</ChildObjects>\n\t</Configuration>\n</MetaDataObject>\n');
  writeFileSync(join(base, 'Languages', 'Русский.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20">\n`
    + `\t<Language uuid="${langUuid}">\n\t\t<Properties>\n\t\t\t<Name>Русский</Name>\n`
    + `\t\t\t<LanguageCode>ru</LanguageCode>\n\t\t</Properties>\n\t</Language>\n</MetaDataObject>\n`);
  const out = join(dir, 'out');
  const script = join(repo, 'skills', 'db-install-agentquery', 'scripts', 'db-install-agentquery.py');
  const r = spawnSync(py, [script, '-Database', 'dev', '-PrepareOnly', '-OutputDir', out], { cwd: dir, encoding: 'utf8' });
  ok(r.status === 0, 'PrepareOnly завершается 0, платформа не нужна', r.stderr || r.stdout);
  const prepared = text(join(out, 'Languages', 'Русский.xml'));
  const preparedCfg = text(join(out, 'Configuration.xml'));
  ok(prepared.includes(langUuid) && !prepared.includes('00000000-0000-0000-0000-000000000000'), 'uuid языка взят из базы', prepared);
  ok(/version="2\.20"/.test(preparedCfg), 'version формата подменён на версию базы', preparedCfg.slice(0, 200));
  ok(!(r.stdout + r.stderr).includes('secret-from-file'), 'пароль базы не попал в вывод подготовки', r.stdout);
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
