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

test('environment requests preserve and deduplicate the complete target set', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-environment-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new EnvironmentStore(directory);
  const additionalTargets = [{ serviceId: 'service_web', name: 'database__connection__password' }];

  const first = await store.createRequest('service_mysql', 'MYSQL_PASSWORD', 'Shared password', additionalTargets, 'app_ghost');
  const duplicate = await store.createRequest('service_mysql', 'MYSQL_PASSWORD', 'Another description', additionalTargets, 'app_ghost');
  const different = await store.createRequest('service_mysql', 'MYSQL_PASSWORD', undefined, [], 'app_ghost');

  assert.equal(duplicate.id, first.id);
  assert.notEqual(different.id, first.id);
  assert.deepEqual(first.targets, [
    { serviceId: 'service_mysql', name: 'MYSQL_PASSWORD' },
    { serviceId: 'service_web', name: 'database__connection__password' },
  ]);
  assert.equal('value' in first, false);
});

test('one protected request applies the same value to multiple Services', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-environment-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new EnvironmentStore(directory);
  const environments = new Map([
    ['service_mysql', { MYSQL_DATABASE: 'ghost' }],
    ['service_web', { database__connection__host: 'mysql' }],
  ]);
  const services = [
    { id: 'container_mysql', serviceId: 'service_mysql', appId: 'app_ghost', runtimeName: 'mysql-runtime', name: 'mysql', ports: [] },
    { id: 'container_web', serviceId: 'service_web', appId: 'app_ghost', runtimeName: 'web-runtime', name: 'web', ports: [] },
  ];
  const replacements = [];
  const docker = {
    listContainers: async () => services,
    getContainerEnvironment: async (id) => ({ containerId: id, name: id, environment: environments.get(id) ?? {} }),
    replaceContainerEnvironment: async (id, environment) => {
      replacements.push({ id, environment });
      environments.set(id, environment);
      return { containerId: id };
    },
  };
  const applications = new ApplicationService(docker, { sync: async () => undefined }, { get: async () => [] }, store);

  const request = await applications.requestEnvironmentVariable(
    'service_mysql',
    'MYSQL_PASSWORD',
    'Shared database password',
    [{ serviceId: 'service_web', name: 'database__connection__password' }],
  );
  const completed = await applications.completeEnvironmentRequest('service_mysql', request.requestId, 'same-secret');

  assert.equal(replacements.length, 2);
  assert.equal(environments.get('service_mysql').MYSQL_PASSWORD, 'same-secret');
  assert.equal(environments.get('service_web').database__connection__password, 'same-secret');
  assert.equal((await store.list('service_mysql')).find((variable) => variable.name === 'MYSQL_PASSWORD').protectedFromAI, true);
  assert.equal((await store.list('service_web')).find((variable) => variable.name === 'database__connection__password').protectedFromAI, true);
  assert.deepEqual(completed.targets, [
    { serviceId: 'service_mysql', name: 'MYSQL_PASSWORD', configured: true },
    { serviceId: 'service_web', name: 'database__connection__password', configured: true },
  ]);
  assert.equal(JSON.stringify(completed).includes('same-secret'), false);
});

test('generated environment secrets are protected and never returned to the agent', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-environment-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new EnvironmentStore(directory);
  const environments = new Map([['service_web', {}]]);
  const services = [{ id: 'container_web', serviceId: 'service_web', appId: 'app_web', runtimeName: 'web-runtime', name: 'web', ports: [] }];
  const docker = {
    listContainers: async () => services,
    getContainerEnvironment: async (id) => ({ containerId: id, name: id, environment: environments.get(id) ?? {} }),
    replaceContainerEnvironment: async (id, environment) => { environments.set(id, environment); return { containerId: id }; },
  };
  const applications = new ApplicationService(docker, { sync: async () => undefined }, { get: async () => [] }, store);

  const result = await applications.generateEnvironmentSecret('service_web', 'APP_SECRET', [], 32);
  const generated = environments.get('service_web').APP_SECRET;

  assert.equal(typeof generated, 'string');
  assert.ok(generated.length >= 40);
  assert.equal((await store.list('service_web')).find((variable) => variable.name === 'APP_SECRET').protectedFromAI, true);
  assert.equal(JSON.stringify(result).includes(generated), false);
  assert.match(result.valueLocation, /Environment table.*Show/);
});

test('generated environment secrets preserve existing values unless replacement is explicit', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-environment-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new EnvironmentStore(directory);
  const environments = new Map([['service_web', { ADMIN_PASSWORD: 'existing-password' }]]);
  const services = [{ id: 'container_web', serviceId: 'service_web', appId: 'app_web', runtimeName: 'web-runtime', name: 'web', ports: [] }];
  const docker = {
    listContainers: async () => services,
    getContainerEnvironment: async (id) => ({ containerId: id, name: id, environment: environments.get(id) ?? {} }),
    replaceContainerEnvironment: async (id, environment) => { environments.set(id, environment); return { containerId: id }; },
  };
  const applications = new ApplicationService(docker, { sync: async () => undefined }, { get: async () => [] }, store);

  await assert.rejects(
    applications.generateEnvironmentSecret('service_web', 'ADMIN_PASSWORD'),
    /Environment table.*Show.*explicitly requests a new value/,
  );
  assert.equal(environments.get('service_web').ADMIN_PASSWORD, 'existing-password');

  await applications.generateEnvironmentSecret('service_web', 'ADMIN_PASSWORD', [], 32, true);
  assert.notEqual(environments.get('service_web').ADMIN_PASSWORD, 'existing-password');
});

test('shared environment requests reject targets outside the App', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-environment-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new EnvironmentStore(directory);
  const services = [
    { id: 'container_mysql', serviceId: 'service_mysql', appId: 'app_ghost', runtimeName: 'mysql-runtime', name: 'mysql', ports: [] },
    { id: 'container_other', serviceId: 'service_other', appId: 'app_other', runtimeName: 'other-runtime', name: 'other', ports: [] },
  ];
  const applications = new ApplicationService({ listContainers: async () => services }, {}, {}, store);

  await assert.rejects(
    applications.requestEnvironmentVariable('service_mysql', 'MYSQL_PASSWORD', undefined, [{ serviceId: 'service_other', name: 'PASSWORD' }]),
    /same App/,
  );
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
      { type: 'tool-createApp', input: { name: 'WordPress', services: [{ name: 'mysql', image: 'mysql:8', ports: {}, environment: { MYSQL_PASSWORD: 'never-send-this' } }] } },
      { type: 'tool-addService', input: { appId: 'app_one', service: { name: 'redis', image: 'redis', ports: {}, environment: { PASSWORD: 'never-send-this' } } } },
      { type: 'text', text: 'Deployment complete.' },
    ],
  }];

  const sanitized = sanitizeAgentMessages(messages);

  assert.equal(JSON.stringify(sanitized).includes('never-send-this'), false);
  assert.equal(sanitized[0].parts.some((part) => part.type === 'tool-setEnvironmentVariable'), false);
  assert.equal('environment' in sanitized[0].parts.find((part) => part.type === 'tool-createApplication').input, false);
  assert.equal('environment' in sanitized[0].parts.find((part) => part.type === 'tool-createApp').input.services[0], false);
  assert.equal('environment' in sanitized[0].parts.find((part) => part.type === 'tool-addService').input.service, false);
  assert.equal(sanitized[0].parts.find((part) => part.type === 'text').text, 'Deployment complete.');
});

test('provider-bound history strips credentials from Basic Auth widget records', () => {
  const messages = [{
    id: 'message',
    role: 'assistant',
    parts: [{
      type: 'tool-requestBasicAuthSetup',
      input: { routeId: 'route_one', password: 'never-send-this' },
      output: { requestId: 'authreq_one', routeId: 'route_one', status: 'completed', username: 'michal', password: 'never-send-this', passwordHash: '$argon2id$secret' },
    }],
  }];

  const sanitized = sanitizeAgentMessages(messages);
  const serialized = JSON.stringify(sanitized);
  assert.equal(serialized.includes('never-send-this'), false);
  assert.equal(serialized.includes('$argon2id$secret'), false);
  assert.deepEqual(sanitized[0].parts[0].input, { routeId: 'route_one' });
  assert.equal(sanitized[0].parts[0].output.username, 'michal');
});

test('provider-bound history strips injected values from environment request records', () => {
  const messages = [{
    id: 'message',
    role: 'assistant',
    parts: [{
      type: 'tool-requestEnvironmentVariable',
      input: {
        serviceId: 'service_mysql',
        name: 'MYSQL_PASSWORD',
        value: 'never-send-this',
        additionalTargets: [{ serviceId: 'service_web', name: 'database__connection__password', value: 'never-send-this' }],
      },
      output: {
        requestId: 'envreq_one',
        serviceId: 'service_mysql',
        name: 'MYSQL_PASSWORD',
        targets: [{ serviceId: 'service_mysql', name: 'MYSQL_PASSWORD', value: 'never-send-this' }],
        status: 'completed',
        value: 'never-send-this',
      },
    }],
  }];

  const sanitized = sanitizeAgentMessages(messages);
  const serialized = JSON.stringify(sanitized);
  assert.equal(serialized.includes('never-send-this'), false);
  assert.deepEqual(sanitized[0].parts[0].input.additionalTargets, [
    { serviceId: 'service_web', name: 'database__connection__password' },
  ]);
  assert.deepEqual(sanitized[0].parts[0].output.targets, [
    { serviceId: 'service_mysql', name: 'MYSQL_PASSWORD' },
  ]);
});

test('provider-bound repository setup history never includes private key fields', () => {
  const messages = [{
    id: 'message',
    role: 'assistant',
    parts: [{
      type: 'tool-createGitApp',
      input: { name: 'Private App', repositoryUrl: 'https://github.com/example/private-app', privateKey: 'never-send-this' },
      output: {
        appId: 'app_one',
        privateKey: 'never-send-this',
        repositorySetup: {
          appId: 'app_one',
          status: 'pending',
          repository: 'example/private-app',
          settingsUrl: 'https://github.com/example/private-app/settings/keys',
          publicKey: 'ssh-ed25519 public',
          privateKey: 'never-send-this',
        },
      },
    }],
  }];

  const sanitized = sanitizeAgentMessages(messages);
  const serialized = JSON.stringify(sanitized);
  assert.equal(serialized.includes('never-send-this'), false);
  assert.equal(sanitized[0].parts[0].output.repositorySetup.publicKey, 'ssh-ed25519 public');
});
