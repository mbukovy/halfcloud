import assert from 'node:assert/strict';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { AppStore } from '../dist/backend/apps.js';
import { RepositoryService, validatePublicGitUrl } from '../dist/backend/repositories.js';

test('accepts public HTTPS Git URLs and rejects local or credential-bearing forms', () => {
  assert.equal(validatePublicGitUrl('https://github.com/example/project.git'), 'https://github.com/example/project.git');
  assert.throws(() => validatePublicGitUrl('git@github.com:example/project.git'), /Invalid Git repository URL/);
  assert.throws(() => validatePublicGitUrl('file:///tmp/project'), /must use an HTTPS URL/);
  assert.throws(() => validatePublicGitUrl('https://user:secret@example.com/project.git'), /cannot contain credentials/);
  assert.throws(() => validatePublicGitUrl('https://localhost/project.git'), /public host/);
});

test('rejects Git hosts that resolve to non-public address space before cloning', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-git-network-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const data = path.join(directory, 'data');
  const repositories = path.join(directory, 'repositories');
  const apps = new AppStore(data);
  const app = await apps.create('Private Target', {
    source: { type: 'git', url: 'https://git.example.test/project.git' },
    deployment: { status: 'in_progress', stage: 'cloning', buildAttempts: 0, updatedAt: new Date().toISOString() },
  });
  const service = new RepositoryService(apps, repositories, async () => [{ address: '100.64.0.1' }]);

  await assert.rejects(service.clone(app.id, app.source.url), (error) => error.code === 'not_public');
});

test('persists Git source and deployment metadata without changing App identity', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-git-app-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const apps = new AppStore(directory);
  const commit = 'a'.repeat(40);
  const app = await apps.create('Source App', {
    source: { type: 'git', url: 'https://example.com/team/project.git', branch: 'main', resolvedCommit: commit },
    deployment: { status: 'in_progress', stage: 'planning', buildAttempts: 0, updatedAt: new Date().toISOString() },
  });

  const updated = await apps.update(app.id, {
    source: { ...app.source, currentCommit: commit },
    deployment: { status: 'running', stage: 'running', message: 'Deployment complete', buildAttempts: 1, image: 'halfcloud/app:test', updatedAt: new Date().toISOString() },
  });

  assert.equal(updated.id, app.id);
  assert.equal((await apps.get(app.id)).source.currentCommit, commit);
  assert.equal((await apps.get(app.id)).deployment.status, 'running');
});

test('inspects a bounded checkout and confines repository reads and deployment writes', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-repository-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const data = path.join(directory, 'data');
  const repositories = path.join(directory, 'repositories');
  const apps = new AppStore(data);
  const commit = 'b'.repeat(40);
  const app = await apps.create('Project', {
    source: { type: 'git', url: 'https://example.com/team/project.git', branch: 'trunk', resolvedCommit: commit },
    deployment: { status: 'in_progress', stage: 'inspecting', buildAttempts: 0, updatedAt: new Date().toISOString() },
  });
  const checkout = path.join(repositories, app.id, 'repository');
  await mkdir(path.join(checkout, 'src'), { recursive: true });
  await mkdir(path.join(checkout, 'node_modules', 'ignored'), { recursive: true });
  await mkdir(path.join(checkout, '.git'), { recursive: true });
  await writeFile(path.join(checkout, 'halfcloud.md'), '# Deploy\nUse port 3000.\n');
  await writeFile(path.join(checkout, 'README.md'), '# Project\n');
  await writeFile(path.join(checkout, 'package.json'), '{"scripts":{"start":"node src/index.js"}}\n');
  await writeFile(path.join(checkout, 'Dockerfile'), 'FROM node:22-alpine\nCOPY . .\n');
  await writeFile(path.join(checkout, '.env'), 'SECRET=hidden\n');
  await writeFile(path.join(checkout, 'src', 'index.js'), 'console.log("ready")\n');
  await writeFile(path.join(checkout, 'src', 'private.key'), 'not-for-the-agent\n');
  await writeFile(path.join(checkout, 'node_modules', 'ignored', 'dependency.js'), 'ignored\n');
  await writeFile(path.join(directory, 'outside.txt'), 'outside\n');
  await symlink(path.join(directory, 'outside.txt'), path.join(checkout, 'outside-link'));
  const service = new RepositoryService(apps, repositories);

  const inspection = await service.inspect(app.id);
  assert.equal(inspection.files[0].path, 'halfcloud.md');
  assert.match(inspection.tree, /src\//);
  assert.doesNotMatch(inspection.tree, /node_modules/);
  assert.equal((await service.readFile(app.id, 'src/index.js')).content, 'console.log("ready")\n');
  await assert.rejects(service.readFile(app.id, '.env'), /cannot be read/);
  await assert.rejects(service.readFile(app.id, 'outside-link'), /escapes the managed checkout/);
  await assert.rejects(service.readFile(app.id, '../outside.txt'), /cannot contain traversal/);
  await assert.rejects(service.writeDeploymentFile(app.id, 'src/index.js', 'changed'), /only Dockerfile variants/);

  const generated = await service.writeDeploymentFile(app.id, 'Dockerfile.halfcloud', 'FROM scratch\n');
  assert.equal(generated.path, 'Dockerfile.halfcloud');
  assert.equal(generated.bytes, 13);
});

test('prepares a bounded Docker context without Git metadata or likely secret files', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-build-context-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const data = path.join(directory, 'data');
  const repositories = path.join(directory, 'repositories');
  const apps = new AppStore(data);
  const commit = 'c'.repeat(40);
  const app = await apps.create('Build Project', {
    source: { type: 'git', url: 'https://example.com/project.git', branch: 'main', resolvedCommit: commit },
    deployment: { status: 'in_progress', stage: 'planning', buildAttempts: 0, updatedAt: new Date().toISOString() },
  });
  const checkout = path.join(repositories, app.id, 'repository');
  await mkdir(path.join(checkout, '.git'), { recursive: true });
  await mkdir(path.join(checkout, 'config'), { recursive: true });
  await writeFile(path.join(checkout, 'Dockerfile.halfcloud'), 'FROM scratch\n');
  await writeFile(path.join(checkout, 'app.txt'), 'application\n');
  await writeFile(path.join(checkout, '.env'), 'ROOT_SECRET=yes\n');
  await writeFile(path.join(checkout, 'config', '.env.production'), 'NESTED_SECRET=yes\n');
  await writeFile(path.join(checkout, 'config', 'server.pem'), 'KEY\n');
  await writeFile(path.join(checkout, '.git', 'config'), 'git metadata\n');
  const service = new RepositoryService(apps, repositories);

  const context = await service.buildContext(app.id, '.', 'Dockerfile.halfcloud');
  assert.equal(context.commit, commit);
  assert.match(context.image, /^halfcloud\/app-[a-f0-9]+:c{12}-1$/);
  assert.deepEqual(context.entries.sort(), ['Dockerfile.halfcloud', 'app.txt']);
  assert.equal((await apps.get(app.id)).deployment.stage, 'building');
  assert.equal((await apps.get(app.id)).deployment.buildAttempts, 1);
});
