#!/usr/bin/env python3
"""
Сборка и установка агента 1С для OpenCode v2.

Команды:
  build     — пересобрать skills/ из upstream cc-1c-skills (сохраняя собственные навыки в skills/)
  install   — установить навыки, агентов и команды в проект (.opencode/) или глобально (~/.config/opencode/)
              и зарегистрировать MCP-серверы (~/.config/opencode/opencode.json), плагин bsl-autocheck
              (проверка BSL после каждой правки) и плагин shell-guard
              (запрет COM, интерактивного 1cv8 и загрузки конфигурации вне db-*)
  runtime   — переключить рантайм (powershell/python) у установленных навыков
  uninstall — удалить установленное командой install

Примеры:
  python scripts/opencode_port.py install --project-dir /path/to/my-1c-project
  python scripts/opencode_port.py install --project-dir . --runtime python
  python scripts/opencode_port.py install --global
  python scripts/opencode_port.py build --upstream ../cc-1c-skills
"""

import argparse
import json
import os
import pathlib
import shutil
import subprocess
import sys

import port_core as core

GLOBAL_DIR = os.path.join('.config', 'opencode')
PROJECT_DIR = '.opencode'
GLOBAL_NODE_PREFIX = '"$HOME/.config/opencode"'
PROJECT_NODE_PREFIX = f'"{core.SKILL_DIR}/../.."'
MARKER = '.1c-opencode'   # список установленных файлов агентов/команд


def repo_root():
    return core.repo_root()


def target_base(args):
    return os.path.expanduser('~') if args.is_global else os.path.abspath(args.project_dir)


def opencode_dir(base, is_global):
    return os.path.join(base, GLOBAL_DIR if is_global else PROJECT_DIR)


def install_tree(src, dst):
    os.makedirs(dst, exist_ok=True)
    ignore = shutil.ignore_patterns('node_modules', '__pycache__', '.browser-session.json')
    for name in core.scan_skills(src):
        target = os.path.join(dst, name)
        if os.path.isdir(target):
            shutil.rmtree(target)
        shutil.copytree(os.path.join(src, name), target, ignore=ignore)


def adjust_web_test_prefix(dst, is_global):
    prefix = GLOBAL_NODE_PREFIX if is_global else PROJECT_NODE_PREFIX
    path = os.path.join(dst, 'web-test')
    if not os.path.isdir(path):
        return
    for md in core.collect_md_files(path):
        content = core.read(md)
        new = content
        for current in (core.WEB_TEST_PREFIX, GLOBAL_NODE_PREFIX, PROJECT_NODE_PREFIX):
            new = new.replace(f'--prefix {current} ', f'--prefix {prefix} ')
        if new != content:
            core.write(md, new)


def copy_md_dir(kind, oc_dir):
    """Агенты и команды из .opencode/<kind>/ репозитория -> <opencode_dir>/<kind>/."""
    src = os.path.join(repo_root(), '.opencode', kind)
    dst = os.path.join(oc_dir, kind)
    os.makedirs(dst, exist_ok=True)
    copied = []
    for name in sorted(os.listdir(src)):
        if name.endswith('.md'):
            shutil.copy2(os.path.join(src, name), os.path.join(dst, name))
            copied.append(f'{kind}/{name}')
    return copied


PLUGIN_FILE = 'bsl-autocheck.js'
SHELL_GUARD_FILE = 'shell-guard.js'
# (файл в plugins/ репозитория, имя переходника, комментарий в установленном файле)
_PLUGIN_SHIMS = (
    ('bsl-autocheck.mjs', PLUGIN_FILE,
     'Создано scripts/opencode_port.py install — проверка BSL после каждой правки (1C-Agent).'),
    ('shell-guard.mjs', SHELL_GUARD_FILE,
     'Создано scripts/opencode_port.py install — запрет COM, интерактивного 1cv8, загрузки вне db-*, пароля в команде и чтения секретов (1C-Agent).'),
)


def install_plugin(oc_dir, *, autocheck=True):
    """Плагины OpenCode v2: переходники в <opencode>/plugins/ на код в репозитории.
    shell-guard ставится всегда, bsl-autocheck — если autocheck (его гасит --no-autocheck)."""
    dst_dir = os.path.join(oc_dir, 'plugins')
    os.makedirs(dst_dir, exist_ok=True)
    copied = []
    for src_name, dest_name, note in _PLUGIN_SHIMS:
        dest = os.path.join(dst_dir, dest_name)
        if dest_name == PLUGIN_FILE and not autocheck:
            if os.path.isfile(dest):
                os.remove(dest)
            continue
        src = pathlib.Path(repo_root(), 'plugins', src_name).resolve()
        core.write(dest,
                   f'// {note}\n'
                   '// Код плагина: ' + str(src) + '\n'
                   f'export {{ default }} from {json.dumps(src.as_uri())};\n')
        copied.append(f'plugins/{dest_name}')
    return copied


def register_mcp(remove=False, vrunner=False):
    script = os.path.join(repo_root(), 'mcp', 'register-opencode-mcp.mjs')
    node = shutil.which('node')
    if not node:
        if not remove:
            print('Node.js не найден — MCP-серверы не зарегистрированы. '
                  f'После установки Node.js выполните: node "{script}"')
        return
    cmd = [node, script] + (['--remove'] if remove else []) + (['--vrunner'] if vrunner else [])
    subprocess.run(cmd, check=False)


def cmd_build(args):
    return core.cmd_build(args)


def cmd_install(args):
    src = os.path.join(repo_root(), core.REPO_SKILLS)
    skills = core.scan_skills(src)
    if not skills:
        print(f'Ошибка: навыки не найдены в {src}. Сначала выполните build.', file=sys.stderr)
        return 1
    base = target_base(args)
    if not os.path.isdir(base):
        print(f"Ошибка: каталог '{base}' не найден.", file=sys.stderr)
        return 1
    oc = opencode_dir(base, args.is_global)
    dst = os.path.join(oc, 'skills')
    install_tree(src, dst)
    if args.runtime:
        core.apply_runtime(dst, args.runtime)
    adjust_web_test_prefix(dst, args.is_global)
    files = copy_md_dir('agents', oc) + copy_md_dir('commands', oc)
    files += install_plugin(oc, autocheck=not args.no_autocheck)
    core.write(os.path.join(oc, MARKER), '\n'.join(files) + '\n')
    if not args.is_global:
        agents_md = os.path.join(base, 'AGENTS.md')
        if not os.path.exists(agents_md):
            shutil.copy2(os.path.join(repo_root(), 'templates', 'AGENTS.md'), agents_md)
            print(f'Создан шаблон {agents_md} — поправьте под свой проект.')
    if not args.no_mcp:
        register_mcp(remove=False, vrunner=args.vrunner)
    print(f'Установлено: {len(skills)} навыков в {dst}, агентов и команд: {len(files)} в {oc}')
    if not args.is_global:
        core.print_gitignore_recommendations(base)
    print('\nЗапустите OpenCode (Desktop или CLI) из каталога проекта: агент «1c» выбран по умолчанию '
          '(если в конфиге задан свой default_agent — выберите «1c» вручную).')
    return 0


def cmd_uninstall(args):
    oc = opencode_dir(target_base(args), args.is_global)
    dst = os.path.join(oc, 'skills')
    names = set(core.scan_skills(os.path.join(repo_root(), core.REPO_SKILLS)))
    removed = 0
    for name in core.scan_skills(dst) if os.path.isdir(dst) else []:
        if name in names:
            shutil.rmtree(os.path.join(dst, name))
            removed += 1
    marker = os.path.join(oc, MARKER)
    if os.path.isfile(marker):
        for rel in core.read(marker).split():
            p = os.path.join(oc, rel)
            if os.path.isfile(p):
                os.remove(p)
        os.remove(marker)
    if not args.no_mcp:
        register_mcp(remove=True)
    print(f'Удалено навыков: {removed} из {dst}')
    return 0


def cmd_runtime(args):
    dst = os.path.join(opencode_dir(target_base(args), args.is_global), 'skills')
    if not os.path.isdir(dst) or not core.scan_skills(dst):
        print(f'Ошибка: навыки не найдены в {dst}', file=sys.stderr)
        return 1
    core.apply_runtime(dst, args.runtime)
    return 0


def main():
    parser = argparse.ArgumentParser(
        description='Агент 1С для OpenCode v2: сборка навыков и установка',
        epilog=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)

    def add_target(p):
        g = p.add_mutually_exclusive_group()
        g.add_argument('--project-dir', default=os.getcwd(), help='каталог 1С-проекта (по умолчанию текущий)')
        g.add_argument('--global', dest='is_global', action='store_true', help='установить в ~/.config/opencode/')

    p = sub.add_parser('build', help='пересобрать skills/ из upstream cc-1c-skills')
    p.add_argument('--upstream', help='путь к локальному клону cc-1c-skills (иначе git clone)')
    p.add_argument('--ref', help='ветка/тег upstream для git clone (по умолчанию main)')
    p.add_argument('--runtime', choices=['powershell', 'python'], default='powershell')
    p.set_defaults(func=cmd_build)

    p = sub.add_parser('install', help='установить навыки, агентов, команды и MCP')
    add_target(p)
    p.add_argument('--runtime', choices=['powershell', 'python'], help='сразу переключить рантайм навыков')
    p.add_argument('--no-mcp', action='store_true', help='не регистрировать MCP-серверы')
    p.add_argument('--vrunner', action='store_true', help='включить MCP-сервер vrunner-mcp (vanessa-runner 3.x)')
    p.add_argument('--no-autocheck', action='store_true', help='не ставить плагин bsl-autocheck (проверка BSL после правок)')
    p.set_defaults(func=cmd_install)

    p = sub.add_parser('runtime', help='переключить рантайм у установленных навыков')
    p.add_argument('runtime', choices=['powershell', 'python'])
    add_target(p)
    p.set_defaults(func=cmd_runtime)

    p = sub.add_parser('uninstall', help='удалить установленное')
    add_target(p)
    p.add_argument('--no-mcp', action='store_true', help='не трогать MCP-серверы')
    p.set_defaults(func=cmd_uninstall)

    args = parser.parse_args()
    return args.func(args)


if __name__ == '__main__':
    sys.exit(main())
