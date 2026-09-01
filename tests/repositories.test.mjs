import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { mkdtemp } from 'node:fs/promises';
import { AppStore } from '../dist/backend/apps.js';
import { RepositoryService, normalizeRepositoryUrl, validatePublicGitUrl } from '../dist/backend/repositories.js';

const exec = promisify(execFile);

test('accepts public HTTPS Git URLs and rejects local or credential-bearing forms', () => {
  assert.equal(validatePublicGitUrl('https://github.com/example/project.git'), 'https://github.com/example/project.git');
  assert.throws(() => validatePublicGitUrl('git@github.com:example/project.git'), /Invalid Git repository URL/);
  assert.throws(() => validatePublicGitUrl('file:///tmp/project'), /must use an HTTPS URL/);
  assert.throws(() => validatePublicGitUrl('https://user:secret@example.com/project.git'), /cannot contain credentials/);
  assert.throws(() => validatePublicGitUrl('https://localhost/project.git'), /public host/);
});

test('normalizes common GitHub repository URLs and builds provider setup metadata', () => {
  assert.deepEqual(normalizeRepositoryUrl('https://github.com/example/private-app'), {
    originalUrl: 'https://github.com/example/private-app',
    gitUrl: 'git@github.com:example/private-app.git',
    provider: 'github',
    owner: 'example',
    repository: 'private-app',
    settingsUrl: 'https://github.com/example/private-app/settings/keys',
    requiresSsh: false,
  });
  assert.equal(normalizeRepositoryUrl('git@github.com:example/private-app.git').requiresSsh, true);
  assert.equal(normalizeRepositoryUrl('ssh://git@github.com/example/private-app.git').originalUrl, 'https://github.com/example/private-app.git');
  assert.throws(() => normalizeRepositoryUrl('ssh://root@github.com/example/private-app.git'), /must use git@github.com/);
  assert.throws(() => normalizeRepositoryUrl('https://github.com/example/private-app?token=secret'), /query parameters/);
});

test('creates one persistent restricted deploy key per App and reuses it', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-deploy-key-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const data = path.join(directory, 'data');
  const repositories = path.join(directory, 'repositories');
  const apps = new AppStore(data);
  const app = await apps.create('Private App', {
    source: { type: 'git', url: 'https://github.com/example/private-app' },
    deployment: { status: 'in_progress', stage: 'cloning', buildAttempts: 0, updatedAt: new Date().toISOString() },
  });
  const service = new RepositoryService(apps, repositories);

  const first = await service.preparePrivateAccess(app.id);
  const second = await service.preparePrivateAccess(app.id);
  const root = path.join(repositories, app.id);
  const privateKey = await readFile(path.join(root, 'id_ed25519'), 'utf8');
  const metadata = JSON.parse(await readFile(path.join(root, 'metadata.json'), 'utf8'));

  assert.equal(first.publicKey, second.publicKey);
  assert.match(first.publicKey, /^ssh-ed25519 /);
  assert.equal((await stat(path.join(root, 'id_ed25519'))).mode & 0o777, 0o600);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal(metadata.authentication, 'ssh-deploy-key');
  assert.equal(metadata.settingsUrl, 'https://github.com/example/private-app/settings/keys');
  assert.equal(JSON.stringify(first).includes(privateKey), false);
  assert.equal((await apps.get(app.id)).deployment.stage, 'awaiting_deploy_key');

  await service.delete(app.id);
  await assert.rejects(stat(root), (error) => error.code === 'ENOENT');
});

test('recovers a completed private checkout after restart before metadata was updated', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-private-resume-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const data = path.join(directory, 'data');
  const repositories = path.join(directory, 'repositories');
  const apps = new AppStore(data);
  const app = await apps.create('Interrupted Clone', {
    source: { type: 'git', url: 'https://github.com/example/private-app' },
    deployment: { status: 'in_progress', stage: 'cloning', updatedAt: new Date().toISOString() },
  });
  const service = new RepositoryService(apps, repositories);
  await service.preparePrivateAccess(app.id);
  const root = path.join(repositories, app.id);
  const metadataPath = path.join(root, 'metadata.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  await writeFile(metadataPath, `${JSON.stringify({ ...metadata, accessVerified: true })}\n`, { mode: 0o600 });
  const checkout = path.join(root, 'repository');
  await mkdir(checkout);
  await exec('git', ['init', '-b', 'develop'], { cwd: checkout });
  await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: checkout });
  await exec('git', ['config', 'user.name', 'Test'], { cwd: checkout });
  await writeFile(path.join(checkout, 'README.md'), '# App\n');
  await exec('git', ['add', 'README.md'], { cwd: checkout });
  await exec('git', ['commit', '-m', 'Initial'], { cwd: checkout });

  const result = await service.clonePrivate(app.id);

  assert.equal(result.existing, true);
  assert.equal(result.source.branch, 'develop');
  assert.match(result.source.resolvedCommit, /^[a-f0-9]{40}$/);
  assert.equal((await apps.get(app.id)).deployment.stage, 'inspecting');
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
