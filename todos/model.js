import crypto from 'node:crypto';

function cleanText(value, label, maxLength) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${label} fehlt`);
  if (text.length > maxLength) throw new Error(`${label} ist zu lang`);
  return text;
}

export function createTodo(text, { now = Date.now() } = {}) {
  return { text: cleanText(text, 'To-do', 300), done: false, ts: now };
}

export function findTodo(memory, todoTs) {
  const ts = Number(todoTs);
  if (!Number.isFinite(ts)) return null;
  return (memory.todos || []).find(todo => todo.ts === ts) || null;
}

export function updateTodoNotes(memory, todoTs, notes) {
  const todo = findTodo(memory, todoTs);
  if (!todo) return null;
  const value = String(notes || '').trim();
  if (value.length > 4000) throw new Error('Notiz ist zu lang');
  todo.notes = value;
  return todo;
}

export function addTodoSubtask(memory, todoTs, text, { id = crypto.randomUUID(), now = Date.now() } = {}) {
  const todo = findTodo(memory, todoTs);
  if (!todo) return null;
  todo.subtasks = Array.isArray(todo.subtasks) ? todo.subtasks : [];
  const subtask = { id, text: cleanText(text, 'Unterpunkt', 300), done: false, ts: now };
  todo.subtasks.push(subtask);
  return { todo, subtask };
}

export function toggleTodoSubtask(memory, todoTs, subtaskId) {
  const todo = findTodo(memory, todoTs);
  if (!todo) return null;
  const subtask = (todo.subtasks || []).find(item => item.id === String(subtaskId || ''));
  if (!subtask) return { todo, subtask: null };
  subtask.done = !subtask.done;
  return { todo, subtask };
}
