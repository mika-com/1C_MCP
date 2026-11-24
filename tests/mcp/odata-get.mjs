#!/usr/bin/env node
// Тесты odata_get: только GET, лимит, пароль не в URL и не в ответе, статус публикации.
//   node tests/mcp/odata-get.mjs
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildODataUrl, clampTop, odataGet, serviceRoot } from '../../mcp/lib/odata-get.mjs';

const here = dirname(fileURLToPath(import.meta.url));
let passed = 0; let failed = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? `\n       ${String(extra).split('\n').join('\n       ')}` : ''}`); }
};

const PASSWORD = 'S3cret-Long-Password';
const root = mkdtempSync(join(tmpdir(), 'odata-get-'));
function project(extra = {}) {
  writeFileSync(join(root, '.v8-project.json'), JSON.stringify({
    databases: [{
      id: 'dev', user: 'Администратор', password: PASSWORD,
      webUrl: 'http://127.0.0.1:9/dev', ...extra,
    }],
  }));
}

console.log('адрес и параметры:');
{
  ok(clampTop(undefined) === 100 && clampTop(0) === 1 && clampTop(9999) === 500, '$top зажат в 1…500');
  const db = { id: 'dev', webUrl: 'http://user:secret@127.0.0.1/dev/' };
  const rootUrl = serviceRoot(db);
  ok(rootUrl.url === 'http://127.0.0.1/dev/odata/standard.odata', 'userinfo вырезается, хвост standard.odata', rootUrl.url);
  const built = buildODataUrl(rootUrl.url, { entity: 'Catalog_Номенклатура', filter: 'IsFolder eq false', select: 'Description,Code', top: 20, orderby: 'Description asc' });
  ok(built.url.startsWith('http://127.0.0.1/dev/odata/standard.odata/Catalog_') && built.url.includes('$top=20') && built.url.includes('$filter=') && !built.url.includes('secret'), 'GET-адрес собирается из полей', built.url);
  ok(buildODataUrl(rootUrl.url, { entity: '../etc/passwd' }).error, 'путь с .. отвергается');
  ok(buildODataUrl(rootUrl.url, { entity: '$batch' }).error, '$batch отвергается');
  ok(!buildODataUrl(rootUrl.url, { entity: '$metadata' }).error, '$metadata разрешён');
  ok(buildODataUrl(rootUrl.url, { action: 'status' }).url.includes('$format=json') && !buildODataUrl(rootUrl.url, { action: 'status' }).url.includes('/$metadata'), 'status бьёт в корень сервиса');
}

console.log('исполнение:');
{
  project();
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    if (String(url).includes(PASSWORD)) throw new Error('password in url');
    if (init.method !== 'GET') throw new Error('not get');
    if (String(url).includes('$metadata')) {
      return { ok: true, status: 200, async text() { return '<edmx:Edmx></edmx:Edmx>'; } };
    }
    return {
      ok: true, status: 200,
      async text() {
        return JSON.stringify({ value: [{ Description: PASSWORD, Code: 'A-1' }, { Description: 'B', Code: 'A-2' }] });
      },
    };
  };
  const text = await odataGet(root, { database: 'dev', entity: 'Catalog_Номенклатура', top: 1 }, { fetchImpl });
  ok(seen.length === 1 && seen[0].init.method === 'GET', 'один GET');
  ok(seen[0].url.includes('$top=1') && !seen[0].url.includes(PASSWORD), '$top ужат и пароля в URL нет', seen[0].url);
  ok(seen[0].init.headers.Authorization.startsWith('Basic ') && !text.includes(PASSWORD) && text.includes('A-1'), 'пароль в заголовке и вырезан из ячеек', text);
  const meta = await odataGet(root, { database: 'dev', entity: '$metadata' }, { fetchImpl });
  ok(/\$metadata/.test(meta) && meta.includes('edmx'), '$metadata возвращается текстом', meta);
  const missing = await odataGet(root, { database: 'dev', action: 'status' }, {
    fetchImpl: async () => ({ ok: false, status: 404, async text() { return 'no'; } }),
  });
  ok(/404/.test(missing) && /OData/.test(missing) && !missing.includes(PASSWORD), '404 объясняет, что OData не опубликован', missing);
  const noUrl = await odataGet(root, { database: 'empty', entity: 'Catalog_X' }, { fetchImpl });
  writeFileSync(join(root, '.v8-project.json'), JSON.stringify({ databases: [{ id: 'empty', user: 'a', password: PASSWORD }] }));
  const noUrl2 = await odataGet(root, { database: 'empty', entity: 'Catalog_X' }, { fetchImpl });
  ok(/odataUrl/.test(noUrl2) && !noUrl2.includes(PASSWORD), 'без webUrl и odataUrl запрос не уходит', noUrl2);
  ok(noUrl.includes('не найдена') || /odata_get/.test(noUrl), 'чужой id не читает чужую базу', noUrl);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
