#!/usr/bin/env python3
"""
Сборка и установка агента 1С для OpenCode v2.

Команды:
  build     — пересобрать skills/ из upstream cc-1c-skills (+ свои навыки из own-skills/)
  install   — установить навыки, агентов и команды в проект (.opencode/) или глобально (~/.config/opencode/)
              и зарегистрировать MCP-серверы и LSP bsl (~/.config/opencode/opencode.json)
  runtime   — переключить рантайм (powershell/python) у установленных навыков
  uninstall — удалить установленное командой install

Примеры:
  python scripts/opencode_port.py install --project-dir /path/to/my-1c-project
  python scripts/opencode_port.py install --project-dir . --runtime python
  python scripts/opencode_port.py install --global
  python scripts/opencode_port.py build --upstream ../cc-1c-skills
"""

import argparse
import os
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


def register_mcp(remove=False, vrunner=False, lsp=True):
    script = os.path.join(repo_root(), 'mcp', 'register-opencode-mcp.mjs')
    node = shutil.which('node')
    if not node:
        if not remove:
            print('Node.js не найден — MCP-серверы не зарегистрированы. '
                  f'После установки Node.js выполните: node "{script}"')
        return
    cmd = ([node, script] + (['--remove'] if remove else []) + (['--vrunner'] if vrunner else [])
           + ([] if lsp else ['--no-lsp']))
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
    core.write(os.path.join(oc, MARKER), '\n'.join(files) + '\n')
    if not args.is_global:
        agents_md = os.path.join(base, 'AGENTS.md')
        if not os.path.exists(agents_md):
            shutil.copy2(os.path.join(repo_root(), 'templates', 'AGENTS.md'), agents_md)
            print(f'Создан шаблон {agents_md} — поправьте под свой проект.')
    if not args.no_mcp:
        register_mcp(remove=False, vrunner=args.vrunner, lsp=not args.no_lsp)
    print(f'Установлено: {len(skills)} навыков в {dst}, агентов и команд: {len(files)} в {oc}')
    if not args.is_global:
        core.print_gitignore_recommendations(base)
    print('\nЗапустите OpenCode (Desktop или CLI) из каталога проекта и выберите агента «1c».')
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
    p.add_argument('--no-lsp', action='store_true', help='не записывать LSP bsl (BSL LS) в конфиг OpenCode')
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
