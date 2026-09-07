import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appNetworkName, DockerService } from '../dist/backend/docker.js';

const appId = 'app_12345678-1234-1234-1234-123456789abc';
const serviceId = 'service_12345678-1234-1234-1234-123456789abc';
const network = appNetworkName(appId);
const imageFields = ['Cmd', 'Entrypoint', 'User', 'WorkingDir', 'Healthcheck'];

function replacementFixture({ running = true, failure } = {}) {
  const previousConfig = {
    Cmd: ['old-server'], Entrypoint: ['/old-entrypoint'], User: '1000', WorkingDir: '/old-app',
    Healthcheck: { Test: ['CMD', 'old-check'], Interval: 30_000_000_000 },
  };
  const nextConfig = {
    Cmd: ['new-server'], Entrypoint: ['/new-entrypoint'], User: '2000', WorkingDir: '/new-app',
    Healthcheck: { Interval: 60_000_000_000, Test: ['CMD', 'new-check'] },
  };
  const inspection = {
    Id: 'old-container', Name: '/app-web', Image: 'sha256:old-image', State: { Running: running },
    Config: {
      ...structuredClone(previousConfig), Image: 'halfcloud/web:latest',
      Hostname: 'web-host', Domainname: 'internal', Tty: true, OpenStdin: true,
      StopSignal: 'SIGQUIT', StopTimeout: 25,
      Labels: { 'halfcloud.managed': 'true', 'halfcloud.app.id': appId, 'halfcloud.service.id': serviceId, 'halfcloud.service.name': 'web', 'halfcloud.hostname': 'web.example.com' },
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
  const old = {
    async inspect() { return inspection; },
    async stop(options) { assert.deepEqual(options, { t: 10 }); events.push('stop-old'); },
    async rename({ name }) { events.push(name === 'app-web' ? 'restore-name' : 'backup-name'); },
    async start() { events.push('start-old'); },
    async remove(options) { assert.deepEqual(options, { force: true, v: false }); events.push('remove-old'); },
  };
  const service = Object.create(DockerService.prototype);
  service.docker = {
    async listContainers() { return [{ Id: inspection.Id, Names: [inspection.Name], Labels: inspection.Config.Labels }]; },
    getContainer(id) { assert.equal(id, inspection.Id); return old; },
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
      return { async inspect() { return { Name: network, Driver: 'bridge', Labels: { 'halfcloud.managed': 'true', 'halfcloud.app.id': appId } }; } };
    },
    async createContainer(options) {
      creates.push(options);
      events.push('create');
      if (failure === 'create') throw new Error('create failed');
      return {
        id: 'new-container',
        async start() { events.push('start-new'); if (failure === 'start') throw new Error('start failed'); },
        async remove(options) { assert.deepEqual(options, { force: true, v: false }); events.push('remove-new'); },
      };
    },
  };
  return { service, inspection, previousConfig, nextConfig, events, creates };
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
    HostConfig: inspection.HostConfig,
    NetworkingConfig: { EndpointsConfig: {
      [network]: { Aliases: ['web', 'web-alias'], IPAMConfig: { IPv4Address: '172.20.0.10' }, DriverOpts: { custom: 'option' }, Links: undefined },
      secondary: { Aliases: ['secondary-web'], Links: ['db:db'], IPAMConfig: null, DriverOpts: undefined },
    } },
  });
  assert.deepEqual(events, ['inspect:halfcloud/web:latest', 'inspect:sha256:old-image', 'stop-old', 'backup-name', 'create', 'start-new', 'remove-old']);
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
  assert.deepEqual(events, ['inspect:halfcloud/web:latest', 'inspect:sha256:old-image', 'backup-name', 'create', 'remove-old']);
});

for (const failure of ['create', 'start']) {
  test(`image replacement rolls back after ${failure} failure without deleting the old container or volumes`, async () => {
    const { service, events } = replacementFixture({ failure });
    await assert.rejects(service.replaceContainerImage(serviceId, 'halfcloud/web:latest'), new RegExp(`${failure} failed`));
    assert.deepEqual(events, [
      'inspect:halfcloud/web:latest', 'inspect:sha256:old-image', 'stop-old', 'backup-name', 'create',
      ...(failure === 'start' ? ['start-new', 'remove-new'] : []), 'restore-name', 'start-old',
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
  assert.deepEqual(events, ['stop-old', 'backup-name', 'create', 'start-new', 'remove-old']);
  assert.equal(await readFile(path.join(service.appsDir, appId, '.env'), 'utf8'), 'API_KEY=protected-secret\nMULTILINE=one\\ntwo\n');
});
