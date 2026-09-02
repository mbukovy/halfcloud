import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appNetworkName, assertManagedVolumeLabels, createOrReuseAppNetwork, createOrReuseManagedVolume, DockerService, managedBindPath, rootlessSocketPath, searchContainerImages, validateHostPort } from '../dist/backend/docker.js';

test('requires an explicit rootless user Docker socket', () => {
  assert.equal(rootlessSocketPath('unix:///run/user/1001/docker.sock'), '/run/user/1001/docker.sock');
  for (const endpoint of [undefined, 'unix:///var/run/docker.sock', 'tcp://127.0.0.1:2375', 'unix:///run/user/name/docker.sock']) {
    assert.throws(() => rootlessSocketPath(endpoint), /rootless Docker socket/);
  }
});

test('limits application publications to the managed port range', () => {
  validateHostPort(10000);
  validateHostPort(19999);
  for (const port of [80, 9999, 20000, 65535, 10000.5]) assert.throws(() => validateHostPort(port), /10000-19999/);
});

test('searches Docker Hub with supported filters and normalizes results', async () => {
  let searchOptions;
  const client = {
    async searchImages(options) {
      searchOptions = options;
      return [
        { name: 'filebrowser/filebrowser', description: 'Web file browser', star_count: 4100, is_official: false, is_automated: false },
        { name: 'library/low-stars', description: 'Not popular enough', star_count: 10, is_official: true },
        { name: 'library/unknown-stars', description: 'Popularity unavailable', is_official: true },
        { name: 'library/httpd', description: 'Apache HTTP Server', star_count: 5000, is_official: true, extra: 'ignored' },
      ];
    },
  };

  const results = await searchContainerImages(client, { query: '  file browser  ', limit: 5, minStars: 100, officialOnly: true });
  assert.deepEqual(searchOptions, {
    term: 'file browser',
    limit: 5,
    filters: { 'is-official': ['true'], stars: ['100'] },
  });
  assert.deepEqual(results, [{
    name: 'library/httpd',
    description: 'Apache HTTP Server',
    starCount: 5000,
    official: true,
    source: 'Docker Hub',
  }]);
});

test('defaults image search to ten results and handles empty results', async () => {
  let searchOptions;
  const results = await searchContainerImages({
    async searchImages(options) {
      searchOptions = options;
      return [];
    },
  }, { query: 'pastebin' });
  assert.deepEqual(searchOptions, { term: 'pastebin', limit: 10 });
  assert.deepEqual(results, []);
});

test('limits normalized image search results', async () => {
  const results = await searchContainerImages({
    async searchImages() {
      return Array.from({ length: 5 }, (_, index) => ({ name: `example/image-${index}`, is_official: false }));
    },
  }, { query: 'example', limit: 2 });
  assert.deepEqual(results.map((result) => result.name), ['example/image-0', 'example/image-1']);
});

test('validates image search inputs before calling Docker', async () => {
  const client = { async searchImages() { throw new Error('must not be called'); } };
  await assert.rejects(searchContainerImages(client, { query: '   ' }), /cannot be empty/);
  for (const limit of [0, 26, 1.5]) await assert.rejects(searchContainerImages(client, { query: 'postgres', limit }), /between 1 and 25/);
  for (const minStars of [-1, 1.5]) await assert.rejects(searchContainerImages(client, { query: 'postgres', minStars }), /non-negative integer/);
});

test('returns Docker image search failures as errors', async () => {
  const failure = new Error('registry unavailable');
  await assert.rejects(searchContainerImages({ async searchImages() { throw failure; } }, { query: 'uptime monitor' }), failure);
});

test('limits bind mounts to application-relative paths', () => {
  assert.equal(managedBindPath('/home/halfcloudrunner/.halfcloud/apps/demo', 'data'), '/home/halfcloudrunner/.halfcloud/apps/demo/data');
  for (const source of ['', '.', '/', '/etc', '../secrets', 'data/../../escape']) {
    assert.throws(() => managedBindPath('/home/halfcloudrunner/.halfcloud/apps/demo', source), /managed application directory/);
  }
});

test('accepts all required labels on a managed volume', () => {
  assert.doesNotThrow(() => assertManagedVolumeLabels({
    Name: 'halfcloud-n8n-data',
    Labels: { 'halfcloud.managed': 'true', 'halfcloud.application': 'n8n', 'halfcloud.volume': 'data' },
  }, 'n8n', 'data'));
  assert.throws(() => assertManagedVolumeLabels({
    Name: 'halfcloud-n8n-data',
    Labels: { 'halfcloud.application': 'n8n', 'halfcloud.volume': 'data' },
  }, 'n8n', 'data'), /not managed/);
});

test('inspects the dockerode volume handle before validating labels', async () => {
  let createOptions;
  const docker = {
    async createVolume(options) {
      createOptions = options;
      return { name: options.Name };
    },
    getVolume(name) {
      return {
        async inspect() {
          return {
            Name: name,
            Labels: { 'halfcloud.managed': 'true', 'halfcloud.application': 'n8n', 'halfcloud.volume': 'data' },
          };
        },
      };
    },
  };

  const volume = await createOrReuseManagedVolume(docker, 'n8n', 'data');
  assert.equal(volume.Name, 'halfcloud-n8n-data');
  assert.deepEqual(createOptions.Labels, {
    'halfcloud.managed': 'true',
    'halfcloud.application': 'n8n',
    'halfcloud.volume': 'data',
  });
});

test('finds orphaned managed volumes by their retained App ID', async () => {
  let listOptions;
  const service = Object.create(DockerService.prototype);
  service.docker = {
    async listVolumes(options) {
      listOptions = options;
      return { Volumes: [
        { Name: 'halfcloud-service_web-data', Labels: { 'halfcloud.managed': 'true', 'halfcloud.app.id': 'app_nextcloud', 'halfcloud.service.id': 'service_web', 'halfcloud.application': 'service_web', 'halfcloud.volume': 'data' }, Driver: 'local' },
        { Name: 'halfcloud-service_db-data', Labels: { 'halfcloud.managed': 'true', 'halfcloud.app.id': 'app_nextcloud', 'halfcloud.service.id': 'service_db', 'halfcloud.application': 'service_db', 'halfcloud.volume': 'data' }, Driver: 'local' },
      ] };
    },
    async listContainers() {
      return [{ Id: 'container-db', Names: ['/nextcloud-db'], Mounts: [{ Type: 'volume', Name: 'halfcloud-service_db-data' }] }];
    },
  };

  const volumes = await service.listManagedVolumes({ appId: 'app_nextcloud', orphaned: true });

  assert.deepEqual(listOptions, { filters: { label: ['halfcloud.managed=true', 'halfcloud.app.id=app_nextcloud'] } });
  assert.deepEqual(volumes.map((volume) => volume.name), ['halfcloud-service_web-data']);
  assert.equal(volumes[0].appId, 'app_nextcloud');
  assert.equal(volumes[0].serviceId, 'service_web');
  assert.equal(volumes[0].orphaned, true);
});

test('lists dangling volumes even when they have no HalfCloud labels', async () => {
  let listOptions;
  const service = Object.create(DockerService.prototype);
  service.docker = {
    async listVolumes(options) {
      listOptions = options;
      return { Volumes: [
        { Name: '2aef48b00b0d1367', Labels: {}, Driver: 'local' },
        { Name: 'halfcloud-mariadb-data', Labels: {}, Driver: 'local' },
      ] };
    },
    async listContainers() { return []; },
  };

  const volumes = await service.listDockerVolumes(true);

  assert.deepEqual(listOptions, { filters: { dangling: ['true'] } });
  assert.deepEqual(volumes.map((volume) => ({ name: volume.name, managed: volume.managedByHalfCloud, legacy: volume.legacyHalfCloudName, unused: volume.unused })), [
    { name: '2aef48b00b0d1367', managed: false, legacy: false, unused: true },
    { name: 'halfcloud-mariadb-data', managed: false, legacy: true, unused: true },
  ]);
});

test('deletes only a volume that Docker still reports as dangling', async () => {
  const removed = [];
  const service = Object.create(DockerService.prototype);
  service.docker = {
    async listVolumes() { return { Volumes: [{ Name: 'unused-volume' }] }; },
    getVolume(name) { return { async remove() { removed.push(name); } }; },
  };

  await service.deleteUnusedVolume('unused-volume');
  await assert.rejects(service.deleteUnusedVolume('attached-volume'), /not unused/);
  assert.deepEqual(removed, ['unused-volume']);
});

test('lists only images unused by running or stopped containers', async () => {
  const service = Object.create(DockerService.prototype);
  service.docker = {
    async listImages() {
      return [
        { Id: 'sha256:used', RepoTags: ['nextcloud:latest'], Size: 100, Created: 10 },
        { Id: 'sha256:unused', RepoTags: ['old-app:latest'], Size: 250, Created: 20 },
        { Id: 'sha256:dangling', RepoTags: ['<none>:<none>'], Size: 50, Created: 30 },
      ];
    },
    async listContainers() { return [{ ImageID: 'sha256:used' }]; },
  };

  const result = await service.listUnusedImages();

  assert.deepEqual(result.images.map((image) => ({ id: image.id, names: image.names })), [
    { id: 'sha256:unused', names: ['old-app:latest'] },
    { id: 'sha256:dangling', names: [] },
  ]);
  assert.equal(result.totalSize, 300);
});

test('prunes all images not referenced by an existing container', async () => {
  let pruneOptions;
  const service = Object.create(DockerService.prototype);
  service.docker = {
    async pruneImages(options) {
      pruneOptions = options;
      return { ImagesDeleted: [{ Deleted: 'sha256:unused' }], SpaceReclaimed: 4096 };
    },
  };

  assert.deepEqual(await service.pruneUnusedImages(), { deleted: 1, spaceReclaimed: 4096 });
  assert.deepEqual(pruneOptions, { filters: { dangling: ['false'] } });
});

test('creates an isolated managed bridge network for an App', async () => {
  let createOptions;
  let exists = false;
  const docker = {
    async createNetwork(options) {
      createOptions = options;
      exists = true;
    },
    getNetwork(name) {
      return {
        async inspect() {
          if (!exists) throw Object.assign(new Error('not found'), { statusCode: 404 });
          return { Name: name, Id: 'network-id', Driver: 'bridge', Labels: { 'halfcloud.managed': 'true', 'halfcloud.app.id': appId } };
        },
      };
    },
  };

  const appId = 'app_12345678-1234-1234-1234-123456789abc';
  const network = await createOrReuseAppNetwork(docker, appId);
  assert.equal(appNetworkName(appId), `halfcloud_${appId}`);
  assert.equal(network.Name, `halfcloud_${appId}`);
  assert.deepEqual(createOptions, {
    Name: `halfcloud_${appId}`,
    CheckDuplicate: true,
    Driver: 'bridge',
    Labels: { 'halfcloud.managed': 'true', 'halfcloud.app.id': appId },
  });
});

test('refuses to reuse a network not owned by the App', async () => {
  const docker = {
    async createNetwork() {},
    getNetwork(name) {
      return { async inspect() { return { Name: name, Id: 'other', Driver: 'bridge', Labels: { 'halfcloud.managed': 'true', 'halfcloud.app.id': 'app_00000000-0000-0000-0000-000000000000' } }; } };
    },
  };

  await assert.rejects(createOrReuseAppNetwork(docker, 'app_12345678-1234-1234-1234-123456789abc'), /not managed by HalfCloud/);
});

test('runs Service initialization in an isolated one-shot container with the same runtime state', async (t) => {
  const appsDir = await mkdtemp(path.join(tmpdir(), 'halfcloud-initialization-'));
  t.after(() => rm(appsDir, { recursive: true, force: true }));
  const appId = 'app_12345678-1234-1234-1234-123456789abc';
  const serviceId = 'service_12345678-1234-1234-1234-123456789abc';
  const bindSource = path.join(appsDir, appId, 'config');
  await mkdir(bindSource, { recursive: true });
  const sourceInspection = {
    Id: 'container-source',
    Image: 'sha256:immutable-image',
    State: { Running: true },
    Config: {
      Labels: {
        'halfcloud.managed': 'true',
        'halfcloud.app.id': appId,
        'halfcloud.service.id': serviceId,
        'halfcloud.service.name': 'web',
      },
      Env: ['API_KEY=protected-value', 'PORT=3000'],
      User: '1000:1000',
      WorkingDir: '/app',
    },
    HostConfig: { PidsLimit: 256 },
    NetworkSettings: { Networks: { [appNetworkName(appId)]: {} } },
    Mounts: [
      { Type: 'bind', Source: bindSource, Destination: '/app/config', RW: false },
      { Type: 'volume', Name: 'halfcloud-service-data', Source: '/var/lib/docker/volumes/data/_data', Destination: '/app/data', RW: true },
    ],
  };
  let createOptions;
  let started = 0;
  let removed = 0;
  const source = { async inspect() { return sourceInspection; } };
  const operation = {
    async start() { started += 1; },
    async wait() { return { StatusCode: 0 }; },
    async stop() { throw new Error('successful operation must not be stopped'); },
    async remove(options) { removed += 1; assert.deepEqual(options, { force: true, v: false }); },
  };
  const service = Object.create(DockerService.prototype);
  service.appsDir = appsDir;
  service.initializingServices = new Set();
  service.ensureAppNetwork = async (candidate) => {
    assert.equal(candidate, appId);
    return { name: appNetworkName(appId), driver: 'bridge' };
  };
  service.docker = {
    async listContainers() {
      return [{ Id: 'container-source', Names: ['/source'], Labels: sourceInspection.Config.Labels }];
    },
    getContainer(id) {
      assert.equal(id, 'container-source');
      return source;
    },
    async createContainer(options) {
      createOptions = options;
      return operation;
    },
  };

  const result = await service.runServiceInitializationCommand(serviceId, ['node', 'dist/setup.js', '--non-interactive']);

  assert.deepEqual(result, { serviceId, exitCode: 0, completed: true });
  assert.equal(started, 1);
  assert.equal(removed, 1);
  assert.equal(createOptions.Image, 'sha256:immutable-image');
  assert.deepEqual(createOptions.Entrypoint, ['node']);
  assert.deepEqual(createOptions.Cmd, ['dist/setup.js', '--non-interactive']);
  assert.deepEqual(createOptions.Env, sourceInspection.Config.Env);
  assert.equal(createOptions.User, '1000:1000');
  assert.equal(createOptions.WorkingDir, '/app');
  assert.deepEqual(createOptions.Labels, {
    'halfcloud.operation': 'service-initialization',
    'halfcloud.app.id': appId,
    'halfcloud.service.id': serviceId,
  });
  assert.equal(createOptions.Labels['halfcloud.managed'], undefined);
  assert.deepEqual(createOptions.HostConfig, {
    NetworkMode: appNetworkName(appId),
    PortBindings: {},
    PublishAllPorts: false,
    RestartPolicy: { Name: 'no' },
    LogConfig: { Type: 'none', Config: {} },
    SecurityOpt: ['no-new-privileges'],
    PidsLimit: 256,
    Mounts: [
      { Type: 'bind', Source: await realpath(bindSource), Target: '/app/config', ReadOnly: true },
      { Type: 'volume', Source: 'halfcloud-service-data', Target: '/app/data', ReadOnly: false },
    ],
  });
  assert.deepEqual(createOptions.NetworkingConfig, { EndpointsConfig: { [appNetworkName(appId)]: {} } });

  await service.runServiceInitializationCommand(serviceId, ['openclaw', 'devices', 'list'], 'service');
  assert.equal(createOptions.HostConfig.NetworkMode, 'container:container-source');
  assert.equal(createOptions.NetworkingConfig, undefined);

  service.initializingServices.add(serviceId);
  await assert.rejects(service.runServiceInitializationCommand(serviceId, ['setup']), /already running/);
  service.initializingServices.delete(serviceId);
});

test('cleans up a failed one-shot initialization without changing the source Service', async (t) => {
  const appsDir = await mkdtemp(path.join(tmpdir(), 'halfcloud-initialization-failure-'));
  t.after(() => rm(appsDir, { recursive: true, force: true }));
  const appId = 'app_12345678-1234-1234-1234-123456789abc';
  const serviceId = 'service_12345678-1234-1234-1234-123456789abc';
  await mkdir(path.join(appsDir, appId), { recursive: true });
  const labels = { 'halfcloud.managed': 'true', 'halfcloud.app.id': appId, 'halfcloud.service.id': serviceId, 'halfcloud.service.name': 'web' };
  let removed = 0;
  let sourceLifecycleCalls = 0;
  const source = {
    async inspect() {
      return {
        Image: 'sha256:image',
        Id: 'source',
        State: { Running: false },
        Config: { Labels: labels, Env: [] },
        HostConfig: { PidsLimit: 512 },
        NetworkSettings: { Networks: { [appNetworkName(appId)]: {} } },
        Mounts: [],
      };
    },
    async start() { sourceLifecycleCalls += 1; },
    async stop() { sourceLifecycleCalls += 1; },
  };
  const service = Object.create(DockerService.prototype);
  service.appsDir = appsDir;
  service.initializingServices = new Set();
  service.ensureAppNetwork = async () => ({ name: appNetworkName(appId), driver: 'bridge' });
  service.docker = {
    async listContainers() { return [{ Id: 'source', Labels: labels }]; },
    getContainer() { return source; },
    async createContainer() {
      return {
        async start() {},
        async wait() { return { StatusCode: 23 }; },
        async remove() { removed += 1; },
      };
    },
  };

  await assert.rejects(service.runServiceInitializationCommand(serviceId, ['setup']), /exit code 23/);
  assert.equal(removed, 1);
  assert.equal(sourceLifecycleCalls, 0);
  assert.equal(service.initializingServices.size, 0);
  await assert.rejects(service.runServiceInitializationCommand(serviceId, []), /1-32 bounded arguments/);
  await assert.rejects(service.runServiceInitializationCommand(serviceId, ['setup'], 'service'), /requires a running Service/);
});
