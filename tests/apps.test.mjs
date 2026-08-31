import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AppStore } from '../dist/backend/apps.js';

test('creates immutable App identity and cosmetic renames', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-apps-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new AppStore(directory);

  const wordpress = await store.create('WordPress');
  assert.match(wordpress.id, /^app_[a-f0-9-]{36}$/);
  assert.equal(wordpress.name, 'WordPress');

  const renamed = await store.renameApp(wordpress.id, 'Company Website');
  assert.equal(renamed.id, wordpress.id);
  assert.equal(renamed.name, 'Company Website');
  assert.equal((await store.get('Company Website')).id, wordpress.id);

  const persisted = JSON.parse(await readFile(path.join(directory, 'apps.json'), 'utf8'));
  assert.equal(persisted.apps[0].id, wordpress.id);
  assert.equal(persisted.apps[0].name, 'Company Website');
});

test('discourages conversationally ambiguous duplicate App names', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-apps-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new AppStore(directory);
  await store.create('My App');
  await assert.rejects(store.create('my app'), /already exists/);
});

test('loads legacy App records without source metadata', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-apps-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'apps.json'), `${JSON.stringify({
    version: 1,
    apps: [{ id: 'app_00000000-0000-0000-0000-000000000000', name: 'Legacy', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
  })}\n`);
  const app = await new AppStore(directory).get('Legacy');
  assert.equal(app.source, undefined);
  assert.equal(app.deployment, undefined);
});

test('serializes concurrent App metadata mutations', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-apps-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const firstStore = new AppStore(directory);
  const secondStore = new AppStore(directory);

  await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 ? firstStore : secondStore).create(`App ${index}`)));

  const apps = await firstStore.list();
  assert.equal(apps.length, 20);
  assert.equal(new Set(apps.map((app) => app.name)).size, 20);
});
