import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ConversationStore } from '../dist/backend/conversations.js';

function userMessage(id, text) {
  return { id, role: 'user', parts: [{ type: 'text', text }] };
}

test('round-trips complete structured UI messages', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-conversations-'));
  const store = new ConversationStore(directory);
  t.after(() => {
    store.close();
    return rm(directory, { recursive: true, force: true });
  });
  const messages = [
    userMessage('user-1', 'Deploy this GitHub repository and run it behind my domain'),
    {
      id: 'assistant-1',
      role: 'assistant',
      metadata: { tokenUsage: { input: 10, output: 5 } },
      parts: [{
        type: 'tool-createApp',
        toolCallId: 'call-1',
        state: 'output-available',
        input: { name: 'Example' },
        output: { appId: 'app-1', status: 'running' },
      }],
    },
  ];

  const saved = store.save('conversation_00000000-0000-0000-0000-000000000001', messages);
  assert.equal(saved.title, 'Deploy this GitHub repository and run it behind my domain');
  assert.deepEqual(saved.messages, messages);
  assert.deepEqual(store.get(saved.id)?.messages, messages);
});

test('orders conversations by latest activity and updates derived titles', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-conversations-'));
  const store = new ConversationStore(directory);
  t.after(() => {
    store.close();
    return rm(directory, { recursive: true, force: true });
  });
  const firstId = 'conversation_00000000-0000-0000-0000-000000000001';
  const secondId = 'conversation_00000000-0000-0000-0000-000000000002';
  store.save(firstId, [userMessage('user-1', 'First conversation')]);
  await new Promise((resolve) => setTimeout(resolve, 2));
  store.save(secondId, [userMessage('user-2', 'Second conversation')]);
  assert.deepEqual(store.list().map(({ id }) => id), [secondId, firstId]);

  await new Promise((resolve) => setTimeout(resolve, 2));
  store.save(firstId, [userMessage('user-1', 'First conversation'), userMessage('user-3', 'Continue')]);
  assert.deepEqual(store.list().map(({ id }) => id), [firstId, secondId]);
});

test('does not create empty conversations', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-conversations-'));
  const store = new ConversationStore(directory);
  t.after(() => {
    store.close();
    return rm(directory, { recursive: true, force: true });
  });

  assert.throws(() => store.save('conversation_00000000-0000-0000-0000-000000000001', []));
  assert.deepEqual(store.list(), []);
});
