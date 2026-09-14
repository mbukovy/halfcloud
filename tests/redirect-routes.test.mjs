import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ApplicationService } from '../dist/backend/applications.js';
import { RedirectStore } from '../dist/backend/redirects.js';

function serviceWith(redirects, docker, caddy, domains = { async get() { return []; } }) {
  return new ApplicationService(
    docker,
    caddy,
    domains,
    {},
    {},
    async () => 'hash',
    {},
    {},
    redirects,
  );
}

test('applies independent redirects through the normal Caddy sync', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-redirect-routes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const redirects = new RedirectStore(directory);
  let synced;
  const applications = serviceWith(
    redirects,
    { async listContainers() { return []; } },
    { async sync(apps, routes) { synced = { apps, routes }; } },
  );

  const redirect = await applications.addRedirect('taisen.mbukovy.eu', 'taisen.fun');

  assert.deepEqual(synced, { apps: [], routes: [redirect] });
  assert.deepEqual(await applications.listRedirects(), [redirect]);
});

test('rejects redirect hostnames already assigned to a service', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-redirect-routes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const redirects = new RedirectStore(directory);
  const docker = { async listContainers() { return [{ name: 'web', serviceId: 'service_web' }]; } };
  const domains = { async get() { return [{ hostname: 'used.example.com' }]; } };
  const applications = serviceWith(redirects, docker, { async sync() {} }, domains);

  await assert.rejects(applications.addRedirect('used.example.com', 'new.example.com'), /already attached/);
  assert.deepEqual(await redirects.list(), []);
});

test('rolls redirect storage back when Caddy rejects a change', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-redirect-routes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const redirects = new RedirectStore(directory);
  const applications = serviceWith(
    redirects,
    { async listContainers() { return []; } },
    { async sync() { throw new Error('Caddy rejected candidate'); } },
  );

  await assert.rejects(applications.addRedirect('old.example.com', 'new.example.com'), /Caddy rejected/);
  assert.deepEqual(await redirects.list(), []);
});

test('restores the same redirect record when Caddy rejects removal', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-redirect-routes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const redirects = new RedirectStore(directory);
  const redirect = await redirects.add('old.example.com', 'new.example.com');
  const applications = serviceWith(
    redirects,
    { async listContainers() { return []; } },
    { async sync() { throw new Error('Caddy rejected candidate'); } },
  );

  await assert.rejects(applications.removeRedirect('old.example.com'), /Caddy rejected/);
  assert.deepEqual(await redirects.list(), [redirect]);
});
