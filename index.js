import 'dotenv/config';
import express from 'express';
import { generateText, tool } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';

const app = express();
app.use(express.json());

const SYSTEM_PROMPT = `Du bist IVA, der persoenliche Assistent von Nadine.
Charakter: Sparringspartner, kein Jasager. Loesungsorientiert, direkt, ehrlich.
Keine Moralkeule - wenn etwas in einer kleinen Grauzone liegt, nenne Weg UND Haken in einem Satz und liefere dann die Loesung.
Fasse dich kurz. Hoechstens eine Rueckfrage, und nur wenn wirklich noetig.
Du hast Werkzeuge (z.B. Todos anlegen). Nutze sie, statt nur darueber zu reden.`;

const tools = {
  createTodo: tool({
    description: 'Legt ein neues Todo fuer Nadine an.',
    parameters: z.object({ text: z.string().describe('Der Todo-Text') }),
    execute: async ({ text }) => {
      console.log('NEUES TODO:', text);
      return { ok: true, text };
    },
  }),
};

async function askIva(userText) {
  const { text } = await generateText({
    model: anthropic('claude-sonnet-4-6'),
    system: SYSTEM_PROMPT,
    prompt: userText,
    tools,
    maxSteps: 5,
  });
  return text;
}

app.post('/telegram', async (req, res) => {
  const msg = req.body?.message;
  const chatId = msg?.chat?.id;
  const userText = msg?.text;
  res.sendStatus(200);
  if (!chatId || !userText) return;
  try {
    const reply = await askIva(userText);
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: reply }),
    });
  } catch (e) {
    console.error('Fehler bei askIva/Telegram:', e);
  }
});

async function setupTelegramWebhook() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (!token || !domain) {
    console.log('Telegram: Token oder Domain fehlt noch - Webhook nicht gesetzt.');
    return;
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/setWebhook?url=https://${domain}/telegram`);
    console.log('Telegram-Webhook gesetzt:', await r.text());
  } catch (e) {
    console.error('Webhook-Fehler:', e);
  }
}

app.get('/', (_req, res) => res.send('IVA laeuft.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('IVA-Core auf Port ' + PORT);
  setupTelegramWebhook();
});
