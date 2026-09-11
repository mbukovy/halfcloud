import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { AppStore } from '../dist/backend/apps.js';
import { ApplicationService } from '../dist/backend/applications.js';
import { DomainStore } from '../dist/backend/domains.js';
import { EnvironmentStore } from '../dist/backend/environment.js';
import { RepositoryService } from '../dist/backend/repositories.js';
import { RouteAccessRequestStore } from '../dist/backend/route-access.js';

const currentCommit = 'a'.repeat(40);
const nextCommit = 'b'.repeat(40);
const secret = 'runtime-only-secret';
const recipes = [
  { contextPath: 'web', dockerfilePath: 'Dockerfile', dockerfileContent: 'FROM node:22\nCMD ["node", "web.mjs"]\n', dockerignoreContent: 'node_modules\n' },
  { contextPath: 'worker', dockerfilePath: 'Dockerfile.worker', dockerfileContent: 'FROM node:22\nCMD ["node", "worker.mjs"]\n', dockerignoreContent: 'cache\n' },
];

function assertSafeResult(result) {
  assert.doesNotMatch(JSON.stringify(result), /dockerfile|dockerignore|FROM node|runtime-only-secret/i);
}

async function fixture(t, { verify = true } = {}) {
  const previousBaseDomain = process.env.HALFCLOUD_BASE_DOMAIN;
  process.env.HALFCLOUD_BASE_DOMAIN = 'example.com';
  t.after(() => {
    if (previousBaseDomain === undefined) delete process.env.HALFCLOUD_BASE_DOMAIN;
    else process.env.HALFCLOUD_BASE_DOMAIN = previousBaseDomain;
  });
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-application-updates-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const events = [];
  const apps = new AppStore(directory);
  const app = await apps.create('Two Services', {
    source: { type: 'git', url: 'https://github.com/example/project', branch: 'main', resolvedCommit: currentCommit },
  });
  const repositoriesDir = path.join(directory, 'repositories');
  const checkout = path.join(repositoriesDir, app.id, 'repository');
  for (const recipe of recipes) {
    const context = path.join(checkout, recipe.contextPath);
    await mkdir(context, { recursive: true });
    await writeFile(path.join(context, recipe.dockerfilePath), recipe.dockerfileContent);
    await writeFile(path.join(context, '.dockerignore'), recipe.dockerignoreContent);
    await writeFile(path.join(context, `${recipe.contextPath}.mjs`), 'console.log("ready");\n');
    await writeFile(path.join(context, '.env'), `API_KEY=${secret}\n`);
  }
  const git = t.mock.fn(async (args) => {
    events.push(args.includes('rev-parse') ? 'git:commit' : args.includes('fetch') ? 'git:fetch' : 'git:checkout');
    return { stdout: args.includes('rev-parse') ? `${nextCommit}\n` : '', stderr: '' };
  });
  const resolveHost = async () => [{ address: '8.8.8.8' }];
  const repositories = new RepositoryService(apps, repositoriesDir, resolveHost, git);
  const domains = new DomainStore(directory);
  t.mock.method(domains, 'withReadiness', async (stored) => stored);
  const environment = new EnvironmentStore(directory);
  const runtime = {
    services: [],
    builds: new Map(),
    backups: new Map(),
    buildInputs: [],
    async buildImage(input) {
      events.push(`build:${input.recipe.contextPath}`);
      assert.equal(await readFile(path.join(input.context, input.dockerfile), 'utf8'), input.recipe.dockerfileContent);
      assert.equal(await readFile(path.join(input.context, '.dockerignore'), 'utf8'), input.recipe.dockerignoreContent);
      assert.ok(!input.entries.includes('.env'));
      this.buildInputs.push(input);
      const imageId = `sha256:${createHash('sha256').update(input.image).digest('hex')}`;
      this.builds.set(input.image, imageId);
      return { image: input.image, imageId, logs: '' };
    },
    async createContainer(input) {
      const service = {
        id: `container-${this.services.length + 1}`, appId: input.appId, serviceId: input.serviceId,
        name: input.serviceName, runtimeName: input.name, image: input.image, hostname: input.hostname,
        state: input.start === false ? 'exited' : 'running', status: 'Created',
        ports: Object.entries(input.ports).map(([host, target]) => ({ host: Number(host), container: Number(target), protocol: 'tcp' })),
        internalPorts: [], cpuPercent: 0, memoryUsed: 0, memoryLimit: 0,
      };
      this.services.push(service);
      return { id: service.id, name: service.name, running: service.state === 'running', steps: [] };
    },
    async listContainers() { return structuredClone(this.services); },
    async getContainerEnvironment(id) {
      const service = this.services.find((candidate) => candidate.id === id || candidate.serviceId === id);
      return { name: service.serviceId, environment: { API_KEY: secret } };
    },
    async startContainer(id) {
      this.services.find((service) => service.id === id).state = 'running';
      return { containerId: id, state: 'running' };
    },
    async inspectContainer(id) {
      const service = this.services.find((candidate) => candidate.id === id);
      assert.ok(service, `Unknown container ${id}`);
      return { ...service, imageId: this.builds.get(service.image), health: null, ports: service.ports.map((port) => ({ hostPort: port.host, target: `${port.container}/tcp` })) };
    },
    async beginContainerImageReplacement(id, image) {
      const index = this.services.findIndex((service) => service.id === id);
      assert.notEqual(index, -1);
      const previous = structuredClone(this.services[index]);
      assert.ok(!this.backups.has(previous.serviceId));
      assert.ok(this.builds.has(image));
      events.push(`swap:${previous.name}`);
      const replacement = { ...previous, id: `${id}-replacement`, image };
      this.services[index] = replacement;
      const transaction = {
        containerId: replacement.id, name: replacement.runtimeName, state: replacement.state,
        commit: async () => {
          events.push(`cleanup:${previous.name}`);
          this.backups.delete(previous.serviceId);
        },
        rollback: async () => {
          events.push(`rollback:${previous.name}`);
          this.services[index] = previous;
          this.backups.delete(previous.serviceId);
        },
      };
      this.backups.set(previous.serviceId, { appId: previous.appId, transaction });
      return transaction;
    },
    async recoverContainerReplacements(committedApps = new Set(), appId) {
      events.push(committedApps.has(app.id) ? 'recover:forward' : 'recover:rollback');
      for (const backup of [...this.backups.values()]) {
        if (appId && backup.appId !== appId) continue;
        await backup.transaction[committedApps.has(backup.appId) ? 'commit' : 'rollback']();
      }
      return [];
    },
    async rollbackMissingContainerReplacements(issues) {
      for (const issue of issues) await this.backups.get(issue.serviceId).transaction.rollback();
    },
  };
  const caddy = { sync: t.mock.fn(async () => { events.push('routes'); }) };
  const makeApplications = (store = apps, repositoryService = repositories) => new ApplicationService(
    runtime, caddy, domains, environment, new RouteAccessRequestStore(directory), async () => 'hash', store, repositoryService,
  );
  const applications = makeApplications();
  const wait = t.mock.method(applications, 'waitForService', async (_appId, serviceId, imageId, healthPath, singleProbe = false) => {
    const service = await applications.service(app.id, serviceId);
    assert.equal((await runtime.inspectContainer(service.id)).imageId, imageId);
    assert.equal(healthPath, service.name === 'web' ? '/ready' : null);
    events.push(`${singleProbe ? 'probe' : 'health'}:${service.name}`);
  });
  const built = [];
  for (const recipe of recipes) {
    const result = await applications.buildRepositoryImage(app.id, recipe.contextPath, recipe.dockerfilePath);
    const input = runtime.buildInputs.at(-1);
    assert.notEqual(input.context, path.join(checkout, recipe.contextPath));
    await assert.rejects(stat(input.context), { code: 'ENOENT' });
    assertSafeResult(result);
    built.push(result);
    await applications.addService(app.id, {
      name: recipe.contextPath, image: result.image,
      ports: recipe.contextPath === 'web' ? { 10001: '3000' } : {}, environment: { API_KEY: secret },
    });
  }
  await applications.addService(app.id, { name: 'redis', image: 'redis:7', ports: {} });
  await applications.startApp(app.id);
  if (verify) await applications.verifyGitDeployment(app.id, 'web', '/ready');
  const previousUpdates = await repositories.getServiceUpdates(app.id);
  const previousServices = structuredClone(runtime.services);
  for (const method of ['recordBuild', 'saveServiceUpdates', 'saveUpdateRun', 'clearUpdateRun']) {
    const original = repositories[method].bind(repositories);
    t.mock.method(repositories, method, async (...args) => {
      const result = await original(...args);
      events.push(method === 'saveUpdateRun' ? `journal:${args[1].phase}` : method === 'recordBuild' ? `record:${args[1].recipe.contextPath}` : method);
      return result;
    });
  }
  events.length = 0;
  runtime.buildInputs.length = 0;
  wait.mock.resetCalls();
  caddy.sync.mock.resetCalls();
  return { directory, repositoriesDir, checkout, apps, app, repositories, runtime, domains, environment, applications, makeApplications, git, resolveHost, events, built, previousUpdates, previousServices, caddy, wait };
}

test('first verified deployment records distinct per-Service recipes and images at the same commit', async (t) => {
  const f = await fixture(t, { verify: false });
  assert.notEqual(f.built[0].image, f.built[1].image);
  assert.notEqual(f.built[0].imageId, f.built[1].imageId);
  assert.equal((await f.apps.get(f.app.id)).source.currentCommit, undefined);
  for (const [index, built] of f.built.entries()) {
    assert.deepEqual(await f.repositories.getBuild(f.app.id, built.image), {
      image: built.image, imageId: built.imageId, commit: currentCommit, recipe: recipes[index],
    });
  }
  const result = await f.applications.verifyGitDeployment(f.app.name, undefined, '/ready');
  assert.deepEqual(result, { appId: f.app.id, commit: currentCommit, verified: true, updateRecipesSaved: 2 });
  assertSafeResult(result);
  const persisted = new RepositoryService(new AppStore(f.directory), f.repositoriesDir);
  assert.deepEqual(await persisted.getServiceUpdates(f.app.id), f.built.map((built, index) => ({
    image: built.image, imageId: built.imageId, commit: currentCommit, recipe: recipes[index],
    serviceId: f.runtime.services[index].serviceId, healthPath: index === 0 ? '/ready' : null,
  })));
  assert.equal((await f.apps.get(f.app.id)).source.currentCommit, currentCommit);
  assert.deepEqual(f.events, ['health:web', 'health:worker', 'probe:web', 'probe:worker', 'saveServiceUpdates']);
  assertSafeResult(await f.applications.getApp(f.app.id, false));
});

test('initial build staging is cleaned after Docker or build-record failure without changing checkout files', async (t) => {
  for (const failure of ['build', 'record']) await t.test(failure, async (t) => {
    const f = await fixture(t);
    const build = f.runtime.buildImage.bind(f.runtime);
    let input;
    t.mock.method(f.runtime, 'buildImage', async (candidate) => {
      input = candidate;
      assert.notEqual(input.context, path.join(f.checkout, 'web'));
      assert.ok((await stat(input.context)).isDirectory());
      if (failure === 'build') throw new Error('Injected build failure');
      return build(input);
    });
    if (failure === 'record') t.mock.method(f.repositories, 'recordBuild', async () => { throw new Error('Injected record failure'); });
    const succeeded = t.mock.method(f.repositories, 'buildSucceeded');
    await assert.rejects(f.applications.buildRepositoryImage(f.app.id, 'web', 'Dockerfile'), /Injected .* failure/);
    await assert.rejects(stat(input.context), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(f.checkout, 'web', 'Dockerfile'), 'utf8'), recipes[0].dockerfileContent);
    assert.equal(succeeded.mock.callCount(), 0);
    assert.equal(await f.repositories.getBuild(f.app.id, input.image), undefined);
    assert.deepEqual(f.runtime.services, f.previousServices);
  });
});

test('paired empty generated inputs use the existing Dockerfile without writing or generating deployment files', async (t) => {
  const f = await fixture(t);
  for (const method of ['prepareGeneratedBuildContext', 'writeDeploymentFile']) {
    t.mock.method(f.repositories, method, async () => assert.fail(`${method} must not run`));
  }
  const result = await f.applications.buildRepositoryImage(f.app.id, 'web', 'Dockerfile', undefined, { dockerfileContent: '', dockerignoreContent: '' });
  assert.equal(await readFile(path.join(f.checkout, 'web', 'Dockerfile'), 'utf8'), recipes[0].dockerfileContent);
  assert.equal(await readFile(path.join(f.checkout, 'web', '.dockerignore'), 'utf8'), recipes[0].dockerignoreContent);
  await assert.rejects(stat(path.join(f.checkout, 'web', 'Dockerfile.halfcloud')), { code: 'ENOENT' });
  assert.deepEqual((await f.repositories.getBuild(f.app.id, result.image)).recipe, recipes[0]);
  assertSafeResult(result);
});

test('failed first verification never publishes a partial recipe plan or deployed commit', async (t) => {
  const f = await fixture(t, { verify: false });
  t.mock.method(f.applications, 'waitForService', async (_appId, serviceId) => {
    if (serviceId === f.runtime.services[1].serviceId) throw new Error('worker: Service is not healthy and running');
  });
  await assert.rejects(f.applications.verifyGitDeployment(f.app.id, 'web', '/ready'), /worker: Service is not healthy and running/);
  assert.deepEqual(await f.repositories.getServiceUpdates(f.app.id), []);
  assert.equal(f.repositories.saveServiceUpdates.mock.callCount(), 0);
  const app = await f.apps.get(f.app.id);
  assert.equal(app.source.currentCommit, undefined);
  assert.equal(app.deployment.errorCode, 'verification_failed');
});

test('deterministic update builds and records every saved recipe before swapping, then commits only after group health', async (t) => {
  const f = await fixture(t);
  for (const method of ['inspect', 'writeDeploymentFile', 'prepareGeneratedBuildContext', 'buildContext', 'buildSucceeded']) {
    t.mock.method(f.repositories, method, async () => assert.fail(`${method} must not run during an update`));
  }
  for (const method of ['inspectRepository', 'writeRepositoryDeploymentFile', 'buildRepositoryImage']) {
    t.mock.method(f.applications, method, async () => assert.fail(`${method} must not run during an update`));
  }
  t.mock.method(globalThis, 'fetch', async () => assert.fail('No LLM or other HTTP request is needed with readiness mocked'));
  // Changed checkout instructions must not replace the verified recipe.
  await writeFile(path.join(f.checkout, 'web', 'Dockerfile'), 'FROM unrelated:latest\n');
  await writeFile(path.join(f.checkout, 'worker', '.dockerignore'), '*\n');
  const updateApp = f.apps.update.bind(f.apps);
  t.mock.method(f.apps, 'update', async (id, changes) => {
    if (changes.source?.currentCommit === nextCommit) {
      assert.equal((await f.apps.get(id)).source.currentCommit, currentCommit);
      const run = await f.repositories.getUpdateRun(id);
      assert.equal(run.phase, 'committed');
      assert.deepEqual(await f.repositories.getServiceUpdates(id), run.updates);
      assert.deepEqual(f.events.filter((event) => event.startsWith('health:')).sort(), ['health:web', 'health:worker']);
      assert.deepEqual(f.events.filter((event) => event.startsWith('probe:')).sort(), ['probe:web', 'probe:worker']);
      assert.equal(f.runtime.backups.size, 2);
      f.events.push('commit');
    }
    return updateApp(id, changes);
  });
  const result = await f.applications.updateGitApp(f.app.name);
  assert.equal(result.updated, true);
  assert.equal(result.commit, nextCommit);
  assertSafeResult(result);
  assert.deepEqual(f.events.filter((event) => !/^(health|probe):/.test(event)), [
    'git:fetch', 'git:commit', 'git:checkout', 'build:web', 'record:web', 'build:worker', 'record:worker',
    'journal:applying', 'swap:web', 'swap:worker', 'routes',
    'journal:committed', 'saveServiceUpdates', 'commit', 'recover:forward', 'cleanup:web', 'cleanup:worker', 'routes', 'clearUpdateRun',
  ]);
  assert.deepEqual(f.events.slice(11, 13).sort(), ['health:web', 'health:worker']);
  assert.deepEqual(f.events.slice(13, 15).sort(), ['probe:web', 'probe:worker']);
  const updates = await f.repositories.getServiceUpdates(f.app.id);
  assert.deepEqual(f.wait.mock.calls.map((call) => call.arguments), [
    ...updates.map(({ serviceId, imageId, healthPath }) => [f.app.id, serviceId, imageId, healthPath]),
    ...updates.map(({ serviceId, imageId, healthPath }) => [f.app.id, serviceId, imageId, healthPath, true]),
  ]);
  assert.deepEqual(updates.map((update) => update.recipe), recipes);
  assert.deepEqual(updates.map((update) => update.healthPath), ['/ready', null]);
  assert.deepEqual(result.services, updates.map(({ serviceId, image }) => ({ serviceId, image })));
  for (const [index, update] of updates.entries()) {
    assert.notEqual(update.image, f.previousUpdates[index].image);
    assert.equal(update.commit, nextCommit);
    assert.equal(f.runtime.services[index].image, update.image);
    const { serviceId, healthPath, ...build } = update;
    assert.deepEqual(await f.repositories.getBuild(f.app.id, update.image), build);
    await assert.rejects(stat(f.runtime.buildInputs[index].context), { code: 'ENOENT' });
  }
  assert.deepEqual(f.runtime.services[2], f.previousServices[2]);
  assert.equal(f.runtime.backups.size, 0);
  assert.equal(await f.repositories.getUpdateRun(f.app.id), undefined);
  const app = await f.apps.get(f.app.id);
  assert.equal(app.source.currentCommit, nextCommit);
  assert.equal(app.deployment.status, 'running');
  assert.equal(app.deployment.image, undefined);
});

test('a failed candidate build never swaps a Service or changes the deployed commit and recipes', async (t) => {
  const f = await fixture(t);
  const build = f.runtime.buildImage.bind(f.runtime);
  let failedContext;
  t.mock.method(f.runtime, 'buildImage', async (input) => {
    if (input.recipe.contextPath === 'worker') {
      failedContext = input.context;
      throw new Error('worker build failed');
    }
    return build(input);
  });
  await assert.rejects(f.applications.updateGitApp(f.app.id), /worker build failed/);
  assert.deepEqual(f.runtime.services, f.previousServices);
  assert.equal(f.runtime.backups.size, 0);
  assert.ok(!f.events.some((event) => event.startsWith('swap:') || event.startsWith('journal:')));
  assert.deepEqual(await f.repositories.getServiceUpdates(f.app.id), f.previousUpdates);
  assert.equal(await f.repositories.getUpdateRun(f.app.id), undefined);
  const app = await f.apps.get(f.app.id);
  assert.equal(app.source.currentCommit, currentCommit);
  assert.equal(app.deployment.errorCode, 'build_failed');
  assert.equal(f.repositories.recordBuild.mock.callCount(), 1);
  await assert.rejects(stat(failedContext), { code: 'ENOENT' });
  await assert.rejects(stat(f.runtime.buildInputs[0].context), { code: 'ENOENT' });
  assert.equal((await f.applications.refreshGitRepository(f.app.id)).changed, false);
});

test('delayed startup failure rolls back ALL swapped Services and resyncs old routes without publishing commit or recipes', async (t) => {
  const f = await fixture(t);
  const webChecked = Promise.withResolvers();
  t.mock.method(f.applications, 'waitForService', async (_id, serviceId) => {
    assert.equal(f.runtime.backups.size, 2);
    assert.equal((await f.repositories.getUpdateRun(f.app.id)).phase, 'applying');
    assert.deepEqual(await f.repositories.getServiceUpdates(f.app.id), f.previousUpdates);
    assert.equal((await f.apps.get(f.app.id)).source.currentCommit, currentCommit);
    const service = f.runtime.services.find((candidate) => candidate.serviceId === serviceId);
    f.events.push(`health:${service.name}`);
    if (service.name === 'worker') {
      await webChecked.promise;
      await setImmediate();
      // Models a successful container start followed by Node's missing-module crash loop.
      service.state = 'restarting';
      service.status = 'MODULE_NOT_FOUND';
      throw new Error('worker: Service is not healthy and running');
    }
    webChecked.resolve();
  });
  await assert.rejects(f.applications.updateGitApp(f.app.id), /worker: Service is not healthy and running/);
  assert.deepEqual(f.runtime.services, f.previousServices);
  assert.deepEqual(f.events.filter((event) => /^(swap|rollback|cleanup|journal):/.test(event)), [
    'journal:applying', 'swap:web', 'swap:worker', 'rollback:worker', 'rollback:web',
  ]);
  assert.deepEqual(f.events.filter((event) => event.startsWith('health:')).sort(), ['health:web', 'health:worker']);
  assert.deepEqual(await f.repositories.getServiceUpdates(f.app.id), f.previousUpdates);
  assert.equal(await f.repositories.getUpdateRun(f.app.id), undefined);
  assert.equal(f.runtime.backups.size, 0);
  assert.equal(f.caddy.sync.mock.callCount(), 2);
  const [newRoutes, restoredRoutes] = f.caddy.sync.mock.calls.map((call) => call.arguments[0]);
  assert.notEqual(newRoutes[0].id, f.previousServices[0].id);
  assert.equal(restoredRoutes[0].id, f.previousServices[0].id);
  assert.deepEqual(restoredRoutes[0].domains, newRoutes[0].domains);
  assert.deepEqual(restoredRoutes.map(({ id, image }) => ({ id, image })), f.previousServices.map(({ id, image }) => ({ id, image })));
  const app = await f.apps.get(f.app.id);
  assert.equal(app.source.currentCommit, currentCommit);
  assert.equal(app.deployment.errorCode, 'verification_failed');
  assert.equal((await f.applications.refreshGitRepository(f.app.id)).changed, false);
});

test('a verified same-commit update is a no-op without builds, swaps or plan writes', async (t) => {
  const f = await fixture(t);
  f.git.mock.mockImplementation(async () => ({ stdout: `${currentCommit}\n`, stderr: '' }));
  const before = await f.apps.get(f.app.id);
  const result = await f.applications.updateGitApp(f.app.id);
  assert.deepEqual(result, { appId: f.app.id, commit: currentCommit, updated: false, message: 'Already up to date' });
  assertSafeResult(result);
  assert.deepEqual(await f.apps.get(f.app.id), before);
  assert.deepEqual(await f.repositories.getServiceUpdates(f.app.id), f.previousUpdates);
  assert.deepEqual(f.runtime.services, f.previousServices);
  assert.deepEqual(f.events, []);
  assert.equal(f.git.mock.callCount(), 3);
});

test('final group verification rolls back every replacement if an early-ready web or dependency fails during worker warmup', async (t) => {
  for (const failing of ['web', 'redis']) await t.test(failing, async (t) => {
    const f = await fixture(t);
    const webReady = Promise.withResolvers();
    let workerReady = false;
    const wait = t.mock.method(f.applications, 'waitForService', async (appId, serviceId, imageId, healthPath, singleProbe = false) => {
      const service = f.runtime.services.find((candidate) => candidate.serviceId === serviceId);
      if (singleProbe) {
        assert.equal(workerReady, true);
        if (service.name === 'web' && failing === 'web') {
          return ApplicationService.prototype.waitForService.call(f.applications, appId, serviceId, imageId, healthPath, true);
        }
        return;
      }
      if (service.name === 'web') webReady.resolve();
      else {
        await webReady.promise;
        await setImmediate();
        f.runtime.services.find((candidate) => candidate.name === failing).state = 'restarting';
        workerReady = true;
      }
    });
    t.mock.method(globalThis, 'fetch', async () => assert.fail('A failed final image/state probe must not fetch'));
    await assert.rejects(f.applications.updateGitApp(f.app.id), failing === 'web' ? /healthy and running/ : /A Service stopped during update verification/);
    assert.deepEqual(wait.mock.calls.map((call) => [call.arguments[1], call.arguments[4] ?? false]), [
      ...f.previousUpdates.map(({ serviceId }) => [serviceId, false]),
      ...f.previousUpdates.map(({ serviceId }) => [serviceId, true]),
    ]);
    assert.deepEqual(f.events.filter((event) => /^(rollback|cleanup):/.test(event)), ['rollback:worker', 'rollback:web']);
    assert.ok(!f.events.includes('journal:committed'));
    assert.deepEqual(f.runtime.services.slice(0, 2), f.previousServices.slice(0, 2));
    assert.equal(f.runtime.backups.size, 0);
    assert.deepEqual(await f.repositories.getServiceUpdates(f.app.id), f.previousUpdates);
    assert.equal((await f.apps.get(f.app.id)).source.currentCommit, currentCommit);
    assert.equal(await f.repositories.getUpdateRun(f.app.id), undefined);
    assert.equal(f.caddy.sync.mock.callCount(), 2);
    assert.deepEqual(f.caddy.sync.mock.calls.at(-1).arguments[0].map(({ id, image }) => ({ id, image })), f.previousServices.map(({ id, image }) => ({ id, image })));
  });
});

test('first deployment can save distinct custom readiness endpoints for multiple APIs', async (t) => {
  const f = await fixture(t, { verify: false });
  const worker = f.runtime.services[1];
  worker.ports = [{ host: 10002, container: 3000, protocol: 'tcp' }];
  await f.domains.initialize(worker.serviceId, 'worker.example.com');
  t.mock.method(f.applications, 'waitForService', async (_appId, serviceId, _imageId, healthPath) => {
    assert.equal(healthPath, serviceId === worker.serviceId ? '/worker-ready' : '/web-ready');
  });
  await f.applications.verifyGitDeployment(f.app.id, undefined, '/', { web: '/web-ready', [worker.serviceId]: '/worker-ready' });
  assert.deepEqual((await f.repositories.getServiceUpdates(f.app.id)).map(({ healthPath }) => healthPath), ['/web-ready', '/worker-ready']);
});

test('recovery must durably republish a committed decision before deleting any backup', async (t) => {
  const f = await fixture(t);
  t.mock.method(f.repositories, 'saveServiceUpdates', async () => { throw new Error('Interrupted finalization'); });
  await assert.rejects(f.applications.updateGitApp(f.app.id), /finalization is pending/);
  const repositories = new RepositoryService(new AppStore(f.directory), f.repositoriesDir, f.resolveHost, f.git);
  t.mock.method(repositories, 'saveUpdateRun', async () => { throw new Error('Cannot flush commit decision'); });
  const recover = t.mock.method(f.runtime, 'recoverContainerReplacements');
  await assert.rejects(f.makeApplications(f.apps, repositories).recoverUpdates(), /Cannot flush commit decision/);
  assert.equal(recover.mock.callCount(), 0);
  assert.equal(f.runtime.backups.size, 2);
});

test('legacy Apps without verified recipes fail before Git, builds, or runtime access', async (t) => {
  const f = await fixture(t, { verify: false });
  const before = await f.apps.get(f.app.id);
  for (const method of ['listContainers', 'inspectContainer', 'buildImage', 'beginContainerImageReplacement', 'recoverContainerReplacements']) {
    t.mock.method(f.runtime, method, async () => assert.fail(`${method} must not run`));
  }
  await assert.rejects(f.applications.updateGitApp(f.app.name), /no verified update recipes/);
  assert.equal(f.git.mock.callCount(), 0);
  assert.deepEqual(await f.apps.get(f.app.id), before);
  assert.deepEqual(f.events, []);
});

test('another update and Service/configuration mutations are blocked before modification, then the guard releases', async (t) => {
  const f = await fixture(t);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const build = f.runtime.buildImage.bind(f.runtime);
  t.mock.method(f.runtime, 'buildImage', async (input) => {
    entered.resolve();
    await release.promise;
    return build(input);
  });
  const updating = f.applications.updateGitApp(f.app.id);
  try {
    await entered.promise;
    const gitCalls = f.git.mock.callCount();
    const web = f.runtime.services[0];
    const before = await f.apps.get(f.app.id);
    const variables = await f.applications.listEnvironment(web.id);
    const domains = await f.domains.get(web.serviceId);
    const writes = [
      t.mock.method(f.runtime, 'startContainer'), t.mock.method(f.runtime, 'createContainer'),
      t.mock.method(f.environment, 'replaceVariables'), t.mock.method(f.domains, 'replace'),
      t.mock.method(f.domains, 'add'), t.mock.method(f.domains, 'remove'),
    ];
    for (const operation of [
      () => f.applications.updateGitApp(f.app.name),
      () => f.applications.verifyGitDeployment(f.app.id),
      () => f.applications.writeRepositoryDeploymentFile(f.app.id, 'web/Dockerfile', 'FROM scratch\n'),
      () => f.applications.startApp(f.app.id),
      () => f.applications.stopApp(f.app.id),
      () => f.applications.deleteApp(f.app.id),
      () => f.applications.startService(f.app.id, web.serviceId),
      () => f.applications.stopService(f.app.id, web.serviceId),
      () => f.applications.removeService(f.app.id, web.serviceId),
      () => f.applications.startContainer(web.id),
      () => f.applications.stopContainer(web.id),
      () => f.applications.deleteContainer(web.id),
      () => f.applications.addService(f.app.id, { name: 'extra', image: 'redis:7', ports: {} }),
      () => f.applications.saveEnvironmentVariable(web.id, { variableId: variables[0].id, name: 'API_KEY', value: 'changed' }),
      () => f.applications.saveEnvironmentVariables(web.id, []),
      () => f.applications.deleteEnvironmentVariable(web.id, variables[0].id),
      () => f.applications.addDomain(web.id, 'custom.example.com'),
      () => f.applications.removeDomain(web.id, domains[0].hostname, true),
      () => f.applications.setPrimaryDomain(web.id, domains[0].hostname),
    ]) await assert.rejects(operation(), /An App update or its recovery is in progress/);
    assert.ok(writes.every((write) => write.mock.callCount() === 0));
    assert.deepEqual(await f.apps.get(f.app.id), before);
    assert.deepEqual(await f.applications.listEnvironment(web.id), variables);
    assert.deepEqual(await f.domains.get(web.serviceId), domains);
    assert.deepEqual(f.runtime.services, f.previousServices);
    assert.equal(f.caddy.sync.mock.callCount(), 0);
    assert.equal(f.git.mock.callCount(), gitCalls);
    assert.equal(f.runtime.backups.size, 0);
  } finally {
    release.resolve();
    await updating;
  }
  assert.equal((await f.applications.updateGitApp(f.app.id)).updated, false);
});

test('startup rolls an applying journal back and restores the previous persisted plan', async (t) => {
  const f = await fixture(t);
  await f.repositories.refresh(f.app.id);
  const updates = [];
  for (const previous of f.previousUpdates) {
    const build = await f.repositories.prepareSavedBuild(f.app.id, previous.recipe);
    try {
      const result = await f.runtime.buildImage(build);
      await f.repositories.recordBuild(f.app.id, build, result.imageId);
      updates.push({ ...previous, image: result.image, imageId: result.imageId, commit: nextCommit });
    } finally {
      await build.cleanup();
    }
  }
  await f.repositories.saveUpdateRun(f.app.id, { phase: 'applying', commit: nextCommit, previousUpdates: f.previousUpdates, updates });
  for (const [index, update] of updates.entries()) await f.runtime.beginContainerImageReplacement(f.previousServices[index].id, update.image);
  await f.repositories.saveServiceUpdates(f.app.id, updates);
  const store = new AppStore(f.directory);
  const repositories = new RepositoryService(store, f.repositoriesDir, f.resolveHost, f.git);
  const restarted = f.makeApplications(store, repositories);
  const gitCalls = f.git.mock.callCount();
  await assert.rejects(restarted.updateGitApp(f.app.id), /interrupted update needs recovery/);
  assert.equal(f.git.mock.callCount(), gitCalls);
  f.events.length = 0;
  await restarted.recoverUpdates();
  assert.deepEqual(f.events, ['recover:rollback', 'rollback:web', 'rollback:worker', 'routes']);
  assert.deepEqual(f.runtime.services, f.previousServices);
  assert.deepEqual(await repositories.getServiceUpdates(f.app.id), f.previousUpdates);
  assert.equal((await store.get(f.app.id)).source.currentCommit, currentCommit);
  assert.equal((await store.get(f.app.id)).deployment.errorCode, 'deployment_failed');
  assert.equal(await repositories.getUpdateRun(f.app.id), undefined);
  assert.deepEqual(f.caddy.sync.mock.calls.at(-1).arguments[0].map(({ id }) => id), f.previousServices.map(({ id }) => id));
  await restarted.recoverUpdates();
  assert.deepEqual(f.runtime.services, f.previousServices);
});

test('startup publishes the committed plan and commit when finalization failed before either was saved', async (t) => {
  const f = await fixture(t);
  t.mock.method(f.repositories, 'saveServiceUpdates', async () => { throw new Error('Plan publication interrupted'); });
  await assert.rejects(f.applications.updateGitApp(f.app.id), /committed, but finalization is pending/);
  const run = await f.repositories.getUpdateRun(f.app.id);
  assert.equal(run.phase, 'committed');
  assert.equal(f.runtime.backups.size, 2);
  assert.equal((await f.apps.get(f.app.id)).source.currentCommit, currentCommit);
  assert.deepEqual(await f.repositories.getServiceUpdates(f.app.id), f.previousUpdates);
  const store = new AppStore(f.directory);
  const repositories = new RepositoryService(store, f.repositoriesDir, f.resolveHost, f.git);
  const restarted = f.makeApplications(store, repositories);
  const gitCalls = f.git.mock.callCount();
  f.events.length = 0;
  await restarted.recoverUpdates();
  assert.deepEqual(f.events, ['recover:forward', 'cleanup:web', 'cleanup:worker', 'recover:forward', 'routes']);
  assert.deepEqual(await repositories.getServiceUpdates(f.app.id), run.updates);
  assert.equal((await store.get(f.app.id)).source.currentCommit, nextCommit);
  assert.equal((await store.get(f.app.id)).deployment.status, 'running');
  assert.equal(await repositories.getUpdateRun(f.app.id), undefined);
  assert.equal(f.runtime.backups.size, 0);
  assert.equal(f.git.mock.callCount(), gitCalls);
  assert.deepEqual(f.runtime.services.slice(0, 2).map(({ image }) => image), run.updates.map(({ image }) => image));
});

test('a committed journal finishes forward on restart after partial container cleanup, never rolling back', async (t) => {
  const f = await fixture(t);
  const recover = f.runtime.recoverContainerReplacements.bind(f.runtime);
  const recovery = t.mock.method(f.runtime, 'recoverContainerReplacements', async (committedApps, appId) => {
    assert.ok(committedApps.has(f.app.id));
    assert.equal(appId, f.app.id);
    assert.equal((await f.repositories.getUpdateRun(f.app.id)).phase, 'committed');
    await f.runtime.backups.values().next().value.transaction.commit();
    throw new Error('Docker unavailable during second backup cleanup');
  });
  await assert.rejects(f.applications.updateGitApp(f.app.id), /committed, but finalization is pending/);
  assert.equal(f.runtime.backups.size, 1);
  const run = await f.repositories.getUpdateRun(f.app.id);
  assert.equal(run.phase, 'committed');
  assert.deepEqual(await f.repositories.getServiceUpdates(f.app.id), run.updates);
  assert.equal((await f.apps.get(f.app.id)).source.currentCommit, nextCommit);
  const gitCalls = f.git.mock.callCount();
  await assert.rejects(f.applications.updateGitApp(f.app.id), /An App update or its recovery is in progress/);
  assert.equal(f.git.mock.callCount(), gitCalls);
  recovery.mock.restore();
  const recoverCalls = t.mock.method(f.runtime, 'recoverContainerReplacements', recover);
  const store = new AppStore(f.directory);
  const repositories = new RepositoryService(store, f.repositoriesDir, f.resolveHost, f.git);
  const restarted = f.makeApplications(store, repositories);
  f.events.length = 0;
  await restarted.recoverUpdates();
  assert.deepEqual(f.events, ['recover:forward', 'cleanup:worker', 'recover:forward', 'routes']);
  assert.deepEqual(recoverCalls.mock.calls.map((call) => call.arguments), [[new Set([f.app.id])], [new Set([f.app.id]), f.app.id]]);
  assert.equal(f.runtime.backups.size, 0);
  assert.equal(await repositories.getUpdateRun(f.app.id), undefined);
  assert.deepEqual(await repositories.getServiceUpdates(f.app.id), run.updates);
  assert.equal((await store.get(f.app.id)).source.currentCommit, nextCommit);
  assert.equal((await store.get(f.app.id)).deployment.status, 'running');
  assert.deepEqual(f.runtime.services.slice(0, 2).map(({ image }) => image), run.updates.map(({ image }) => image));
  assert.deepEqual(f.runtime.services[2], f.previousServices[2]);
  assert.equal(f.git.mock.callCount(), gitCalls);
  await restarted.recoverUpdates();
  assert.equal(f.runtime.backups.size, 0);
});

test('chat recovery finishes a committed update without restarting HalfCloud', async (t) => {
  const f = await fixture(t);
  const interrupted = t.mock.method(f.repositories, 'saveServiceUpdates', async () => { throw new Error('Plan publication interrupted'); });
  await assert.rejects(f.applications.updateGitApp(f.app.id), /finalization is pending/);
  assert.equal((await f.repositories.getUpdateRun(f.app.id)).phase, 'committed');
  interrupted.mock.restore();
  const result = await f.applications.recoverGitAppUpdate(f.app.id);
  assert.deepEqual(result, { appId: f.app.id, recovered: true, result: 'completed' });
  assert.equal(await f.repositories.getUpdateRun(f.app.id), undefined);
  assert.equal(f.runtime.backups.size, 0);
  assert.equal((await f.apps.get(f.app.id)).source.currentCommit, nextCommit);
  assert.equal((await f.applications.updateGitApp(f.app.id)).updated, false);
});

test('a removed recovery journal releases the guard even when its directory sync reports failure', async (t) => {
  const f = await fixture(t);
  const clear = f.repositories.clearUpdateRun.bind(f.repositories);
  let failed = false;
  t.mock.method(f.repositories, 'clearUpdateRun', async (appId) => {
    await clear(appId);
    if (!failed) {
      failed = true;
      throw new Error('Directory sync failed after journal removal');
    }
  });
  await assert.rejects(f.applications.updateGitApp(f.app.id), /finalization is pending/);
  assert.equal(await f.repositories.getUpdateRun(f.app.id), undefined);
  assert.deepEqual(await f.applications.recoverGitAppUpdate(f.app.id), {
    appId: f.app.id, recovered: false, message: 'No interrupted update needed recovery',
  });
  assert.equal((await f.applications.updateGitApp(f.app.id)).updated, false);
});

test('startup quarantines missing committed replacements and chat restores a complete previous generation', async (t) => {
  const f = await fixture(t);
  const issues = f.previousUpdates.map(({ serviceId }, index) => ({
    code: 'missing_replacement', appId: f.app.id, serviceId,
    name: f.previousServices[index].runtimeName, backupId: `backup-${index}`, backupName: `backup-${index}-pending`,
  }));
  const recover = t.mock.method(f.runtime, 'recoverContainerReplacements', async (committedApps) => {
    f.events.push(committedApps.has(f.app.id) ? 'recover:forward' : 'recover:rollback');
    return committedApps.has(f.app.id) ? issues : [];
  });
  await assert.rejects(f.applications.updateGitApp(f.app.id), /finalization is pending/);
  assert.equal((await f.repositories.getUpdateRun(f.app.id)).phase, 'committed');
  await f.applications.recoverUpdates();
  assert.equal((await f.repositories.getUpdateRun(f.app.id)).phase, 'committed');
  assert.equal((await f.apps.get(f.app.id)).deployment.status, 'failed');
  await assert.rejects(f.applications.startApp(f.app.id), /update or its recovery is in progress/);
  const result = await f.applications.recoverGitAppUpdate(f.app.id);
  assert.deepEqual(result, { appId: f.app.id, recovered: true, result: 'rolled_back' });
  assert.equal(await f.repositories.getUpdateRun(f.app.id), undefined);
  assert.deepEqual(f.runtime.services, f.previousServices);
  assert.deepEqual(await f.repositories.getServiceUpdates(f.app.id), f.previousUpdates);
  assert.equal((await f.apps.get(f.app.id)).source.currentCommit, currentCommit);
  recover.mock.restore();
  assert.equal((await f.applications.updateGitApp(f.app.id)).updated, true);
});

test('uncertain commit writes retain all containers and recover forward, including unreadable decisions', async (t) => {
  for (const unreadable of [false, true]) await t.test(unreadable ? 'decision reread fails closed' : 'committed rename followed by sync failure', async (t) => {
    const f = await fixture(t);
    const save = f.repositories.saveUpdateRun.bind(f.repositories);
    const read = f.repositories.getUpdateRun.bind(f.repositories);
    let attemptedCommit = false;
    t.mock.method(f.repositories, 'saveUpdateRun', async (appId, run) => {
      await save(appId, run);
      if (run.phase === 'committed') {
        attemptedCommit = true;
        throw new Error('Directory sync failed after journal rename');
      }
    });
    const reread = t.mock.method(f.repositories, 'getUpdateRun', async (appId) => {
      if (unreadable && attemptedCommit) throw new Error('Journal read failed');
      return read(appId);
    });
    await assert.rejects(f.applications.updateGitApp(f.app.id), unreadable ? /commit decision could not be read/ : /committed, but finalization is pending/);
    assert.equal(reread.mock.callCount(), 3);
    const run = await read(f.app.id);
    assert.equal(run.phase, 'committed');
    assert.equal(f.runtime.backups.size, 2);
    assert.ok(!f.events.some((event) => /^(rollback|cleanup|recover):/.test(event)));
    assert.equal(f.repositories.clearUpdateRun.mock.callCount(), 0);
    assert.equal(f.repositories.saveServiceUpdates.mock.callCount(), 0);
    assert.deepEqual(await f.repositories.getServiceUpdates(f.app.id), f.previousUpdates);
    assert.equal((await f.apps.get(f.app.id)).source.currentCommit, currentCommit);
    await assert.rejects(f.applications.updateGitApp(f.app.id), /An App update or its recovery is in progress/);
    await assert.rejects(f.applications.deleteApp(f.app.id), /An App update or its recovery is in progress/);
    if (unreadable) {
      await assert.rejects(f.applications.recoverUpdates(), /Journal read failed/);
      assert.equal(f.runtime.backups.size, 2);
      assert.ok(!f.events.some((event) => /^(rollback|cleanup|recover):/.test(event)));
    }
    const store = new AppStore(f.directory);
    const repositories = new RepositoryService(store, f.repositoriesDir, f.resolveHost, f.git);
    f.events.length = 0;
    await f.makeApplications(store, repositories).recoverUpdates();
    assert.deepEqual(f.events, ['recover:forward', 'cleanup:web', 'cleanup:worker', 'recover:forward', 'routes']);
    assert.equal(f.runtime.backups.size, 0);
    assert.deepEqual(await repositories.getServiceUpdates(f.app.id), run.updates);
    assert.equal((await store.get(f.app.id)).source.currentCommit, nextCommit);
    assert.equal(await repositories.getUpdateRun(f.app.id), undefined);
    assert.deepEqual(f.runtime.services.slice(0, 2).map(({ image }) => image), run.updates.map(({ image }) => image));
  });
});

test('Docker healthcheck timing allows readiness after the default first probe at 30 seconds', async (t) => {
  const f = await fixture(t);
  const worker = f.runtime.services[1];
  f.wait.mock.restore();
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const inspect = f.runtime.inspectContainer.bind(f.runtime);
  const probes = t.mock.method(f.runtime, 'inspectContainer', async (id) => {
    now = [30_001, 31_000, 32_000, 33_000][probes.mock.callCount()];
    return {
      ...await inspect(id), health: now === 30_001 ? 'starting' : 'healthy',
      healthcheck: { intervalMs: 30_000, startPeriodMs: 0, startIntervalMs: 5_000, retries: 3, timeoutMs: 30_000 },
    };
  });
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Private worker readiness does not use HTTP'));
  await f.applications.waitForService(f.app.id, worker.serviceId, f.built[1].imageId, null);
  assert.equal(probes.mock.callCount(), 4);
  assert.equal(now, 33_000);
});

test('readiness requires three healthy image checks and accepts Basic Auth 401 only on the public route', async (t) => {
  const f = await fixture(t);
  const web = f.runtime.services[0];
  const stored = await f.domains.get(web.serviceId);
  await f.domains.replace(web.serviceId, stored.map((domain) => ({ ...domain, access: { type: 'basic_auth', username: 'operator', passwordHash: 'hash' } })));
  const inspect = t.mock.method(f.runtime, 'inspectContainer');
  const cancel = t.mock.fn(async () => {});
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal instanceof AbortSignal);
    return { status: url.startsWith('https:') ? 401 : 200, body: { cancel } };
  });
  f.wait.mock.restore();
  await f.applications.waitForService(f.app.id, web.serviceId, f.built[0].imageId, '/ready');
  assert.equal(inspect.mock.callCount(), 3);
  assert.equal(fetch.mock.callCount(), 6);
  assert.equal(cancel.mock.callCount(), 6);
  assert.deepEqual(fetch.mock.calls.map((call) => call.arguments[0]), Array.from({ length: 3 }, () => [
    'http://127.0.0.1:10001/ready', `https://${stored[0].hostname}/ready`,
  ]).flat());
});

test('readiness rejects wrong images, startup crash loops, unhealthy containers and failed HTTP checks', async (t) => {
  for (const scenario of [
    { name: 'wrong image', inspection: { imageId: `sha256:${'f'.repeat(64)}` }, error: /expected built image/, fetches: 0 },
    { name: 'missing-module startup crash', inspection: { state: 'restarting' }, error: /healthy and running/, fetches: 0 },
    { name: 'Docker health failure', inspection: { health: 'unhealthy' }, error: /healthy and running/, fetches: 0 },
    { name: 'local unauthorized', localStatus: 401, error: /Application health check returned HTTP 401/, fetches: 1 },
    { name: 'public HTTP failure', publicStatus: 503, error: /Public health check returned HTTP 503/, fetches: 2 },
    { name: 'unprotected public unauthorized', publicStatus: 401, error: /Public health check returned HTTP 401/, fetches: 2 },
  ]) await t.test(scenario.name, async (t) => {
    const f = await fixture(t);
    const web = f.runtime.services[0];
    let now = 0;
    t.mock.method(Date, 'now', () => now);
    const inspect = f.runtime.inspectContainer.bind(f.runtime);
    t.mock.method(f.runtime, 'inspectContainer', async (id) => {
      now = 30_001;
      return { ...await inspect(id), ...scenario.inspection };
    });
    const fetch = t.mock.method(globalThis, 'fetch', async (url) => ({
      status: url.startsWith('https:') ? scenario.publicStatus ?? 200 : scenario.localStatus ?? 200,
      body: { async cancel() {} },
    }));
    f.wait.mock.restore();
    await assert.rejects(f.applications.waitForService(f.app.id, web.serviceId, f.built[0].imageId, '/ready'), scenario.error);
    assert.equal(fetch.mock.callCount(), scenario.fetches);
  });
});
