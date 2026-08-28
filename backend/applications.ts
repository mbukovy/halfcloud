import { randomUUID } from 'node:crypto';
import { CaddyService } from './caddy.js';
import { DockerService, type CreateContainerInput } from './docker.js';
import { DomainStore, normalizeHostname, type ServiceDomain } from './domains.js';
import { EnvironmentStore, assertEnvironmentVariableName, serializeEnvironmentForAgent, type EnvironmentVariable } from './environment.js';

export class ApplicationService {
  constructor(
    private readonly docker: DockerService,
    private readonly caddy = new CaddyService(),
    private readonly domains = new DomainStore(),
    private readonly environment = new EnvironmentStore(),
  ) {}

  ping() { return this.docker.ping(); }
  getRuntimeInfo() { return this.docker.getRuntimeInfo(); }
  assertRootless() { return this.docker.assertRootless(); }
  ensureNetwork() { return this.docker.ensureNetwork(); }
  async listContainers(includeStats = true) {
    const containers = await this.docker.listContainers(includeStats);
    return Promise.all(containers.map(async (container) => {
      const stored = await this.domains.get(container.name, container.hostname);
      const domainStates = await this.domains.withReadiness(stored);
      const primary = domainStates.find((domain) => domain.primary);
      return { ...container, domains: domainStates, hostname: primary?.hostname };
    }));
  }
  getContainerLogs(id: string, tail?: number) { return this.docker.getContainerLogs(id, tail); }
  getContainerStats(id: string) { return this.docker.getContainerStats(id); }
  listManagedVolumes(application?: string) { return this.docker.listManagedVolumes(application); }
  inspectManagedVolume(volumeName: string) { return this.docker.inspectManagedVolume(volumeName); }
  deleteManagedVolume(volumeName: string) { return this.docker.deleteManagedVolume(volumeName); }
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
    inputs: Array<{ id: string; name: string; value: string; protectedFromAI: boolean }>,
  ) {
    const runtime = await this.docker.getContainerEnvironment(id);
    const previous = await this.environment.list(runtime.name, runtime.environment);
    const previousById = new Map(previous.map((variable) => [variable.id, variable]));
    if (inputs.length !== previous.length || new Set(inputs.map((input) => input.id)).size !== inputs.length) {
      throw new Error('Environment changed since it was loaded; refresh and try again');
    }
    const now = new Date().toISOString();
    const updated = inputs.map((input) => {
      assertEnvironmentVariableName(input.name);
      const existing = previousById.get(input.id);
      if (!existing) throw new Error('Environment changed since it was loaded; refresh and try again');
      return { ...existing, name: input.name, value: input.value, protectedFromAI: input.protectedFromAI, updatedAt: now };
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

  async requestEnvironmentVariable(id: string, name: string, description?: string) {
    const application = await this.application(id);
    const request = await this.environment.createRequest(application.name, name, description);
    return { requestId: request.id, serviceId: request.serviceId, name: request.name, description: request.description, status: request.status };
  }

  async completeEnvironmentRequest(id: string, requestId: string, value: string, protectedFromAI = true) {
    const application = await this.application(id);
    const request = await this.environment.getRequest(application.name, requestId);
    if (request.status !== 'pending') throw new Error(`Environment request ${requestId} is ${request.status}`);
    const variables = await this.listEnvironment(id);
    const existing = variables.find((variable) => variable.name === request.name);
    await this.saveEnvironmentVariable(id, { variableId: existing?.id, name: request.name, value, protectedFromAI });
    const completed = await this.environment.setRequestStatus(application.name, requestId, 'completed');
    return { requestId: completed.id, serviceId: completed.serviceId, name: completed.name, status: completed.status, protectedFromAI };
  }

  async inspectContainerForAgent(id: string) {
    return { ...(await this.docker.inspectContainer(id)), environment: (await this.listEnvironmentForAgent(id)).variables };
  }

  async createContainer(input: CreateContainerInput) {
    const hasPublicTcpPort = Object.values(input.ports).some((target) => !target.includes('/') || target.endsWith('/tcp'));
    if (input.hostname && !hasPublicTcpPort) throw new Error('A hostname requires a published TCP port');
    const managedHostname = hasPublicTcpPort ? this.defaultHostname(input.name) : undefined;
    const customHostname = input.hostname ? normalizeHostname(input.hostname) : undefined;
    if (customHostname) await this.assertHostnameAvailable(customHostname);
    const result = await this.docker.createContainer({ ...input, hostname: managedHostname });
    try {
      await this.environment.initialize(input.name, input.environment ?? {}, false);
      const serviceDomains = managedHostname ? await this.domains.initialize(input.name, managedHostname, customHostname) : [];
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
      domains: await this.domains.get(container.name, container.hostname),
    }))));
  }

  async listDomains(id: string) {
    const application = await this.application(id);
    return this.domains.withReadiness(await this.domains.get(application.name, application.hostname));
  }

  async addDomain(id: string, hostname: string) {
    const application = await this.application(id, true);
    const normalized = normalizeHostname(hostname);
    await this.assertHostnameAvailable(normalized, application.name);
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

  private async mutateDomains(
    application: { name: string; hostname?: string },
    mutate: (name: string, legacyHostname?: string) => Promise<ServiceDomain[]>,
  ) {
    const previous = await this.domains.get(application.name, application.hostname);
    const updated = await mutate(application.name, application.hostname);
    try {
      await this.syncRoutes();
      return this.domains.withReadiness(updated);
    } catch (error) {
      await this.domains.replace(application.name, previous);
      throw error;
    }
  }

  private async application(id: string, requirePublic = false) {
    const containers = await this.docker.listContainers(false);
    const matches = containers.filter((container) => container.id === id || container.id.startsWith(id) || container.name === id);
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
      if (application.name === exceptApplication) continue;
      const domains = await this.domains.get(application.name, application.hostname);
      if (domains.some((domain) => domain.hostname === hostname)) throw new Error(`${hostname} is already attached to ${application.name}`);
    }
    if (hostname === process.env.HALFCLOUD_HOSTNAME?.toLowerCase()) throw new Error(`${hostname} is reserved for HalfCloud`);
  }

  private defaultHostname(name: string) {
    const domain = process.env.HALFCLOUD_BASE_DOMAIN;
    if (!domain) throw new Error('HALFCLOUD_BASE_DOMAIN is required to expose applications');
    return `${name.toLowerCase()}.${domain}`;
  }
}
