// shell-guard.mjs — плагин OpenCode v2: запрет опасных команд 1С кодом, а не текстом промпта.
//
// Хуки (контракт OpenCode v2, тот же, что у bsl-autocheck):
// - tool.execute.before — может прервать вызов (throw). Так блокируются shell и Code Mode.
// - shell.create.before — хук оболочки не умеет отменять запуск, поэтому команда подменяется
//   на короткий отказ. Опасный процесс не стартует, даже если исключение из tool-хука проглотят.
//
// Блокируется:
// - COM-коннектор и COM-приложение любой версии (V82/V83/V85/… .COMConnector и .Application),
//   в том числе внутри запускаемого скрипта и powershell -EncodedCommand;
// - интерактивный 1cv8 / 1cv8c (ENTERPRISE, в том числе /Execute, и конфигуратор без пакетной операции);
// - загрузка и обновление конфигурации и расширений в базу вне скриптов навыков
//   (прямой /LoadConfigFromFiles, /LoadCfg, /UpdateDBCfg, /RestoreIB, ibcmd config load|import|apply
//   и ibcmd extension create|update|load);
// - команда, в которой виден пароль базы: значение из .v8-project.json (длина от 6),
//   непустой -Password / --password / --db-pwd, /P с значением, curl -u user:pass, Basic,
//   user:pass в URL. Текст отказа пароль не повторяет. Тело доверенного скрипта навыка
//   на шаблон -Password не проверяется: параметр там объявлен, значение подставляет сам скрипт;
// - чтение .v8-project.json, opencode.db и .env (кроме .env.example) через оболочку;
// - Get-Content / Select-String / cat / grep / rg по BSL и XML метаданных выгрузки.
//   Это блок, а не предупреждение: в сессиях такой обход индекса и был основной расход,
//   предупреждение команду всё равно выполняет. В ответе назван инструмент, которым
//   читать нужно (read с offset, find_method, find_usages, search_code, meta-info).
//
// Скрипты навыков (`…/skills/<навык>/scripts/…`, в том числе установленные в ~/.config/opencode/skills)
// не проверяются на запуск платформы и загрузку: это штатный пакетный путь db-*, epf-*, erf-*.
// COM в них всё равно запрещён. Пароль на командной строке навыка тоже запрещён:
// навык вызывают с -Database <id>, без -Password.
//
// Отключение — осознанное, в конфиге проекта (переменная среды важнее, как у bsl-autocheck):
//   .v8-project.json: "shellGuard": { "enabled": false }   или  "shellGuard": false
//   V8_SHELL_GUARD=0

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const ACTIVE = Symbol.for('1c-agent.shell-guard.active');
const MAX_SCRIPT_BYTES = 1024 * 1024;

const COM_PROGID = /\bV8\d*[A-Za-z0-9]*\.(?:COMConnector|Application)\b/;
const COM_ACTION = /(?:-ComObject\b|\bComObject\b|CreateObject\s*\(|GetObject\s*\(|\bwin32com\b|\bcomtypes\b|\bDispatch\s*\(|\bregsvr32\b|comcntr\.dll)/i;

const LOAD_KEY = /\/(?:LoadConfigFromFiles|LoadCfg|UpdateDBCfg|UpdateCfg|LoadConfig|RestoreIB)\b/i;
const IBCMD_MUTATION = /\bibcmd(?:\.exe)?\b[\s\S]{0,500}?\b(?:config\s+(?:load|import|apply)|extension\s+(?:create|update|load|import|delete)|infobase\s+restore)\b/i;

// Пакетные операции конфигуратора, которые не загружают конфигурацию в базу.
// Неизвестный ключ пакетным не считается: кусок пути вроде srv/db не должен пропускать GUI.
const BATCH_KEYS = new Set([
  'dumpconfigtofiles', 'dumpcfg', 'dumpdbcfg', 'dumpib',
  'checkconfig', 'checkmodules', 'checkcanapplyconfigurationextensions',
  'loadexternaldataprocessororreportfromfiles', 'dumpexternaldataprocessororreporttofiles',
  'configurationrepositoryupdate', 'configurationrepositorycommit', 'configurationrepositorydumpcfg',
  'configurationrepositorybindcfg', 'configurationrepositoryunbindcfg',
  'configurationrepositorylock', 'configurationrepositoryunlock',
  'configurationrepositoryreport', 'configurationrepositorycreate',
  'comparecfg', 'rollbackcfg',
]);

function stripJsonComments(text) {
  let out = ''; let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { out += c; if (c === '\\') out += text[++i] ?? ''; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i + 2); if (i < 0) break; i++; continue; }
    out += c;
  }
  return out.replace(/,\s*([}\]])/g, '$1');
}

const boolish = (v) => {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'boolean') return v;
  return !/^(0|false|no|off|нет)$/i.test(String(v));
};

export function loadGuardSettings(dir, env = process.env) {
  let fromFile;
  try {
    const f = resolve(dir, '.v8-project.json');
    if (existsSync(f)) {
      const proj = JSON.parse(stripJsonComments(readFileSync(f, 'utf8').replace(/^\uFEFF/, '')));
      const g = proj.shellGuard;
      if (g === false) fromFile = false;
      else if (g && typeof g === 'object' && 'enabled' in g) fromFile = boolish(g.enabled);
    }
  } catch { /* битый json — защита остаётся включённой */ }
  const fromEnv = boolish(env.V8_SHELL_GUARD);
  const enabled = fromEnv !== undefined ? fromEnv : (fromFile !== undefined ? fromFile : true);
  return { enabled };
}

export function hasCom(text) {
  const s = String(text || '');
  if (/\bregsvr32\b/i.test(s) && /comcntr/i.test(s)) return true;
  if (!COM_PROGID.test(s)) return false;
  if (COM_ACTION.test(s)) return true;
  // New-Object без -ComObject, но с ProgID рядом: New-Object V85.COMConnector
  return /\bNew-Object\b/i.test(s);
}

function hasPlatformExe(text) {
  return /1cv8(?:c|s)?\.exe\b/i.test(text)
    || /(?:^|[\\/\s"'`=&])1cv8(?:c|s)?(?=$|[\s"'`])/im.test(text);
}

export function launchesPlatform(text) {
  const s = String(text || '');
  if (!hasPlatformExe(s)) return false;
  if (/\bStart-Process\b/i.test(s)) return true;
  if (/[\\/]1cv8(?:c|s)?(?:\.exe)?["']?\s+(?:DESIGNER|CONFIG|ENTERPRISE)\b/i.test(s)) return true;
  if (/(?:^|[\n;&|])\s*&?\s*["'][^"'\n]*1cv8(?:c|s)?(?:\.exe)?["']/im.test(s)) return true;
  // $exe = '...\1cv8.exe'  …  & $exe   или  $exe DESIGNER
  if (/\$exe\b[\s\S]{0,400}?\b(?:DESIGNER|CONFIG|ENTERPRISE)\b/i.test(s) && /1cv8(?:c|s)?(?:\.exe)?/i.test(s)) return true;
  return false;
}

function slashKeys(text) {
  return [...String(text || '').matchAll(/\/([A-Za-z][A-Za-z0-9]*)/g)].map((m) => m[1].toLowerCase());
}

export function isLoadOrUpdate(text) {
  const s = String(text || '');
  if (IBCMD_MUTATION.test(s)) return true;
  if (!LOAD_KEY.test(s)) return false;
  // Ключ загрузки сам по себе (поиск, echo) — ещё не запуск. Нужен запуск платформы или ibcmd.
  return launchesPlatform(s) || /\bibcmd(?:\.exe)?\b/i.test(s);
}

export function isInteractiveLaunch(text) {
  const s = String(text || '');
  if (!launchesPlatform(s)) return false;
  if (/\bENTERPRISE\b/i.test(s)) return true;
  if (!/\b(?:DESIGNER|CONFIG)\b/i.test(s)) return true;
  if (isLoadOrUpdate(s)) return false;
  const keys = new Set(slashKeys(s));
  for (const key of BATCH_KEYS) if (keys.has(key)) return false;
  return true;
}

function decodeEncoded(command) {
  const extra = [];
  const re = /-(?:EncodedCommand|enc)\s+([A-Za-z0-9+/=]+)/gi;
  let m;
  while ((m = re.exec(command))) {
    try { extra.push(Buffer.from(m[1], 'base64').toString('utf16le')); } catch { /* не base64 */ }
  }
  return extra;
}

export function isTrustedSkillScript(file) {
  const n = String(file || '').replace(/\\/g, '/').toLowerCase();
  return /\/skills\/[^/]+\/scripts\/[^/]+\.(?:ps1|py|mjs|js)$/.test(n);
}

export function referencedScripts(command) {
  const out = [];
  const add = (p) => { if (p && !out.includes(p)) out.push(p); };
  const src = String(command || '');
  for (const m of src.matchAll(/-(?:File|f)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/gi)) add(m[1] || m[2] || m[3]);
  for (const m of src.matchAll(/\bpython(?:3)?(?:\.exe)?\s+(?:-[^\s]+\s+)*("([^"]+\.py)"|'([^']+\.py)'|(\S+\.py))/gi)) add(m[2] || m[3] || m[4]);
  for (const m of src.matchAll(/\bnode(?:\.exe)?\s+("([^"]+\.m?js)"|'([^']+\.m?js)'|(\S+\.m?js))/gi)) add(m[2] || m[3] || m[4]);
  for (const m of src.matchAll(/\boscript\s+("([^"]+\.os)"|'([^']+\.os)'|(\S+\.os))/gi)) add(m[2] || m[3] || m[4]);
  return out;
}

function isSearchOnly(command) {
  const t = String(command || '').trim();
  if (hasCom(t) || launchesPlatform(t) || IBCMD_MUTATION.test(t)) return false;
  if (passwordIssue(t, []) || readsSecretFile(t) || isMetadataScan(t)) return false;
  return /^(?:rg|grep|egrep|fgrep|ag|ugrep|findstr)\b/i.test(t) || /^git\s+grep\b/i.test(t);
}

export function collectSecrets(proj) {
  const out = [];
  const add = (value) => {
    if (typeof value === 'string' && value.length >= 6 && !out.includes(value)) out.push(value);
  };
  for (const db of proj?.databases || []) {
    add(db?.password);
    add(db?.repository?.password);
    for (const ext of db?.extensions || []) add(ext?.repository?.password);
  }
  return out;
}

export function loadSecrets(dir) {
  try {
    const f = resolve(dir, '.v8-project.json');
    if (!existsSync(f)) return [];
    const proj = JSON.parse(stripJsonComments(readFileSync(f, 'utf8').replace(/^\uFEFF/, '')));
    return collectSecrets(proj);
  } catch { return []; }
}

function nonEmpty(value) {
  const v = String(value ?? '').trim();
  return v.length > 0 && v !== "''" && v !== '""';
}

export function passwordIssue(text, secrets = []) {
  const s = String(text || '');
  const param = /(?:^|[\s;&|`])(?:-{1,2}Password|-{2}password|--db-pwd)\b(?:\s*[:=]\s*|\s+)(?:"([^"]*)"|'([^']*)'|(\S+))/gi;
  let m;
  while ((m = param.exec(s))) {
    if (nonEmpty(m[1] ?? m[2] ?? m[3])) return true;
  }
  const slashP = /(?:^|[\s;&|`])\/P(?:"([^"]*)"|'([^']*)'|(?![A-Za-z])(\S+))/g;
  while ((m = slashP.exec(s))) {
    if (nonEmpty(m[1] ?? m[2] ?? m[3])) return true;
  }
  if (/\/\/[^/\s:]+:[^/\s@]+@/.test(s)) return true;
  if (/\bcurl\b/i.test(s)) {
    const user = /(?:^|[\s;&|`])(?:-u|--user)\s+(?:"([^"]*)"|'([^']*)'|(\S+))/gi;
    while ((m = user.exec(s))) {
      const val = m[1] ?? m[2] ?? m[3] ?? '';
      if (val.includes(':') && nonEmpty(val.split(':')[1])) return true;
    }
  }
  const basic = /\bBasic\s+([A-Za-z0-9+/=]{8,})/gi;
  while ((m = basic.exec(s))) {
    try {
      const decoded = Buffer.from(m[1], 'base64').toString('utf8');
      if (/^[^\s:]{1,80}:\S{1,200}$/.test(decoded)) return true;
    } catch { /* не base64 */ }
  }
  for (const secret of secrets) {
    if (secret && s.includes(secret)) return true;
  }
  return false;
}

const READER = /(?:^|[\s;&|`(])(?:Get-Content|gc|type|cat|more|less|head|tail|Select-String|sls|findstr|grep|egrep|fgrep|rg|ag|bat|sqlite3)\b|ReadAllText|open\s*\(/i;

export function readsSecretFile(text) {
  const s = String(text || '');
  if (!READER.test(s)) return false;
  if (/\.v8-project\.json\b/i.test(s) || /\bopencode\.db\b/i.test(s)) return true;
  const envs = s.match(/\.env(?:\.[A-Za-z0-9_-]+)?/gi) || [];
  return envs.some((hit) => !/\.env\.example$/i.test(hit));
}

const SCANNER = /(?:^|[\s;&|`(])(?:Get-Content|gc|type|cat|more|less|Select-String|sls|findstr|grep|egrep|fgrep|rg|ag|Select-Xml)\b/i;
const META_DIR = /(?:^|[\s"'`\\/(])(?:Catalogs|Documents|CommonModules|InformationRegisters|AccumulationRegisters|AccountingRegisters|CalculationRegisters|DataProcessors|Enums|HTTPServices|WebServices|Subsystems|Constants|CommonForms|EventSubscriptions|ScheduledJobs|ChartsOfAccounts|ChartsOfCharacteristicTypes|ChartsOfCalculationTypes|ExchangePlans|DocumentJournals|BusinessProcesses|FilterCriteria|DefinedTypes|CommonTemplates|CommonAttributes|FunctionalOptions|XDTOPackages)[\\/]/i;
const META_FILE = /\.bsl\b|\*\.bsl\b|Configuration\.xml\b|Form\.xml\b|Rights\.xml\b/i;

export function isMetadataScan(text) {
  const s = String(text || '');
  if (!SCANNER.test(s)) return false;
  if (META_FILE.test(s)) return true;
  if (META_DIR.test(s)) return true;
  return /\bsrc[\\/]/i.test(s) && /\.xml\b/i.test(s);
}

const MESSAGES = {
  com: 'shell-guard: заблокирован COM-коннектор (любая версия платформы) или регистрация comcntr. '
    + 'Данные базы читает инструмент query_db сервера 1c-search — только ВЫБРАТЬ. '
    + 'Свой скрипт, EncodedCommand и Code Mode ту же команду не проведут.',
  interactive: 'shell-guard: заблокирован интерактивный запуск платформы (окно предприятия или конфигуратор без пакетной операции, включая /Execute своим скриптом). '
    + 'Предприятие — навык db-run, проверка в браузере — web-test (агент 1c-tester), чтение данных — query_db. '
    + 'Пакетная сборка EPF/ERF и выгрузка — навыками, не прямым запуском.',
  load: 'shell-guard: заблокирована загрузка или обновление конфигурации и расширений в базу вне навыков db-*. '
    + 'Это делают db-load-xml, db-load-cf, db-load-git, db-update, db-install-agentquery, db-cfe-admin (агент 1c-deployer). '
    + 'Прямой конфигуратор и команды автономного сервера на загрузку сюда не подходят.',
  password: 'shell-guard: в команде пароль базы или ключ доступа (-Password, /P, --password, curl -u, Basic, user:pass в URL). '
    + 'Навык вызывают с -Database <id>: скрипт сам читает user и password из .v8-project.json. '
    + 'Значение пароля в этот ответ не входит.',
  secrets: 'shell-guard: прямое чтение .v8-project.json, opencode.db или .env через оболочку заблокировано. '
    + 'Учётные данные читают навыки и MCP (query_db, odata_get) внутри своего процесса и не печатают пароль. '
    + '.env.example читать можно.',
  metadata: 'shell-guard: чтение BSL или XML метаданных через Get-Content, Select-String, cat или grep не выполняется. '
    + 'Такой обход индекса раздувает сессию, поэтому команда не запускается, а не сопровождается предупреждением. '
    + 'Код модуля — инструмент read с offset и limit, find_method, find_usages, search_code. '
    + 'Состав объекта — meta-info, find_object, object_refs. Повторять ту же команду не нужно.',
};

function withSwitch(message) {
  return `${message} Снять блокировку может только человек: "shellGuard": { "enabled": false } в .v8-project.json или переменная V8_SHELL_GUARD=0.`;
}

export function denyCommand(shell, message) {
  const sh = String(shell || '');
  const safe = String(message).replace(/'/g, "'\\''");
  if (/powershell|pwsh/i.test(sh)) {
    const ps = String(message).replace(/'/g, "''");
    return `Write-Error '${ps}'; exit 97`;
  }
  if (/(^|[\\/])cmd(\.exe)?$/i.test(sh.trim())) {
    return 'echo shell-guard: command blocked 1>&2 & exit /b 97';
  }
  return `echo '${safe}' >&2; exit 97`;
}

function readScript(file, readFile) {
  let st;
  try { st = statSync(file); } catch { return { missing: true, text: '' }; }
  if (!st.isFile()) return { missing: true, text: '' };
  if (st.size > MAX_SCRIPT_BYTES) return { tooBig: true, text: '' };
  try { return { text: readFile(file) }; } catch { return { unreadable: true, text: '' }; }
}

// null — команду можно выполнять. Иначе { code, message }.
export function inspectCommand(command, { cwd = process.cwd(), readFile, enabled = true, secrets, projectDir } = {}) {
  if (!enabled) return null;
  const cmd = String(command || '');
  if (!cmd.trim()) return null;
  const secretList = Array.isArray(secrets) ? secrets : loadSecrets(projectDir || cwd);
  const chunks = [cmd, ...decodeEncoded(cmd)];
  const line = chunks.join('\n');
  if (passwordIssue(line, secretList)) return { code: 'password', message: withSwitch(MESSAGES.password) };
  if (readsSecretFile(line)) return { code: 'secrets', message: withSwitch(MESSAGES.secrets) };
  if (isMetadataScan(line)) return { code: 'metadata', message: withSwitch(MESSAGES.metadata) };
  if (isSearchOnly(cmd)) return null;
  const untrusted = [];
  const read = readFile || ((f) => readFileSync(f, 'utf8'));
  for (const rel of referencedScripts(cmd)) {
    const file = resolve(cwd || process.cwd(), rel);
    if (isTrustedSkillScript(file)) {
      const body = readScript(file, read);
      if (body.text && hasCom(body.text)) return { code: 'com', message: withSwitch(MESSAGES.com) };
      continue;
    }
    const body = readScript(file, read);
    if (body.tooBig || body.unreadable) {
      return {
        code: 'script',
        message: withSwitch('shell-guard: скрипт не прочитан целиком, команда не запущена. Запускайте навык из каталога skills, а не копию.'),
      };
    }
    if (body.text) untrusted.push(body.text);
  }
  const all = chunks.concat(untrusted).join('\n');
  if (passwordIssue(all, secretList)) return { code: 'password', message: withSwitch(MESSAGES.password) };
  if (readsSecretFile(all)) return { code: 'secrets', message: withSwitch(MESSAGES.secrets) };
  if (hasCom(all)) return { code: 'com', message: withSwitch(MESSAGES.com) };
  if (chunks.concat(untrusted).some(isLoadOrUpdate)) return { code: 'load', message: withSwitch(MESSAGES.load) };
  if (chunks.concat(untrusted).some(isInteractiveLaunch)) return { code: 'interactive', message: withSwitch(MESSAGES.interactive) };
  return null;
}

function commandOf(input) {
  if (!input || typeof input !== 'object') return '';
  if (typeof input.command === 'string') return input.command;
  if (typeof input.cmd === 'string') return input.cmd;
  if (typeof input.code === 'string') return input.code;
  return '';
}

export function guardInput(input, opts) {
  const command = commandOf(input);
  if (!command) return null;
  return inspectCommand(command, opts);
}

export function createPlugin({ env = process.env, readFile } = {}) {
  return {
    id: '1c-agent.shell-guard',
    async setup(ctx) {
      const root = ctx?.location?.directory || process.cwd();
      const active = (globalThis[ACTIVE] ||= new Set());
      const key = process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root);
      if (active.has(key)) return undefined;
      active.add(key);

      const optsFor = (cwd) => ({
        cwd: cwd || root,
        readFile,
        enabled: loadGuardSettings(root, env).enabled,
        projectDir: root,
      });

      if (ctx.shell && typeof ctx.shell.hook === 'function') {
        try {
          await ctx.shell.hook('create.before', (event) => {
            if (!event || typeof event.command !== 'string') return;
            const hit = inspectCommand(event.command, optsFor(event.cwd));
            if (!hit) return;
            event.command = denyCommand(event.shell, hit.message);
          });
        } catch { /* хост без shell-хука */ }
      }

      if (ctx.tool && typeof ctx.tool.hook === 'function') {
        await ctx.tool.hook('execute.before', (event) => {
          const input = event?.input;
          if (!input || typeof input !== 'object') return;
          const hit = guardInput(input, optsFor(event.cwd || input.cwd));
          if (!hit) return;
          if (typeof input.command === 'string') input.command = denyCommand(event.shell || input.shell, hit.message);
          else if (typeof input.cmd === 'string') input.cmd = denyCommand(event.shell || input.shell, hit.message);
          throw new Error(hit.message);
        });
      }

      return () => { active.delete(key); };
    },
  };
}

export default createPlugin();
