import 'dotenv/config';
import express from 'express';
import fs from 'fs/promises';
import { generateText, tool } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';

const app = express();
app.use(express.json());

const DATA_DIR = '/data';
const MEM_FILE = DATA_DIR + '/memory.json';

async function loadMemory() {
  try { return JSON.parse(await fs.readFile(MEM_FILE, 'utf8')); }
  catch { return { todos: [], notes: [] }; }
}
async function saveMemory(mem) {
  await fs.mkdir(DATA_DIR, { recursive: true }).catch(() => {});
  await fs.writeFile(MEM_FILE, JSON.stringify(mem, null, 2));
}

async function buildSystemPrompt() {
  const mem = await loadMemory();
  const notes = mem.notes.length ? mem.notes.map(n => '- ' + n).join('\n') : '(noch nichts gemerkt)';
  const open = mem.todos.filter(t => !t.done);
  const todoText = open.length ? open.map(t => '- ' + t.text).join('\n') : '(keine offenen)';
  return `Du bist IVA, der persoenliche Assistent von Nadine.
Charakter: Sparringspartner, kein Jasager. Loesungsorientiert, direkt, ehrlich.
Keine Moralkeule - bei Grauzonen Weg UND Haken in einem Satz, dann die Loesung.
Fasse dich kurz. Hoechstens eine Rueckfrage, nur wenn noetig.
Nutze deine Werkzeuge, statt nur darueber zu reden.

Das hast du dir gemerkt:
${notes}

Offene Todos:
${todoText}`;
}

const tools = {
  createTodo: tool({
    description: 'Legt ein neues Todo an.',
    parameters: z.object({ text: z.string() }),
    execute: async ({ text }) => {
      const mem = await loadMemory();
      mem.todos.push({ text, done: false, ts: Date.now() });
      await saveMemory(mem);
      return { ok: true, text };
    },
  }),
  completeTodo: tool({
    description: 'Markiert ein Todo per Textsuche als erledigt.',
    parameters: z.object({ text: z.string() }),
    execute: async ({ text }) => {
      const mem = await loadMemory();
      const t = mem.todos.find(t => !t.done && t.text.toLowerCase().includes(text.toLowerCase()));
      if (t) { t.done = true; await saveMemory(mem); return { ok: true, done: t.text }; }
      return { ok: false, msg: 'nicht gefunden' };
    },
  }),
  remember: tool({
    description: 'Merkt sich dauerhaft eine Information (bereichsuebergreifend).',
    parameters: z.object({ fact: z.string() }),
    execute: async ({ fact }) => {
      const mem = await loadMemory();
      mem.notes.push(fact);
      await saveMemory(mem);
      return { ok: true, fact };
    },
  }),
};

async function askIva(userText) {
  const system = await buildSystemPrompt();
  const { text } = await generateText({
    model: anthropic('claude-sonnet-4-6'),
    system,
    prompt: userText,
    tools,
    maxSteps: 5,
  });
  return text;
}

async function transcribeVoice(fileId) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const fileRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
  const filePath = (await fileRes.json()).result.file_path;
  const audioRes = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  const audioBuf = Buffer.from(await audioRes.arrayBuffer());
  const form = new FormData();
  form.append('file', new Blob([audioBuf]), 'voice.ogg');
  form.append('model', 'whisper-large-v3-turbo');
  const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: form,
  });
  return (await r.json()).text;
}

app.post('/telegram', async (req, res) => {
  const msg = req.body?.message;
  const chatId = msg?.chat?.id;
  res.sendStatus(200);
  if (!chatId) return;
  try {
    let userText = msg?.text;
    if (!userText && msg?.voice) {
      userText = await transcribeVoice(msg.voice.file_id);
    }
    if (!userText) return;
    const reply = await askIva(userText);
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: reply }),
    });
  } catch (e) { console.error('Fehler:', e); }
});

async function setupTelegramWebhook() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (!token || !domain) { console.log('Telegram: Token/Domain fehlt.'); return; }
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/setWebhook?url=https://${domain}/telegram`);
    console.log('Telegram-Webhook:', await r.text());
  } catch (e) { console.error('Webhook-Fehler:', e); }
}

app.get('/', (_req, res) => res.send('IVA laeuft.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log('IVA-Core auf Port ' + PORT); setupTelegramWebhook(); });
