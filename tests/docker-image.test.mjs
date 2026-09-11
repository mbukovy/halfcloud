import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import Docker from 'dockerode';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appNetworkName, DockerService } from '../dist/backend/docker.js';

const appId = 'app_12345678-1234-1234-1234-123456789abc';
const serviceId = 'service_12345678-1234-1234-1234-123456789abc';
const network = appNetworkName(appId);
const imageFields = ['Cmd', 'Entrypoint', 'User', 'WorkingDir', 'Healthcheck'];

function replacementFixture({ running = true, failure, suffix = '', ownerAppId = appId } = {}) {
  const network = appNetworkName(ownerAppId);
  const previousConfig = {
    Cmd: ['old-server'], Entrypoint: ['/old-entrypoint'], User: '1000', WorkingDir: '/old-app',
    Healthcheck: { Test: ['CMD', 'old-check'], Interval: 30_000_000_000 },
  };
  const nextConfig = {
    Cmd: ['new-server'], Entrypoint: ['/new-entrypoint'], User: '2000', WorkingDir: '/new-app',
    Healthcheck: { Interval: 60_000_000_000, Test: ['CMD', 'new-check'] },
  };
  const inspection = {
    Id: `old-container${suffix}`, Name: `/app-web${suffix}`, Image: 'sha256:old-image', State: { Running: running },
    Config: {
      ...structuredClone(previousConfig), Image: 'halfcloud/web:latest',
      Hostname: 'web-host', Domainname: 'internal', Tty: true, OpenStdin: true,
      StopSignal: 'SIGQUIT', StopTimeout: 25,
      Labels: { 'halfcloud.managed': 'true', 'halfcloud.app.id': ownerAppId, 'halfcloud.service.id': `${serviceId}${suffix}`, 'halfcloud.service.name': `web${suffix}`, 'halfcloud.hostname': 'web.example.com' },
      Env: ['API_KEY=protected-secret', 'DATABASE_URL=postgres://user:password@db/app', 'VALUE=with=equals', 'MULTILINE=one\ntwo', 'EMPTY='],
      ExposedPorts: { '3000/tcp': {}, '3001/udp': {} }, Volumes: { '/data': {} },
    },
    HostConfig: {
      NetworkMode: network,
      PortBindings: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '10001' }], '3001/udp': [{ HostIp: '127.0.0.1', HostPort: '10002' }] },
      Binds: ['/managed/config:/config:ro'],
      Mounts: [{ Type: 'volume', Source: 'halfcloud-web-data', Target: '/data', ReadOnly: false }],
      RestartPolicy: { Name: 'on-failure', MaximumRetryCount: 3 },
      LogConfig: { Type: 'json-file', Config: { 'max-size': '10m' } },
      SecurityOpt: ['no-new-privileges'], CapDrop: ['ALL'], ReadonlyRootfs: true,
      PidsLimit: 128, Memory: 268435456, NanoCpus: 500000000, Init: true,
      Tmpfs: { '/tmp': 'rw,noexec' }, Dns: ['10.0.0.2'], GroupAdd: ['100'],
    },
    Mounts: [
      { Type: 'bind', Source: '/managed/config', Destination: '/config', RW: false },
      { Type: 'volume', Name: 'halfcloud-web-data', Destination: '/data', RW: true },
    ],
    NetworkSettings: { Networks: {
      [network]: { Aliases: ['web', 'web-alias'], IPAMConfig: { IPv4Address: '172.20.0.10' }, DriverOpts: { custom: 'option' }, NetworkID: 'network-id', EndpointID: 'old-endpoint', IPAddress: '172.20.0.10' },
      secondary: { Aliases: ['secondary-web'], Links: ['db:db'], IPAMConfig: null, IPAddress: '172.21.0.10' },
    } },
  };
  const events = [];
  const creates = [];
  const failures = new Set(failure ? [failure] : []);
  const fail = (step) => { if (failures.has(step)) throw new Error(`${step} failed`); };
  let oldName = inspection.Name;
  let oldRunning = running;
  const containers = new Map();
  const old = {
    id: inspection.Id,
    async inspect() {
      if (!containers.has(inspection.Id)) throw Object.assign(new Error('not found'), { statusCode: 404 });
      return { ...inspection, Name: oldName, State: { Running: oldRunning, Status: oldRunning ? 'running' : 'exited' } };
    },
    async stop(options) { assert.deepEqual(options, { t: 10 }); events.push('stop-old'); oldRunning = false; fail('stop'); },
    async rename({ name }) {
      const step = name === inspection.Name.slice(1) ? 'restore-name' : name.endsWith('-committed') ? 'commit-name' : 'backup-name';
      events.push(step);
      fail(step);
      oldName = `/${name}`;
      fail(`${step}-after`);
    },
    async start() { events.push('start-old'); fail('start-old'); oldRunning = true; },
    async remove(options) { assert.deepEqual(options, { force: true, v: false }); events.push('remove-old'); fail('remove-old'); containers.delete(inspection.Id); },
  };
  containers.set(inspection.Id, old);
  const service = Object.create(DockerService.prototype);
  service.initializingServices = new Set();
  service.docker = {
    async listContainers() {
      return Promise.all([...containers.values()].map(async (container) => {
        const value = await container.inspect();
        return { Id: value.Id, Names: [value.Name], Labels: value.Config.Labels, Image: value.Config.Image, ImageID: value.Image, State: value.State.Status };
      }));
    },
    getContainer(id) {
      return containers.get(id) ?? { async inspect() { throw Object.assign(new Error('not found'), { statusCode: 404 }); } };
    },
    getImage(image) {
      return { async inspect() {
        events.push(`inspect:${image}`);
        if (failure === image) throw new Error('image not found');
        if (image === inspection.Image) return { Id: image, Config: previousConfig };
        assert.equal(image, 'halfcloud/web:latest');
        return { Id: 'sha256:new-image', Config: nextConfig };
      } };
    },
    getNetwork(name) {
      assert.equal(name, network);
      return { async inspect() { return { Name: network, Driver: 'bridge', Labels: { 'halfcloud.managed': 'true', 'halfcloud.app.id': ownerAppId } }; } };
    },
    async createContainer(options) {
      creates.push(options);
      events.push('create');
      fail('create');
      const value = {
        ...structuredClone(inspection), Id: `new-container${suffix}`, Name: `/${options.name}`, Image: 'sha256:new-image',
        Config: options, State: { Running: false, Status: 'created', Health: { Status: 'starting' } },
      };
      const container = {
        id: value.Id,
        async inspect() { return value; },
        async start() { events.push('start-new'); fail('start'); value.State.Running = true; value.State.Status = 'running'; },
        async remove(options) { assert.deepEqual(options, { force: true, v: false }); events.push('remove-new'); fail('remove-new'); containers.delete(container.id); },
      };
      containers.set(container.id, container);
      fail('create-after');
      return container;
    },
  };
  return { service, inspection, previousConfig, nextConfig, events, creates, failures, containers };
}

function combineReplacementFixtures(fixtures) {
  const clients = fixtures.map(({ service }) => service.docker);
  const service = Object.create(DockerService.prototype);
  service.initializingServices = new Set();
  service.docker = {
    ...clients[0],
    async listContainers() { return (await Promise.all(clients.map((client) => client.listContainers()))).flat(); },
    getContainer(id) { return fixtures.find(({ containers }) => containers.has(id)).containers.get(id); },
    getNetwork(name) { return clients[fixtures.findIndex(({ inspection }) => inspection.HostConfig.NetworkMode === name)].getNetwork(name); },
    createContainer(options) {
      return clients[fixtures.findIndex(({ inspection }) => inspection.Config.Labels['halfcloud.service.id'] === options.Labels['halfcloud.service.id'])].createContainer(options);
    },
  };
  return service;
}

function recoveryPlan(fixtures, action = 'commit') {
  const entries = Array.isArray(fixtures) ? fixtures : [fixtures];
  const plan = new Map();
  for (const { inspection } of entries) {
    const owner = inspection.Config.Labels['halfcloud.app.id'];
    const service = inspection.Config.Labels['halfcloud.service.id'];
    if (!plan.has(owner)) plan.set(owner, new Map());
    plan.get(owner).set(service, { action, previousImageId: inspection.Image, updateImageId: 'sha256:new-image' });
  }
  return plan;
}

function addInitializationHelper({ containers }, state = 'running') {
  const inspection = {
    Id: 'initialization-helper', Name: '/hopeful_hopper', State: { Status: state, Running: state === 'running' },
    Config: { Labels: { 'halfcloud.operation': 'service-initialization', 'halfcloud.app.id': appId, 'halfcloud.service.id': serviceId } },
  };
  containers.set(inspection.Id, {
    async inspect() { return inspection; },
    async remove() { assert.fail('Replacement must not delete initialization helpers'); },
    async start() { assert.fail('Replacement must not start initialization helpers'); },
    async stop() { assert.fail('Replacement must not stop initialization helpers'); },
  });
  return inspection;
}

test('image replacement preserves identity, protected environment and runtime configuration while using new defaults', async () => {
  const { service, inspection, nextConfig, events, creates } = replacementFixture();
  const original = structuredClone(inspection);
  const result = await service.replaceContainerImage(serviceId, ' halfcloud/web:latest ');

  assert.deepEqual(result, { containerId: 'new-container', name: 'app-web', state: 'running' });
  for (const entry of inspection.Config.Env) {
    const value = entry.slice(entry.indexOf('=') + 1);
    if (value) assert.ok(!JSON.stringify(result).includes(value));
  }
  assert.deepEqual(creates[0], {
    ...inspection.Config, ...nextConfig, Image: 'halfcloud/web:latest', name: 'app-web',
    Labels: { ...inspection.Config.Labels, 'halfcloud.replacement.backup': creates[0].Labels['halfcloud.replacement.backup'] },
    HostConfig: inspection.HostConfig,
    NetworkingConfig: { EndpointsConfig: {
      [network]: { Aliases: ['web', 'web-alias'], IPAMConfig: { IPv4Address: '172.20.0.10' }, DriverOpts: { custom: 'option' }, Links: undefined },
      secondary: { Aliases: ['secondary-web'], Links: ['db:db'], IPAMConfig: null, DriverOpts: undefined },
    } },
  });
  assert.deepEqual(events, ['inspect:halfcloud/web:latest', 'inspect:sha256:old-image', 'backup-name', 'stop-old', 'create', 'start-new', 'commit-name', 'remove-old']);
  assert.deepEqual(inspection, original);
});

for (const key of imageFields) {
  test(`image replacement retains a runtime ${key} override and updates other inherited defaults`, async () => {
    const { service, inspection, nextConfig, creates } = replacementFixture();
    const overrides = {
      Cmd: ['custom-server', '--flag'], Entrypoint: ['/custom-entrypoint'], User: '3456:3456', WorkingDir: '/custom-app',
      Healthcheck: { Test: ['NONE'] },
    };
    inspection.Config[key] = overrides[key];
    await service.replaceContainerImage(serviceId, 'halfcloud/web:latest');
    for (const field of imageFields) assert.deepEqual(creates[0][field], field === key ? overrides[key] : nextConfig[field]);
  });
}

test('image replacement compares healthcheck values independently of object key order', async () => {
  const { service, inspection, nextConfig, creates } = replacementFixture();
  inspection.Config.Healthcheck = { Interval: 30_000_000_000, Test: ['CMD', 'old-check'] };
  await service.replaceContainerImage(serviceId, 'halfcloud/web:latest');
  assert.deepEqual(creates[0].Healthcheck, nextConfig.Healthcheck);
});

test('image replacement adopts newly added defaults and drops removed defaults', async () => {
  for (const removed of [false, true]) {
    const { service, inspection, previousConfig, nextConfig, creates } = replacementFixture();
    if (removed) {
      for (const key of imageFields) delete nextConfig[key];
    } else {
      for (const key of imageFields) {
        delete previousConfig[key];
        inspection.Config[key] = null;
      }
    }
    await service.replaceContainerImage(serviceId, 'halfcloud/web:latest');
    for (const key of imageFields) assert.deepEqual(creates[0][key], nextConfig[key]);
  }
});

test('image replacement retains an explicitly disabled entrypoint', async () => {
  const { service, inspection, creates } = replacementFixture();
  inspection.Config.Entrypoint = null;
  await service.replaceContainerImage(serviceId, 'halfcloud/web:latest');
  assert.deepEqual(creates[0].Entrypoint, ['']);
});

test('image replacement does not overwrite existing environment values that match previous image defaults', async () => {
  const { service, inspection, previousConfig, nextConfig, creates } = replacementFixture();
  previousConfig.Env = ['API_KEY=protected-secret', 'PATH=/old/bin'];
  nextConfig.Env = ['API_KEY=different-secret', 'PATH=/new/bin'];
  inspection.Config.Env.push('PATH=/old/bin');
  await service.replaceContainerImage(serviceId, 'halfcloud/web:latest');
  assert.deepEqual(creates[0].Env, inspection.Config.Env);
});

test('image replacement reuses image-declared and anonymous volumes', async () => {
  const { service, inspection, creates } = replacementFixture();
  inspection.HostConfig.Mounts.push({ Type: 'volume', Target: '/anonymous', VolumeOptions: { NoCopy: true } });
  inspection.HostConfig.Binds.push('/short-syntax');
  for (const destination of ['/image-data', '/anonymous', '/short-syntax']) {
    inspection.Mounts.push({ Type: 'volume', Name: `volume-${destination.slice(1)}`, Destination: destination, RW: true });
  }
  const original = structuredClone(inspection);
  await service.replaceContainerImage(serviceId, 'halfcloud/web:latest');
  assert.deepEqual(creates[0].HostConfig.Mounts, [
    inspection.HostConfig.Mounts[0],
    { Type: 'volume', Source: 'volume-image-data', Target: '/image-data', ReadOnly: false },
    { Type: 'volume', Source: 'volume-anonymous', Target: '/anonymous', ReadOnly: false, VolumeOptions: { NoCopy: true } },
  ]);
  assert.deepEqual(creates[0].HostConfig.Binds, ['/managed/config:/config:ro', 'volume-short-syntax:/short-syntax']);
  assert.deepEqual(inspection, original);
});

test('image replacement leaves a stopped service stopped', async () => {
  const { service, events } = replacementFixture({ running: false });
  assert.deepEqual(await service.replaceContainerImage(serviceId, 'halfcloud/web:latest'), { containerId: 'new-container', name: 'app-web', state: 'exited' });
  assert.deepEqual(events, ['inspect:halfcloud/web:latest', 'inspect:sha256:old-image', 'backup-name', 'create', 'commit-name', 'remove-old']);
});

for (const failure of ['create', 'start']) {
  test(`image replacement rolls back after ${failure} failure without deleting the old container or volumes`, async () => {
    const { service, events } = replacementFixture({ failure });
    await assert.rejects(service.replaceContainerImage(serviceId, 'halfcloud/web:latest'), new RegExp(`${failure} failed`));
    assert.deepEqual(events, [
      'inspect:halfcloud/web:latest', 'inspect:sha256:old-image', 'backup-name', 'stop-old', 'create',
      ...(failure === 'start' ? ['start-new', 'remove-new'] : []), 'start-old', 'restore-name',
    ]);
  });
}

test('failed image replacement does not start a previously stopped service', async () => {
  const { service, events } = replacementFixture({ running: false, failure: 'create' });
  await assert.rejects(service.replaceContainerImage(serviceId, 'halfcloud/web:latest'), /create failed/);
  assert.deepEqual(events, ['inspect:halfcloud/web:latest', 'inspect:sha256:old-image', 'backup-name', 'create', 'restore-name']);
});

for (const image of ['halfcloud/web:latest', 'sha256:old-image']) {
  test(`image replacement fails before stopping the service if ${image} cannot be inspected`, async () => {
    const { service, events, creates } = replacementFixture({ failure: image });
    await assert.rejects(service.replaceContainerImage(serviceId, 'halfcloud/web:latest'), /image not found/);
    assert.ok(events.every((event) => event.startsWith('inspect:')));
    assert.equal(creates.length, 0);
  });
}

test('image replacement rejects empty or oversized image names before Docker calls', async () => {
  const service = Object.create(DockerService.prototype);
  for (const image of ['', '  ', 'x'.repeat(256)]) await assert.rejects(service.replaceContainerImage(serviceId, image), /Invalid image name/);
});

test('environment replacement still uses the shared replacement flow and writes the requested environment', async (t) => {
  const { service, inspection, events, creates } = replacementFixture();
  service.appsDir = await mkdtemp(path.join(tmpdir(), 'halfcloud-replacement-'));
  t.after(() => rm(service.appsDir, { recursive: true, force: true }));
  await mkdir(path.join(service.appsDir, appId));
  const result = await service.replaceContainerEnvironment(serviceId, { API_KEY: 'protected-secret', MULTILINE: 'one\ntwo' });
  assert.deepEqual(result, { containerId: 'new-container', name: 'app-web', state: 'running' });
  assert.deepEqual(creates[0].Env, ['API_KEY=protected-secret', 'MULTILINE=one\ntwo']);
  for (const key of imageFields) assert.deepEqual(creates[0][key], inspection.Config[key]);
  assert.equal(creates[0].Image, inspection.Config.Image);
  assert.deepEqual(events, ['backup-name', 'stop-old', 'create', 'start-new', 'commit-name', 'remove-old']);
  assert.equal(await readFile(path.join(service.appsDir, appId, '.env'), 'utf8'), 'API_KEY=protected-secret\nMULTILINE=one\\ntwo\n');
});

test('a delayed health failure can roll back a successfully started replacement', async () => {
  const { service, containers, inspection, events } = replacementFixture();
  const transaction = await service.beginContainerImageReplacement(serviceId, 'halfcloud/web:latest');
  assert.equal(transaction.containerId, 'new-container');
  assert.equal(transaction.name, 'app-web');
  assert.equal(transaction.state, 'running');
  assert.equal(containers.size, 2);
  assert.equal((await containers.get(inspection.Id).inspect()).State.Running, false);
  const next = await containers.get(transaction.containerId).inspect();
  next.State.Health.Status = 'unhealthy';
  const verified = await service.inspectContainer(serviceId);
  assert.equal(verified.health, 'unhealthy');
  assert.equal(verified.imageId, 'sha256:new-image');
  assert.equal(verified.image, 'halfcloud/web:latest');
  await transaction.rollback();
  await transaction.rollback();
  await assert.rejects(transaction.commit(), /already completed/);
  assert.equal(containers.size, 1);
  assert.equal((await service.inspectContainer(serviceId)).id, inspection.Id);
  assert.equal((await containers.get(inspection.Id).inspect()).Name, '/app-web');
  assert.equal((await containers.get(inspection.Id).inspect()).State.Running, true);
  assert.deepEqual(events.slice(-3), ['remove-new', 'start-old', 'restore-name']);
  assert.ok(!events.includes('remove-old'));
});

test('commit only deletes the backup, is idempotent, and prohibits later rollback', async () => {
  const { service, containers, events } = replacementFixture();
  const transaction = await service.beginContainerImageReplacement(serviceId, 'halfcloud/web:latest');
  const previousEvents = events.length;
  await transaction.commit();
  await transaction.commit();
  await assert.rejects(transaction.rollback(), /already completed/);
  assert.deepEqual(events.slice(previousEvents), ['commit-name', 'remove-old']);
  assert.deepEqual([...containers.keys()], ['new-container']);
});

test('several begun replacements can all be rolled back after one fails verification', async () => {
  const fixtures = [replacementFixture(), replacementFixture({ running: false, suffix: '-two' })];
  const service = combineReplacementFixtures(fixtures);
  const transactions = await Promise.all(fixtures.map(({ inspection }) => service.beginContainerImageReplacement(inspection.Config.Labels['halfcloud.service.id'], 'halfcloud/web:latest')));
  assert.ok(fixtures.every(({ containers }) => containers.size === 2));
  assert.equal((await service.listContainers(false)).length, 2);
  await Promise.all(transactions.map((transaction) => transaction.rollback()));
  for (const [index, { inspection, containers }] of fixtures.entries()) {
    assert.equal(containers.size, 1);
    assert.equal((await service.inspectContainer(inspection.Config.Labels['halfcloud.service.id'])).state, index === 0 ? 'running' : 'exited');
  }
});

test('backups are hidden from listing and service resolution, but exact old IDs remain accessible', async () => {
  const { service, inspection } = replacementFixture();
  await service.beginContainerImageReplacement(serviceId, 'halfcloud/web:latest');
  assert.deepEqual((await service.listContainers(false)).map(({ id }) => id), ['new-container']);
  assert.equal((await service.inspectContainer(serviceId)).id, 'new-container');
  assert.equal((await service.inspectContainer(inspection.Id)).id, inspection.Id);
  await assert.rejects(service.inspectContainer('old-cont'), /was not found/);
  await assert.rejects(service.beginContainerImageReplacement(serviceId, 'halfcloud/web:latest'), /already has a pending/);
  await assert.rejects(service.beginContainerImageReplacement(inspection.Id, 'halfcloud/web:latest'), /retained backup/);
});

test('image replacement rejects same-process initialization before changing the Service', async () => {
  const { service, inspection, containers, events } = replacementFixture();
  service.initializingServices.add(serviceId);
  await assert.rejects(service.beginContainerImageReplacement(serviceId, 'halfcloud/web:latest'), /initialization command is active/);
  assert.ok(events.every((event) => event.startsWith('inspect:')));
  assert.equal(containers.size, 1);
  assert.equal((await containers.get(inspection.Id).inspect()).Name, inspection.Name);
  assert.equal((await containers.get(inspection.Id).inspect()).State.Running, true);
});

for (const state of ['running', 'created', 'paused', 'restarting']) {
  test(`image replacement rejects a persisted ${state} initialization helper before stopping the Service`, async () => {
    const fixture = replacementFixture();
    const helper = addInitializationHelper(fixture, state);
    const { service, inspection, containers, events } = fixture;
    assert.equal(service.initializingServices.size, 0);
    await assert.rejects(service.beginContainerImageReplacement(serviceId, 'halfcloud/web:latest'), /initialization command is active/);
    assert.ok(events.every((event) => event.startsWith('inspect:')));
    assert.equal((await containers.get(inspection.Id).inspect()).Name, inspection.Name);
    assert.equal((await containers.get(inspection.Id).inspect()).State.Running, true);
    assert.ok(containers.has(helper.Id));
  });
}

for (const committed of [false, true]) {
  for (const state of ['running', 'exited']) {
    test(`recovery ignores an orphan ${state} initialization helper without deleting it (committed=${committed})`, async () => {
      const fixture = replacementFixture();
      const { service, inspection, containers } = fixture;
      await service.beginContainerImageReplacement(serviceId, 'halfcloud/web:latest');
      const helper = addInitializationHelper(fixture, state);
      const originalHelper = structuredClone(helper);
      const restarted = Object.create(DockerService.prototype);
      restarted.docker = service.docker;
      await restarted.recoverContainerReplacements(committed ? recoveryPlan(fixture) : undefined);
      assert.deepEqual([...containers.keys()].sort(), [committed ? 'new-container' : inspection.Id, helper.Id].sort());
      assert.deepEqual(await containers.get(helper.Id).inspect(), originalHelper);
      assert.equal((await restarted.inspectContainer(serviceId)).state, 'running');
    });
  }
}

test('an exited initialization helper does not prevent beginning or rolling back a replacement', async () => {
  const fixture = replacementFixture();
  const helper = addInitializationHelper(fixture, 'exited');
  const transaction = await fixture.service.beginContainerImageReplacement(serviceId, 'halfcloud/web:latest');
  await transaction.rollback();
  assert.deepEqual([...fixture.containers.keys()].sort(), [fixture.inspection.Id, helper.Id].sort());
});

test('initialization for another Service does not block replacement', async () => {
  const fixture = replacementFixture();
  const helper = addInitializationHelper(fixture);
  helper.Config.Labels['halfcloud.service.id'] = 'another-service';
  fixture.service.initializingServices.add('another-service');
  const transaction = await fixture.service.beginContainerImageReplacement(serviceId, 'halfcloud/web:latest');
  await transaction.rollback();
  assert.ok(fixture.containers.has(helper.Id));
});

for (const mismatch of ['operation', 'app', 'name', 'backup-name', 'managed']) {
  test(`recovery does not ignore an initialization lookalike with mismatched ${mismatch}`, async () => {
    const fixture = replacementFixture();
    await fixture.service.beginContainerImageReplacement(serviceId, 'halfcloud/web:latest');
    const helper = addInitializationHelper(fixture, 'exited');
    if (mismatch === 'operation') helper.Config.Labels['halfcloud.operation'] = 'unrelated';
    if (mismatch === 'app') helper.Config.Labels['halfcloud.app.id'] = 'another-app';
    if (mismatch === 'name') helper.Name = fixture.inspection.Name;
    if (mismatch === 'backup-name') helper.Name = (await fixture.containers.get(fixture.inspection.Id).inspect()).Name;
    if (mismatch === 'managed') helper.Config.Labels['halfcloud.managed'] = 'true';
    const before = fixture.events.length;
    await assert.rejects(fixture.service.recoverContainerReplacements(), /mismatched identity/);
    assert.equal(fixture.events.length, before);
    assert.equal(fixture.containers.size, 3);
  });
}

test('inspectContainer exposes healthcheck durations in milliseconds without exposing the command', async () => {
  const { service, inspection } = replacementFixture();
  inspection.Config.Healthcheck = {
    Test: ['CMD-SHELL', 'check --token protected-secret'], Interval: 45_000_000_000,
    StartPeriod: 90_000_000_000, StartInterval: 2_500_000_000, Retries: 7, Timeout: 8_000_000_000,
  };
  const result = await service.inspectContainer(serviceId);
  assert.deepEqual(result.healthcheck, { intervalMs: 45_000, startPeriodMs: 90_000, startIntervalMs: 2500, retries: 7, timeoutMs: 8000 });
  assert.ok(!JSON.stringify(result).includes('protected-secret'));
});

test('inspectContainer supplies Docker healthcheck defaults for omitted and zero timing values', async () => {
  const { service, inspection } = replacementFixture();
  for (const values of [{}, { Interval: 0, StartPeriod: 0, StartInterval: 0, Retries: 0, Timeout: 0 }]) {
    inspection.Config.Healthcheck = { Test: ['CMD', 'check'], ...values };
    assert.deepEqual((await service.inspectContainer(serviceId)).healthcheck, {
      intervalMs: 30_000, startPeriodMs: 0, startIntervalMs: 5000, retries: 3, timeoutMs: 30_000,
    });
  }
});

test('inspectContainer returns null timing for absent or disabled healthchecks', async () => {
  const { service, inspection } = replacementFixture();
  for (const healthcheck of [undefined, {}, { Test: [] }, { Test: ['NONE'], Interval: 30_000_000_000 }]) {
    inspection.Config.Healthcheck = healthcheck;
    assert.equal((await service.inspectContainer(serviceId)).healthcheck, null);
  }
});

for (const running of [true, false]) {
  test(`startup recovery restores an uncommitted replacement (original running=${running})`, async () => {
    const { service, containers, inspection } = replacementFixture({ running });
    await service.beginContainerImageReplacement(serviceId, 'halfcloud/web:latest');
    const restarted = Object.create(DockerService.prototype);
    restarted.docker = service.docker;
    await restarted.recoverContainerReplacements();
    await restarted.recoverContainerReplacements();
    assert.deepEqual([...containers.keys()], [inspection.Id]);
    const restored = await restarted.inspectContainer(serviceId);
    assert.equal(restored.id, inspection.Id);
    assert.equal(restored.state, running ? 'running' : 'exited');
    assert.equal((await containers.get(inspection.Id).inspect()).Name, '/app-web');
  });
}

for (const interrupted of [false, true]) {
  test(`a journal-committed two-Service group recovers pending replacements forward (interrupted=${interrupted})`, async () => {
    const fixtures = [replacementFixture(), replacementFixture({ suffix: '-two' })];
    const service = combineReplacementFixtures(fixtures);
    await Promise.all(fixtures.map(({ inspection }) => service.beginContainerImageReplacement(inspection.Config.Labels['halfcloud.service.id'], 'halfcloud/web:latest')));
    for (const { inspection, containers } of fixtures) assert.match((await containers.get(inspection.Id).inspect()).Name, /-pending$/);
    const restarted = Object.create(DockerService.prototype);
    restarted.docker = service.docker;
    const committedServices = recoveryPlan(fixtures);
    if (interrupted) {
      fixtures[1].failures.add('commit-name');
      await assert.rejects(restarted.recoverContainerReplacements(committedServices), /commit-name failed/);
      assert.deepEqual([...fixtures[0].containers.keys()], ['new-container']);
      assert.match((await fixtures[1].containers.get(fixtures[1].inspection.Id).inspect()).Name, /-pending$/);
      fixtures[1].failures.clear();
    }
    await restarted.recoverContainerReplacements(committedServices);
    await restarted.recoverContainerReplacements(committedServices);
    for (const { inspection, containers, events } of fixtures) {
      assert.equal(containers.size, 1);
      assert.ok(!containers.has(inspection.Id));
      const replacement = await restarted.inspectContainer(inspection.Config.Labels['halfcloud.service.id']);
      assert.equal(replacement.imageId, 'sha256:new-image');
      assert.equal(replacement.state, 'running');
      assert.ok(events.includes('remove-old'));
      assert.ok(!events.includes('remove-new'));
      assert.ok(!events.includes('start-old'));
      assert.ok(!events.includes('restore-name'));
    }
  });
}

for (const committed of [true, false]) {
  test(`App-scoped recovery leaves another active App untouched (committed=${committed})`, async () => {
    const otherAppId = 'app_abcdefab-1234-1234-1234-123456789abc';
    const fixtures = [replacementFixture(), replacementFixture({ suffix: '-other', ownerAppId: otherAppId })];
    const service = combineReplacementFixtures(fixtures);
    await Promise.all(fixtures.map(({ inspection }) => service.beginContainerImageReplacement(inspection.Config.Labels['halfcloud.service.id'], 'halfcloud/web:latest')));
    const otherEvents = [...fixtures[1].events];
    await service.recoverContainerReplacements(committed ? recoveryPlan(fixtures) : undefined, appId);
    assert.deepEqual([...fixtures[0].containers.keys()], [committed ? 'new-container' : 'old-container']);
    assert.equal(fixtures[1].containers.size, 2);
    assert.deepEqual(fixtures[1].events, otherEvents);
    assert.match((await fixtures[1].containers.get(fixtures[1].inspection.Id).inspect()).Name, /-pending$/);
    await service.recoverContainerReplacements(undefined, otherAppId);
    assert.deepEqual([...fixtures[1].containers.keys()], ['old-container-other']);
  });
}

test('committed Git recovery rolls an unrelated missing pending replacement back', async () => {
  const fixtures = [replacementFixture(), replacementFixture({ suffix: '-database' })];
  const service = combineReplacementFixtures(fixtures);
  await Promise.all(fixtures.map(({ inspection }) => service.beginContainerImageReplacement(inspection.Config.Labels['halfcloud.service.id'], 'halfcloud/web:latest')));
  fixtures[1].containers.delete('new-container-database');
  assert.deepEqual(await service.recoverContainerReplacements(recoveryPlan(fixtures[0])), []);
  assert.deepEqual([...fixtures[0].containers.keys()], ['new-container']);
  assert.deepEqual([...fixtures[1].containers.keys()], ['old-container-database']);
  assert.equal((await fixtures[1].containers.get('old-container-database').inspect()).Name, '/app-web-database');
});

test('explicit recovery restores a missing independently committed replacement', async () => {
  const fixture = replacementFixture();
  const transaction = await fixture.service.beginContainerImageReplacement(serviceId, 'halfcloud/web:latest');
  fixture.failures.add('remove-old');
  await assert.rejects(transaction.commit(), /remove-old failed/);
  fixture.failures.clear();
  fixture.containers.delete('new-container');
  const issues = await fixture.service.recoverContainerReplacements();
  assert.equal(issues.length, 1);
  assert.match((await fixture.containers.get('old-container').inspect()).Name, /-committed$/);
  await fixture.service.restoreMissingStandaloneReplacements(issues);
  assert.deepEqual([...fixture.containers.keys()], ['old-container']);
  assert.equal((await fixture.containers.get('old-container').inspect()).Name, '/app-web');
  assert.equal((await fixture.service.inspectContainer(serviceId)).state, 'running');
});

for (const failure of ['backup-name', 'backup-name-after', 'stop', 'create-after']) {
  test(`a ${failure} failure restores name and original running state`, async () => {
    const { service, containers, inspection, events } = replacementFixture({ failure });
    await assert.rejects(service.beginContainerImageReplacement(serviceId, 'halfcloud/web:latest'), new RegExp(`${failure} failed`));
    assert.deepEqual([...containers.keys()], [inspection.Id]);
    assert.equal((await containers.get(inspection.Id).inspect()).Name, '/app-web');
    assert.equal((await containers.get(inspection.Id).inspect()).State.Running, true);
    assert.ok(!events.includes('remove-old'));
  });
}

for (const failure of ['remove-new', 'start-old', 'restore-name']) {
  test(`rollback surfaces ${failure} failure and startup recovery can retry`, async () => {
    const { service, containers, inspection, failures } = replacementFixture();
    const transaction = await service.beginContainerImageReplacement(serviceId, 'halfcloud/web:latest');
    failures.add(failure);
    await assert.rejects(transaction.rollback(), new RegExp(`${failure} failed`));
    assert.match((await containers.get(inspection.Id).inspect()).Name, /-pending$/);
    failures.clear();
    const restarted = Object.create(DockerService.prototype);
    restarted.docker = service.docker;
    await restarted.recoverContainerReplacements();
    assert.equal((await restarted.inspectContainer(serviceId)).id, inspection.Id);
  });
}

test('automatic rollback reports both the original failure and the failed restoration', async () => {
  const { service, failures } = replacementFixture({ failure: 'start' });
  failures.add('start-old');
  await assert.rejects(service.beginContainerImageReplacement(serviceId, 'halfcloud/web:latest'), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /rollback failed.*start-old failed/);
    assert.deepEqual(error.errors.map(({ message }) => message), ['start failed', 'start-old failed']);
    return true;
  });
});

test('recovery handles a crash after journaling but before stop or creation', async () => {
  const { service, containers, creates, inspection } = replacementFixture();
  await service.beginContainerImageReplacement(serviceId, 'halfcloud/web:latest');
  containers.delete('new-container');
  await containers.get(inspection.Id).start();
  assert.match((await containers.get(inspection.Id).inspect()).Name, /-pending$/);
  await service.recoverContainerReplacements();
  assert.equal(creates.length, 1);
  assert.equal((await containers.get(inspection.Id).inspect()).Name, '/app-web');
  assert.equal((await service.inspectContainer(serviceId)).state, 'running');
});

for (const failure of ['remove-old', 'commit-name-after']) {
  test(`a durable commit survives ${failure} failure and process restart without rolling back`, async () => {
    const { service, containers, failures, events } = replacementFixture();
    const transaction = await service.beginContainerImageReplacement(serviceId, 'halfcloud/web:latest');
    failures.add(failure);
    await assert.rejects(transaction.commit(), new RegExp(`${failure} failed`));
    await assert.rejects(transaction.rollback(), /Cannot roll back a committed/);
    assert.deepEqual((await service.listContainers(false)).map(({ id }) => id), ['new-container']);
    failures.clear();
    const restarted = Object.create(DockerService.prototype);
    restarted.docker = service.docker;
    await restarted.recoverContainerReplacements();
    assert.deepEqual([...containers.keys()], ['new-container']);
    assert.ok(!events.includes('remove-new'));
    assert.ok(!events.includes('start-old'));
  });
}

test('failure to record a commit leaves the replacement rollbackable', async () => {
  const { service, failures } = replacementFixture();
  const transaction = await service.beginContainerImageReplacement(serviceId, 'halfcloud/web:latest');
  failures.add('commit-name');
  await assert.rejects(transaction.commit(), /commit-name failed/);
  await transaction.rollback();
  assert.equal((await service.inspectContainer(serviceId)).id, 'old-container');
});

for (const mismatch of ['halfcloud.managed', 'halfcloud.app.id', 'halfcloud.service.id', 'halfcloud.replacement.backup', 'name']) {
  test(`recovery fails closed on replacement ${mismatch} mismatch`, async () => {
    const { service, containers, events } = replacementFixture();
    await service.beginContainerImageReplacement(serviceId, 'halfcloud/web:latest');
    const next = await containers.get('new-container').inspect();
    if (mismatch === 'name') next.Name = '/unrelated';
    else next.Config.Labels[mismatch] = 'unrelated';
    const before = events.length;
    await assert.rejects(service.recoverContainerReplacements(), /mismatched identity/);
    assert.equal(containers.size, 2);
    assert.equal(events.length, before);
  });
}

test('recovery ignores unmanaged lookalikes and names outside the controlled convention', async () => {
  for (const managed of [true, false]) {
    const fixture = replacementFixture();
    const { service, containers, inspection, events } = fixture;
    const old = containers.get(inspection.Id);
    if (managed) await old.rename({ name: 'app-web-halfcloud-backup-123456' });
    else {
      await service.beginContainerImageReplacement(serviceId, 'halfcloud/web:latest');
      inspection.Config.Labels['halfcloud.managed'] = 'false';
    }
    const before = events.length;
    await service.recoverContainerReplacements(recoveryPlan(fixture));
    assert.equal(events.length, before);
    assert.deepEqual((await service.listContainers(false)).map(({ id }) => id), [managed ? inspection.Id : 'new-container']);
    if (managed) assert.equal((await service.inspectContainer(serviceId)).id, inspection.Id);
    else await assert.rejects(service.inspectContainer(inspection.Id), /was not found/);
  }
});

test('a committed group can recreate a missing replacement from its retained configuration', async () => {
  const fixture = replacementFixture();
  const { service, containers, events } = fixture;
  await service.beginContainerImageReplacement(serviceId, 'halfcloud/web:latest');
  containers.delete('new-container');
  const before = events.length;
  const issues = await service.recoverContainerReplacements(recoveryPlan(fixture));
  assert.deepEqual(issues.map(({ code, appId: owner, serviceId: service }) => ({ code, appId: owner, serviceId: service })), [{
    code: 'missing_replacement', appId, serviceId,
  }]);
  assert.equal(events.length, before);
  assert.match((await containers.get('old-container').inspect()).Name, /-pending$/);
  await service.recreateMissingContainerReplacement(issues[0], 'halfcloud/web:latest', 'sha256:new-image');
  assert.equal((await service.inspectContainer(serviceId)).id, 'new-container');
  assert.deepEqual(await service.recoverContainerReplacements(recoveryPlan(fixture)), []);
  assert.deepEqual([...containers.keys()], ['new-container']);
});

test('startup discards an interrupted unverified repair and retains the previous container', async () => {
  const fixture = replacementFixture();
  const { service, containers } = fixture;
  await service.beginContainerImageReplacement(serviceId, 'halfcloud/web:latest');
  containers.delete('new-container');
  const [issue] = await service.recoverContainerReplacements(recoveryPlan(fixture));
  await service.recreateMissingContainerReplacement(issue, 'halfcloud/web:latest', 'sha256:new-image');
  const issues = await service.recoverContainerReplacements(recoveryPlan(fixture, 'retain'), appId);
  assert.equal(issues.length, 1);
  assert.deepEqual([...containers.keys()], ['old-container']);
  assert.match((await containers.get('old-container').inspect()).Name, /-pending$/);
});

test('missing replacement repair refuses an active persisted initialization helper', async () => {
  const fixture = replacementFixture();
  await fixture.service.beginContainerImageReplacement(serviceId, 'halfcloud/web:latest');
  fixture.containers.delete('new-container');
  const [issue] = await fixture.service.recoverContainerReplacements(recoveryPlan(fixture));
  addInitializationHelper(fixture);
  await assert.rejects(
    fixture.service.recreateMissingContainerReplacement(issue, 'halfcloud/web:latest', 'sha256:new-image'),
    /initialization command is active/,
  );
  assert.deepEqual([...fixture.containers.keys()], ['old-container', 'initialization-helper']);
});

test('startup recovery propagates restoration errors and leaves the recovery marker intact', async () => {
  const { service, failures, containers } = replacementFixture();
  await service.beginContainerImageReplacement(serviceId, 'halfcloud/web:latest');
  failures.add('start-old');
  await assert.rejects(service.recoverContainerReplacements(), /start-old failed/);
  assert.match((await containers.get('old-container').inspect()).Name, /-pending$/);
  assert.deepEqual(await service.listContainers(false), []);
});

test('recovery refuses multiple backups claiming the same original name without changing either', async () => {
  const { service, containers, events } = replacementFixture();
  await service.beginContainerImageReplacement(serviceId, 'halfcloud/web:latest');
  const old = await containers.get('old-container').inspect();
  containers.set('duplicate', { async inspect() {
    return { ...old, Id: 'duplicate', Name: old.Name.replace(/-pending$/, '-committed') };
  } });
  const before = events.length;
  await assert.rejects(service.recoverContainerReplacements(), /Multiple replacement backups/);
  assert.equal(events.length, before);
});

test('replacement detects a moved image tag before starting the new container', async () => {
  const { service, nextConfig, events } = replacementFixture();
  service.docker.getImage = (image) => ({ async inspect() {
    return { Id: image === 'halfcloud/web:latest' ? 'sha256:chosen-image' : image, Config: nextConfig };
  } });
  await assert.rejects(service.beginContainerImageReplacement(serviceId, 'halfcloud/web:latest'), /image tag changed/);
  assert.ok(!events.includes('start-new'));
  assert.equal((await service.inspectContainer(serviceId)).id, 'old-container');
});

// Exercise Dockerode's actual packer, stopping at its HTTP boundary, without a Docker daemon or tar dependency.
for (const dockerfile of ['Dockerfile.halfcloud', 'deploy/Dockerfile.production']) {
  test(`Dockerode sends ${dockerfile} and .dockerignore even when ignored`, async (t) => {
    const context = await mkdtemp(path.join(tmpdir(), 'halfcloud-build-test-'));
    t.after(() => rm(context, { recursive: true, force: true }));
    const ignore = 'Dockerfile*\ndeploy\n.dockerignore\nsecret.txt\n';
    await mkdir(path.join(context, 'deploy'));
    await writeFile(path.join(context, dockerfile), 'FROM scratch\n');
    await writeFile(path.join(context, '.dockerignore'), ignore);
    await writeFile(path.join(context, 'secret.txt'), 'never send this\n');
    await writeFile(path.join(context, 'app.js'), 'console.log("application");\n');
    const packed = new Map();
    const docker = new Docker();
    docker.modem.dial = async ({ file }, callback) => {
      try {
        const chunks = [];
        for await (const chunk of file) chunks.push(chunk);
        const tar = gunzipSync(Buffer.concat(chunks));
        for (let offset = 0; offset + 512 <= tar.length && tar[offset];) {
          const header = tar.subarray(offset, offset + 512);
          const name = header.subarray(0, 100).toString().replace(/\0.*$/, '');
          const size = Number.parseInt(header.subarray(124, 136).toString().replace(/\0.*$/, '').trim(), 8) || 0;
          packed.set(name, tar.subarray(offset + 512, offset + 512 + size).toString());
          offset += 512 + Math.ceil(size / 512) * 512;
        }
        callback(null, Readable.from([]));
      } catch (error) { callback(error); }
    };
    const service = Object.create(DockerService.prototype);
    let snapshot;
    service.docker = {
      async buildImage(input, options) {
        snapshot = input.context;
        assert.notEqual(snapshot, context);
        // Skip only the BuildKit session handshake; use the real Dockerode archive implementation.
        return docker.buildImage(input, { ...options, version: '1' });
      },
      followProgress(stream, complete) { stream.resume(); stream.on('end', () => complete()); },
      getImage() { return { async inspect() { return { Id: 'sha256:built-image' }; } }; },
    };
    const result = await service.buildImage({ context, dockerfile, entries: ['app.js', 'secret.txt'], image: 'halfcloud/web:test' });
    assert.equal(result.imageId, 'sha256:built-image');
    assert.deepEqual([...packed.keys()].sort(), ['.dockerignore', 'app.js', dockerfile].sort());
    assert.equal(packed.get(dockerfile), 'FROM scratch\n');
    assert.ok(packed.get('.dockerignore').startsWith(ignore));
    assert.equal(await readFile(path.join(context, '.dockerignore'), 'utf8'), ignore);
    await assert.rejects(readFile(path.join(snapshot, '.dockerignore')), { code: 'ENOENT' });
  });
}

test('build context snapshot never reads a symlinked .dockerignore into the archive', async (t) => {
  const context = await mkdtemp(path.join(tmpdir(), 'halfcloud-build-test-'));
  t.after(() => rm(context, { recursive: true, force: true }));
  await writeFile(path.join(context, 'Dockerfile'), 'FROM scratch\n');
  await writeFile(path.join(context, 'secret'), 'protected-secret');
  await symlink('secret', path.join(context, '.dockerignore'));
  const service = Object.create(DockerService.prototype);
  service.docker = { async buildImage() { assert.fail('Unsafe context must not reach Docker'); } };
  await assert.rejects(service.buildImage({ context, dockerfile: 'Dockerfile', entries: ['Dockerfile'], image: 'halfcloud/web:test' }), /\.dockerignore must be a regular file/);
});
