import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
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

export interface BuildImageInput {
  context: string;
  dockerfile: string;
  entries: string[];
  image: string;
}

export interface ContainerReplacement {
  containerId: string;
  name: string;
  state: string;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface ContainerRecoveryIssue {
  code: 'missing_replacement';
  appId: string;
  serviceId: string;
  name: string;
  backupId: string;
  backupName: string;
}

class MissingContainerReplacementError extends Error {
  constructor(readonly issue: ContainerRecoveryIssue) {
    super(`Replacement for ${issue.name} is missing; refusing commit`);
  }
}

// The rename is a durable journal: record running state before stopping, and commit before cleanup.
const replacementName = /^\/?([a-zA-Z0-9][a-zA-Z0-9_.-]{0,127})-halfcloud-replacement-v1-([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})-(running|stopped)-(pending|committed)$/;
const replacementLabel = 'halfcloud.replacement.backup';

function isServiceInitializationContainer(container: Docker.ContainerInfo, appId: string, serviceId: string, serviceName: string) {
  return container.Labels?.['halfcloud.operation'] === 'service-initialization'
    && container.Labels['halfcloud.app.id'] === appId
    && container.Labels['halfcloud.service.id'] === serviceId
    && container.Labels['halfcloud.managed'] === undefined
    && container.Labels[replacementLabel] === undefined
    // Helpers have Docker-generated names, never the Service's runtime name or a replacement journal name.
    && container.Names?.length === 1
    && /^\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(container.Names[0]!)
    && container.Names[0] !== `/${serviceName}`
    && !replacementName.test(container.Names[0]!);
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

export type ServiceCommandNetworkMode = 'app' | 'service';

export class DockerService {
  private readonly docker: Docker;
  private readonly appsDir: string;
  private readonly initializingServices = new Set<string>();

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

  async buildImage(input: BuildImageInput) {
    if (!/^halfcloud\/[a-z0-9._-]+:[a-z0-9._-]+$/.test(input.image)) throw new Error('Invalid managed build image name');
    if (!input.entries.length || input.entries.length > 20_000) throw new Error('Invalid Docker build context');
    const timeoutMs = Math.min(Math.max(Number(process.env.HALFCLOUD_BUILD_TIMEOUT_MS ?? 600_000), 30_000), 1_800_000);
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), timeoutMs);
    const messages: string[] = [];
    let context: string | undefined;
    try {
      // Dockerode filters src with .dockerignore, including the Dockerfile itself. Use a private
      // snapshot with last-match exceptions, never rewrite the repository or import its tar dependencies.
      context = await mkdtemp(path.join(tmpdir(), 'halfcloud-build-'));
      const entries = [...new Set([...input.entries, input.dockerfile, '.dockerignore'])];
      for (const entry of entries) {
        if (abortController.signal.aborted) throw new Error('Docker build context preparation timed out');
        if (!entry || path.isAbsolute(entry) || entry.split('/').some((part) => part === '..' || part === '.' || !part) || /[\r\n\\]/.test(entry)) {
          throw new Error('Invalid Docker build context path');
        }
        const source = path.join(input.context, entry);
        if (entry === '.dockerignore') continue;
        const details = await lstat(source);
        if (!details.isFile() && !details.isSymbolicLink()) throw new Error('Docker build entries must be files');
        if (await realpath(path.dirname(source)) !== path.resolve(path.dirname(source))) throw new Error('Docker build entry has a symbolic-link parent');
        if (entry === input.dockerfile && !details.isFile()) throw new Error('Dockerfile must be a regular file');
        await mkdir(path.dirname(path.join(context, entry)), { recursive: true });
        await cp(source, path.join(context, entry), { mode: constants.COPYFILE_FICLONE, verbatimSymlinks: true });
      }
      const ignorePath = path.join(input.context, '.dockerignore');
      const ignoreStat = await lstat(ignorePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (ignoreStat && !ignoreStat.isFile()) throw new Error('.dockerignore must be a regular file');
      const ignore = ignoreStat ? await readFile(ignorePath, 'utf8') : '';
      const dockerfilePattern = input.dockerfile.replace(/([*?\[\]!# ])/g, '\\$1');
      await writeFile(path.join(context, '.dockerignore'), `${ignore}\n!${dockerfilePattern}\n!.dockerignore\n`, { mode: 0o600 });
      const stream = await this.docker.buildImage(
        { context, src: entries },
        {
          dockerfile: input.dockerfile,
          t: input.image,
          pull: true,
          rm: true,
          forcerm: true,
          labels: { 'halfcloud.managed': 'true', 'halfcloud.source': 'git' },
          version: '2',
          abortSignal: abortController.signal,
        },
      );
      const collectMessage = (event: unknown) => {
        if (typeof event !== 'object' || event === null) return;
        const value = event as { stream?: unknown; status?: unknown; error?: unknown; errorDetail?: { message?: unknown } };
        const message = typeof value.errorDetail?.message === 'string' ? value.errorDetail.message
          : typeof value.error === 'string' ? value.error
            : typeof value.stream === 'string' ? value.stream
              : typeof value.status === 'string' ? value.status
                : '';
        if (message) messages.push(message.trimEnd());
      };
      await new Promise<void>((resolve, reject) => {
        const buildProgress = this.docker as unknown as { followProgress: (stream: NodeJS.ReadableStream, complete: (error?: Error) => void, progress: (event: unknown) => void) => void };
        buildProgress.followProgress(stream, (error) => error ? reject(error) : resolve(), collectMessage);
      });
      const inspection = await this.docker.getImage(input.image).inspect();
      return { image: input.image, imageId: inspection.Id, logs: messages.join('\n').slice(-32 * 1024) };
    } catch (error) {
      if (abortController.signal.aborted) throw new Error(`Application build timed out after ${Math.round(timeoutMs / 1000)} seconds`);
      const detail = error instanceof Error ? error.message : 'Docker build failed';
      const logs = messages.join('\n').slice(-32 * 1024);
      throw new Error(logs ? `${detail}\n${logs}`.slice(-32 * 1024) : detail);
    } finally {
      clearTimeout(timer);
      if (context) await rm(context, { recursive: true, force: true });
    }
  }

  async listContainers(includeStats = true) {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: ['halfcloud.managed=true'] },
    });
    return Promise.all(containers.filter((container) => container.Labels?.['halfcloud.managed'] === 'true' && !container.Names?.some((name) => replacementName.test(name))).map(async (container) => {
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

  async runServiceInitializationCommand(id: string, command: string[], networkMode: ServiceCommandNetworkMode = 'app') {
    if (!command.length || command.length > 32 || command.some((part) => !part || part.length > 4096 || part.includes('\0'))) {
      throw new Error('Initialization command must contain 1-32 bounded arguments');
    }
    if (networkMode !== 'app' && networkMode !== 'service') throw new Error('Initialization network mode must be app or service');
    const source = await this.managedContainer(id);
    const inspection = await source.inspect();
    const appId = inspection.Config.Labels?.['halfcloud.app.id'];
    const serviceId = inspection.Config.Labels?.['halfcloud.service.id'];
    const serviceName = inspection.Config.Labels?.['halfcloud.service.name'];
    if (!appId || !serviceId || !serviceName) throw new Error('Managed Service is missing required ownership labels');
    const initializingServices = this.initializingServices;
    if (initializingServices.has(serviceId)) throw new Error(`An initialization command is already running for Service ${serviceName}`);
    initializingServices.add(serviceId);

    let operation: Docker.Container;
    try {
      const networkName = appNetworkName(appId);
      if (!inspection.NetworkSettings.Networks?.[networkName]) throw new Error(`Managed Service is not connected to its App network ${networkName}`);
      await this.ensureAppNetwork(appId);
      if (networkMode === 'service' && !inspection.State.Running) throw new Error('Service-local initialization requires a running Service');

      const appsRoot = await realpath(this.appsDir);
      const appDir = path.join(appsRoot, appId);
      const mounts: Docker.MountSettings[] = [];
      for (const mount of inspection.Mounts) {
        if (mount.Type === 'bind') {
          const sourcePath = await realpath(mount.Source);
          if (sourcePath === appDir || !sourcePath.startsWith(`${appDir}${path.sep}`)) throw new Error(`Service bind mount ${mount.Destination} is outside its managed App directory`);
          mounts.push({ Type: 'bind', Source: sourcePath, Target: mount.Destination, ReadOnly: mount.RW === false });
          continue;
        }
        if (mount.Type === 'volume' && mount.Name) {
          mounts.push({ Type: 'volume', Source: mount.Name, Target: mount.Destination, ReadOnly: mount.RW === false });
          continue;
        }
        throw new Error(`Service mount ${mount.Destination} has unsupported type ${mount.Type}`);
      }

      operation = await this.docker.createContainer({
        Image: inspection.Image,
        Entrypoint: [command[0]!],
        Cmd: command.slice(1),
        WorkingDir: inspection.Config.WorkingDir,
        User: inspection.Config.User,
        Env: inspection.Config.Env,
        Labels: {
          'halfcloud.operation': 'service-initialization',
          'halfcloud.app.id': appId,
          'halfcloud.service.id': serviceId,
        },
        HostConfig: {
          NetworkMode: networkMode === 'service' ? `container:${inspection.Id}` : networkName,
          PortBindings: {},
          PublishAllPorts: false,
          RestartPolicy: { Name: 'no' },
          LogConfig: { Type: 'none', Config: {} },
          SecurityOpt: ['no-new-privileges'],
          PidsLimit: Math.min(inspection.HostConfig.PidsLimit ?? 512, 512),
          Mounts: mounts,
        },
        ...(networkMode === 'app' ? { NetworkingConfig: { EndpointsConfig: { [networkName]: {} } } } : {}),
      });
    } catch (error) {
      initializingServices.delete(serviceId);
      throw error;
    }
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), 300_000);
    try {
      await operation.start();
      const result = await Promise.race([
        operation.wait(),
        new Promise<never>((_resolve, reject) => abortController.signal.addEventListener('abort', () => reject(new Error('Initialization command timed out after 300 seconds')), { once: true })),
      ]);
      if (result.StatusCode !== 0) throw new Error(`Initialization command failed with exit code ${result.StatusCode}`);
      return { serviceId, exitCode: result.StatusCode, completed: true };
    } catch (error) {
      if (abortController.signal.aborted) await operation.stop({ t: 5 }).catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(timer);
      initializingServices.delete(serviceId);
      await operation.remove({ force: true, v: false }).catch(() => undefined);
    }
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

  async listDockerVolumes(unusedOnly = false) {
    const { Volumes: volumes = [] } = await this.docker.listVolumes(unusedOnly ? { filters: { dangling: ['true'] } } : {});
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
    return volumes.map((volume) => ({
      name: volume.Name,
      driver: volume.Driver,
      managedByHalfCloud: volume.Labels?.['halfcloud.managed'] === 'true',
      legacyHalfCloudName: volume.Name.startsWith('halfcloud-'),
      appId: volume.Labels?.['halfcloud.app.id'],
      serviceId: volume.Labels?.['halfcloud.service.id'],
      localName: volume.Labels?.['halfcloud.volume'],
      attachedTo: attached.get(volume.Name) ?? [],
      unused: !(attached.get(volume.Name)?.length),
    }));
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

  async deleteUnusedVolume(volumeName: string) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/.test(volumeName)) throw new Error('Invalid Docker volume name');
    const { Volumes: volumes = [] } = await this.docker.listVolumes({ filters: { dangling: ['true'] } });
    if (!volumes.some((volume) => volume.Name === volumeName)) throw new Error(`Docker volume ${volumeName} is not unused and was not deleted`);
    await this.docker.getVolume(volumeName).remove();
    return { volumeName, deleted: true };
  }

  async listUnusedImages() {
    const [images, containers] = await Promise.all([
      this.docker.listImages({ all: true }),
      this.docker.listContainers({ all: true }),
    ]);
    const usedImageIds = new Set(containers.map((container) => container.ImageID));
    const unused = images.filter((image) => !usedImageIds.has(image.Id)).map((image) => ({
      id: image.Id,
      names: image.RepoTags?.filter((name) => name !== '<none>:<none>') ?? [],
      size: image.Size,
      createdAt: new Date(image.Created * 1000).toISOString(),
    }));
    return { images: unused, totalSize: unused.reduce((total, image) => total + image.size, 0) };
  }

  async pruneUnusedImages() {
    const result = await this.docker.pruneImages({ filters: { dangling: ['false'] } });
    return {
      deleted: result.ImagesDeleted?.length ?? 0,
      spaceReclaimed: result.SpaceReclaimed ?? 0,
    };
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
    const transaction = await this.replaceContainer(id, { environment: nextEnvironment });
    await transaction.commit();
    return { containerId: transaction.containerId, name: transaction.name, state: transaction.state };
  }

  async replaceContainerImage(id: string, image: string) {
    const transaction = await this.beginContainerImageReplacement(id, image);
    await transaction.commit();
    return { containerId: transaction.containerId, name: transaction.name, state: transaction.state };
  }

  async beginContainerImageReplacement(id: string, image: string): Promise<ContainerReplacement> {
    image = image.trim();
    if (!image || image.length > 255) throw new Error('Invalid image name');
    return this.replaceContainer(id, { image });
  }

  private async replaceContainer(id: string, changes: { environment?: Record<string, string>; image?: string }): Promise<ContainerReplacement> {
    const container = await this.managedContainer(id);
    const inspection = await container.inspect();
    const name = inspection.Name.replace(/^\//, '');
    const appId = inspection.Config.Labels?.['halfcloud.app.id'];
    if (!appId) throw new Error('Managed service is missing its App ID');
    const serviceId = inspection.Config.Labels?.['halfcloud.service.id'];
    if (!serviceId) throw new Error('Managed service is missing its Service ID');
    if (replacementName.test(name)) throw new Error('Cannot replace a retained backup');
    if (this.initializingServices.has(serviceId)) throw new Error(`Cannot replace Service ${serviceId} while an initialization command is active`);
    const backups = await this.docker.listContainers({ all: true, filters: { label: ['halfcloud.managed=true'] } });
    if (backups.some((candidate) => candidate.Labels?.['halfcloud.managed'] === 'true' && candidate.Labels['halfcloud.service.id'] === serviceId && candidate.Names?.some((value) => replacementName.test(value)))) {
      throw new Error(`Service ${serviceId} already has a pending replacement or cleanup`);
    }
    // Keep existing environment values, even if they match image defaults: they may be intentional secrets or overrides.
    const config: Docker.ContainerCreateOptions = { ...inspection.Config };
    let expectedImageId: string | undefined;
    if (changes.image !== undefined) {
      const nextImage = await this.docker.getImage(changes.image).inspect();
      expectedImageId = nextImage.Id;
      // The original tag may already point at the newly built image.
      const previousImage = await this.docker.getImage(inspection.Image).inspect();
      config.Image = changes.image;
      for (const key of ['Cmd', 'Entrypoint', 'User', 'WorkingDir', 'Healthcheck'] as const) {
        if (isDeepStrictEqual(config[key] ?? null, previousImage.Config[key] ?? null)) {
          Object.assign(config, { [key]: nextImage.Config[key] });
        } else if (key === 'Entrypoint' && !config.Entrypoint?.length) {
          // Docker uses [""] to explicitly disable an image's entrypoint.
          config.Entrypoint = [''];
        }
      }
    }
    if (changes.environment !== undefined) {
      config.Env = Object.entries(changes.environment).map(([key, value]) => `${key}=${value}`);
    }
    const networkName = appNetworkName(appId);
    await createOrReuseAppNetwork(this.docker, appId);
    const hostConfig = { ...inspection.HostConfig };
    // Image-declared and anonymous volumes must reuse their existing data, not allocate fresh volumes.
    for (const mount of inspection.Mounts) {
      if (mount.Type !== 'volume' || !mount.Name) continue;
      const configured = hostConfig.Mounts?.find((candidate) => candidate.Target === mount.Destination);
      if (configured?.Source || hostConfig.Binds?.some((bind) => bind.split(':')[1] === mount.Destination)) continue;
      if (hostConfig.Binds?.includes(mount.Destination)) {
        hostConfig.Binds = hostConfig.Binds.map((bind) => bind === mount.Destination ? `${mount.Name}:${mount.Destination}` : bind);
        continue;
      }
      hostConfig.Mounts = [
        ...(hostConfig.Mounts ?? []).filter((candidate) => candidate.Target !== mount.Destination),
        { ...configured, Type: 'volume', Source: mount.Name, Target: mount.Destination, ReadOnly: !mount.RW },
      ];
    }
    const endpoints: Docker.EndpointsConfig = Object.fromEntries(Object.entries(inspection.NetworkSettings.Networks).map(([network, endpoint]) => [
      network,
      { IPAMConfig: endpoint.IPAMConfig, Links: endpoint.Links, Aliases: endpoint.Aliases, DriverOpts: (endpoint as Docker.EndpointSettings).DriverOpts },
    ]));
    endpoints[networkName] ??= { Aliases: [inspection.Config.Labels?.['halfcloud.service.name'] ?? name] };
    const operations = await this.docker.listContainers({ all: true });
    if (this.initializingServices.has(serviceId) || operations.some((candidate) =>
      isServiceInitializationContainer(candidate, appId, serviceId, name) && !['exited', 'dead'].includes(candidate.State),
    )) throw new Error(`Cannot replace Service ${serviceId} while an initialization command is active`);
    const wasRunning = inspection.State.Running;
    const backupName = `${name}-halfcloud-replacement-v1-${randomUUID()}-${wasRunning ? 'running' : 'stopped'}-pending`;
    if (!replacementName.test(backupName)) throw new Error('Invalid replacement container name');
    let replacement: Docker.Container | undefined;
    try {
      await container.rename({ name: backupName });
      if (wasRunning) await container.stop({ t: 10 });
      replacement = await this.docker.createContainer({
        ...config,
        Labels: { ...config.Labels, [replacementLabel]: backupName },
        name,
        HostConfig: hostConfig,
        NetworkingConfig: { EndpointsConfig: endpoints },
      });
      // Keep the tag for service.image matching, but never start an image if that tag moved during creation.
      if (expectedImageId && (await replacement.inspect()).Image !== expectedImageId) throw new Error('Replacement image tag changed during container creation');
      if (wasRunning) await replacement.start();
      if (changes.environment !== undefined) {
        const appDir = path.join(this.appsDir, appId);
        await writeFile(path.join(appDir, '.env'), `${Object.entries(changes.environment).map(([key, value]) => `${key}=${value.replace(/\n/g, '\\n')}`).join('\n')}${Object.keys(changes.environment).length ? '\n' : ''}`, { mode: 0o600 });
      }
    } catch (error) {
      try {
        await this.finishContainerReplacement(inspection.Id, backupName, 'rollback');
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], `Container replacement failed; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
      throw error;
    }
    let completed: 'commit' | 'rollback' | undefined;
    let busy = false;
    const finish = async (action: 'commit' | 'rollback') => {
      if (busy) throw new Error('Container replacement is already being finalized');
      if (completed === action) return;
      if (completed) throw new Error(`Container replacement already completed: ${completed}`);
      busy = true;
      try {
        await this.finishContainerReplacement(inspection.Id, backupName, action);
        completed = action;
      } finally {
        busy = false;
      }
    };
    return {
      containerId: replacement.id, name, state: wasRunning ? 'running' : 'exited',
      commit: () => finish('commit'),
      rollback: () => finish('rollback'),
    };
  }

  // committedApps must come from durable group decisions. Run at startup, or scope to an App whose updates are locked.
  // Ambiguous recovery errors stay fatal; a specifically missing committed replacement is returned for App-level quarantine.
  async recoverContainerReplacements(committedApps: ReadonlySet<string> = new Set(), appId?: string): Promise<ContainerRecoveryIssue[]> {
    const containers = await this.docker.listContainers({ all: true, filters: { label: [
      'halfcloud.managed=true',
      ...(appId !== undefined ? [`halfcloud.app.id=${appId}`] : []),
    ] } });
    const backups = containers.flatMap((container) => {
      const ownerAppId = container.Labels?.['halfcloud.app.id'];
      if (container.Labels?.['halfcloud.managed'] !== 'true' || (appId !== undefined && ownerAppId !== appId)) return [];
      const name = container.Names?.find((value) => replacementName.test(value));
      return name ? [{ id: container.Id, name: name.replace(/^\//, ''), appId: ownerAppId }] : [];
    });
    const names = backups.map((backup) => replacementName.exec(backup.name)![1]);
    if (new Set(names).size !== names.length) throw new Error('Multiple replacement backups claim the same container name');
    const issues: ContainerRecoveryIssue[] = [];
    for (const backup of backups) {
      const committed = backup.name.endsWith('-committed') || (backup.appId !== undefined && committedApps.has(backup.appId));
      try {
        await this.finishContainerReplacement(backup.id, backup.name, committed ? 'commit' : 'rollback');
      } catch (error) {
        if (error instanceof MissingContainerReplacementError) issues.push(error.issue);
        else throw error;
      }
    }
    return issues;
  }

  async rollbackMissingContainerReplacements(issues: ContainerRecoveryIssue[]): Promise<void> {
    const prepared = [];
    for (const issue of issues) {
      const inspection = await this.docker.getContainer(issue.backupId).inspect();
      const currentName = inspection.Name.replace(/^\//, '');
      const pendingName = issue.backupName.replace(/-committed$/, '-pending');
      const committedName = pendingName.replace(/-pending$/, '-committed');
      const labels = inspection.Config.Labels;
      if (issue.code !== 'missing_replacement' || ![pendingName, committedName].includes(currentName)
        || labels?.['halfcloud.managed'] !== 'true' || labels['halfcloud.app.id'] !== issue.appId
        || labels['halfcloud.service.id'] !== issue.serviceId || replacementName.exec(currentName)?.[1] !== issue.name) {
        throw new Error(`Replacement backup ${issue.backupId} has mismatched identity`);
      }
      const containers = await this.docker.listContainers({ all: true });
      if (containers.some((candidate) => candidate.Id !== issue.backupId
        && !isServiceInitializationContainer(candidate, issue.appId, issue.serviceId, issue.name)
        && (candidate.Names?.includes(`/${issue.name}`) || candidate.Labels?.['halfcloud.service.id'] === issue.serviceId))) {
        throw new Error(`Replacement for ${issue.name} appeared during recovery; refusing rollback`);
      }
      prepared.push({ issue, currentName, pendingName });
    }
    for (const { issue, currentName, pendingName } of prepared) {
      const container = this.docker.getContainer(issue.backupId);
      if (currentName !== pendingName) await container.rename({ name: pendingName });
      await this.finishContainerReplacement(issue.backupId, pendingName, 'rollback');
    }
  }

  private async finishContainerReplacement(id: string, backupName: string, action: 'commit' | 'rollback'): Promise<void> {
    const match = replacementName.exec(backupName);
    if (!match) throw new Error('Invalid replacement backup name');
    const name = match[1]!;
    const wasRunning = match[3] === 'running';
    const pendingName = backupName.replace(/-committed$/, '-pending');
    const committedName = pendingName.replace(/-pending$/, '-committed');
    const container = this.docker.getContainer(id);
    const inspection = await container.inspect().catch((error: { statusCode?: number }) => {
      if (action === 'commit' && error.statusCode === 404) return undefined;
      throw error;
    });
    if (!inspection) return;
    const currentName = inspection.Name.replace(/^\//, '');
    const labels = inspection.Config.Labels;
    if (labels?.['halfcloud.managed'] !== 'true' || !labels['halfcloud.app.id'] || !labels['halfcloud.service.id']
      || ![pendingName, committedName, ...(action === 'rollback' ? [name] : [])].includes(currentName)) {
      throw new Error(`Replacement backup ${id} has mismatched identity`);
    }
    if (action === 'rollback' && currentName === committedName) throw new Error('Cannot roll back a committed container replacement');
    const containers = await this.docker.listContainers({ all: true });
    const candidates = containers.filter((candidate) => candidate.Id !== id
      && !isServiceInitializationContainer(candidate, labels['halfcloud.app.id']!, labels['halfcloud.service.id']!, name)
      && (candidate.Names?.includes(`/${name}`) || candidate.Labels?.['halfcloud.service.id'] === labels['halfcloud.service.id']));
    const replacement = candidates[0];
    if (candidates.length > 1 || (replacement && (
      !replacement.Names?.includes(`/${name}`)
      || replacement.Labels?.['halfcloud.managed'] !== 'true'
      || replacement.Labels['halfcloud.app.id'] !== labels['halfcloud.app.id']
      || replacement.Labels['halfcloud.service.id'] !== labels['halfcloud.service.id']
      || replacement.Labels[replacementLabel] !== pendingName
    ))) throw new Error(`Replacement for ${name} has mismatched identity; refusing recovery`);
    if (action === 'commit') {
      if (!replacement) throw new MissingContainerReplacementError({
        code: 'missing_replacement', appId: labels['halfcloud.app.id'], serviceId: labels['halfcloud.service.id'],
        name, backupId: id, backupName: currentName,
      });
      // Once renamed, a cleanup failure must never turn a successful update into a rollback.
      if (currentName !== committedName) await container.rename({ name: committedName });
      await container.remove({ force: true, v: false });
    } else {
      if (replacement) await this.docker.getContainer(replacement.Id).remove({ force: true, v: false });
      if (wasRunning && !inspection.State.Running) await container.start();
      if (!wasRunning && inspection.State.Running) await container.stop({ t: 10 });
      // Clear the journal last, so a restart during restoration can safely retry it.
      if (currentName !== name) await container.rename({ name });
    }
  }

  async inspectContainer(id: string) {
    const container = await this.managedContainer(id);
    const inspection = await container.inspect();
    const healthcheck = inspection.Config.Healthcheck;
    return {
      id: inspection.Id,
      name: inspection.Config.Labels?.['halfcloud.service.name'] ?? inspection.Name.replace(/^\//, ''),
      appId: inspection.Config.Labels?.['halfcloud.app.id'],
      serviceId: inspection.Config.Labels?.['halfcloud.service.id'],
      image: inspection.Config.Image,
      imageId: inspection.Image,
      state: inspection.State.Status,
      ports: Object.entries(inspection.NetworkSettings.Ports ?? {}).flatMap(([target, bindings]) =>
        (bindings ?? []).map((binding) => ({ target, hostPort: binding.HostPort, hostIp: binding.HostIp }))),
      mounts: inspection.Mounts.map((mount) => ({ type: mount.Type, target: mount.Destination, ...(mount.Name ? { name: mount.Name } : {}) })),
      networks: Object.keys(inspection.NetworkSettings.Networks ?? {}),
      restartPolicy: inspection.HostConfig.RestartPolicy?.Name ?? 'no',
      health: inspection.State.Health?.Status ?? null,
      // Docker stores durations in nanoseconds; zero/omitted values select daemon defaults.
      healthcheck: healthcheck?.Test?.length && healthcheck.Test[0] !== 'NONE' ? {
        intervalMs: (healthcheck.Interval || 30_000_000_000) / 1_000_000,
        startPeriodMs: (healthcheck.StartPeriod || 0) / 1_000_000,
        startIntervalMs: (healthcheck.StartInterval || 5_000_000_000) / 1_000_000,
        retries: healthcheck.Retries || 3,
        timeoutMs: (healthcheck.Timeout || 30_000_000_000) / 1_000_000,
      } : null,
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
      container.Labels?.['halfcloud.managed'] === 'true' && (container.Id === idOrName || (!container.Names?.some((name) => replacementName.test(name)) && (
        container.Id.startsWith(idOrName) || container.Names?.some((name) => name === `/${idOrName}`) || container.Labels?.['halfcloud.service.id'] === idOrName
      ))),
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
