import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ApplicationService } from '../dist/backend/applications.js';
import { DomainStore } from '../dist/backend/domains.js';
import { RouteAccessRequestStore, assertBasicAuthPassword, assertBasicAuthUsername } from '../dist/backend/route-access.js';

test('validates Basic Auth credentials without returning their values', () => {
  assert.doesNotThrow(() => assertBasicAuthUsername('michal.admin'));
  assert.throws(() => assertBasicAuthUsername('bad user'), /Username/);
  assert.throws(() => assertBasicAuthPassword('short'), /at least 8/);
});

test('credential requests persist lifecycle metadata without credential fields', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-route-access-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requests = new RouteAccessRequestStore(directory);

  const pending = await requests.create('app', 'route_one', 'setup');
  const completed = await requests.complete('app', pending.id);
  const persisted = await readFile(path.join(directory, 'app', 'route-access-requests.json'), 'utf8');

  assert.equal(completed.status, 'completed');
  assert.equal(persisted.includes('username'), false);
  assert.equal(persisted.includes('password'), false);
});

test('stores only a hash and exposes only safe route access metadata', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-route-access-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const domains = new DomainStore(directory);
  const [domain] = await domains.initialize('grafana', 'grafana.example.com');
  const docker = { listContainers: async () => [{ id: 'container', name: 'grafana', state: 'running', hostname: domain.hostname, ports: [{ host: 10001, protocol: 'tcp' }] }] };
  let syncedApplications;
  const caddy = { sync: async (applications) => { syncedApplications = applications; } };
  const requests = {
    get: async () => ({ id: 'authreq_one', routeId: domain.id, operation: 'setup', status: 'pending' }),
    complete: async () => ({ id: 'authreq_one', routeId: domain.id, operation: 'setup', status: 'completed' }),
  };
  const applications = new ApplicationService(docker, caddy, domains, {}, requests, async () => '$argon2id$stored-hash');

  const result = await applications.completeBasicAuthRequest(domain.id, 'authreq_one', 'michal', 'never-send-this');
  const inspection = await applications.inspectRouteAccess(domain.id);
  const listed = await applications.listDomains('grafana');
  const persisted = await readFile(path.join(directory, 'grafana', 'domains.json'), 'utf8');

  assert.deepEqual(result, { success: true, requestId: 'authreq_one', routeId: domain.id, access: 'basic_auth', username: 'michal', status: 'completed' });
  assert.deepEqual(inspection, { type: 'basic_auth', username: 'michal' });
  assert.equal(JSON.stringify(listed).includes('stored-hash'), false);
  assert.equal(persisted.includes('never-send-this'), false);
  assert.equal(persisted.includes('$argon2id$stored-hash'), true);
  assert.equal(syncedApplications[0].domains[0].access.passwordHash, '$argon2id$stored-hash');
});

test('restores public desired state when Caddy rejects protection', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-route-access-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const domains = new DomainStore(directory);
  const [domain] = await domains.initialize('app', 'app.example.com');
  const docker = { listContainers: async () => [{ id: 'container', name: 'app', state: 'running', hostname: domain.hostname, ports: [{ host: 10002, protocol: 'tcp' }] }] };
  const requests = { get: async () => ({ id: 'authreq_one', routeId: domain.id, operation: 'setup', status: 'pending' }) };
  const applications = new ApplicationService(docker, { sync: async () => { throw new Error('Caddy rejected candidate'); } }, domains, {}, requests, async () => '$argon2id$hash');

  await assert.rejects(
    applications.completeBasicAuthRequest(domain.id, 'authreq_one', 'user', 'long-enough'),
    /Caddy rejected candidate/,
  );
  assert.deepEqual((await domains.get('app'))[0].access, { type: 'public' });
});
