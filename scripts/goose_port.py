#!/usr/bin/env python3
# goose_port.py v1.0 — Порт навыков 1С (cc-1c-skills) под AI-агент goose
# Upstream: https://github.com/Nikolay-Shirokov/cc-1c-skills (MIT)
"""
Сборка и установка навыков 1С для goose (https://github.com/block/goose).

goose находит навыки в `.agents/skills/` проекта и в `~/.agents/skills/`,
а хуки — в плагинах `.agents/plugins/<имя>/` и `~/.agents/plugins/<имя>/`.

Команды:
  build    — пересобрать .agents/skills/ этого репозитория из upstream cc-1c-skills
  install  — установить навыки в проект (или глобально в ~/.agents/skills/)
  runtime  — переключить рантайм скриптов (PowerShell <-> Python) у установленных навыков
  uninstall — удалить установленные навыки (и плагин хуков)

Примеры:
  python scripts/goose_port.py install --project-dir /path/to/my-1c-project
  python scripts/goose_port.py install --project-dir . --runtime python --hooks --hints
  python scripts/goose_port.py install --global
  python scripts/goose_port.py runtime python --project-dir /path/to/my-1c-project
  python scripts/goose_port.py build --upstream ../cc-1c-skills
"""
import argparse
import glob
import os
import re
import shutil
import subprocess
import sys
import tempfile

UPSTREAM_URL = 'https://github.com/Nikolay-Shirokov/cc-1c-skills.git'

SKILLS_PREFIX = '.agents/skills'
PLUGINS_PREFIX = '.agents/plugins'
HOOKS_PLUGIN = '1c-support-guard'

GITIGNORE_RECOMMENDATIONS = [
    '.v8-project.json',
    'build/',
    'base/',
    '*.epf',
    '*.erf',
    '*.log',
]

# ---------------------------------------------------------------------------
# Пути и рантайм (логика совместима со scripts/switch.py из upstream)
# ---------------------------------------------------------------------------
# ${CLAUDE_SKILL_DIR}/../<other>/<rest> — ссылка на соседний навык
RX_SKILL_DIR_CROSS = re.compile(r'\$\{CLAUDE_SKILL_DIR\}/\.\./([a-z][a-z0-9-]+)/')
SKILL_DIR_VAR = '${CLAUDE_SKILL_DIR}/'

# Префикс путей к навыкам в собранных SKILL.md (не часть более длинного пути).
RX_SKILLS_PREFIX = re.compile(r'(?<![\w/~.\\-])\.agents/skills/')

RX_PS = re.compile(
    r'powershell\.exe\s+'
    r'(?:-NoProfile\s+)?'
    r'(?:-ExecutionPolicy\s+\S+\s+)?'
    r'-File\s+(?P<q>["\']?)(?P<path>[^"\s]+?)\.ps1(?P=q)?'
)
RX_PY = re.compile(r"python\s+(?P<q>[\"']?)(?P<path>[^\"\s]+?)\.py(?P=q)?")


def ps_invocation(path, quote):
    return f"powershell.exe -NoProfile -File {quote}{path}.ps1{quote}"


def switch_runtime_content(content, runtime):
    if runtime == 'python':
        return RX_PS.sub(lambda m: f"python {m.group('q')}{m.group('path')}.py{m.group('q')}", content)
    if runtime == 'powershell':
        return RX_PY.sub(lambda m: ps_invocation(m.group('path'), m.group('q')), content)
    return content


def repo_root():
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


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


def missing_runtime_files(skill_dir, runtime, skills_root):
    """Скрипты целевого рантайма, на которые сослался бы SKILL.md, но которых нет."""
    rx, ext = (RX_PS, '.py') if runtime == 'python' else (RX_PY, '.ps1')
    missing = []
    for md in collect_md_files(skill_dir):
        for m in rx.finditer(read(md)):
            # Путь относительный (.agents/skills/...) или абсолютный (глобальная установка)
            p = m.group('path')
            idx = p.find(SKILLS_PREFIX + '/')
            if idx < 0:
                continue
            rel = p[idx + len(SKILLS_PREFIX) + 1:]
            if not os.path.isfile(os.path.join(skills_root, rel + ext)):
                missing.append(rel + ext)
    return missing


def apply_runtime(skills_dir, runtime, verbose=True):
    """Переключить рантайм во всех .md навыков. Навыки, у которых нет скриптов
    целевого рантайма (например, img-grid — только Python), не трогаются."""
    switched, single = 0, []
    for name in scan_skills(skills_dir):
        skill_dir = os.path.join(skills_dir, name)
        if missing_runtime_files(skill_dir, runtime, skills_dir):
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
GOOSE_TEXT_REPLACEMENTS = [
    ('Спроси у пользователя через AskUserQuestion', 'Спроси у пользователя'),
    ('через AskUserQuestion', 'вопросом пользователю'),
    ('AskUserQuestion', 'вопрос пользователю'),
    ('читай результат через Read tool', 'читай результат инструментом чтения файлов'),
    ('Read tool', 'инструмент чтения файлов'),
    # web-test: в goose нет run_in_background — фоновый запуск средствами shell
    # (shell-инструмент goose не ждёт процессы, отправленные в фон через &).
    ('node $RUN start <url>            # run_in_background=true',
     'nohup node $RUN start <url> > "${TMPDIR:-/tmp}/web-test-start.log" 2>&1 &   # в фоне: goose не ждёт процесс с &'),
]

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


def adapt_markdown(content, skill_name, is_skill_md):
    # ${CLAUDE_SKILL_DIR} -> путь от корня проекта (goose запускает shell в каталоге проекта)
    content = RX_SKILL_DIR_CROSS.sub(f'{SKILLS_PREFIX}/\\1/', content)
    content = content.replace(SKILL_DIR_VAR, f'{SKILLS_PREFIX}/{skill_name}/')
    for old, new in GOOSE_TEXT_REPLACEMENTS:
        content = content.replace(old, new)
    if is_skill_md:
        m = RX_FRONTMATTER.match(content)
        if m:
            content = '---\n' + adapt_frontmatter(m.group('body')) + '\n---\n' + content[m.end():]
    return content


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

    dst = os.path.join(repo_root(), SKILLS_PREFIX.replace('/', os.sep))
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
            new = adapt_markdown(content, name, os.path.basename(md) == 'SKILL.md')
            if new != content:
                write(md, new)
    apply_runtime(dst, args.runtime, verbose=False)

    sha = ''
    try:
        sha = subprocess.run(['git', '-C', upstream, 'rev-parse', 'HEAD'],
                             capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        pass
    write(os.path.join(repo_root(), 'UPSTREAM'),
          f'{UPSTREAM_URL}\n{sha}\n')
    print(f'Собрано {len(skills)} навыков в {SKILLS_PREFIX}/ (рантайм: {args.runtime}, upstream {sha[:12]})')
    if not args.upstream:
        shutil.rmtree(upstream, ignore_errors=True)
    return 0


# ---------------------------------------------------------------------------
# install / uninstall / runtime
# ---------------------------------------------------------------------------
def target_base(args):
    return os.path.expanduser('~') if args.is_global else os.path.abspath(args.project_dir)


def rewrite_prefix_absolute(skills_dir):
    """Для глобальной установки относительные пути `.agents/skills/...` из SKILL.md
    не работают (shell goose стартует в каталоге проекта) — делаем их абсолютными."""
    abs_prefix = skills_dir.replace('\\', '/').rstrip('/') + '/'
    if ' ' in abs_prefix:
        print(f'Предупреждение: путь "{abs_prefix}" содержит пробелы — '
              f'часть команд в SKILL.md может потребовать кавычек.', file=sys.stderr)
    for md in glob.glob(os.path.join(skills_dir, '**', '*.md'), recursive=True):
        content = read(md)
        new = RX_SKILLS_PREFIX.sub(lambda _: abs_prefix, content)
        if new != content:
            write(md, new)


def install_hooks(base):
    src = os.path.join(repo_root(), 'goose', 'plugins', HOOKS_PLUGIN)
    dst = os.path.join(base, PLUGINS_PREFIX.replace('/', os.sep), HOOKS_PLUGIN)
    if os.path.isdir(dst):
        shutil.rmtree(dst)
    shutil.copytree(src, dst, ignore=shutil.ignore_patterns('test'))
    print(f'Плагин хуков установлен: {dst}')


def install_hints(base, is_global):
    """Подсказки проекта для goose: <проект>/.goosehints или ~/.config/goose/.goosehints."""
    src = os.path.join(repo_root(), 'goose', '.goosehints')
    dst = (os.path.join(base, '.config', 'goose', '.goosehints') if is_global
           else os.path.join(base, '.goosehints'))
    if os.path.isfile(dst):
        print(f'{dst} уже существует — не перезаписываю. Образец: {src}')
        return
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy2(src, dst)
    print(f'Подсказки goose установлены: {dst}')


def print_gitignore_recommendations(project_dir):
    path = os.path.join(project_dir, '.gitignore')
    existing = set()
    if os.path.isfile(path):
        existing = {line.strip() for line in read(path).splitlines()}
    missing = [r for r in GITIGNORE_RECOMMENDATIONS if r not in existing]
    if missing:
        print('\nРекомендуется добавить в .gitignore проекта:')
        for r in missing:
            print('  ' + r)


def cmd_install(args):
    src = os.path.join(repo_root(), SKILLS_PREFIX.replace('/', os.sep))
    skills = scan_skills(src)
    if not skills:
        print(f'Ошибка: навыки не найдены в {src}. Сначала выполните build.', file=sys.stderr)
        return 1
    base = target_base(args)
    if not os.path.isdir(base):
        print(f"Ошибка: каталог '{base}' не найден.", file=sys.stderr)
        return 1
    dst = os.path.join(base, SKILLS_PREFIX.replace('/', os.sep))
    if os.path.realpath(dst) == os.path.realpath(src):
        if args.runtime:
            apply_runtime(dst, args.runtime)
        if args.hooks:
            install_hooks(base)
        if args.hints:
            install_hints(base, args.is_global)
        return 0

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

    if args.runtime:
        apply_runtime(dst, args.runtime)
    if args.is_global:
        rewrite_prefix_absolute(dst)
    if args.hooks:
        install_hooks(base)
    if args.hints:
        install_hints(base, args.is_global)
    if not args.is_global:
        print_gitignore_recommendations(base)
    print('\nЗапустите goose из каталога проекта — навыки появятся в `/skills` и `goose skills list`.')
    return 0


def cmd_uninstall(args):
    base = target_base(args)
    src_names = set(scan_skills(os.path.join(repo_root(), SKILLS_PREFIX.replace('/', os.sep))))
    dst = os.path.join(base, SKILLS_PREFIX.replace('/', os.sep))
    if os.path.realpath(dst) == os.path.realpath(os.path.join(repo_root(), SKILLS_PREFIX)):
        print('Ошибка: нельзя удалять навыки из самого репозитория порта.', file=sys.stderr)
        return 1
    removed = 0
    for name in scan_skills(dst):
        if name in src_names:
            shutil.rmtree(os.path.join(dst, name))
            removed += 1
    hooks = os.path.join(base, PLUGINS_PREFIX.replace('/', os.sep), HOOKS_PLUGIN)
    if os.path.isdir(hooks):
        shutil.rmtree(hooks)
        print(f'Удалён плагин хуков: {hooks}')
    print(f'Удалено навыков: {removed} из {dst}')
    return 0


def cmd_runtime(args):
    dst = os.path.join(target_base(args), SKILLS_PREFIX.replace('/', os.sep))
    if not scan_skills(dst):
        print(f'Ошибка: навыки не найдены в {dst}', file=sys.stderr)
        return 1
    apply_runtime(dst, args.runtime)
    return 0


def main():
    parser = argparse.ArgumentParser(
        description='Навыки 1С для goose: сборка из upstream и установка',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__.split('Примеры:', 1)[1] if 'Примеры:' in __doc__ else None,
    )
    sub = parser.add_subparsers(dest='cmd', required=True)

    def add_target(p):
        g = p.add_mutually_exclusive_group()
        g.add_argument('--project-dir', default=os.getcwd(),
                       help='целевой проект (по умолчанию: текущий каталог)')
        g.add_argument('--global', dest='is_global', action='store_true',
                       help='установка для пользователя: ~/.agents/skills/')

    p = sub.add_parser('build', help='пересобрать .agents/skills/ из upstream cc-1c-skills')
    p.add_argument('--upstream', help='путь к локальному клону cc-1c-skills (иначе git clone)')
    p.add_argument('--ref', help='ветка/тег upstream для git clone (по умолчанию main)')
    p.add_argument('--runtime', choices=['powershell', 'python'], default='powershell')
    p.set_defaults(func=cmd_build)

    p = sub.add_parser('install', help='установить навыки в проект или глобально')
    add_target(p)
    p.add_argument('--runtime', choices=['powershell', 'python'],
                   help='рантайм скриптов (по умолчанию как в репозитории — PowerShell)')
    p.add_argument('--hooks', action='store_true',
                   help='[экспериментально] установить плагин хуков 1c-support-guard')
    p.add_argument('--hints', action='store_true',
                   help='скопировать подсказки goose/.goosehints в проект (если файла ещё нет)')
    p.set_defaults(func=cmd_install)

    p = sub.add_parser('runtime', help='переключить рантайм у установленных навыков')
    p.add_argument('runtime', choices=['powershell', 'python'])
    add_target(p)
    p.set_defaults(func=cmd_runtime)

    p = sub.add_parser('uninstall', help='удалить установленные навыки и плагин хуков')
    add_target(p)
    p.set_defaults(func=cmd_uninstall)

    args = parser.parse_args()
    if not hasattr(args, 'is_global'):
        args.is_global = False
    return args.func(args)


if __name__ == '__main__':
    sys.exit(main() or 0)
