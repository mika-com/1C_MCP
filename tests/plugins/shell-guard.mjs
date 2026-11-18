#!/usr/bin/env node
// Тесты плагина shell-guard: COM любой версии, интерактивный 1cv8, загрузка вне db-*, отключение в конфиге.
//   node tests/plugins/shell-guard.mjs
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as G from '../../plugins/shell-guard.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
let passed = 0; let failed = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? `\n       ${String(extra).split('\n').join('\n       ')}` : ''}`); }
};

const dir = mkdtempSync(join(tmpdir(), 'shell-guard-'));
const skill = join(dir, 'skills', 'db-load-xml', 'scripts', 'db-load-xml.ps1');
mkdirSync(dirname(skill), { recursive: true });
const skillBody = [
  "$exe = 'C:\\Program Files\\1cv8\\8.5.1.1529\\bin\\1cv8.exe'",
  "$args = @('DESIGNER','/LoadConfigFromFiles','src','/UpdateDBCfg','/DisableStartupDialogs')",
  'Start-Process -FilePath $exe -ArgumentList $args -Wait',
].join('\n');
writeFileSync(skill, skillBody);
const evil = join(dir, 'tmp_probe.ps1');
writeFileSync(evil, 'New-Object -ComObject V85.COMConnector | Out-Null\n');
const evilLoad = join(dir, 'load-ext.ps1');
writeFileSync(evilLoad, skillBody);

console.log('разбор команд:');
{
  const com83 = 'try { $c = New-Object -ComObject V83.COMConnector } catch { $_ }';
  const com85 = "$conn = New-Object -ComObject V85.COMConnector; $c = $conn.Connect('Srvr=x')";
  const py = 'python -c "import win32com; win32com.client.Dispatch(\'V82.Application\')"';
  ok(G.inspectCommand(com83)?.code === 'com', 'V83.COMConnector в команде');
  ok(G.inspectCommand(com85)?.code === 'com', 'V85.COMConnector в команде');
  ok(G.inspectCommand(py)?.code === 'com', 'win32com Dispatch V82.Application');
  ok(G.inspectCommand('regsvr32 /s comcntr.dll')?.code === 'com', 'regsvr32 comcntr.dll');
  ok(G.inspectCommand('reg query "HKCR\\V83.COMConnector\\CLSID"') === null, 'чтение реестра без создания COM не блокируется');
  ok(G.inspectCommand('rg -n "V83.COMConnector" src') === null, 'поиск строки rg не блокируется');
  ok(G.inspectCommand('Get-ChildItem "C:\\Program Files\\1cv8" -Directory') === null, 'список каталогов платформы не блокируется');
  ok(G.inspectCommand('Get-Process -Name 1cv8,1cv8c -EA SilentlyContinue') === null, 'Get-Process 1cv8 не блокируется');

  const enterprise = [
    "$exe='C:\\Program Files\\1cv8\\8.5.1.1529\\bin\\1cv8.exe'",
    "$args=@('ENTERPRISE','/S\"srv/db\"','/DisableStartupDialogs','/Execute','C:\\build\\q.epf')",
    'Start-Process -FilePath $exe -ArgumentList $args -Wait',
  ].join('\n');
  ok(G.inspectCommand(enterprise)?.code === 'interactive', 'ENTERPRISE /Execute — интерактивный запуск');
  const designerGui = "& 'C:\\Program Files\\1cv8\\8.3.27.2325\\bin\\1cv8.exe' DESIGNER /S srv/db /DisableStartupDialogs";
  ok(G.inspectCommand(designerGui)?.code === 'interactive', 'конфигуратор без пакетной операции');
  const epf = [
    "$exe='C:\\Program Files\\1cv8\\8.3.27.2325\\bin\\1cv8.exe'",
    "$args=@('DESIGNER','/LoadExternalDataProcessorOrReportFromFiles','a.xml','b.epf','/DisableStartupDialogs')",
    'Start-Process -FilePath $exe -ArgumentList $args -Wait',
  ].join('\n');
  ok(G.inspectCommand(epf) === null, 'пакетная сборка EPF напрямую не считается загрузкой в базу');
  const dump = "& 'C:\\Program Files\\1cv8\\8.3.27.2325\\bin\\1cv8.exe' DESIGNER /DumpConfigToFiles C:\\out /DisableStartupDialogs";
  ok(G.inspectCommand(dump) === null, 'выгрузка конфигурации в файлы не блокируется');

  const load = [
    "$exe='C:\\Program Files\\1cv8\\8.5.1.1529\\bin\\1cv8.exe'",
    "$args=@('DESIGNER','/S','srv/db','/LoadConfigFromFiles','C:\\src','-Extension','ИнтеграцияСДО','/DisableStartupDialogs')",
    'Start-Process -FilePath $exe -ArgumentList $args -Wait',
  ].join('\n');
  ok(G.inspectCommand(load)?.code === 'load', 'LoadConfigFromFiles расширения блокируется');
  const update = "$exe='C:\\bin\\1cv8.exe'; $args=@('DESIGNER','/UpdateDBCfg','-Extension','ИнтеграцияСДО'); Start-Process -FilePath $exe -ArgumentList $args";
  ok(G.inspectCommand(update)?.code === 'load', 'UpdateDBCfg блокируется');
  ok(G.inspectCommand('ibcmd infobase config load --db-path=C:\\db src')?.code === 'load', 'ibcmd config load блокируется');
  ok(G.inspectCommand('ibcmd infobase config extension update --name=X')?.code === 'load', 'ibcmd extension update блокируется');
  ok(G.inspectCommand('ibcmd infobase config export --out=C:\\out') === null, 'ibcmd config export не блокируется');
  ok(G.inspectCommand('ibcmd infobase dump C:\\a.dt') === null, 'ibcmd infobase dump не блокируется');

  ok(G.inspectCommand(`powershell -File "${skill}"`, { cwd: dir }) === null, 'навык db-load-xml запускать можно');
  ok(G.inspectCommand(`powershell -File "${evil}"`, { cwd: dir })?.code === 'com', 'самодельный скрипт с V85.COMConnector блокируется');
  ok(G.inspectCommand(`powershell.exe -NoProfile -File "${evilLoad}"`, { cwd: dir })?.code === 'load', 'копия загрузки вне skills/ блокируется');

  const encoded = Buffer.from('New-Object -ComObject V85.COMConnector', 'utf16le').toString('base64');
  ok(G.inspectCommand(`powershell -EncodedCommand ${encoded}`)?.code === 'com', 'EncodedCommand с COM раскодируется и блокируется');

  const comSkill = join(dir, 'skills', 'db-run', 'scripts', 'db-run.ps1');
  mkdirSync(dirname(comSkill), { recursive: true });
  writeFileSync(comSkill, 'New-Object -ComObject V83.COMConnector\n');
  ok(G.inspectCommand(`powershell -File "${comSkill}"`, { cwd: dir })?.code === 'com', 'COM внутри навыка тоже блокируется');

  ok(G.inspectCommand(com85, { enabled: false }) === null, 'enabled: false пропускает команду');
  for (const code of ['com', 'interactive', 'load']) {
    const hit = G.inspectCommand(code === 'com' ? com85 : code === 'interactive' ? enterprise : load);
    const denied = G.denyCommand('powershell', hit.message);
    ok(G.inspectCommand(denied) === null, `текст отказа (${code}) сам не блокируется`);
    ok(!/S3cret|password/i.test(hit.message), `текст отказа (${code}) без пароля`);
  }
}

console.log('конфиг:');
{
  writeFileSync(join(dir, '.v8-project.json'), '{\n // комментарий\n "shellGuard": { "enabled": false, },\n}\n');
  ok(G.loadGuardSettings(dir, {}).enabled === false, '.v8-project.json shellGuard.enabled=false');
  ok(G.loadGuardSettings(dir, { V8_SHELL_GUARD: '1' }).enabled === true, 'V8_SHELL_GUARD=1 важнее файла');
  writeFileSync(join(dir, '.v8-project.json'), '{ "shellGuard": false }\n');
  ok(G.loadGuardSettings(dir, {}).enabled === false, 'shellGuard: false');
  ok(G.loadGuardSettings(join(dir, 'missing'), {}).enabled === true, 'без файла защита включена');
}

console.log('плагин:');
{
  const root = mkdtempSync(join(tmpdir(), 'shell-guard-plugin-'));
  const plugin = G.createPlugin({ env: {} });
  const hooks = {};
  const dispose = await plugin.setup({
    location: { directory: root },
    tool: { hook: async (name, cb) => { hooks[name] = cb; return { dispose() {} }; } },
    shell: { hook: async (name, cb) => { hooks['shell:' + name] = cb; return { dispose() {} }; } },
  });
  const bad = { tool: 'shell', input: { command: 'New-Object -ComObject V85.COMConnector' } };
  let thrown = '';
  try { await hooks['execute.before'](bad); } catch (e) { thrown = e.message; }
  ok(/shell-guard:/.test(thrown) && /query_db/.test(thrown), 'tool.execute.before бросает отказ', thrown);
  ok(/shell-guard:/.test(bad.input.command) && !/COMConnector/.test(bad.input.command), 'команда shell подменена и больше не содержит COM');
  const sh = { command: "& 'C:\\1cv8\\bin\\1cv8.exe' ENTERPRISE /F C:\\db", shell: 'powershell.exe', cwd: root };
  await hooks['shell:create.before'](sh);
  ok(/Write-Error/.test(sh.command) && !/ENTERPRISE/.test(sh.command), 'shell.create.before подменяет интерактивный запуск');
  const code = { tool: 'execute', input: { code: 'const x = 1; return x;' } };
  let codeThrew = false;
  try { await hooks['execute.before'](code); } catch { codeThrew = true; }
  ok(!codeThrew && code.input.code === 'const x = 1; return x;', 'Code Mode без опасного текста не трогаем');
  const offRoot = mkdtempSync(join(tmpdir(), 'shell-guard-off-'));
  writeFileSync(join(offRoot, '.v8-project.json'), '{ "shellGuard": { "enabled": false } }');
  const hooksOff = {};
  const pluginOff = G.createPlugin({ env: {} });
  const disposeOff = await pluginOff.setup({
    location: { directory: offRoot },
    tool: { hook: async (name, cb) => { hooksOff[name] = cb; return { dispose() {} }; } },
  });
  const allowed = { input: { command: 'New-Object -ComObject V83.COMConnector' } };
  let offThrew = false;
  try { await hooksOff['execute.before'](allowed); } catch { offThrew = true; }
  ok(!offThrew && allowed.input.command.includes('COMConnector'), 'выключенный в конфиге плагин команду не меняет');
  await dispose?.();
  await disposeOff?.();
}

console.log('переходник репозитория:');
{
  const shim = await import(pathToFileURL(join(repo, '.opencode', 'plugins', 'shell-guard.js')).href);
  ok(shim.default?.id === '1c-agent.shell-guard' && typeof shim.default.setup === 'function', '.opencode/plugins/shell-guard.js');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
