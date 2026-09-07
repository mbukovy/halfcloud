import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GitHubWebhookError, GitHubWebhookService } from '../dist/backend/github-webhooks.js';

const commit = 'a'.repeat(40);
const failureMessage = 'Automatic update failed; inspect the App';
const repository = { full_name: 'owner/repo', id: 123 };
const push = (extra = {}) => ({ repository, ref: 'refs/heads/main', deleted: false, after: 'b'.repeat(40), ...extra });
const signature = (secret, raw) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
const httpError = (status) => (error) => error instanceof GitHubWebhookError && error.status === status;

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-github-webhooks-'));
  const file = path.join(directory, 'github-webhooks.json');
  const targets = new Map(['app1', 'app2'].map((appId) => [appId, {
    appId, appName: `name-${appId}`, repository: 'owner/repo', branch: 'main', ready: true,
  }]));
  const services = [];
  const releases = [];
  const state = {
    targets, calls: [], busy: new Set(),
    target: async (id) => ({ ...[...targets.values()].find((target) => target.appId === id || target.appName === id) }),
    update: async () => ({ commit, updated: true }),
  };
  const make = () => {
    const service = new GitHubWebhookService({
      target: (id) => state.target(id),
      update: (...args) => { state.calls.push(args); return state.update(...args); },
      busy: (id) => state.busy.has(id),
    }, directory, 'Control.Example.com');
    services.push(service);
    return service;
  };
  const service = make();
  let serial = 0;
  const send = async (setup, payload, event = 'push', delivery = `delivery-${++serial}`, receiver = service) => {
    const { secret } = await receiver.getSecret(setup.appId, setup.hookId);
    const raw = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
    return receiver.receive(setup.hookId, raw, signature(secret, raw), event, delivery);
  };
  const configure = async (appId = 'app1') => {
    const setup = await service.requestSetup(appId);
    await send(setup, { repository, zen: 'ping' }, 'ping');
    return service.setEnabled(setup.appId, setup.hookId, true);
  };
  const gate = () => {
    const deferred = Promise.withResolvers();
    releases.push(deferred.resolve);
    return deferred;
  };
  t.after(async () => {
    for (const instance of services) instance.stop();
    for (const release of releases) release();
    await Promise.all(services.map((instance) => instance.drain()));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, file, service, make, state, send, configure, gate, journal: async () => JSON.parse(await readFile(file, 'utf8')) };
}

test('setup is idempotent by immutable App ID, private, and explicitly allowlisted', async (t) => {
  const f = await fixture(t);
  const setups = await Promise.all(Array.from({ length: 8 }, (_, i) => f.service.requestSetup(i % 2 ? 'name-app1' : 'app1')));
  const setup = setups[0];
  for (const other of setups) assert.deepEqual(other, setup);
  assert.deepEqual(Object.keys(setup).sort(), ['appId', 'branch', 'enabled', 'hookId', 'kind', 'payloadUrl', 'repository', 'settingsUrl', 'verified']);
  assert.equal(setup.payloadUrl, `https://control.example.com/api/webhooks/github/${setup.hookId}`);
  assert.equal(setup.settingsUrl, 'https://github.com/owner/repo/settings/hooks');
  assert.equal(setup.enabled, false);
  assert.equal(setup.verified, false);
  const { secret } = await f.service.getSecret('app1', setup.hookId);
  assert.match(secret, /^[a-f0-9]{64}$/);
  assert.notEqual(secret, setup.hookId);
  assert.equal(JSON.stringify(setup).includes(secret), false);
  assert.equal((await stat(f.file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(f.directory), ['github-webhooks.json']);
  assert.equal((await f.journal()).hooks.length, 1);
  await assert.rejects(f.service.getSecret('app2', setup.hookId), httpError(404));
  await assert.rejects(f.service.setEnabled('app1', setup.hookId, true), httpError(409));
  await assert.rejects(f.service.setEnabled('app1', setup.hookId, 'false'), httpError(400));
  setup.enabled = true;
  assert.equal((await f.service.getSetup('app1')).enabled, false);
  assert.equal(await f.service.getSetup('absent'), undefined);
  f.state.targets.get('app1').appName = 'renamed';
  assert.equal((await f.service.requestSetup('renamed')).hookId, setup.hookId);
  await f.service.remove('app1');
  await f.service.remove('app1');
  assert.equal(await f.service.getSetup('app1'), undefined);
});

test('rejects unsafe hostnames and invalid or unready metadata without leaking callback errors', async (t) => {
  const f = await fixture(t);
  for (const hostname of ['', 'https://example.com', 'user@example.com', 'example.com/path', 'example.com:443',
    'example.com?x', 'example.com#x', ' example.com', 'example.com\n', 'a..com', '-host.com', 'host-.com', 'a'.repeat(64) + '.com']) {
    assert.throws(() => new GitHubWebhookService({}, f.directory, hostname), httpError(400));
  }
  const original = { ...f.state.targets.get('app1') };
  for (const change of [{ ready: false }, { repository: 'https://github.com/owner/repo' }, { repository: 'Owner/Repo' },
    { repository: 'owner/..' }, { branch: '../main' }, { branch: 'main\n' }, { branch: 'a.lock' }, { appId: '../app' }]) {
    f.state.targets.set('app1', { ...original, ...change });
    await assert.rejects(f.service.requestSetup('name-app1'), httpError(409));
  }
  f.state.target = async () => { throw new Error('secret repository credentials'); };
  await assert.rejects(f.service.requestSetup('app1'), (error) => error.status === 409 && !error.message.includes('credentials'));
});

test('HMAC uses exact raw bytes, checks signatures before JSON, and bounds public input', async (t) => {
  const f = await fixture(t);
  const setup = await f.service.requestSetup('app1');
  const { secret } = await f.service.getSecret('app1', setup.hookId);
  const raw = Buffer.from('{ "repository": {"full_name":"owner/repo", "id":123} }\n');
  const signed = signature(secret, raw);
  const before = await readFile(f.file, 'utf8');
  for (const invalid of ['', `sha1=${'a'.repeat(40)}`, signed.toUpperCase(), `${signed}\n`, `sha256=${'a'.repeat(63)}`, `sha256=${'z'.repeat(64)}`]) {
    await assert.rejects(f.service.receive(setup.hookId, raw, invalid, 'ping', 'd'), httpError(401));
  }
  await assert.rejects(f.service.receive(setup.hookId, Buffer.from(JSON.stringify(JSON.parse(raw))), signed, 'ping', 'd'), httpError(401));
  const invalidJson = Buffer.from('{not-json');
  await assert.rejects(f.service.receive(setup.hookId, invalidJson, signed, 'ping', 'd'), httpError(401));
  await assert.rejects(f.service.receive(setup.hookId, invalidJson, signature(secret, invalidJson), 'ping', 'd'), httpError(400));
  await assert.rejects(f.service.receive(setup.hookId, raw, signed, 'ping\n', 'd'), httpError(400));
  await assert.rejects(f.service.receive(setup.hookId, raw, signed, 'ping', 'd'.repeat(129)), httpError(400));
  await assert.rejects(f.service.receive(setup.hookId, Buffer.alloc(25 * 1024 * 1024 + 1), signed, 'ping', 'd'), httpError(413));
  await assert.rejects(f.service.receive('unknown', raw, signed, 'ping', 'd'), httpError(404));
  assert.equal(await readFile(f.file, 'utf8'), before);
  const receiving = f.service.receive(setup.hookId, raw, signed, 'ping', 'valid');
  raw.fill(0); // The service must own the verified bytes while it waits for the store.
  assert.deepEqual(await receiving, { status: 200, body: { verified: true } });
  assert.equal((await f.service.getSetup('app1')).verified, true);
  assert.deepEqual(f.state.calls, []);
});

test('repository, ID, branch, deletion and tag filters gate verification and deployment', async (t) => {
  const f = await fixture(t);
  const setup = await f.service.requestSetup('app1');
  const ignored = [
    push({ repository: { full_name: 'someone/else', id: 123 } }),
    push({ repository: { full_name: 'owner/repo', id: '123' } }),
    push({ repository: { full_name: 'owner/repo', id: -1 } }),
    push({ repository: { full_name: 'owner/repo' } }),
    push({ repository: null }), push({ ref: 'refs/heads/other' }), push({ ref: 'refs/tags/main' }),
    push({ ref: 'main' }), push({ deleted: true }), push({ deleted: 'false' }), push({ after: '0'.repeat(40) }),
    push({ after: undefined }), push({ after: 'untrusted-sha' }),
  ];
  for (const payload of ignored) assert.deepEqual((await f.send(setup, payload)).body, { ignored: true });
  assert.deepEqual((await f.send(setup, push(), 'pull_request')).body, { ignored: true });
  assert.equal((await f.service.getSetup('app1')).verified, false);
  assert.deepEqual((await f.send(setup, { repository: { full_name: 'OWNER/REPO' } }, 'ping')).body, { verified: true });
  assert.equal((await f.journal()).hooks[0].repositoryId, undefined);
  assert.deepEqual((await f.send(setup, push({ after: 'c'.repeat(40) }))).body, { verified: true });
  assert.equal((await f.journal()).hooks[0].repositoryId, 123);
  assert.equal((await f.service.getSetup('app1')).enabled, false);
  await f.service.start();
  await f.service.drain();
  assert.equal(f.state.calls.length, 0);
  await f.service.setEnabled('app1', setup.hookId, true);
  assert.deepEqual((await f.send(setup, push({ repository: { full_name: 'owner/repo', id: 456 } }))).body, { ignored: true });
  assert.deepEqual((await f.send(setup, { repository: { full_name: 'owner/repo' }, zen: 'missing pin' }, 'ping')).body, { ignored: true });
  assert.deepEqual((await f.send(setup, { repository, zen: 'never deploy ping' }, 'ping')).body, { verified: true });
  assert.equal((await f.journal()).hooks[0].pending, false);
  assert.equal((await f.send(setup, push({ repository: { full_name: 'OWNER/REPO', id: 123 }, after: 'e'.repeat(40), clone_url: 'https://attacker/secret' }))).status, 202);
  await f.service.drain();
  assert.deepEqual(f.state.calls, [['app1']]);
  assert.equal((await f.service.getSetup('app1')).lastUpdate.commit, commit);
  assert.doesNotMatch(await readFile(f.file, 'utf8'), /attacker|untrusted-sha|clone_url/);
});

test('target changes require an explicit new setup; enabling also rechecks readiness', async (t) => {
  const f = await fixture(t);
  const setup = await f.configure();
  await f.service.setEnabled('app1', setup.hookId, false);
  f.state.targets.get('app1').ready = false;
  await assert.rejects(f.service.setEnabled('app1', setup.hookId, true), httpError(409));
  f.state.targets.get('app1').ready = true;
  f.state.targets.get('app1').branch = 'feature/new';
  await assert.rejects(f.service.requestSetup('app1'), /target changed/);
  await assert.rejects(f.service.setEnabled('app1', setup.hookId, true), /target changed/);
  assert.equal((await f.service.getSetup('app1')).hookId, setup.hookId);
  await f.service.remove('app1');
  const replacement = await f.configure();
  assert.notEqual(replacement.hookId, setup.hookId);
  assert.deepEqual((await f.send(replacement, push())).body, { ignored: true });
  assert.equal((await f.send(replacement, push({ ref: 'refs/heads/feature/new' }))).status, 202);
});

test('delivery IDs AND signed-body hashes survive restart and prevent later re-enabling replays', async (t) => {
  const f = await fixture(t);
  const setup = await f.service.requestSetup('app1');
  const payload = push();
  await f.send(setup, payload, 'push', 'original');
  await f.service.setEnabled('app1', setup.hookId, true);
  assert.deepEqual((await f.send(setup, payload, 'push', 'new-id')).body, { duplicate: true });
  assert.deepEqual((await f.send(setup, push({ after: 'd'.repeat(40) }), 'push', 'original')).body, { duplicate: true });
  f.service.stop();
  const restarted = f.make();
  assert.deepEqual((await f.send(setup, payload, 'push', 'after-restart', restarted)).body, { duplicate: true });
  await restarted.start();
  await restarted.drain();
  assert.equal(f.state.calls.length, 0);
  assert.equal((await f.send(setup, push({ after: 'e'.repeat(40) }), 'push', 'fresh', restarted)).status, 202);
  await restarted.drain();
  assert.equal(f.state.calls.length, 1);
});

test('replay ledger is bounded to 128 admissions and seven days, not permanent', async (t) => {
  const f = await fixture(t);
  const setup = await f.configure();
  for (let index = 0; index < 129; index++) await f.send(setup, push({ nonce: index }), 'push', `bounded-${index}`);
  let journal = await f.journal();
  assert.equal(journal.hooks[0].deliveries.length, 128);
  assert.equal(journal.hooks[0].deliveries[0].id, 'bounded-1');
  assert.equal((await f.send(setup, push({ nonce: 0 }), 'push', 'bounded-0')).status, 202);
  journal = await f.journal();
  for (const entry of journal.hooks[0].deliveries) entry.at = new Date(Date.now() - 8 * 86400000).toISOString();
  f.service.stop();
  await writeFile(f.file, JSON.stringify(journal));
  const restarted = f.make();
  assert.equal((await f.send(setup, push({ nonce: 0 }), 'push', 'bounded-0', restarted)).status, 202);
  assert.equal((await f.journal()).hooks[0].deliveries.length, 1);
});

test('admission is durable before 202, coalesces bursts, and does not dispatch before start', async (t) => {
  const f = await fixture(t);
  const setup = await f.configure();
  const admissions = await Promise.all(Array.from({ length: 20 }, (_, nonce) => f.send(setup, push({ nonce }))));
  assert.ok(admissions.every((result) => result.status === 202));
  const journal = await f.journal();
  assert.equal(journal.hooks[0].pending, true);
  assert.equal(journal.hooks[0].lastUpdate.status, 'queued');
  await f.service.drain();
  assert.equal(f.state.calls.length, 0);
  f.service.stop();
  const restarted = f.make();
  assert.equal((await restarted.getSetup('app1')).lastUpdate.status, 'queued');
  assert.equal(f.state.calls.length, 0);
  await restarted.start(); // Parent recovery must precede this call.
  await restarted.drain();
  assert.deepEqual(f.state.calls, [['app1']]);
  assert.equal((await restarted.getSetup('app1')).lastUpdate.status, 'succeeded');
  assert.equal((await f.journal()).hooks[0].pending, false);
});

test('one update globally and exactly one coalesced followup during an in-flight update', async (t) => {
  const f = await fixture(t);
  const first = await f.configure('app1');
  const second = await f.configure('app2');
  const entered = f.gate();
  const release = f.gate();
  let active = 0;
  f.state.update = async () => {
    assert.equal(++active, 1);
    if (f.state.calls.length === 1) { entered.resolve(); await release.promise; }
    active--;
    return { commit, updated: false };
  };
  await f.send(first, push({ nonce: 0 }));
  await f.service.start();
  const draining = f.service.drain();
  await entered.promise;
  await Promise.all(Array.from({ length: 8 }, (_, nonce) => f.send(first, push({ nonce: nonce + 1 }))));
  await f.send(second, push());
  assert.equal((await f.service.getSetup('app1')).lastUpdate.status, 'running');
  assert.equal((await f.journal()).hooks[0].pending, true);
  assert.equal(f.state.calls.length, 1);
  release.resolve();
  await draining;
  assert.deepEqual(f.state.calls, [['app1'], ['app1'], ['app2']]);
  assert.equal((await f.service.getSetup('app1')).lastUpdate.status, 'succeeded');
});

test('busy Apps defer without blocking other Apps; app_busy is requeued without an immediate retry loop', async (t) => {
  const f = await fixture(t);
  const first = await f.configure('app1');
  const second = await f.configure('app2');
  f.state.busy.add('app1');
  await f.send(first, push());
  await f.send(second, push());
  await f.service.start();
  await f.service.drain();
  assert.deepEqual(f.state.calls, [['app2']]);
  assert.equal((await f.service.getSetup('app1')).lastUpdate.status, 'queued');
  f.state.busy.delete('app1');
  f.state.update = async () => { throw Object.assign(new Error('private app busy detail'), { code: 'app_busy' }); };
  await f.service.drain();
  assert.deepEqual(f.state.calls, [['app2'], ['app1']]);
  assert.equal((await f.service.getSetup('app1')).lastUpdate.status, 'queued');
  assert.equal((await f.journal()).hooks[0].pending, true);
  assert.doesNotMatch(await readFile(f.file, 'utf8'), /private app busy detail/);
  f.state.update = async () => ({ commit, updated: true });
  await f.service.drain();
  assert.deepEqual(f.state.calls, [['app2'], ['app1'], ['app1']]);
});

test('busy retry timer eventually dispatches without another delivery', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const setup = await f.configure();
  const entered = f.gate();
  f.state.busy.add('app1');
  f.state.update = async () => { entered.resolve(); return { commit, updated: true }; };
  await f.send(setup, push());
  await f.service.start();
  await f.service.drain();
  f.state.busy.clear();
  // Keep the test alive; the production retry timer itself must not keep a process alive.
  const keepAlive = setTimeout(() => entered.reject(new Error('Retry did not run')), 4000);
  try { await entered.promise; await f.service.drain(); }
  finally { clearTimeout(keepAlive); }
  assert.equal(f.state.calls.length, 1);
});

test('busy races and app_busy during target lookup preserve the admitted update', async (t) => {
  const f = await fixture(t);
  const setup = await f.configure();
  const target = f.state.target;
  f.state.target = async (id) => {
    f.state.busy.add(id);
    return target(id);
  };
  await f.send(setup, push());
  await f.service.start();
  await f.service.drain();
  assert.equal(f.state.calls.length, 0);
  assert.equal((await f.service.getSetup('app1')).lastUpdate.status, 'queued');
  f.state.busy.clear();
  f.state.target = async () => { throw Object.assign(new Error('private busy context'), { code: 'app_busy' }); };
  await f.service.drain();
  assert.equal(f.state.calls.length, 0);
  assert.equal((await f.journal()).hooks[0].pending, true);
  assert.equal((await f.service.getSetup('app1')).lastUpdate.status, 'queued');
  f.state.target = target;
  await f.service.drain();
  assert.equal(f.state.calls.length, 1);
});

test('build failures are generic, secret-free, and not retried', async (t) => {
  const f = await fixture(t);
  const setup = await f.configure();
  const { secret } = await f.service.getSecret('app1', setup.hookId);
  f.state.update = async () => {
    assert.equal((await f.service.getSetup('app1')).lastUpdate.status, 'running');
    throw new Error(`build logs: ${secret} runtime-password`);
  };
  await f.send(setup, push());
  await f.service.start();
  await f.service.drain();
  await f.service.drain();
  const result = await f.service.getSetup('app1');
  assert.equal(result.lastUpdate.status, 'failed');
  assert.equal(result.lastUpdate.message, failureMessage);
  assert.equal(f.state.calls.length, 1);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.doesNotMatch(JSON.stringify(result), /secret|deliveries|repositoryId|pending|inFlight|runtime-password/);
  assert.doesNotMatch(await readFile(f.file, 'utf8'), /build logs|runtime-password/);
  assert.deepEqual((await f.send(setup, push())).body, { duplicate: true });
});

test('dispatcher rechecks readiness and target; target I/O never holds the store lock', async (t) => {
  for (const change of [{ ready: false }, { repository: 'owner/other' }, { branch: 'changed' }]) await t.test(JSON.stringify(change), async (t) => {
    const f = await fixture(t);
    const setup = await f.configure();
    await f.send(setup, push());
    Object.assign(f.state.targets.get('app1'), change);
    await f.service.start();
    await f.service.drain();
    assert.equal(f.state.calls.length, 0);
    assert.equal((await f.service.getSetup('app1')).lastUpdate.message, failureMessage);
    assert.equal((await f.journal()).hooks[0].pending, false);
  });
  await t.test('disable during target lookup prevents dispatch', async (t) => {
    const f = await fixture(t);
    const setup = await f.configure();
    const entered = f.gate();
    const release = f.gate();
    f.state.target = async () => { entered.resolve(); await release.promise; return { ...f.state.targets.get('app1') }; };
    await f.send(setup, push());
    await f.service.start();
    const draining = f.service.drain();
    await entered.promise;
    await f.service.setEnabled('app1', setup.hookId, false);
    release.resolve();
    await draining;
    assert.equal(f.state.calls.length, 0);
  });
});

test('startup marks in-flight work interrupted without blindly rerunning it; distinct pending followup survives', async (t) => {
  for (const followup of [false, true]) await t.test(`followup=${followup}`, async (t) => {
    const f = await fixture(t);
    const setup = await f.configure();
    await f.send(setup, push());
    const journal = await f.journal();
    journal.hooks[0].pending = followup;
    journal.hooks[0].inFlight = randomUUID();
    journal.hooks[0].lastUpdate = { status: 'running', updatedAt: new Date().toISOString() };
    f.service.stop();
    await writeFile(f.file, JSON.stringify(journal));
    const restarted = f.make();
    await restarted.start();
    restarted.stop();
    const recovered = await restarted.getSetup('app1');
    assert.equal(recovered.lastUpdate.status, 'interrupted');
    assert.equal((await f.journal()).hooks[0].inFlight, undefined);
    await restarted.start();
    await restarted.drain();
    assert.equal(f.state.calls.length, followup ? 1 : 0);
    await restarted.start();
    await restarted.drain();
    assert.equal(f.state.calls.length, followup ? 1 : 0);
  });
});

test('disable, rotation and removal clear pending work and invalidate obsolete credentials', async (t) => {
  for (const operation of ['disable', 'rotate', 'remove']) await t.test(operation, async (t) => {
    const f = await fixture(t);
    const setup = await f.configure();
    const { secret } = await f.service.getSecret('app1', setup.hookId);
    await f.send(setup, push());
    let replacement;
    if (operation === 'disable') await f.service.setEnabled('app1', setup.hookId, false);
    if (operation === 'rotate') replacement = await f.service.rotateSecret('app1', setup.hookId);
    if (operation === 'remove') await f.service.remove('app1');
    await f.service.start();
    await f.service.drain();
    assert.equal(f.state.calls.length, 0);
    assert.ok((await f.journal()).hooks.every((hook) => !hook.pending));
    if (operation !== 'disable') {
      const raw = Buffer.from(JSON.stringify(push()));
      await assert.rejects(f.service.receive(setup.hookId, raw, signature(secret, raw), 'push', 'obsolete'), httpError(404));
      await assert.rejects(f.service.getSecret('app1', setup.hookId), httpError(404));
    }
    if (replacement) {
      assert.notEqual(replacement.hookId, setup.hookId);
      assert.notEqual((await f.service.getSecret('app1', replacement.hookId)).secret, secret);
      assert.equal(replacement.verified, false);
      assert.equal(replacement.enabled, false);
      assert.equal(replacement.lastUpdate, undefined);
      await assert.rejects(f.service.setEnabled('app1', replacement.hookId, true), httpError(409));
      assert.deepEqual((await f.send(replacement, { repository: { full_name: 'owner/repo', id: 456 } }, 'ping')).body, { ignored: true });
      await f.send(replacement, { repository }, 'ping');
      await f.service.setEnabled('app1', replacement.hookId, true);
      assert.equal((await f.send(replacement, push())).status, 202);
      await f.service.drain();
      assert.equal(f.state.calls.length, 1);
    }
  });
});

test('running updates finish safely after disable, rotation or removal without reviving queued work', async (t) => {
  for (const operation of ['disable', 'rotate', 'remove']) await t.test(operation, async (t) => {
    const f = await fixture(t);
    const setup = await f.configure();
    const entered = f.gate();
    const release = f.gate();
    f.state.update = async () => { entered.resolve(); await release.promise; return { commit, updated: true }; };
    await f.send(setup, push());
    await f.service.start();
    const draining = f.service.drain();
    await entered.promise;
    await f.send(setup, push({ nonce: 'followup' }));
    if (operation === 'disable') await f.service.setEnabled('app1', setup.hookId, false);
    if (operation === 'rotate') await f.service.rotateSecret('app1', setup.hookId);
    if (operation === 'remove') await f.service.remove('app1');
    release.resolve();
    await draining;
    assert.equal(f.state.calls.length, 1);
    const result = await f.service.getSetup('app1');
    if (operation === 'disable') { assert.equal(result.enabled, false); assert.equal(result.lastUpdate.status, 'succeeded'); }
    if (operation === 'rotate') { assert.equal(result.verified, false); assert.equal(result.lastUpdate, undefined); }
    if (operation === 'remove') assert.equal(result, undefined);
  });
});

test('invalid journals fail closed with bounded, generic errors', async (t) => {
  const f = await fixture(t);
  await f.configure();
  const valid = await f.journal();
  f.service.stop();
  for (const corrupt of [
    { ...valid, version: 2 },
    { ...valid, hooks: [...valid.hooks, valid.hooks[0]] },
    { ...valid, hooks: [{ ...valid.hooks[0], buildLogs: 'private-content' }] },
    { ...valid, hooks: [{ ...valid.hooks[0], verified: false }] },
    { ...valid, hooks: [{ ...valid.hooks[0], deliveries: Array(129).fill(valid.hooks[0].deliveries[0]) }] },
    { ...valid, hooks: [{ ...valid.hooks[0], lastUpdate: { status: 'failed', updatedAt: new Date().toISOString(), message: 'private-content' } }] },
  ]) {
    await writeFile(f.file, JSON.stringify(corrupt));
    await assert.rejects(f.make().start(), (error) => error.status === 503 && error.message === 'Webhook store unavailable');
  }
  await writeFile(f.file, Buffer.alloc(32 * 1024 * 1024 + 1));
  await assert.rejects(f.make().start(), httpError(503));
});

test('failed durable admission never acknowledges 202 or invokes the updater', async (t) => {
  const f = await fixture(t);
  const setup = await f.configure();
  await rm(f.file);
  await mkdir(f.file); // Force atomic rename failure, including on privileged test runners.
  await assert.rejects(f.send(setup, push()), (error) => error.status === 503 && error.message === 'Webhook store unavailable');
  await assert.rejects(f.service.getSetup('app1'), httpError(503));
  assert.equal(f.state.calls.length, 0);
  assert.deepEqual(await readdir(f.directory), ['github-webhooks.json']);
});
