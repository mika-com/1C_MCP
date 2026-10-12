// bsl-ls.mjs v1.0 — поиск и установка BSL Language Server для навыков 1С в goose.
// Используется навыком bsl-check и MCP-сервером mcp/bsl-ls.mjs.
// BSL LS: https://github.com/1c-syntax/bsl-language-server (LGPL-3.0), ставится отдельно,
// в репозиторий не входит.

import { existsSync, statSync, readdirSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

export const TOOLS_DIR = join(homedir(), '.config', 'opencode', 'tools', 'bsl-language-server');
export const LEGACY_TOOLS_DIR = join(homedir(), '.agents', 'tools', 'bsl-language-server');
const RELEASE_URL = 'https://github.com/1c-syntax/bsl-language-server/releases/latest/download/';
const ASSETS = { win32: 'bsl-language-server_win.zip', linux: 'bsl-language-server_nix.zip', darwin: 'bsl-language-server_mac.zip' };

function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

function hasCommand(cmd) {
  const r = spawnSync(IS_WIN ? 'where' : 'which', [cmd], { stdio: 'ignore' });
  return r.status === 0;
}

// Окружение: на Linux/macOS Java без UTF-8-локали не читает пути с кириллицей.
export function bslEnv(base = process.env) {
  const env = { ...base };
  if (!IS_WIN && !/utf-?8/i.test(`${env.LC_ALL || ''}${env.LANG || ''}`)) {
    env.LC_ALL = 'C.UTF-8';
    env.LANG = 'C.UTF-8';
  }
  return env;
}

function fromExecutable(path) {
  if (extname(path).toLowerCase() === '.jar') {
    if (!hasCommand('java')) return null;
    return { cmd: 'java', args: ['-Dfile.encoding=UTF-8', '-Dsun.stdout.encoding=UTF-8', '-jar', path], path };
  }
  return { cmd: path, args: [], path };
}

function candidatesIn(dir) {
  const c = [
    join(dir, 'bsl-language-server', 'bsl-language-server.exe'),
    join(dir, 'bsl-language-server', 'bin', 'bsl-language-server'),
    join(dir, 'bsl-language-server.app', 'Contents', 'MacOS', 'bsl-language-server'),
    join(dir, 'bsl-language-server.exe'),
    join(dir, 'bin', 'bsl-language-server'),
  ];
  try {
    for (const f of readdirSync(dir)) if (/^bsl-language-server.*\.jar$/i.test(f)) c.push(join(dir, f));
  } catch { /* нет каталога */ }
  return c;
}

// Найти BSL LS: переменная BSL_LS_PATH (файл или каталог) → OpenCode tools → legacy ~/.agents/tools.
export function findBslLs() {
  const env = process.env.BSL_LS_PATH;
  const places = [];
  if (env) {
    if (isFile(env)) places.push(env);
    else places.push(...candidatesIn(env));
  }
  places.push(...candidatesIn(TOOLS_DIR));
  places.push(...candidatesIn(LEGACY_TOOLS_DIR));
  for (const p of places) {
    if (isFile(p)) {
      const r = fromExecutable(p);
      if (r) return r;
    }
  }
  return null;
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { stdio: 'inherit', ...opts });
}

function download(url, file) {
  // curl есть в Windows 10+, Linux и macOS и понимает системный прокси; fetch — запасной путь.
  if (hasCommand('curl')) {
    const r = run('curl', ['-fL', '--retry', '2', '-o', file, url]);
    if (r.status === 0) return;
  }
  throw new Error(`не удалось скачать ${url}`);
}

function extract(zip, dest) {
  if (IS_WIN) {
    const r = run('powershell.exe', ['-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dest}' -Force`]);
    if (r.status !== 0) throw new Error('не удалось распаковать архив (Expand-Archive)');
    return;
  }
  if (hasCommand('unzip')) {
    const r = run('unzip', ['-q', '-o', zip, '-d', dest]);
    if (r.status === 0) return;
  }
  const py = hasCommand('python3') ? 'python3' : 'python';
  const code = 'import zipfile,os,sys\nz=zipfile.ZipFile(sys.argv[1])\nfor i in z.infolist():\n' +
    ' p=z.extract(i,sys.argv[2])\n m=(i.external_attr>>16)&0o777\n if m: os.chmod(p,m)\n';
  const r = run(py, ['-c', code, zip, dest]);
  if (r.status !== 0) throw new Error('не удалось распаковать архив (нет unzip и python)');
}

function makeExecutable(dir) {
  // Права на исполнение для запускающих файлов и встроенной Java (Linux/macOS).
  const walk = (d, depth) => {
    if (depth > 6) return;
    let list;
    try { list = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/[\\/](bin|MacOS)$/.test(d) || e.name === 'jspawnhelper') { try { chmodSync(p, 0o755); } catch { /* */ } }
    }
  };
  walk(dir, 0);
}

// Установить (или обновить) BSL LS в ~/.config/opencode/tools/bsl-language-server. Возвращает findBslLs().
export function installBslLs({ log = console.log } = {}) {
  const asset = ASSETS[process.platform];
  if (!asset) throw new Error(`платформа ${process.platform} не поддерживается — поставьте BSL LS вручную и задайте BSL_LS_PATH`);
  mkdirSync(TOOLS_DIR, { recursive: true });
  const zip = join(tmpdir(), `bsl-ls-${Date.now()}.zip`);
  log(`Скачиваю ${asset} (около 170 МБ) в ${TOOLS_DIR} ...`);
  download(RELEASE_URL + asset, zip);
  for (const old of ['bsl-language-server', 'bsl-language-server.app']) {
    rmSync(join(TOOLS_DIR, old), { recursive: true, force: true });
  }
  log('Распаковываю ...');
  extract(zip, TOOLS_DIR);
  rmSync(zip, { force: true });
  if (!IS_WIN) makeExecutable(TOOLS_DIR);
  const found = findBslLs();
  if (!found) throw new Error(`после распаковки BSL LS не найден в ${TOOLS_DIR}`);
  return found;
}

export function bslVersion(found) {
  const r = spawnSync(found.cmd, [...found.args, 'version'], { encoding: 'utf8', env: bslEnv(), timeout: 120000 });
  const out = `${r.stdout || ''}`.split('\n').map((s) => s.trim()).filter((s) => /\d+\.\d+/.test(s) && !/JAVA_TOOL/.test(s));
  return (out.pop() || '?').replace(/^version:\s*/i, '');
}

export const INSTALL_HINT =
  'BSL Language Server не установлен. Установите его один раз: запустите install-windows.cmd из папки плагина ' +
  `или выполните \`node "${join(dirname(fileURLToPath(import.meta.url)), 'bsl-check.mjs')}" -Install\` ` +
  `(около 170 МБ, ставится в ${TOOLS_DIR}; также поддерживается legacy-путь ${LEGACY_TOOLS_DIR}). ` +
  'Свой BSL LS можно указать переменной BSL_LS_PATH.';
