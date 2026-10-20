#!/usr/bin/env node
// Тесты семантического поиска 1c-search на поддельном OpenAI-совместимом сервере (tests/mcp/fake-openai.mjs):
// построение и инкрементальное обновление индекса, гибридный поиск, переранжирование (logprobs и /v1/rerank),
// деградация (сервер недоступен / завис / нет шаблона реранкера / нет logprobs), блокировка построителя между
// процессами, общее хранилище, токен API не попадает в вывод и файлы, MCP stdio.
//   node tests/mcp/semantic.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, utimesSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { startFake } from './fake-openai.mjs';
import * as sem from '../../mcp/lib/semantic.mjs';
import { buildIndex, semanticSearch, semanticIndex, semanticSources, keywordRank } from '../../mcp/code-search.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(here, '..', '..', 'mcp', 'code-search.mjs');
let passed = 0; let failed = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name}${extra ? `\n       ${String(extra).split('\n').join('\n       ')}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// фиктивный токен для фейкового сервера: генерируется при запуске, литерала в репозитории нет
const TOKEN = `fake-${process.pid}-${Date.now().toString(36)}`;

const MOD_SALES = `// Проверяет, не превышен ли кредитный лимит контрагента при оформлении заказа.
// Параметры:
//   Контрагент - СправочникСсылка.Контрагенты
Функция ПроверитьКредитныйЛимит(Контрагент, Сумма) Экспорт
	Лимит = Контрагент.КредитныйЛимит;
	Возврат Сумма <= Лимит;
КонецФункции

// Рассчитывает скидку по дисконтной карте покупателя.
Функция РассчитатьСкидку(Карта) Экспорт
	Возврат 5;
КонецФункции
`;
const MOD_STOCK = `// Резервирует товары на складе под заказ покупателя.
Процедура ЗарезервироватьТовары(Заказ) Экспорт
	Остаток = 0;
КонецПроцедуры

&НаСервере
// Печать накладной на отгрузку товаров со склада
Процедура НапечататьНакладную() Экспорт
КонецПроцедуры
`;
const CATALOG = `<?xml version="1.0" encoding="UTF-8"?>
<MetaDataObject xmlns:v8="http://v8.1c.ru/8.1/data/core"><Catalog><Properties><Name>Контрагенты</Name>
<Synonym><v8:item><v8:lang>ru</v8:lang><v8:content>Контрагенты (покупатели и поставщики)</v8:content></v8:item></Synonym></Properties>
<ChildObjects><Attribute><Properties><Name>КредитныйЛимит</Name><Synonym><v8:item><v8:lang>ru</v8:lang><v8:content>Кредитный лимит</v8:content></v8:item></Synonym></Properties></Attribute></ChildObjects>
</Catalog></MetaDataObject>`;

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'sem-proj-'));
  const cf = join(root, 'src', 'cf');
  mkdirSync(join(cf, 'CommonModules', 'Продажи', 'Ext'), { recursive: true });
  mkdirSync(join(cf, 'CommonModules', 'Склад', 'Ext'), { recursive: true });
  mkdirSync(join(cf, 'Catalogs'), { recursive: true });
  writeFileSync(join(cf, 'Configuration.xml'), '<MetaDataObject><Configuration><Properties><Name>Тест</Name></Properties></Configuration></MetaDataObject>');
  writeFileSync(join(cf, 'CommonModules', 'Продажи', 'Ext', 'Module.bsl'), MOD_SALES);
  writeFileSync(join(cf, 'CommonModules', 'Склад', 'Ext', 'Module.bsl'), MOD_STOCK);
  writeFileSync(join(cf, 'Catalogs', 'Контрагенты.xml'), CATALOG);
  return root;
}

const envFor = (fake, store, extra = {}) => ({
  SEMANTIC_BASE_URL: fake ? fake.url : 'http://127.0.0.1:9/v1', SEMANTIC_STORE_DIR: store, SEMANTIC_EMBED_DIM: '64',
  SEMANTIC_AUTOBUILD: '0', SEMANTIC_TIMEOUT_MS: '2000', SEMANTIC_RERANK_TIMEOUT_MS: '5000', ...extra,
});
const withEnv = async (env, fn) => {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  try { return await fn(); } finally { for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
};
const reset = () => { sem.resetProbes(); sem.resetStores(); sem.resetRerank(); };

async function build(root, env, action = 'build') {
  return withEnv(env, async () => {
    const idx = buildIndex(root, { force: true });
    return semanticIndex(idx, { action, wait_seconds: 20 }, { env });
  });
}
const search = (root, env, a) => withEnv(env, () => semanticSearch(buildIndex(root, { force: true }), a, { env }));

console.log('semantic: настройки и разбор ответа реранкера');
{
  const root = makeProject();
  writeFileSync(join(root, '.v8-project.json'), JSON.stringify({ semanticSearch: { embedModel: 'from-file', apiKey: 'leak', topK: 7, rerankBackend: 'rerank-api' } }));
  const cfg = sem.loadConfig(root, { SEMANTIC_EMBED_MODEL: 'from-env', LMSTUDIO_API_KEY: TOKEN });
  ok(cfg.embedModel === 'from-env' && cfg.topK === 7 && cfg.rerankBackend === 'rerank-api', 'переменные среды важнее .v8-project.json, остальное — из файла');
  ok(cfg.apiKey === TOKEN && !JSON.stringify(cfg).includes(TOKEN), 'токен берётся из LMSTUDIO_API_KEY и не сериализуется');
  ok(cfg.notes.some((n) => /apiKey.*игнорируется/.test(n)) && !JSON.stringify(cfg).includes('leak'), 'apiKey в .v8-project.json игнорируется с предупреждением');
  ok(sem.loadConfig(root, { SEMANTIC_RERANK_BACKEND: 'bogus' }).rerankBackend === 'none', 'неизвестный бэкенд переранжирования → none');
  ok(sem.loadConfig(root, { SEMANTIC_SEARCH: '0' }).enabled === false && sem.loadConfig(root, {}).enabled === 'auto', 'enabled: auto по умолчанию, SEMANTIC_SEARCH=0 выключает');
  const s1 = sem.yesNoScore({ token: 'yes', logprob: -0.1, top_logprobs: [{ token: 'yes', logprob: -0.1 }, { token: 'no', logprob: -2.4 }] });
  ok(Math.abs(s1.score - 1 / (1 + Math.exp(-2.3))) < 1e-9 && s1.found, 'P(yes) = softmax(yes, no)');
  const s2 = sem.yesNoScore({ token: 'no', logprob: -0.05, top_logprobs: [{ token: 'no', logprob: -0.05 }] });
  ok(Math.abs(s2.score - 1 / (1 + Math.exp(-0.05 + 10))) < 1e-9, 'отсутствующий yes → −10');
  ok(!sem.yesNoScore({ token: 'Hello', logprob: -0.1, top_logprobs: [] }).found, 'нет ни yes, ни no — found=false');
  const body = sem.responsesBody(sem.loadConfig(root, {}), 'q', 'd', 1);
  ok(body.temperature === 0 && body.max_output_tokens === 1 && body.top_logprobs === 20 && body.store === false &&
    body.include[0] === 'message.output_text.logprobs' && body.input[0].content === sem.RERANK_SYSTEM &&
    body.input[1].content.startsWith('<Instruct>: ') && body.input[1].content.includes('\n<Query>: q\n<Document>: d'), 'тело /v1/responses по карточке Qwen3-Reranker');
  ok(sem.queryText(sem.loadConfig(root, {}), 'x').startsWith('Instruct: ') && sem.queryText(sem.loadConfig(root, {}), 'x').endsWith('\nQuery: x'), 'инструкция Qwen3-Embedding у запроса');
  ok(sem.rrf([['a', 'b', 'c'], ['c', 'a']])[0].key === 'a', 'RRF объединяет списки');
}

console.log('semantic: построение, поиск, инкрементальное обновление');
{
  const fake = await startFake({});
  const root = makeProject();
  const store = mkdtempSync(join(tmpdir(), 'sem-store-'));
  const env = envFor(fake, store, { LMSTUDIO_API_KEY: TOKEN });
  reset();
  const st = await build(root, env);
  ok(/Построение завершено/.test(st) && /5 из 5 фрагментов с векторами \(100%\)/.test(st), 'индекс построен: 4 метода + 1 объект', st);
  ok(fake.stats.embedInputs === 5, `эмбеддинги посчитаны один раз (${fake.stats.embedInputs})`);
  ok(fake.stats.auth.every((a) => a === `Bearer ${TOKEN}`), 'токен передаётся в Authorization');
  const files = readdirSync(sem.vectorDir(sem.loadConfig(root, env)));
  ok(files.some((f) => f.endsWith('.vec')) && !files.some((f) => f.endsWith('.tmp')), 'сегмент записан атомарно, временных файлов нет');
  const blob = [...files.map((f) => readFileSync(join(sem.vectorDir(sem.loadConfig(root, env)), f), 'latin1')),
    ...readdirSync(join(store, 'projects')).map((f) => readFileSync(join(store, 'projects', f), 'utf8'))].join('');
  ok(!blob.includes(TOKEN), 'токен не попал в файлы хранилища');

  const r = await search(root, env, { query: 'где проверяется кредитный лимит контрагента' });
  const first = r.split('\n').find((l) => /^1\. /.test(l)) || '';
  ok(/ПроверитьКредитныйЛимит/.test(first), 'гибридный поиск: нужный метод первым', r);
  ok(/Режим: гибридный/.test(r) && /переранжирование: qwen3-reranker-4b/.test(r) && /rerank \d\.\d\d/.test(r), 'режим и оценки реранкера в ответе', r);
  ok(/Module\.bsl:4-7/.test(r) && /\/\/ Проверяет, не превышен/.test(r), 'файл:строки и первая строка комментария', r);
  ok(!r.includes(TOKEN), 'токен не попал в ответ');
  ok(fake.stats.maxOut.every((m) => m === 1), 'max_output_tokens=1');
  const sem1 = await search(root, env, { query: 'резервирование товаров на складе', mode: 'semantic', rerank: false });
  ok(/^1\. ОбщийМодуль\.Склад → Процедура ЗарезервироватьТовары/m.test(sem1) && !/rerank/.test(sem1), 'режим semantic без реранкера', sem1);
  const objq = await search(root, env, { query: 'контрагенты покупатели поставщики', limit: 3 });
  ok(/Справочник\.Контрагенты.*объект метаданных/.test(objq), 'объекты метаданных тоже ищутся', objq);
  const scoped = await search(root, env, { query: 'товары', object: 'ОбщийМодуль.Склад' });
  ok(!/Продажи/.test(scoped) && /Склад/.test(scoped), 'object сужает поиск', scoped);
  const code = await search(root, env, { query: 'скидка по дисконтной карте', with_code: true, limit: 2 });
  ok(/```bsl[\s\S]*Возврат 5;/.test(code), 'with_code=true — код первых результатов', code);

  // инкрементально: меняем один модуль — пересчитываются только его методы
  const before = fake.stats.embedInputs;
  await sleep(20);
  writeFileSync(join(root, 'src', 'cf', 'CommonModules', 'Продажи', 'Ext', 'Module.bsl'), MOD_SALES.replace('Возврат 5;', 'Возврат 7;'));
  const st2 = await build(root, env);
  ok(fake.stats.embedInputs - before === 1 && /100%/.test(st2), `после правки одного метода пересчитан 1 фрагмент (${fake.stats.embedInputs - before})`, st2);
  const before2 = fake.stats.embedInputs;
  await build(root, env);
  ok(fake.stats.embedInputs === before2, 'без изменений — ни одного запроса эмбеддингов');
  await build(root, env, 'rebuild');
  ok(fake.stats.embedInputs === before2, 'rebuild переразбирает файлы, но готовые векторы берёт из хранилища (по хэшу)');

  // общее хранилище: тот же код в другом клоне (другой корень) — векторы переиспользуются
  const clone = makeProject();
  writeFileSync(join(clone, 'src', 'cf', 'CommonModules', 'Продажи', 'Ext', 'Module.bsl'), MOD_SALES.replace('Возврат 5;', 'Возврат 7;'));
  const before3 = fake.stats.embedInputs;
  const st3 = await build(clone, env);
  ok(fake.stats.embedInputs === before3 && /100%/.test(st3), 'второй клон в общем хранилище — 0 новых эмбеддингов', st3);

  // max_output_tokens=1 отвергнут → 16
  reset(); fake.opts.reject1 = true; fake.stats.maxOut.length = 0;
  const r16 = await search(root, env, { query: 'кредитный лимит контрагента' });
  ok(/rerank/.test(r16) && fake.stats.maxOut.includes(16) && !/\[!\]/.test(r16), 'max_output_tokens=1 отвергнут → повтор с 16', r16);
  fake.opts.reject1 = false;

  // нет шаблона реранкера: модель «думает»
  reset(); fake.opts.think = true;
  const rt = await search(root, env, { query: 'кредитный лимит контрагента' });
  ok(/\[!\] переранжирование не выполнено: .*<think>.*шаблон/.test(rt) && /^1\. /m.test(rt) && !/rerank \d/.test(rt), 'без шаблона: понятная пометка, результаты без переранжирования', rt);
  const rt2 = await search(root, env, { query: 'кредитный лимит контрагента' });
  ok(/переранжирование пропущено/.test(rt2), 'после фатальной ошибки реранкер не дёргается минуту');
  fake.opts.think = false;

  reset(); fake.opts.nologprobs = true;
  const rn = await search(root, env, { query: 'кредитный лимит' });
  ok(/не вернул logprobs.*lms runtime update/.test(rn), 'нет logprobs → подсказка обновить движок', rn);
  fake.opts.nologprobs = false;

  // бэкенд rerank-api
  reset();
  const ra = await search(root, { ...env, SEMANTIC_RERANK_BACKEND: 'rerank-api' }, { query: 'где проверяется кредитный лимит контрагента' });
  ok(fake.stats.rerank === 1 && /rerank \d/.test(ra) && /^1\. .*ПроверитьКредитныйЛимит/m.test(ra), 'rerank-api: один запрос /v1/rerank', ra);
  reset(); fake.opts.noRerank = true;
  const ra2 = await search(root, { ...env, SEMANTIC_RERANK_BACKEND: 'rerank-api' }, { query: 'кредитный лимит' });
  ok(/\/rerank не поддерживается/.test(ra2) && /^1\. /m.test(ra2), 'rerank-api недоступен — пометка, без переранжирования', ra2);
  fake.opts.noRerank = false;

  // модель эмбеддингов не загружена
  reset(); fake.opts.embedModelMissing = 'other';
  const nm = await search(root, env, { query: 'кредитный лимит' });
  ok(/\[!\] семантика недоступна \(эмбеддинги qwen3-embedding-4b: HTTP 404/.test(nm) && /Режим: по ключевым словам/.test(nm) && /ПроверитьКредитныйЛимит/.test(nm), 'модель не загружена → ключевые слова с пометкой', nm);
  fake.opts.embedModelMissing = undefined;

  // требуется токен, а его нет
  reset(); fake.opts.auth = TOKEN;
  const na = await search(root, { ...env, LMSTUDIO_API_KEY: '' }, { query: 'кредитный лимит' });
  ok(/нужен токен API: переменная среды LMSTUDIO_API_KEY/.test(na) && /ПроверитьКредитныйЛимит/.test(na), 'нет токена → подсказка про LMSTUDIO_API_KEY', na);
  fake.opts.auth = undefined;

  // выключено
  const off = await search(root, { ...env, SEMANTIC_SEARCH: '0' }, { query: 'кредитный лимит' });
  ok(/семантический поиск выключен/.test(off) && /ПроверитьКредитныйЛимит/.test(off), 'SEMANTIC_SEARCH=0 → только ключевые слова');
  await fake.close();
}

console.log('semantic: деградация без сервера');
{
  const root = makeProject();
  const store = mkdtempSync(join(tmpdir(), 'sem-store-'));
  reset();
  let t = Date.now();
  const r = await search(root, envFor(null, store), { query: 'где проверяется кредитный лимит контрагента' });
  ok(/\[!\] семантика недоступна \(http:\/\/127\.0\.0\.1:9\/v1: соединение не установлено/.test(r) && /Режим: по ключевым словам/.test(r), 'сервер не запущен → одна строка [!] и поиск по словам', r);
  ok(/ПроверитьКредитныйЛимит/.test(r) && Date.now() - t < 4000, `ключевые слова нашли метод (${Date.now() - t} мс)`);
  const ix = await withEnv(envFor(null, store), () => semanticIndex(buildIndex(root), { action: 'build' }, { env: envFor(null, store) }));
  ok(/Сервер недоступен/.test(ix) && /Построение не запущено/.test(ix), 'semantic_index build без сервера — не падает', ix);

  const hang = await startFake({ hang: true });
  reset();
  t = Date.now();
  const rh = await search(root, envFor(hang, store), { query: 'кредитный лимит' });
  ok(/нет ответа за 3 с/.test(rh) && Date.now() - t < 6000, `сервер завис → таймаут ${Date.now() - t} мс, ответ по ключевым словам`, rh);
  await hang.close();

  const fake = await startFake({});
  reset();
  const ni = await search(root, envFor(fake, store), { query: 'кредитный лимит' });
  ok(/семантический индекс ещё не построен — запустите semantic_index action=build/.test(ni), 'индекса нет → подсказка', ni);
  // автопостроение в фоне при поиске
  reset();
  const env2 = { ...envFor(fake, store), SEMANTIC_AUTOBUILD: '1' };
  const ab = await search(root, env2, { query: 'кредитный лимит' });
  ok(/ещё не построен|неполный/.test(ab) || /Режим: гибридный/.test(ab), 'первый поиск запускает построение в фоне', ab);
  const bs = sem.buildState(root);
  if (bs?.promise) await bs.promise;
  const ab2 = await search(root, env2, { query: 'где проверяется кредитный лимит контрагента' });
  ok(/Режим: гибридный/.test(ab2) && !/неполный/.test(ab2), 'после фонового построения — гибридный режим', ab2);

  // частичный индекс: падение сервера на эмбеддингах посреди построения → ошибка в статусе, поиск по неполному индексу
  const root2 = makeProject();
  reset();
  const env3 = { ...envFor(fake, mkdtempSync(join(tmpdir(), 'sem-store-'))), SEMANTIC_BATCH: '2' };
  fake.opts.failEmbed = true;
  const sf = await withEnv(env3, async () => {
    const idx = buildIndex(root2, { force: true });
    return semanticIndex(idx, { action: 'build', wait_seconds: 20 }, { env: env3 });
  });
  ok(/ошибка — HTTP 500/.test(sf) && /0 из 5/.test(sf), 'ошибка сервера при построении — в статусе, процесс жив', sf);
  fake.opts.failEmbed = false;
  await fake.close();
}

console.log('semantic: блокировка и хранилище');
{
  const store = mkdtempSync(join(tmpdir(), 'sem-store-'));
  const lockFile = join(store, 'x', 'build.lock');
  const a = sem.acquireLock(lockFile);
  ok(!!a && sem.acquireLock(lockFile) === null, 'второй построитель блокировку не получает');
  const info = sem.readLock(lockFile);
  ok(info.pid === process.pid && !info.stale, 'в блокировке pid и пользователь');
  a.release();
  ok(!existsSync(lockFile), 'блокировка снята');
  writeFileSync(lockFile, JSON.stringify({ token: 'old', pid: 999999 }));
  const old = new Date(Date.now() - sem.LOCK_STALE_MS - 5000);
  utimesSync(lockFile, old, old);
  const b = sem.acquireLock(lockFile);
  ok(!!b, 'брошенная блокировка (heartbeat старше 2 мин) снимается');
  b.release();

  const vs = new sem.VectorStore(join(store, 'v'), 8);
  for (let i = 0; i < 5; i++) vs.append([{ h: String(i).repeat(40), v: sem.normalize([1, i, 0, 0, 0, 0, 0, 1], 8) }]);
  ok(vs.segments().length === 5, '5 сегментов');
  ok(vs.compact(3) === 5 && vs.segments().length === 1, 'уплотнение: 5 → 1');
  const vs2 = new sem.VectorStore(join(store, 'v'), 8).refresh();
  ok(vs2.size === 5 && Math.abs(vs2.score(sem.normalize([1, 2, 0, 0, 0, 0, 0, 1], 8), '2'.repeat(40)) - 1) < 0.02, 'после уплотнения векторы читаются (int8, косинус ≈ 1)');
  writeFileSync(join(store, 'v', 'seg-broken.vec'), 'garbage');
  ok(new sem.VectorStore(join(store, 'v'), 8).refresh().size === 5, 'битый сегмент пропускается');

  // два процесса-построителя одновременно на одно хранилище
  const fake = await startFake({ delayMs: 150 });
  const root = makeProject();
  const shared = mkdtempSync(join(tmpdir(), 'sem-shared-'));
  const env = { ...process.env, ...envFor(fake, shared), SEMANTIC_BATCH: '1' };
  const run = () => new Promise((res) => {
    const p = spawn(process.execPath, [SERVER, '--semantic-build', '--root', root], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => res({ code, out }));
  });
  const [r1, r2] = await Promise.all([run(), run()]);
  const codes = [r1.code, r2.code].sort();
  ok((codes[0] === 0 && codes[1] === 4) || (codes[0] === 0 && codes[1] === 0), `одновременно строит один процесс (коды ${codes.join(', ')})`, r1.out + '\n' + r2.out);
  ok(fake.stats.embedInputs === 5, `каждый фрагмент посчитан один раз (${fake.stats.embedInputs})`);
  const r3 = await run();
  ok(r3.code === 0 && /5 из 5/.test(r3.out) && fake.stats.embedInputs === 5, 'повторный запуск CLI: всё уже есть', r3.out);
  ok(!readdirSync(sem.vectorDir(sem.loadConfig(root, env))).some((f) => f.endsWith('.tmp') || f === 'build.lock'), 'после завершения нет блокировки и временных файлов');
  await fake.close();
  rmSync(shared, { recursive: true, force: true });
}

console.log('semantic: MCP stdio');
{
  const fake = await startFake({});
  const root = makeProject();
  const store = mkdtempSync(join(tmpdir(), 'sem-store-'));
  const p = spawn(process.execPath, [SERVER], { cwd: root, env: { ...process.env, ...envFor(fake, store), LMSTUDIO_API_KEY: TOKEN }, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  createInterface({ input: p.stdout }).on('line', (l) => lines.push(JSON.parse(l)));
  const send = (m) => p.stdin.write(JSON.stringify(m) + '\n');
  const wait = async (id, ms = 20000) => { const t = Date.now() + ms; while (Date.now() < t) { const m = lines.find((x) => x.id === id); if (m) return m; await sleep(50); } return null; };
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
  await wait(1);
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const tl = await wait(2);
  const names = tl?.result?.tools?.map((t) => t.name) || [];
  ok(names.includes('semantic_search') && names.includes('semantic_index') && names.includes('find_method'), 'tools/list: semantic_search, semantic_index и прежние');
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'semantic_index', arguments: { action: 'build', wait_seconds: 15 } } });
  const b = await wait(3);
  ok(/100%/.test(b?.result?.content?.[0]?.text || ''), 'semantic_index build через MCP', b?.result?.content?.[0]?.text);
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'semantic_search', arguments: { query: 'где проверяется кредитный лимит контрагента' } } });
  const s = await wait(4);
  const text = s?.result?.content?.[0]?.text || '';
  ok(/^1\. .*ПроверитьКредитныйЛимит/m.test(text) && !text.includes(TOKEN), 'semantic_search через MCP', text);
  send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'index_status', arguments: {} } });
  const is = await wait(5);
  ok(/Семантический поиск: .*индекс есть \(5 фрагментов\)/.test(is?.result?.content?.[0]?.text || ''), 'index_status показывает семантический индекс', is?.result?.content?.[0]?.text);
  p.stdin.end();
  await new Promise((r) => p.on('close', r));
  await fake.close();
}

console.log('semantic: ключевые слова');
{
  const root = makeProject();
  const idx = buildIndex(root, { force: true });
  const kw = keywordRank(idx, 'где ПроверитьКредитныйЛимит');
  ok(kw[0]?.m?.name === 'ПроверитьКредитныйЛимит', 'идентификатор из запроса находит метод');
  const src = semanticSources(idx, { includeObjects: true });
  ok(src.filter((x) => x.kind === 'module').length === 2 && src.some((x) => x.kind === 'object' && x.title === 'Справочник.Контрагенты'), 'источники: модули и объекты');
  const chunks = sem.moduleChunks(MOD_STOCK, src.find((x) => x.moduleId === 'ОбщийМодуль.Склад'), 2000);
  ok(chunks[1].text.includes('&НаСервере') && chunks[1].text.includes('// Печать накладной') && chunks[1].text.startsWith('Модуль: ОбщийМодуль.Склад'), 'фрагмент: заголовок модуля, директива, комментарий, тело');
  const typical = sem.moduleChunks('// Комментарий\n&НаКлиенте\nПроцедура Б()\nКонецПроцедуры', { moduleId: 'М', methods: [{ name: 'Б', kind: 'Процедура', line: 3, end: 4, dir: '&НаКлиенте' }] }, 2000)[0].text;
  ok(typical === 'Модуль: М\n// Комментарий\n&НаКлиенте\nПроцедура Б()\nКонецПроцедуры', 'обычный порядок: комментарий, директива, метод', typical);
  ok(sem.moduleChunks('Процедура А()\n' + 'Х = 1;\n'.repeat(1000) + 'КонецПроцедуры', { moduleId: 'М', methods: [{ name: 'А', kind: 'Процедура', line: 1, end: 1002 }] }, 500)[0].text.length < 560, 'длинный метод усекается до maxChunkChars');
}

console.log('semantic: EOS для Qwen3-Embedding (пулинг по последнему токену)');
{
  const EOS = '<|endoftext|>';
  const root = makeProject();
  const cfgOf = (env) => sem.loadConfig(root, env);
  ok(sem.embedEos(cfgOf({})) === EOS && cfgOf({}).appendEos === 'auto', 'по умолчанию auto: qwen3-embedding-4b → <|endoftext|>');
  ok(sem.embedEos(cfgOf({ SEMANTIC_EMBED_MODEL: 'majentik/Text-Embedding-Qwen3-Embedding-4B' })) === EOS, 'auto распознаёт имя модели без учёта регистра');
  ok(sem.embedEos(cfgOf({ SEMANTIC_EMBED_MODEL: 'nomic-embed-text-v1.5' })) === '', 'auto: другие модели — без EOS');
  ok(sem.embedEos(cfgOf({ SEMANTIC_EMBED_APPEND_EOS: '0' })) === '', 'SEMANTIC_EMBED_APPEND_EOS=0 выключает');
  ok(sem.embedEos(cfgOf({ SEMANTIC_EMBED_MODEL: 'bge-m3', SEMANTIC_EMBED_APPEND_EOS: 'true', SEMANTIC_EMBED_EOS_TOKEN: '</s>' })) === '</s>', 'явное true и свой eosToken');
  const r2 = makeProject();
  writeFileSync(join(r2, '.v8-project.json'), JSON.stringify({ semanticSearch: { appendEos: false } }));
  ok(sem.embedEos(sem.loadConfig(r2, {})) === '' && sem.embedEos(sem.loadConfig(r2, { SEMANTIC_EMBED_APPEND_EOS: 'auto' })) === EOS, '.v8-project.json appendEos=false; переменная среды важнее');
  ok(sem.withEos('a', EOS) === `a${EOS}` && sem.withEos(`a${EOS}`, EOS) === `a${EOS}` && sem.withEos(`a${EOS}\n`, EOS) === `a${EOS}` && sem.withEos('a', '') === 'a', 'EOS не дублируется');
  ok(sem.hashText('x') === sem.hashText('x', '') && sem.hashText('x', EOS) !== sem.hashText('x'), 'хэш фрагмента учитывает EOS (без EOS — прежний)');
  ok(sem.vectorDir(cfgOf({})) !== sem.vectorDir(cfgOf({ SEMANTIC_EMBED_APPEND_EOS: '0' })), 'с EOS и без — разные наборы векторов');

  const fake = await startFake({ models: ['qwen3-embedding-4b', 'qwen3-reranker-4b', 'nomic-embed-text'] });
  const store = mkdtempSync(join(tmpdir(), 'sem-eos-'));
  // 1) старое поведение (как до исправления): без EOS
  const envOld = envFor(fake, store, { SEMANTIC_EMBED_APPEND_EOS: '0' });
  reset();
  await build(root, envOld);
  ok(fake.stats.inputs.length === 5 && fake.stats.inputs.every((i) => !i.text.includes(EOS)), 'appendEos=0: входы без EOS');
  // 2) обновление: auto → индекс устарел, всё пересчитывается с EOS
  const envNew = envFor(fake, store);
  reset();
  const stOld = await withEnv(envNew, () => semanticIndex(buildIndex(root, { force: true }), { action: 'status' }, { env: envNew }));
  ok(/построен без EOS/.test(stOld) && /EOS <\|endoftext\|> \(авто\)/.test(stOld), 'статус: индекс построен без EOS — устарел', stOld);
  fake.stats.inputs.length = 0;
  const stNew = await build(root, envNew);
  ok(/5 из 5 фрагментов с векторами/.test(stNew) && fake.stats.inputs.length === 5, `после смены EOS все фрагменты пересчитаны (${fake.stats.inputs.length})`, stNew);
  const once = (t) => t.endsWith(EOS) && t.indexOf(EOS) === t.length - EOS.length;
  ok(fake.stats.inputs.every((i) => once(i.text)), 'документы: EOS ровно один раз и в конце');
  fake.stats.inputs.length = 0;
  await build(root, envNew);
  ok(fake.stats.inputs.length === 0, 'повторное построение с EOS — ничего не пересчитывается');
  const r = await search(root, envNew, { query: 'где проверяется кредитный лимит контрагента', rerank: false });
  ok(/ПроверитьКредитныйЛимит/.test(r.split('\n').find((l) => /^1\. /.test(l)) || ''), 'поиск по индексу с EOS', r);
  const q = fake.stats.inputs.find((i) => i.text.startsWith('Instruct: '));
  ok(!!q && once(q.text), 'запрос: Instruct … Query … + EOS', q?.text);
  // 3) усечение при 4xx (длинный вход): половина текста + EOS в конце
  fake.opts.maxInputChars = 140;
  const store2 = mkdtempSync(join(tmpdir(), 'sem-eos2-'));
  const envTr = envFor(fake, store2);
  reset(); fake.stats.inputs.length = 0;
  await build(root, envTr);
  const singles = fake.stats.inputs.filter((i) => i.text.length <= 140);
  ok(fake.stats.inputs.some((i) => i.text.length > 140) && singles.length > 0 && fake.stats.inputs.every((i) => once(i.text)), 'усечение сохраняет EOS в конце');
  fake.opts.maxInputChars = undefined;
  // 4) не-Qwen модель — без EOS
  const envOther = envFor(fake, mkdtempSync(join(tmpdir(), 'sem-eos3-')), { SEMANTIC_EMBED_MODEL: 'nomic-embed-text' });
  reset(); fake.stats.inputs.length = 0;
  await build(root, envOther);
  await search(root, envOther, { query: 'кредитный лимит', rerank: false });
  ok(fake.stats.inputs.length >= 6 && fake.stats.inputs.every((i) => i.model === 'nomic-embed-text' && !i.text.includes(EOS)), 'другая модель: ни документы, ни запрос без EOS');
  await fake.close();
  for (const d of [store, store2]) rmSync(d, { recursive: true, force: true });
}

console.log(`\nsemantic: ${passed} ok, ${failed} fail`);
process.exit(failed ? 1 : 0);
