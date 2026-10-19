// Поддельный OpenAI-совместимый сервер для тестов семантического поиска:
//   GET /v1/models, POST /v1/embeddings (мешок слов → вектор), POST /v1/responses (logprobs yes/no по пересечению слов
//   Query и Document, как Qwen3-Reranker), POST /v1/rerank (llama-server / Cohere-формат).
// Поведение меняется полем opts (режимы: think, nologprobs, reject1, hang, auth, embedDim).
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const tokens = (s) => String(s).toLowerCase().replace(/ё/g, 'е')
  .replace(/([а-яa-z0-9])([А-ЯA-Z])/g, '$1 $2').split(/[^a-zа-я0-9]+/).filter((w) => w.length > 2)
  .map((w) => (w.length > 5 ? w.slice(0, w.length - 2) : w));

export function bagVector(text, dim) {
  const v = new Array(dim).fill(0);
  for (const t of tokens(text)) {
    const h = createHash('md5').update(t).digest();
    v[h.readUInt16LE(0) % dim] += 1;
    v[h.readUInt16LE(2) % dim] += 0.5;
  }
  if (!v.some((x) => x)) v[0] = 1;
  return v;
}

function overlap(q, d) {
  const qs = new Set(tokens(q)); const ds = new Set(tokens(d));
  let n = 0; for (const t of qs) if (ds.has(t)) n++;
  return qs.size ? n / qs.size : 0;
}

export function startFake(opts = {}) {
  const stats = { embedInputs: 0, embedCalls: 0, responses: 0, rerank: 0, maxOut: [], auth: [] };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      stats.auth.push(req.headers.authorization || '');
      if (opts.hang) return;   // не отвечаем вовсе
      if (opts.auth && req.headers.authorization !== `Bearer ${opts.auth}`) return send(401, { error: { message: 'Unauthorized' } });
      let j = {};
      try { j = body ? JSON.parse(body) : {}; } catch { return send(400, { error: { message: 'bad json' } }); }
      const delay = opts.delayMs || 0;
      setTimeout(() => {
        if (req.method === 'GET' && req.url === '/v1/models') {
          return send(200, { object: 'list', data: (opts.models || ['qwen3-embedding-4b', 'qwen3-reranker-4b']).map((id) => ({ id, object: 'model' })) });
        }
        if (req.method === 'POST' && req.url === '/v1/embeddings') {
          const input = Array.isArray(j.input) ? j.input : [j.input];
          if (opts.failEmbed) return send(500, { error: { message: 'boom' } });
          if (opts.embedModelMissing && j.model !== opts.embedModelMissing) return send(404, { error: { message: `model ${j.model} not found` } });
          stats.embedCalls++; stats.embedInputs += input.length;
          if (input.some((t) => t.length > (opts.maxInputChars || 1e9))) return send(400, { error: { message: 'input too long for context' } });
          return send(200, { object: 'list', data: input.map((t, index) => ({ object: 'embedding', index, embedding: bagVector(t, opts.embedDim || 128) })) });
        }
        if (req.method === 'POST' && req.url === '/v1/responses') {
          stats.responses++; stats.maxOut.push(j.max_output_tokens);
          if (opts.reject1 && j.max_output_tokens < 16) return send(400, { error: { message: 'max_output_tokens must be at least 16' } });
          const user = (j.input || []).find((m) => m.role === 'user')?.content || '';
          const q = (user.match(/<Query>: ([\s\S]*?)\n<Document>:/) || [])[1] || '';
          const d = (user.match(/<Document>: ([\s\S]*)$/) || [])[1] || '';
          const p = Math.min(0.98, Math.max(0.02, overlap(q, d)));
          const ly = Math.log(p); const ln = Math.log(1 - p);
          const firstTok = opts.think ? '<think>' : (ly >= ln ? 'yes' : 'no');
          const content = { type: 'output_text', text: firstTok, annotations: [] };
          if (!opts.nologprobs) {
            content.logprobs = [{ token: firstTok, logprob: opts.think ? -0.01 : Math.max(ly, ln),
              top_logprobs: opts.think ? [{ token: '<think>', logprob: -0.01 }, { token: 'yes', logprob: -6 }]
                : [{ token: 'yes', logprob: ly }, { token: 'no', logprob: ln }, { token: 'Yes', logprob: ly - 5 }] }];
          }
          return send(200, { id: 'resp_1', object: 'response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [content] }] });
        }
        if (req.method === 'POST' && req.url === '/v1/rerank') {
          stats.rerank++;
          if (opts.noRerank) return send(404, { error: { message: 'Not Found' } });
          const results = (j.documents || []).map((d, index) => ({ index, relevance_score: overlap(j.query, d) }))
            .sort((a, b) => b.relevance_score - a.relevance_score);
          return send(200, { results });
        }
        send(404, { error: { message: 'Not Found' } });
      }, delay);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    resolve({ url: `http://127.0.0.1:${port}/v1`, port, stats, opts, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) });
  }));
}

if (process.argv[1] && process.argv[1].endsWith('fake-openai.mjs')) {
  startFake({}).then((f) => console.log(f.url));
}
