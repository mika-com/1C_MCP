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
    '`$TMPDIR/web-test-error-shot.png` (путь — в поле `screenshot` ответа): скопируй его в `build/reports/web/`. '
    'На одну проверку смотри 1–2 скриншота, не пачку полноразмерных PNG: сначала текст и DOM. Цикл прогона '
    'в основном агенте не крути — его ведёт субагент `1c-tester`.\n'
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
FORM_EVENT_NOTE = (
    '> **Неизвестное событие (OpenCode).** Имени нет в списках ниже — `form-compile` пишет `[ERROR]` '
    'и завершается с кодом 1, Form.xml не создаёт. Платформа иначе сохраняет событие и никогда его не вызывает. '
    'Расшифровка отчёта — `DetailProcessing` у поля табличного документа, не выдуманное имя. '
    'Незнакомое событие сначала проверь в `1c-help`. Обход: `FORM_COMPILE_ALLOW_UNKNOWN_EVENTS=1` '
    '(только предупреждение).\n\n'
)
FORM_EVENT_NOTES = {
    'form-compile': '### События',
}
PASSWORD_NOTE = (
    '> **Пароль (OpenCode).** Не передавай `-Password`, `-UserName` вместе с паролем, `/P`, `--password`, '
    '`curl -u` и заголовок `Basic`. Передай `-Database <id>`: скрипт подставит путь или сервер, пользователя '
    'и пароль из записи `databases[]` (сначала `id` и `aliases`, иначе `path` или `server`+`ref`). '
    'Нет записи — `V8_DB_USER` / `V8_DB_PASSWORD`. Явный `-Password` перекрывает файл, но shell-guard его '
    'блокирует. Значение пароля в команду и в ответ не подставляй.\n\n'
)
# Свои навыки порта (их нет в upstream): хранятся прямо в skills/ и сохраняются при пересборке
OWN_SKILL_NAMES = ('1c-test', 'bsl-check', 'print-form', 'vrunner', 'db-install-agentquery')
OVERLAY_FILES = (
    'web-test/scripts/cli/commands/open.mjs',
    'web-test/scripts/cli/keepalive.mjs',
    'web-test/scripts/engine/forms/frame-text.mjs',
)


def add_skill_notes(skills_dir):
    for note, targets in ((SAFE_MODE_NOTE, SKILL_NOTES), (BSL_CHECK_NOTE, BSL_CHECK_NOTES),
                          (WEB_TEST_REPORTS_NOTE, WEB_TEST_NOTES), (PRINT_FORM_NOTE, PRINT_FORM_NOTES),
                          (INTERCEPTOR_NOTE, INTERCEPTOR_NOTES), (FORM_EVENT_NOTE, FORM_EVENT_NOTES)):
        for name, anchor in targets.items():
            path = os.path.join(skills_dir, name, 'SKILL.md')
            content = read(path)
            if note.strip() in content:
                continue
            if anchor not in content:
                print(f'Предупреждение: в {name}/SKILL.md нет «{anchor}», заметка не добавлена', file=sys.stderr)
                continue
            write(path, content.replace(anchor, note + anchor, 1))
    add_password_notes(skills_dir)


def add_password_notes(skills_dir):
    marker = '**Пароль (OpenCode).**'
    anchor = 'с теми же параметрами.\n\n'
    for name in scan_skills(skills_dir):
        path = os.path.join(skills_dir, name, 'SKILL.md')
        if not os.path.isfile(path):
            continue
        content = read(path)
        if '-Password' not in content or marker in content:
            continue
        if anchor in content:
            content = content.replace(anchor, anchor + PASSWORD_NOTE, 1)
        else:
            content = PASSWORD_NOTE + content
        write(path, content)


def save_port_files(dst):
    """Сохраняет свои навыки и файлы-оверлеи из skills/ во временный каталог перед очисткой."""
    saved = {'own': {}, 'overlays': {}}
    if not os.path.isdir(dst):
        return saved
    for name in OWN_SKILL_NAMES:
        p = os.path.join(dst, name)
        if os.path.isdir(p):
            tmp = tempfile.mkdtemp(prefix=f'own-{name}-')
            shutil.copytree(p, os.path.join(tmp, name), ignore=shutil.ignore_patterns('__pycache__', 'node_modules'))
            saved['own'][name] = os.path.join(tmp, name)
    for rel in OVERLAY_FILES:
        p = os.path.join(dst, native(rel))
        if os.path.isfile(p):
            saved['overlays'][rel] = open(p, 'rb').read()
    return saved


def restore_port_files(dst, saved):
    own_names = []
    for name, src_dir in saved.get('own', {}).items():
        target = os.path.join(dst, name)
        if os.path.isdir(target):
            shutil.rmtree(target)
        shutil.copytree(src_dir, target)
        shutil.rmtree(os.path.dirname(src_dir), ignore_errors=True)
        own_names.append(name)
    overlay_rels = []
    for rel, data in saved.get('overlays', {}).items():
        skill_name = rel.split('/')[0]
        if not os.path.isdir(os.path.join(dst, skill_name)):
            continue
        target = os.path.join(dst, native(rel))
        os.makedirs(os.path.dirname(target), exist_ok=True)
        open(target, 'wb').write(data)
        overlay_rels.append(rel)
    return own_names, overlay_rels


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
# form-compile: неизвестное событие — ошибка, а не тихий [WARN]
# (патч поверх upstream, чтобы пережить opencode_port.py build)
# ---------------------------------------------------------------------------
_FORM_COMPILE_PY_EVENTS_OLD = '''    # Validate event names
    if type_key and type_key in KNOWN_EVENTS:
        allowed = KNOWN_EVENTS[type_key]
        for ev_name, _, _ in pairs:
            if allowed and str(ev_name) not in allowed:
                print(f"[WARN] Unknown event '{ev_name}' for {type_key} '{element_name}'. Known: {', '.join(allowed)}")
'''
_FORM_COMPILE_PY_EVENTS_NEW = '''    # Validate event names. Раньше это был [WARN] в stdout, и модель продолжала:
    # платформа принимает XML и никогда не вызывает обработчик.
    known_element_events = []
    for _evs in KNOWN_EVENTS.values():
        for _n in _evs:
            if _n not in known_element_events:
                known_element_events.append(_n)
    if type_key and type_key in KNOWN_EVENTS:
        allowed = KNOWN_EVENTS[type_key]
        for ev_name, _, _ in pairs:
            if str(ev_name) not in allowed:
                reject_unknown_event(type_key or 'element', ev_name, element_name, allowed or ['(none)'])
    else:
        for ev_name, _, _ in pairs:
            if str(ev_name) not in known_element_events:
                reject_unknown_event(type_key or 'element', ev_name, element_name, known_element_events)
'''
_FORM_COMPILE_PY_WARN_OLD = '''# Незнакомое событие формы — предупреждение (опечатка в имени события не даёт ошибки платформы).
def warn_unknown_form_event(name):
    if name not in KNOWN_FORM_EVENTS:
        print(f"[WARN] Unknown form event '{name}'. Known: {', '.join(KNOWN_FORM_EVENTS)}")
'''
_FORM_COMPILE_PY_WARN_NEW = '''# Незнакомое событие — ошибка. Платформа кладёт имя в XML и молча не вызывает обработчик.
def reject_unknown_event(kind, name, owner, known):
    known_s = ', '.join(str(k) for k in known)
    msg = (f"[ERROR] Unknown {kind} event '{name}' for '{owner}'. "
           f"form-compile refuses it: the platform keeps the name in XML and never calls the handler. "
           f"Check 1c-help before inventing an event. Known: {known_s}.")
    if os.environ.get('FORM_COMPILE_ALLOW_UNKNOWN_EVENTS') == '1':
        print(f"[WARN] {msg} FORM_COMPILE_ALLOW_UNKNOWN_EVENTS=1 — continuing.", file=sys.stderr)
        print(f"[WARN] {msg} FORM_COMPILE_ALLOW_UNKNOWN_EVENTS=1 — continuing.")
        return
    print(msg, file=sys.stderr)
    print(msg)
    sys.exit(1)


def warn_unknown_form_event(name):
    if name not in KNOWN_FORM_EVENTS:
        reject_unknown_event('form', name, 'Form', KNOWN_FORM_EVENTS)
'''
_FORM_COMPILE_PY_FORM_EVENTS_OLD = '''    "OnSaveDataInSettingsAtServer", "ExternalEvent", "OnReopen", "Opening",
]
'''
_FORM_COMPILE_PY_FORM_EVENTS_NEW = '''    "OnSaveDataInSettingsAtServer", "ExternalEvent", "OnReopen", "Opening",
    "OnComposeResult", "OnSaveVariantAtServer", "BeforeLoadVariantAtServer", "OnLoadVariantAtServer",
    "OnSaveUserSettingsAtServer", "BeforeLoadUserSettingsAtServer", "OnLoadUserSettingsAtServer",
]
'''
_FORM_COMPILE_PY_SPREAD_OLD = '''    "picture": ["Click"],
    "cmdBar": [],
'''
_FORM_COMPILE_PY_SPREAD_NEW = '''    "picture": ["Click"],
    "spreadsheet": ["DetailProcessing", "AdditionalDetailProcessing", "OnChangeAreaContent", "OnActivate", "Selection"],
    "cmdBar": [],
'''
_FORM_COMPILE_PS_EVENTS_OLD = (
    '\t# Validate event names\n'
    '\tif ($typeKey -and $script:knownEvents.ContainsKey($typeKey)) {\n'
    '\t\t$allowed = $script:knownEvents[$typeKey]\n'
    '\t\tforeach ($pr in $pairs) {\n'
    '\t\t\tif ($allowed.Count -gt 0 -and $allowed -notcontains "$($pr.name)") {\n'
    '\t\t\t\tWrite-Host "[WARN] Unknown event \'$($pr.name)\' for $typeKey \'$elementName\'. Known: $($allowed -join \', \')"\n'
    '\t\t\t}\n'
    '\t\t}\n'
    '\t}\n'
)
_FORM_COMPILE_PS_EVENTS_NEW = (
    '\t# Validate event names (неизвестное имя → код 1; FORM_COMPILE_ALLOW_UNKNOWN_EVENTS=1 — только предупреждение)\n'
    '\t$knownAll = New-Object System.Collections.Generic.List[string]\n'
    '\tforeach ($k in $script:knownEvents.Keys) {\n'
    '\t\tforeach ($n in @($script:knownEvents[$k])) {\n'
    '\t\t\tif ($n -and -not $knownAll.Contains([string]$n)) { [void]$knownAll.Add([string]$n) }\n'
    '\t\t}\n'
    '\t}\n'
    '\tif ($typeKey -and $script:knownEvents.ContainsKey($typeKey)) {\n'
    '\t\t$allowed = @($script:knownEvents[$typeKey])\n'
    '\t\tforeach ($pr in $pairs) {\n'
    '\t\t\tif ($allowed -notcontains "$($pr.name)") {\n'
    '\t\t\t\tFail-UnknownEvent -Kind $typeKey -Name "$($pr.name)" -Owner $elementName -Known $allowed\n'
    '\t\t\t}\n'
    '\t\t}\n'
    '\t} else {\n'
    '\t\tforeach ($pr in $pairs) {\n'
    '\t\t\tif ($knownAll -notcontains "$($pr.name)") {\n'
    '\t\t\t\tFail-UnknownEvent -Kind $(if ($typeKey) { $typeKey } else { \'element\' }) -Name "$($pr.name)" -Owner $elementName -Known $knownAll\n'
    '\t\t\t}\n'
    '\t\t}\n'
    '\t}\n'
)
_FORM_COMPILE_PS_WARN_OLD = (
    '# Незнакомое событие формы — предупреждение (опечатка в имени события не даёт ошибки платформы).\n'
    'function Warn-UnknownFormEvent([string]$name) {\n'
    '\tif ($script:knownFormEvents -notcontains $name) {\n'
    '\t\tWrite-Host "[WARN] Unknown form event \'$name\'. Known: $($script:knownFormEvents -join \', \')"\n'
    '\t}\n'
    '}\n'
)
_FORM_COMPILE_PS_WARN_NEW = (
    '# Незнакомое событие — ошибка. Платформа кладёт имя в XML и молча не вызывает обработчик.\n'
    'function Fail-UnknownEvent {\n'
    '\tparam([string]$Kind, [string]$Name, [string]$Owner, $Known)\n'
    '\t$knownS = (@($Known) | Where-Object { $_ }) -join \', \'\n'
    '\t$msg = "[ERROR] Unknown $Kind event \'$Name\' for \'$Owner\'. form-compile refuses it: the platform keeps the name in XML and never calls the handler. Check 1c-help before inventing an event. Known: $knownS."\n'
    '\tif ($env:FORM_COMPILE_ALLOW_UNKNOWN_EVENTS -eq \'1\') {\n'
    '\t\tWrite-Host "[WARN] $msg FORM_COMPILE_ALLOW_UNKNOWN_EVENTS=1 — continuing." -ForegroundColor Yellow\n'
    '\t\treturn\n'
    '\t}\n'
    '\tWrite-Host $msg -ForegroundColor Red\n'
    '\texit 1\n'
    '}\n'
    'function Warn-UnknownFormEvent([string]$name) {\n'
    '\tif ($script:knownFormEvents -notcontains $name) {\n'
    '\t\tFail-UnknownEvent -Kind \'form\' -Name $name -Owner \'Form\' -Known $script:knownFormEvents\n'
    '\t}\n'
    '}\n'
)
_FORM_COMPILE_PS_LIST_OLD = (
    '"picture"   = @("Click")\n'
    '\t"cmdBar"    = @()\n'
)
_FORM_COMPILE_PS_LIST_NEW = (
    '"picture"   = @("Click")\n'
    '\t"spreadsheet" = @("DetailProcessing","AdditionalDetailProcessing","OnChangeAreaContent","OnActivate","Selection")\n'
    '\t"cmdBar"    = @()\n'
)
_FORM_COMPILE_PS_FORM_OLD = (
    '"ExternalEvent","OnReopen","Opening")'
)
_FORM_COMPILE_PS_FORM_NEW = (
    '"ExternalEvent","OnReopen","Opening",'
    '"OnComposeResult","OnSaveVariantAtServer","BeforeLoadVariantAtServer","OnLoadVariantAtServer",'
    '"OnSaveUserSettingsAtServer","BeforeLoadUserSettingsAtServer","OnLoadUserSettingsAtServer")'
)
_FORM_COMPILE_SKILL_OLD = (
    '**pages:** `OnCurrentPageChange`\n'
)
_FORM_COMPILE_SKILL_NEW = (
    '**pages:** `OnCurrentPageChange`\n'
    '**spreadsheet (поле табличного документа):** `DetailProcessing`, `AdditionalDetailProcessing`, '
    '`OnChangeAreaContent`, `OnActivate`, `Selection`\n'
    '**форма отчёта (СКД), дополнительно:** `OnComposeResult`, `OnSaveVariantAtServer`, `BeforeLoadVariantAtServer`, '
    '`OnLoadVariantAtServer`, `OnSaveUserSettingsAtServer`, `BeforeLoadUserSettingsAtServer`, '
    '`OnLoadUserSettingsAtServer`, `OnSaveDataInSettingsAtServer`, `OnReopen`\n'
)


def _replace_once(text, old, new, label):
    if old not in text:
        print(f'Предупреждение: якорь не найден ({label}) — патч не применён', file=sys.stderr)
        return text, False
    if text.count(old) != 1:
        print(f'Предупреждение: якорь встретился {text.count(old)} раз ({label}) — патч не применён', file=sys.stderr)
        return text, False
    return text.replace(old, new, 1), True


def patch_form_compile_events(skills_dir):
    """form-compile: неизвестное событие формы/элемента — код 1, а не тихий [WARN]."""
    patched = []
    py = os.path.join(skills_dir, 'form-compile', 'scripts', 'form-compile.py')
    ps = os.path.join(skills_dir, 'form-compile', 'scripts', 'form-compile.ps1')
    md = os.path.join(skills_dir, 'form-compile', 'SKILL.md')
    if os.path.isfile(py):
        text = read(py)
        ok = True
        for label, old, new in (
            ('py events', _FORM_COMPILE_PY_EVENTS_OLD, _FORM_COMPILE_PY_EVENTS_NEW),
            ('py warn', _FORM_COMPILE_PY_WARN_OLD, _FORM_COMPILE_PY_WARN_NEW),
            ('py form list', _FORM_COMPILE_PY_FORM_EVENTS_OLD, _FORM_COMPILE_PY_FORM_EVENTS_NEW),
            ('py spreadsheet', _FORM_COMPILE_PY_SPREAD_OLD, _FORM_COMPILE_PY_SPREAD_NEW),
        ):
            if new in text:
                continue
            text, one = _replace_once(text, old, new, label)
            ok = ok and one
        if ok and text != read(py):
            write(py, text)
            patched.append(os.path.relpath(py, skills_dir))
        elif 'def reject_unknown_event' not in text:
            print('Ошибка: form-compile.py не пропатчен (события)', file=sys.stderr)
    if os.path.isfile(ps):
        raw = open(ps, 'rb').read()
        bom = raw.startswith(b'\xef\xbb\xbf')
        text = raw.decode('utf-8-sig')
        changed = False
        for label, old, new in (
            ('ps events', _FORM_COMPILE_PS_EVENTS_OLD, _FORM_COMPILE_PS_EVENTS_NEW),
            ('ps warn', _FORM_COMPILE_PS_WARN_OLD, _FORM_COMPILE_PS_WARN_NEW),
            ('ps spreadsheet', _FORM_COMPILE_PS_LIST_OLD, _FORM_COMPILE_PS_LIST_NEW),
            ('ps form list', _FORM_COMPILE_PS_FORM_OLD, _FORM_COMPILE_PS_FORM_NEW),
        ):
            if new in text:
                continue
            text, one = _replace_once(text, old, new, label)
            changed = changed or one
        if changed:
            data = text.encode('utf-8')
            if bom:
                data = b'\xef\xbb\xbf' + data
            with open(ps, 'wb') as f:
                f.write(data)
            patched.append(os.path.relpath(ps, skills_dir))
        elif 'function Fail-UnknownEvent' not in text:
            print('Ошибка: form-compile.ps1 не пропатчен (события)', file=sys.stderr)
    if os.path.isfile(md):
        text = read(md)
        if _FORM_COMPILE_SKILL_NEW not in text:
            text, one = _replace_once(text, _FORM_COMPILE_SKILL_OLD, _FORM_COMPILE_SKILL_NEW, 'skill events')
            if one:
                write(md, text)
                patched.append(os.path.relpath(md, skills_dir))
    return patched


# ---------------------------------------------------------------------------
# Пароль базы: .v8-project.json или V8_DB_USER / V8_DB_PASSWORD, не командная строка
# ---------------------------------------------------------------------------
_CRED_PY_FN = '''
def _apply_database_connection(args, db, filled):
    """-Database задаёт соединение из записи. Явные path/server не затирают пустую запись."""
    if not getattr(args, 'Database', None) or not db:
        return
    kind = str(db.get('type') or '').strip().lower()
    if db.get('path') and kind != 'server':
        args.InfoBasePath = str(db['path'])
    elif db.get('server') and db.get('ref'):
        args.InfoBaseServer = str(db['server'])
        args.InfoBaseRef = str(db['ref'])
    elif db.get('path'):
        args.InfoBasePath = str(db['path'])
    filled.append('database ' + str(db.get('id') or args.Database) + ' from .v8-project.json')

def apply_db_credentials(args):
    """OpenCode: -UserName/-Password не обязательны. Источник (по убыванию): явный аргумент,
    -Database (id или aliases в databases[]), затем path или server+ref, затем V8_DB_USER / V8_DB_PASSWORD.
    Значение пароля в вывод не попадает."""
    if not hasattr(args, 'Password') and not hasattr(args, 'UserName'):
        return args
    # Снять окружающие кавычки до сопоставления с .v8-project.json (clean_path ещё впереди).
    for _attr in ('InfoBasePath', 'InfoBaseServer', 'InfoBaseRef', 'Database'):
        _v = getattr(args, _attr, '') or ''
        if isinstance(_v, str):
            _v = _v.strip()
            if len(_v) >= 2 and _v[0] == _v[-1] and _v[0] in (chr(34) + chr(39)):
                _v = _v[1:-1].strip()
            setattr(args, _attr, _v)
    db = None
    try:
        db = find_project_database(args)
    except Exception:
        db = None
    if getattr(args, 'Database', None) and not db:
        print('Error: база с id «%s» не найдена в .v8-project.json.' % args.Database, file=sys.stderr)
        sys.exit(1)
    filled = []
    _apply_database_connection(args, db, filled)
    if not getattr(args, 'UserName', None):
        user, src = '', ''
        if db and db.get('user'):
            user, src = str(db.get('user')), '.v8-project.json'
        elif os.environ.get('V8_DB_USER'):
            user, src = os.environ.get('V8_DB_USER'), 'V8_DB_USER'
        if user:
            args.UserName = user
            filled.append('user from ' + src)
    if not getattr(args, 'Password', None):
        pwd, src = '', ''
        if db and db.get('password'):
            pwd, src = str(db.get('password')), '.v8-project.json'
        elif os.environ.get('V8_DB_PASSWORD'):
            pwd, src = os.environ.get('V8_DB_PASSWORD'), 'V8_DB_PASSWORD'
        if pwd:
            args.Password = pwd
            filled.append('password from ' + src)
    if filled:
        print('Infobase credentials (' + ', '.join(filled) + ') — not passed on the command line.')
    return args


'''
_CRED_PY_ANCHOR = '''            if (db["server"].lower() == args.InfoBaseServer.lower()
                    and db["ref"].lower() == args.InfoBaseRef.lower()):
                return db
    return None
'''
_CRED_PS_ANCHOR = '''            if ($db.server.Equals($InfoBaseServer, [System.StringComparison]::OrdinalIgnoreCase) -and
                $db.ref.Equals($InfoBaseRef, [System.StringComparison]::OrdinalIgnoreCase)) { return $db }
        }
    }
    return $null
}
'''
_CRED_PS_CALL = r'''
# OpenCode: -Database <id> подставляет соединение, пользователя и пароль.
# Явный -Password сильнее, но в команду его не передают. Значение пароля не печатаем.
$dbRecCred = Find-ProjectDatabase
$credFrom = @()
if ($Database) {
    if (-not $dbRecCred) { Write-Host "Error: база с id '$Database' не найдена в .v8-project.json." -ForegroundColor Red; exit 1 }
    if ($dbRecCred.path -and [string]$dbRecCred.type -ne 'server') { $InfoBasePath = [string]$dbRecCred.path }
    elseif ($dbRecCred.server -and $dbRecCred.ref) {
        $InfoBaseServer = [string]$dbRecCred.server
        $InfoBaseRef = [string]$dbRecCred.ref
    } elseif ($dbRecCred.path) { $InfoBasePath = [string]$dbRecCred.path }
    $credFrom += ('database ' + [string]$dbRecCred.id + ' from .v8-project.json')
}
if (-not $UserName -or -not $Password) {
    if (-not $UserName) {
        if ($dbRecCred -and $dbRecCred.user) { $UserName = [string]$dbRecCred.user; $credFrom += 'user from .v8-project.json' }
        elseif ($env:V8_DB_USER) { $UserName = $env:V8_DB_USER; $credFrom += 'user from V8_DB_USER' }
    }
    if (-not $Password) {
        if ($dbRecCred -and $dbRecCred.password) { $Password = [string]$dbRecCred.password; $credFrom += 'password from .v8-project.json' }
        elseif ($env:V8_DB_PASSWORD) { $Password = $env:V8_DB_PASSWORD; $credFrom += 'password from V8_DB_PASSWORD' }
    }
}
if ($credFrom.Count) { Write-Host ("Infobase credentials (" + ($credFrom -join ', ') + ") — not passed on the command line.") }

'''


_FIND_PY_OLD = '''def find_project_database(args):
    """Запись базы в реестре, соответствующая переданному соединению. None, если не найдена."""
    pf = _sg_find_v8project(os.getcwd())
    if not pf:
        return None
    try:
        with open(pf, encoding="utf-8-sig") as f:
            proj = json.load(f)
    except Exception:
        return None
    for db in proj.get("databases") or []:
'''

_FIND_PY_NEW = '''def _db_token(value):
    return str(value or '').strip().lower()

def find_project_database(args):
    """Запись базы в реестре. Сначала -Database (id или aliases), иначе path или server+ref."""
    pf = _sg_find_v8project(os.getcwd())
    if not pf:
        return None
    try:
        with open(pf, encoding="utf-8-sig") as f:
            proj = json.load(f)
    except Exception:
        return None
    wanted = _db_token(getattr(args, 'Database', ''))
    if wanted:
        for db in proj.get("databases") or []:
            if _db_token(db.get('id')) == wanted:
                return db
            for alias in db.get('aliases') or []:
                if _db_token(alias) == wanted:
                    return db
        return None
    for db in proj.get("databases") or []:
'''

_FIND_PS_OLD = '''function Find-ProjectDatabase {
    # Запись базы в реестре, соответствующая переданному соединению. $null, если не найдена.
    $pf = Find-V8Project (Get-Location).Path
    if (-not $pf) { return $null }
    try { $proj = Get-Content $pf -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
    if (-not $proj.databases) { return $null }
    foreach ($db in $proj.databases) {
'''

_FIND_PS_NEW = '''function Find-ProjectDatabase {
    # Запись базы: сначала -Database (id или aliases), иначе path или server+ref.
    $pf = Find-V8Project (Get-Location).Path
    if (-not $pf) { return $null }
    try { $proj = Get-Content $pf -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
    if (-not $proj.databases) { return $null }
    $wanted = ''
    $var = Get-Variable -Name Database -Scope Script -ErrorAction SilentlyContinue
    if ($var -and $var.Value) { $wanted = ([string]$var.Value).Trim() }
    if ($wanted) {
        foreach ($db in @($proj.databases)) {
            if ($db.id -and [string]$db.id.Equals($wanted, [System.StringComparison]::OrdinalIgnoreCase)) { return $db }
            foreach ($alias in @($db.aliases)) {
                if ($alias -and [string]$alias.Equals($wanted, [System.StringComparison]::OrdinalIgnoreCase)) { return $db }
            }
        }
        return $null
    }
    foreach ($db in $proj.databases) {
'''


def patch_db_credentials(skills_dir):
    """Скрипты с -Password читают учётные данные базы сами. Явный аргумент по-прежнему сильнее."""
    patched = []
    py_files = glob.glob(os.path.join(skills_dir, '*', 'scripts', '**', '*.py'), recursive=True)
    for path in py_files:
        raw = open(path, 'rb').read()
        text = raw.decode('utf-8')
        orig = text
        if _FIND_PY_OLD in text:
            text = text.replace(_FIND_PY_OLD, _FIND_PY_NEW, 1)
        if re.search(r'''add_argument\(\s*['"]-Password['"]''', text) and not re.search(
                r'''add_argument\(\s*['"]-Database['"]''', text):
            text2, n = re.subn(
                r'''(?m)^(?P<ind>[ \t]*)parser\.add_argument\(\s*['"]-Password['"][^\n]*\n''',
                lambda m: m.group(0) + m.group('ind')
                + 'parser.add_argument("-Database", default="", help="id базы в .v8-project.json: соединение и пароль берутся из записи")\n',
                text, count=1)
            if n == 1:
                text = text2
        if not re.search(r'''add_argument\(\s*['"]-Password['"]''', text):
            # Раньше ловили упоминание -Password в тексте ошибки. Функцию, вставленную так, убираем.
            if _CRED_PY_FN in text:
                text = text.replace(_CRED_PY_FN, '\n', 1)
                open(path, 'wb').write(text.encode('utf-8'))
                patched.append(os.path.relpath(path, skills_dir))
            continue
        if 'def find_project_database' not in text:
            if text != orig:
                open(path, 'wb').write(text.encode('utf-8'))
                patched.append(os.path.relpath(path, skills_dir))
            continue
        # Обновить уже вставленную функцию, если в ней ещё нет снятия кавычек.
        if 'def apply_db_credentials' in text and 'chr(34)' not in text:
            text2, n = re.subn(
                r"\ndef apply_db_credentials\(args\):.*?not passed on the command line\.'\)\n    return args\n",
                _CRED_PY_FN.rstrip('\n') + '\n',
                text, count=1, flags=re.S)
            if n == 1:
                text = text2
        if 'def apply_db_credentials' not in text:
            text, one = _replace_once(text, _CRED_PY_ANCHOR, _CRED_PY_ANCHOR + _CRED_PY_FN, os.path.basename(path) + ' cred fn')
            if not one:
                continue
        if not re.search(r'(?m)^\s*apply_db_credentials\(args\)\s*$', text):
            text2, n = re.subn(
                r'^(?P<ind>[ \t]*)args = ci_parse_args\(parser(?:, argv)?\)\s*$',
                lambda m: m.group(0) + '\n' + m.group('ind') + 'apply_db_credentials(args)',
                text, count=1, flags=re.M)
            if n != 1:
                print(f'Предупреждение: нет вызова ci_parse_args для учётных данных в {path}', file=sys.stderr)
                continue
            text = text2
        if text != orig:
            open(path, 'wb').write(text.encode('utf-8'))
            patched.append(os.path.relpath(path, skills_dir))
    ps_files = glob.glob(os.path.join(skills_dir, '*', 'scripts', '**', '*.ps1'), recursive=True)
    for path in ps_files:
        raw = open(path, 'rb').read()
        bom = raw.startswith(b'\xef\xbb\xbf')
        text = raw.decode('utf-8-sig')
        if _FIND_PS_OLD in text:
            text = text.replace(_FIND_PS_OLD, _FIND_PS_NEW, 1)
        if '[string]$Password,' in text and '[string]$Database' not in text:
            text = text.replace(
                '[string]$Password,\n',
                '[string]$Password,\n\n    [Parameter(Mandatory=$false)]\n    [string]$Database,\n',
                1)
        if '[string]$Password' not in text or 'function Find-ProjectDatabase' not in text:
            if text != raw.decode('utf-8-sig'):
                data = text.encode('utf-8')
                if bom:
                    data = b'\xef\xbb\xbf' + data
                open(path, 'wb').write(data)
                patched.append(os.path.relpath(path, skills_dir))
            continue
        if 'OpenCode: пользователь и пароль' in text or '-Database <id> подставляет' in text:
            if text != raw.decode('utf-8-sig'):
                data = text.encode('utf-8')
                if bom:
                    data = b'\xef\xbb\xbf' + data
                open(path, 'wb').write(data)
                patched.append(os.path.relpath(path, skills_dir))
            continue
        text2, one = _replace_once(text, _CRED_PS_ANCHOR, _CRED_PS_ANCHOR + _CRED_PS_CALL, os.path.basename(path) + ' cred ps')
        if not one:
            continue
        data = text2.encode('utf-8')
        if bom:
            data = b'\xef\xbb\xbf' + data
        open(path, 'wb').write(data)
        patched.append(os.path.relpath(path, skills_dir))
    return patched


# ---------------------------------------------------------------------------
# PowerShell: stdout UTF-8 (Windows PowerShell по умолчанию пишет в OEM/cp866)
# ---------------------------------------------------------------------------
_PS_UTF8 = (
    '# 1C-Agent: stdout UTF-8 (Windows PowerShell по умолчанию пишет в OEM/cp866)\n'
    'try {\n'
    '\t$utf8 = New-Object System.Text.UTF8Encoding $false\n'
    '\t[Console]::InputEncoding = $utf8\n'
    '\t[Console]::OutputEncoding = $utf8\n'
    '\t$OutputEncoding = $utf8\n'
    '} catch {}\n'
)


def _inject_ps_utf8(text):
    if '1C-Agent: stdout UTF-8' in text:
        return text, False
    m = re.search(r'(?i)\bparam\s*\(', text)
    if not m:
        return _PS_UTF8 + '\n' + text, True
    i = m.end()  # сразу после '('
    depth = 1
    while i < len(text) and depth:
        ch = text[i]
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        i += 1
    if text[i:i + 2] == '\r\n':
        i += 2
        nl = '\r\n'
    elif text[i:i + 1] == '\n':
        i += 1
        nl = '\n'
    else:
        nl = '\n'
    snippet = _PS_UTF8.replace('\n', nl)
    return text[:i] + snippet + text[i:], True


def patch_powershell_utf8(skills_dir):
    patched = []
    for path in glob.glob(os.path.join(skills_dir, '*', 'scripts', '**', '*.ps1'), recursive=True):
        if 'node_modules' in path:
            continue
        raw = open(path, 'rb').read()
        bom = raw.startswith(b'\xef\xbb\xbf')
        text = raw.decode('utf-8-sig')
        new, changed = _inject_ps_utf8(text)
        if not changed:
            continue
        # сохраняем стиль перевода строк файла
        if '\r\n' in text and '\r\n' not in new.split('1C-Agent: stdout UTF-8', 1)[-1][:80]:
            pass
        data = new.encode('utf-8')
        if bom:
            data = b'\xef\xbb\xbf' + data
        open(path, 'wb').write(data)
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
    saved = save_port_files(dst)
    if os.path.isdir(dst):
        shutil.rmtree(dst)
    os.makedirs(dst)

    ignore = shutil.ignore_patterns('node_modules', '__pycache__', '.browser-session.json')
    for name in skills:
        shutil.copytree(os.path.join(src, name), os.path.join(dst, name), ignore=ignore)
        for md in collect_md_files(os.path.join(dst, name)):
            content = read(md)
            new = adapt_markdown(content, os.path.basename(md) == 'SKILL.md')
            if new != content:
                write(md, new)
    patched = patch_scripts(dst)
    own, overlays = restore_port_files(dst, saved)
    patched += patch_form_compile_events(dst)
    patched += patch_db_credentials(dst)
    patched += patch_powershell_utf8(dst)
    add_skill_notes(dst)
    apply_runtime(dst, args.runtime, verbose=False)

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
