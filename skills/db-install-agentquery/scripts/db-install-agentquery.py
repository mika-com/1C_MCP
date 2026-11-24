#!/usr/bin/env python3
# db-install-agentquery — загрузить расширение AgentQuery в информационную базу.
# Исходники расширения лежат рядом: ../extension. Перед /LoadConfigFromFiles язык
# привязывается к выгрузке базы (configSrc или -ConfigPath), формат XML подгоняется
# под version базовой Configuration.xml. Пароль в эту команду не передают:
# db-load-xml получает -Database и читает учётные данные сам.
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

EXTENSION_NAME = 'AgentQuery'
ZERO_UUID = '00000000-0000-0000-0000-000000000000'
FORMAT_221 = 221


def script_dir():
    return os.path.dirname(os.path.abspath(__file__))


def extension_source():
    return os.path.normpath(os.path.join(script_dir(), '..', 'extension'))


def sibling_load_script():
    return os.path.normpath(os.path.join(script_dir(), '..', '..', 'db-load-xml', 'scripts', 'db-load-xml.py'))


def format_rank(ver):
    m = re.match(r'^(\d+)\.(\d+)$', ver or '')
    return int(m.group(1)) * 100 + int(m.group(2)) if m else 0


def read_text(path):
    with open(path, encoding='utf-8-sig') as f:
        return f.read()


def write_1c_xml(path, text):
    """Выгрузка Конфигуратора: UTF-8 BOM и CRLF, без перевода в конце."""
    body = text.replace('\r\n', '\n').replace('\n', '\r\n').rstrip('\r\n')
    with open(path, 'wb') as f:
        f.write(b'\xef\xbb\xbf')
        f.write(body.encode('utf-8'))


def find_v8project(start):
    d = os.path.abspath(start or os.getcwd())
    for _ in range(20):
        pj = os.path.join(d, '.v8-project.json')
        if os.path.isfile(pj):
            return pj
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    return None


def load_project(start):
    pj = find_v8project(start)
    if not pj:
        return None, None
    try:
        return pj, json.loads(read_text(pj))
    except Exception as e:
        print(f'Error: не читается {pj}: {e}', file=sys.stderr)
        return pj, None


def database_by_id(proj, database):
    wanted = (database or '').strip().lower()
    if not wanted or not proj:
        return None
    for db in proj.get('databases') or []:
        if str(db.get('id') or '').strip().lower() == wanted:
            return db
        for alias in db.get('aliases') or []:
            if str(alias).strip().lower() == wanted:
                return db
    return None


def resolve_config_dir(explicit, proj, db):
    raw = (explicit or '').strip().strip('"').strip("'")
    if not raw and db:
        raw = str(db.get('configSrc') or '').strip()
    if not raw:
        return None
    if not os.path.isabs(raw):
        root = os.getcwd()
        pj = find_v8project(os.getcwd())
        if pj:
            root = os.path.dirname(pj)
        raw = os.path.normpath(os.path.join(root, raw))
    cfg = os.path.join(raw, 'Configuration.xml')
    if not os.path.isfile(cfg):
        return None
    return raw


def base_facts(config_dir):
    text = read_text(os.path.join(config_dir, 'Configuration.xml'))
    ver = re.search(r'<MetaDataObject\b[^>]*\bversion="([^"]+)"', text)
    names = re.findall(r'<Language>([^<]+)</Language>', text)
    lang_name = names[0].strip() if names else None
    lang_uuid = None
    lang_code = None
    if lang_name:
        lang_file = os.path.join(config_dir, 'Languages', lang_name + '.xml')
        if os.path.isfile(lang_file):
            lt = read_text(lang_file)
            m = re.search(r'<Language\b[^>]*\buuid="([^"]+)"', lt)
            if m:
                lang_uuid = m.group(1)
            c = re.search(r'<LanguageCode>([^<]*)</LanguageCode>', lt)
            if c and c.group(1).strip():
                lang_code = c.group(1).strip()
    return {
        'version': ver.group(1) if ver else None,
        'language': lang_name,
        'language_uuid': lang_uuid,
        'language_code': lang_code,
    }


def _rename_language(text, old, new, code):
    text = text.replace(f'<Language>{old}</Language>', f'<Language>{new}</Language>')
    text = text.replace(f'<DefaultLanguage>Language.{old}</DefaultLanguage>', f'<DefaultLanguage>Language.{new}</DefaultLanguage>')
    text = text.replace(f'<Name>{old}</Name>', f'<Name>{new}</Name>')
    if code:
        text = re.sub(r'<LanguageCode>[^<]*</LanguageCode>', f'<LanguageCode>{code}</LanguageCode>', text, count=1)
    return text


def _bump_format(text, version, configuration):
    if not version:
        return text
    text = re.sub(r'(<MetaDataObject\b[^>]*\bversion=")[^"]+"', rf'\g<1>{version}"', text, count=1)
    text = re.sub(r'(<Rights\b[^>]*\bversion=")[^"]+"', rf'\g<1>{version}"', text, count=1)
    if configuration and format_rank(version) >= FORMAT_221:
        if 'xmlns:pal=' not in text:
            text = text.replace(
                ' xmlns:style=',
                ' xmlns:pal="http://v8.1c.ru/8.1/data/ui/colors/palette" xmlns:style=',
                1)
        if '<Caption/>' not in text and '<Caption>' not in text and '<DefaultLanguage>' in text:
            text = text.replace(
                '<DefaultLanguage>',
                '<Caption/>\r\n\t\t\t<ShortCaption/>\r\n\t\t\t<DefaultLanguage>',
                1)
    return text


def prepare_extension(dest, base_config_dir=None):
    """Копия шаблона в dest. Если есть выгрузка базы — uuid языка и version формата.

    Возвращает dict notes (список строк) и patched (bool: язык привязан).
    """
    src = extension_source()
    if not os.path.isfile(os.path.join(src, 'Configuration.xml')):
        raise FileNotFoundError(f'нет шаблона расширения: {src}')
    if os.path.isdir(dest):
        shutil.rmtree(dest)
    shutil.copytree(src, dest)
    notes = []
    patched = False
    facts = None
    if base_config_dir:
        facts = base_facts(base_config_dir)
        notes.append(
            f'база: формат {facts["version"] or "?"}, язык {facts["language"] or "?"}'
        )
    old_name = 'Русский'
    new_name = (facts or {}).get('language') or old_name
    lang_uuid = (facts or {}).get('language_uuid')
    if new_name != old_name:
        old_file = os.path.join(dest, 'Languages', old_name + '.xml')
        new_file = os.path.join(dest, 'Languages', new_name + '.xml')
        if os.path.isfile(old_file):
            os.replace(old_file, new_file)
        notes.append(f'язык шаблона «{old_name}» заменён на «{new_name}»')
    for dirpath, _dirs, files in os.walk(dest):
        for name in files:
            path = os.path.join(dirpath, name)
            if not name.endswith('.xml'):
                if name.endswith('.bsl'):
                    body = read_text(path).replace('\r\n', '\n').replace('\n', '\r\n').rstrip('\r\n')
                    with open(path, 'wb') as f:
                        f.write(b'\xef\xbb\xbf')
                        f.write(body.encode('utf-8'))
                continue
            text = read_text(path)
            if new_name != old_name:
                text = _rename_language(text, old_name, new_name, (facts or {}).get('language_code'))
            if lang_uuid and ZERO_UUID in text:
                text = text.replace(ZERO_UUID, lang_uuid)
                patched = True
            text = _bump_format(text, (facts or {}).get('version'), name == 'Configuration.xml')
            write_1c_xml(path, text)
    if base_config_dir and not patched:
        notes.append(
            'язык расширения не привязан: в выгрузке базы нет Languages/<имя>.xml с uuid. '
            'Загрузка может не пройти, пока -ConfigPath не укажет на полную выгрузку.'
        )
    elif not base_config_dir:
        notes.append(
            'configSrc и -ConfigPath не заданы: uuid языка остался нулевым. '
            'Для загрузки укажите выгрузку базы, иначе платформа не найдёт заимствованный язык.'
        )
    if facts and facts.get('version') and format_rank(facts['version']) >= FORMAT_221:
        notes.append(
            f'формат базы {facts["version"]} новее шаблона 2.17: version подменён, '
            'для 2.21 добавлены xmlns:pal и пустые Caption/ShortCaption. '
            'На живой платформе этот шаг не проверялся.'
        )
    return {'dest': dest, 'patched': patched, 'notes': notes, 'facts': facts}


def _ci_parse(parser, argv):
    argv = list(sys.argv[1:] if argv is None else argv)
    names = {s.lower(): s for a in parser._actions for s in a.option_strings}
    for i, tok in enumerate(argv):
        if tok.startswith('-') and tok.lower() in names:
            argv[i] = names[tok.lower()]
    return parser.parse_args(argv)


def build_load_command(args, config_dir):
    script = sibling_load_script()
    cmd = [sys.executable, script, '-ConfigDir', config_dir, '-Extension', EXTENSION_NAME, '-Mode', 'Full']
    if not args.PrepareOnly and not args.NoUpdate:
        cmd.append('-UpdateDB')
    if args.Database:
        cmd += ['-Database', args.Database]
    else:
        if args.InfoBasePath:
            cmd += ['-InfoBasePath', args.InfoBasePath]
        if args.InfoBaseServer:
            cmd += ['-InfoBaseServer', args.InfoBaseServer]
        if args.InfoBaseRef:
            cmd += ['-InfoBaseRef', args.InfoBaseRef]
    if args.V8Path:
        cmd += ['-V8Path', args.V8Path]
    return cmd


def main(argv=None):
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(
        description='Загрузить расширение AgentQuery (query_db) в информационную базу',
        allow_abbrev=False)
    parser.add_argument('-Database', default='', help='id базы в .v8-project.json')
    parser.add_argument('-InfoBasePath', default='')
    parser.add_argument('-InfoBaseServer', default='')
    parser.add_argument('-InfoBaseRef', default='')
    parser.add_argument('-ConfigPath', default='', help='каталог выгрузки конфигурации базы (язык и формат)')
    parser.add_argument('-V8Path', default='')
    parser.add_argument('-OutputDir', default='', help='куда положить подготовленные исходники')
    parser.add_argument('-NoUpdate', action='store_true', help='не передавать -UpdateDB')
    parser.add_argument('-PrepareOnly', action='store_true', help='только подготовить каталог, платформу не запускать')
    args = _ci_parse(parser, argv)

    pj, proj = load_project(os.getcwd())
    db = database_by_id(proj, args.Database) if args.Database else None
    if args.Database and proj is not None and db is None:
        ids = [str(d.get('id')) for d in (proj.get('databases') or []) if d.get('id')]
        print(f'Error: база с id «{args.Database}» не найдена в .v8-project.json'
              + (f'. Доступны: {", ".join(ids)}' if ids else ''), file=sys.stderr)
        return 1
    if args.Database and proj is None:
        print('Error: для -Database нужен .v8-project.json в каталоге проекта или выше.', file=sys.stderr)
        return 1

    config_dir = resolve_config_dir(args.ConfigPath, proj, db)
    if args.OutputDir:
        dest = args.OutputDir if os.path.isabs(args.OutputDir) else os.path.abspath(args.OutputDir)
    else:
        dest = tempfile.mkdtemp(prefix='agentquery-')
    try:
        info = prepare_extension(dest, config_dir)
    except Exception as e:
        print(f'Error: не подготовлено расширение: {e}', file=sys.stderr)
        return 1
    print(f'Prepared: {info["dest"]}')
    for note in info['notes']:
        print(f'Note: {note}')
    if not info['patched']:
        print('Note: загрузка без uuid языка базовой конфигурации, скорее всего, будет отвергнута платформой.')
    if args.PrepareOnly:
        print('PrepareOnly: платформа не запускалась.')
        return 0 if info['patched'] or not config_dir else 2

    if not args.Database and not args.InfoBasePath and not (args.InfoBaseServer and args.InfoBaseRef):
        print('Error: укажите -Database <id> или параметры соединения. Пароль передавать не нужно.', file=sys.stderr)
        return 1
    script = sibling_load_script()
    if not os.path.isfile(script):
        print(f'Error: не найден {script}. Загрузите каталог Prepared навыком db-load-xml '
              f'-Extension {EXTENSION_NAME} -UpdateDB.', file=sys.stderr)
        return 1
    cmd = build_load_command(args, info['dest'])
    print('Running: db-load-xml ' + ' '.join(cmd[2:]))
    print('Пароль в эту команду не входит: его читает db-load-xml из .v8-project.json.')
    proc = subprocess.run(cmd)
    code = proc.returncode if proc.returncode is not None else 1
    if code == 0:
        ident = args.Database or args.InfoBasePath or (args.InfoBaseServer + '/' + args.InfoBaseRef)
        print(f'[OK] Расширение {EXTENSION_NAME} загружено в «{ident}».')
        print('Безопасный режим для этого расширения снимать не нужно: модуль только выполняет ВЫБРАТЬ.')
        print(f'Дальше опубликуйте базу навыком web-publish (HTTP-сервисы расширений уже в default.vrd).')
        print(f'Проверка: query_db {{"database": "{args.Database or "<id>"}", "action": "status"}}.')
    return code


if __name__ == '__main__':
    sys.exit(main())
