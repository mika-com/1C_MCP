// web-test cli/keepalive — OpenCode: долгоживущий сеанс браузера между вызовами shell.
// Файл порта (skill-overlays/), в upstream cc-1c-skills его нет; подключается правками из scripts/port_core.py.
//
// - SESSION_TOKEN: случайный токен сеанса. HTTP-сервер `start` слушает 127.0.0.1, а на RDP-сервере
//   127.0.0.1 общий для всех пользователей: без токена чужой пользователь мог бы прислать /exec (а в exec
//   есть writeFileSync) в наш браузер. Токен лежит только в файле сеанса (временный каталог пользователя,
//   права 0600) и передаётся первым сегментом пути: /<token>/exec.
// - Простой: сервер сам выходит из 1С и закрывает браузер, если N минут не было запросов
//   (WEB_TEST_IDLE_MIN, по умолчанию 30; 0 — без ограничения). Пока выполняется exec, сеанс не простаивает.
// - SIGTERM/SIGHUP (выход из сеанса, закрытие окна) — тоже с выходом из 1С, чтобы не держать лицензию.
import { randomBytes, timingSafeEqual } from 'crypto';
import { writeFileSync, renameSync, chmodSync } from 'fs';

export const SESSION_TOKEN = randomBytes(24).toString('hex');
export const DEFAULT_IDLE_MIN = 30;

export function idleMinutes(env = process.env) {
  const raw = env.WEB_TEST_IDLE_MIN;
  if (raw === undefined || raw === '') return DEFAULT_IDLE_MIN;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_IDLE_MIN;
}

/** Проверить токен в начале пути и убрать его: /<token>/exec → /exec. false — чужой запрос. */
export function authorize(req, token = SESSION_TOKEN) {
  const url = String(req.url || '');
  const m = /^\/([^/?#]+)(\/.*)?$/.exec(url);
  if (!m || !token) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  req.url = m[2] || '/';
  return true;
}

/** Префикс пути для клиента (exec/shot/stop/status) по данным файла сеанса. */
export function tokenPrefix(sess) {
  return sess && sess.token ? `/${sess.token}` : '';
}

/** Файл сеанса: атомарно и только для владельца (на Linux временный каталог общий). */
export function writeSessionFile(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch {}
  renameSync(tmp, file);
}

let lastActivity = Date.now();
let inflight = 0;
let watchdog = null;

/** Отметить начало запроса; вернуть функцию завершения (вызывать один раз). */
export function trackRequest() {
  inflight++;
  lastActivity = Date.now();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    inflight = Math.max(0, inflight - 1);
    lastActivity = Date.now();
  };
}

export function idleState() {
  return { inflight, idleMs: Date.now() - lastActivity };
}

/**
 * Остановка по простою и по сигналам. stop() — выход из 1С, закрытие браузера, удаление файла сеанса.
 * Возвращает функцию снятия таймера (для тестов).
 */
export function armIdleStop(stop, { idleMin = idleMinutes(), checkMs } = {}) {
  let stopping = false;
  const once = async (reason) => {
    if (stopping) return;
    stopping = true;
    try { process.stderr.write(`web-test: ${reason} — сеанс закрывается\n`); } catch {}
    try { await stop(reason); } finally { process.exit(0); }
  };
  for (const sig of ['SIGTERM', 'SIGHUP']) {
    try { process.on(sig, () => once(sig)); } catch {}
  }
  if (watchdog) clearInterval(watchdog);
  watchdog = null;
  lastActivity = Date.now();
  if (idleMin > 0) {
    const limit = idleMin * 60 * 1000;
    watchdog = setInterval(() => {
      if (inflight === 0 && Date.now() - lastActivity >= limit) once(`простой ${idleMin} мин`);
    }, checkMs ?? Math.min(30000, Math.max(200, limit / 4)));
    watchdog.unref?.();
  }
  return () => { if (watchdog) clearInterval(watchdog); watchdog = null; };
}

/** Одинаковые ли адреса публикации (без учёта завершающего «/» и регистра хоста). */
export function sameUrl(a, b) {
  const norm = (u) => {
    try {
      const x = new URL(String(u));
      return `${x.protocol}//${x.host.toLowerCase()}${x.pathname.replace(/\/+$/, '')}${x.search}`;
    } catch { return String(u || '').replace(/\/+$/, ''); }
  };
  return norm(a) === norm(b);
}
