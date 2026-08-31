import assert from 'node:assert/strict';
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
