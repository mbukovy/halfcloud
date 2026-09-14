import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RedirectStore } from '../dist/backend/redirects.js';

test('persists normalized hostname redirects', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-redirects-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new RedirectStore(directory);

  const redirect = await store.add('Taisen.Mbukovy.Eu.', 'TAISEN.fun');

  assert.match(redirect.id, /^redirect_/);
  assert.equal(redirect.hostname, 'taisen.mbukovy.eu');
  assert.equal(redirect.targetHostname, 'taisen.fun');
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'redirects.json'), 'utf8')), [redirect]);
  assert.deepEqual(await store.list(), [redirect]);
});

test('rejects duplicate, self-referential, and invalid redirects', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-redirects-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new RedirectStore(directory);
  await store.add('old.example.com', 'new.example.com');

  await assert.rejects(store.add('old.example.com', 'other.example.com'), /already has a redirect/);
  await assert.rejects(store.add('same.example.com', 'same.example.com'), /must be different/);
  await assert.rejects(store.add('https://bad.example.com', 'new.example.com'), /Invalid domain/);
});

test('removes redirects by normalized hostname', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-redirects-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new RedirectStore(directory);
  const redirect = await store.add('old.example.com', 'new.example.com');

  assert.deepEqual(await store.remove('OLD.example.com.'), redirect);
  assert.deepEqual(await store.list(), []);
  await assert.rejects(store.remove('old.example.com'), /was not found/);
});
