#!/usr/bin/env python3
# analyze_session.py v1.0 — разбор сеанса goose: на что ушли токены и где агент ходил по кругу
"""
Анализ сеанса goose для оптимизации работы с навыками 1С.

Источник — экспорт сеанса в JSON (goose Desktop: «История сеансов» → сеанс → экспорт;
CLI: `goose session export --session-id <ID> --format json -o session.json`)
или база сеансов goose напрямую (sessions.db).

Отчёт: расход токенов и стоимость по шагам, загруженные навыки, скрипты навыков, запущенные
без загрузки навыка, ошибки, повторяющиеся вызовы (хождение по кругу), самые тяжёлые ответы
инструментов, ручная правка XML вместо навыков и итоговые рекомендации.

Примеры:
  python analyze_session.py session.json
  python analyze_session.py --list                       # последние сеансы из sessions.db
  python analyze_session.py --db                         # последний сеанс из sessions.db
  python analyze_session.py --db --session 20261006_3 -o report.md
  python analyze_session.py session.json --transcript transcript.md   # сжатая расшифровка для разбора моделью
"""
import argparse
import json
import os
import re
import sqlite3
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone

RX_SKILL_SCRIPT = re.compile(r'[\\/]skills[\\/]([a-z][a-z0-9-]+)[\\/]scripts[\\/]([\w.-]+\.(?:ps1|py|mjs))')
RX_1C_SOURCE = re.compile(r'\.(xml|bsl|mxl)$', re.I)
EDIT_TOOLS = {'edit', 'write', 'text_editor'}


def default_db_path():
    if os.name == 'nt':
        return os.path.join(os.environ.get('APPDATA', ''), 'Block', 'goose', 'data', 'sessions', 'sessions.db')
    base = os.environ.get('XDG_DATA_HOME') or os.path.join(os.path.expanduser('~'), '.local', 'share')
    return os.path.join(base, 'goose', 'sessions', 'sessions.db')


# ---------------------------------------------------------------------------
# Загрузка
# ---------------------------------------------------------------------------
def load_export(path):
    with open(path, encoding='utf-8') as f:
        data = json.load(f)
    conv = data.get('conversation') or []
    if isinstance(conv, dict):
        conv = conv.get('messages', [])
    return data, conv


def db_connect(path):
    if not os.path.isfile(path):
        sys.exit(f'База сеансов не найдена: {path}\nУкажите путь: --db-path <путь к sessions.db>')
    return sqlite3.connect(f'file:{path}?mode=ro', uri=True)


def db_list(path, limit):
    con = db_connect(path)
    rows = con.execute(
        'SELECT id, name, working_dir, updated_at, accumulated_total_tokens, accumulated_cost '
        'FROM sessions ORDER BY updated_at DESC LIMIT ?', (limit,)).fetchall()
    print(f'{"ID":<14} {"Обновлён":<20} {"Токены":>10} {"Стоимость":>10}  Название / каталог')
    for sid, name, wd, upd, tok, cost in rows:
        print(f'{sid:<14} {str(upd)[:19]:<20} {tok or 0:>10} {cost or 0:>10.3f}  {name or "—"} | {wd}')


def load_db(path, session_id):
    con = db_connect(path)
    con.row_factory = sqlite3.Row
    if session_id:
        srow = con.execute('SELECT * FROM sessions WHERE id = ?', (session_id,)).fetchone()
    else:
        srow = con.execute("SELECT * FROM sessions WHERE session_type = 'user' "
                           'ORDER BY updated_at DESC LIMIT 1').fetchone()
    if srow is None:
        sys.exit(f'Сеанс не найден: {session_id or "(последний)"}')
    data = dict(srow)
    try:
        data['model_config'] = json.loads(data.get('model_config_json') or '{}')
    except ValueError:
        data['model_config'] = {}
    data['accumulated_usage'] = {
        'input_tokens': data.get('accumulated_input_tokens'),
        'output_tokens': data.get('accumulated_output_tokens'),
        'total_tokens': data.get('accumulated_total_tokens'),
        'cache_read_input_tokens': data.get('accumulated_cache_read_tokens'),
    }
    conv = []
    for r in con.execute('SELECT role, content_json, created_timestamp, metadata_json FROM messages '
                         'WHERE session_id = ? ORDER BY id', (data['id'],)):
        try:
            content = json.loads(r['content_json'])
        except (TypeError, ValueError):
            content = []
        try:
            meta = json.loads(r['metadata_json']) if r['metadata_json'] else {}
        except ValueError:
            meta = {}
        conv.append({'role': r['role'], 'created': r['created_timestamp'], 'content': content, 'metadata': meta})
    try:
        compactions = con.execute('SELECT COUNT(*) FROM usage_ledger WHERE session_id = ? AND is_compaction = 1',
                                  (data['id'],)).fetchone()[0]
    except sqlite3.Error:
        compactions = 0
    data['_compactions'] = compactions
    return data, conv


# ---------------------------------------------------------------------------
# Разбор
# ---------------------------------------------------------------------------
def result_text(tool_result):
    """Текст ответа инструмента и признак ошибки."""
    if not isinstance(tool_result, dict):
        return '', False
    if tool_result.get('status') == 'error':
        return str(tool_result.get('error', '')), True
    value = tool_result.get('value') or {}
    parts = []
    for c in value.get('content') or []:
        if isinstance(c, dict) and c.get('type') == 'text':
            parts.append(c.get('text', ''))
        elif isinstance(c, dict) and c.get('type') == 'resource':
            parts.append(str(c.get('resource', {}).get('text', '')))
    is_error = bool(value.get('isError'))
    sc = value.get('structuredContent')
    if isinstance(sc, dict) and isinstance(sc.get('exit_code'), int) and sc['exit_code'] != 0:
        is_error = True
    return '\n'.join(parts), is_error


def num(n):
    return f'{n or 0:,}'.replace(',', '\u202f')


def short(s, n):
    s = ' '.join(str(s).split())
    return s if len(s) <= n else s[:n - 1] + '…'


def analyze(data, conv):
    calls = {}          # id -> вызов
    order = []          # порядок вызовов
    steps = []          # шаги модели с расходом
    user_msgs = []
    assistant_texts = []
    notifications = []
    for idx, m in enumerate(conv):
        meta = m.get('metadata') or {}
        role = m.get('role')
        usage = meta.get('usage')
        step_tools = []
        for c in m.get('content') or []:
            t = c.get('type')
            if t == 'toolRequest':
                tc = c.get('toolCall') or {}
                if tc.get('status') == 'success':
                    name = tc['value'].get('name', '?')
                    args = tc['value'].get('arguments') or {}
                else:
                    name, args = '(ошибка вызова)', {'error': tc.get('error')}
                call = {'id': c.get('id'), 'name': name, 'args': args, 'msg': idx,
                        'ext': (c.get('_meta') or {}).get('goose_extension'), 'result': '', 'error': False,
                        'answered': False}
                calls[call['id']] = call
                order.append(call)
                step_tools.append(name)
            elif t == 'toolResponse':
                call = calls.get(c.get('id'))
                text, err = result_text(c.get('toolResult'))
                if call:
                    call.update(result=text, error=err, answered=True)
            elif t == 'text' and role == 'user' and meta.get('userVisible', True):
                user_msgs.append(c.get('text', ''))
            elif t == 'text' and role == 'assistant':
                assistant_texts.append(c.get('text', ''))
            elif t in ('systemNotification', 'error'):
                notifications.append(c.get('msg') or c.get('message') or c.get('text') or json.dumps(c)[:200])
        if role == 'assistant' and usage:
            steps.append({'n': len(steps) + 1, 'msg': idx, 'in': usage.get('inputTokens') or 0,
                          'out': usage.get('outputTokens') or 0, 'cost': usage.get('cost') or 0,
                          'cache': usage.get('cacheReadInputTokens') or usage.get('cacheReadTokens') or 0,
                          'tools': step_tools})
    return {'calls': order, 'steps': steps, 'user': user_msgs, 'assistant': assistant_texts,
            'notes': notifications}


def call_key(call):
    return call['name'] + ' ' + json.dumps(call['args'], ensure_ascii=False, sort_keys=True)


def call_brief(call, n=110):
    a = call['args']
    if call['name'] == 'shell':
        return short(a.get('command', ''), n)
    if call['name'] == 'load_skill':
        return a.get('name', '')
    if 'path' in a:
        return short(a['path'], n)
    return short(json.dumps(a, ensure_ascii=False), n)


# ---------------------------------------------------------------------------
# Отчёт
# ---------------------------------------------------------------------------
def fmt_ts(ts):
    try:
        return datetime.fromtimestamp(int(ts), tz=timezone.utc).strftime('%Y-%m-%d %H:%M UTC')
    except (TypeError, ValueError, OSError):
        return str(ts)


def report(data, conv, a, top):
    out = []
    w = out.append
    calls, steps = a['calls'], a['steps']
    acc = data.get('accumulated_usage') or {}
    total_in = acc.get('input_tokens') or sum(s['in'] for s in steps)
    total_out = acc.get('output_tokens') or sum(s['out'] for s in steps)
    cost = data.get('accumulated_cost')
    if cost is None:
        cost = sum(s['cost'] for s in steps)
    model = (data.get('model_config') or {}).get('model_name') if isinstance(data.get('model_config'), dict) else None
    times = [m.get('created') for m in conv if m.get('created')]
    duration = (max(times) - min(times)) / 60 if len(times) > 1 else 0

    w(f'# Разбор сеанса goose: {data.get("name") or data.get("id")}\n')
    w(f'- Сеанс: `{data.get("id")}`, каталог: `{data.get("working_dir")}`')
    w(f'- Модель: {data.get("provider_name") or "?"} / {model or "?"}, режим: {data.get("goose_mode") or "?"}')
    if times:
        w(f'- Начат: {fmt_ts(min(times))}, длительность: {duration:.0f} мин')
    w(f'- Запросов к модели: **{len(steps)}**, вызовов инструментов: **{len(calls)}**, '
      f'сообщений пользователя: {len(a["user"])}')
    w(f'- Токены: вход **{num(total_in)}**, выход {num(total_out)}'
      + (f', из кэша {num(acc.get("cache_read_input_tokens"))}' if acc.get('cache_read_input_tokens') else ''))
    w(f'- Стоимость: **{cost:.3f}** (оценка goose)' if cost else '- Стоимость: нет данных')
    if data.get('_compactions'):
        w(f'- Сжатий контекста: {data["_compactions"]}')
    w('')

    # Задача
    if a['user']:
        w('## Запросы пользователя\n')
        for i, u in enumerate(a['user'], 1):
            w(f'{i}. {short(u, 300)}')
        w('')

    # Навыки
    loaded = [c for c in calls if c['name'] == 'load_skill']
    skill_names = [c['args'].get('name', '') for c in loaded]
    main_loaded = {n.split('/')[0].split(':')[-1] for n in skill_names}
    script_runs = []
    for c in calls:
        if c['name'] == 'shell':
            for m in RX_SKILL_SCRIPT.finditer(c['args'].get('command', '')):
                script_runs.append((m.group(1), m.group(2), c))
    w('## Навыки\n')
    if skill_names:
        for n, cnt in Counter(skill_names).most_common():
            w(f'- загружен `{n}`' + (f' (загрузок: {cnt})' if cnt > 1 else ''))
    else:
        w('- **Ни один навык не загружался** (`load_skill` не вызывался).')
    unloaded = sorted({s for s, _, _ in script_runs if s not in main_loaded})
    if unloaded:
        w(f'- Скрипты навыков запускались **без загрузки навыка**: {", ".join(f"`{s}`" for s in unloaded)} — '
          'модель вызывала их «по памяти», не читая инструкцию.')
    if script_runs:
        cnt = Counter(f'{s}/{f}' for s, f, _ in script_runs)
        w('- Запуски скриптов навыков: ' + ', '.join(f'`{k}` ×{v}' for k, v in cnt.most_common()))
    w('')

    # Инструменты и ошибки
    w('## Инструменты\n')
    w('| Инструмент | Вызовов | С ошибкой |')
    w('|---|---:|---:|')
    by_tool = Counter(c['name'] for c in calls)
    err_tool = Counter(c['name'] for c in calls if c['error'])
    for name, cnt in by_tool.most_common():
        w(f'| {name} | {cnt} | {err_tool.get(name, 0)} |')
    w('')

    # Повторы
    dup = defaultdict(list)
    for i, c in enumerate(calls):
        dup[call_key(c)].append(i)
    repeats = [(k, v) for k, v in dup.items() if len(v) > 1]
    repeats.sort(key=lambda kv: -len(kv[1]))
    streak, best_streak, best_end = 0, 0, -1
    for i, c in enumerate(calls):
        streak = streak + 1 if c['error'] else 0
        if streak > best_streak:
            best_streak, best_end = streak, i
    w('## Хождение по кругу\n')
    if repeats:
        w('Одинаковые вызовы (тот же инструмент с теми же аргументами):\n')
        for k, idxs in repeats[:top]:
            c = calls[idxs[0]]
            errs = sum(1 for i in idxs if calls[i]['error'])
            w(f'- ×{len(idxs)} `{c["name"]}`: {call_brief(c)}' + (f' — все с ошибкой' if errs == len(idxs) else f' — с ошибкой: {errs}' if errs else ''))
    else:
        w('- Повторяющихся вызовов нет.')
    if best_streak >= 3:
        first = best_end - best_streak + 1
        w(f'- Самая длинная серия ошибок подряд: **{best_streak}** (вызовы {first + 1}–{best_end + 1}), '
          f'начиная с: {call_brief(calls[first])}')
    w('')

    # Расход по шагам
    if steps:
        w('## Расход токенов\n')
        first_in, last_in = steps[0]['in'], steps[-1]['in']
        w(f'Вход первого запроса: {num(first_in)}, последнего: {num(last_in)}'
          + (f' (рост ×{last_in / first_in:.1f})' if first_in else '')
          + '. Каждый запрос заново отправляет модели всю историю чата, поэтому длинные сеансы дорожают '
            'с каждым шагом.\n')
        w(f'Самые дорогие запросы (топ-{top}):\n')
        w('| Шаг | Вход | Выход | Стоимость | Что модель сделала |')
        w('|---:|---:|---:|---:|---|')
        for s in sorted(steps, key=lambda s: -(s['cost'] or s['in']))[:top]:
            w(f'| {s["n"]} | {s["in"]} | {s["out"]} | {s["cost"]:.4f} | {", ".join(s["tools"]) or "ответ текстом"} |')
        w('')

    # Тяжёлые ответы
    heavy = sorted((c for c in calls if c['result']), key=lambda c: -len(c['result']))[:top]
    if heavy:
        w('## Самые большие ответы инструментов\n')
        w('Они остаются в истории и оплачиваются в каждом следующем запросе.\n')
        for c in heavy:
            w(f'- {num(len(c["result"]))} симв. — `{c["name"]}`: {call_brief(c, 90)}')
        w('')

    # Ручная правка XML
    manual = [c for c in calls if c['name'].split('__')[-1] in EDIT_TOOLS
              and RX_1C_SOURCE.search(str(c['args'].get('path', '')))]
    xml_edits = [c for c in manual if str(c['args'].get('path', '')).lower().endswith('.xml')]

    # Ошибки
    errors = [c for c in calls if c['error']]
    if errors:
        w(f'## Ошибки (первые {top})\n')
        for c in errors[:top]:
            w(f'- `{c["name"]}`: {call_brief(c, 90)}\n  → {short(c["result"], 220)}')
        w('')

    # Рекомендации
    rec = []
    if not skill_names and (script_runs or manual):
        rec.append('Модель не загружала навыки. Напишите в задаче: «используй навык …», и проверьте, что '
                   '`.goosehints` лежит в папке проекта.')
    if unloaded:
        rec.append(f'Скрипты {", ".join(unloaded)} запускались без чтения навыка — отсюда ошибки в параметрах. '
                   'Попросите модель сначала загрузить навык.')
    if xml_edits:
        rec.append(f'XML выгрузки правился вручную (правок: {len(xml_edits)}, инструмент {", ".join(sorted({c["name"] for c in xml_edits}))}). '
                   'Для этого есть навыки *-edit / *-compile — они не ломают формат.')
    if repeats and len(repeats[0][1]) >= 3:
        rec.append('Модель повторяла одни и те же действия. Остановите её раньше, уточните задачу или '
                   'подскажите следующий шаг; при частых повторах возьмите более сильную модель.')
    if best_streak >= 3:
        rec.append('Длинная серия ошибок подряд: модель не меняла подход. Посмотрите текст первой ошибки — '
                   'часто это настройка окружения (база, платформа, ibcmd, GOOSE_SHELL), которую модель не может исправить сама.')
    if steps and steps[0]['in'] and steps[-1]['in'] / steps[0]['in'] > 8:
        rec.append('Контекст вырос многократно. Начинайте новый чат на каждую задачу и просите сохранять '
                   'большие выводы в файл (-OutFile), а не печатать их целиком.')
    if heavy and len(heavy[0]['result']) > 20000:
        rec.append('Есть очень большие ответы инструментов — используйте фильтры навыков *-info '
                   '(режимы overview/brief) вместо полного вывода.')
    if errors and len(errors) > len(calls) * 0.3:
        rec.append(f'Ошибкой закончились {len(errors)} из {len(calls)} вызовов. Проверьте настройки из '
                   'docs/quickstart.md (Git Bash, путь к платформе в .v8-project.json).')
    w('## Рекомендации\n')
    if rec:
        for r in rec:
            w(f'- {r}')
    else:
        w('- Явных проблем не найдено.')
    w('')
    return '\n'.join(out)


def transcript(data, conv, limit_result):
    """Сжатая расшифровка: пригодна, чтобы показать сеанс сильной модели и спросить, что пошло не так."""
    out = [f'# Расшифровка сеанса goose {data.get("id")} ({data.get("provider_name")}, '
           f'каталог {data.get("working_dir")})\n']
    calls = {}
    for m in conv:
        meta = m.get('metadata') or {}
        if not meta.get('agentVisible', True) and not meta.get('userVisible', True):
            continue
        for c in m.get('content') or []:
            t = c.get('type')
            if t == 'text' and m.get('role') == 'user' and meta.get('userVisible', True):
                out.append(f'\n**Пользователь:** {c.get("text", "").strip()}\n')
            elif t == 'text' and m.get('role') == 'assistant':
                out.append(f'\n**Модель:** {short(c.get("text", ""), 1500)}\n')
            elif t == 'toolRequest':
                tc = c.get('toolCall') or {}
                v = tc.get('value') or {}
                calls[c.get('id')] = v.get('name')
                out.append(f'- → `{v.get("name", "?")}` {short(json.dumps(v.get("arguments", {}), ensure_ascii=False), 400)}')
            elif t == 'toolResponse':
                text, err = result_text(c.get('toolResult'))
                mark = '✗' if err else '✓'
                out.append(f'  - {mark} {short(text, limit_result)}')
    return '\n'.join(out) + '\n'


def main():
    p = argparse.ArgumentParser(description='Разбор сеанса goose для оптимизации',
                                formatter_class=argparse.RawDescriptionHelpFormatter,
                                epilog='Примеры:' + __doc__.split('Примеры:', 1)[1])
    p.add_argument('export', nargs='?', help='JSON-экспорт сеанса goose')
    p.add_argument('--db', action='store_true', help='читать из базы сеансов goose (sessions.db)')
    p.add_argument('--db-path', default=default_db_path(), help='путь к sessions.db')
    p.add_argument('--session', help='ID сеанса в базе (по умолчанию последний)')
    p.add_argument('--list', action='store_true', help='показать последние сеансы из базы')
    p.add_argument('--top', type=int, default=10, help='сколько строк в списках (по умолчанию 10)')
    p.add_argument('-o', '--output', help='записать отчёт в файл (Markdown)')
    p.add_argument('--transcript', help='записать сжатую расшифровку сеанса в файл (Markdown)')
    p.add_argument('--result-chars', type=int, default=600, help='обрезка ответов инструментов в расшифровке')
    args = p.parse_args()

    if args.list:
        db_list(args.db_path, args.top * 2)
        return 0
    if args.export:
        data, conv = load_export(args.export)
    elif args.db or args.session:
        data, conv = load_db(args.db_path, args.session)
    else:
        p.error('укажите JSON-экспорт сеанса или --db')

    text = report(data, conv, analyze(data, conv), args.top)
    if args.output:
        with open(args.output, 'w', encoding='utf-8') as f:
            f.write(text)
        print(f'Отчёт: {args.output}')
    else:
        sys.stdout.reconfigure(encoding='utf-8')
        print(text)
    if args.transcript:
        with open(args.transcript, 'w', encoding='utf-8') as f:
            f.write(transcript(data, conv, args.result_chars))
        print(f'Расшифровка: {args.transcript}')
    return 0


if __name__ == '__main__':
    sys.exit(main() or 0)
