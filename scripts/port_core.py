#!/usr/bin/env python3
# port_core.py — ядро сборки навыков 1С (cc-1c-skills) под OpenCode v2
# Upstream: https://github.com/Nikolay-Shirokov/cc-1c-skills (MIT)
"""
Общая логика пересборки skills/ из upstream cc-1c-skills и адаптации SKILL.md под OpenCode v2.
Точка входа для пользователя — scripts/opencode_port.py. Старый goose-скрипт: legacy/scripts/goose_port.py.
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
    ('читай результат через Read tool', 'читай результат инструментом чтения файлов'),
    ('Read tool', 'инструмент чтения файлов'),
    # web-test: run_in_background (Claude Code) -> shell OpenCode с background: true
    ('node $RUN start <url>            # run_in_background=true',
     'node $RUN start <url>            # shell с background: true'),
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
    'Если после загрузки и обновления доработка расширения «не работает» — сначала проверь свойства: '
    '`/db-cfe-admin list`, и сними режим: `/db-cfe-admin set-properties <база> -Name <Расширение> '
    '-SafeMode off` (нужен `ibcmd` и файловая база). Если `ibcmd` нет или база серверная — не ищи '
    'обходных путей, а скажи пользователю снять флажок вручную: в Предприятии «Все функции → '
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
# Свои навыки порта (их нет в upstream): копируются в skills/ при каждой сборке
OWN_SKILLS = 'own-skills'


def add_skill_notes(skills_dir):
    for note, targets in ((SAFE_MODE_NOTE, SKILL_NOTES), (BSL_CHECK_NOTE, BSL_CHECK_NOTES)):
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
    ],
}


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
          f'(рантайм: {args.runtime}, upstream {sha[:12]}, пропатчено скриптов: {len(patched)})')
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
