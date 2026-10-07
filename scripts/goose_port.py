#!/usr/bin/env python3
# goose_port.py v2.0 — Порт навыков 1С (cc-1c-skills) под AI-агент goose
# Upstream: https://github.com/Nikolay-Shirokov/cc-1c-skills (MIT)
"""
Сборка и установка навыков 1С для goose (https://github.com/block/goose).

Репозиторий — плагин goose (Open Plugins): plugin.json, skills/, hooks/hooks.json.
Основной способ установки — `goose plugin install https://github.com/mika-com/1C_MCP_GOOSE`.
Этот скрипт нужен для пересборки из upstream и для установки навыков без плагина.

Команды:
  build     — пересобрать skills/ из upstream cc-1c-skills
  install   — установить навыки в проект (.agents/skills/) или для пользователя (~/.agents/skills/)
  runtime   — жёстко переключить рантайм (PowerShell <-> Python) у установленных навыков
  uninstall — удалить навыки, установленные командой install

Примеры:
  python scripts/goose_port.py install --project-dir /path/to/my-1c-project
  python scripts/goose_port.py install --project-dir . --runtime python --hooks --hints
  python scripts/goose_port.py install --global
  python scripts/goose_port.py runtime python --project-dir /path/to/my-1c-project
  python scripts/goose_port.py build --upstream ../cc-1c-skills
"""
import argparse
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

UPSTREAM_URL = 'https://github.com/Nikolay-Shirokov/cc-1c-skills.git'

REPO_SKILLS = 'skills'              # навыки в репозитории (каталог skills/ плагина)
INSTALL_SKILLS = '.agents/skills'   # куда install кладёт навыки без плагина
PLUGINS_PREFIX = '.agents/plugins'
HOOKS_PLUGIN = '1c-tools'          # хуки и ask_user для установки без плагина
OLD_HOOKS_PLUGINS = ('1c-support-guard',)

# Каталог навыка в командах SKILL.md. goose при загрузке навыка выводит его абсолютный путь
# («Skill directory: ...»), поэтому одни и те же SKILL.md работают из плагина, из проекта
# и из ~/.agents/skills. Без «$», чтобы shell не подставил пустую переменную.
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
# Адаптация SKILL.md из формата Claude Code в формат goose
# ---------------------------------------------------------------------------
# web-test: Playwright ставится не внутрь навыка, а в каталог-предок: goose при загрузке навыка
# перечисляет модели все его файлы, и node_modules (~550 файлов) раздул бы контекст, а Node находит
# пакет в родительских каталогах скрипта. Для плагина (~/.agents/plugins/1c/...) и ~/.agents/skills
# это ~/.agents — переживает `goose plugin update`, который заменяет каталог плагина целиком.
# При установке в проект install переписывает префикс на <проект>/.agents.
WEB_TEST_PREFIX = '"$HOME/.agents"'
WEB_TEST_PREFIX_PROJECT = f'"{SKILL_DIR}/../.."'
WEB_TEST_SETUP = (f'npm install --prefix {WEB_TEST_PREFIX} --no-fund --no-audit "playwright@^1.50.0" '
                  f'&& npx --prefix {WEB_TEST_PREFIX} playwright install chromium')

GOOSE_TEXT_REPLACEMENTS = [
    # AskUserQuestion (Claude Code) -> ask_user: MCP-сервер плагина mcp/ask-user.mjs показывает форму
    ('Спроси у пользователя через AskUserQuestion', 'Спроси у пользователя через инструмент `ask_user` (форма)'),
    ('через AskUserQuestion', 'через инструмент `ask_user` (форма)'),
    ('AskUserQuestion', 'инструмент `ask_user`'),
    ('читай результат через Read tool', 'читай результат инструментом чтения файлов'),
    ('Read tool', 'инструмент чтения файлов'),
    # web-test: в goose нет run_in_background — фоновый запуск средствами shell
    # (shell-инструмент goose не ждёт процессы, отправленные в фон через &).
    ('node $RUN start <url>            # run_in_background=true',
     'nohup node $RUN start <url> > "${TMPDIR:-/tmp}/web-test-start.log" 2>&1 &   # в фоне: goose не ждёт процесс с &'),
    (f'cd "{SKILL_DIR}/scripts" && npm install && npx playwright install chromium', WEB_TEST_SETUP),
    ("Requires Node.js 18+. `npm install` fetches Playwright; `npx playwright install chromium` downloads the browser.",
     "Requires Node.js 18+. `npm install` puts Playwright into `node_modules` of a parent directory of the "
     "skill (outside the skill, so goose does not list it as skill files; Node resolves packages from parent "
     "directories). `npx playwright install chromium` downloads the browser. If `run.mjs` fails with "
     "\"Cannot find package 'playwright'\", repeat this setup."),
]

GOOSE_NOTE = (
    '> **goose:** `{SKILL_DIR}` в командах — каталог этого навыка: подставь абсолютный путь из строки '
    '`Skill directory:` (раздел Supporting Files в конце). Команды запускай из корня проекта. '
    'Если `powershell.exe` недоступен (Linux/macOS), запусти одноимённый `.py`-скрипт через `python` '
    '(или `python3`) с теми же параметрами.\n\n'
)

MANUAL_ONLY_NOTE = ' Вызывай только по явной просьбе пользователя.'

RX_FRONTMATTER = re.compile(r'\A---\n(?P<body>.*?)\n---\n', re.S)


def adapt_frontmatter(fm):
    """allowed-tools — имена инструментов Claude Code, в goose их нет: удаляем.
    disable-model-invocation goose не поддерживает: переносим смысл в description."""
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
            manual_only = line.split(':', 1)[1].strip().lower() == 'true'
            i += 1
            continue
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
    for old, new in GOOSE_TEXT_REPLACEMENTS:
        content = content.replace(old, new)
    if is_skill_md:
        m = RX_FRONTMATTER.match(content)
        if m:
            body = content[m.end():]
            if SKILL_DIR in body:
                # Заметка — сразу после заголовка навыка
                h = re.match(r'(\s*#[^\n]*\n\n?)', body)
                body = (h.group(1) + GOOSE_NOTE + body[h.end():]) if h else GOOSE_NOTE + body
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
OWN_SKILLS = 'goose/skills'


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


# В плагине скрипты лежат вне проекта (~/.agents/plugins/...), поэтому корень проекта —
# рабочий каталог сессии goose, а не «4 уровня вверх от скрипта», как в upstream.
SCRIPT_PATCHES = {
    '.ps1': [
        ('$projectRoot = (Get-Item $PSScriptRoot).Parent.Parent.Parent.Parent.FullName',
         '$projectRoot = (Get-Location).Path  # goose: корень проекта — рабочий каталог'),
    ],
    '.py': [
        ('project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(script_dir))))',
         'project_root = os.getcwd()  # goose: корень проекта — рабочий каталог'),
    ],
    '.mjs': [
        ("export const projectRoot = pathResolve(dirname(__fn_state), '..', '..', '..', '..', '..', '..');",
         "// goose: навыки могут лежать вне проекта (плагин), корень проекта — рабочий каталог\n"
         "export const projectRoot = process.env.V8_PROJECT_ROOT ? pathResolve(process.env.V8_PROJECT_ROOT) "
         ": process.cwd();"),
        # Скриншот ошибки — во временный каталог, а не в каталог навыка (в плагине это ~/.agents/plugins/...,
        # а каждый файл в каталоге навыка goose перечисляет модели при загрузке навыка).
        ("import { fileURLToPath } from 'url';\nimport * as browser from '../browser.mjs';",
         "import { fileURLToPath } from 'url';\nimport { tmpdir } from 'os';\nimport * as browser from '../browser.mjs';"),
        ("const DEFAULT_ERROR_SHOT_PATH = resolve(__dirname, '..', '..', 'error-shot.png');",
         "const DEFAULT_ERROR_SHOT_PATH = resolve(tmpdir(), 'web-test-error-shot.png');  // goose"),
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


# ---------------------------------------------------------------------------
# install / uninstall / runtime (установка без плагина)
# ---------------------------------------------------------------------------
def target_base(args):
    return os.path.expanduser('~') if args.is_global else os.path.abspath(args.project_dir)


def install_hooks(base):
    """Хуки и форма вопросов ask_user отдельным плагином goose: <base>/.agents/plugins/1c-tools/."""
    plugins = os.path.join(base, native(PLUGINS_PREFIX))
    for old in OLD_HOOKS_PLUGINS:
        if os.path.isdir(os.path.join(plugins, old)):
            shutil.rmtree(os.path.join(plugins, old))
    dst = os.path.join(plugins, HOOKS_PLUGIN)
    if os.path.isdir(dst):
        shutil.rmtree(dst)
    shutil.copytree(os.path.join(repo_root(), 'hooks'), os.path.join(dst, 'hooks'),
                    ignore=shutil.ignore_patterns('test'))
    shutil.copytree(os.path.join(repo_root(), 'mcp'), os.path.join(dst, 'mcp'))
    # mcp/bsl-ls.mjs ищет BSL LS модулем навыка bsl-check — кладём копию рядом
    shutil.copy2(os.path.join(repo_root(), native(OWN_SKILLS), 'bsl-check', 'scripts', 'bsl-ls.mjs'),
                 os.path.join(dst, 'mcp', 'bsl-ls-locate.mjs'))
    manifest = {
        'name': HOOKS_PLUGIN,
        'version': '1.0.0',
        'description': 'Навыки 1С: защита объектов на поддержке (хук), форма вопросов ask_user, поиск по выгрузке, BSL LS.',
        'mcpServers': json.load(open(os.path.join(repo_root(), 'plugin.json'), encoding='utf-8'))['mcpServers'],
    }
    write(os.path.join(dst, 'plugin.json'), json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    print(f'Плагин 1c-tools (хук, ask_user, поиск, BSL LS) установлен: {dst}')


def install_hints(base, is_global):
    """Подсказки для goose: <проект>/.goosehints или ~/.config/goose/.goosehints."""
    src = os.path.join(repo_root(), 'goose', '.goosehints')
    dst = (os.path.join(base, '.config', 'goose', '.goosehints') if is_global
           else os.path.join(base, '.goosehints'))
    if os.path.isfile(dst):
        print(f'{dst} уже существует — не перезаписываю. Образец: {src}')
        return
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy2(src, dst)
    print(f'Подсказки goose установлены: {dst}')


def install_recipes(base):
    """Рецепты этапов работы: <base>/.agents/recipes (goose ищет там и в проекте, и в домашнем каталоге)."""
    src = os.path.join(repo_root(), 'goose', 'recipes')
    if not os.path.isdir(src):
        return
    dst = os.path.join(base, '.agents', 'recipes')
    os.makedirs(dst, exist_ok=True)
    names = [f for f in sorted(os.listdir(src)) if f.endswith('.yaml')]
    for f in names:
        shutil.copy2(os.path.join(src, f), os.path.join(dst, f))
    print(f'Рецепты ({len(names)}): {dst}')


def print_gitignore_recommendations(project_dir):
    path = os.path.join(project_dir, '.gitignore')
    existing = set()
    if os.path.isfile(path):
        existing = {line.strip() for line in read(path).splitlines()}
    recs = GITIGNORE_RECOMMENDATIONS + ['.agents/node_modules/', '.agents/package.json',
                                        '.agents/package-lock.json']
    missing = [r for r in recs if r not in existing]
    if missing:
        print('\nРекомендуется добавить в .gitignore проекта:')
        for r in missing:
            print('  ' + r)


def cmd_install(args):
    src = os.path.join(repo_root(), REPO_SKILLS)
    skills = scan_skills(src)
    if not skills:
        print(f'Ошибка: навыки не найдены в {src}. Сначала выполните build.', file=sys.stderr)
        return 1
    base = target_base(args)
    if not os.path.isdir(base):
        print(f"Ошибка: каталог '{base}' не найден.", file=sys.stderr)
        return 1
    dst = os.path.join(base, native(INSTALL_SKILLS))
    os.makedirs(dst, exist_ok=True)
    for name in os.listdir(src):
        p = os.path.join(src, name)
        if os.path.isfile(p):
            shutil.copy2(p, os.path.join(dst, name))
    ignore = shutil.ignore_patterns('node_modules', '__pycache__', '.browser-session.json')
    for name in skills:
        target = os.path.join(dst, name)
        if os.path.isdir(target):
            shutil.rmtree(target)
        shutil.copytree(os.path.join(src, name), target, ignore=ignore)
    print(f'Установлено {len(skills)} навыков в {dst}')

    if not args.is_global:
        # web-test: ~/.agents не предок <проект>/.agents/skills — ставим Playwright в <проект>/.agents
        for md in collect_md_files(os.path.join(dst, 'web-test')):
            content = read(md)
            new = content.replace(f'--prefix {WEB_TEST_PREFIX} ', f'--prefix {WEB_TEST_PREFIX_PROJECT} ')
            if new != content:
                write(md, new)
    if args.runtime:
        apply_runtime(dst, args.runtime)
    if args.hooks:
        install_hooks(base)
    if args.hints:
        install_hints(base, args.is_global)
    install_recipes(base)
    if not args.is_global:
        print_gitignore_recommendations(base)
    print('\nЗапустите goose из каталога проекта — навыки появятся в `/skills` и `goose skills list`.')
    print('Не ставьте одновременно плагин `1c` и навыки через install — получатся дубли.')
    return 0


def cmd_uninstall(args):
    base = target_base(args)
    src_names = set(scan_skills(os.path.join(repo_root(), REPO_SKILLS)))
    dst = os.path.join(base, native(INSTALL_SKILLS))
    removed = 0
    for name in scan_skills(dst):
        if name in src_names:
            shutil.rmtree(os.path.join(dst, name))
            removed += 1
    for name in (HOOKS_PLUGIN,) + OLD_HOOKS_PLUGINS:
        hooks = os.path.join(base, native(PLUGINS_PREFIX), name)
        if os.path.isdir(hooks):
            shutil.rmtree(hooks)
            print(f'Удалён плагин: {hooks}')
    rdir = os.path.join(base, '.agents', 'recipes')
    src_recipes = os.path.join(repo_root(), 'goose', 'recipes')
    if os.path.isdir(rdir) and os.path.isdir(src_recipes):
        for f in os.listdir(src_recipes):
            if os.path.isfile(os.path.join(rdir, f)):
                os.remove(os.path.join(rdir, f))
    print(f'Удалено навыков: {removed} из {dst}')
    return 0


def cmd_runtime(args):
    dst = os.path.join(target_base(args), native(INSTALL_SKILLS))
    if not scan_skills(dst):
        print(f'Ошибка: навыки не найдены в {dst}', file=sys.stderr)
        return 1
    apply_runtime(dst, args.runtime)
    return 0


def main():
    parser = argparse.ArgumentParser(
        description='Навыки 1С для goose: сборка из upstream и установка без плагина',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='Примеры:' + __doc__.split('Примеры:', 1)[1],
    )
    sub = parser.add_subparsers(dest='cmd', required=True)

    def add_target(p):
        g = p.add_mutually_exclusive_group()
        g.add_argument('--project-dir', default=os.getcwd(),
                       help='целевой проект (по умолчанию: текущий каталог)')
        g.add_argument('--global', dest='is_global', action='store_true',
                       help='для пользователя: ~/.agents/skills/')

    p = sub.add_parser('build', help='пересобрать skills/ из upstream cc-1c-skills')
    p.add_argument('--upstream', help='путь к локальному клону cc-1c-skills (иначе git clone)')
    p.add_argument('--ref', help='ветка/тег upstream для git clone (по умолчанию main)')
    p.add_argument('--runtime', choices=['powershell', 'python'], default='powershell')
    p.set_defaults(func=cmd_build)

    p = sub.add_parser('install', help='установить навыки в проект или для пользователя (без плагина)')
    add_target(p)
    p.add_argument('--runtime', choices=['powershell', 'python'],
                   help='жёстко прописать рантайм (по умолчанию PowerShell с откатом на Python)')
    p.add_argument('--hooks', action='store_true',
                   help='установить хук, форму вопросов ask_user, поиск по выгрузке и BSL LS как MCP (плагин 1c-tools)')
    p.add_argument('--hints', action='store_true',
                   help='скопировать goose/.goosehints в проект (если файла ещё нет)')
    p.set_defaults(func=cmd_install)

    p = sub.add_parser('runtime', help='переключить рантайм у навыков, установленных install')
    p.add_argument('runtime', choices=['powershell', 'python'])
    add_target(p)
    p.set_defaults(func=cmd_runtime)

    p = sub.add_parser('uninstall', help='удалить навыки, установленные install, и плагин хуков')
    add_target(p)
    p.set_defaults(func=cmd_uninstall)

    args = parser.parse_args()
    if not hasattr(args, 'is_global'):
        args.is_global = False
    return args.func(args)


if __name__ == '__main__':
    sys.exit(main() or 0)
