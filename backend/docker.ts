import net from 'node:net';
import Docker from 'dockerode';

export type PortMap = Record<string, string>;

export interface CreateContainerInput {
  name: string;
  image: string;
  ports: PortMap;
  environment?: Record<string, string>;
}

interface DockerStats {
  cpu_stats?: { cpu_usage?: { total_usage?: number; percpu_usage?: number[] }; system_cpu_usage?: number; online_cpus?: number };
  precpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number };
  memory_stats?: { usage?: number; limit?: number; stats?: { cache?: number; inactive_file?: number } };
}

export class DockerService {
  private readonly docker = new Docker({ socketPath: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock' });

  async ping() {
    await this.docker.ping();
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
        name: container.Labels?.['halfcloud.name'] ?? container.Names?.[0]?.replace(/^\//, '') ?? container.Id.slice(0, 12),
        image: container.Image,
        state: container.State,
        status: container.Status,
        ports,
        ...stats,
      };
    }));
  }

  async createContainer(input: CreateContainerInput) {
    const name = input.name.trim();
    const image = input.image.trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name)) throw new Error('Invalid container name');
    if (!image || image.length > 255) throw new Error('Invalid image name');

    const existing = await this.docker.listContainers({ all: true, filters: { name: [`^/${name}$`] } });
    if (existing.length) throw new Error(`A Docker container named ${name} already exists`);

    const targetPorts = new Set<string>();
    const normalizedPorts = Object.entries(input.ports).map(([host, target]) => {
      if (!/^\d+$/.test(host) || !/^\d+(\/(tcp|udp))?$/.test(target)) throw new Error(`Invalid port mapping ${host} -> ${target}`);
      const hostPort = Number.parseInt(host, 10);
      const [containerPart, protocol = 'tcp'] = target.split('/');
      const containerPort = Number.parseInt(containerPart ?? '', 10);
      if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535 || !Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535) {
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

    let pulled = false;
    try {
      await this.docker.getImage(image).inspect();
    } catch {
      const stream = await this.docker.pull(image);
      await new Promise<void>((resolve, reject) => {
        this.docker.modem.followProgress(stream, (error) => error ? reject(error) : resolve());
      });
      pulled = true;
    }

    const exposedPorts: Record<string, object> = {};
    const portBindings: Record<string, Array<{ HostIp: string; HostPort: string }>> = {};
    for (const port of normalizedPorts) {
      const key = `${port.containerPort}/${port.protocol}`;
      exposedPorts[key] = {};
      portBindings[key] = [{ HostIp: '0.0.0.0', HostPort: String(port.hostPort) }];
    }

    const container = await this.docker.createContainer({
      name,
      Image: image,
      Env: Object.entries(input.environment ?? {}).map(([key, value]) => `${key}=${value}`),
      Labels: { 'halfcloud.managed': 'true', 'halfcloud.name': name },
      ExposedPorts: exposedPorts,
      HostConfig: {
        PortBindings: portBindings,
        RestartPolicy: { Name: 'unless-stopped' },
        LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
        SecurityOpt: ['no-new-privileges'],
        PidsLimit: 512,
      },
    });
    try {
      await container.start();
      const inspection = await container.inspect();
      return {
        id: inspection.Id,
        name,
        image,
        running: inspection.State.Running,
        ports: input.ports,
        steps: ['Checked published ports', pulled ? `Pulled ${image}` : `Found ${image} locally`, 'Created container', 'Started container'],
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

  async deleteContainer(id: string) {
    const container = await this.managedContainer(id);
    const inspection = await container.inspect();
    await container.remove({ force: inspection.State.Running, v: false });
    return { containerId: container.id, deleted: true, imageRemoved: false };
  }

  async getContainerLogs(id: string, tail = 200) {
    const container = await this.managedContainer(id);
    const output = await container.logs({ stdout: true, stderr: true, timestamps: true, tail: Math.min(Math.max(tail, 1), 1000) });
    return { containerId: container.id, logs: this.cleanDockerLog(Buffer.isBuffer(output) ? output : Buffer.from(String(output))) };
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
      container.Id === idOrName || container.Id.startsWith(idOrName) || container.Names?.some((name) => name === `/${idOrName}`) || container.Labels?.['halfcloud.name'] === idOrName,
    );
    if (!matches.length) throw new Error(`Managed container ${idOrName} was not found`);
    if (matches.length > 1) throw new Error(`Container id ${idOrName} is ambiguous; use the exact name or full id`);
    return this.docker.getContainer(matches[0]!.Id);
  }

  private async portConflict(port: number) {
    const containers = await this.docker.listContainers({ all: true });
    const owner = containers.find((container) => container.Ports?.some((binding) => binding.PublicPort === port));
    if (owner) return `container ${owner.Names?.[0]?.replace(/^\//, '') ?? owner.Id.slice(0, 12)}`;
    const free = await new Promise<boolean>((resolve) => {
      const server = net.createServer().unref();
      server.once('error', () => resolve(false));
      server.listen(port, '0.0.0.0', () => server.close(() => resolve(true)));
    });
    return free ? null : 'another host process';
  }

  private async nextAvailablePort(start: number) {
    for (let port = Math.max(start, 1024); port <= 65535; port += 1) {
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
