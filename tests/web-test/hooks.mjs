// Хук загрузчика для тестов: scripts/browser.mjs навыка web-test → fake-browser.mjs,
// пакет playwright (его импортирует engine/, который тянет test-runner) → пустая заглушка.
const fake = new URL('./fake-browser.mjs', import.meta.url).href;
const pw = 'data:text/javascript,export const chromium = {};';
export async function resolve(specifier, context, next) {
  if (specifier === 'playwright') return { url: pw, shortCircuit: true };
  if (/(^|\/)browser\.mjs$/.test(specifier) && context.parentURL && /\/web-test\/scripts\//.test(context.parentURL)) {
    return { url: fake, shortCircuit: true };
  }
  return next(specifier, context);
}
