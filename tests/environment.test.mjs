import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ApplicationService } from '../dist/backend/applications.js';
import { sanitizeAgentMessages } from '../dist/backend/agent.js';
import { EnvironmentStore, serializeEnvironmentForAgent } from '../dist/backend/environment.js';

test('newly discovered environment variables default to AI protection', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-environment-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new EnvironmentStore(directory);

  const variables = await store.list('n8n', { N8N_ENCRYPTION_KEY: 'never-send-this' });

  assert.equal(variables.length, 1);
  assert.equal(variables[0].protectedFromAI, true);
  assert.equal(variables[0].value, 'never-send-this');
  assert.deepEqual(await store.list('n8n'), variables);
});

test('agent serialization omits protected values instead of masking them', () => {
  const now = new Date().toISOString();
  const serialized = serializeEnvironmentForAgent([
    { id: 'one', serviceId: 'app', name: 'NODE_ENV', value: 'production', protectedFromAI: false, createdAt: now, updatedAt: now },
    { id: 'two', serviceId: 'app', name: 'API_TOKEN', value: 'never-send-this', protectedFromAI: true, createdAt: now, updatedAt: now },
  ]);

  assert.deepEqual(serialized, [
    { name: 'NODE_ENV', value: 'production', protectedFromAI: false },
    { name: 'API_TOKEN', configured: true, protectedFromAI: true },
  ]);
  assert.equal('value' in serialized[1], false);
  assert.equal(JSON.stringify(serialized).includes('never-send-this'), false);
});

test('environment requests persist lifecycle status without a value field', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-environment-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new EnvironmentStore(directory);

  const pending = await store.createRequest('n8n', 'N8N_ENCRYPTION_KEY', 'Encrypts credentials');
  const completed = await store.setRequestStatus('n8n', pending.id, 'completed');

  assert.equal(pending.status, 'pending');
  assert.equal(completed.status, 'completed');
  assert.equal('value' in completed, false);
});

test('the agent cannot overwrite a protected environment variable', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-environment-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new EnvironmentStore(directory);
  await store.list('payments', { STRIPE_SECRET_KEY: 'never-send-this' });
  let replaced = false;
  const docker = {
    getContainerEnvironment: async () => ({ containerId: 'container', name: 'payments', environment: { STRIPE_SECRET_KEY: 'never-send-this' } }),
    replaceContainerEnvironment: async () => { replaced = true; },
  };
  const applications = new ApplicationService(docker, {}, {}, store);

  await assert.rejects(
    applications.setEnvironmentVariableForAgent('payments', 'STRIPE_SECRET_KEY', 'replacement'),
    /protected from AI/,
  );
  assert.equal(replaced, false);
});

test('bulk environment edits, additions, and deletions use one container recreation', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-environment-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new EnvironmentStore(directory);
  const original = await store.list('app', { FIRST: 'one', SECOND: 'two' });
  const replacements = [];
  const docker = {
    getContainerEnvironment: async () => ({ containerId: 'container', name: 'app', environment: { FIRST: 'one', SECOND: 'two' } }),
    replaceContainerEnvironment: async (_id, environment) => { replacements.push(environment); return { containerId: 'replacement' }; },
    listContainers: async () => [],
  };
  const applications = new ApplicationService(docker, { sync: async () => undefined }, {}, store);

  const result = await applications.saveEnvironmentVariables('app', [
    { id: original[0].id, name: 'FIRST_RENAMED', value: 'updated', protectedFromAI: false },
    { name: 'THIRD', value: 'three', protectedFromAI: true },
  ]);

  assert.deepEqual(replacements, [{ FIRST_RENAMED: 'updated', THIRD: 'three' }]);
  assert.deepEqual(result.variables.map(({ name, value, protectedFromAI }) => ({ name, value, protectedFromAI })), [
    { name: 'FIRST_RENAMED', value: 'updated', protectedFromAI: false },
    { name: 'THIRD', value: 'three', protectedFromAI: true },
  ]);
});

test('provider-bound history excludes environment mutation values', () => {
  const messages = [{
    id: 'message',
    role: 'assistant',
    parts: [
      { type: 'tool-setEnvironmentVariable', input: { serviceId: 'app', name: 'TOKEN', value: 'never-send-this' }, output: { configured: true } },
      { type: 'tool-createApplication', input: { name: 'app', image: 'image', ports: {}, environment: { TOKEN: 'never-send-this' } } },
      { type: 'text', text: 'Deployment complete.' },
    ],
  }];

  const sanitized = sanitizeAgentMessages(messages);

  assert.equal(JSON.stringify(sanitized).includes('never-send-this'), false);
  assert.equal(sanitized[0].parts.some((part) => part.type === 'tool-setEnvironmentVariable'), false);
  assert.equal('environment' in sanitized[0].parts.find((part) => part.type === 'tool-createApplication').input, false);
  assert.equal(sanitized[0].parts.find((part) => part.type === 'text').text, 'Deployment complete.');
});
