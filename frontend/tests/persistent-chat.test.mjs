import assert from 'node:assert/strict';
import test from 'node:test';
import { effectScope, ref } from 'vue';
import { savedConversationId, usePersistentChat } from '../src/persistent-chat.ts';

const id = 'conversation_00000000-0000-4000-8000-000000000001';
const user = { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Deploy an app' }] };
const snapshot = (overrides = {}) => ({
  id, title: 'Deploy an app', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  revision: 1, messages: [user], run: { id: 'run-1', status: 'running' }, ...overrides,
});
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

function fixture(t, handler) {
  const storage = new Map();
  globalThis.window = new EventTarget();
  window.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  };
  globalThis.document = new EventTarget();
  document.visibilityState = 'visible';
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const call = { url, ...options, body: options.body ? JSON.parse(options.body) : undefined };
    calls.push(call);
    return handler(call, calls.length);
  });
  const scope = effectScope();
  const activeId = ref('');
  const chat = scope.run(() => usePersistentChat(activeId, () => {}));
  t.after(() => {
    scope.stop();
    delete globalThis.window;
    delete globalThis.document;
  });
  return { chat, activeId, calls, scope, storage };
}

test('a refreshed view restores progress, then catches up on wake without resending the command', async (t) => {
  const completed = snapshot({ revision: 2, run: { id: 'run-1', status: 'completed' }, messages: [user, { id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: 'App deployed' }] }] });
  const { chat, calls } = fixture(t, () => json(completed));
  chat.activate(snapshot());
  assert.equal(chat.status.value, 'streaming');
  assert.equal(savedConversationId(), id);
  document.dispatchEvent(new Event('visibilitychange'));
  await tick();
  assert.equal(chat.messages.value.at(-1).parts[0].text, 'App deployed');
  assert.equal(chat.status.value, 'ready');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
});

test('a lost submission acknowledgement retries with the same request ID and creates no error message', async (t) => {
  const { chat, activeId, calls } = fixture(t, (call, count) => {
    if (count === 1) throw new TypeError('Network connection lost');
    return json(snapshot({ run: { id: call.body.requestId, status: 'completed' }, messages: call.body.messages }));
  });
  activeId.value = id;
  await chat.sendMessage({ text: 'Deploy an app' });
  assert.equal(chat.reconnecting.value, true);
  assert.equal(chat.error.value, undefined);
  assert.equal(chat.status.value, 'submitted');
  window.dispatchEvent(new Event('online'));
  await tick();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.requestId, calls[1].body.requestId);
  assert.equal(chat.messages.value.length, 1);
  assert.equal(chat.status.value, 'ready');
  assert.equal(chat.reconnecting.value, false);
});

test('connection loss during a run keeps it busy and recovers the latest server history', async (t) => {
  const { chat, calls } = fixture(t, (_call, count) => {
    if (count === 1) throw new TypeError('Offline');
    return json(snapshot({ revision: 2, run: { id: 'run-1', status: 'completed' } }));
  });
  chat.activate(snapshot());
  window.dispatchEvent(new Event('focus'));
  await tick();
  assert.equal(chat.status.value, 'streaming');
  assert.equal(chat.error.value, undefined);
  assert.equal(chat.reconnecting.value, true);
  window.dispatchEvent(new Event('online'));
  await tick();
  assert.equal(chat.status.value, 'ready');
  assert.ok(calls.every((call) => call.method === 'GET'));
});

test('switching conversations detaches without Stop and ignores an old in-flight snapshot', async (t) => {
  let resolve;
  const { chat, calls } = fixture(t, () => new Promise((complete) => { resolve = complete; }));
  chat.activate(snapshot());
  window.dispatchEvent(new Event('focus'));
  const secondId = 'conversation_00000000-0000-4000-8000-000000000002';
  chat.activate(snapshot({ id: secondId, messages: [], run: undefined }));
  resolve(json(snapshot({ revision: 5 })));
  await tick();
  assert.deepEqual(chat.messages.value, []);
  assert.equal(savedConversationId(), secondId);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
});

test('approval responses are persisted individually and only continue once every approval has an answer', async (t) => {
  const parts = ['1', '2'].map((number) => ({ type: 'tool-deleteApp', toolCallId: `call-${number}`, state: 'approval-requested', input: { appId: `app-${number}` }, approval: { id: `approval-${number}` } }));
  const { chat, calls } = fixture(t, (call) => json(snapshot({
    revision: calls.length + 1, messages: call.body.messages,
    run: { id: call.body.requestId ?? 'run-1', status: call.method === 'PUT' ? 'completed' : 'running' },
  })));
  chat.activate(snapshot({ messages: [user, { id: 'assistant-1', role: 'assistant', parts }], run: { id: 'run-1', status: 'completed' } }));
  await chat.addToolApprovalResponse({ id: 'approval-1', approved: true, reason: 'Approved' });
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].body.messages.at(-1).parts[0].state, 'approval-responded');
  await chat.addToolApprovalResponse({ id: 'approval-2', approved: false, reason: 'Dismissed' });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, '/api/chat');
  assert.equal(calls[1].body.messages.length, 2);
  assert.equal(calls[1].body.messages.at(-1).id, 'assistant-1');
  assert.equal(calls[1].body.messages.at(-1).parts[1].approval.approved, false);
});

test('Stop retries through network loss and targets the original run', async (t) => {
  const { chat, calls } = fixture(t, (call, count) => {
    if (count === 1) throw new TypeError('Offline');
    return json(snapshot({ run: { id: 'run-1', status: 'stopped' } }));
  });
  chat.activate(snapshot());
  await chat.stop();
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.url.endsWith('/stop') && call.body.requestId === 'run-1'));
  assert.equal(chat.status.value, 'ready');
  assert.equal(chat.reconnecting.value, false);
});

test('conflicting stale submissions reload server history instead of repeating an action', async (t) => {
  const latest = snapshot({ revision: 10, messages: [user], run: { id: 'other-run', status: 'running' } });
  const { chat, activeId, calls } = fixture(t, (call) => call.method === 'POST' ? json({ error: 'Conversation has changed' }, 409) : json(latest));
  activeId.value = id;
  await chat.sendMessage({ text: 'Stale request' });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].method, 'GET');
  assert.deepEqual(chat.messages.value, [user]);
  assert.equal(chat.status.value, 'streaming');
});

test('widget changes made during a save are queued and persisted with the next revision', async (t) => {
  let resolve;
  const { chat, calls } = fixture(t, (call, count) => {
    const value = snapshot({ revision: count + 1, run: undefined, messages: call.body.messages });
    return count === 1 ? new Promise((complete) => { resolve = () => complete(json(value)); }) : json(value);
  });
  chat.activate(snapshot({ run: undefined }));
  chat.messages.value[0].parts[0].text = 'First change';
  const first = chat.persistConversation();
  chat.messages.value[0].parts[0].text = 'Second change';
  const second = chat.persistConversation();
  resolve();
  await Promise.all([first, second]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.messages[0].parts[0].text, 'First change');
  assert.equal(calls[1].body.messages[0].parts[0].text, 'Second change');
  assert.equal(calls[1].body.revision, 2);
});

test('switching during a slow widget save still schedules recovery for the newly opened run', async (t) => {
  let resolve;
  const secondId = 'conversation_00000000-0000-4000-8000-000000000002';
  const second = snapshot({ id: secondId });
  const { chat, calls } = fixture(t, (call) => call.method === 'PUT'
    ? new Promise((complete) => { resolve = () => complete(json(snapshot({ revision: 2, run: undefined }))); })
    : json({ ...second, revision: 3, run: { id: 'run-1', status: 'completed' } }));
  chat.activate(snapshot({ run: undefined }));
  const saving = chat.persistConversation();
  chat.activate(second);
  await new Promise((complete) => setTimeout(complete, 800));
  resolve();
  await saving;
  await new Promise((complete) => setTimeout(complete, 800));
  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.includes(secondId));
  assert.equal(chat.status.value, 'ready');
});
