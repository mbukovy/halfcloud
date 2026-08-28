import assert from 'node:assert/strict';
import test from 'node:test';
import { appNetworkName, assertManagedVolumeLabels, createOrReuseAppNetwork, createOrReuseManagedVolume, managedBindPath, rootlessSocketPath, validateHostPort } from '../dist/backend/docker.js';

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
