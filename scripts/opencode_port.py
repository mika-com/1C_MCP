#!/usr/bin/env python3
"""
Сборка и установка навыков 1С для OpenCode.

Команды:
  build     — пересобрать skills/ из upstream cc-1c-skills
  install   — установить навыки в проект (.agents/skills/) или глобально (~/.config/opencode/skills/)
  runtime   — жёстко переключить рантайм у установленных навыков
  uninstall — удалить навыки, установленные командой install

Примеры:
  python scripts/opencode_port.py install --project-dir /path/to/my-1c-project
  python scripts/opencode_port.py install --project-dir . --runtime python
  python scripts/opencode_port.py install --global
  python scripts/opencode_port.py runtime python --project-dir /path/to/my-1c-project
  python scripts/opencode_port.py build --upstream ../cc-1c-skills
"""

import argparse
import os
import shutil
import subprocess
import sys

import goose_port as legacy

GLOBAL_SKILLS = os.path.join('.config', 'opencode', 'skills')
PROJECT_SKILLS = os.path.join('.agents', 'skills')
GLOBAL_NODE_PREFIX = '"$HOME/.config/opencode"'
PROJECT_NODE_PREFIX = f'"{legacy.SKILL_DIR}/../.."'


def repo_root():
    return legacy.repo_root()


def scan_installed(skills_dir):
    return legacy.scan_skills(skills_dir)


def target_base(args):
    return os.path.expanduser('~') if args.is_global else os.path.abspath(args.project_dir)


def skills_dir(base, is_global):
    rel = GLOBAL_SKILLS if is_global else PROJECT_SKILLS
    return os.path.join(base, rel)


def install_tree(src, dst):
    os.makedirs(dst, exist_ok=True)
    ignore = shutil.ignore_patterns('node_modules', '__pycache__', '.browser-session.json')
    for name in legacy.scan_skills(src):
        target = os.path.join(dst, name)
        if os.path.isdir(target):
            shutil.rmtree(target)
        shutil.copytree(os.path.join(src, name), target, ignore=ignore)


def adjust_web_test_prefix(dst, is_global):
    prefix = GLOBAL_NODE_PREFIX if is_global else PROJECT_NODE_PREFIX
    path = os.path.join(dst, 'web-test')
    if not os.path.isdir(path):
        return
    for md in legacy.collect_md_files(path):
        content = legacy.read(md)
        new = content
        for current in (legacy.WEB_TEST_PREFIX, GLOBAL_NODE_PREFIX, PROJECT_NODE_PREFIX):
            new = new.replace(f'--prefix {current} ', f'--prefix {prefix} ')
        if new != content:
            legacy.write(md, new)


def register_mcp(remove=False):
    script = os.path.join(repo_root(), 'mcp', 'register-opencode-mcp.mjs')
    node = shutil.which('node')
    if not node or not os.path.isfile(script):
        if not remove:
            print('Node.js не найден — MCP-серверы 1c-ask/1c-search/1c-bsl не зарегистрированы. '
                  f'После установки Node.js выполните: node "{script}"')
        return
    subprocess.run([node, script] + (['--remove'] if remove else []), check=False)


def print_next_steps(base, is_global):
    if is_global:
        print('\nOpenCode увидит навыки после перезапуска из глобального каталога ~/.config/opencode/skills/.')
    else:
        print('\nЗапустите OpenCode из каталога проекта — навыки будут доступны из .agents/skills/.')
    print('MCP-серверы 1c-ask/1c-search/1c-bsl можно использовать через opencode.json.')


def cmd_build(args):
    return legacy.cmd_build(args)


def cmd_install(args):
    src = os.path.join(repo_root(), legacy.REPO_SKILLS)
    skills = legacy.scan_skills(src)
    if not skills:
        print(f'Ошибка: навыки не найдены в {src}. Сначала выполните build.', file=sys.stderr)
        return 1
    base = target_base(args)
    if not os.path.isdir(base):
        print(f"Ошибка: каталог '{base}' не найден.", file=sys.stderr)
        return 1
    dst = skills_dir(base, args.is_global)
    install_tree(src, dst)
    if args.runtime:
        legacy.apply_runtime(dst, args.runtime)
    adjust_web_test_prefix(dst, args.is_global)
    if not args.no_mcp:
        register_mcp(remove=False)
    print(f'Установлено {len(skills)} навыков в {dst}')
    if not args.is_global:
        legacy.print_gitignore_recommendations(base)
    print_next_steps(base, args.is_global)
    return 0


def cmd_uninstall(args):
    dst = skills_dir(target_base(args), args.is_global)
    src_names = set(legacy.scan_skills(os.path.join(repo_root(), legacy.REPO_SKILLS)))
    removed = 0
    for name in scan_installed(dst):
        if name in src_names:
            shutil.rmtree(os.path.join(dst, name))
            removed += 1
    if not args.no_mcp:
        register_mcp(remove=True)
    print(f'Удалено навыков: {removed} из {dst}')
    return 0


def cmd_runtime(args):
    dst = skills_dir(target_base(args), args.is_global)
    if not scan_installed(dst):
        print(f'Ошибка: навыки не найдены в {dst}', file=sys.stderr)
        return 1
    legacy.apply_runtime(dst, args.runtime)
    return 0


def main():
    parser = argparse.ArgumentParser(
        description='Навыки 1С для OpenCode: сборка из upstream и установка навыков',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='Примеры:' + __doc__.split('Примеры:', 1)[1],
    )
    sub = parser.add_subparsers(dest='cmd', required=True)

    def add_target(p):
        g = p.add_mutually_exclusive_group()
        g.add_argument('--project-dir', default=os.getcwd(),
                       help='целевой проект (по умолчанию: текущий каталог)')
        g.add_argument('--global', dest='is_global', action='store_true',
                       help='глобальная установка в ~/.config/opencode/skills/')

    p = sub.add_parser('build', help='пересобрать skills/ из upstream cc-1c-skills')
    p.add_argument('--upstream', help='путь к локальному клону cc-1c-skills (иначе git clone)')
    p.add_argument('--ref', help='ветка/тег upstream для git clone (по умолчанию main)')
    p.add_argument('--runtime', choices=['powershell', 'python'], default='powershell')
    p.set_defaults(func=cmd_build)

    p = sub.add_parser('install', help='установить навыки в проект или глобально для OpenCode')
    add_target(p)
    p.add_argument('--runtime', choices=['powershell', 'python'],
                   help='жёстко прописать рантайм (по умолчанию PowerShell с откатом на Python)')
    p.add_argument('--no-mcp', action='store_true',
                   help='не обновлять opencode.json для 1c-ask/1c-search/1c-bsl')
    p.set_defaults(func=cmd_install)

    p = sub.add_parser('runtime', help='переключить рантайм у навыков, установленных install')
    p.add_argument('runtime', choices=['powershell', 'python'])
    add_target(p)
    p.set_defaults(func=cmd_runtime)

    p = sub.add_parser('uninstall', help='удалить навыки, установленные install')
    add_target(p)
    p.add_argument('--no-mcp', action='store_true',
                   help='не удалять записи 1c-ask/1c-search/1c-bsl из opencode.json')
    p.set_defaults(func=cmd_uninstall)

    args = parser.parse_args()
    if not hasattr(args, 'is_global'):
        args.is_global = False
    return args.func(args)


if __name__ == '__main__':
    sys.exit(main() or 0)
