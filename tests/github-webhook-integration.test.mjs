import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { convertToModelMessages } from 'ai';
import express from 'express';
import ts from 'typescript';
import { sanitizeAgentMessages } from '../dist/backend/agent.js';
import { AppBusyError, ApplicationService } from '../dist/backend/applications.js';
import { AppStore } from '../dist/backend/apps.js';
import { ConversationStore } from '../dist/backend/conversations.js';
import { githubWebhookReceiver } from '../dist/backend/github-webhook-routes.js';
import { GitHubWebhookError, GitHubWebhookService } from '../dist/backend/github-webhooks.js';
import { RepositoryService } from '../dist/backend/repositories.js';

const commit = 'a'.repeat(40);
const nextCommit = 'b'.repeat(40);
const repository = { full_name: 'owner/project', id: 123 };
const sign = (secret, raw) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
const webhookError = (status) => (error) => error instanceof GitHubWebhookError && error.status === status;

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-webhook-integration-'));
  const previousHostname = process.env.HALFCLOUD_HOSTNAME;
  process.env.HALFCLOUD_HOSTNAME = 'control.example.com';
  const apps = new AppStore(directory);
  const app = await apps.create('Public GitHub App', {
    source: { type: 'git', url: 'https://github.com/Owner/Project.git', branch: 'release/Production', currentCommit: commit, resolvedCommit: commit },
  });
  const unexpected = t.mock.fn(() => { throw new Error('Unexpected external operation'); });
  t.mock.method(globalThis, 'fetch', unexpected);
  const repositories = new RepositoryService(apps, path.join(directory, 'repositories'), unexpected, unexpected);
  const image = `halfcloud/app-${app.id.slice(4).replaceAll('-', '')}:verified`;
  const recipe = {
    serviceId: 'service_web', image, imageId: `sha256:${'c'.repeat(64)}`, commit, healthPath: '/ready',
    recipe: { contextPath: '.', dockerfilePath: 'Dockerfile', dockerfileContent: 'FROM node:22\nCMD ["node", "server.mjs"]\n', dockerignoreContent: '.env\n' },
  };
  await repositories.saveServiceUpdates(app.id, [recipe]);
  const runtime = {
    services: [{ id: 'container_web', serviceId: recipe.serviceId, appId: app.id, name: 'web', image, state: 'running', ports: [] }],
    async listContainers() { return structuredClone(this.services); },
    deleteContainer: t.mock.fn(async (id) => { runtime.services = runtime.services.filter((service) => service.id !== id); }),
    deleteAppNetwork: t.mock.fn(async () => {}),
    buildImage: unexpected,
  };
  const applications = new ApplicationService(
    runtime, { sync: async () => {} }, { get: async () => [], withReadiness: async (domains) => domains },
    {}, {}, unexpected, apps, repositories,
  );
  let service;
  t.after(async () => {
    service?.stop();
    await service?.drain();
    if (previousHostname === undefined) delete process.env.HALFCLOUD_HOSTNAME;
    else process.env.HALFCLOUD_HOSTNAME = previousHostname;
    await rm(directory, { recursive: true, force: true });
  });
  const setup = async () => {
    service = applications.githubWebhooks;
    const setup = await applications.requestGitHubWebhookSetup(app.name);
    const { secret } = await service.getSecret(app.id, setup.hookId);
    return { setup, secret, service };
  };
  return { directory, apps, app, repositories, recipe, runtime, applications, setup, unexpected };
}

async function receiver(t, service) {
  const app = express();
  const resolveService = t.mock.fn(() => service);
  const auth = t.mock.fn((_request, response) => response.status(401).json({ error: 'Mock browser authentication required' }));
  app.use('/api/webhooks/github', githubWebhookReceiver(resolveService));
  app.use(express.json());
  app.use(auth);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const send = ({ hookId, raw = Buffer.alloc(0), method = 'POST', pathname = `/api/webhooks/github/${hookId}`, headers = [] }) => new Promise((resolve, reject) => {
    // An array preserves duplicate header lines, including different capitalization.
    const request = http.request({
      hostname: '127.0.0.1', port: server.address().port, method, path: pathname,
      headers: ['Host', '127.0.0.1', 'Connection', 'close', 'Content-Length', String(raw.length), ...headers],
      agent: false,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error('Local webhook request timed out')));
    request.end(raw);
  });
  return { send, auth, resolveService };
}

function delivery(setup, secret, raw, event = 'ping', id = 'delivery-1') {
  return {
    hookId: setup.hookId, raw,
    headers: ['Content-Type', 'application/json', 'X-Hub-Signature-256', sign(secret, raw), 'X-GitHub-Event', event, 'X-GitHub-Delivery', id],
  };
}

test('real HTTP ingress authenticates exact raw JSON without a cookie and dispatches only the saved branch', async (t) => {
  const f = await fixture(t);
  const { setup, secret, service } = await f.setup();
  const web = await receiver(t, service);
  const update = t.mock.method(f.applications, 'updateGitApp', async () => ({ commit: nextCommit, updated: true }));
  const raw = Buffer.from('{ "repository": {"full_name": "owner/project", "id": 123}, "zen": "ping" }\n');
  const result = await web.send(delivery(setup, secret, raw));
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.text), { verified: true });
  assert.equal(web.auth.mock.callCount(), 0);
  assert.equal(update.mock.callCount(), 0);
  await service.setEnabled(f.app.id, setup.hookId, true);
  const push = (ref) => Buffer.from(JSON.stringify({ repository, ref, deleted: false, after: 'd'.repeat(40), clone_url: 'https://untrusted.example/not-the-checkout' }));
  for (const [index, ref] of ['refs/heads/main', 'refs/heads/release/production', 'refs/tags/release/Production'].entries()) {
    const ignored = await web.send(delivery(setup, secret, push(ref), 'push', `ignored-${index}`));
    assert.equal(ignored.status, 200);
    assert.deepEqual(JSON.parse(ignored.text), { ignored: true });
  }
  const accepted = await web.send(delivery(setup, secret, push(`refs/heads/${setup.branch}`), 'push', 'accepted'));
  assert.equal(accepted.status, 202);
  assert.deepEqual(JSON.parse(accepted.text), { queued: true });
  assert.equal(update.mock.callCount(), 0, 'admission must not bypass startup recovery');
  await service.start();
  await service.drain();
  assert.equal(update.mock.callCount(), 1);
  assert.deepEqual(update.mock.calls[0].arguments, [f.app.id], 'never pass a payload URL, branch, SHA, or agent callback to the updater');
  assert.equal(update.mock.calls[0].this, f.applications);
  assert.equal((await f.applications.getGitHubWebhookSetup(f.app.name)).lastUpdate.commit, nextCommit);
  assert.equal(f.unexpected.mock.callCount(), 0);
});

test('HTTP receiver accepts GitHub push payloads larger than the ordinary API body limit', async (t) => {
  const f = await fixture(t);
  const { setup, secret, service } = await f.setup();
  const web = await receiver(t, service);
  const ping = Buffer.from(JSON.stringify({ repository }));
  await service.receive(setup.hookId, ping, sign(secret, ping), 'ping', 'verify');
  await service.setEnabled(f.app.id, setup.hookId, true);
  const raw = Buffer.from(JSON.stringify({ repository, ref: `refs/heads/${setup.branch}`, deleted: false, after: nextCommit, commits: [{ message: 'x'.repeat(2 * 1024 * 1024) }] }));
  assert.equal((await web.send(delivery(setup, secret, raw, 'push', 'large-push'))).status, 202);
  const journal = await readFile(path.join(f.directory, 'github-webhooks.json'), 'utf8');
  assert.ok(journal.length < 5000, 'never persist the GitHub payload');
  assert.equal(JSON.parse(journal).hooks[0].pending, true);
});

test('HTTP receiver rejects invalid bodies and signatures before changing the journal', async (t) => {
  const f = await fixture(t);
  const { setup, secret, service } = await f.setup();
  const web = await receiver(t, service);
  const before = await readFile(path.join(f.directory, 'github-webhooks.json'), 'utf8');
  const raw = Buffer.from('{ "repository": {"full_name":"owner/project","id":123} }\n');
  const malformed = Buffer.from('{not-json');
  const wrongSignature = delivery(setup, secret, raw);
  wrongSignature.headers[3] = sign('fixture-not-the-signing-secret', raw);
  const changedBytes = { ...delivery(setup, secret, raw), raw: Buffer.from(JSON.stringify(JSON.parse(raw))) };
  const wrongMalformed = { ...wrongSignature, raw: malformed };
  const wrongType = delivery(setup, secret, raw);
  wrongType.headers[1] = 'text/plain';
  const missingType = delivery(setup, secret, raw);
  missingType.headers.splice(0, 2);
  const compressed = delivery(setup, secret, gzipSync(raw));
  compressed.headers.push('Content-Encoding', 'gzip');
  const oversized = Buffer.from(JSON.stringify({ padding: 'x'.repeat(25 * 1024 * 1024) }));
  for (const [name, request, status] of [
    ['wrong signature', wrongSignature, 401],
    ['reserialized JSON', changedBytes, 401],
    ['unsigned malformed JSON', wrongMalformed, 401],
    ['signed malformed JSON', delivery(setup, secret, malformed), 400],
    ['signed non-object JSON', delivery(setup, secret, Buffer.from('[]')), 400],
    ['wrong content type', wrongType, 415],
    ['missing content type', missingType, 415],
    ['compressed body', compressed, 415],
    ['oversized body', delivery(setup, secret, oversized), 413],
  ]) await t.test(name, async () => {
    const response = await web.send(request);
    assert.equal(response.status, status);
    assert.equal(typeof JSON.parse(response.text).error, 'string');
    assert.equal(response.text.includes(secret), false);
    assert.equal(response.text.includes(sign(secret, request.raw)), false);
    assert.doesNotMatch(response.text, /not-json|padding|fixture-not-the-signing-secret/);
    assert.equal(await readFile(path.join(f.directory, 'github-webhooks.json'), 'utf8'), before);
  });
  assert.equal(web.auth.mock.callCount(), 0);
});

test('native HTTP duplicate and missing security headers are rejected, even with a browser cookie', async (t) => {
  const f = await fixture(t);
  const { setup, secret, service } = await f.setup();
  const web = await receiver(t, service);
  const raw = Buffer.from(JSON.stringify({ repository }));
  for (const name of ['X-Hub-Signature-256', 'X-GitHub-Event', 'X-GitHub-Delivery']) {
    for (const duplicate of [false, true]) await t.test(`${name}: ${duplicate ? 'duplicate' : 'missing'}`, async () => {
      const request = delivery(setup, secret, raw);
      const index = request.headers.indexOf(name);
      if (duplicate) request.headers.push(name.toLowerCase(), request.headers[index + 1]);
      else request.headers.splice(index, 2);
      request.headers.push('Cookie', 'halfcloud_session=fixture-browser-session');
      assert.equal((await web.send(request)).status, 400);
    });
  }
  assert.equal(web.resolveService.mock.callCount(), 0, 'invalid headers must not instantiate or call the service');
  assert.equal(web.auth.mock.callCount(), 0, 'browser authentication must not replace the signature check');
  assert.equal((await service.getSetup(f.app.id)).verified, false);
});

test('non-ingress methods and paths fall through to supplied browser authentication', async (t) => {
  const web = await receiver(t, {});
  for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    await t.test(method, async () => {
      const before = web.auth.mock.callCount();
      const response = await web.send({ hookId: 'f'.repeat(64), method });
      assert.equal(response.status, 401, method);
      if (method !== 'HEAD') assert.deepEqual(JSON.parse(response.text), { error: 'Mock browser authentication required' });
      assert.equal(web.auth.mock.callCount(), before + 1);
    });
  }
  for (const pathname of ['/api/webhooks/github', '/api/webhooks/github/id/extra', '/api/apps/app_one/github-webhook/secret']) {
    assert.equal((await web.send({ pathname, headers: ['Content-Type', 'application/json'], raw: Buffer.from('{}') })).status, 401);
  }
  assert.equal(web.resolveService.mock.callCount(), 0);
});

test('public GitHub URL metadata without provider supports lazy, persistent, name-resolved setup', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.apps.get(f.app.id)).source.provider, undefined);
  await assert.rejects(stat(path.join(f.directory, 'github-webhooks.json')), { code: 'ENOENT' });
  const { setup, secret, service } = await f.setup();
  assert.equal(f.applications.githubWebhooks, service);
  assert.deepEqual(await f.applications.requestGitHubWebhookSetup(f.app.id), setup);
  assert.deepEqual(await f.applications.getGitHubWebhookSetup(f.app.name), setup);
  assert.equal(setup.repository, 'owner/project');
  assert.equal(setup.branch, f.app.source.branch);
  assert.equal(setup.payloadUrl, `https://control.example.com/api/webhooks/github/${setup.hookId}`);
  assert.equal(setup.enabled, false);
  assert.equal(setup.verified, false);
  assert.equal(JSON.stringify(setup).includes(secret), false);
  assert.deepEqual(await f.repositories.getServiceUpdates(f.app.id), [f.recipe]);
  const journal = JSON.parse(await readFile(path.join(f.apps.dataDir, 'github-webhooks.json'), 'utf8'));
  assert.equal(journal.hooks[0].appId, f.app.id);
  assert.equal(journal.hooks[0].hookId, setup.hookId);
  await f.apps.renameApp(f.app.id, 'Renamed App');
  assert.deepEqual(await f.applications.getGitHubWebhookSetup('Renamed App'), setup);
});

test('setup requires configured GitHub metadata and verified recipes matching every repository Service', async (t) => {
  for (const change of ['missing recipe', 'missing deployed commit', 'stale recipe commit', 'wrong runtime image', 'missing runtime Service', 'unrecorded repository Service', 'missing branch', 'non-GitHub URL', 'non-Git App']) {
    await t.test(change, async (t) => {
      const f = await fixture(t);
      if (change === 'missing recipe') await f.repositories.saveServiceUpdates(f.app.id, []);
      if (change === 'missing deployed commit') await f.apps.update(f.app.id, { source: { ...f.app.source, currentCommit: undefined } });
      if (change === 'stale recipe commit') await f.repositories.saveServiceUpdates(f.app.id, [{ ...f.recipe, commit: nextCommit }]);
      if (change === 'wrong runtime image') f.runtime.services[0].image = 'node:22';
      if (change === 'missing runtime Service') f.runtime.services = [];
      if (change === 'unrecorded repository Service') f.runtime.services.push({ ...f.runtime.services[0], id: 'container_worker', serviceId: 'service_worker' });
      if (change === 'missing branch') await f.apps.update(f.app.id, { source: { ...f.app.source, branch: undefined } });
      if (change === 'non-GitHub URL') await f.apps.update(f.app.id, { source: { ...f.app.source, url: 'https://gitlab.com/owner/project' } });
      if (change === 'non-Git App') await f.apps.update(f.app.id, { source: undefined });
      await assert.rejects(f.setup(), webhookError(409));
      await assert.rejects(f.applications.getGitHubWebhookSetup(f.app.id), webhookError(404));
      assert.equal(f.unexpected.mock.callCount(), 0);
    });
  }
});

test('actual repository locks and typed AppBusyError defer the same deterministic update callback', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const { setup, secret, service } = await f.setup();
  const ping = Buffer.from(JSON.stringify({ repository }));
  await service.receive(setup.hookId, ping, sign(secret, ping), 'ping', 'verify');
  await service.setEnabled(f.app.id, setup.hookId, true);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.mock.method(f.repositories, 'writeDeploymentFile', async () => { entered.resolve(); await release.promise; });
  const operation = f.applications.writeRepositoryDeploymentFile(f.app.id, 'Dockerfile', 'FROM node:22');
  t.after(async () => { release.resolve(); await operation; });
  await entered.promise;
  let busyError;
  await assert.rejects(f.applications.updateGitApp(f.app.id), (error) => {
    busyError = error;
    return error instanceof AppBusyError && error.code === 'app_busy';
  });
  await assert.rejects(f.applications.requestGitHubWebhookSetup(f.app.id), (error) => error.status === 409 && error.code === 'app_busy');
  let defer = true;
  const update = t.mock.method(f.applications, 'updateGitApp', async () => {
    if (defer) { defer = false; throw busyError; }
    return { commit: nextCommit, updated: true };
  });
  const push = Buffer.from(JSON.stringify({ repository, ref: `refs/heads/${setup.branch}`, deleted: false, after: nextCommit }));
  await service.receive(setup.hookId, push, sign(secret, push), 'push', 'busy-push');
  await service.start();
  await service.drain();
  assert.equal(update.mock.callCount(), 0, 'the adapter must expose real operation locks');
  release.resolve();
  await operation;
  await service.drain();
  assert.equal(update.mock.callCount(), 1, 'typed busy errors must not trigger an immediate retry loop');
  assert.equal((await service.getSetup(f.app.id)).lastUpdate.status, 'queued');
  const journal = await readFile(path.join(f.directory, 'github-webhooks.json'), 'utf8');
  assert.equal(JSON.parse(journal).hooks[0].pending, true);
  assert.equal(journal.includes(busyError.message), false);
  await service.drain();
  assert.equal(update.mock.callCount(), 2);
  assert.ok(update.mock.calls.every((call) => call.arguments.length === 1 && call.arguments[0] === f.app.id));
  assert.equal((await service.getSetup(f.app.id)).lastUpdate.status, 'succeeded');
  assert.equal(f.unexpected.mock.callCount(), 0);
});

test('readiness snapshots share the repository gate so concurrent manual work cannot consume a push', async (t) => {
  const f = await fixture(t);
  const { setup, secret, service } = await f.setup();
  const ping = Buffer.from(JSON.stringify({ repository }));
  await service.receive(setup.hookId, ping, sign(secret, ping), 'ping', 'verify');
  await service.setEnabled(f.app.id, setup.hookId, true);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const getRecipes = f.repositories.getServiceUpdates.bind(f.repositories);
  t.mock.method(f.repositories, 'getServiceUpdates', async (...args) => {
    const recipes = await getRecipes(...args);
    entered.resolve();
    await release.promise;
    return recipes;
  });
  t.after(() => release.resolve());
  const update = t.mock.method(f.applications, 'updateGitApp', async () => ({ commit: nextCommit, updated: true }));
  const push = Buffer.from(JSON.stringify({ repository, ref: `refs/heads/${setup.branch}`, deleted: false, after: nextCommit }));
  await service.receive(setup.hookId, push, sign(secret, push), 'push', 'race-push');
  await service.start();
  const draining = service.drain();
  await entered.promise;
  await assert.rejects(f.applications.writeRepositoryDeploymentFile(f.app.id, 'Dockerfile', 'FROM scratch'), (error) => error instanceof AppBusyError);
  release.resolve();
  await draining;
  assert.equal(update.mock.callCount(), 1);
  assert.equal((await service.getSetup(f.app.id)).lastUpdate.status, 'succeeded');
});

test('deleting an App removes durable webhook configuration and pending work', async (t) => {
  const f = await fixture(t);
  const { setup, secret, service } = await f.setup();
  const ping = Buffer.from(JSON.stringify({ repository }));
  await service.receive(setup.hookId, ping, sign(secret, ping), 'ping', 'verify');
  await service.setEnabled(f.app.id, setup.hookId, true);
  const push = Buffer.from(JSON.stringify({ repository, ref: `refs/heads/${setup.branch}`, deleted: false, after: nextCommit }));
  await service.receive(setup.hookId, push, sign(secret, push), 'push', 'queued');
  const update = t.mock.method(f.applications, 'updateGitApp', async () => assert.fail('Deleted App must never dispatch'));
  assert.equal((await f.applications.deleteApp(f.app.name)).deleted, true);
  assert.equal(await service.getSetup(f.app.id), undefined);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.directory, 'github-webhooks.json'), 'utf8')).hooks, []);
  await assert.rejects(stat(path.join(f.directory, 'repositories', f.app.id)), { code: 'ENOENT' });
  assert.deepEqual(await f.apps.list(), []);
  assert.deepEqual(f.runtime.deleteContainer.mock.calls[0].arguments, ['container_web']);
  assert.deepEqual(f.runtime.deleteAppNetwork.mock.calls[0].arguments, [f.app.id]);
  await service.start();
  await service.drain();
  assert.equal(update.mock.callCount(), 0);
  const restarted = new GitHubWebhookService({}, f.directory, 'control.example.com');
  t.after(() => restarted.stop());
  await assert.rejects(restarted.receive(setup.hookId, push, sign(secret, push), 'push', 'after-delete'), webhookError(404));
});

test('server wiring keeps ingress before JSON, CSRF and auth while widget routes stay authenticated and uncached', async () => {
  // Importing server.ts would initialize auth, SQLite, and a rootless Docker runtime.
  const source = ts.createSourceFile('server.ts', await readFile(new URL('../backend/server.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const calls = [];
  const visit = (node) => { if (ts.isCallExpression(node)) calls.push(node); ts.forEachChild(node, visit); };
  visit(source);
  const named = (call, name) => call.expression.getText(source) === name;
  const text = (node) => node && ts.isStringLiteral(node) ? node.text : undefined;
  const ingress = calls.find((call) => named(call, 'app.use') && text(call.arguments[0]) === '/api/webhooks/github');
  assert.ok(ingress);
  const factory = ingress.arguments[1];
  assert.ok(ts.isCallExpression(factory) && named(factory, 'githubWebhookReceiver'));
  assert.ok(ts.isArrowFunction(factory.arguments[0]));
  assert.equal(factory.arguments[0].body.getText(source), 'docker.githubWebhooks');
  for (const name of ['express.json', 'cookieParser', 'auth.middleware']) {
    const middleware = calls.find((call) => named(call, name));
    assert.ok(middleware && ingress.pos < middleware.pos, name);
  }
  const apiGuards = calls.filter((call) => named(call, 'app.use') && text(call.arguments[0]) === '/api');
  assert.ok(apiGuards.length >= 2);
  assert.ok(apiGuards.every((guard) => ingress.pos < guard.pos));
  for (const [method, route] of [
    ['post', '/api/apps/:appId/github-webhook/setup'], ['get', '/api/apps/:appId/github-webhook'],
    ['post', '/api/apps/:appId/github-webhook/secret'], ['put', '/api/apps/:appId/github-webhook'],
    ['post', '/api/apps/:appId/github-webhook/rotate'],
  ]) {
    const endpoint = calls.find((call) => named(call, `app.${method}`) && text(call.arguments[0]) === route);
    assert.ok(endpoint, `${method} ${route}`);
    assert.ok(apiGuards.every((guard) => guard.pos < endpoint.pos));
    assert.ok(calls.some((call) => call.pos > endpoint.pos && call.end < endpoint.end
      && named(call, 'response.setHeader') && text(call.arguments[0]) === 'Cache-Control' && text(call.arguments[1]) === 'no-store'));
  }
  const recovery = calls.find((call) => named(call, 'docker.recoverUpdates'));
  const start = calls.find((call) => named(call, 'docker.githubWebhooks.start'));
  assert.ok(recovery && start && recovery.pos < start.pos);
});

test('webhook tool secrets are removed before provider replay and before SQLite JSON persistence', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-webhook-context-'));
  const store = new ConversationStore(directory);
  const database = new DatabaseSync(path.join(directory, 'halfcloud.sqlite'));
  t.after(async () => { database.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const secret = 'FIXTURE_ONLY_WEBHOOK_SECRET_NOT_A_CREDENTIAL';
  const safe = {
    kind: 'github-webhook', appId: 'app_fixture', hookId: 'a'.repeat(64), repository: 'owner/project', branch: 'release/Production',
    payloadUrl: `https://control.example.com/api/webhooks/github/${'a'.repeat(64)}`,
    settingsUrl: 'https://github.com/owner/project/settings/hooks', enabled: true, verified: true,
    lastDeliveryAt: '2026-09-07T00:00:00.000Z', lastEvent: 'push',
    lastUpdate: { status: 'succeeded', updatedAt: '2026-09-07T00:00:00.000Z', commit },
  };
  const parts = [];
  const expected = [];
  for (const toolName of ['requestGitHubWebhookSetup', 'getGitHubWebhookSetup']) {
    for (const dynamic of [false, true]) {
      for (const state of ['output-available', 'output-error']) {
        const identity = { type: dynamic ? 'dynamic-tool' : `tool-${toolName}`, ...(dynamic ? { toolName } : {}), toolCallId: `call-${parts.length}`, state };
        parts.push({
          ...identity, input: { appId: safe.appId, secret, enabled: true, rotate: true, nested: { secret } },
          ...(state === 'output-available' ? { output: { ...safe, secret, signature: secret, deliveries: [{ secret }], lastUpdate: { ...safe.lastUpdate, logs: secret } } } : {}),
          secret, rawInput: secret, errorText: secret, providerMetadata: { secret }, callProviderMetadata: { secret }, resultProviderMetadata: { secret },
        });
        expected.push({ ...identity, input: { appId: safe.appId }, ...(state === 'output-available' ? { output: safe } : { errorText: 'GitHub webhook setup could not be completed' }) });
      }
    }
  }
  const unrelated = { type: 'text', text: 'Complete setup in the trusted widget.' };
  const messages = [
    { id: 'user', role: 'user', parts: [{ type: 'text', text: 'Enable automatic updates' }] },
    { id: 'assistant', role: 'assistant', metadata: { tokenUsage: { input: 10, output: 20 } }, parts: [...parts, unrelated] },
  ];
  const original = structuredClone(messages);
  const sanitized = sanitizeAgentMessages(messages);
  assert.deepEqual(sanitized[1].parts, [...expected, unrelated]);
  assert.deepEqual(sanitized[1].metadata, messages[1].metadata);
  const replay = await convertToModelMessages(sanitized);
  assert.equal(JSON.stringify(replay).includes(secret), false);
  assert.ok(JSON.stringify(replay).includes(safe.payloadUrl));
  const id = 'conversation_webhook_fixture';
  assert.deepEqual(store.save(id, messages).messages, sanitized);
  const persisted = database.prepare('SELECT messages_json FROM conversations WHERE id = ?').get(id).messages_json;
  assert.equal(persisted.includes(secret), false, 'check the stored JSON, not just a sanitized getter');
  assert.deepEqual(JSON.parse(persisted), sanitized);
  // Simulate an older row written before the storage boundary was introduced.
  database.prepare('UPDATE conversations SET messages_json = ? WHERE id = ?').run(JSON.stringify(messages), id);
  assert.deepEqual(store.get(id).messages, sanitized);
  store.save(id, store.get(id).messages);
  assert.equal(database.prepare('SELECT messages_json FROM conversations WHERE id = ?').get(id).messages_json.includes(secret), false);
  assert.deepEqual(messages, original, 'sanitizing must not mutate caller-owned messages');
});

test('webhook context drops invalid outputs and incomplete calls rather than replaying injected error details', () => {
  const secret = 'FIXTURE_ONLY_INJECTED_WEBHOOK_ERROR';
  const messages = [{ id: 'assistant', role: 'assistant', parts: [
    { type: 'tool-requestGitHubWebhookSetup', toolCallId: 'invalid', state: 'output-available', input: { appId: 'app_fixture', secret }, output: { secret }, errorText: secret },
    { type: 'dynamic-tool', toolName: 'getGitHubWebhookSetup', toolCallId: 'pending', state: 'input-available', input: { appId: 'app_fixture', secret } },
  ] }];
  assert.deepEqual(sanitizeAgentMessages(messages)[0].parts, [
    { type: 'tool-requestGitHubWebhookSetup', toolCallId: 'invalid', state: 'output-available', input: { appId: 'app_fixture' } },
  ]);
});
