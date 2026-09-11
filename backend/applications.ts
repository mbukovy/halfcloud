import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AppStore, type AppRecord } from './apps.js';
import { CaddyService } from './caddy.js';
import { DockerService, type ContainerRecoveryIssue, type ContainerReplacement, type CreateContainerInput, type DeploymentProgress, type ManagedVolumeFilter, type SearchContainerImagesInput, type ServiceCommandNetworkMode } from './docker.js';
import { DomainStore, normalizeHostname, type ServiceDomain } from './domains.js';
import { EnvironmentStore, assertEnvironmentVariableName, environmentRequestTargets, serializeEnvironmentForAgent, type EnvironmentTarget, type EnvironmentVariable } from './environment.js';
import { RouteAccessRequestStore, assertBasicAuthPassword, assertBasicAuthUsername, hashBasicAuthPassword } from './route-access.js';
import { GitRepositoryError, RepositoryService, normalizeRepositoryUrl, type RepositoryUpdateRun, type ServiceUpdateRecipe } from './repositories.js';
import { GitHubWebhookService, GitHubWebhookError, type GitHubWebhookTarget } from './github-webhooks.js';

export class AppBusyError extends Error {
  readonly code = 'app_busy';
}

export class ApplicationService {
  private readonly repositoryOperations = new Set<string>();
  private readonly updatingApps = new Set<string>();
  private webhookService?: GitHubWebhookService;

  constructor(
    private readonly docker: DockerService,
    private readonly caddy = new CaddyService(),
    private readonly domains = new DomainStore(),
    private readonly environment = new EnvironmentStore(),
    private readonly accessRequests = new RouteAccessRequestStore(),
    private readonly hashPassword: (password: string) => Promise<string> = hashBasicAuthPassword,
    private readonly apps = new AppStore(),
    private readonly repositories = new RepositoryService(apps),
  ) {}

  get githubWebhooks() {
    return this.webhookService ??= new GitHubWebhookService({
      target: (appId) => this.githubWebhookTarget(appId),
      update: (appId) => this.updateGitApp(appId),
      busy: (appId) => this.repositoryOperations.has(appId) || this.updatingApps.has(appId),
    }, this.apps.dataDir);
  }

  private async githubWebhookTarget(appIdOrName: string): Promise<GitHubWebhookTarget> {
    return this.withRepositoryOperation(appIdOrName, async (app) => {
      if (!app.source?.branch) throw new GitHubWebhookError(409, 'A GitHub App with a configured branch is required');
      const location = normalizeRepositoryUrl(app.source.url);
      if (location.provider !== 'github') throw new GitHubWebhookError(409, 'This App is not backed by GitHub');
      const recipes = await this.repositories.getServiceUpdates(app.id);
      const services = (await this.docker.listContainers(false)).filter((service) => service.appId === app.id);
      const prefix = `halfcloud/app-${app.id.slice(4).replaceAll('-', '')}:`;
      const ready = Boolean(app.source.currentCommit) && recipes.length > 0
        && recipes.every((recipe) => recipe.commit === app.source!.currentCommit && services.some((service) => service.serviceId === recipe.serviceId && service.image === recipe.image))
        && services.every((service) => !service.image.startsWith(prefix) || recipes.some((recipe) => recipe.serviceId === service.serviceId));
      return { appId: app.id, appName: app.name, repository: `${location.owner}/${location.repository}`.toLowerCase(), branch: app.source.branch, ready };
    });
  }

  requestGitHubWebhookSetup(appIdOrName: string) { return this.githubWebhooks.requestSetup(appIdOrName); }

  async getGitHubWebhookSetup(appIdOrName: string) {
    const app = await this.apps.get(appIdOrName);
    const setup = await this.githubWebhooks.getSetup(app.id);
    if (!setup) throw new GitHubWebhookError(404, 'GitHub webhook setup not found');
    return setup;
  }

  ping() { return this.docker.ping(); }
  searchContainerImages(input: SearchContainerImagesInput) { return this.docker.searchContainerImages(input); }
  getRuntimeInfo() { return this.docker.getRuntimeInfo(); }
  assertRootless() { return this.docker.assertRootless(); }
  ensureAppNetwork(appId: string) { return this.docker.ensureAppNetwork(appId); }
  async listContainers(includeStats = true) {
    const containers = await this.docker.listContainers(includeStats);
    return Promise.all(containers.map(async (container) => {
      const stored = await this.domains.get(container.serviceId ?? container.name, container.hostname);
      const domainStates = await this.domains.withReadiness(stored);
      const primary = domainStates.find((domain) => domain.primary);
      return { ...container, domains: domainStates, hostname: primary?.hostname };
    }));
  }

  async listApps(includeStats = true) {
    const [apps, services] = await Promise.all([this.apps.list(), this.listContainers(includeStats)]);
    return apps.map((app) => {
      const appServices = services.filter((service) => service.appId === app.id);
      const running = appServices.filter((service) => service.state === 'running').length;
      const failed = appServices.some((service) => ['dead', 'restarting'].includes(service.state));
      const status = !appServices.length
        ? app.deployment?.status === 'in_progress' ? 'deploying' : 'failed'
        : running === appServices.length ? 'running' : running === 0 ? 'stopped' : failed ? 'degraded' : 'partially_running';
      return {
        ...app,
        status,
        services: appServices,
        cpuPercent: Number(appServices.reduce((total, service) => total + service.cpuPercent, 0).toFixed(2)),
        memoryUsed: appServices.reduce((total, service) => total + service.memoryUsed, 0),
        runningServices: running,
      };
    });
  }

  async getApp(idOrName: string, includeStats = true) {
    const app = await this.apps.get(idOrName);
    return (await this.listApps(includeStats)).find((candidate) => candidate.id === app.id)!;
  }

  async createApp(input: { name: string; services: Array<Omit<CreateContainerInput, 'appId' | 'serviceId' | 'serviceName' | 'publicName' | 'name' | 'start'> & { name: string }> }, onProgress?: (progress: DeploymentProgress) => void) {
    if (!input.services.length) throw new Error('An App requires at least one Service');
    const names = input.services.map((service) => this.serviceName(service.name));
    if (new Set(names).size !== names.length) throw new Error('Service names must be unique within an App');
    const app = await this.apps.create(input.name);
    const created: string[] = [];
    try {
      for (const [index, service] of input.services.entries()) {
        const result = await this.createServiceRecord(app.id, { ...service, name: names[index]! }, onProgress);
        created.push(result.id);
      }
      onProgress?.({ phase: 'activity', label: `Verifying ${app.name}` });
      return this.getApp(app.id);
    } catch (error) {
      for (const id of created.reverse()) await this.docker.deleteContainer(id).catch(() => undefined);
      await this.docker.deleteAppNetwork(app.id).catch(() => undefined);
      await this.apps.deleteApp(app.id).catch(() => undefined);
      await this.syncRoutes().catch(() => undefined);
      throw error;
    }
  }

  async createGitApp(input: { name: string; repositoryUrl: string; branch?: string }, onProgress?: (progress: DeploymentProgress) => void) {
    const location = normalizeRepositoryUrl(input.repositoryUrl);
    const repositoryUrl = location.originalUrl;
    const now = new Date().toISOString();
    const app = await this.apps.create(input.name, {
      source: { type: 'git', url: repositoryUrl, ...(input.branch ? { branch: input.branch } : {}) },
      deployment: { status: 'in_progress', stage: 'cloning', message: 'Cloning repository', buildAttempts: 0, updatedAt: now },
    });
    if (location.requiresSsh) {
      const repositorySetup = await this.repositories.preparePrivateAccess(app.id, repositoryUrl);
      return { appId: app.id, appName: app.name, source: (await this.apps.get(app.id)).source, repositorySetup };
    }
    onProgress?.({ phase: 'activity', label: 'Cloning repository' });
    let result;
    try {
      result = await this.repositories.clone(app.id, repositoryUrl, input.branch);
    } catch (error) {
      if (location.provider === 'github' && error instanceof GitRepositoryError && (error.code === 'not_found' || error.code === 'not_public')) {
        const repositorySetup = await this.repositories.preparePrivateAccess(app.id, repositoryUrl);
        return { appId: app.id, appName: app.name, source: (await this.apps.get(app.id)).source, repositorySetup };
      }
      await this.repositories.fail(app.id, 'cloning', error).catch(() => undefined);
      throw error;
    }
    onProgress?.({ phase: 'activity', label: 'Inspecting repository' });
    try {
      const inspection = await this.repositories.inspect(app.id);
      return { ...result, inspection };
    } catch (error) {
      await this.repositories.fail(app.id, 'inspecting', error).catch(() => undefined);
      throw error;
    }
  }

  getRepositoryDeployKey(appIdOrName: string) { return this.repositories.getPrivateAccessSetup(appIdOrName); }
  verifyRepositoryDeployKey(appIdOrName: string) { return this.repositories.verifyPrivateAccess(appIdOrName); }

  async resumePrivateGitApp(appIdOrName: string, onProgress?: (progress: DeploymentProgress) => void) {
    const app = await this.apps.get(appIdOrName);
    if (app.source?.authentication !== 'ssh-deploy-key') throw new Error('This App is not waiting for private repository access');
    onProgress?.({ phase: 'activity', label: 'Cloning private repository' });
    const result = await this.repositories.clonePrivate(app.id, app.source.branch);
    onProgress?.({ phase: 'activity', label: 'Inspecting repository' });
    try {
      return { ...result, inspection: await this.repositories.inspect(app.id) };
    } catch (error) {
      await this.repositories.fail(app.id, 'inspecting', error).catch(() => undefined);
      throw error;
    }
  }

  async inspectRepository(appIdOrName: string) {
    return this.withRepositoryOperation(appIdOrName, async (app) => {
      try {
        return await this.repositories.inspect(app.id);
      } catch (error) {
        await this.repositories.fail(app.id, 'inspecting', error).catch(() => undefined);
        throw error;
      }
    });
  }
  async refreshGitRepository(appIdOrName: string, onProgress?: (progress: DeploymentProgress) => void) {
    return this.withRepositoryOperation(appIdOrName, async (app) => {
      onProgress?.({ phase: 'activity', label: 'Fetching latest Git changes' });
      return this.repositories.refresh(app.id);
    });
  }

  async deployRepositoryImage(appIdOrName: string, serviceIdOrName: string, image: string, healthPath?: string) {
    return this.withRepositoryOperation(appIdOrName, async (app) => {
      if (healthPath !== undefined && (!/^\/[^\x00-\x1f\x7f]*$/.test(healthPath) || healthPath.length > 500)) throw new Error('Invalid readiness path');
      const build = await this.repositories.getBuild(app.id, image);
      if (!build || build.commit !== app.source?.resolvedCommit) throw new Error('Use a successfully built image for this App and commit');
      const service = await this.service(app.id, serviceIdOrName);
      const saved = (await this.repositories.getServiceUpdates(app.id)).find((recipe) => recipe.serviceId === service.serviceId);
      let replacement: ContainerReplacement | undefined;
      try {
        await this.repositories.setStage(app.id, 'deploying', `Updating ${service.name}`);
        replacement = await this.docker.beginContainerImageReplacement(service.id, image);
        await this.syncRoutes();
        if (replacement.state === 'running') await this.waitForService(app.id, service.serviceId!, build.imageId, service.ports.some((port) => port.protocol === 'tcp') ? healthPath ?? saved?.healthPath ?? '/' : null);
      } catch (error) {
        if (replacement) await replacement.rollback();
        await this.repositories.fail(app.id, 'deploying', error);
        await this.syncRoutes().catch(() => undefined);
        throw error;
      }
      await replacement.commit();
      return { appId: app.id, serviceId: service.serviceId, image, containerId: replacement.containerId, state: replacement.state };
    });
  }

  async updateGitApp(appIdOrName: string, onProgress?: (progress: DeploymentProgress) => void) {
    return this.withRepositoryOperation(appIdOrName, async (app) => {
      if (await this.repositories.getUpdateRun(app.id)) throw new Error('An interrupted update needs recovery before another update can start');
      const previousUpdates = await this.repositories.getServiceUpdates(app.id);
      if (!previousUpdates.length) throw new Error('This App has no verified update recipes. Prepare and verify its per-Service deployment recipes once before using automatic updates. No Services were changed.');
      const runtime = await this.getApp(app.id, false);
      const repositoryPrefix = `halfcloud/app-${app.id.slice(4).replaceAll('-', '')}:`;
      if (runtime.services.some((service) => service.image.startsWith(repositoryPrefix) && !previousUpdates.some((recipe) => recipe.serviceId === service.serviceId))) {
        throw new Error('Every repository-built Service needs a verified update recipe before updating the App');
      }
      if (runtime.services.some((service) => service.state !== 'running')) throw new Error('All Services must be running before a deterministic update; repair or start the App first');
      for (const recipe of previousUpdates) {
        const service = await this.service(app.id, recipe.serviceId);
        if ((await this.docker.inspectContainer(service.id)).imageId !== recipe.imageId) throw new Error(`The running image for ${service.name} differs from its verified update recipe`);
      }
      this.updatingApps.add(app.id);
      let run: RepositoryUpdateRun | undefined;
      let failedStage: 'cloning' | 'building' | 'deploying' | 'verifying' = 'cloning';
      let recovered = true;
      let commitDecisionUncertain = false;
      const replacements: ContainerReplacement[] = [];
      try {
        onProgress?.({ phase: 'activity', label: 'Fetching latest Git changes' });
        const refreshed = await this.repositories.refresh(app.id);
        const commit = refreshed.source!.resolvedCommit!;
        if (app.source?.currentCommit === commit && previousUpdates.every((recipe) => recipe.commit === commit)) {
          return { appId: app.id, commit, updated: false, message: 'Already up to date' };
        }
        const updates: ServiceUpdateRecipe[] = [];
        failedStage = 'building';
        // Build every Service first. Build failures never interrupt the running App.
        for (const recipe of previousUpdates) {
          const service = await this.service(app.id, recipe.serviceId);
          const label = `Building update for ${service.name}`;
          onProgress?.({ phase: 'activity', label });
          await this.repositories.setStage(app.id, 'building', label);
          const build = await this.repositories.prepareSavedBuild(app.id, recipe.recipe);
          try {
            const result = await this.docker.buildImage(build);
            await this.repositories.recordBuild(app.id, build, result.imageId);
            updates.push({ ...recipe, image: result.image, imageId: result.imageId, commit });
          } finally {
            await build.cleanup?.();
          }
        }
        run = { phase: 'applying', commit, previousUpdates, updates };
        await this.repositories.saveUpdateRun(app.id, run);
        failedStage = 'deploying';
        await this.repositories.setStage(app.id, 'deploying', 'Replacing application Services');
        onProgress?.({ phase: 'activity', label: 'Updating application Services' });
        for (const update of updates) {
          const service = await this.service(app.id, update.serviceId);
          replacements.push(await this.docker.beginContainerImageReplacement(service.id, update.image));
        }
        await this.syncRoutes();
        failedStage = 'verifying';
        await this.repositories.setStage(app.id, 'verifying', 'Checking updated Services');
        onProgress?.({ phase: 'activity', label: 'Checking the updated App' });
        await Promise.all(updates.map((update) => this.waitForService(app.id, update.serviceId, update.imageId, update.healthPath)));
        // Recheck the whole group: an early-ready Service may have failed while another warmed up.
        await Promise.all(updates.map((update) => this.waitForService(app.id, update.serviceId, update.imageId, update.healthPath, true)));
        const ready = await this.getApp(app.id, false);
        if (ready.services.some((service) => service.state !== 'running')) throw new Error('A Service stopped during update verification');
        // This durable App-wide decision precedes deleting ANY previous container.
        const committed = { ...run, phase: 'committed' as const };
        commitDecisionUncertain = true;
        await this.repositories.saveUpdateRun(app.id, committed);
        run = committed;
        commitDecisionUncertain = false;
        await this.finishUpdate(app.id, committed);
        return { appId: app.id, commit, updated: true, services: updates.map(({ serviceId, image }) => ({ serviceId, image })) };
      } catch (error) {
        if (commitDecisionUncertain) {
          try {
            const persisted = await this.repositories.getUpdateRun(app.id);
            if (!persisted || persisted.commit !== run?.commit) throw new Error('Could not reconcile the update decision');
            run = persisted;
          } catch {
            recovered = false;
            throw new Error('The update commit decision could not be read. Containers were retained; recover this App update before trying again.');
          }
        }
        if (run?.phase === 'committed') {
          recovered = false;
          throw new Error('The update passed verification and was committed, but finalization is pending. Recover this App update to finish safely; do not rebuild or replace the App.');
        }
        try {
          for (const replacement of replacements.reverse()) await replacement.rollback();
          if (run) {
            this.assertContainerRecoveryComplete(await this.docker.recoverContainerReplacements(new Set(), app.id));
            await this.repositories.saveServiceUpdates(app.id, previousUpdates);
          }
          await this.syncRoutes();
          await this.repositories.fail(app.id, failedStage, error);
          if (run) await this.repositories.clearUpdateRun(app.id);
        } catch (rollbackError) {
          recovered = false;
          throw new AggregateError([error, rollbackError], 'Update failed and recovery is incomplete. Previous containers were retained; recover this App update before trying again.');
        }
        throw error;
      } finally {
        if (recovered) this.updatingApps.delete(app.id);
        else await this.releaseUpdateGuardIfSettled(app.id);
      }
    });
  }

  private async finishUpdate(appId: string, run: RepositoryUpdateRun) {
    await this.repositories.saveServiceUpdates(appId, run.updates);
    const app = await this.apps.get(appId);
    await this.apps.update(appId, {
      source: { ...app.source!, currentCommit: run.commit },
      deployment: { ...app.deployment, image: undefined, status: 'running', stage: 'running', message: 'Update complete', errorCode: undefined, updatedAt: new Date().toISOString() },
    });
    this.assertContainerRecoveryComplete(await this.docker.recoverContainerReplacements(new Set([appId]), appId));
    await this.syncRoutes();
    await this.repositories.clearUpdateRun(appId);
  }

  async recoverGitAppUpdate(appIdOrName: string, onProgress?: (progress: DeploymentProgress) => void) {
    const app = await this.apps.get(appIdOrName);
    if (app.source?.type !== 'git') throw new Error('This App is not backed by a Git repository');
    if (this.repositoryOperations.has(app.id)) throw new AppBusyError('Another repository operation is in progress for this App; wait for it to finish');
    this.repositoryOperations.add(app.id);
    this.updatingApps.add(app.id);
    try {
      const run = await this.repositories.getUpdateRun(app.id);
      const repairingServiceIds = new Set(run?.repairingServiceIds ?? []);
      const repairingServices = repairingServiceIds.size ? new Map([[app.id, repairingServiceIds]]) : new Map();
      const issues = await this.docker.recoverContainerReplacements(run?.phase === 'committed' ? new Set([app.id]) : new Set(), app.id, repairingServices);
      if (issues.length) {
        if (run?.phase === 'committed' && issues.every(({ serviceId }) => run.updates.some((update) => update.serviceId === serviceId))) {
          await this.repairCommittedUpdate(app.id, run, issues, onProgress);
          return { appId: app.id, recovered: true, result: 'completed' as const };
        }
        await this.markUpdateRecoveryRequired(app.id, issues);
        throw new Error('This update cannot be recovered automatically because its retained Service does not match the committed update. The Service and recovery record were preserved.');
      }
      if (!run) return { appId: app.id, recovered: false, message: 'No interrupted update needed recovery' };
      if (run.phase === 'committed') {
        await this.finishUpdate(app.id, run);
        return { appId: app.id, recovered: true, result: 'completed' as const };
      }
      await this.repositories.saveServiceUpdates(app.id, run.previousUpdates);
      await this.repositories.fail(app.id, 'deploying', new Error('Interrupted update was rolled back to the previous containers'));
      await this.syncRoutes();
      await this.repositories.clearUpdateRun(app.id);
      return { appId: app.id, recovered: true, result: 'rolled_back' as const };
    } finally {
      await this.releaseUpdateGuardIfSettled(app.id);
      this.repositoryOperations.delete(app.id);
    }
  }

  private async releaseUpdateGuardIfSettled(appId: string) {
    try {
      if (!await this.repositories.getUpdateRun(appId)) this.updatingApps.delete(appId);
    } catch {
      // Keep the guard when durable recovery state cannot be read safely.
    }
  }

  private assertContainerRecoveryComplete(issues: ContainerRecoveryIssue[]) {
    if (issues.length) throw new Error('A committed update is missing a replacement Service; the previous Service and recovery record were retained');
  }

  private async markUpdateRecoveryRequired(appId: string, issues: ContainerRecoveryIssue[]) {
    this.updatingApps.add(appId);
    await this.repositories.fail(appId, 'deploying', new Error(
      `${issues.length === 1 ? 'A replacement Service is' : 'Replacement Services are'} missing from a committed update. Previous Services were retained for safe recovery.`,
    ));
  }

  private async repairCommittedUpdate(appId: string, run: RepositoryUpdateRun, issues: ContainerRecoveryIssue[], onProgress?: (progress: DeploymentProgress) => void) {
    const repairIds = [...new Set(issues.map(({ serviceId }) => serviceId))];
    const repairing = { ...run, repairingServiceIds: repairIds };
    await this.repositories.saveUpdateRun(appId, repairing);
    let repairCommitted = false;
    try {
      for (const issue of issues) {
        const update = run.updates.find(({ serviceId }) => serviceId === issue.serviceId)!;
        onProgress?.({ phase: 'activity', label: `Recreating retained Service ${issue.name}` });
        try {
          await this.docker.assertImageIdentity(update.image, update.imageId);
        } catch {
          const build = await this.repositories.prepareSavedBuild(appId, update.recipe);
          try {
            if (build.commit !== run.commit) throw new Error('The committed source revision is no longer checked out');
            const rebuilt = await this.docker.buildImage(build);
            if (rebuilt.imageId !== update.imageId) throw new Error('The committed image could not be reproduced exactly');
            await this.repositories.recordBuild(appId, build, rebuilt.imageId);
          } finally {
            await build.cleanup?.();
          }
        }
        await this.docker.recreateMissingContainerReplacement(issue, update.image, update.imageId);
      }
      await this.syncRoutes();
      onProgress?.({ phase: 'activity', label: 'Checking the repaired App' });
      await Promise.all(run.updates.map((update) => this.waitForService(appId, update.serviceId, update.imageId, update.healthPath)));
      await Promise.all(run.updates.map((update) => this.waitForService(appId, update.serviceId, update.imageId, update.healthPath, true)));
      const ready = await this.getApp(appId, false);
      if (ready.services.some((service) => service.state !== 'running')) throw new Error('A Service stopped during repair verification');
      const { repairingServiceIds: _repairingServiceIds, ...committed } = repairing;
      await this.repositories.saveUpdateRun(appId, committed);
      repairCommitted = true;
      await this.finishUpdate(appId, committed);
    } catch (error) {
      if (repairCommitted) throw new Error('The repaired update passed verification, but finalization is pending. Recover this App update again to finish safely.');
      await this.docker.recoverContainerReplacements(new Set([appId]), appId, new Map([[appId, new Set(repairIds)]])).catch(() => undefined);
      await this.markUpdateRecoveryRequired(appId, issues);
      throw new Error(`The missing Service could not be recreated safely: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async recoverUpdates() {
    const runs = [];
    for (const app of await this.apps.list()) {
      if (app.source?.type !== 'git') continue;
      const run = await this.repositories.getUpdateRun(app.id);
      // A previous process may have seen a rename succeed but its directory fsync fail.
      if (run?.phase === 'committed') await this.repositories.saveUpdateRun(app.id, run);
      if (run) {
        this.updatingApps.add(app.id);
        runs.push({ appId: app.id, run });
      }
    }
    const repairingServices = new Map(runs.flatMap(({ appId, run }) => run.repairingServiceIds?.length
      ? [[appId, new Set(run.repairingServiceIds)] as const] : []));
    const issues = await this.docker.recoverContainerReplacements(
      new Set(runs.filter(({ run }) => run.phase === 'committed').map(({ appId }) => appId)), undefined, repairingServices,
    );
    const unresolvedApps = new Set(issues.map(({ appId }) => appId));
    for (const appId of unresolvedApps) await this.markUpdateRecoveryRequired(appId, issues.filter((issue) => issue.appId === appId));
    for (const { appId, run } of runs) {
      if (unresolvedApps.has(appId)) continue;
      if (run.phase === 'committed') await this.finishUpdate(appId, run);
      else {
        await this.repositories.saveServiceUpdates(appId, run.previousUpdates);
        await this.repositories.fail(appId, 'deploying', new Error('Interrupted update was rolled back to the previous containers'));
        await this.syncRoutes();
        await this.repositories.clearUpdateRun(appId);
      }
      this.updatingApps.delete(appId);
    }
  }

  private async withRepositoryOperation<T>(appIdOrName: string, operation: (app: AppRecord) => Promise<T>): Promise<T> {
    const app = await this.apps.get(appIdOrName);
    if (app.source?.type !== 'git') throw new Error('This App is not backed by a Git repository');
    this.assertAppNotUpdating(app.id);
    if (this.repositoryOperations.has(app.id)) throw new AppBusyError('Another repository operation is in progress for this App; wait for it to finish');
    this.repositoryOperations.add(app.id);
    try {
      return await operation(await this.apps.get(app.id));
    } finally {
      this.repositoryOperations.delete(app.id);
    }
  }
  listRepositoryDirectory(appIdOrName: string, repositoryPath?: string) { return this.repositories.listDirectory(appIdOrName, repositoryPath); }
  readRepositoryFile(appIdOrName: string, repositoryPath: string) { return this.repositories.readFile(appIdOrName, repositoryPath); }
  writeRepositoryDeploymentFile(appIdOrName: string, repositoryPath: string, content: string) {
    return this.withRepositoryOperation(appIdOrName, (app) => this.repositories.writeDeploymentFile(app.id, repositoryPath, content));
  }
  retryRepositoryBuild(appIdOrName: string) {
    return this.withRepositoryOperation(appIdOrName, (app) => this.repositories.retryBuild(app.id));
  }

  async buildRepositoryImage(
    appIdOrName: string,
    contextPath = '.',
    dockerfilePath = 'Dockerfile',
    onProgress?: (progress: DeploymentProgress) => void,
    generatedFiles?: { dockerfileContent: string; dockerignoreContent: string },
  ) {
    return this.withRepositoryOperation(appIdOrName, async () => {
      let build;
      try {
        build = generatedFiles && (generatedFiles.dockerfileContent !== '' || generatedFiles.dockerignoreContent !== '')
          ? await this.repositories.prepareGeneratedBuildContext(appIdOrName, contextPath, generatedFiles.dockerfileContent, generatedFiles.dockerignoreContent)
          : await this.repositories.buildContext(appIdOrName, contextPath, dockerfilePath);
        onProgress?.({ phase: 'activity', label: 'Building application' });
        const result = await this.docker.buildImage(build);
        await this.repositories.recordBuild(appIdOrName, build, result.imageId);
        await this.repositories.buildSucceeded(appIdOrName, result.image);
        return { appId: (await this.apps.get(appIdOrName)).id, commit: build.commit, ...result };
      } catch (error) {
        await this.repositories.fail(appIdOrName, 'building', error);
        throw error;
      } finally {
        await build?.cleanup?.();
      }
    });
  }

  async addService(appIdOrName: string, input: Omit<CreateContainerInput, 'appId' | 'serviceId' | 'serviceName' | 'publicName' | 'name' | 'start'> & { name: string }, onProgress?: (progress: DeploymentProgress) => void) {
    const app = await this.apps.get(appIdOrName);
    this.assertAppNotUpdating(app.id);
    const sourceDeployment = app.source?.type === 'git' && app.source.resolvedCommit !== app.source.currentCommit;
    if (sourceDeployment) await this.repositories.setStage(app.id, 'deploying', `Preparing ${input.name}`);
    try {
      const name = this.serviceName(input.name);
      const existing = (await this.getApp(app.id, false)).services;
      if (existing.some((service) => service.name === name)) throw new Error(`Service ${name} already exists in ${app.name}`);
      await this.createServiceRecord(app.id, { ...input, name }, onProgress);
      onProgress?.({ phase: 'activity', label: `Verifying ${name}` });
      return this.getApp(app.id);
    } catch (error) {
      if (sourceDeployment) await this.repositories.fail(app.id, 'deploying', error);
      throw error;
    }
  }

  async renameApp(appIdOrName: string, name: string) {
    return this.apps.renameApp(appIdOrName, name);
  }

  async startApp(idOrName: string) {
    const app = await this.apps.get(idOrName);
    this.assertAppNotUpdating(app.id);
    const sourceDeployment = app.source?.type === 'git' && app.source.resolvedCommit !== app.source.currentCommit;
    if (sourceDeployment) await this.repositories.setStage(app.id, 'deploying', 'Starting application');
    try {
      return await this.appAction(app.id, (id) => this.startContainer(id), (state) => state !== 'running');
    } catch (error) {
      if (sourceDeployment) await this.repositories.fail(app.id, 'deploying', error);
      throw error;
    }
  }
  async stopApp(idOrName: string) { return this.appAction(idOrName, (id) => this.stopContainer(id), (state) => state === 'running'); }
  async restartApp(idOrName: string) { return this.appAction(idOrName, (id) => this.restartContainer(id)); }
  async recreateApp(idOrName: string) {
    const result = await this.appAction(idOrName, (id) => this.docker.recreateContainer(id));
    await this.syncRoutes();
    return result;
  }

  async deleteApp(idOrName: string, deleteData = false) {
    const app = await this.getApp(idOrName, false);
    this.assertAppNotUpdating(app.id);
    await this.webhookService?.remove(app.id);
    const deployKeyRemovalUrl = app.source?.authentication === 'ssh-deploy-key' ? app.source.settingsUrl : undefined;
    for (const service of app.services) await this.docker.deleteContainer(service.id);
    await this.docker.deleteAppNetwork(app.id);
    if (deleteData) {
      for (const volume of await this.docker.listManagedVolumes()) {
        if (app.services.some((service) => service.serviceId === volume.application)) await this.docker.deleteManagedVolume(volume.name);
      }
    }
    await this.repositories.delete(app.id);
    await this.apps.deleteApp(app.id);
    await this.syncRoutes();
    return { appId: app.id, appName: app.name, deleted: true, persistentDataDeleted: deleteData, ...(deployKeyRemovalUrl ? { deployKeyRemovalUrl } : {}) };
  }

  async getAppLogs(idOrName: string, tail = 200) {
    const app = await this.getApp(idOrName, false);
    const entries = await Promise.all(app.services.map(async (service) => ({ name: service.name, ...(await this.docker.getContainerLogs(service.id, tail)) })));
    const logs = entries
      .flatMap((entry) => entry.logs.split('\n').filter(Boolean).map((line) => ({ line, output: `[${entry.name}] ${line}` })))
      .sort((left, right) => left.line.localeCompare(right.line))
      .map((entry) => entry.output)
      .join('\n');
    return { appId: app.id, logs };
  }

  async service(appIdOrName: string, serviceIdOrName: string) {
    const app = await this.getApp(appIdOrName, false);
    const matches = app.services.filter((service) => service.serviceId === serviceIdOrName || service.id === serviceIdOrName || service.id.startsWith(serviceIdOrName) || service.name === serviceIdOrName);
    if (!matches.length) throw new Error(`Service ${serviceIdOrName} was not found in ${app.name}`);
    if (matches.length > 1) throw new Error(`Service ${serviceIdOrName} is ambiguous`);
    return matches[0]!;
  }

  async startService(appIdOrName: string, serviceIdOrName: string) {
    const app = await this.apps.get(appIdOrName);
    this.assertAppNotUpdating(app.id);
    const sourceDeployment = app.source?.type === 'git' && app.source.resolvedCommit !== app.source.currentCommit;
    if (sourceDeployment) await this.repositories.setStage(app.id, 'deploying', `Starting ${serviceIdOrName}`);
    try {
      return await this.startContainer((await this.service(app.id, serviceIdOrName)).id);
    } catch (error) {
      if (sourceDeployment) await this.repositories.fail(app.id, 'deploying', error);
      throw error;
    }
  }
  async stopService(appIdOrName: string, serviceIdOrName: string) { return this.stopContainer((await this.service(appIdOrName, serviceIdOrName)).id); }
  async restartService(appIdOrName: string, serviceIdOrName: string) { return this.restartContainer((await this.service(appIdOrName, serviceIdOrName)).id); }
  async recreateService(appIdOrName: string, serviceIdOrName: string) {
    const service = await this.service(appIdOrName, serviceIdOrName);
    this.assertAppNotUpdating(service.appId!);
    const result = await this.docker.recreateContainer(service.id);
    await this.syncRoutes();
    return result;
  }
  async removeService(appIdOrName: string, serviceIdOrName: string) {
    const app = await this.getApp(appIdOrName, false);
    if (app.services.length === 1) throw new Error('Delete the App instead of removing its only Service');
    const service = await this.service(app.id, serviceIdOrName);
    await this.deleteContainer(service.id);
    return { appId: app.id, serviceId: service.serviceId, deleted: true };
  }
  getContainerLogs(id: string, tail?: number) { return this.docker.getContainerLogs(id, tail); }
  getContainerStats(id: string) { return this.docker.getContainerStats(id); }
  async runServiceInitializationCommand(appIdOrName: string, serviceIdOrName: string, command: string[], networkMode: ServiceCommandNetworkMode = 'app') {
    const app = await this.apps.get(appIdOrName);
    this.assertAppNotUpdating(app.id);
    const service = await this.service(app.id, serviceIdOrName);
    return this.docker.runServiceInitializationCommand(service.id, command, networkMode);
  }

  async verifyGitDeployment(appIdOrName: string, serviceIdOrName?: string, healthPath = '/', serviceHealthPaths: Record<string, string> = {}) {
    return this.withRepositoryOperation(appIdOrName, async (appRecord) => {
      if (!/^\/[^\x00-\x1f\x7f]*$/.test(healthPath) || healthPath.length > 500) throw new Error('Health path must be a bounded absolute URL path');
      const paths = new Map(Object.entries(serviceHealthPaths));
      for (const value of paths.values()) if (!/^\/[^\x00-\x1f\x7f]*$/.test(value) || value.length > 500) throw new Error('Invalid Service readiness path');
      await this.repositories.setStage(appRecord.id, 'verifying', 'Verifying application');
      try {
        const app = await this.getApp(appRecord.id, false);
        if (!app.services.length) throw new Error('Deployment has no Services');
        if (app.services.some((service) => service.state !== 'running')) throw new Error('Every Service must be running before deployment can complete');
        const repositoryImagePrefix = `halfcloud/app-${app.id.slice(4).replaceAll('-', '')}:`;
        const services = app.services.filter((service) => service.image.startsWith(repositoryImagePrefix));
        if (!services.length) throw new Error('No Service uses a built repository image');
        for (const key of paths.keys()) {
          if (!services.some((service) => (service.serviceId === key || service.name === key) && service.ports.some((port) => port.protocol === 'tcp'))) throw new Error(`Readiness path does not identify a repository-built web Service: ${key}`);
        }
        const selected = serviceIdOrName ? await this.service(app.id, serviceIdOrName) : services.find((service) => service.ports.some((port) => port.protocol === 'tcp'));
        if (selected && !services.some((service) => service.serviceId === selected.serviceId)) throw new Error('The selected Service is not built from this repository');
        const previous = await this.repositories.getServiceUpdates(app.id);
        const updates: ServiceUpdateRecipe[] = [];
        for (const service of services) {
          const build = await this.repositories.getBuild(app.id, service.image);
          if (!build || build.commit !== appRecord.source?.resolvedCommit) throw new Error('Build and deploy every repository Service at this commit before verification; existing Apps need a one-time verified recipe');
          const saved = previous.find((recipe) => recipe.serviceId === service.serviceId);
          const path = service.ports.some((port) => port.protocol === 'tcp')
            ? paths.get(service.serviceId!) ?? paths.get(service.name) ?? (selected?.serviceId === service.serviceId ? healthPath : saved?.healthPath ?? '/')
            : null;
          updates.push({ ...build, serviceId: service.serviceId!, healthPath: path });
        }
        await Promise.all(updates.map((update) => this.waitForService(app.id, update.serviceId, update.imageId, update.healthPath)));
        await Promise.all(updates.map((update) => this.waitForService(app.id, update.serviceId, update.imageId, update.healthPath, true)));
        await this.repositories.saveServiceUpdates(app.id, updates);
        const updated = await this.repositories.markDeployed(app.id);
        return { appId: app.id, commit: updated.source?.currentCommit, verified: true, updateRecipesSaved: updates.length };
      } catch (error) {
        await this.repositories.fail(appRecord.id, 'verifying', error);
        throw error;
      }
    });
  }

  private async waitForService(appId: string, serviceId: string, imageId: string, healthPath: string | null, singleProbe = false) {
    const service = await this.service(appId, serviceId);
    const domain = service.domains.find((candidate) => candidate.managed) ?? service.domains.find((candidate) => candidate.primary) ?? service.domains[0];
    const started = Date.now();
    let deadline = started + 30_000;
    let successes = 0;
    let lastError = 'Service did not become ready';
    do {
      try {
        const inspection = await this.docker.inspectContainer(service.id);
        if (inspection.healthcheck) {
          const check = inspection.healthcheck;
          deadline = started + Math.min(300_000, Math.max(30_000, check.startPeriodMs + check.intervalMs + check.timeoutMs + 5_000));
        }
        if (inspection.imageId !== imageId) throw new Error('Service is not using the expected built image');
        if (inspection.state !== 'running' || (inspection.health !== null && inspection.health !== 'healthy')) throw new Error('Service is not healthy and running');
        if (healthPath !== null) {
          const port = inspection.ports.find((candidate) => candidate.target.endsWith('/tcp'));
          if (!port || !domain) throw new Error('Web Service has no published port or domain');
          const response = await fetch(`http://127.0.0.1:${port.hostPort}${healthPath}`, { redirect: 'manual', signal: AbortSignal.timeout(3_000) });
          await response.body?.cancel();
          if (response.status < 200 || response.status >= 400) throw new Error(`Application health check returned HTTP ${response.status}`);
          const publicResponse = await fetch(`https://${domain.hostname}${healthPath}`, { redirect: 'manual', signal: AbortSignal.timeout(3_000) });
          await publicResponse.body?.cancel();
          const protectedRoute = domain.access.type === 'basic_auth' && publicResponse.status === 401;
          if (!protectedRoute && (publicResponse.status < 200 || publicResponse.status >= 400)) throw new Error(`Public health check returned HTTP ${publicResponse.status}`);
        }
        if (++successes >= (singleProbe ? 1 : 3)) return;
      } catch (error) {
        if (singleProbe) throw error;
        successes = 0;
        lastError = error instanceof Error ? error.message : 'Service health check failed';
      }
      if (Date.now() >= deadline) break;
      await delay(1_000);
    } while (Date.now() < deadline);
    throw new Error(`${service.name}: ${lastError}`);
  }
  listManagedVolumes(filter?: ManagedVolumeFilter) { return this.docker.listManagedVolumes(filter); }
  listDockerVolumes(unusedOnly?: boolean) { return this.docker.listDockerVolumes(unusedOnly); }
  inspectManagedVolume(volumeName: string) { return this.docker.inspectManagedVolume(volumeName); }
  deleteManagedVolume(volumeName: string) { return this.docker.deleteManagedVolume(volumeName); }
  deleteUnusedVolume(volumeName: string) { return this.docker.deleteUnusedVolume(volumeName); }
  async listUnusedImages() {
    const protectedIds = await this.pendingUpdateImageIds();
    const result = await this.docker.listUnusedImages();
    const images = result.images.filter(({ id }) => !protectedIds.has(id));
    return { images, totalSize: images.reduce((total, image) => total + image.size, 0) };
  }
  async pruneUnusedImages() {
    if ((await this.pendingUpdateImageIds()).size) throw new Error('Unused images cannot be pruned while an App update needs recovery');
    return this.docker.pruneUnusedImages();
  }

  private async pendingUpdateImageIds() {
    const ids = new Set<string>();
    for (const app of await this.apps.list()) {
      if (app.source?.type !== 'git') continue;
      const run = await this.repositories.getUpdateRun(app.id);
      for (const update of run?.updates ?? []) ids.add(update.imageId);
    }
    return ids;
  }
  reconcileManagedVolume(application: string, localName: string) { return this.docker.reconcileManagedVolume(application, localName); }
  repairStorageOwnership(id: string, mountTarget: string) { return this.docker.repairStorageOwnership(id, mountTarget); }

  async listEnvironment(id: string) {
    const runtime = await this.docker.getContainerEnvironment(id);
    return this.environment.list(runtime.name, runtime.environment);
  }

  async listEnvironmentForAgent(id: string) {
    return { variables: serializeEnvironmentForAgent(await this.listEnvironment(id)) };
  }

  async saveEnvironmentVariable(
    id: string,
    input: { variableId?: string; name: string; value: string; protectedFromAI?: boolean },
  ) {
    assertEnvironmentVariableName(input.name);
    const runtime = await this.docker.getContainerEnvironment(id);
    const previous = await this.environment.list(runtime.name, runtime.environment);
    const existing = input.variableId ? previous.find((variable) => variable.id === input.variableId) : undefined;
    if (input.variableId && !existing) throw new Error(`Environment variable ${input.variableId} was not found`);
    if (previous.some((variable) => variable.name === input.name && variable.id !== existing?.id)) {
      throw new Error(`Environment variable ${input.name} already exists`);
    }
    const now = new Date().toISOString();
    const variable: EnvironmentVariable = existing
      ? { ...existing, name: input.name, value: input.value, protectedFromAI: input.protectedFromAI ?? true, updatedAt: now }
      : { id: `env_${randomUUID()}`, serviceId: runtime.name, name: input.name, value: input.value, protectedFromAI: input.protectedFromAI ?? true, createdAt: now, updatedAt: now };
    const updated = existing ? previous.map((candidate) => candidate.id === existing.id ? variable : candidate) : [...previous, variable];
    await this.applyEnvironment(id, runtime.name, previous, updated);
    return variable;
  }

  async saveEnvironmentVariables(
    id: string,
    inputs: Array<{ id?: string; name: string; value: string; protectedFromAI: boolean }>,
  ) {
    const runtime = await this.docker.getContainerEnvironment(id);
    const previous = await this.environment.list(runtime.name, runtime.environment);
    const previousById = new Map(previous.map((variable) => [variable.id, variable]));
    const suppliedIds = inputs.flatMap((input) => input.id ? [input.id] : []);
    if (new Set(suppliedIds).size !== suppliedIds.length || suppliedIds.some((variableId) => !previousById.has(variableId))) {
      throw new Error('Environment changed since it was loaded; refresh and try again');
    }
    const now = new Date().toISOString();
    const updated = inputs.map((input) => {
      assertEnvironmentVariableName(input.name);
      const existing = input.id ? previousById.get(input.id) : undefined;
      return existing
        ? { ...existing, name: input.name, value: input.value, protectedFromAI: input.protectedFromAI, updatedAt: now }
        : { id: `env_${randomUUID()}`, serviceId: runtime.name, name: input.name, value: input.value, protectedFromAI: input.protectedFromAI, createdAt: now, updatedAt: now };
    });
    if (new Set(updated.map((variable) => variable.name)).size !== updated.length) throw new Error('Environment variable names must be unique');
    await this.applyEnvironment(id, runtime.name, previous, updated);
    return { variables: updated };
  }

  async deleteEnvironmentVariable(id: string, variableId: string) {
    const runtime = await this.docker.getContainerEnvironment(id);
    const previous = await this.environment.list(runtime.name, runtime.environment);
    const variable = previous.find((candidate) => candidate.id === variableId);
    if (!variable) throw new Error(`Environment variable ${variableId} was not found`);
    const updated = previous.filter((candidate) => candidate.id !== variableId);
    const result = await this.applyEnvironment(id, runtime.name, previous, updated);
    return { ...result, variableId, deleted: true };
  }

  async setEnvironmentVariableForAgent(id: string, name: string, value: string) {
    const variables = await this.listEnvironment(id);
    const existing = variables.find((variable) => variable.name === name);
    if (existing?.protectedFromAI) throw new Error(`${name} is protected from AI and can only be changed in the Environment interface`);
    const variable = await this.saveEnvironmentVariable(id, { variableId: existing?.id, name, value, protectedFromAI: false });
    return { serviceId: variable.serviceId, name: variable.name, configured: true, protectedFromAI: false };
  }

  async requestEnvironmentVariable(id: string, name: string, description?: string, additionalTargets: EnvironmentTarget[] = []) {
    if (additionalTargets.length > 19) throw new Error('An environment request supports at most 20 targets');
    const application = await this.application(id);
    const serviceId = application.serviceId ?? application.name;
    const targets: EnvironmentTarget[] = [];
    for (const target of additionalTargets) {
      const targetApplication = await this.application(target.serviceId);
      if (targetApplication.appId !== application.appId) throw new Error('Shared environment values can only target Services in the same App');
      targets.push({ serviceId: targetApplication.serviceId ?? targetApplication.name, name: target.name });
    }
    const request = await this.environment.createRequest(serviceId, name, description, targets, application.appId);
    return {
      requestId: request.id,
      appId: request.appId,
      serviceId: request.serviceId,
      name: request.name,
      targets: environmentRequestTargets(request),
      description: request.description,
      status: request.status,
    };
  }

  async generateEnvironmentSecret(id: string, name: string, additionalTargets: EnvironmentTarget[] = [], bytes = 32, replaceExisting = false) {
    if (!Number.isInteger(bytes) || bytes < 16 || bytes > 128) throw new Error('Generated secret size must be between 16 and 128 bytes');
    if (!replaceExisting) {
      for (const target of [{ serviceId: id, name }, ...additionalTargets]) {
        const existing = (await this.listEnvironment(target.serviceId)).find((variable) => variable.name === target.name);
        if (existing) {
          throw new Error(`${target.name} is already configured. The user can retrieve it from the Service's Environment table by selecting Show. Set replaceExisting only if the user explicitly requests a new value.`);
        }
      }
    }
    const request = await this.requestEnvironmentVariable(id, name, 'Generated securely by HalfCloud', additionalTargets);
    const result = await this.completeEnvironmentRequest(id, request.requestId, randomBytes(bytes).toString('base64url'), true);
    return {
      ...result,
      valueLocation: `Open the Service's Environment table, find ${name}, and select Show.`,
    };
  }

  async completeEnvironmentRequest(id: string, requestId: string, value: string, protectedFromAI = true) {
    const application = await this.application(id);
    const serviceKey = application.serviceId ?? application.name;
    const request = await this.environment.getRequest(serviceKey, requestId);
    if (request.status !== 'pending') throw new Error(`Environment request ${requestId} is ${request.status}`);
    if (request.appId && request.appId !== application.appId) throw new Error('Environment request does not belong to this App');

    const grouped = new Map<string, { names: string[] }>();
    for (const target of environmentRequestTargets(request)) {
      assertEnvironmentVariableName(target.name);
      const targetApplication = await this.application(target.serviceId);
      if (targetApplication.appId !== application.appId) throw new Error('Shared environment values can only target Services in the same App');
      const targetServiceId = targetApplication.serviceId ?? targetApplication.name;
      const group = grouped.get(targetServiceId) ?? { names: [] };
      if (!group.names.includes(target.name)) group.names.push(target.name);
      grouped.set(targetServiceId, group);
    }

    const changes: Array<{ serviceId: string; previous: EnvironmentVariable[]; updated: EnvironmentVariable[] }> = [];
    const now = new Date().toISOString();
    for (const [targetServiceId, group] of grouped) {
      const runtime = await this.docker.getContainerEnvironment(targetServiceId);
      const previous = await this.environment.list(runtime.name, runtime.environment);
      const byName = new Map(previous.map((variable) => [variable.name, variable]));
      const updated = [...previous];
      for (const name of group.names) {
        const existing = byName.get(name);
        const variable: EnvironmentVariable = existing
          ? { ...existing, value, protectedFromAI, updatedAt: now }
          : { id: `env_${randomUUID()}`, serviceId: runtime.name, name, value, protectedFromAI, createdAt: now, updatedAt: now };
        if (existing) updated[updated.findIndex((candidate) => candidate.id === existing.id)] = variable;
        else updated.push(variable);
      }
      changes.push({ serviceId: targetServiceId, previous, updated });
    }

    const applied: typeof changes = [];
    try {
      for (const change of changes) {
        await this.applyEnvironment(change.serviceId, change.serviceId, change.previous, change.updated);
        applied.push(change);
      }
    } catch (error) {
      for (const change of applied.reverse()) {
        await this.applyEnvironment(change.serviceId, change.serviceId, change.updated, change.previous).catch(() => undefined);
      }
      throw error;
    }

    const completed = await this.environment.setRequestStatus(serviceKey, requestId, 'completed');
    return {
      requestId: completed.id,
      serviceId: completed.serviceId,
      name: completed.name,
      targets: environmentRequestTargets(completed).map((target) => ({ ...target, configured: true })),
      status: completed.status,
      protectedFromAI,
    };
  }

  async inspectContainerForAgent(id: string) {
    return { ...(await this.docker.inspectContainer(id)), environment: (await this.listEnvironmentForAgent(id)).variables };
  }

  async createContainer(input: CreateContainerInput, onProgress?: (progress: DeploymentProgress) => void) {
    this.assertAppNotUpdating(input.appId);
    const hasPublicTcpPort = Object.values(input.ports).some((target) => !target.includes('/') || target.endsWith('/tcp'));
    if (input.hostname && !hasPublicTcpPort) throw new Error('A hostname requires a published TCP port');
    const managedHostname = hasPublicTcpPort ? this.defaultHostname(input.publicName) : undefined;
    const customHostname = input.hostname ? normalizeHostname(input.hostname) : undefined;
    if (customHostname) await this.assertHostnameAvailable(customHostname);
    const result = await this.docker.createContainer({ ...input, hostname: managedHostname }, onProgress);
    try {
      onProgress?.({ phase: 'activity', label: 'Configuring application access' });
      await this.environment.initialize(input.serviceId, input.environment ?? {}, false);
      const serviceDomains = managedHostname ? await this.domains.initialize(input.serviceId, managedHostname, customHostname) : [];
      await this.syncRoutes();
      const primary = serviceDomains.find((domain) => domain.primary);
      return { ...result, domains: serviceDomains, ...(primary ? { hostname: primary.hostname, url: `https://${primary.hostname}` } : {}) };
    } catch (error) {
      await this.docker.deleteContainer(result.id).catch(() => undefined);
      throw error;
    }
  }

  async startContainer(id: string) {
    await this.assertServiceNotUpdating(id);
    const result = await this.docker.startContainer(id);
    await this.syncRoutes();
    return result;
  }

  async stopContainer(id: string) {
    await this.assertServiceNotUpdating(id);
    const result = await this.docker.stopContainer(id);
    await this.syncRoutes();
    return result;
  }

  async restartContainer(id: string) {
    await this.assertServiceNotUpdating(id);
    const result = await this.docker.restartContainer(id);
    await this.syncRoutes();
    return result;
  }

  async deleteContainer(id: string) {
    await this.assertServiceNotUpdating(id);
    const result = await this.docker.deleteContainer(id);
    await this.syncRoutes();
    return result;
  }

  async syncRoutes() {
    const containers = await this.docker.listContainers(false);
    await this.caddy.sync(await Promise.all(containers.map(async (container) => ({
      ...container,
       domains: await this.domains.get(container.serviceId ?? container.name, container.hostname),
    }))));
  }

  async listDomains(id: string) {
    const application = await this.application(id);
    return this.domains.withReadiness(await this.domains.get(application.serviceId ?? application.name, application.hostname));
  }

  async addDomain(id: string, hostname: string) {
    const application = await this.application(id, true);
    const normalized = normalizeHostname(hostname);
    await this.assertHostnameAvailable(normalized, application.serviceId ?? application.name);
    return this.mutateDomains(application, (name, legacy) => this.domains.add(name, legacy, normalized));
  }

  async removeDomain(id: string, hostname: string, allowManaged = false) {
    const application = await this.application(id, true);
    return this.mutateDomains(application, (name, legacy) => this.domains.remove(name, legacy, hostname, allowManaged));
  }

  async setPrimaryDomain(id: string, hostname: string) {
    const application = await this.application(id, true);
    return this.mutateDomains(application, (name, legacy) => this.domains.setPrimary(name, legacy, hostname));
  }

  async inspectRouteAccess(routeId: string) {
    const { domain } = await this.route(routeId);
    return domain.access.type === 'basic_auth'
      ? { type: 'basic_auth' as const, username: domain.access.username }
      : { type: 'public' as const };
  }

  async requestBasicAuthSetup(routeId: string) {
    return this.requestBasicAuth(routeId, 'setup');
  }

  async requestBasicAuthPasswordChange(routeId: string) {
    return this.requestBasicAuth(routeId, 'change');
  }

  async completeBasicAuthRequest(routeId: string, requestId: string, username: string, password: string) {
    assertBasicAuthUsername(username);
    assertBasicAuthPassword(password);
    const located = await this.route(routeId);
    const serviceKey = located.application.serviceId ?? located.application.name;
    const request = await this.accessRequests.get(serviceKey, requestId);
    if (request.routeId !== routeId || request.status !== 'pending') throw new Error('Basic Auth request is no longer pending');
    if (request.operation === 'setup' && located.domain.access.type !== 'public') throw new Error('Route is already password protected');
    if (request.operation === 'change' && located.domain.access.type !== 'basic_auth') throw new Error('Route is not password protected');

    const passwordHash = await this.hashPassword(password);
    const updated = located.domains.map((domain) => domain.id === routeId
      ? { ...domain, access: { type: 'basic_auth' as const, username, passwordHash } }
      : domain);
    await this.replaceRouteAccess(serviceKey, located.domains, updated);
    await this.accessRequests.complete(serviceKey, requestId);
    return { success: true, requestId, routeId, access: 'basic_auth' as const, username, status: 'completed' as const };
  }

  async removeRouteProtection(routeId: string) {
    const located = await this.route(routeId);
    if (located.domain.access.type === 'public') return { success: true, routeId, access: 'public' as const };
    const updated = located.domains.map((domain) => domain.id === routeId
      ? { ...domain, access: { type: 'public' as const } }
      : domain);
    await this.replaceRouteAccess(located.application.serviceId ?? located.application.name, located.domains, updated);
    return { success: true, routeId, access: 'public' as const };
  }

  private async mutateDomains(
    application: { name: string; serviceId?: string; hostname?: string },
    mutate: (name: string, legacyHostname?: string) => Promise<ServiceDomain[]>,
  ) {
    const serviceKey = application.serviceId ?? application.name;
    await this.assertServiceNotUpdating(serviceKey);
    const previous = await this.domains.get(serviceKey, application.hostname);
    const updated = await mutate(serviceKey, application.hostname);
    try {
      await this.syncRoutes();
      return this.domains.withReadiness(updated);
    } catch (error) {
      await this.domains.replace(serviceKey, previous);
      throw error;
    }
  }

  private async requestBasicAuth(routeId: string, operation: 'setup' | 'change') {
    const located = await this.route(routeId);
    if (operation === 'setup' && located.domain.access.type !== 'public') throw new Error('Route is already password protected');
    if (operation === 'change' && located.domain.access.type !== 'basic_auth') throw new Error('Route is not password protected');
    const readiness = (await this.domains.withReadiness([located.domain]))[0]!;
    if (!readiness.httpsReady) throw new Error('Password protection requires working HTTPS for this route');
    const request = await this.accessRequests.create(located.application.serviceId ?? located.application.name, routeId, operation);
    return {
      requestId: request.id,
      routeId,
      hostname: located.domain.hostname,
      operation,
      status: request.status,
    };
  }

  private async route(routeId: string) {
    const matches: Array<{ application: { name: string; serviceId?: string; hostname?: string }; domain: ServiceDomain; domains: ServiceDomain[] }> = [];
    for (const application of await this.docker.listContainers(false)) {
      const domains = await this.domains.get(application.serviceId ?? application.name, application.hostname);
      const domain = domains.find((candidate) => candidate.id === routeId);
      if (domain) matches.push({ application, domain, domains });
    }
    if (!matches.length) throw new Error(`HTTP route ${routeId} was not found`);
    if (matches.length > 1) throw new Error(`HTTP route ${routeId} is not unique`);
    return matches[0]!;
  }

  private async replaceRouteAccess(application: string, previous: ServiceDomain[], updated: ServiceDomain[]) {
    await this.assertServiceNotUpdating(application);
    await this.domains.replace(application, updated);
    try {
      await this.syncRoutes();
    } catch (error) {
      await this.domains.replace(application, previous);
      await this.syncRoutes().catch(() => undefined);
      throw error;
    }
  }

  private async application(id: string, requirePublic = false) {
    const containers = await this.docker.listContainers(false);
    const matches = containers.filter((container) => container.id === id || container.id.startsWith(id) || container.serviceId === id || container.runtimeName === id || container.name === id);
    if (!matches.length) throw new Error(`Managed application ${id} was not found`);
    if (matches.length > 1) throw new Error(`Application id ${id} is ambiguous; use the exact name or full id`);
    const application = matches[0]!;
    if (requirePublic && !application.ports.some((port) => port.protocol === 'tcp')) throw new Error(`${application.name} does not have a published TCP port`);
    return application;
  }

  private async applyEnvironment(id: string, serviceId: string, previous: EnvironmentVariable[], updated: EnvironmentVariable[]) {
    await this.assertServiceNotUpdating(serviceId);
    await this.environment.replaceVariables(serviceId, updated);
    try {
      const result = await this.docker.replaceContainerEnvironment(id, Object.fromEntries(updated.map((variable) => [variable.name, variable.value])));
      await this.syncRoutes();
      return result;
    } catch (error) {
      await this.environment.replaceVariables(serviceId, previous);
      throw error;
    }
  }

  private async assertHostnameAvailable(hostname: string, exceptApplication?: string) {
    for (const application of await this.docker.listContainers(false)) {
      const serviceKey = application.serviceId ?? application.name;
      if (serviceKey === exceptApplication) continue;
      const domains = await this.domains.get(serviceKey, application.hostname);
      if (domains.some((domain) => domain.hostname === hostname)) throw new Error(`${hostname} is already attached to ${application.name}`);
    }
    if (hostname === process.env.HALFCLOUD_HOSTNAME?.toLowerCase()) throw new Error(`${hostname} is reserved for HalfCloud`);
  }

  private defaultHostname(name: string) {
    const domain = process.env.HALFCLOUD_BASE_DOMAIN;
    if (!domain) throw new Error('HALFCLOUD_BASE_DOMAIN is required to expose applications');
    return `${name.toLowerCase()}.${domain}`;
  }

  private async createServiceRecord(appId: string, input: Omit<CreateContainerInput, 'appId' | 'serviceId' | 'serviceName' | 'publicName' | 'name' | 'start'> & { name: string }, onProgress?: (progress: DeploymentProgress) => void) {
    const serviceId = `service_${randomUUID()}`;
    const runtimeName = `hc_${appId.slice(4, 12)}_${serviceId.slice(8, 16)}`;
    const app = await this.apps.get(appId);
    const existingServices = (await this.listContainers(false)).filter((service) => service.appId === appId);
    const appSlug = app.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || app.id.slice(4, 12);
    const publicName = existingServices.length ? `${appSlug}-${input.name}`.slice(0, 63).replace(/-$/, '') : appSlug.slice(0, 63);
    return this.createContainer({ ...input, appId, serviceId, serviceName: input.name, publicName, name: runtimeName, start: false }, onProgress);
  }

  private serviceName(value: string) {
    const name = value.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new Error('Service names must use lowercase letters, numbers, and hyphens');
    return name;
  }

  private async appAction(idOrName: string, action: (serviceId: string) => Promise<unknown>, applies = (_state: string) => true) {
    const app = await this.getApp(idOrName, false);
    this.assertAppNotUpdating(app.id);
    const results = [];
    for (const service of app.services) if (applies(service.state)) results.push(await action(service.id));
    return { appId: app.id, services: results };
  }

  private assertAppNotUpdating(appId: string) {
    if (this.updatingApps.has(appId)) {
      const message = 'An App update or its recovery is in progress; wait before changing its Services or configuration';
      throw new AppBusyError(message);
    }
  }

  private async assertServiceNotUpdating(id: string) {
    if (!this.updatingApps.size) return;
    const service = await this.application(id);
    this.assertAppNotUpdating(service.appId!);
  }
}
