// Memory-Skill: Todos + gemerkte Notizen. Tool-Namen und Parameter-Shapes 1:1
// wie zuvor inline in index.js. Deps: loadMemory/saveMemory (aus index.js).
import { tool } from 'ai';
import { z } from 'zod';

export function memorySkill({ loadMemory, saveMemory }) {
  return {
    createTodo: tool({
      description: 'Legt ein neues Todo an.',
      parameters: z.object({ text: z.string() }),
      execute: async ({ text }) => {
        const m = await loadMemory();
        m.todos = m.todos || [];
        m.todos.push({ text, done: false, ts: Date.now() });
        await saveMemory(m);
        return { ok: true, text };
      },
    }),
    completeTodo: tool({
      description: 'Markiert ein Todo per Textsuche als erledigt.',
      parameters: z.object({ text: z.string() }),
      execute: async ({ text }) => {
        const m = await loadMemory();
        const t = (m.todos || []).find(t => !t.done && t.text.toLowerCase().includes(text.toLowerCase()));
        if (t) { t.done = true; await saveMemory(m); return { ok: true, done: t.text }; }
        return { ok: false };
      },
    }),
    remember: tool({
      description: 'Merkt sich dauerhaft eine Info.',
      parameters: z.object({ fact: z.string() }),
      execute: async ({ fact }) => {
        const m = await loadMemory();
        m.notes = m.notes || [];
        m.notes.push(fact);
        await saveMemory(m);
        return { ok: true, fact };
      },
    }),
  };
}

export const memorySkillMeta = { id: 'memory', toolNames: ['createTodo', 'completeTodo', 'remember'] };
