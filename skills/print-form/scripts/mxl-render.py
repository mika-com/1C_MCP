#!/usr/bin/env python3
"""
mxl-render.py — предпросмотр макета табличного документа 1С (Template.xml) в HTML и PNG.

  python mxl-render.py <Template.xml> [-o out.html] [--png out.png] [--no-areas] [--scale 1.3]

HTML: сетка колонок с ширинами, высоты строк, объединения, рамки (стиль/толщина), шрифты,
выравнивания, перенос, цвета; параметры показаны как ‹Имя› (курсив), шаблоны — как есть.
Слева — полоса именованных областей (Rows), чтобы видеть Шапку/Строку/Подвал.
PNG: скриншот HTML через Playwright/Chromium (scripts/render-png.mjs, Node.js).

Единицы: ширина колонки — 1/8 символа (A4 книжная ≈ 540, альбомная ≈ 780), высота строки и
шрифт — пункты. Это приближение платформенного вида, а не точная копия печати.
"""
import argparse
import html
import os
import shutil
import subprocess
import sys

from lxml import etree

NS = {'s': 'http://v8.1c.ru/8.2/data/spreadsheet', 'v8': 'http://v8.1c.ru/8.1/data/core',
      'v8ui': 'http://v8.1c.ru/8.1/data/ui', 'xsi': 'http://www.w3.org/2001/XMLSchema-instance'}
S = '{%s}' % NS['s']
PX_PER_UNIT = 1.3      # 540 ед. (A4 книжная) ≈ 700 px
PT = 96 / 72
DEFAULT_COL_UNITS = 72
DEFAULT_ROW_PT = 12.75
AREA_COLORS = ['#e3f2fd', '#fce4ec', '#e8f5e9', '#fff3e0', '#f3e5f5', '#e0f7fa', '#f9fbe7', '#efebe9']


def txt(el, path, default=None):
    r = el.find(path, NS)
    return r.text if r is not None and r.text is not None else default


def ival(el, path, default=None):
    v = txt(el, path)
    try:
        return int(v) if v is not None else default
    except ValueError:
        return default


def local_text(el):
    """<tl>/<format> с v8:item → текст на ru (или первом языке)."""
    if el is None:
        return None
    items = el.findall('v8:item', NS)
    if not items:
        return ''
    for it in items:
        if txt(it, 'v8:lang') == 'ru':
            return txt(it, 'v8:content', '')
    return txt(items[0], 'v8:content', '')


class Doc:
    def __init__(self, path):
        self.root = etree.parse(path).getroot()
        r = self.root
        self.lines = []
        for ln in r.findall('s:line', NS):
            st = ln.find('v8ui:style', NS)
            self.lines.append((st.text if st is not None else 'Solid', int(ln.get('width', '1'))))
        self.fonts = []
        for f in r.findall('s:font', NS):
            self.fonts.append({'face': f.get('faceName'), 'size': f.get('height'), 'bold': f.get('bold') == 'true',
                               'italic': f.get('italic') == 'true', 'underline': f.get('underline') == 'true',
                               'strike': f.get('strikeout') == 'true', 'scale': f.get('scale', '100')})
        self.formats = [None] + r.findall('s:format', NS)   # 1-based
        dfi = ival(r, 's:defaultFormatIndex', 0)
        self.default_width = self.fmt_int(dfi, 'width') or DEFAULT_COL_UNITS
        # наборы колонок: None — основной
        self.colsets = {}
        for cs in r.findall('s:columns', NS):
            cid = txt(cs, 's:id')
            size = ival(cs, 's:size', 0)
            widths = {}
            for ci in cs.findall('s:columnsItem', NS):
                idx = ival(ci, 's:index', 0)
                fi = ival(ci, 's:column/s:formatIndex', 0)
                w = self.fmt_int(fi, 'width')
                widths[idx] = w
            self.colsets[cid] = (size, widths)
        if None not in self.colsets:
            self.colsets[None] = (0, {})
        # строки
        self.rows = {}
        for ri in r.findall('s:rowsItem', NS):
            a = ival(ri, 's:index', 0)
            b = ival(ri, 's:indexTo', a)
            row = ri.find('s:row', NS)
            for i in range(a, b + 1):
                self.rows[i] = row
        self.height = max(ival(r, 's:height', 0) or 0, (max(self.rows) + 1) if self.rows else 0)
        self.merges = []
        for m in r.findall('s:merge', NS):
            self.merges.append({'r': ival(m, 's:r', 0), 'c': ival(m, 's:c', 0), 'h': ival(m, 's:h', 0),
                                'w': ival(m, 's:w', 0), 'cs': txt(m, 's:columnsID')})
        self.areas = []
        for n in r.findall('s:namedItem', NS):
            ar = n.find('s:area', NS)
            if ar is None:
                continue
            self.areas.append({'name': txt(n, 's:name', ''), 'type': txt(ar, 's:type'),
                               'r1': ival(ar, 's:beginRow', -1), 'r2': ival(ar, 's:endRow', -1),
                               'c1': ival(ar, 's:beginColumn', -1), 'c2': ival(ar, 's:endColumn', -1)})

    def fmt(self, i):
        return self.formats[i] if i and 0 < i < len(self.formats) else None

    def fmt_int(self, i, tag):
        f = self.fmt(i)
        return ival(f, 's:' + tag) if f is not None else None

    # --- CSS ---
    def border_css(self, idx):
        if idx is None or idx >= len(self.lines) or idx < 0:
            return None
        style, width = self.lines[idx]
        w = max(width, 1)
        if style == 'None':
            return 'none'
        css = {'Solid': 'solid', 'Dotted': 'dotted', 'ThinDashed': 'dashed', 'LargeDashed': 'dashed',
               'ThickDashed': 'dashed', 'Double': 'double'}.get(style, 'solid')
        if css == 'double':
            w = max(w, 3)
        if style == 'ThickDashed':
            w = max(w, 2)
        return f'{w}px {css} #000'

    @staticmethod
    def color(v):
        if not v:
            return None
        if v.startswith('#'):
            return v
        if ':' in v:
            name = v.split(':', 1)[1]
            return None if v.startswith('style:') else name.lower()
        return None

    def cell_css(self, f):
        css = {}
        if f is None:
            return css
        fi = ival(f, 's:font')
        if fi is not None and 0 <= fi < len(self.fonts):
            ft = self.fonts[fi]
            if ft['face']:
                css['font-family'] = f"'{ft['face']}', Arial, sans-serif"
            if ft['size']:
                size = float(ft['size']) * float(ft['scale'] or 100) / 100
                css['font-size'] = f'{size * PT:.1f}px'
            if ft['bold']:
                css['font-weight'] = 'bold'
            if ft['italic']:
                css['font-style'] = 'italic'
            deco = [d for d, on in (('underline', ft['underline']), ('line-through', ft['strike'])) if on]
            if deco:
                css['text-decoration'] = ' '.join(deco)
        b = ival(f, 's:border')
        sides = {'left': ival(f, 's:leftBorder'), 'top': ival(f, 's:topBorder'),
                 'right': ival(f, 's:rightBorder'), 'bottom': ival(f, 's:bottomBorder')}
        if b is not None:
            sides = {k: b for k in sides}
        for side, idx in sides.items():
            bc = self.border_css(idx)
            if bc:
                css[f'border-{side}'] = bc
        bcol = self.color(txt(f, 's:borderColor'))
        if bcol:
            css['border-color'] = bcol
        ha = txt(f, 's:horizontalAlignment')
        if ha:
            css['text-align'] = {'Left': 'left', 'Center': 'center', 'Right': 'right', 'Justify': 'justify'}.get(ha, 'left')
        va = txt(f, 's:verticalAlignment')
        if va:
            css['vertical-align'] = {'Top': 'top', 'Center': 'middle', 'Bottom': 'bottom'}.get(va, 'bottom')
        tp = txt(f, 's:textPlacement')
        css['white-space'] = 'normal' if tp == 'Wrap' else 'nowrap'
        if tp == 'Cut':
            css['overflow'] = 'hidden'
        for tag, prop in (('backColor', 'background-color'), ('textColor', 'color')):
            c = self.color(txt(f, 's:' + tag))
            if c:
                css[prop] = c
        ind = ival(f, 's:indent')
        if ind:
            css['padding-left'] = f'{ind * 6}px'
        orient = ival(f, 's:textOrientation')
        if orient in (900, 2700, 90, 270):
            css['writing-mode'] = 'vertical-rl'
            if orient in (900, 90):
                css['transform'] = 'rotate(180deg)'
        return css

    def cell_content(self, c, f):
        param = txt(c, 's:parameter')
        text = local_text(c.find('s:tl', NS))
        fill = txt(f, 's:fillType') if f is not None else None
        if param or fill == 'Parameter':
            name = param or (text or '?')
            return f'<span class="p">‹{html.escape(name)}›</span>'
        if text:
            esc = html.escape(text).replace('\n', '<br>')
            if fill == 'Template':
                import re
                esc = re.sub(r'\[([^\]]+)\]', r'<span class="p">[\1]</span>', esc)
            return esc
        return ''

    # --- раскладка ---
    def col_widths(self, cs):
        size, widths = self.colsets.get(cs, self.colsets[None])
        return size, widths

    def render(self, show_areas=True, title=''):
        # ширина сетки: максимум из size, колонок с форматом, ячеек и объединений
        maxcol = {}
        for i, row in self.rows.items():
            cs = txt(row, 's:columnsID')
            col = -1
            for cg in row.findall('s:c', NS):
                col = ival(cg, 's:i', col + 1)
                maxcol[cs] = max(maxcol.get(cs, 0), col + 1)
        for m in self.merges:
            maxcol[m['cs']] = max(maxcol.get(m['cs'], 0), m['c'] + m['w'] + 1)

        def ncols(cs):
            size, widths = self.col_widths(cs)
            return max(size, maxcol.get(cs, 0), (max(widths) + 1) if widths else 0, 1)

        def width_px(cs, j):
            _, widths = self.col_widths(cs)
            w = widths.get(j)
            return round((w if w else self.default_width) * PX_PER_UNIT)

        # области-полосы по строкам
        row_areas = {}
        palette = {}
        for a in self.areas:
            if a['type'] == 'Rows' and a['r1'] >= 0:
                palette.setdefault(a['name'], AREA_COLORS[len(palette) % len(AREA_COLORS)])
                for i in range(a['r1'], a['r2'] + 1):
                    row_areas.setdefault(i, []).append(a['name'])

        # объединения: (cs, r, c) → (rowspan, colspan); закрытые ячейки
        span, covered = {}, set()
        for m in self.merges:
            rows = range(self.height) if m['r'] == -1 else [m['r']]
            for r0 in rows:
                h = 0 if m['r'] == -1 else m['h']
                span[(m['cs'], r0, m['c'])] = (h + 1, m['w'] + 1)
                for dr in range(h + 1):
                    for dc in range(m['w'] + 1):
                        if dr or dc:
                            covered.add((m['cs'], r0 + dr, m['c'] + dc))

        out = []
        # группируем подряд идущие строки с одним набором колонок в одну таблицу
        blocks, cur, cur_cs = [], [], object()
        for i in range(self.height):
            row = self.rows.get(i)
            cs = txt(row, 's:columnsID') if row is not None else None
            if cs != cur_cs and cur:
                blocks.append((cur_cs, cur))
                cur = []
            cur_cs = cs
            cur.append(i)
        if cur:
            blocks.append((cur_cs, cur))

        for cs, idxs in blocks:
            n = ncols(cs)
            cols = ''.join(f'<col style="width:{width_px(cs, j)}px">' for j in range(n))
            total = sum(width_px(cs, j) for j in range(n))
            gutter = '<col style="width:120px">' if show_areas else ''
            out.append(f'<table style="width:{total + (120 if show_areas else 0)}px">{gutter}{cols}')
            for i in idxs:
                row = self.rows.get(i)
                rf = self.fmt(ival(row, 's:formatIndex', 0)) if row is not None else None
                if rf is not None and txt(rf, 's:hidden') == 'true':
                    continue
                h = ival(rf, 's:height') if rf is not None else None
                hpx = round((h if h else DEFAULT_ROW_PT) * PT)
                cells = {}
                if row is not None:
                    col = -1
                    for cg in row.findall('s:c', NS):
                        col = ival(cg, 's:i', col + 1)
                        cc = cg.find('s:c', NS)
                        if cc is not None:
                            cells[col] = cc
                tds = []
                if show_areas:
                    names = row_areas.get(i, [])
                    bg = palette.get(names[0], '#fff') if names else '#fff'
                    label = html.escape(', '.join(names))
                    tds.append(f'<td class="area" style="background:{bg}">{label} <span class="rn">{i + 1}</span></td>')
                for j in range(n):
                    if (cs, i, j) in covered:
                        continue
                    cc = cells.get(j)
                    f = self.fmt(ival(cc, 's:f', 0)) if cc is not None else rf
                    css = self.cell_css(f)
                    attrs = ''
                    if (cs, i, j) in span:
                        rs, csp = span[(cs, i, j)]
                        if rs > 1:
                            attrs += f' rowspan="{rs}"'
                        if csp > 1:
                            attrs += f' colspan="{min(csp, n - j)}"'
                    content = self.cell_content(cc, f) if cc is not None else ''
                    # как в 1С: текст без переноса вылезает только в пустые соседние ячейки без рамок;
                    # параметры и ячейки в рамке обрезаются
                    if css.get('white-space') == 'nowrap' and (
                            'class="p"' in content or any(k.startswith('border-') for k in css)
                            or (j + 1 < n and cells.get(j + 1) is not None
                                and self.cell_content(cells[j + 1], self.fmt(ival(cells[j + 1], 's:f', 0))))):
                        css['overflow'] = 'hidden'
                        css['text-overflow'] = 'clip'
                    style = ';'.join(f'{k}:{v}' for k, v in css.items())
                    tds.append(f'<td{attrs} style="{style}">{content}</td>')
                out.append(f'<tr style="height:{hpx}px">{"".join(tds)}</tr>')
            out.append('</table>')

        legend = ''
        if show_areas and palette:
            legend = '<div class="legend">Области: ' + ' '.join(
                f'<span style="background:{c}">{html.escape(nm)}</span>' for nm, c in palette.items()) + '</div>'
        params = sorted({p.text for p in self.root.iter(S + 'parameter') if p.text})
        plist = f'<div class="legend">Параметры ({len(params)}): {html.escape(", ".join(params))}</div>' if params else ''
        return f'''<!DOCTYPE html><html><head><meta charset="utf-8"><title>{html.escape(title)}</title><style>
body{{font-family:Arial,sans-serif;font-size:13px;margin:16px;background:#fff;color:#000}}
table{{border-collapse:collapse;table-layout:fixed;margin:0}}
td{{padding:1px 3px;overflow:visible;vertical-align:bottom;font-size:13px;line-height:1.15;box-sizing:border-box}}
td.area{{font-size:10px;color:#555;border-right:2px solid #999;white-space:nowrap;overflow:hidden;vertical-align:middle}}
td.area .rn{{color:#aaa;float:right}}
.p{{color:#1565c0;font-style:italic}}
.legend{{font-size:11px;color:#444;margin:6px 0}} .legend span{{padding:1px 6px;margin-right:4px;border:1px solid #ccc}}
h1{{font-size:14px;color:#333;margin:0 0 8px}}
</style></head><body><h1>{html.escape(title)}</h1>{legend}{plist}<div id="sheet">{"".join(out)}</div></body></html>'''


def to_png(html_path, png_path):
    here = os.path.dirname(os.path.abspath(__file__))
    node = shutil.which('node')
    if not node:
        print('PNG пропущен: Node.js не найден', file=sys.stderr)
        return 2
    r = subprocess.run([node, os.path.join(here, 'render-png.mjs'), html_path, png_path])
    return r.returncode


def main():
    global PX_PER_UNIT
    ap = argparse.ArgumentParser(description='Предпросмотр макета MXL (Template.xml) в HTML/PNG')
    ap.add_argument('template')
    ap.add_argument('-o', '--output', help='HTML (по умолчанию рядом: <имя>.preview.html)')
    ap.add_argument('--png', help='сохранить PNG (нужны Node.js и Playwright с Chromium)')
    ap.add_argument('--no-areas', action='store_true', help='без полосы именованных областей')
    ap.add_argument('--scale', type=float, default=1.3, help='px на единицу ширины колонки (1.3)')
    a = ap.parse_args()

    PX_PER_UNIT = a.scale
    if not os.path.isfile(a.template):
        print(f'Файл не найден: {a.template}', file=sys.stderr)
        return 1
    doc = Doc(a.template)
    title = os.path.relpath(a.template)
    out = a.output or os.path.splitext(a.template)[0] + '.preview.html'
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, 'w', encoding='utf-8') as fh:
        fh.write(doc.render(show_areas=not a.no_areas, title=title))
    print(f'[OK] HTML: {out}  (строк {doc.height}, областей {len(doc.areas)}, объединений {len(doc.merges)})')
    if a.png:
        rc = to_png(os.path.abspath(out), os.path.abspath(a.png))
        if rc == 0:
            print(f'[OK] PNG: {a.png}')
        return rc
    return 0


if __name__ == '__main__':
    sys.exit(main())
