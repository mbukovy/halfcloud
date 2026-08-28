import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DomainStore, normalizeHostname } from '../dist/backend/domains.js';

test('migrates a legacy hostname without recreating application state', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-domains-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new DomainStore(directory);

  const domains = await store.get('n8n', 'n8n.127.0.0.1.nip.io');

  assert.match(domains[0].id, /^route_/);
  assert.deepEqual({ ...domains[0], id: undefined }, {
    id: undefined,
    hostname: 'n8n.127.0.0.1.nip.io',
    primary: true,
    managed: true,
    access: { type: 'public' },
  });
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'n8n', 'domains.json'), 'utf8')), domains);
});

test('keeps the managed fallback and makes the first custom domain primary', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-domains-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new DomainStore(directory);
  await store.initialize('n8n', 'n8n.127.0.0.1.nip.io');

  const added = await store.add('n8n', undefined, 'N8N.Example.com.');
  assert.deepEqual(added.map(({ id: _id, ...domain }) => domain), [
    { hostname: 'n8n.127.0.0.1.nip.io', primary: false, managed: true, access: { type: 'public' } },
    { hostname: 'n8n.example.com', primary: true, managed: false, access: { type: 'public' } },
  ]);

  await assert.rejects(store.remove('n8n', undefined, 'n8n.127.0.0.1.nip.io'), /explicit confirmation/);
  const switched = await store.setPrimary('n8n', undefined, 'n8n.127.0.0.1.nip.io');
  assert.equal(switched.filter((domain) => domain.primary).length, 1);
  assert.equal(switched.find((domain) => domain.managed)?.primary, true);
});

test('migrates persisted domains to stable public route records', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-domains-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'app'), { recursive: true });
  await writeFile(path.join(directory, 'app', 'domains.json'), JSON.stringify([
    { hostname: 'app.example.com', primary: true, managed: false },
  ]));
  const store = new DomainStore(directory);

  const first = await store.get('app');
  const second = await store.get('app');

  assert.match(first[0].id, /^route_/);
  assert.equal(second[0].id, first[0].id);
  assert.deepEqual(first[0].access, { type: 'public' });
});

test('validates hostnames and prevents removing the final public domain', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-domains-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new DomainStore(directory);
  await store.initialize('demo', 'demo.127.0.0.1.nip.io');

  assert.throws(() => normalizeHostname('https://demo.example.com/path'), /Invalid domain/);
  await assert.rejects(store.remove('demo', undefined, 'demo.127.0.0.1.nip.io', true), /at least one domain/);
});
