import net from 'node:net';
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Docker from 'dockerode';

export type PortMap = Record<string, string>;

export interface CreateContainerInput {
  name: string;
  appId: string;
  serviceId: string;
  serviceName: string;
  publicName: string;
  image: string;
  ports: PortMap;
  environment?: Record<string, string>;
  namedVolumes?: Record<string, string>;
  volumes?: Record<string, string>;
  hostname?: string;
  start?: boolean;
}

export interface SearchContainerImagesInput {
  query: string;
  limit?: number;
  officialOnly?: boolean;
  minStars?: number;
}

export interface ContainerImageSearchResult {
  name: string;
  description: string;
  starCount?: number;
  official: boolean;
  source: 'Docker Hub';
}

export type DeploymentProgress =
  | { phase: 'pulling-image'; image: string }
  | { phase: 'activity'; label: string }
  | { phase: 'working' };

interface ImageSearchClient {
  searchImages(options: { term: string; limit: number; filters?: Record<string, string[]> }): Promise<unknown>;
}

export async function searchContainerImages(client: ImageSearchClient, input: SearchContainerImagesInput): Promise<ContainerImageSearchResult[]> {
  const query = input.query.trim();
  const limit = input.limit ?? 10;
  const minStars = input.minStars ?? 0;
  if (!query) throw new Error('Container image search query cannot be empty');
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new Error('Container image search limit must be between 1 and 25');
  if (!Number.isInteger(minStars) || minStars < 0) throw new Error('Minimum star count must be a non-negative integer');

  const filters: Record<string, string[]> = {};
  if (input.officialOnly) filters['is-official'] = ['true'];
  if (minStars > 0) filters.stars = [String(minStars)];
  const response = await client.searchImages({
    term: query,
    limit,
    ...(Object.keys(filters).length ? { filters } : {}),
  });
  if (!Array.isArray(response)) throw new Error('Docker returned an invalid container image search response');

  return response.flatMap((value): ContainerImageSearchResult[] => {
    if (typeof value !== 'object' || value === null) return [];
    const result = value as Record<string, unknown>;
    if (typeof result.name !== 'string' || !result.name) return [];
    const stars = typeof result.star_count === 'number' && Number.isFinite(result.star_count) ? result.star_count : undefined;
    const official = result.is_official === true;
    if (input.officialOnly && !official) return [];
    if (minStars > 0 && (stars === undefined || stars < minStars)) return [];
    return [{
      name: result.name,
      description: typeof result.description === 'string' ? result.description : '',
      ...(stars !== undefined ? { starCount: stars } : {}),
      official,
      source: 'Docker Hub',
    }];
  }).slice(0, limit);
}

interface ManagedVolumeClient {
  createVolume(options: Docker.VolumeCreateOptions): Promise<unknown>;
  getVolume(name: string): { inspect(): Promise<Docker.VolumeInspectInfo> };
}

interface ManagedNetworkClient {
  createNetwork(options: Docker.NetworkCreateOptions): Promise<unknown>;
  getNetwork(name: string): { inspect(): Promise<Docker.NetworkInspectInfo> };
}

export function appNetworkName(appId: string) {
  if (!/^app_[a-f0-9-]{36}$/.test(appId)) throw new Error('Invalid App ID');
  return `halfcloud_${appId}`;
}

export async function createOrReuseAppNetwork(docker: ManagedNetworkClient, appId: string) {
  const managedNetworkName = appNetworkName(appId);
  let network: Docker.NetworkInspectInfo;
  try {
    network = await docker.getNetwork(managedNetworkName).inspect();
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode !== 404) throw error;
    try {
      await docker.createNetwork({
        Name: managedNetworkName,
        CheckDuplicate: true,
        Driver: 'bridge',
        Labels: { 'halfcloud.managed': 'true', 'halfcloud.app.id': appId },
      });
    } catch (createError) {
      if ((createError as { statusCode?: number }).statusCode !== 409) throw createError;
    }
    network = await docker.getNetwork(managedNetworkName).inspect();
  }
  if (network.Driver !== 'bridge' || network.Labels?.['halfcloud.managed'] !== 'true' || network.Labels?.['halfcloud.app.id'] !== appId) {
    throw new Error(`Docker network ${managedNetworkName} already exists and is not managed by HalfCloud`);
  }
  return network;
}

export function assertManagedVolumeLabels(volume: Docker.VolumeInspectInfo, application: string, localName: string) {
  if (
    volume.Labels?.['halfcloud.managed'] !== 'true'
    || volume.Labels?.['halfcloud.application'] !== application
    || volume.Labels?.['halfcloud.volume'] !== localName
  ) {
    throw new Error(`Docker volume ${volume.Name} already exists and is not managed by application ${application} as ${localName}`);
  }
}

export async function createOrReuseManagedVolume(docker: ManagedVolumeClient, application: string, localName: string, appId?: string) {
  const volumeName = `halfcloud-${application}-${localName}`;
  await docker.createVolume({
    Name: volumeName,
    Labels: {
      'halfcloud.managed': 'true',
      'halfcloud.application': application,
      'halfcloud.volume': localName,
      ...(appId ? { 'halfcloud.app.id': appId, 'halfcloud.service.id': application } : {}),
    },
  });
  const inspection = await docker.getVolume(volumeName).inspect();
  assertManagedVolumeLabels(inspection, application, localName);
  return inspection;
}

const minimumHostPort = 10_000;
const maximumHostPort = 19_999;

export function rootlessSocketPath(dockerHost: string | undefined) {
  if (!dockerHost?.startsWith('unix:///run/user/') || !/^unix:\/\/\/run\/user\/\d+\/docker\.sock$/.test(dockerHost)) {
    throw new Error('DOCKER_HOST must explicitly identify the HalfCloud rootless Docker socket under /run/user/<uid>/docker.sock');
  }
  return dockerHost.slice('unix://'.length);
}

export function validateHostPort(port: number) {
  if (!Number.isInteger(port) || port < minimumHostPort || port > maximumHostPort) throw new Error(`Host port must be in the ${minimumHostPort}-${maximumHostPort} range`);
}

export function managedBindPath(appDir: string, relativeSource: string) {
  if (path.isAbsolute(relativeSource) || relativeSource.split(/[\\/]/).includes('..')) throw new Error(`Bind mount ${relativeSource} must be relative to the managed application directory`);
  const source = path.resolve(appDir, relativeSource);
  if (source === appDir || !source.startsWith(`${appDir}${path.sep}`)) throw new Error(`Bind mount ${relativeSource} escapes the managed application directory`);
  return source;
}

interface DockerStats {
  cpu_stats?: { cpu_usage?: { total_usage?: number; percpu_usage?: number[] }; system_cpu_usage?: number; online_cpus?: number };
  precpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number };
  memory_stats?: { usage?: number; limit?: number; stats?: { cache?: number; inactive_file?: number } };
}

export interface ManagedVolumeFilter {
  appId?: string;
  serviceId?: string;
  orphaned?: boolean;
}

export class DockerService {
  private readonly docker: Docker;
  private readonly appsDir: string;

  constructor() {
    const socketPath = rootlessSocketPath(process.env.DOCKER_HOST);
    if (process.getuid && socketPath !== `/run/user/${process.getuid()}/docker.sock`) {
      throw new Error('DOCKER_HOST must belong to the user running HalfCloud');
    }
    this.docker = new Docker({ socketPath });
    this.appsDir = path.resolve(process.env.HALFCLOUD_APPS_DIR ?? `${process.env.HOME ?? '/home/halfcloudrunner'}/.halfcloud/apps`);
  }

  async ping() {
    await this.docker.ping();
  }

  searchContainerImages(input: SearchContainerImagesInput) {
    return searchContainerImages(this.docker, input);
  }

  async getRuntimeInfo() {
    const info = await this.docker.info();
    const securityOptions: string[] = info.SecurityOptions ?? [];
    const rootless = securityOptions.some((option: string) => option === 'name=rootless' || option.includes('rootless'));
    return {
      dockerVersion: info.ServerVersion,
      rootless,
      cgroupVersion: info.CgroupVersion === '2' ? 'v2' : 'v1',
      cpuCount: info.NCPU,
      memoryTotal: info.MemTotal,
      cpuLimitsSupported: info.CgroupVersion === '2',
      memoryLimitsSupported: info.MemoryLimit !== false,
      securityOptions,
    };
  }

  async assertRootless() {
    const info = await this.getRuntimeInfo();
    if (!info.rootless) throw new Error('The configured Docker daemon is not running in rootless mode');
    return info;
  }

  async ensureAppNetwork(appId: string) {
    const network = await createOrReuseAppNetwork(this.docker, appId);
    return { name: network.Name, driver: network.Driver };
  }

  async listContainers(includeStats = true) {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: ['halfcloud.managed=true'] },
    });
    return Promise.all(containers.map(async (container) => {
      const ports = (container.Ports ?? []).filter((port) => port.PublicPort).map((port) => ({
        host: port.PublicPort!,
        container: port.PrivatePort,
        protocol: port.Type,
      }));
      const internalPorts = [...new Map((container.Ports ?? []).map((port) => [
        `${port.PrivatePort}/${port.Type}`,
        { port: port.PrivatePort, protocol: port.Type },
      ])).values()];
      let stats = { cpuPercent: 0, memoryUsed: 0, memoryLimit: 0 };
      if (includeStats && container.State === 'running') {
        try {
          stats = await this.getContainerStats(container.Id);
        } catch {
          // A container can stop between the list and stats calls.
        }
      }
      return {
        id: container.Id,
        name: container.Labels?.['halfcloud.service.name'] ?? container.Names?.[0]?.replace(/^\//, '') ?? container.Id.slice(0, 12),
        appId: container.Labels?.['halfcloud.app.id'],
        serviceId: container.Labels?.['halfcloud.service.id'],
        runtimeName: container.Names?.[0]?.replace(/^\//, '') ?? container.Id.slice(0, 12),
        image: container.Image,
        state: container.State,
        status: container.Status,
        hostname: container.Labels?.['halfcloud.hostname'],
        ports,
        internalPorts,
        ...stats,
      };
    }));
  }

  async createContainer(input: CreateContainerInput, onProgress?: (progress: DeploymentProgress) => void) {
    const name = input.name.trim();
    const image = input.image.trim();
    onProgress?.({ phase: 'activity', label: `Checking ${input.serviceName}` });
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name)) throw new Error('Invalid container name');
    if (!image || image.length > 255) throw new Error('Invalid image name');
    if (input.hostname && !/^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(input.hostname)) {
      throw new Error('Invalid application hostname');
    }

    const networkName = appNetworkName(input.appId);
    onProgress?.({ phase: 'activity', label: 'Preparing private network' });
    await this.ensureAppNetwork(input.appId);

    const existing = await this.docker.listContainers({ all: true, filters: { name: [`^/${name}$`] } });
    if (existing.length) throw new Error(`A Docker container named ${name} already exists`);

    const targetPorts = new Set<string>();
    const normalizedPorts = Object.entries(input.ports).map(([host, target]) => {
      if (!/^\d+$/.test(host) || !/^\d+(\/(tcp|udp))?$/.test(target)) throw new Error(`Invalid port mapping ${host} -> ${target}`);
      const hostPort = Number.parseInt(host, 10);
      const [containerPart, protocol = 'tcp'] = target.split('/');
      const containerPort = Number.parseInt(containerPart ?? '', 10);
      try {
        validateHostPort(hostPort);
      } catch {
        throw new Error(`Invalid port mapping ${host} -> ${target}`);
      }
      if (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535) {
        throw new Error(`Invalid port mapping ${host} -> ${target}`);
      }
      if (protocol !== 'tcp' && protocol !== 'udp') throw new Error(`Unsupported port protocol ${protocol}`);
      const targetKey = `${containerPort}/${protocol}`;
      if (targetPorts.has(targetKey)) throw new Error(`Container port ${targetKey} cannot be published more than once`);
      targetPorts.add(targetKey);
      return { hostPort, containerPort, protocol };
    });

    for (const port of normalizedPorts) {
      const conflict = await this.portConflict(port.hostPort);
      if (conflict) {
        const suggestion = await this.nextAvailablePort(port.hostPort + 1);
        throw new Error(`Port ${port.hostPort} is already used by ${conflict}. Suggested available port: ${suggestion}`);
      }
    }

    for (const key of Object.keys(input.environment ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable name ${key}`);
    }

    onProgress?.({ phase: 'activity', label: `Preparing storage for ${input.serviceName}` });
    await mkdir(this.appsDir, { recursive: true, mode: 0o700 });
    const appsRoot = await realpath(this.appsDir);
    const appDir = path.join(appsRoot, input.appId);
    await mkdir(appDir, { recursive: false, mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    if (await realpath(appDir) !== appDir) throw new Error(`Application directory ${name} cannot be a symbolic link`);
    const binds: string[] = [];
    const newBindSources: string[] = [];
    for (const [relativeSource, containerTarget] of Object.entries(input.volumes ?? {})) {
      if (!containerTarget.startsWith('/') || containerTarget === '/') throw new Error(`Invalid container mount target ${containerTarget}`);
      const source = managedBindPath(appDir, relativeSource);
      if (await this.createManagedBindDirectory(appDir, source)) newBindSources.push(source);
      binds.push(`${source}:${containerTarget}`);
    }
    const mounts: Array<{ Type: 'volume'; Source: string; Target: string }> = [];
    const mountTargets = new Set(binds.map((bind) => bind.slice(bind.indexOf(':') + 1)));
    for (const [localName, containerTarget] of Object.entries(input.namedVolumes ?? {})) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(localName)) throw new Error(`Invalid named volume ${localName}`);
      if (!containerTarget.startsWith('/') || containerTarget === '/') throw new Error(`Invalid container mount target ${containerTarget}`);
      if (mountTargets.has(containerTarget)) throw new Error(`Container mount target ${containerTarget} cannot be used more than once`);
      mountTargets.add(containerTarget);
      const volumeName = `halfcloud-${input.serviceId}-${localName}`;
      if (volumeName.length > 255) throw new Error(`Named volume ${localName} is too long`);
      await createOrReuseManagedVolume(this.docker, input.serviceId, localName, input.appId);
      mounts.push({ Type: 'volume', Source: volumeName, Target: containerTarget });
    }

    const environment = input.environment ?? {};
    if (Object.keys(environment).length) {
      await writeFile(path.join(appDir, '.env'), `${Object.entries(environment).map(([key, value]) => `${key}=${value.replace(/\n/g, '\\n')}`).join('\n')}\n`, { mode: 0o600 });
    }

    let pulled = false;
    let imageInspection: Docker.ImageInspectInfo;
    onProgress?.({ phase: 'activity', label: `Checking ${image}` });
    try {
      imageInspection = await this.docker.getImage(image).inspect();
    } catch {
      onProgress?.({ phase: 'pulling-image', image });
      try {
        const stream = await this.docker.pull(image);
        await new Promise<void>((resolve, reject) => {
          this.docker.modem.followProgress(stream, (error) => error ? reject(error) : resolve());
        });
        pulled = true;
        imageInspection = await this.docker.getImage(image).inspect();
      } finally {
        onProgress?.({ phase: 'working' });
      }
    }

    if (newBindSources.length) {
      await this.initializeStorageOwnership(image, imageInspection.Config?.User ?? '', newBindSources.map((source) => ({ type: 'bind', source })));
    }

    const exposedPorts: Record<string, object> = {};
    const portBindings: Record<string, Array<{ HostIp: string; HostPort: string }>> = {};
    for (const port of normalizedPorts) {
      const key = `${port.containerPort}/${port.protocol}`;
      exposedPorts[key] = {};
      portBindings[key] = [{ HostIp: '127.0.0.1', HostPort: String(port.hostPort) }];
    }

    const container = await this.docker.createContainer({
      name,
      Image: image,
      Env: Object.entries(environment).map(([key, value]) => `${key}=${value}`),
      Labels: {
        'halfcloud.managed': 'true',
        'halfcloud.app.id': input.appId,
        'halfcloud.service.id': input.serviceId,
        'halfcloud.service.name': input.serviceName,
        ...(input.hostname ? { 'halfcloud.hostname': input.hostname } : {}),
      },
      ExposedPorts: exposedPorts,
      HostConfig: {
        NetworkMode: networkName,
        PortBindings: portBindings,
        RestartPolicy: { Name: 'unless-stopped' },
        LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
        SecurityOpt: ['no-new-privileges'],
        PidsLimit: 512,
        Binds: binds,
        Mounts: mounts,
      },
      NetworkingConfig: { EndpointsConfig: { [networkName]: { Aliases: [input.serviceName] } } },
    });
    try {
      const shouldStart = input.start !== false;
      if (shouldStart) {
        onProgress?.({ phase: 'activity', label: `Starting ${input.serviceName}` });
        await container.start();
      }
      const inspection = await container.inspect();
      return {
        id: inspection.Id,
        name,
        image,
        running: inspection.State.Running,
        ports: input.ports,
        steps: [
          'Validated rootless deployment policy',
          `Connected to ${networkName} network`,
          'Checked published ports',
          pulled ? `Pulled ${image}` : `Found ${image} locally`,
          'Created service',
          shouldStart ? 'Started service' : 'Staged service for configuration',
        ],
      };
    } catch (error) {
      await container.remove({ force: true }).catch(() => undefined);
      throw error;
    }
  }

  async startContainer(id: string) {
    const container = await this.managedContainer(id);
    await container.start();
    return { containerId: container.id, state: 'running' };
  }

  async stopContainer(id: string) {
    const container = await this.managedContainer(id);
    await container.stop({ t: 10 });
    return { containerId: container.id, state: 'exited' };
  }

  async restartContainer(id: string) {
    const container = await this.managedContainer(id);
    await container.restart({ t: 10 });
    return { containerId: container.id, state: 'running' };
  }

  async recreateContainer(id: string) {
    const runtime = await this.getContainerEnvironment(id);
    return this.replaceContainerEnvironment(id, runtime.environment);
  }

  async deleteContainer(id: string) {
    const container = await this.managedContainer(id);
    const inspection = await container.inspect();
    await container.remove({ force: inspection.State.Running, v: false });
    return { containerId: container.id, deleted: true, imageRemoved: false };
  }

  async deleteAppNetwork(appId: string) {
    const name = appNetworkName(appId);
    const network = await this.docker.getNetwork(name).inspect().catch((error: { statusCode?: number }) => {
      if (error.statusCode === 404) return undefined;
      throw error;
    });
    if (!network) return { name, deleted: false };
    if (network.Labels?.['halfcloud.managed'] !== 'true' || network.Labels?.['halfcloud.app.id'] !== appId) throw new Error(`Network ${name} is not owned by App ${appId}`);
    await this.docker.getNetwork(network.Id).remove();
    return { name, deleted: true };
  }

  async listManagedVolumes(filter: ManagedVolumeFilter = {}) {
    const filters = [
      'halfcloud.managed=true',
      ...(filter.appId ? [`halfcloud.app.id=${filter.appId}`] : []),
      ...(filter.serviceId ? [`halfcloud.service.id=${filter.serviceId}`] : []),
    ];
    const { Volumes: volumes = [] } = await this.docker.listVolumes({ filters: { label: filters } });
    const containers = await this.docker.listContainers({ all: true });
    const attached = new Map<string, string[]>();
    for (const container of containers) {
      for (const mount of container.Mounts ?? []) {
        if (mount.Type !== 'volume' || !mount.Name) continue;
        const names = attached.get(mount.Name) ?? [];
        names.push(container.Names?.[0]?.replace(/^\//, '') ?? container.Id.slice(0, 12));
        attached.set(mount.Name, names);
      }
    }
    const results = volumes.map((volume) => ({
      name: volume.Name,
      application: volume.Labels?.['halfcloud.application'],
      appId: volume.Labels?.['halfcloud.app.id'],
      serviceId: volume.Labels?.['halfcloud.service.id'],
      localName: volume.Labels?.['halfcloud.volume'],
      driver: volume.Driver,
      attachedTo: attached.get(volume.Name) ?? [],
      orphaned: !(attached.get(volume.Name)?.length),
    }));
    return filter.orphaned === undefined ? results : results.filter((volume) => volume.orphaned === filter.orphaned);
  }

  async inspectManagedVolume(volumeName: string) {
    const volume = await this.managedVolume(volumeName);
    const containers = await this.docker.listContainers({ all: true });
    const attachedTo = containers
      .filter((container) => container.Mounts?.some((mount) => mount.Type === 'volume' && mount.Name === volume.Name))
      .map((container) => container.Names?.[0]?.replace(/^\//, '') ?? container.Id.slice(0, 12));
    return {
      name: volume.Name,
      application: volume.Labels['halfcloud.application'],
      appId: volume.Labels['halfcloud.app.id'],
      serviceId: volume.Labels['halfcloud.service.id'],
      localName: volume.Labels['halfcloud.volume'],
      driver: volume.Driver,
      scope: volume.Scope,
      attachedTo,
      orphaned: attachedTo.length === 0,
    };
  }

  async deleteManagedVolume(volumeName: string) {
    const volume = await this.managedVolume(volumeName);
    await this.docker.getVolume(volume.Name).remove();
    return { volumeName: volume.Name, deleted: true };
  }

  async reconcileManagedVolume(application: string, localName: string) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(application)) throw new Error('Invalid application name');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(localName)) throw new Error('Invalid local volume name');
    const volumeName = `halfcloud-${application}-${localName}`;
    const volume = await this.docker.getVolume(volumeName).inspect();
    assertManagedVolumeLabels(volume, application, localName);
    const details = await this.inspectManagedVolume(volumeName);
    if (!details.orphaned) throw new Error(`Docker volume ${volumeName} is attached and does not need reconciliation`);
    return { ...details, reconciled: true, reusableByCreateApplication: true };
  }

  async repairStorageOwnership(id: string, mountTarget: string) {
    if (!mountTarget.startsWith('/') || mountTarget === '/') throw new Error('Invalid container mount target');
    const container = await this.managedContainer(id);
    const inspection = await container.inspect();
    const mount = inspection.Mounts.find((candidate) => candidate.Destination === mountTarget);
    if (!mount) throw new Error(`Application does not have storage mounted at ${mountTarget}`);

    let storage: { type: 'bind' | 'volume'; source: string };
    if (mount.Type === 'volume') {
      const volume = await this.managedVolume(mount.Name ?? mount.Source);
      if (volume.Labels['halfcloud.application'] !== inspection.Config.Labels?.['halfcloud.service.id']) throw new Error(`Volume ${volume.Name} is not managed by this service`);
      storage = { type: 'volume', source: volume.Name };
    } else if (mount.Type === 'bind') {
      const application = inspection.Config.Labels?.['halfcloud.app.id'];
      if (!application) throw new Error('Managed application label is missing');
      const appRoot = await realpath(path.join(this.appsDir, application));
      const source = await realpath(mount.Source);
      if (source === appRoot || !source.startsWith(`${appRoot}${path.sep}`)) throw new Error('Bind mount is outside the managed application directory');
      storage = { type: 'bind', source };
    } else {
      throw new Error(`Storage type ${mount.Type} cannot be repaired`);
    }

    const wasRunning = inspection.State.Running;
    if (wasRunning) await container.stop({ t: 10 });
    try {
      await this.initializeStorageOwnership(inspection.Config.Image, inspection.Config.User, [storage]);
    } finally {
      if (wasRunning) await container.start();
    }
    return { containerId: container.id, mountTarget, owner: inspection.Config.User, repaired: true, state: wasRunning ? 'running' : 'exited' };
  }

  async getContainerEnvironment(id: string) {
    const container = await this.managedContainer(id);
    const inspection = await container.inspect();
    return {
      containerId: container.id,
      name: inspection.Config.Labels?.['halfcloud.service.id'] ?? inspection.Name.replace(/^\//, ''),
      environment: Object.fromEntries((inspection.Config.Env ?? []).map((entry) => {
        const separator = entry.indexOf('=');
        return [entry.slice(0, separator), entry.slice(separator + 1)];
      })),
    };
  }

  async replaceContainerEnvironment(id: string, nextEnvironment: Record<string, string>) {
    for (const key of Object.keys(nextEnvironment)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable name ${key}`);
    }
    const container = await this.managedContainer(id);
    const inspection = await container.inspect();
    const name = inspection.Name.replace(/^\//, '');
    const appId = inspection.Config.Labels?.['halfcloud.app.id'];
    if (!appId) throw new Error('Managed service is missing its App ID');
    const networkName = appNetworkName(appId);
    await createOrReuseAppNetwork(this.docker, appId);
    const backupName = `${name}-halfcloud-backup-${Date.now()}`;
    const wasRunning = inspection.State.Running;
    if (wasRunning) await container.stop({ t: 10 });
    await container.rename({ name: backupName });
    let replacement: Docker.Container | undefined;
    try {
      replacement = await this.docker.createContainer({
        name,
        Image: inspection.Config.Image,
        Cmd: inspection.Config.Cmd,
        Entrypoint: inspection.Config.Entrypoint,
        WorkingDir: inspection.Config.WorkingDir,
        User: inspection.Config.User,
        Env: Object.entries(nextEnvironment).map(([key, value]) => `${key}=${value}`),
        Labels: inspection.Config.Labels,
        ExposedPorts: inspection.Config.ExposedPorts,
        Healthcheck: inspection.Config.Healthcheck,
        HostConfig: {
          NetworkMode: networkName,
          PortBindings: inspection.HostConfig.PortBindings,
          Binds: inspection.HostConfig.Binds,
          RestartPolicy: inspection.HostConfig.RestartPolicy,
          LogConfig: inspection.HostConfig.LogConfig,
          SecurityOpt: inspection.HostConfig.SecurityOpt,
          PidsLimit: inspection.HostConfig.PidsLimit,
          Mounts: inspection.HostConfig.Mounts,
        },
        NetworkingConfig: { EndpointsConfig: { [networkName]: { Aliases: [inspection.Config.Labels?.['halfcloud.service.name'] ?? name] } } },
      });
      if (wasRunning) await replacement.start();
      const appDir = path.join(this.appsDir, appId);
      await writeFile(path.join(appDir, '.env'), `${Object.entries(nextEnvironment).map(([key, value]) => `${key}=${value.replace(/\n/g, '\\n')}`).join('\n')}${Object.keys(nextEnvironment).length ? '\n' : ''}`, { mode: 0o600 });
      await container.remove({ force: true, v: false });
      return { containerId: replacement.id, name, state: wasRunning ? 'running' : 'exited' };
    } catch (error) {
      if (replacement) await replacement.remove({ force: true }).catch(() => undefined);
      await container.rename({ name });
      if (wasRunning) await container.start().catch(() => undefined);
      throw error;
    }
  }

  async inspectContainer(id: string) {
    const container = await this.managedContainer(id);
    const inspection = await container.inspect();
    return {
      id: inspection.Id,
      name: inspection.Config.Labels?.['halfcloud.service.name'] ?? inspection.Name.replace(/^\//, ''),
      appId: inspection.Config.Labels?.['halfcloud.app.id'],
      serviceId: inspection.Config.Labels?.['halfcloud.service.id'],
      image: inspection.Config.Image,
      state: inspection.State.Status,
      ports: Object.entries(inspection.NetworkSettings.Ports ?? {}).flatMap(([target, bindings]) =>
        (bindings ?? []).map((binding) => ({ target, hostPort: binding.HostPort, hostIp: binding.HostIp }))),
      mounts: inspection.Mounts.map((mount) => ({ type: mount.Type, target: mount.Destination, ...(mount.Name ? { name: mount.Name } : {}) })),
      networks: Object.keys(inspection.NetworkSettings.Networks ?? {}),
      restartPolicy: inspection.HostConfig.RestartPolicy?.Name ?? 'no',
      health: inspection.State.Health?.Status ?? null,
    };
  }

  async getContainerLogs(id: string, tail = 200) {
    const container = await this.managedContainer(id);
    const output = await container.logs({ stdout: true, stderr: true, timestamps: true, tail: Math.min(Math.max(tail, 1), 1000) });
    const inspection = await container.inspect();
    const secrets = (inspection.Config.Env ?? []).map((entry) => entry.slice(entry.indexOf('=') + 1)).filter((value) => value.length >= 4);
    let logs = this.cleanDockerLog(Buffer.isBuffer(output) ? output : Buffer.from(String(output)));
    for (const secret of secrets) logs = logs.replaceAll(secret, '[REDACTED]');
    return { containerId: container.id, logs };
  }

  async getContainerStats(id: string) {
    const container = await this.managedContainer(id);
    const stats = await container.stats({ stream: false }) as unknown as DockerStats;
    const cpuDelta = (stats.cpu_stats?.cpu_usage?.total_usage ?? 0) - (stats.precpu_stats?.cpu_usage?.total_usage ?? 0);
    const systemDelta = (stats.cpu_stats?.system_cpu_usage ?? 0) - (stats.precpu_stats?.system_cpu_usage ?? 0);
    const cpus = stats.cpu_stats?.online_cpus ?? stats.cpu_stats?.cpu_usage?.percpu_usage?.length ?? 1;
    const cache = stats.memory_stats?.stats?.inactive_file ?? stats.memory_stats?.stats?.cache ?? 0;
    return {
      cpuPercent: Number((systemDelta > 0 ? (cpuDelta / systemDelta) * cpus * 100 : 0).toFixed(2)),
      memoryUsed: Math.max(0, (stats.memory_stats?.usage ?? 0) - cache),
      memoryLimit: stats.memory_stats?.limit ?? 0,
    };
  }

  private async managedContainer(idOrName: string) {
    const candidates = await this.docker.listContainers({ all: true, filters: { label: ['halfcloud.managed=true'] } });
    const matches = candidates.filter((container) =>
      container.Id === idOrName || container.Id.startsWith(idOrName) || container.Names?.some((name) => name === `/${idOrName}`) || container.Labels?.['halfcloud.service.id'] === idOrName,
    );
    if (!matches.length) throw new Error(`Managed container ${idOrName} was not found`);
    if (matches.length > 1) throw new Error(`Container id ${idOrName} is ambiguous; use the exact name or full id`);
    return this.docker.getContainer(matches[0]!.Id);
  }

  private async managedVolume(volumeName: string) {
    if (!/^halfcloud-[a-zA-Z0-9_.-]+$/.test(volumeName)) throw new Error('Invalid managed volume name');
    const volume = await this.docker.getVolume(volumeName).inspect();
    if (volume.Labels?.['halfcloud.managed'] !== 'true' || !volume.Labels?.['halfcloud.application'] || !volume.Labels?.['halfcloud.volume']) {
      throw new Error(`Docker volume ${volumeName} is not managed by HalfCloud`);
    }
    assertManagedVolumeLabels(volume, volume.Labels['halfcloud.application'], volume.Labels['halfcloud.volume']);
    return volume;
  }

  private async createManagedBindDirectory(appDir: string, source: string) {
    let created = false;
    let current = appDir;
    for (const segment of path.relative(appDir, source).split(path.sep)) {
      current = path.join(current, segment);
      try {
        const details = await lstat(current);
        if (details.isSymbolicLink() || !details.isDirectory()) throw new Error(`Bind mount path ${current} must contain directories only`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await mkdir(current, { mode: 0o700 });
        created = true;
      }
    }
    return created;
  }

  private async initializeStorageOwnership(
    image: string,
    imageUser: string,
    storage: Array<{ type: 'bind' | 'volume'; source: string }>,
  ) {
    if (!imageUser || ['0', '0:0', 'root', 'root:root'].includes(imageUser)) return;
    const targets = storage.map((_, index) => `/halfcloud-storage/${index}`);
    const helper = await this.docker.createContainer({
      Image: image,
      User: '0:0',
      Entrypoint: ['/bin/sh', '-c'],
      Cmd: [
        'requested_user="$1"; shift; case "$requested_user" in *:*) owner="$requested_user" ;; *) owner="$(id -u "$requested_user"):$(id -g "$requested_user")" ;; esac; chown -R "$owner" "$@"',
        'halfcloud-storage-init',
        imageUser,
        ...targets,
      ],
      HostConfig: {
        NetworkMode: 'none',
        ReadonlyRootfs: true,
        SecurityOpt: ['no-new-privileges'],
        CapDrop: ['ALL'],
        CapAdd: ['CHOWN', 'DAC_OVERRIDE'],
        PidsLimit: 32,
        Binds: storage.flatMap((item, index) => item.type === 'bind' ? [`${item.source}:${targets[index]}`] : []),
        Mounts: storage.flatMap((item, index) => item.type === 'volume' ? [{ Type: 'volume' as const, Source: item.source, Target: targets[index]! }] : []),
      },
    });
    try {
      await helper.start();
      const result = await helper.wait();
      if (result.StatusCode !== 0) {
        const output = await helper.logs({ stdout: true, stderr: true, tail: 50 });
        throw new Error(`Could not initialize storage ownership for image user ${imageUser}: ${this.cleanDockerLog(Buffer.isBuffer(output) ? output : Buffer.from(String(output)))}`);
      }
    } finally {
      await helper.remove({ force: true, v: false }).catch(() => undefined);
    }
  }

  private async portConflict(port: number) {
    const containers = await this.docker.listContainers({ all: true });
    const owner = containers.find((container) => container.Ports?.some((binding) => binding.PublicPort === port));
    if (owner) return `container ${owner.Names?.[0]?.replace(/^\//, '') ?? owner.Id.slice(0, 12)}`;
    const free = await new Promise<boolean>((resolve) => {
      const server = net.createServer().unref();
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    return free ? null : 'another host process';
  }

  private async nextAvailablePort(start: number) {
    for (let port = Math.max(start, minimumHostPort); port <= maximumHostPort; port += 1) {
      if (!(await this.portConflict(port))) return port;
    }
    throw new Error('No available host port found');
  }

  private cleanDockerLog(buffer: Buffer) {
    const lines: string[] = [];
    let offset = 0;
    while (offset + 8 <= buffer.length) {
      const size = buffer.readUInt32BE(offset + 4);
      if ((buffer[offset] === 1 || buffer[offset] === 2) && offset + 8 + size <= buffer.length) {
        lines.push(buffer.subarray(offset + 8, offset + 8 + size).toString('utf8'));
        offset += 8 + size;
      } else {
        return buffer.toString('utf8');
      }
    }
    return lines.join('').trimEnd();
  }
}
