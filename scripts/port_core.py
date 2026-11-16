#!/usr/bin/env python3
# port_core.py — ядро сборки навыков 1С (cc-1c-skills) под OpenCode v2
# Upstream: https://github.com/Nikolay-Shirokov/cc-1c-skills (MIT)
"""
Общая логика пересборки skills/ из upstream cc-1c-skills и адаптации SKILL.md под OpenCode v2.
Точка входа для пользователя — scripts/opencode_port.py.
"""
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

UPSTREAM_URL = 'https://github.com/Nikolay-Shirokov/cc-1c-skills.git'

REPO_SKILLS = 'skills'              # собранные навыки в репозитории

# Каталог навыка в командах SKILL.md. OpenCode при загрузке навыка сообщает модели его базовый каталог,
# поэтому одни и те же SKILL.md работают из .opencode/skills проекта и из ~/.config/opencode/skills. Без «$», чтобы shell не подставил пустую переменную.
SKILL_DIR = '{SKILL_DIR}'

GITIGNORE_RECOMMENDATIONS = [
    '.v8-project.json',
    'build/',
    'base/',
    '*.epf',
    '*.erf',
    '*.log',
    'tools/',
]

# ---------------------------------------------------------------------------
# Рантайм (логика совместима со scripts/switch.py из upstream)
# ---------------------------------------------------------------------------
RX_SKILL_DIR_CROSS = re.compile(r'\$\{CLAUDE_SKILL_DIR\}/\.\./([a-z][a-z0-9-]+)/')
CLAUDE_SKILL_DIR = '${CLAUDE_SKILL_DIR}/'

RX_PS = re.compile(
    r'powershell\.exe\s+'
    r'(?:-NoProfile\s+)?'
    r'(?:-ExecutionPolicy\s+\S+\s+)?'
    r'-File\s+(?P<q>["\']?)(?P<path>[^"\s]+?)\.ps1(?P=q)?'
)
RX_PY = re.compile(r"python\s+(?P<q>[\"']?)(?P<path>[^\"\s]+?)\.py(?P=q)?")


def switch_runtime_content(content, runtime):
    if runtime == 'python':
        return RX_PS.sub(lambda m: f"python {m.group('q')}{m.group('path')}.py{m.group('q')}", content)
    if runtime == 'powershell':
        return RX_PY.sub(
            lambda m: f"powershell.exe -NoProfile -File {m.group('q')}{m.group('path')}.ps1{m.group('q')}",
            content)
    return content


def repo_root():
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def native(path):
    return path.replace('/', os.sep)


def scan_skills(skills_dir):
    if not os.path.isdir(skills_dir):
        return []
    return sorted(
        e for e in os.listdir(skills_dir)
        if os.path.isfile(os.path.join(skills_dir, e, 'SKILL.md'))
    )


def collect_md_files(skill_dir):
    return sorted(glob.glob(os.path.join(skill_dir, '**', '*.md'), recursive=True))


def read(path):
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()


def write(path, content):
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(content)


def missing_runtime_files(skill_dir, runtime):
    """Скрипты целевого рантайма, на которые сослался бы SKILL.md, но которых нет."""
    rx, ext = (RX_PS, '.py') if runtime == 'python' else (RX_PY, '.ps1')
    missing = []
    for md in collect_md_files(skill_dir):
        for m in rx.finditer(read(md)):
            p = m.group('path')
            if not p.startswith(SKILL_DIR + '/'):
                continue
            target = os.path.normpath(os.path.join(skill_dir, native(p[len(SKILL_DIR) + 1:]) + ext))
            if not os.path.isfile(target):
                missing.append(target)
    return missing


def apply_runtime(skills_dir, runtime, verbose=True):
    """Переключить рантайм во всех .md навыков. Навыки без скриптов целевого рантайма
    (например, img-grid — только Python) не трогаются."""
    switched, single = 0, []
    for name in scan_skills(skills_dir):
        skill_dir = os.path.join(skills_dir, name)
        if missing_runtime_files(skill_dir, runtime):
            single.append(name)
            continue
        for md in collect_md_files(skill_dir):
            content = read(md)
            new = switch_runtime_content(content, runtime)
            if new != content:
                write(md, new)
                switched += 1
    if verbose:
        print(f"Рантайм: {runtime}, изменено файлов: {switched}")
        if single:
            print("Без изменений (нет скриптов для этого рантайма): " + ', '.join(single))
    return switched


# ---------------------------------------------------------------------------
# Адаптация SKILL.md из формата Claude Code в формат OpenCode v2
# ---------------------------------------------------------------------------
# web-test: Playwright ставится не внутрь навыка, а в каталог-предок: OpenCode показывает модели
# файлы навыка, и node_modules (~550 файлов) раздул бы контекст, а Node находит пакет в родительских
# каталогах скрипта. Для глобальной установки (~/.config/opencode/skills) это ~/.config/opencode,
# для проектной (<проект>/.opencode/skills) install переписывает префикс на <проект>/.opencode.
WEB_TEST_PREFIX = '"$HOME/.config/opencode"'
WEB_TEST_PREFIX_PROJECT = f'"{SKILL_DIR}/../.."'
WEB_TEST_SETUP = (f'npm install --prefix {WEB_TEST_PREFIX} --no-fund --no-audit "playwright@^1.50.0" '
                  f'&& npx --prefix {WEB_TEST_PREFIX} playwright install chromium')

TEXT_REPLACEMENTS = [
    # AskUserQuestion (Claude Code) -> встроенный инструмент OpenCode `question`
    ('Спроси у пользователя через AskUserQuestion', 'Спроси у пользователя встроенным инструментом `question`'),
    ('через AskUserQuestion', 'встроенным инструментом `question`'),
    ('AskUserQuestion', 'инструмент `question`'),
    # web-test: скриншот ошибки exec/run пишется во временный каталог (см. SCRIPT_PATCHES)
    ('"screenshot": "error-shot.png"', '"screenshot": "<$TMPDIR>/web-test-error-shot.png"'),
    # web-publish: порт по умолчанию — первый свободный от 8081 (несколько пользователей RDP, см. SCRIPT_PATCHES)
    ('| `-Port <порт>` | нет | Порт (по умолчанию `8081`) |',
     '| `-Port <порт>` | нет | Порт (по умолчанию — первый свободный, начиная с `8081`; итоговый URL печатается) |'),
    ('читай результат через Read tool', 'читай результат инструментом чтения файлов'),
    ('Read tool', 'инструмент чтения файлов'),
    # web-test: в OpenCode интерактивный сеанс открывает `open` (отдельный процесс, переживает конец вызова
    # shell); `run` — только для целого сценария одним скриптом: он сам закрывает браузер.
    ('# One-shot: opens browser → runs script → closes browser → exits\n'
     'node $RUN run http://localhost:8081/bpdemo test-scenario.js\n',
     '# Step by step (OpenCode): open once, then one exec per action — the browser stays open\n'
     'node $RUN open http://localhost:8081/bpdemo\n'
     'node $RUN exec step1.js\n'
     'node $RUN exec step2.js\n'
     'node $RUN stop                  # only when the whole task is done\n\n'
     '# One-shot: opens browser → runs script → closes browser → exits\n'
     'node $RUN run http://localhost:8081/bpdemo test-scenario.js\n'),
    ('### Autonomous mode (preferred for complete scenarios)\n',
     '### Autonomous mode (a complete scenario in ONE script)\n\n'
     '`run` launches a new browser, logs in to 1C (30-60 s), runs the script and closes the browser. '
     '**Never call `run` once per step** — every call opens and closes 1C again. For anything step by step '
     '(look at the form, then decide the next action) use the interactive mode below.\n'),
    ("# 1. Start session in the background — `start` stays running as the server, so don't wait on\n"
     "#    its stdout. Poll `status` instead: it exits 0 only once the session is loaded and live.\n"
     "node $RUN start <url>            # run_in_background=true\n"
     "until node $RUN status >/dev/null 2>&1; do sleep 2; done   # exit 0 = ready\n",
     "# 1. Open the session once. `open` starts the browser server as a separate background process,\n"
     "#    waits until 1C is loaded and returns JSON — run it as an ordinary shell call (no background\n"
     "#    flag, no polling). Calling `open` again with the same URL returns the live session.\n"
     "node $RUN open <url>\n"),
    ('# 4. Stop (logout + close)\nnode $RUN stop\n',
     '# 4. Stop (logout + close) — only when the whole task is done, not after each step\nnode $RUN stop\n'),
    ('`start` runs an HTTP server in background. Use `exec`/`shot`/`stop` from other shells.',
     '**Session lifetime (OpenCode).** The OpenCode shell can end the processes of a call when the call returns '
     '(and does at its 2-minute timeout), so `start` run as an ordinary call dies together with the browser. '
     '`open` detaches the server, so the same browser and the same 1C seance serve every following '
     '`exec`/`shot` — across shell calls, without `background: true`. Do not close the session between '
     'steps and do not run `stop` + `open` to "refresh" it; if something looks stuck, use '
     '`closeForm()` or `getFormState()`. `exec` without a session fails with "No active session" — then '
     'call `open` again. The session closes itself after `WEB_TEST_IDLE_MIN` minutes without requests '
     '(default 30; `--idle-min=N` for `open`, 0 — never); a running `exec` is never cut. A different URL in '
     '`open` closes the old session and opens the new one. The session is per OS user: its file (port and '
     'token) is in the user\'s temp directory, and the server answers only requests with that token, so '
     'other users of an RDP server cannot reach your browser. On Windows PowerShell there is no `<<` '
     'heredoc: write the script to a file and run `node $RUN exec step.js`. `start` (foreground server) '
     'still works for a shell with `background: true`.'),
    (f'cd "{SKILL_DIR}/scripts" && npm install && npx playwright install chromium', WEB_TEST_SETUP),
    ("Requires Node.js 18+. `npm install` fetches Playwright; `npx playwright install chromium` downloads the browser.",
     "Requires Node.js 18+. `npm install` puts Playwright into `node_modules` of a parent directory of the "
     "skill (outside the skill, so OpenCode does not list it as skill files; Node resolves packages from parent "
     "directories). `npx playwright install chromium` downloads the browser. If `run.mjs` fails with "
     "\"Cannot find package 'playwright'\", repeat this setup."),
]

OPENCODE_NOTE = (
    '> **OpenCode:** `{SKILL_DIR}` в командах — каталог текущего навыка. Подставь абсолютный путь к каталогу '
    'навыка, если среда не делает это автоматически. Команды запускай из корня проекта. '
    'Если `powershell.exe` недоступен (Linux/macOS), запусти одноимённый `.py`-скрипт через `python` '
    '(или `python3`) с теми же параметрами.\n\n'
)

MANUAL_ONLY_NOTE = ' Вызывай только по явной просьбе пользователя.'

RX_FRONTMATTER = re.compile(r'\A---\n(?P<body>.*?)\n---\n', re.S)


def adapt_frontmatter(fm):
    """allowed-tools — имена инструментов Claude Code, в OpenCode их нет: удаляем.
    disable-model-invocation оставляем (OpenCode v2 его понимает) и дублируем смысл в description."""
    lines = fm.split('\n')
    out, manual_only, i = [], False, 0
    while i < len(lines):
        line = lines[i]
        if line.startswith('allowed-tools:'):
            i += 1
            while i < len(lines) and lines[i].startswith((' ', '\t', '-')):
                i += 1
            continue
        if line.startswith('disable-model-invocation:'):
            # OpenCode v2 понимает поле нативно: оставляем и дублируем смысл в description
            manual_only = line.split(':', 1)[1].strip().lower() == 'true'
        out.append(line)
        i += 1
    if manual_only:
        for j, line in enumerate(out):
            if line.startswith('description:') and MANUAL_ONLY_NOTE.strip() not in line:
                out[j] = line.rstrip().rstrip('.') + '.' + MANUAL_ONLY_NOTE
    return '\n'.join(out)


def adapt_markdown(content, is_skill_md):
    content = RX_SKILL_DIR_CROSS.sub(f'{SKILL_DIR}/../\\1/', content)
    content = content.replace(CLAUDE_SKILL_DIR, SKILL_DIR + '/')
    for old, new in TEXT_REPLACEMENTS:
        content = content.replace(old, new)
    if is_skill_md:
        m = RX_FRONTMATTER.match(content)
        if m:
            body = content[m.end():]
            if SKILL_DIR in body:
                # Заметка — сразу после заголовка навыка
                h = re.match(r'(\s*#[^\n]*\n\n?)', body)
                body = (h.group(1) + OPENCODE_NOTE + body[h.end():]) if h else OPENCODE_NOTE + body
            content = '---\n' + adapt_frontmatter(m.group('body')) + '\n---\n' + body
    return content


# Подсказки, которых нет в upstream там, где они нужны. Знание «расширение после первой загрузки
# в безопасном режиме, перехватчики не работают» есть только в db-cfe-admin, а модель в этом
# сценарии работает с навыками загрузки/обновления и его не открывает.
SAFE_MODE_NOTE = (
    '> **Расширение и безопасный режим.** Расширение, впервые загруженное в базу, создаётся '
    'с **включённым безопасным режимом**: перехватчики модулей (`&Перед`, `&После`, `&Вместо`, '
    '`&ИзменениеИКонтроль`) в нём **не применяются**, обращения к файлам и внешним ресурсам запрещены. '
    'Сразу после загрузки расширения, до проверки в браузере, сними режим (скрипт загрузки печатает '
    'строку `[безопасный режим]`). Сначала проверь свойства: '
    '`/db-cfe-admin list`, и сними режим: `/db-cfe-admin set-properties <база> -Name <Расширение> '
    '-SafeMode off` (нужен `ibcmd` и файловая база). Если `ibcmd` нет или база серверная — не ищи '
    'обходных путей и не открывай веб-клиент, а спроси пользователя снять флажок вручную: в Предприятии «Все функции → '
    'Стандартные → Управление расширениями конфигурации» или в конфигураторе «Конфигурация → '
    'Расширения конфигурации».\n\n'
)
SKILL_NOTES = {
    # навык: заголовок, перед которым вставить заметку
    'db-load-xml': '## Примеры',
    'db-load-cf': '## Примеры',
    'db-load-git': '## Примеры',
    'db-update': '## Примеры',
    'cfe-patch-method': '## Команда',
}


WEB_TEST_REPORTS_NOTE = (
    '> **Отчёты и окружение (OpenCode).** Перед запуском выполни preflight навыка `1c-test` '
    '(`node <1c-test>/scripts/preflight.mjs [база]`): Playwright, Chromium, дисплей, доступность веб-клиента. '
    'Все артефакты — в `build/reports/web/`: регресс `test ... --format=allure --report-dir=build/reports/web/allure` '
    '(скриншоты и видео попадают туда же), JUnit — `node <1c-test>/scripts/allure-to-junit.mjs '
    'build/reports/web/allure build/reports/web/junit.xml`. Скриншот ошибки `exec`/`run` пишется в '
    '`$TMPDIR/web-test-error-shot.png` (путь — в поле `screenshot` ответа): скопируй его в `build/reports/web/`.\n'
    '> Текст ленты, HTML-поля и табличного документа лежит во фрейме: `getFormState().frameTexts` '
    '(или `readFrameText()`). Скриншот этого текста не заменяет. `"ok": true` на клике не проверяет надписи. '
    'В итог цитируй прочитанные строки. Не встраивай диагностический вывод в модуль конфигурации, чтобы прочитать форму.\n\n'
)
WEB_TEST_NOTES = {
    'web-test': '## Execution modes',
}


BSL_CHECK_NOTE = (
    '> **Проверка кода перед загрузкой.** Перед загрузкой в базу проверь изменённые модули навыком '
    '`bsl-check` (BSL Language Server): `bsl-check -Path <каталог расширения или объекта>`. Он находит '
    'синтаксические и типовые ошибки за секунды — без цикла «загрузка → ошибка платформы → правка».\n\n'
)
BSL_CHECK_NOTES = {
    'db-load-xml': '## Примеры',
    'db-load-git': '## Примеры',
    'cfe-validate': '## Команда',
}
PRINT_FORM_NOTE = (
    '> **Печатная форма (OpenCode).** Команда печати здесь — только каркас. Саму форму делай навыком '
    '`print-form`: макет `template-add` → JSON DSL → `mxl-compile` → `mxl-validate` → предпросмотр PNG '
    '(`mxl-render`) и модуль заполнения по эталону (`ПолучитьОбласть`, `Параметры.Заполнить`, `ПроверитьВывод`, '
    '`УправлениеПечатью.ВывестиТабличныйДокументВКоллекцию`). Таблицу программно (`.Область().Текст`) не строй.\n\n'
)
PRINT_FORM_NOTES = {
    'epf-bsp-init': '## Инструкции',
    'epf-bsp-add-command': '## Инструкции',
}
INTERCEPTOR_NOTE = (
    '> **Выбор перехватчика (OpenCode).** Логика меняется внутри типового метода — `ModificationAndControl` '
    '(`&ИзменениеИКонтроль`) с минимальными правками `#Вставка`/`#Удаление`; копировать тело оригинала в `&Вместо` '
    'запрещено. Код только до/после — `Before`/`After`. `Instead` — только условная замена с `ПродолжитьВызов`. После '
    'обновления типовой — `-Check`, при дрейфе `-Actualize`, конфликты — пользователю. Подробно — раздел «Перехват '
    'методов типовой конфигурации» агента `1c` и `docs/cfe-guide.md`.\n\n'
)
INTERCEPTOR_NOTES = {
    'cfe-patch-method': '## Типы перехвата',
}
# Свои навыки порта (их нет в upstream): копируются в skills/ при каждой сборке
OWN_SKILLS = 'own-skills'


def add_skill_notes(skills_dir):
    for note, targets in ((SAFE_MODE_NOTE, SKILL_NOTES), (BSL_CHECK_NOTE, BSL_CHECK_NOTES),
                          (WEB_TEST_REPORTS_NOTE, WEB_TEST_NOTES), (PRINT_FORM_NOTE, PRINT_FORM_NOTES),
                          (INTERCEPTOR_NOTE, INTERCEPTOR_NOTES)):
        for name, anchor in targets.items():
            path = os.path.join(skills_dir, name, 'SKILL.md')
            content = read(path)
            if note.strip() in content:
                continue
            if anchor not in content:
                print(f'Предупреждение: в {name}/SKILL.md нет «{anchor}», заметка не добавлена', file=sys.stderr)
                continue
            write(path, content.replace(anchor, note + anchor, 1))


def copy_own_skills(dst):
    src = os.path.join(repo_root(), native(OWN_SKILLS))
    names = scan_skills(src)
    for name in names:
        target = os.path.join(dst, name)
        if os.path.isdir(target):
            shutil.rmtree(target)
        shutil.copytree(os.path.join(src, name), target,
                        ignore=shutil.ignore_patterns('__pycache__', 'node_modules'))
    return names


# Навыки могут лежать вне проекта (~/.config/opencode/skills), поэтому корень проекта —
# рабочий каталог сессии OpenCode, а не «4 уровня вверх от скрипта», как в upstream.
SCRIPT_PATCHES = {
    '.ps1': [
        ('$projectRoot = (Get-Item $PSScriptRoot).Parent.Parent.Parent.Parent.FullName',
         '$projectRoot = (Get-Location).Path  # OpenCode: корень проекта — рабочий каталог'),
    ],
    '.py': [
        ('project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(script_dir))))',
         'project_root = os.getcwd()  # OpenCode: корень проекта — рабочий каталог'),
    ],
    '.mjs': [
        ("export const projectRoot = pathResolve(dirname(__fn_state), '..', '..', '..', '..', '..', '..');",
         "// OpenCode: навыки могут лежать вне проекта, корень проекта — рабочий каталог\n"
         "export const projectRoot = process.env.V8_PROJECT_ROOT ? pathResolve(process.env.V8_PROJECT_ROOT) "
         ": process.cwd();"),
        # Скриншот ошибки — во временный каталог, а не в каталог навыка (каталог навыка может быть
        # глобальным, а файлы в каталоге навыка OpenCode показывает модели при загрузке навыка).
        ("import { fileURLToPath } from 'url';\nimport * as browser from '../browser.mjs';",
         "import { fileURLToPath } from 'url';\nimport { tmpdir } from 'os';\nimport * as browser from '../browser.mjs';"),
        ("const DEFAULT_ERROR_SHOT_PATH = resolve(__dirname, '..', '..', 'error-shot.png');",
         "const DEFAULT_ERROR_SHOT_PATH = resolve(tmpdir(), 'web-test-error-shot.png');"),
        # web-test start/exec: файл сеанса (порт HTTP-сервера браузера) — свой у каждого пользователя и
        # каталога навыка, а не общий файл в каталоге навыка (несколько пользователей RDP, общая установка).
        ("export const SESSION_FILE = resolve(__dirname, '..', '..', '.browser-session.json');",
         "import { tmpdir as __wtTmp, userInfo as __wtUser } from 'os';\n"
         "import { createHash as __wtHash } from 'crypto';\n"
         "// OpenCode: файл сеанса — у каждого пользователя и каталога навыка свой (несколько сеансов RDP)\n"
         "const __wtName = (() => { try { return __wtUser().username; } catch { return 'user'; } })().replace(/[^\\w.-]/g, '_');\n"
         "export const SESSION_FILE = resolve(process.env.WEB_TEST_SESSION_DIR || __wtTmp(), "
         "`web-test-session-${__wtName}-${__wtHash('sha1').update(resolve(__dirname)).digest('hex').slice(0, 10)}.json`);"),
    ],
}

# web-test: долгоживущий сеанс браузера (OpenCode). Shell OpenCode завершает процессы обычного вызова, когда
# вызов закончился, а `run` сам закрывает браузер — при работе по шагам 1С открывалась заново на каждом шаге.
# Команда `open` (skill-overlays/web-test/.../commands/open.mjs) запускает `start` отдельным процессом и
# возвращается, когда 1С готова; сервер `start` закрывается по `stop` или после простоя (cli/keepalive.mjs).
# Запросы к серверу — только с токеном из файла сеанса пользователя (127.0.0.1 общий для всех на RDP-сервере).
SCRIPT_PATCHES['.mjs'] += [
    # run.mjs: команда open
    ("import { cmdTest } from './cli/commands/test.mjs';",
     "import { cmdTest } from './cli/commands/test.mjs';\n"
     "import { cmdOpen } from './cli/commands/open.mjs';  // OpenCode: долгоживущий сеанс"),
    ("  case 'test':   await cmdTest(rawArgs); break;",
     "  case 'test':   await cmdTest(rawArgs); break;\n"
     "  case 'open':   await cmdOpen(args[0], rawArgs); break;  // OpenCode: открыть или взять открытый сеанс"),
    # util.mjs: справка
    ("  start <url>              Launch browser and connect to 1C web client\n",
     "  open <url>               Open a browser session in the background or reuse the open one;\n"
     "                           it stays between exec calls (stop, or idle WEB_TEST_IDLE_MIN=30 min)\n"
     "  start <url>              Launch browser and connect to 1C web client (foreground server)\n"),
    # session.mjs: подсказка без сеанса
    ("die('No active session. Run: node src/run.mjs start <url>');",
     "die('No active session. Run: node run.mjs open <url> — the browser then stays open between exec calls');"),
    # start.mjs: токен, файл сеанса 0600, остановка по простою и сигналам
    ("import { handleRequest } from '../server.mjs';",
     "import { handleRequest } from '../server.mjs';\n"
     "import { SESSION_TOKEN, writeSessionFile, armIdleStop, idleMinutes } from '../keepalive.mjs';  // OpenCode"),
    ("      startedAt: new Date().toISOString()\n    };\n"
     "    writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));",
     "      startedAt: new Date().toISOString(),\n"
     "      token: SESSION_TOKEN,          // OpenCode: без токена сервер отвечает 403\n"
     "      idleMin: idleMinutes(),\n"
     "    };\n"
     "    writeSessionFile(SESSION_FILE, session);\n"
     "    armIdleStop(async () => { await browser.disconnect(); cleanup(); });"),
    # server.mjs: только запросы с токеном; учёт активности для остановки по простою
    ("import { executeScript } from './exec-context.mjs';\n\nexport async function handleRequest(req, res) {\n  try {",
     "import { executeScript } from './exec-context.mjs';\n"
     "import { authorize, trackRequest } from './keepalive.mjs';  // OpenCode\n\n"
     "export async function handleRequest(req, res) {\n"
     "  if (!authorize(req)) { res.writeHead(403); res.end('Forbidden'); return; }\n"
     "  res.on('close', trackRequest());\n"
     "  try {"),
    # status.mjs печатает содержимое файла сеанса — без токена
    ("  const sess = JSON.parse(readFileSync(SESSION_FILE, 'utf-8'));\n",
     "  const sess = JSON.parse(readFileSync(SESSION_FILE, 'utf-8'));\n"
     "  Object.defineProperty(sess, 'token', { enumerable: false });  // OpenCode: токен не печатаем\n"),
    # клиенты: токен первым сегментом пути
    ("hostname: '127.0.0.1', port: sess.port, path: '/exec',",
     "hostname: '127.0.0.1', port: sess.port, path: (sess.token ? `/${sess.token}` : '') + '/exec',"),
    ("`http://127.0.0.1:${sess.port}/",
     "`http://127.0.0.1:${sess.port}${sess.token ? `/${sess.token}` : ''}/"),
    # getFormState читает текст iframe (лента, HTML, табличный документ); файл — skill-overlays
    ("import { checkForErrors, detectPlatformDialogs } from '../core/errors.mjs';",
     "import { checkForErrors, detectPlatformDialogs } from '../core/errors.mjs';\n"
     "import { readFrameTexts } from './frame-text.mjs';  // OpenCode: текст iframe (лента, HTML, табличный документ)"),
    ("  const pd = await detectPlatformDialogs();\n  if (pd.length) state.platformDialogs = pd;\n  return state;",
     "  const pd = await detectPlatformDialogs();\n  if (pd.length) state.platformDialogs = pd;\n"
     "  // Текст внутри iframe (лента, HTML-поле, табличный документ) page.evaluate не видит.\n"
     "  if (state?.iframes) {\n"
     "    try {\n"
     "      const frameTexts = await readFrameTexts(page, { formNum: state.form });\n"
     "      if (frameTexts.length) state.frameTexts = frameTexts;\n"
     "    } catch { /* форма без доступного фрейма */ }\n"
     "  }\n"
     "  return state;"),
    ("export { getFormState } from './engine/forms/state.mjs';",
     "export { getFormState } from './engine/forms/state.mjs';\n"
     "export { readFrameText } from './engine/forms/frame-text.mjs';  // OpenCode"),
]

# Файлы порта, которых нет в upstream: копируются поверх собранных навыков (skill-overlays/<навык>/...)
OVERLAYS = 'skill-overlays'


def copy_overlays(dst):
    src = os.path.join(repo_root(), native(OVERLAYS))
    copied = []
    if not os.path.isdir(src):
        return copied
    for base, _dirs, files in os.walk(src):
        for name in files:
            if name.endswith('.pyc'):
                continue
            rel = os.path.relpath(os.path.join(base, name), src)
            if not os.path.isdir(os.path.join(dst, rel.split(os.sep)[0])):
                continue   # навыка нет в сборке — не создаём
            target = os.path.join(dst, rel)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            shutil.copy2(os.path.join(base, name), target)
            copied.append(rel)
    return copied


# web-publish: порт по умолчанию 8081 занят другим пользователем/сеансом (RDP) → берём следующий свободный
# (порт нашего же Apache считается свободным — он будет перезапущен). Явный -Port работает как раньше.
WEB_PUBLISH_PORT_PY = """    port = args.Port
    if not port:
        # OpenCode: несколько пользователей на одном сервере — ищем свободный порт от 8081
        _exe = os.path.normcase(os.path.normpath(os.path.join(apache_path, 'bin', 'httpd.exe')))
        _ours = {p.pid for p in get_our_httpd(_exe)}
        port = 8081
        while port < 8181:
            _holder = check_port_in_use(port)
            if _holder is None or _holder in _ours:
                break
            port += 1
        if port != 8081:
            print(f'Порт 8081 занят (другой пользователь/сеанс?) — использую {port}')
"""
WEB_PUBLISH_PORT_PS1 = """# OpenCode: несколько пользователей на одном сервере — порт по умолчанию ищем свободный от 8081
if ($Port -eq 0) {
    $ourExe = (Resolve-Path $httpdExe -ErrorAction SilentlyContinue).Path
    $Port = 8081
    while ($Port -lt 8181) {
        $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $c) { break }
        $holder = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
        if ($ourExe -and $holder -and $holder.Path -eq $ourExe) { break }
        $Port++
    }
    if ($Port -ne 8081) { Write-Host "Порт 8081 занят (другой пользователь/сеанс?) — использую $Port" -ForegroundColor Yellow }
}
$listenLines ="""
SCRIPT_PATCHES['.py'] += [
    ("parser.add_argument('-Port', type=int, default=8081, help='Port (default: 8081)')",
     "parser.add_argument('-Port', type=int, default=0, help='Port (default: first free from 8081)')"),
    ("    port = args.Port\n", WEB_PUBLISH_PORT_PY),
]
SCRIPT_PATCHES['.ps1'] += [
    ("    [int]$Port = 8081,", "    [int]$Port = 0,  # OpenCode: 0 — первый свободный от 8081"),
    ("$listenLines =", WEB_PUBLISH_PORT_PS1),
]

# После успешной загрузки расширения — строка в stdout, которую модель видит в том же шаге,
# а не только в тексте навыка. Одна строка, чтобы совпасть при любом отступе.
_SAFE_PY = (
    'print("[безопасный режим] Расширение после загрузки включено в безопасном режиме: перехватчики не выполняются. '
    'До браузера сними его — db-cfe-admin set-properties <база> -Name <Имя> -SafeMode off (только ibcmd и файловая база). '
    'Нет ibcmd или база серверная — остановись и спроси пользователя, веб-клиент не открывай.") '
    'if (getattr(args, "Extension", None) or getattr(args, "AllExtensions", None)) else None'
)
_SAFE_PS = (
    'if ($Extension -or $AllExtensions) { Write-Host "[безопасный режим] Расширение после загрузки включено в безопасном режиме: '
    'перехватчики не выполняются. До браузера сними его — db-cfe-admin set-properties <база> -Name <Имя> -SafeMode off '
    '(только ibcmd и файловая база). Нет ibcmd или база серверная — остановись и спроси пользователя, веб-клиент не открывай." '
    '-ForegroundColor Yellow }'
)
for _old in (
    'print("Load completed successfully")',
    'print("Database configuration updated successfully")',
    'print(f"Configuration loaded successfully from: {args.ConfigDir}")',
    'print(f"Configuration loaded successfully from: {args.InputFile}")',
):
    SCRIPT_PATCHES['.py'] += [(_old, _old + '; ' + _SAFE_PY)]
for _old in (
    'Write-Host "Load completed successfully" -ForegroundColor Green',
    'Write-Host "Database configuration updated successfully" -ForegroundColor Green',
    'Write-Host "Configuration loaded successfully from: $ConfigDir" -ForegroundColor Green',
    'Write-Host "Configuration loaded successfully from: $InputFile" -ForegroundColor Green',
):
    SCRIPT_PATCHES['.ps1'] += [(_old, _old + '; ' + _SAFE_PS)]


def patch_scripts(skills_dir):
    """Точечные правки скриптов. Работает с байтами, чтобы сохранить BOM у .ps1."""
    patched = []
    for ext, repls in SCRIPT_PATCHES.items():
        for path in glob.glob(os.path.join(skills_dir, '*', 'scripts', '**', '*' + ext), recursive=True):
            if 'node_modules' in path:
                continue
            with open(path, 'rb') as f:
                data = f.read()
            new = data
            for old, rep in repls:
                new = new.replace(old.encode('utf-8'), rep.encode('utf-8'))
            if new != data:
                with open(path, 'wb') as f:
                    f.write(new)
                patched.append(os.path.relpath(path, skills_dir))
    return patched


# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------
def clone_upstream(ref):
    tmp = tempfile.mkdtemp(prefix='cc-1c-skills-')
    cmd = ['git', 'clone', '--depth', '1']
    if ref:
        cmd += ['--branch', ref]
    cmd += [UPSTREAM_URL, tmp]
    print('Клонирование ' + UPSTREAM_URL + ' ...')
    subprocess.run(cmd, check=True)
    return tmp


def cmd_build(args):
    upstream = args.upstream or clone_upstream(args.ref)
    src = os.path.join(upstream, '.claude', 'skills')
    skills = scan_skills(src)
    if not skills:
        print(f'Ошибка: навыки не найдены в {src}', file=sys.stderr)
        return 1

    dst = os.path.join(repo_root(), REPO_SKILLS)
    if os.path.isdir(dst):
        shutil.rmtree(dst)
    os.makedirs(dst)

    ignore = shutil.ignore_patterns('node_modules', '__pycache__', '.browser-session.json')
    for name in os.listdir(src):
        p = os.path.join(src, name)
        if os.path.isfile(p):
            shutil.copy2(p, os.path.join(dst, name))
    for name in skills:
        shutil.copytree(os.path.join(src, name), os.path.join(dst, name), ignore=ignore)
        for md in collect_md_files(os.path.join(dst, name)):
            content = read(md)
            new = adapt_markdown(content, os.path.basename(md) == 'SKILL.md')
            if new != content:
                write(md, new)
    patched = patch_scripts(dst)
    overlays = copy_overlays(dst)
    add_skill_notes(dst)
    apply_runtime(dst, args.runtime, verbose=False)
    own = copy_own_skills(dst)

    left = [md for md in glob.glob(os.path.join(dst, '**', '*.md'), recursive=True)
            if 'CLAUDE_SKILL_DIR' in read(md)]
    if left:
        print('Предупреждение: остались ${CLAUDE_SKILL_DIR}: ' + ', '.join(left), file=sys.stderr)

    sha = ''
    try:
        sha = subprocess.run(['git', '-C', upstream, 'rev-parse', 'HEAD'],
                             capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        pass
    write(os.path.join(repo_root(), 'UPSTREAM'), f'{UPSTREAM_URL}\n{sha}\n')
    print(f'Собрано {len(skills)} навыков upstream + {len(own)} своих ({", ".join(own)}) в {REPO_SKILLS}/ '
          f'(рантайм: {args.runtime}, upstream {sha[:12]}, пропатчено скриптов: {len(patched)}, '
          f'файлов порта: {len(overlays)})')
    if not args.upstream:
        shutil.rmtree(upstream, ignore_errors=True)
    return 0


def print_gitignore_recommendations(project_dir):
    path = os.path.join(project_dir, '.gitignore')
    existing = set()
    if os.path.isfile(path):
        existing = {line.strip() for line in read(path).splitlines()}
    recs = GITIGNORE_RECOMMENDATIONS + ['.opencode/node_modules/', '.opencode/package.json',
                                        '.opencode/package-lock.json']
    missing = [r for r in recs if r not in existing]
    if missing:
        print('\nРекомендуется добавить в .gitignore проекта:')
        for r in missing:
            print('  ' + r)
