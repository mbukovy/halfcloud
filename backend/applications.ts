import { CaddyService } from './caddy.js';
import { DockerService, type CreateContainerInput } from './docker.js';

export class ApplicationService {
  constructor(
    private readonly docker: DockerService,
    private readonly caddy = new CaddyService(),
  ) {}

  ping() { return this.docker.ping(); }
  getRuntimeInfo() { return this.docker.getRuntimeInfo(); }
  assertRootless() { return this.docker.assertRootless(); }
  listContainers(includeStats = true) { return this.docker.listContainers(includeStats); }
  getContainerLogs(id: string, tail?: number) { return this.docker.getContainerLogs(id, tail); }
  getContainerStats(id: string) { return this.docker.getContainerStats(id); }

  async setEnvironmentVariable(id: string, key: string, value: string) {
    const result = await this.docker.setEnvironmentVariable(id, key, value);
    await this.syncRoutes();
    return result;
  }

  async createContainer(input: CreateContainerInput) {
    const hostname = input.hostname ?? this.defaultHostname(input.name);
    const result = await this.docker.createContainer({ ...input, hostname });
    try {
      await this.syncRoutes();
      return { ...result, hostname, url: `https://${hostname}` };
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
    await this.caddy.sync(await this.docker.listContainers(false));
  }

  private defaultHostname(name: string) {
    const domain = process.env.HALFCLOUD_BASE_DOMAIN;
    if (!domain) throw new Error('HALFCLOUD_BASE_DOMAIN is required to expose applications');
    return `${name.toLowerCase()}.${domain}`;
  }
}
