import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DockerService } from '../dist/backend/docker.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'halfcloud-storage-read-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appId = 'app_00000000-0000-4000-8000-000000000000';
  const storage = path.join(root, appId, 'data');
  await mkdir(storage, { recursive: true });
  const inspection = {
    Config: { Labels: { 'halfcloud.app.id': appId }, Env: ['TOKEN=secret-value'] },
    State: { Running: false },
    Mounts: [{ Type: 'volume', Name: 'halfcloud-service_original-data', Destination: '/data' }],
  };
  const service = Object.create(DockerService.prototype);
  service.appsDir = root;
  service.managedContainer = async () => ({ id: 'container', inspect: async () => inspection });
  service.managedVolume = async () => ({ Name: 'halfcloud-service_original-data', Labels: { 'halfcloud.app.id': appId } });
  const calls = [];
  let created;
  let result;
  service.docker = {
    getImage: () => ({ inspect: async () => ({}) }),
    createContainer: async (options) => {
      created = options;
      calls.push('create');
      return {
        start: async () => {
          calls.push('start-helper');
          const script = options.Cmd[1].replaceAll("'/halfcloud-storage'", JSON.stringify(storage));
          result = spawnSync(process.execPath, ['-e', script, ...options.Cmd.slice(2)], { encoding: 'utf8' });
        },
        wait: async () => ({ StatusCode: result.status }),
        logs: async () => Buffer.from(result.stdout),
        remove: async (options) => { calls.push(['remove', options]); },
      };
    },
  };
  return { service, inspection, storage, root, calls, created: () => created };
}

test('reads shared App volumes using a read-only isolated helper while the Service is stopped', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.storage, 'nested'));
  await writeFile(path.join(f.storage, 'nested', 'config.txt'), 'hello\nTOKEN=secret-value\n');
  const result = await f.service.readStorageFile('service_copy', '/data', 'nested/config.txt');
  assert.deepEqual(result, {
    containerId: 'container', mountTarget: '/data', path: 'nested/config.txt',
    content: 'hello\nTOKEN=[REDACTED]\n', bytes: 25, truncated: false,
  });
  const options = f.created();
  assert.equal(options.HostConfig.NetworkMode, 'none');
  assert.equal(options.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(options.HostConfig.CapDrop, ['ALL']);
  assert.deepEqual(options.Env, []);
  assert.equal(options.HostConfig.Mounts.length, 1);
  assert.equal(options.HostConfig.Mounts[0].ReadOnly, true);
  assert.equal(options.HostConfig.Mounts[0].VolumeOptions.NoCopy, true);
  assert.deepEqual(f.calls, ['create', 'start-helper', ['remove', { force: true, v: false }]]);
});

test('reads managed bind files with bounded UTF-8 output and redacts split secrets', async (t) => {
  const f = await fixture(t);
  f.inspection.Mounts = [{ Type: 'bind', Source: f.storage, Destination: '/data' }];
  await writeFile(path.join(f.storage, 'text'), 'hello 🌍 next');
  const result = await f.service.readStorageFile('service', '/data', 'text', 8);
  assert.equal(result.content, 'hello ');
  assert.equal(result.truncated, true);
  assert.equal(f.created().HostConfig.Mounts[0].Type, 'bind');
  await writeFile(path.join(f.storage, 'text'), 'TOKEN=secret-value');
  assert.equal((await f.service.readStorageFile('service', '/data', 'text', 10)).content, 'TOKEN=[REDACTED]');
});

test('rejects traversal, invalid limits, sensitive paths and unmounted targets before helper creation', async (t) => {
  const f = await fixture(t);
  for (const file of ['', '/etc/passwd', '../secret', 'a/../secret', 'a\\secret', 'a\0b', 'a//b', '.env', 'nested/id_rsa', 'key.pem']) {
    await assert.rejects(f.service.readStorageFile('service', '/data', file));
  }
  for (const limit of [0, 65_537, 1.5, NaN]) await assert.rejects(f.service.readStorageFile('service', '/data', 'text', limit), /limit/);
  await assert.rejects(f.service.readStorageFile('service', '/other', 'text'), /does not have storage/);
  assert.deepEqual(f.calls, []);
});

test('rejects foreign volumes, unmanaged storage and bind mounts outside the App', async (t) => {
  const f = await fixture(t);
  f.service.managedVolume = async () => ({ Labels: { 'halfcloud.app.id': 'app_foreign' } });
  await assert.rejects(f.service.readStorageFile('service', '/data', 'text'), /not owned/);
  f.inspection.Mounts[0].Type = 'tmpfs';
  await assert.rejects(f.service.readStorageFile('service', '/data', 'text'), /Only managed/);
  f.inspection.Mounts = [{ Type: 'bind', Source: f.root, Destination: '/data' }];
  await assert.rejects(f.service.readStorageFile('service', '/data', 'text'), /outside/);
  assert.deepEqual(f.calls, []);
});

test('rejects symlink files and directories, binary files, directories and missing files and cleans helpers', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'outside'), 'private');
  await symlink(path.join(f.root, 'outside'), path.join(f.storage, 'link'));
  await symlink(f.root, path.join(f.storage, 'escape'));
  await writeFile(path.join(f.storage, 'binary'), Buffer.from([0, 1, 2]));
  await writeFile(path.join(f.storage, 'invalid-utf8'), Buffer.from([255]));
  await mkdir(path.join(f.storage, 'directory'));
  for (const file of ['link', 'escape/outside', 'binary', 'invalid-utf8', 'directory', 'missing']) {
    await assert.rejects(f.service.readStorageFile('service', '/data', file), /Cannot read storage file/);
    assert.deepEqual(f.calls.at(-1), ['remove', { force: true, v: false }]);
  }
});

test('cleans up the helper after a Docker start failure', async (t) => {
  const f = await fixture(t);
  let removed = false;
  f.service.docker.createContainer = async () => ({
    start: async () => { throw new Error('start failed'); },
    remove: async () => { removed = true; },
  });
  await assert.rejects(f.service.readStorageFile('service', '/data', 'text'), /start failed/);
  assert.equal(removed, true);
});
