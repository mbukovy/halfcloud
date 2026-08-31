import { randomBytes, randomUUID } from 'node:crypto';
import { AppStore } from './apps.js';
import { CaddyService } from './caddy.js';
import { DockerService, type CreateContainerInput, type DeploymentProgress, type ManagedVolumeFilter, type SearchContainerImagesInput } from './docker.js';
import { DomainStore, normalizeHostname, type ServiceDomain } from './domains.js';
import { EnvironmentStore, assertEnvironmentVariableName, environmentRequestTargets, serializeEnvironmentForAgent, type EnvironmentTarget, type EnvironmentVariable } from './environment.js';
import { RouteAccessRequestStore, assertBasicAuthPassword, assertBasicAuthUsername, hashBasicAuthPassword } from './route-access.js';
import { RepositoryService, validatePublicGitUrl } from './repositories.js';

export class ApplicationService {
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
    const repositoryUrl = validatePublicGitUrl(input.repositoryUrl);
    const now = new Date().toISOString();
    const app = await this.apps.create(input.name, {
      source: { type: 'git', url: repositoryUrl, ...(input.branch ? { branch: input.branch } : {}) },
      deployment: { status: 'in_progress', stage: 'cloning', message: 'Cloning repository', buildAttempts: 0, updatedAt: now },
    });
    onProgress?.({ phase: 'activity', label: 'Cloning repository' });
    let result;
    try {
      result = await this.repositories.clone(app.id, repositoryUrl, input.branch);
    } catch (error) {
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

  async inspectRepository(appIdOrName: string) {
    try {
      return await this.repositories.inspect(appIdOrName);
    } catch (error) {
      await this.repositories.fail(appIdOrName, 'inspecting', error).catch(() => undefined);
      throw error;
    }
  }
  listRepositoryDirectory(appIdOrName: string, repositoryPath?: string) { return this.repositories.listDirectory(appIdOrName, repositoryPath); }
  readRepositoryFile(appIdOrName: string, repositoryPath: string) { return this.repositories.readFile(appIdOrName, repositoryPath); }
  writeRepositoryDeploymentFile(appIdOrName: string, repositoryPath: string, content: string) { return this.repositories.writeDeploymentFile(appIdOrName, repositoryPath, content); }

  async buildRepositoryImage(appIdOrName: string, contextPath = '.', dockerfilePath = 'Dockerfile', onProgress?: (progress: DeploymentProgress) => void) {
    try {
      const build = await this.repositories.buildContext(appIdOrName, contextPath, dockerfilePath);
      onProgress?.({ phase: 'activity', label: 'Building application' });
      const result = await this.docker.buildImage(build);
      await this.repositories.buildSucceeded(appIdOrName, result.image);
      return { appId: (await this.apps.get(appIdOrName)).id, commit: build.commit, ...result };
    } catch (error) {
      await this.repositories.fail(appIdOrName, 'building', error);
      throw error;
    }
  }

  async addService(appIdOrName: string, input: Omit<CreateContainerInput, 'appId' | 'serviceId' | 'serviceName' | 'publicName' | 'name' | 'start'> & { name: string }, onProgress?: (progress: DeploymentProgress) => void) {
    const app = await this.apps.get(appIdOrName);
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
    for (const service of app.services) await this.docker.deleteContainer(service.id);
    await this.docker.deleteAppNetwork(app.id);
    if (deleteData) {
      for (const volume of await this.docker.listManagedVolumes()) {
        if (app.services.some((service) => service.serviceId === volume.application)) await this.docker.deleteManagedVolume(volume.name);
      }
    }
    await this.apps.deleteApp(app.id);
    await this.repositories.delete(app.id);
    await this.syncRoutes();
    return { appId: app.id, appName: app.name, deleted: true, persistentDataDeleted: deleteData };
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
    const result = await this.docker.recreateContainer((await this.service(appIdOrName, serviceIdOrName)).id);
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
  async runDeploymentCommand(appIdOrName: string, serviceIdOrName: string, command: string[]) {
    const app = await this.apps.get(appIdOrName);
    if (app.source?.type !== 'git') throw new Error('Deployment commands are available only for Git-backed Apps');
    if (!app.source.resolvedCommit || app.source.resolvedCommit === app.source.currentCommit) throw new Error('Deployment commands require a pending Git deployment');
    const attempts = (app.deployment?.initializationAttempts ?? 0) + 1;
    if (attempts > 3) throw new Error('Initialization command retry limit reached');
    const service = await this.service(app.id, serviceIdOrName);
    await this.repositories.setStage(app.id, 'initializing', `Initializing ${service.name} (attempt ${attempts} of 3)`, { initializationAttempts: attempts });
    try {
      return await this.docker.runContainerCommand(service.id, command);
    } catch (error) {
      await this.repositories.fail(app.id, 'initializing', error);
      throw error;
    }
  }

  async verifyGitDeployment(appIdOrName: string, serviceIdOrName?: string, healthPath = '/') {
    const appRecord = await this.apps.get(appIdOrName);
    if (appRecord.source?.type !== 'git') throw new Error('Only Git-backed Apps have a source deployment to verify');
    if (!healthPath.startsWith('/') || healthPath.includes('\0') || healthPath.length > 500) throw new Error('Health path must be a bounded absolute URL path');
    await this.repositories.setStage(appRecord.id, 'verifying', 'Verifying application');
    try {
      const app = await this.getApp(appRecord.id, false);
      if (!app.services.length) throw new Error('Deployment has no Services');
      if (app.services.some((service) => service.state !== 'running')) throw new Error('Every Service must be running before deployment can complete');
      const builtImage = appRecord.deployment?.image;
      if (!builtImage) throw new Error('Deployment does not have a successfully built repository image');
      const builtServices = app.services.filter((service) => service.image === builtImage);
      if (!builtServices.length) throw new Error('No deployed Service uses the image built from this repository commit');
      const target = serviceIdOrName ? await this.service(app.id, serviceIdOrName) : builtServices.find((service) => service.ports.some((port) => port.protocol === 'tcp'));
      let publicUrl: string | undefined;
      if (target) {
        if (target.image !== builtImage) throw new Error('The verified web Service does not use the image built from this repository commit');
        const port = target.ports.find((candidate) => candidate.protocol === 'tcp');
        if (!port) throw new Error(`${target.name} does not publish an HTTP port`);
        await this.checkTcpPort(port.host);
        const domain = target.domains.find((candidate) => candidate.managed) ?? target.domains.find((candidate) => candidate.primary) ?? target.domains[0];
        if (!domain) throw new Error(`${target.name} does not have a public domain`);
        publicUrl = `https://${domain.hostname}${healthPath}`;
        const response = await fetch(publicUrl, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
        if (response.status >= 500) throw new Error(`Application health check returned HTTP ${response.status}`);
      }
      const updated = await this.repositories.markDeployed(app.id);
      return { appId: app.id, commit: updated.source?.currentCommit, verified: true, ...(publicUrl ? { publicUrl } : {}) };
    } catch (error) {
      await this.repositories.fail(appRecord.id, 'verifying', error);
      throw error;
    }
  }
  listManagedVolumes(filter?: ManagedVolumeFilter) { return this.docker.listManagedVolumes(filter); }
  listDockerVolumes(unusedOnly?: boolean) { return this.docker.listDockerVolumes(unusedOnly); }
  inspectManagedVolume(volumeName: string) { return this.docker.inspectManagedVolume(volumeName); }
  deleteManagedVolume(volumeName: string) { return this.docker.deleteManagedVolume(volumeName); }
  deleteUnusedVolume(volumeName: string) { return this.docker.deleteUnusedVolume(volumeName); }
  listUnusedImages() { return this.docker.listUnusedImages(); }
  pruneUnusedImages() { return this.docker.pruneUnusedImages(); }
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

  async generateEnvironmentSecret(id: string, name: string, additionalTargets: EnvironmentTarget[] = [], bytes = 32) {
    if (!Number.isInteger(bytes) || bytes < 16 || bytes > 128) throw new Error('Generated secret size must be between 16 and 128 bytes');
    const request = await this.requestEnvironmentVariable(id, name, 'Generated securely by HalfCloud', additionalTargets);
    return this.completeEnvironmentRequest(id, request.requestId, randomBytes(bytes).toString('base64url'), true);
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
    const result = await this.docker.startContainer(id);
    await this.syncRoutes();
    return result;
  }

  async stopContainer(id: string) {
    const result = await this.docker.stopContainer(id);
    await this.syncRoutes();
    return result;
  }

  async restartContainer(id: string) {
    const result = await this.docker.restartContainer(id);
    await this.syncRoutes();
    return result;
  }

  async deleteContainer(id: string) {
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
    const results = [];
    for (const service of app.services) if (applies(service.state)) results.push(await action(service.id));
    return { appId: app.id, services: results };
  }

  private async checkTcpPort(port: number) {
    const net = await import('node:net');
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      const timer = setTimeout(() => socket.destroy(new Error('Application port did not become reachable')), 5_000);
      socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(); });
      socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
  }
}
