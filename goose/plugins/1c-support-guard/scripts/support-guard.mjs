// support-guard.mjs v1.0-goose — PreToolUse hook для goose: блокирует прямую правку
// (инструменты write/edit/text_editor) объектов типовой конфигурации 1С «на замке»,
// минуя встроенную в навыки проверку.
// Порт hooks/support-guard.mjs из https://github.com/Nikolay-Shirokov/cc-1c-skills
//
// stdin: payload goose { event, tool_name, tool_input: { path, ... }, working_dir, ... }.
// Отказ: stdout {"decision":"block","reason":"..."} (протокол хуков goose / Open Plugins).
// Реакция (deny|warn|off) — editingAllowedCheck из .v8-project.json. Собственные ошибки
// хука никогда не блокируют правку: при сбое stdout пуст, exit 0.

import { decideSupport } from './common/support-state.mjs';
import { getEditMode } from './common/project.mjs';
import { resolve, isAbsolute } from 'node:path';

// text_editor (старый developer-инструмент goose): правкой считаются все команды, кроме view.
const READ_ONLY_COMMANDS = new Set(['view']);

function candidatePaths(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return [];
  if (/(^|__)text_editor$/.test(toolName || '') && READ_ONLY_COMMANDS.has(toolInput.command)) return [];
  const out = [];
  for (const key of ['path', 'file_path']) {
    if (typeof toolInput[key] === 'string' && toolInput[key]) out.push(toolInput[key]);
  }
  return out;
}

// Диагностика для модели под конкретную причину блокировки (код из decideSupport).
function diagnostic(code, target, cfgDir) {
  const head =
    'Редактирование отклонено: это объект типовой конфигурации на поддержке поставщика, ' +
    'прямое редактирование молча сломает будущие обновления.';
  const cfe =
    'Рекомендуемый путь: внести доработку в расширение (навыки cfe-borrow / cfe-patch-method) — ' +
    'состояние поддержки менять не нужно, обновления вендора сохраняются.';
  const offNote = 'Снять проверку для этой базы: editingAllowedCheck = warn|off в .v8-project.json.';
  const root = cfgDir || '<каталог дампа>';

  if (code === 'capability-off') {
    return [
      head,
      `Состояние: у всей конфигурации выключена возможность изменения (режим read-only «из коробки») — ` +
        `поэтому объект «${target}» редактировать нельзя.`,
      cfe,
      `Либо снять защиту явно (навык support-edit, два шага):`,
      `  1. support-edit -Path "${root}" -Capability on   — включить возможность изменения (объекты пока остаются на замке);`,
      `  2. support-edit -Path "${target}" -Set editable   — открыть этот объект для редактирования.`,
      `Изменение применяется в базу полной загрузкой выгрузки и обходит механизм обновлений вендора.`,
      offNote,
    ].join('\n');
  }
  return [
    head,
    `Состояние: объект «${target}» на замке (возможность изменения конфигурации включена, но сам объект не редактируется).`,
    cfe,
    `Либо разрешить редактирование этого объекта (навык support-edit, выбрать одно):`,
    `  • support-edit -Path "${target}" -Set editable      — редактировать и дальше получать обновления вендора (при обновлении возможны конфликты слияния);`,
    `  • support-edit -Path "${target}" -Set off-support   — снять с поддержки: редактирование свободно, обновления по объекту больше не приходят.`,
    offNote,
  ].join('\n');
}

// Ядро решения. Возвращает { stdout, stderr, exitCode }; без I/O — для тестов.
export function processInput(input) {
  const empty = { stdout: '', stderr: '', exitCode: 0 };
  try {
    const cwd = typeof input.working_dir === 'string' && input.working_dir ? input.working_dir : process.cwd();
    for (const p of candidatePaths(input.tool_name, input.tool_input)) {
      const target = isAbsolute(p) ? p : resolve(cwd, p);
      const r = decideSupport(target, 'editable');
      if (!r.blocked) continue;
      const mode = getEditMode(r.cfgDir, cwd);
      if (mode === 'off') continue;
      if (mode === 'warn') {
        return { stdout: '', stderr: `[1c-support-guard] ПРЕДУПРЕЖДЕНИЕ: ${r.reason}. Цель: ${target}`, exitCode: 0 };
      }
      const decision = { decision: 'block', reason: diagnostic(r.code, target, r.cfgDir) };
      return { stdout: JSON.stringify(decision), stderr: '', exitCode: 0 };
    }
    return empty;
  } catch {
    return empty;
  }
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

if (process.argv[1]?.endsWith('support-guard.mjs')) {
  const raw = await readStdin();
  let input = {};
  try { input = raw.trim() ? JSON.parse(raw) : {}; } catch { input = {}; }
  const { stdout, stderr, exitCode } = processInput(input);
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr + '\n');
  process.exit(exitCode);
}
