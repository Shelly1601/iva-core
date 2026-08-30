import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { addTodoSubtask, createTodo, findTodo, toggleTodoSubtask, updateTodoNotes } from '../todos/model.js';

const todo = createTodo('  Größere Aufgabe planen  ', { now: 1700000000000 });
assert.deepEqual(todo, { text: 'Größere Aufgabe planen', done: false, ts: 1700000000000 });
assert.throws(() => createTodo('   '), /fehlt/);

const memory = { todos: [todo], notes: [] };
assert.equal(findTodo(memory, '1700000000000'), todo);
assert.equal(updateTodoNotes(memory, todo.ts, '  Wichtige Hintergrundinfo  '), todo);
assert.equal(todo.notes, 'Wichtige Hintergrundinfo');

const added = addTodoSubtask(memory, todo.ts, '  Ersten Schritt erledigen  ', { id: 'step-1', now: 1700000000001 });
assert.equal(added.subtask.text, 'Ersten Schritt erledigen');
assert.equal(added.subtask.done, false);
assert.equal(todo.subtasks.length, 1);
assert.equal(toggleTodoSubtask(memory, todo.ts, 'step-1').subtask.done, true);
assert.equal(toggleTodoSubtask(memory, todo.ts, 'step-1').subtask.done, false);
assert.equal(addTodoSubtask(memory, 999, 'Nicht vorhanden'), null);
assert.equal(toggleTodoSubtask(memory, todo.ts, 'missing').subtask, null);

const cockpit = await readFile(new URL('../public/cockpit.html', import.meta.url), 'utf8');
assert.match(cockpit, /id="todoAddToggle"/);
assert.match(cockpit, /id="todoOverlay"/);
assert.match(cockpit, /id="subtaskAddForm"/);
assert.match(cockpit, /id="todoNotes"/);
assert.match(cockpit, /\/api\/todos\/.*\/subtasks/);

console.log('PASS To-dos: direktes Anlegen, Unterpunkte, Abhaken, Notizen und Cockpit-Bedienung.');
