// OpenCode: текст фреймов формы (HTML-документ, табличный документ, лента).
// page.evaluate их не читает: документ фрейма для скрипта страницы закрыт.
// Playwright открывает frame отдельно — отсюда берётся текст, который на скриншоте есть, а в getFormState не было.

export function collapseText(raw) {
  return String(raw || '')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function frameInForm(idChain, prefix) {
  if (!prefix) return true;
  return (idChain || []).some((id) => id && String(id).startsWith(prefix));
}

export async function readFrameTexts(page, { formNum = null, limit = 6, maxChars = 4000 } = {}) {
  const prefix = formNum == null ? '' : `form${formNum}_`;
  const handles = await page.$$('iframe');
  const frames = [];
  for (const handle of handles) {
    if (frames.length >= limit) break;
    let meta;
    try {
      meta = await handle.evaluate((f, pfx) => {
        if (f.offsetWidth < 2 || f.offsetHeight < 2) return null;
        const ids = [];
        let el = f;
        for (let d = 0; el && d < 30; d++, el = el.parentElement) if (el.id) ids.push(el.id);
        if (pfx && !ids.some((id) => id.startsWith(pfx))) return null;
        return { id: f.id || '', w: f.offsetWidth, h: f.offsetHeight };
      }, prefix);
    } catch { continue; }
    if (!meta) continue;
    const frame = await handle.contentFrame();
    if (!frame) {
      frames.push({ id: meta.id, width: meta.w, height: meta.h, blocked: true });
      continue;
    }
    try {
      const raw = await frame.evaluate(() => (document.body?.innerText || ''));
      const text = collapseText(raw);
      const entry = { id: meta.id, width: meta.w, height: meta.h, text: text.slice(0, maxChars) };
      if (text.length > maxChars) entry.truncated = true;
      frames.push(entry);
    } catch (e) {
      frames.push({ id: meta.id, width: meta.w, height: meta.h, blocked: true, error: String(e?.message || e).slice(0, 200) });
    }
  }
  return frames;
}

export async function readFrameText() {
  const { page, ensureConnected } = await import('../core/state.mjs');
  ensureConnected();
  const frames = await readFrameTexts(page);
  return { frames };
}
