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
  assert.match(context.image, /-1$/);
  assert.equal((await apps.get(app.id)).deployment.buildAttempts, 1);
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

  assert.equal(context.context, path.join(checkout, 'web'));
  assert.equal(context.dockerfile, 'Dockerfile.halfcloud');
  assert.deepEqual(context.entries.sort(), ['.dockerignore', 'Dockerfile.halfcloud', 'package.json']);
  assert.match(await readFile(path.join(checkout, 'web', 'Dockerfile.halfcloud'), 'utf8'), /^FROM node:24-alpine/);
  assert.equal(await readFile(path.join(checkout, 'web', '.dockerignore'), 'utf8'), 'node_modules\n');
});
