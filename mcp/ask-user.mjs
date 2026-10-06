#!/usr/bin/env node
// ask-user.mjs v1.0 — MCP-сервер «задать уточняющие вопросы» для goose.
// Аналог AskUserQuestion из Claude Code: вопросы показываются пользователю формой
// (MCP Elicitation) — в goose Desktop прямо в чате, в goose CLI — запросом в терминале.
// Без зависимостей: JSON-RPC 2.0 поверх stdio, сообщения разделены переводом строки.

import { createInterface } from 'node:readline';

const SERVER_INFO = { name: '1c-ask-user', version: '1.0.0' };
const OTHER = 'Другое (впишите ниже)';
const MAX_KEY = 120;

const INSTRUCTIONS = [
  'Инструмент ask_user показывает пользователю форму с уточняющими вопросами и ждёт ответа.',
  'Вызывай его ДО начала изменений, если в задаче не хватает данных, которые меняют результат:',
  'какой объект или база, имена и типы реквизитов, в расширении или в основной конфигурации,',
  'куда сохранить, какой вариант реализации выбрать. Перед загрузкой в базу и изменением многих',
  'объектов — подтверждение плана. Собирай все вопросы в один вызов (до 6) и предлагай варианты',
  'ответа (options), когда они очевидны. Не спрашивай то, что однозначно следует из задачи или проекта.',
].join(' ');

const TOOL = {
  name: 'ask_user',
  description:
    'Задать пользователю уточняющие вопросы формой и получить ответы. Используй вместо того, чтобы ' +
    'додумывать недостающие данные или спрашивать текстом в чате. Все вопросы — одним вызовом.',
  inputSchema: {
    type: 'object',
    properties: {
      intro: {
        type: 'string',
        description: 'Короткое пояснение над формой: зачем нужны ответы (1–2 предложения).',
      },
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: 6,
        description: 'Вопросы. Каждый — короткая формулировка; варианты ответа — если они очевидны.',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'Вопрос, до 100 символов.' },
            details: { type: 'string', description: 'Пояснение или пример ответа (необязательно).' },
            options: {
              type: 'array',
              items: { type: 'string' },
              description: 'Варианты ответа (2–6). Первый — рекомендуемый.',
            },
            allow_other: {
              type: 'boolean',
              description: 'Разрешить свой вариант при заданных options (по умолчанию true).',
            },
            type: {
              type: 'string',
              enum: ['text', 'yes_no'],
              description: 'Тип вопроса без options: text — свободный ответ (по умолчанию), yes_no — да/нет.',
            },
          },
          required: ['question'],
        },
      },
    },
    required: ['questions'],
  },
};

// ---------------------------------------------------------------------------
// Транспорт
// ---------------------------------------------------------------------------
let clientSupportsElicitation = false;
let nextId = 1;
const pending = new Map();

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function request(method, params) {
  const id = `ask-${nextId++}`;
  send({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function log(text) {
  process.stderr.write(`[ask-user] ${text}\n`);
}

// ---------------------------------------------------------------------------
// Форма
// ---------------------------------------------------------------------------
function uniqueKey(base, used) {
  let key = base.length > MAX_KEY ? base.slice(0, MAX_KEY - 1) + '…' : base;
  while (used.has(key)) key += ' ';
  used.add(key);
  return key;
}

export function buildForm(args) {
  const questions = Array.isArray(args?.questions) ? args.questions : [];
  if (!questions.length) throw new Error('questions: нужен хотя бы один вопрос');
  const properties = {};
  const required = [];
  const fields = [];        // { index, question, key, otherKey, kind }
  const used = new Set();

  questions.slice(0, 6).forEach((q, i) => {
    const question = String(q?.question || '').trim() || `Вопрос ${i + 1}`;
    const key = uniqueKey(`${i + 1}. ${question}`, used);
    const options = Array.isArray(q.options) ? q.options.map(String).filter(Boolean) : [];
    const field = { index: i + 1, question, key, otherKey: null, kind: 'text' };
    if (options.length) {
      const allowOther = q.allow_other !== false;
      const values = allowOther && !options.includes(OTHER) ? [...options, OTHER] : options;
      properties[key] = { type: 'string', enum: values, description: q.details || undefined };
      required.push(key);
      field.kind = 'choice';
      if (allowOther) {
        field.otherKey = uniqueKey(`${i + 1}.1 Свой вариант`, used);
        properties[field.otherKey] = { type: 'string', description: 'Заполните, если выбрали «Другое»' };
      }
    } else if (q.type === 'yes_no') {
      properties[key] = { type: 'boolean', description: q.details || undefined, default: false };
      field.kind = 'bool';
    } else {
      properties[key] = { type: 'string', description: q.details || undefined };
      required.push(key);
    }
    fields.push(field);
  });

  const message = String(args.intro || '').trim() || 'goose уточняет задачу перед тем, как начать.';
  return { message, requestedSchema: { type: 'object', properties, required }, fields };
}

export function formatAnswers(fields, content) {
  const lines = ['Ответы пользователя:'];
  for (const f of fields) {
    let answer = content?.[f.key];
    if (f.kind === 'bool') answer = answer === true ? 'да' : 'нет';
    if (f.kind === 'choice' && answer === OTHER) answer = content?.[f.otherKey] || '(свой вариант не указан)';
    else if (f.kind === 'choice' && f.otherKey && content?.[f.otherKey]) answer = `${answer}; комментарий: ${content[f.otherKey]}`;
    if (answer === undefined || answer === null || answer === '') answer = '(без ответа)';
    lines.push(`${f.index}. ${f.question} — ${answer}`);
  }
  lines.push('Действуй по этим ответам. Если чего-то по-прежнему не хватает — спроси ещё раз через ask_user.');
  return lines.join('\n');
}

function toolResult(text, isError = false) {
  return { content: [{ type: 'text', text }], isError };
}

async function callAskUser(args) {
  if (!clientSupportsElicitation) {
    return toolResult('Клиент не поддерживает формы (MCP Elicitation). Задай вопросы обычным сообщением в чате ' +
      'и остановись до ответа пользователя.', true);
  }
  let form;
  try {
    form = buildForm(args);
  } catch (e) {
    return toolResult(`Неверные параметры: ${e.message}`, true);
  }
  let res;
  try {
    res = await request('elicitation/create', { message: form.message, requestedSchema: form.requestedSchema });
  } catch (e) {
    return toolResult(`Форма не показана или пользователь не ответил вовремя (${e.message}). ` +
      'Не додумывай ответы: задай вопросы сообщением в чате и остановись.', true);
  }
  if (res?.action === 'accept') return toolResult(formatAnswers(form.fields, res.content || {}));
  if (res?.action === 'decline') {
    return toolResult('Пользователь отказался отвечать на вопросы. Не продолжай изменения: спроси в чате, ' +
      'как он хочет действовать.');
  }
  return toolResult('Пользователь закрыл форму без ответа. Остановись и дождись его сообщения.');
}

// ---------------------------------------------------------------------------
// Обработка сообщений
// ---------------------------------------------------------------------------
async function handle(msg) {
  if (msg.id !== undefined && msg.method === undefined) {
    // ответ клиента на наш запрос (elicitation/create)
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || 'ошибка клиента'));
      else p.resolve(msg.result);
    }
    return;
  }
  const { id, method, params } = msg;
  const reply = (result) => send({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'initialize':
      clientSupportsElicitation = !!params?.capabilities?.elicitation;
      reply({
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
      return;
    case 'ping':
      reply({});
      return;
    case 'tools/list':
      reply({ tools: [TOOL] });
      return;
    case 'tools/call':
      if (params?.name !== TOOL.name) return fail(-32602, `Неизвестный инструмент: ${params?.name}`);
      reply(await callAskUser(params.arguments || {}));
      return;
    default:
      if (id !== undefined) fail(-32601, `Метод не поддерживается: ${method}`);
  }
}

if (process.argv[1]?.endsWith('ask-user.mjs')) {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { log('не JSON: ' + line.slice(0, 200)); return; }
    handle(msg).catch((e) => log(e.stack || String(e)));
  });
  rl.on('close', () => process.exit(0));
}
