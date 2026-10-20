// Поддельный движок web-test (вместо scripts/browser.mjs): без Playwright и 1С.
// Пишет события в FAKE_BROWSER_LOG: "connect <pid> <url>", "disconnect <pid>".
import { appendFileSync } from 'node:fs';

let connected = false;
const log = (s) => { if (process.env.FAKE_BROWSER_LOG) appendFileSync(process.env.FAKE_BROWSER_LOG, s + '\n'); };

export async function connect(url) {
  if (/fail/.test(url)) throw new Error('Нет свободной лицензии (fake)');
  if (/slow/.test(url)) await new Promise((r) => setTimeout(r, 1500));
  connected = true;
  log(`connect ${process.pid} ${url}`);
  return { form: null, formCount: 0 };
}
export async function disconnect() {
  if (connected) log(`disconnect ${process.pid}`);
  connected = false;
}
export function isConnected() { return connected; }
export async function screenshot() { return Buffer.from('89504e47', 'hex'); }
export function setPreserveClipboard() {}
export async function getFormState() { return { form: 1, pid: process.pid }; }
export async function stopRecording() {}
export async function startRecording() {}
export function isRecording() { return false; }
