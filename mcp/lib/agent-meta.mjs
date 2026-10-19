// Версия 1C-Agent и отметка плагина bsl-autocheck. Единственный источник версии — файл VERSION
// в корне репозитория (его читают MCP-серверы и плагин).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function agentVersion() {
  try {
    const raw = readFileSync(join(repoRoot, 'VERSION'), 'utf8').replace(/^\uFEFF/, '').trim();
    const ver = raw.split(/\s+/)[0];
    return ver || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function instructionSuffix() {
  const ver = agentVersion();
  return ` Версия 1C-Agent: ${ver} (файл VERSION в корне репозитория). `
    + 'Если после правки .bsl/.os в результате инструмента нет строки [bsl-autocheck], плагин не активен — '
    + 'так выглядит устаревшая установка: переустановите агента и сверьте эту версию. '
    + 'Живое состояние плагина пишет index_status.';
}

export function userCacheDir(env = process.env) {
  if (process.platform === 'win32') return join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), '1c-opencode');
  return join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), '1c-opencode');
}

export function autocheckStatePath(env = process.env) {
  if (env.BSL_AUTOCHECK_STATE) return env.BSL_AUTOCHECK_STATE;
  return join(userCacheDir(env), 'bsl-autocheck.json');
}

// Плагин вызывает это из setup(): файл есть и version совпадает с VERSION — плагин этой сборки загружен.
export function writeAutocheckState(root, env = process.env) {
  try {
    const p = autocheckStatePath(env);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({
      version: agentVersion(), at: new Date().toISOString(), pid: process.pid, root: root || '',
    }));
    return p;
  } catch {
    return '';
  }
}

export function readAutocheckState(env = process.env) {
  const p = autocheckStatePath(env);
  try {
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function autocheckStatusText(env = process.env) {
  const ver = agentVersion();
  const p = autocheckStatePath(env);
  const data = readAutocheckState(env);
  if (data && data.version === ver) {
    return `Плагин bsl-autocheck: активен (версия ${ver}, отмечен ${data.at || '?'})`;
  }
  if (data && data.version) {
    return `Плагин bsl-autocheck: отмечен старой версией ${data.version}, сейчас ${ver}. `
      + 'Переустановите агента — после правки .bsl не будет актуальной строки [bsl-autocheck].';
  }
  return `Плагин bsl-autocheck: не активен (нет отметки ${p}). `
    + `После правки .bsl не будет строки [bsl-autocheck] — так выглядит устаревшая установка. `
    + `Переустановите 1C-Agent и сверьте версию ${ver}.`;
}

export function agentBanner() {
  return `1C-Agent ${agentVersion()}`;
}
