import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { mkdtemp } from 'node:fs/promises';
import { AppStore } from '../dist/backend/apps.js';
import { RepositoryService, normalizeRepositoryUrl, validatePublicGitUrl } from '../dist/backend/repositories.js';

const exec = promisify(execFile);
const uuidTag = /:[a-f0-9]{12}-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const imageId = `sha256:${'a'.repeat(64)}`;

async function recipeFixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-recipes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const data = path.join(directory, 'data');
  const apps = new AppStore(data);
  const app = await apps.create('Recipe App', {
    source: { type: 'git', url: 'https://example.com/project.git', branch: 'main', resolvedCommit: 'a'.repeat(40) },
    deployment: { status: 'in_progress', stage: 'planning', buildAttempts: 0, updatedAt: new Date().toISOString() },
  });
  const repositories = path.join(directory, 'repositories');
  const root = path.join(repositories, app.id);
  const checkout = path.join(root, 'repository');
  await mkdir(path.join(checkout, 'web', 'docker'), { recursive: true });
  await writeFile(path.join(checkout, 'web', 'docker', 'Dockerfile'), 'FROM scratch\nCOPY . /app\n');
  await writeFile(path.join(checkout, 'web', '.dockerignore'), 'root-only.txt\n');
  await writeFile(path.join(checkout, 'web', 'docker', 'Dockerfile.dockerignore'), 'specific-only.txt\n');
  await writeFile(path.join(checkout, 'web', 'app.txt'), 'old source\n');
  const service = new RepositoryService(apps, repositories);
  return { directory, data, apps, app, repositories, root, checkout, service };
}

async function refreshFixture(t, privateAccess = false) {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-git-refresh-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const remote = path.join(directory, 'remote');
  await mkdir(remote);
  await exec('git', ['init', '-b', 'main'], { cwd: remote });
  const commit = async (content) => {
    await writeFile(path.join(remote, 'README.md'), content);
    await exec('git', ['add', '.'], { cwd: remote });
    await exec('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', content], { cwd: remote });
    return (await exec('git', ['rev-parse', 'HEAD'], { cwd: remote })).stdout.trim();
  };
  const previousCommit = await commit('Initial');
  const apps = new AppStore(path.join(directory, 'data'));
  const app = await apps.create('Existing Git App', {
    source: { type: 'git', url: 'https://github.com/example/project.git', branch: 'main', resolvedCommit: previousCommit, currentCommit: previousCommit },
    deployment: { status: 'running', stage: 'running', buildAttempts: 2, image: 'halfcloud/app:old', updatedAt: new Date().toISOString() },
  });
  const repositories = path.join(directory, 'repositories');
  const root = path.join(repositories, app.id);
  const checkout = path.join(root, 'repository');
  await mkdir(root, { recursive: true });
  await exec('git', ['clone', remote, checkout]);
  const calls = [];
  const service = new RepositoryService(apps, repositories, async () => [{ address: '140.82.112.3' }], async (args, cwd, timeout, limitedCheckout, environment) => {
    calls.push({ args, cwd, timeout, limitedCheckout, environment });
    const actual = [...args];
    const fetch = actual.indexOf('fetch');
    if (fetch !== -1) {
      // Substitute only the transport in tests; checkout and fetch still use real Git.
      actual[actual.length - 2] = remote;
      actual.splice(fetch, 0, '-c', 'protocol.file.allow=always');
    }
    return exec('git', actual, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  });
  if (privateAccess) {
    await service.preparePrivateAccess(app.id);
    const prepared = await apps.get(app.id);
    await apps.update(app.id, { source: { ...prepared.source, ...app.source, authentication: 'ssh-deploy-key' }, deployment: app.deployment });
  }
  return { apps, app, service, commit, remote, root, checkout, calls, previousCommit, repositories };
}

test('refreshes the tracked public branch in place while retaining deployment files and deployed commit', async (t) => {
  const { apps, app, service, commit, remote, checkout, calls, previousCommit } = await refreshFixture(t);
  await service.writeDeploymentFile(app.id, 'Dockerfile.halfcloud', 'FROM scratch\n');
  await service.writeDeploymentFile(app.id, '.dockerignore', '.git\n');
  const latest = await commit('Latest main');
  await exec('git', ['checkout', '-b', 'different-default'], { cwd: remote });
  await commit('Do not deploy this branch');

  const result = await service.refresh(app.id);

  assert.equal(result.appId, app.id);
  assert.equal(result.changed, true);
  assert.equal(result.source.branch, 'main');
  assert.equal(result.source.resolvedCommit, latest);
  assert.equal(result.source.currentCommit, previousCommit);
  assert.equal((await exec('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: checkout })).stdout.trim(), 'main');
  assert.equal(await readFile(path.join(checkout, 'README.md'), 'utf8'), 'Latest main');
  assert.equal(await readFile(path.join(checkout, 'Dockerfile.halfcloud'), 'utf8'), 'FROM scratch\n');
  assert.equal(await readFile(path.join(checkout, '.dockerignore'), 'utf8'), '.git\n');
  const updated = await apps.get(app.id);
  assert.equal(updated.deployment.buildAttempts, 0);
  assert.equal(updated.deployment.image, undefined);
  assert.equal(updated.deployment.stage, 'inspecting');
  const fetch = calls.find(({ args }) => args.includes('fetch'));
  assert.deepEqual(fetch.args.slice(-2), [app.source.url, 'refs/heads/main']);
  assert.ok(fetch.args.includes('http.curloptResolve=github.com:443:140.82.112.3'));
  assert.ok(fetch.args.includes('protocol.file.allow=never'));
  assert.ok(fetch.args.includes('core.hooksPath=/dev/null'));
  assert.ok(fetch.args.includes('--no-recurse-submodules'));
  assert.equal(fetch.limitedCheckout, checkout);

  await apps.update(app.id, { deployment: { ...updated.deployment, buildAttempts: 3, status: 'failed', stage: 'failed', errorCode: 'build_failed' } });
  const unchanged = await apps.get(app.id);
  assert.equal((await service.refresh(app.id)).changed, false);
  assert.deepEqual(await apps.get(app.id), unchanged, 'refreshing the same commit must not reset retry limits');
});

test('refreshes private repositories with the existing deploy key and pinned host identity', async (t) => {
  const { apps, app, service, commit, root, calls } = await refreshFixture(t, true);
  const key = await readFile(path.join(root, 'id_ed25519'), 'utf8');
  const latest = await commit('Private update');
  const result = await service.refresh(app.id);
  assert.equal(result.source.resolvedCommit, latest);
  assert.equal(result.source.authentication, 'ssh-deploy-key');
  assert.equal(await readFile(path.join(root, 'id_ed25519'), 'utf8'), key);
  assert.ok(calls.every(({ environment }) => environment.GIT_SSH_COMMAND.includes('ssh -F')));
  assert.ok(calls.every(({ environment }) => environment.SSH_AUTH_SOCK === ''));
  assert.deepEqual(calls.find(({ args }) => args.includes('fetch')).args.slice(-2), ['git@github.com:example/project.git', 'refs/heads/main']);
  assert.match(await readFile(path.join(root, 'ssh_config'), 'utf8'), /StrictHostKeyChecking yes/);
  assert.equal(JSON.stringify(result).includes(key), false);
  assert.equal((await apps.get(app.id)).source.currentCommit, app.source.currentCommit);
});

test('refreshes to the exact remote branch tip even after its history was replaced', async (t) => {
  const { app, service, commit, remote, checkout } = await refreshFixture(t);
  await exec('git', ['checkout', '--orphan', 'replacement'], { cwd: remote });
  const latest = await commit('Replaced history');
  await exec('git', ['branch', '-M', 'main'], { cwd: remote });
  assert.equal((await service.refresh(app.id)).source.resolvedCommit, latest);
  assert.equal((await exec('git', ['rev-parse', 'HEAD'], { cwd: checkout })).stdout.trim(), latest);
});

test('refuses conflicting local changes and missing branches without advancing deployment state', async (t) => {
  const { apps, app, service, commit, checkout, previousCommit } = await refreshFixture(t);
  await writeFile(path.join(checkout, 'README.md'), 'Local changes');
  await commit('Conflicting remote change');
  await assert.rejects(service.refresh(app.id), /overwritten|commit your changes|Aborting/i);
  assert.equal(await readFile(path.join(checkout, 'README.md'), 'utf8'), 'Local changes');
  assert.equal((await exec('git', ['rev-parse', 'HEAD'], { cwd: checkout })).stdout.trim(), previousCommit);
  assert.deepEqual(await apps.get(app.id), app);

  const missing = await apps.update(app.id, { source: { ...app.source, branch: 'missing' } });
  await assert.rejects(service.refresh(app.id), /remote ref/);
  assert.deepEqual(await apps.get(app.id), missing);
});

test('revalidates public DNS on refresh and never contacts a private address', async (t) => {
  const { apps, app, repositories } = await refreshFixture(t);
  const service = new RepositoryService(apps, repositories, async () => [{ address: '127.0.0.1' }], async () => assert.fail('Git must not run'));
  await assert.rejects(service.refresh(app.id), (error) => error.code === 'not_public');
  assert.deepEqual(await apps.get(app.id), app);
});

test('does not overwrite an ignored local deployment file introduced by the remote', async (t) => {
  const { apps, app, service, commit, remote, checkout } = await refreshFixture(t);
  await writeFile(path.join(checkout, '.git', 'info', 'exclude'), 'Dockerfile.halfcloud\n');
  await service.writeDeploymentFile(app.id, 'Dockerfile.halfcloud', 'FROM local-image\n');
  const before = await apps.get(app.id);
  await writeFile(path.join(remote, 'Dockerfile.halfcloud'), 'FROM upstream-image\n');
  await commit('Add upstream Dockerfile');

  await assert.rejects(service.refresh(app.id), /overwritten|Aborting/i);
  assert.equal(await readFile(path.join(checkout, 'Dockerfile.halfcloud'), 'utf8'), 'FROM local-image\n');
  assert.deepEqual(await apps.get(app.id), before);
});

test('accepts public HTTPS Git URLs and rejects local or credential-bearing forms', () => {
  assert.equal(validatePublicGitUrl('https://github.com/example/project.git'), 'https://github.com/example/project.git');
  assert.throws(() => validatePublicGitUrl('git@github.com:example/project.git'), /Invalid Git repository URL/);
  assert.throws(() => validatePublicGitUrl('file:///tmp/project'), /must use an HTTPS URL/);
  assert.throws(() => validatePublicGitUrl('https://user:secret@example.com/project.git'), /cannot contain credentials/);
  assert.throws(() => validatePublicGitUrl('https://localhost/project.git'), /public host/);
});

test('successful Service builds do not exhaust the retry budget for later Services', async (t) => {
  const { apps, app, service, checkout } = await refreshFixture(t);
  await writeFile(path.join(checkout, 'Dockerfile'), 'FROM scratch\n');
  for (let index = 0; index < 4; index++) {
    const build = await service.buildContext(app.id);
    try {
      await service.buildSucceeded(app.id, build.image);
      assert.equal((await apps.get(app.id)).deployment.buildAttempts, 0);
    } finally {
      await build.cleanup();
    }
  }
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
  assert.match(context.image, /^halfcloud\/app-[a-f0-9]+:c{12}-/);
  assert.match(context.image, uuidTag);
  assert.deepEqual(context.recipe, { contextPath: '.', dockerfilePath: 'Dockerfile.halfcloud', dockerfileContent: 'FROM scratch\n', dockerignoreContent: '' });
  assert.notEqual(context.context, checkout);
  assert.deepEqual(context.entries.sort(), ['.dockerignore', 'Dockerfile.halfcloud', 'app.txt']);
  assert.equal(await readFile(path.join(context.context, '.dockerignore'), 'utf8'), '');
  await assert.rejects(stat(path.join(checkout, '.dockerignore')), { code: 'ENOENT' });
  assert.equal((await apps.get(app.id)).deployment.stage, 'building');
  assert.equal((await apps.get(app.id)).deployment.buildAttempts, 1);
  assert.equal((await apps.get(app.id)).deployment.message, 'Building application (attempt 1 of 3)');
  await context.cleanup();
  await assert.rejects(stat(context.context), { code: 'ENOENT' });
});

test('opens another bounded build cycle after three failed attempts without replacing the App', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-build-retry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const data = path.join(directory, 'data');
  const repositories = path.join(directory, 'repositories');
  const apps = new AppStore(data);
  const commit = 'e'.repeat(40);
  const app = await apps.create('Retry Project', {
    source: { type: 'git', url: 'https://example.com/project.git', branch: 'main', resolvedCommit: commit },
    deployment: { status: 'failed', stage: 'failed', errorCode: 'build_failed', buildAttempts: 3, image: 'halfcloud/app:failed', updatedAt: new Date().toISOString() },
  });
  const checkout = path.join(repositories, app.id, 'repository');
  await mkdir(checkout, { recursive: true });
  await writeFile(path.join(checkout, 'Dockerfile.halfcloud'), 'FROM scratch\n');
  const service = new RepositoryService(apps, repositories);

  await assert.rejects(service.buildContext(app.id, '.', 'Dockerfile.halfcloud'), /Build retry limit reached/);
  const reset = await service.retryBuild(app.id);
  const context = await service.buildContext(app.id, '.', 'Dockerfile.halfcloud');

  assert.equal(reset.id, app.id);
  assert.equal(reset.deployment.buildAttempts, 0);
  assert.equal(reset.deployment.stage, 'preparing');
  assert.equal(reset.deployment.image, undefined);
  assert.match(context.image, uuidTag);
  assert.equal((await apps.get(app.id)).deployment.buildAttempts, 1);
  await context.cleanup();
});

test('does not reset build attempts before the bounded cycle is exhausted', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-build-retry-guard-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const apps = new AppStore(path.join(directory, 'data'));
  const app = await apps.create('Active Build', {
    source: { type: 'git', url: 'https://example.com/project.git', branch: 'main', resolvedCommit: 'f'.repeat(40) },
    deployment: { status: 'failed', stage: 'failed', errorCode: 'build_failed', buildAttempts: 2, updatedAt: new Date().toISOString() },
  });
  const service = new RepositoryService(apps, path.join(directory, 'repositories'));

  await assert.rejects(service.retryBuild(app.id), /only after three failed build attempts/);
  assert.equal((await apps.get(app.id)).deployment.buildAttempts, 2);
});

test('persists and selects a generated Dockerfile in the build context before building', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-generated-build-context-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const data = path.join(directory, 'data');
  const repositories = path.join(directory, 'repositories');
  const apps = new AppStore(data);
  const commit = 'd'.repeat(40);
  const app = await apps.create('Generated Build Project', {
    source: { type: 'git', url: 'https://example.com/project.git', branch: 'main', resolvedCommit: commit },
    deployment: { status: 'in_progress', stage: 'planning', buildAttempts: 0, updatedAt: new Date().toISOString() },
  });
  const checkout = path.join(repositories, app.id, 'repository');
  await mkdir(path.join(checkout, 'web'), { recursive: true });
  await writeFile(path.join(checkout, 'web', 'package.json'), '{"scripts":{"start":"node index.js"}}\n');
  const service = new RepositoryService(apps, repositories);

  const context = await service.prepareGeneratedBuildContext(
    app.id,
    'web',
    'FROM node:24-alpine\nCOPY . .\nCMD ["npm", "start"]\n',
    'node_modules\n',
  );

  assert.notEqual(context.context, path.join(checkout, 'web'));
  assert.equal(context.context.endsWith('/repository/web'), true);
  assert.equal(context.dockerfile, 'Dockerfile.halfcloud');
  assert.deepEqual(context.entries.sort(), ['.dockerignore', 'Dockerfile.halfcloud', 'package.json']);
  assert.equal(await readFile(path.join(context.context, context.dockerfile), 'utf8'), context.recipe.dockerfileContent);
  assert.equal(await readFile(path.join(context.context, '.dockerignore'), 'utf8'), 'node_modules\n');
  await context.cleanup();
  await assert.rejects(stat(context.context), { code: 'ENOENT' });
  assert.match(await readFile(path.join(checkout, 'web', 'Dockerfile.halfcloud'), 'utf8'), /^FROM node:24-alpine/);
  assert.equal(await readFile(path.join(checkout, 'web', '.dockerignore'), 'utf8'), 'node_modules\n');
});

test('initial and saved builds present identical archive inputs when root and Dockerfile-specific ignores disagree', async (t) => {
  const { app, root, checkout, service } = await recipeFixture(t);
  const source = path.join(checkout, 'web');
  await writeFile(path.join(source, '.dockerignore'), 'app.txt\n');
  await writeFile(path.join(source, 'specific-only.txt'), 'excluded by the effective ignore\n');
  const initial = await service.buildContext(app.id, 'web', 'docker/Dockerfile');
  const saved = await service.prepareSavedBuild(app.id, initial.recipe);
  try {
    assert.notEqual(initial.context, saved.context);
    const inputs = [];
    for (const build of [initial, saved]) {
      assert.notEqual(build.context, source);
      assert.equal(build.dockerfile, 'docker/Dockerfile');
      assert.deepEqual(build.entries, ['.dockerignore', 'app.txt', 'docker/Dockerfile', 'specific-only.txt']);
      const files = Object.fromEntries(await Promise.all(build.entries.map(async (entry) => [entry, await readFile(path.join(build.context, entry), 'utf8')])));
      assert.equal(files['.dockerignore'], 'specific-only.txt\n', 'Dockerode must filter using the effective ignore, not the checkout root ignore');
      assert.equal(files['app.txt'], 'old source\n');
      await assert.rejects(stat(path.join(build.context, 'docker', 'Dockerfile.dockerignore')), { code: 'ENOENT' });
      inputs.push({ dockerfile: build.dockerfile, entries: build.entries, files });
    }
    assert.deepEqual(inputs[0], inputs[1]);
    assert.equal(await readFile(path.join(source, '.dockerignore'), 'utf8'), 'app.txt\n', 'preparation must not rewrite the checkout root ignore');
    await writeFile(path.join(source, '.dockerignore'), '*\n');
    await writeFile(path.join(source, 'docker', 'Dockerfile.dockerignore'), '*\n');
    await writeFile(path.join(source, 'docker', 'Dockerfile'), 'FROM changed\n');
    await writeFile(path.join(source, 'app.txt'), 'changed source\n');
    for (const build of [initial, saved]) {
      assert.equal(await readFile(path.join(build.context, build.dockerfile), 'utf8'), initial.recipe.dockerfileContent);
      assert.equal(await readFile(path.join(build.context, '.dockerignore'), 'utf8'), initial.recipe.dockerignoreContent);
      assert.equal(await readFile(path.join(build.context, 'app.txt'), 'utf8'), 'old source\n');
    }
  } finally {
    await initial.cleanup();
    await saved.cleanup();
  }
  await assert.rejects(stat(initial.context), { code: 'ENOENT' });
  await assert.rejects(stat(saved.context), { code: 'ENOENT' });
  assert.equal((await readdir(root)).some((name) => name.startsWith('build-context-')), false);
});

test('records exact successful build snapshots and persists independent per-Service update recipes across restart', async (t) => {
  const { data, apps, app, repositories, root, checkout, service } = await recipeFixture(t);
  assert.deepEqual(await service.getServiceUpdates(app.id), [], 'legacy Apps must not infer a recipe from checkout files');
  const first = await service.buildContext(app.id, 'web', 'docker/Dockerfile');
  assert.equal(await service.getBuild(app.id, first.image), undefined, 'preparation alone must not record a successful build');
  assert.deepEqual(first.recipe, {
    contextPath: 'web', dockerfilePath: 'docker/Dockerfile',
    dockerfileContent: 'FROM scratch\nCOPY . /app\n', dockerignoreContent: 'specific-only.txt\n',
  });
  await writeFile(path.join(checkout, 'web', 'docker', 'Dockerfile'), 'FROM busybox\nCOPY app.txt /worker.txt\n');
  await writeFile(path.join(checkout, 'web', 'docker', 'Dockerfile.dockerignore'), 'worker-only.txt\n');
  await service.recordBuild(app.id, first, imageId);
  await first.cleanup();
  const second = await service.buildContext(app.id, 'web', 'docker/Dockerfile');
  await service.recordBuild(app.id, second, `sha256:${'b'.repeat(64)}`);
  await second.cleanup();
  assert.notEqual(first.image, second.image);
  assert.match(first.image, uuidTag);
  assert.match(second.image, uuidTag);

  const entries = [
    { ...await service.getBuild(app.id, first.image), serviceId: 'service_web', healthPath: '/health' },
    { ...await service.getBuild(app.id, second.image), serviceId: 'service_worker', healthPath: null },
  ];
  const before = await apps.get(app.id);
  await service.saveServiceUpdates(app.id, entries);
  assert.deepEqual(await apps.get(app.id), before, 'recipe persistence is internal, not App/agent metadata');
  const restarted = new RepositoryService(new AppStore(data), repositories);
  assert.deepEqual(await restarted.getServiceUpdates(app.id), entries);
  assert.deepEqual((await restarted.getBuild(app.id, first.image)).recipe, first.recipe);
  const planPath = path.join(root, 'service-updates.json');
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  assert.equal((await stat(planPath)).mode & 0o777, 0o600);
  for (const entry of entries) {
    const folder = path.join(root, `service-updates-${plan.generation}`, entry.serviceId);
    assert.equal(folder.startsWith(`${checkout}/`), false);
    assert.equal((await stat(folder)).mode & 0o777, 0o700);
    for (const [name, content] of [['Dockerfile.update', entry.recipe.dockerfileContent], ['.dockerignore', entry.recipe.dockerignoreContent]]) {
      assert.equal(await readFile(path.join(folder, name), 'utf8'), content);
      assert.equal((await stat(path.join(folder, name))).mode & 0o777, 0o600);
    }
  }
  for (const name of (await readdir(root)).filter((name) => /^build-.*\.json$/.test(name))) {
    assert.equal((await stat(path.join(root, name))).mode & 0o777, 0o600);
  }
  await restarted.saveServiceUpdates(app.id, entries.slice(1));
  assert.deepEqual(await service.getServiceUpdates(app.id), entries.slice(1), 'saves replace the whole plan');
  await restarted.saveServiceUpdates(app.id, []);
  assert.deepEqual(await service.getServiceUpdates(app.id), []);
});

test('stages the latest source with the pinned nested Dockerfile and ignore, independently of global retry limits', async (t) => {
  const { apps, app, root, checkout, service } = await recipeFixture(t);
  const initial = await service.buildContext(app.id, 'web', 'docker/Dockerfile');
  await writeFile(path.join(checkout, 'web', 'app.txt'), 'latest source\n');
  await writeFile(path.join(checkout, 'web', 'docker', 'Dockerfile'), 'FROM malicious-checkout\n');
  await writeFile(path.join(checkout, 'web', '.dockerignore'), '*\n');
  await writeFile(path.join(checkout, 'web', 'docker', 'Dockerfile.dockerignore'), '*\n');
  await writeFile(path.join(checkout, 'web', 'Dockerfile.other.dockerignore'), '*\n');
  assert.equal(await readFile(path.join(initial.context, 'app.txt'), 'utf8'), 'old source\n');
  await initial.cleanup();
  await mkdir(path.join(checkout, 'web', 'nested'));
  await writeFile(path.join(checkout, 'web', 'nested', '.dockerignore'), '*\n');
  await mkdir(path.join(checkout, 'web', '.git'));
  for (const name of ['.git/config', '.git-credentials', '.gitconfig', '.netrc', 'id_ed25519', '.env', 'private.key']) {
    await writeFile(path.join(checkout, 'web', name), 'secret\n');
  }
  await writeFile(path.join(root, 'id_ed25519'), 'outside checkout deploy key\n');
  await apps.update(app.id, {
    source: { ...app.source, resolvedCommit: 'b'.repeat(40) },
    deployment: { ...(await apps.get(app.id)).deployment, buildAttempts: 3 },
  });

  const images = new Set([initial.image]);
  for (let index = 0; index < 4; index += 1) {
    const staged = await service.prepareSavedBuild(app.id, initial.recipe);
    assert.notEqual(staged.context, path.join(checkout, 'web'));
    assert.equal(staged.context.endsWith('/repository/web'), true);
    assert.equal(staged.dockerfile, 'docker/Dockerfile');
    assert.equal(staged.commit, 'b'.repeat(40));
    assert.match(staged.image, uuidTag);
    images.add(staged.image);
    assert.deepEqual(staged.recipe, initial.recipe);
    assert.deepEqual(staged.entries, ['.dockerignore', 'app.txt', 'docker/Dockerfile']);
    assert.equal(await readFile(path.join(staged.context, staged.dockerfile), 'utf8'), initial.recipe.dockerfileContent);
    assert.equal(await readFile(path.join(staged.context, '.dockerignore'), 'utf8'), initial.recipe.dockerignoreContent);
    assert.equal(await readFile(path.join(staged.context, 'app.txt'), 'utf8'), 'latest source\n');
    await assert.rejects(stat(path.join(staged.context, 'docker', 'Dockerfile.dockerignore')), { code: 'ENOENT' });
    await assert.rejects(stat(path.join(staged.context, '.git')), { code: 'ENOENT' });
    await writeFile(path.join(staged.context, 'app.txt'), 'staging-only change');
    assert.equal(await readFile(path.join(checkout, 'web', 'app.txt'), 'utf8'), 'latest source\n');
    await staged.cleanup();
    await staged.cleanup();
    await assert.rejects(stat(staged.context), { code: 'ENOENT' });
  }
  assert.equal(images.size, 5);
  assert.equal((await apps.get(app.id)).deployment.buildAttempts, 3);
  assert.equal(await readFile(path.join(checkout, 'web', '.dockerignore'), 'utf8'), '*\n');
  assert.equal((await readdir(root)).some((name) => name.startsWith('build-context-')), false);
});

test('saved recipes do not require the original Dockerfile or ignore files to still exist', async (t) => {
  const { app, checkout, service } = await recipeFixture(t);
  const initial = await service.buildContext(app.id, 'web', 'docker/Dockerfile');
  const { recipe } = initial;
  await initial.cleanup();
  await rm(path.join(checkout, 'web', 'docker'), { recursive: true });
  await rm(path.join(checkout, 'web', '.dockerignore'));
  const staged = await service.prepareSavedBuild(app.id, recipe);
  try {
    assert.equal(await readFile(path.join(staged.context, staged.dockerfile), 'utf8'), recipe.dockerfileContent);
    assert.equal(await readFile(path.join(staged.context, '.dockerignore'), 'utf8'), recipe.dockerignoreContent);
  } finally {
    await staged.cleanup();
  }
  await mkdir(path.join(checkout, 'web', 'docker'));
  await symlink('/unreadable-checkout-dockerfile', path.join(checkout, 'web', 'docker', 'Dockerfile'));
  await symlink('/unreadable-checkout-ignore', path.join(checkout, 'web', 'docker', 'Dockerfile.dockerignore'));
  await symlink('/unreadable-root-ignore', path.join(checkout, 'web', '.dockerignore'));
  const withLinks = await service.prepareSavedBuild(app.id, recipe);
  assert.deepEqual(withLinks.recipe, recipe);
  await withLinks.cleanup();
});

test('validates both generated inputs before any write, rejects blank Dockerfiles, and accepts empty ignores', async (t) => {
  const { apps, app, checkout, service } = await recipeFixture(t);
  const dockerfile = path.join(checkout, 'web', 'Dockerfile.halfcloud');
  const ignore = path.join(checkout, 'web', '.dockerignore');
  await writeFile(dockerfile, 'FROM original\n');
  const before = await apps.get(app.id);
  for (const [dockerfileContent, dockerignoreContent] of [
    ['', ''], [' \n\t', 'valid'], ['FROM valid\n', '\0'], ['FROM valid\n', 'x'.repeat(128 * 1024 + 1)],
    ['FROM invalid\0', ''], ['x'.repeat(128 * 1024 + 1), ''],
  ]) {
    await assert.rejects(service.prepareGeneratedBuildContext(app.id, 'web', dockerfileContent, dockerignoreContent));
    assert.equal(await readFile(dockerfile, 'utf8'), 'FROM original\n');
    assert.equal(await readFile(ignore, 'utf8'), 'root-only.txt\n');
    assert.deepEqual(await apps.get(app.id), before);
  }
  await assert.rejects(service.writeDeploymentFile(app.id, 'web/Dockerfile.halfcloud', '\n '), /must not be empty/);
  assert.equal(await readFile(dockerfile, 'utf8'), 'FROM original\n');
  const generated = await service.prepareGeneratedBuildContext(app.id, 'web', 'FROM scratch\n', '');
  assert.equal(generated.recipe.dockerignoreContent, '');
  assert.equal(await readFile(ignore, 'utf8'), '');
  await generated.cleanup();
});

test('captures empty Dockerfile-specific ignore rather than falling back and validates checked-in recipe contents', async (t) => {
  const { apps, app, checkout, service } = await recipeFixture(t);
  const dockerfile = path.join(checkout, 'web', 'docker', 'Dockerfile');
  const specific = `${dockerfile}.dockerignore`;
  await writeFile(specific, '');
  const first = await service.buildContext(app.id, 'web', 'docker/Dockerfile');
  assert.equal(first.recipe.dockerignoreContent, '');
  await first.cleanup();
  await rm(specific);
  const second = await service.buildContext(app.id, 'web', 'docker/Dockerfile');
  assert.equal(second.recipe.dockerignoreContent, 'root-only.txt\n');
  await second.cleanup();
  const before = await apps.get(app.id);
  for (const content of ['', ' \n', 'FROM scratch\0', 'x'.repeat(128 * 1024 + 1), Buffer.from([0xff])]) {
    await writeFile(dockerfile, content);
    await assert.rejects(service.buildContext(app.id, 'web', 'docker/Dockerfile'));
    assert.deepEqual(await apps.get(app.id), before);
  }
  await writeFile(dockerfile, 'FROM scratch\n');
  await writeFile(specific, 'x'.repeat(128 * 1024 + 1));
  await assert.rejects(service.buildContext(app.id, 'web', 'docker/Dockerfile'), /safety limits/);
});

test('confines recipe paths, rejects source symlinks and oversize contexts, and cleans up failed staging', async (t) => {
  const { directory, apps, app, root, checkout, service } = await recipeFixture(t);
  const initial = await service.buildContext(app.id, 'web', 'docker/Dockerfile');
  const { recipe } = initial;
  await initial.cleanup();
  const before = await apps.get(app.id);
  for (const invalid of ['../outside', '/tmp/outside', 'C:\\outside', '.git/config', 'a/../../b', 'a\0b', 'a\nb', 'x'.repeat(1025)]) {
    await assert.rejects(service.prepareSavedBuild(app.id, { ...recipe, contextPath: invalid }));
    await assert.rejects(service.prepareSavedBuild(app.id, { ...recipe, dockerfilePath: invalid }));
  }
  await assert.rejects(service.prepareSavedBuild(app.id, { ...recipe, dockerfilePath: '.dockerignore' }));
  await assert.rejects(service.prepareSavedBuild(app.id, { ...recipe, dockerfilePath: '.env/Dockerfile' }));
  await symlink(directory, path.join(checkout, 'escape'));
  await assert.rejects(service.prepareSavedBuild(app.id, { ...recipe, contextPath: 'escape' }), /escapes/);
  await symlink(path.join(checkout, 'web'), path.join(checkout, 'alias'));
  await assert.rejects(service.prepareSavedBuild(app.id, { ...recipe, contextPath: 'alias' }), /symbolic links/);
  const link = path.join(checkout, 'web', 'source-link');
  await symlink(path.join(checkout, 'web', 'app.txt'), link);
  await assert.rejects(service.prepareSavedBuild(app.id, recipe), /symbolic links/);
  await assert.rejects(service.buildContext(app.id, 'web', 'docker/Dockerfile'), /symbolic links/);
  assert.deepEqual(await apps.get(app.id), before, 'failed initial staging must not consume an attempt or change deployment state');
  await rm(link);
  const large = path.join(checkout, 'web', 'large');
  await writeFile(large, '');
  await truncate(large, 1024 * 1024 * 1024 + 1);
  await assert.rejects(service.prepareSavedBuild(app.id, recipe), /safety limits/);
  await assert.rejects(service.buildContext(app.id, 'web', 'docker/Dockerfile'), /safety limits/);
  assert.deepEqual(await apps.get(app.id), before);
  await rm(large);
  assert.equal((await readdir(root)).some((name) => name.startsWith('build-context-')), false);
  assert.equal(await readFile(path.join(checkout, 'web', 'app.txt'), 'utf8'), 'old source\n');
});

test('bounds directory enumeration even when entries would be excluded from staging', async (t) => {
  const { app, root, checkout, service } = await recipeFixture(t);
  const initial = await service.buildContext(app.id, 'web', 'docker/Dockerfile');
  const { recipe } = initial;
  await initial.cleanup();
  for (let start = 0; start < 20_000; start += 100) {
    await Promise.all(Array.from({ length: 100 }, (_, index) => mkdir(path.join(checkout, 'web', `.env.${start + index}`))));
  }
  await assert.rejects(service.prepareSavedBuild(app.id, recipe), /safety limits/);
  assert.equal((await readdir(root)).some((name) => name.startsWith('build-context-')), false);
});

test('keeps the previous complete plan visible when publishing the next generation fails', async (t) => {
  const { app, root, service } = await recipeFixture(t);
  const build = await service.buildContext(app.id, 'web', 'docker/Dockerfile');
  await service.recordBuild(app.id, build, imageId);
  await build.cleanup();
  const entry = { ...await service.getBuild(app.id, build.image), serviceId: 'service_web', healthPath: '/' };
  await service.saveServiceUpdates(app.id, [entry]);
  const files = await readdir(root);
  service.writeRecipeJson = async (_root, _file, _plan, durable) => {
    assert.equal(durable, true);
    assert.deepEqual(await service.getServiceUpdates(app.id), [entry], 'unpublished files must not change the active plan');
    throw new Error('Injected publication failure');
  };
  await assert.rejects(service.saveServiceUpdates(app.id, [{ ...entry, healthPath: '/new' }]), /publication failure/);
  assert.deepEqual(await service.getServiceUpdates(app.id), [entry]);
  const retained = (await readdir(root)).filter((name) => !files.includes(name));
  assert.equal(retained.length, 1, 'publication failures conservatively retain the immutable generation');
  assert.match(retained[0], /^service-updates-/);
  assert.equal(await readFile(path.join(root, retained[0], entry.serviceId, 'Dockerfile.update'), 'utf8'), entry.recipe.dockerfileContent);
});

test('retains the published generation when durable plan publication fails after rename', async (t) => {
  const { data, app, repositories, root, service } = await recipeFixture(t);
  const writes = t.mock.method(service, 'writeRecipeJson');
  const build = await service.buildContext(app.id, 'web', 'docker/Dockerfile');
  await service.recordBuild(app.id, build, imageId);
  await build.cleanup();
  const entry = { ...await service.getBuild(app.id, build.image), serviceId: 'service_web', healthPath: '/' };
  await service.saveServiceUpdates(app.id, [entry]);
  const previous = JSON.parse(await readFile(path.join(root, 'service-updates.json'), 'utf8'));
  const updates = [
    { ...entry, healthPath: '/new', recipe: { ...entry.recipe, dockerfileContent: 'FROM busybox\n' } },
    { ...entry, serviceId: 'service_worker', healthPath: null },
  ];
  const synced = [];
  const syncDirectory = service.syncRecipeDirectory.bind(service);
  t.mock.method(service, 'syncRecipeDirectory', async (directory) => {
    synced.push(directory);
    if (directory === root) {
      const published = JSON.parse(await readFile(path.join(root, 'service-updates.json'), 'utf8'));
      assert.deepEqual(published.entries, updates, 'the real atomic rename must happen before the injected sync failure');
      throw new Error('Injected post-publish directory sync failure');
    }
    await syncDirectory(directory);
  });

  await assert.rejects(service.saveServiceUpdates(app.id, updates), /post-publish directory sync failure/);
  const published = JSON.parse(await readFile(path.join(root, 'service-updates.json'), 'utf8'));
  const generation = path.join(root, `service-updates-${published.generation}`);
  assert.deepEqual(synced, [...updates.map(({ serviceId }) => path.join(generation, serviceId)), generation, root]);
  assert.equal(writes.mock.calls.length, 3);
  assert.ok(writes.mock.calls.every((call) => call.arguments[3] === true), 'build records and both plan publications must request durable writes');
  const restarted = new RepositoryService(new AppStore(data), repositories);
  assert.deepEqual(await restarted.getServiceUpdates(app.id), updates, 'a failed sync must not delete files referenced by the live plan');
  assert.equal(await readFile(path.join(root, `service-updates-${previous.generation}`, entry.serviceId, 'Dockerfile.update'), 'utf8'), entry.recipe.dockerfileContent);
  assert.equal((await readdir(root)).some((name) => name.endsWith('.tmp')), false);
});

test('validates entire plans before publishing and refuses corrupt or symlinked persisted data', async (t) => {
  const { app, root, service } = await recipeFixture(t);
  const build = await service.buildContext(app.id, 'web', 'docker/Dockerfile');
  await service.recordBuild(app.id, build, imageId);
  await build.cleanup();
  const entry = { ...await service.getBuild(app.id, build.image), serviceId: 'service_web', healthPath: '/' };
  await service.saveServiceUpdates(app.id, [entry]);
  const planFile = path.join(root, 'service-updates.json');
  const original = await readFile(planFile, 'utf8');
  const files = await readdir(root);
  for (const invalid of [
    [entry, entry], [{ ...entry, serviceId: '../escape' }], [{ ...entry, imageId: 'not-an-image-id' }],
    [{ ...entry, healthPath: 'https://example.com' }], [{ ...entry, recipe: { ...entry.recipe, dockerfileContent: '' } }],
    Array.from({ length: 101 }, (_, index) => ({ ...entry, serviceId: `service_${index}` })),
    Array.from({ length: 40 }, (_, index) => ({ ...entry, serviceId: `service_${index}`, recipe: { ...entry.recipe, dockerfileContent: 'x'.repeat(128 * 1024), dockerignoreContent: 'x'.repeat(128 * 1024) } })),
  ]) {
    await assert.rejects(service.saveServiceUpdates(app.id, invalid));
    assert.equal(await readFile(planFile, 'utf8'), original);
    assert.deepEqual(await readdir(root), files);
  }
  await writeFile(planFile, '{broken');
  await assert.rejects(service.getServiceUpdates(app.id));
  await writeFile(planFile, JSON.stringify({ ...JSON.parse(original), generation: '../repository' }));
  await assert.rejects(service.getServiceUpdates(app.id));
  await writeFile(planFile, original);
  const { generation } = JSON.parse(original);
  const savedFile = path.join(root, `service-updates-${generation}`, entry.serviceId, 'Dockerfile.update');
  await writeFile(savedFile, 'FROM tampered\n');
  await assert.rejects(service.getServiceUpdates(app.id), /do not match/);
  await rm(savedFile);
  await symlink(path.join(root, 'repository', 'web', 'docker', 'Dockerfile'), savedFile);
  await assert.rejects(service.getServiceUpdates(app.id), /symbolic links/);
  const buildFile = path.join(root, (await readdir(root)).find((name) => /^build-.*\.json$/.test(name)));
  await writeFile(buildFile, '');
  await truncate(buildFile, 8 * 1024 * 1024 + 1);
  await assert.rejects(service.getBuild(app.id, build.image), /text file|safety limits/);
});

test('persists the complete applying and committed update journal across restart and clears it idempotently', async (t) => {
  const { data, apps, app, repositories, root, service } = await recipeFixture(t);
  assert.equal(await service.getUpdateRun(app.id), undefined);
  const build = await service.buildContext(app.id, 'web', 'docker/Dockerfile');
  await build.cleanup();
  const previous = { image: build.image, imageId, commit: build.commit, recipe: build.recipe, serviceId: 'service_web', healthPath: '/' };
  const commit = 'b'.repeat(40);
  const run = {
    phase: 'applying', commit, previousUpdates: [previous],
    updates: [{ ...previous, image: 'halfcloud/app:candidate', imageId: `sha256:${'b'.repeat(64)}`, commit, recipe: { ...previous.recipe, dockerfileContent: 'FROM busybox\n' } }],
  };
  const before = await apps.get(app.id);
  await service.saveUpdateRun(app.id, run);
  const restarted = new RepositoryService(new AppStore(data), repositories);
  assert.deepEqual(await restarted.getUpdateRun(app.id), run);
  const file = path.join(root, 'update-run.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 1, run });
  await restarted.saveUpdateRun(app.id, { ...run, phase: 'committed' });
  assert.deepEqual(await service.getUpdateRun(app.id), { ...run, phase: 'committed' });
  assert.deepEqual(await apps.get(app.id), before, 'the journal alone must not advance deployment state');
  assert.deepEqual(await service.getServiceUpdates(app.id), [], 'the journal alone must not publish the candidate plan');
  await restarted.clearUpdateRun(app.id);
  await service.clearUpdateRun(app.id);
  assert.equal(await service.getUpdateRun(app.id), undefined);
  await rm(root, { recursive: true });
  assert.equal(await restarted.getUpdateRun(app.id), undefined, 'legacy Apps may have no repository storage');
  await restarted.clearUpdateRun(app.id);
  await assert.rejects(stat(root), { code: 'ENOENT' });
});

test('rejects invalid, oversized, corrupt, or symlinked update journals without overwriting a valid decision', async (t) => {
  const { app, root, service } = await recipeFixture(t);
  const run = { phase: 'committed', commit: app.source.resolvedCommit, previousUpdates: [], updates: [] };
  await service.saveUpdateRun(app.id, run);
  const file = path.join(root, 'update-run.json');
  const original = await readFile(file, 'utf8');
  const entry = {
    image: 'halfcloud/app:candidate', imageId, commit: run.commit, serviceId: 'service_web', healthPath: null,
    recipe: { contextPath: '.', dockerfilePath: 'Dockerfile', dockerfileContent: 'x'.repeat(128 * 1024), dockerignoreContent: 'x'.repeat(128 * 1024) },
  };
  for (const invalid of [
    { ...run, phase: 'unknown' }, { ...run, commit: 'invalid' },
    { ...run, previousUpdates: [{ ...entry, serviceId: '../escape' }] },
    { ...run, updates: [entry, entry] },
    { ...run, updates: Array.from({ length: 40 }, (_, index) => ({ ...entry, serviceId: `service_${index}` })) },
  ]) {
    await assert.rejects(service.saveUpdateRun(app.id, invalid));
    assert.equal(await readFile(file, 'utf8'), original);
  }
  for (const content of ['{broken', JSON.stringify({ version: 1, run: { ...run, phase: 'unknown' } }), ' '.repeat(8 * 1024 * 1024 + 1)]) {
    await writeFile(file, content);
    await assert.rejects(service.getUpdateRun(app.id));
  }
  await rm(file);
  await symlink(path.join(root, 'missing-journal'), file);
  await assert.rejects(service.getUpdateRun(app.id), { code: 'ENOENT' }, 'a dangling symlink is corrupt, not a missing legacy journal');
  await service.clearUpdateRun(app.id);
  assert.equal(await service.getUpdateRun(app.id), undefined);
  assert.equal((await readdir(root)).some((name) => name.endsWith('.tmp')), false);
});
