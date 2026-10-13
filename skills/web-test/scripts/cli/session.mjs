// web-test cli/session v1.0 — session-file helpers for HTTP-server mode
// Source: https://github.com/Nikolay-Shirokov/cc-1c-skills
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { die } from './util.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
import { tmpdir as __wtTmp, userInfo as __wtUser } from 'os';
import { createHash as __wtHash } from 'crypto';
// OpenCode: файл сеанса — у каждого пользователя и каталога навыка свой (несколько сеансов RDP)
const __wtName = (() => { try { return __wtUser().username; } catch { return 'user'; } })().replace(/[^\w.-]/g, '_');
export const SESSION_FILE = resolve(process.env.WEB_TEST_SESSION_DIR || __wtTmp(), `web-test-session-${__wtName}-${__wtHash('sha1').update(resolve(__dirname)).digest('hex').slice(0, 10)}.json`);

export function loadSession() {
  if (!existsSync(SESSION_FILE)) {
    die('No active session. Run: node src/run.mjs start <url>');
  }
  return JSON.parse(readFileSync(SESSION_FILE, 'utf-8'));
}

export function cleanup() {
  try { unlinkSync(SESSION_FILE); } catch {}
}
