import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ChatConflictError, ChatRuns } from '../dist/backend/chat-runs.js';
import { ConversationStore } from '../dist/backend/conversations.js';

const user = (text = 'Deploy my app') => ({ id: randomUUID(), role: 'user', parts: [{ type: 'text', text }] });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  for (let index = 0; index < 200; index++) {
    if (check()) return;
    await pause(5);
  }
  assert.fail('Background run did not reach expected state');
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-chat-'));
  const store = new ConversationStore(directory);
  const runs = new ChatRuns(store);
  const streams = [];
  const factory = t.mock.fn(async (_messages, signal) => {
    let writer;
    const stream = new ReadableStream({ start(controller) { writer = controller; } });
    const control = {
      signal,
      write: (chunk) => writer.enqueue(chunk),
      finish() { writer.enqueue({ type: 'finish' }); writer.close(); this.closed = true; },
      closed: false,
    };
    signal.addEventListener('abort', () => {
      if (!control.closed) { writer.enqueue({ type: 'abort' }); writer.close(); control.closed = true; }
    }, { once: true });
    streams.push(control);
    return stream;
  });
  t.after(async () => {
    for (const stream of streams) if (!stream.closed) stream.finish();
    await pause(20);
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const id = `conversation_${randomUUID()}`;
  const requestId = randomUUID();
  const start = (messages = [user()]) => runs.start(id, requestId, messages, -1, factory);
  return { store, runs, factory, streams, id, requestId, start };
}

test('continues without a connected client, persists partial progress, and reloads its completed result', async (t) => {
  const { store, runs, streams, id, start } = await fixture(t);
  const accepted = start();
  assert.equal(accepted.run.status, 'running');
  assert.equal(store.get(id).messages.length, 1);
  const stream = streams[0];
  stream.write({ type: 'start', messageId: 'assistant-1' });
  stream.write({ type: 'text-start', id: 'text-1' });
  stream.write({ type: 'text-delta', id: 'text-1', delta: 'Deploying' });
  // No snapshot reads or browser save calls while the agent is working.
  await until(() => store.get(id).messages.at(-1)?.parts[0]?.text === 'Deploying');
  assert.equal(stream.signal.aborted, false);
  stream.write({ type: 'text-delta', id: 'text-1', delta: ' complete.' });
  stream.write({ type: 'text-end', id: 'text-1' });
  stream.finish();
  await until(() => runs.get(id).run.status === 'completed');
  const reloaded = runs.get(id);
  assert.equal(reloaded.messages.at(-1).parts[0].text, 'Deploying complete.');
  assert.deepEqual(reloaded.messages, store.get(id).messages);
  assert.ok(reloaded.revision > accepted.revision);
});

test('retries are idempotent and stale browser writes cannot overwrite active or completed progress', async (t) => {
  const { runs, factory, streams, id, requestId, start } = await fixture(t);
  const accepted = start();
  const retry = runs.start(id, requestId, [user('Retry')], -1, factory);
  assert.equal(factory.mock.callCount(), 1);
  assert.deepEqual(retry.messages, accepted.messages);
  assert.throws(() => runs.start(id, randomUUID(), accepted.messages, accepted.revision, factory), ChatConflictError);
  assert.throws(() => runs.save(id, accepted.messages, accepted.revision), ChatConflictError);
  streams[0].write({ type: 'start', messageId: 'assistant-1' });
  streams[0].write({ type: 'tool-input-available', toolCallId: 'call-1', toolName: 'createApp', input: { name: 'App' } });
  streams[0].write({ type: 'tool-output-available', toolCallId: 'call-1', output: { appId: 'app-1' } });
  streams[0].finish();
  await until(() => runs.get(id).run.status === 'completed');
  assert.throws(() => runs.save(id, accepted.messages, accepted.revision), ChatConflictError);
  runs.start(id, requestId, accepted.messages, -1, factory);
  assert.equal(factory.mock.callCount(), 1);
  assert.equal(runs.get(id).messages.at(-1).parts[0].output.appId, 'app-1');
});

test('approval requests survive reload and continue the same assistant message without repeating results', async (t) => {
  const { runs, factory, streams, id, start } = await fixture(t);
  start();
  streams[0].write({ type: 'start', messageId: 'assistant-approval' });
  streams[0].write({ type: 'tool-input-available', toolCallId: 'call-1', toolName: 'deleteApp', input: { appId: 'app-1' } });
  streams[0].write({ type: 'tool-approval-request', approvalId: 'approval-1', toolCallId: 'call-1' });
  streams[0].finish();
  await until(() => runs.get(id).run.status === 'completed');
  const restored = structuredClone(runs.get(id));
  const part = restored.messages.at(-1).parts[0];
  assert.equal(part.state, 'approval-requested');
  assert.equal(part.approval.id, 'approval-1');
  part.state = 'approval-responded';
  part.approval.approved = true;
  runs.start(id, randomUUID(), restored.messages, restored.revision, factory);
  streams[1].write({ type: 'start', messageId: 'assistant-approval' });
  streams[1].write({ type: 'tool-output-available', toolCallId: 'call-1', output: { deleted: true } });
  streams[1].finish();
  await until(() => runs.get(id).run.status === 'completed');
  const completed = runs.get(id);
  assert.equal(completed.messages.length, 2);
  assert.equal(completed.messages.at(-1).id, 'assistant-approval');
  assert.equal(completed.messages.at(-1).parts.length, 1);
  assert.equal(completed.messages.at(-1).parts[0].state, 'output-available');
});

test('explicit Stop cancels only the targeted run and preserves its partial response', async (t) => {
  const { runs, streams, id, requestId, start, factory } = await fixture(t);
  start();
  streams[0].write({ type: 'start', messageId: 'assistant-1' });
  streams[0].write({ type: 'text-start', id: 'text-1' });
  streams[0].write({ type: 'text-delta', id: 'text-1', delta: 'Partial response' });
  await until(() => runs.get(id).messages.length === 2);
  runs.stop(id, requestId);
  await until(() => runs.get(id).run.status === 'stopped');
  const stopped = runs.get(id);
  assert.equal(stopped.messages.at(-1).parts[0].text, 'Partial response');
  runs.start(id, randomUUID(), [...stopped.messages, user('Continue')], stopped.revision, factory);
  runs.stop(id, requestId);
  assert.equal(streams[1].signal.aborted, false);
  assert.equal(runs.get(id).run.status, 'running');
});

test('provider error details and token usage remain available after reconnect', async (t) => {
  const { runs, streams, id, start } = await fixture(t);
  start();
  streams[0].write({ type: 'start', messageId: 'assistant-1' });
  streams[0].write({ type: 'message-metadata', messageMetadata: { tokenUsage: { input: 10, output: 5 } } });
  streams[0].write({ type: 'data-agentError', transient: true, data: { requestId: 'error-1', provider: 'openai', model: 'example', details: 'Rate limited' } });
  streams[0].write({ type: 'error', errorText: 'AI provider request failed' });
  streams[0].finish();
  await until(() => runs.get(id).run.status === 'error');
  const restored = runs.get(id);
  assert.equal(restored.run.error, 'AI provider request failed');
  assert.equal(restored.run.agentError.details, 'Rate limited');
  assert.equal(restored.messages.at(-1).metadata.tokenUsage.output, 5);
});

test('a full history still leaves room to persist the new assistant response', async (t) => {
  const { store, runs, streams, id, start } = await fixture(t);
  start(Array.from({ length: 100 }, (_, index) => user(`Message ${index}`)));
  streams[0].write({ type: 'start', messageId: 'assistant-1' });
  streams[0].write({ type: 'text-start', id: 'text-1' });
  streams[0].write({ type: 'text-delta', id: 'text-1', delta: 'Done' });
  streams[0].write({ type: 'text-end', id: 'text-1' });
  streams[0].finish();
  await until(() => runs.get(id).run.status === 'completed');
  assert.equal(store.get(id).messages.length, 101);
  assert.equal(store.get(id).messages[0].parts[0].text, 'Message 0');
  assert.equal(store.get(id).messages.at(-1).parts[0].text, 'Done');
});
