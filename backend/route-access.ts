import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const requestSchema = z.object({
  id: z.string().startsWith('authreq_'),
  routeId: z.string().startsWith('route_'),
  operation: z.enum(['setup', 'change']),
  status: z.enum(['pending', 'completed', 'cancelled']),
});

export type BasicAuthRequest = z.infer<typeof requestSchema>;

export function assertBasicAuthUsername(username: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/.test(username)) {
    throw new Error('Username must use only letters, numbers, dots, underscores, @, or hyphens');
  }
}

export function assertBasicAuthPassword(password: string) {
  if (password.length < 8) throw new Error('Password must be at least 8 characters');
  if (password.length > 1024) throw new Error('Password must be at most 1024 characters');
}

export function hashBasicAuthPassword(password: string): Promise<string> {
  assertBasicAuthPassword(password);
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.CADDY_BINARY ?? 'caddy', ['hash-password', '--algorithm', 'argon2id'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
    child.stderr.resume();
    child.stdin.on('error', () => undefined);
    child.once('error', () => reject(new Error('Password hashing is unavailable')));
    child.once('close', (code) => {
      const hash = output.trim();
      if (code !== 0 || !hash.startsWith('$argon2id$')) {
        reject(new Error('Password hashing failed'));
        return;
      }
      resolve(hash);
    });
    child.stdin.end(`${password}\n`);
  });
}

export class RouteAccessRequestStore {
  private readonly appsDir: string;

  constructor(appsDir = process.env.HALFCLOUD_APPS_DIR ?? `${process.env.HOME ?? '/home/halfcloudrunner'}/.halfcloud/apps`) {
    this.appsDir = path.resolve(appsDir);
  }

  async create(serviceId: string, routeId: string, operation: BasicAuthRequest['operation']) {
    const requests = await this.read(serviceId);
    const existing = requests.find((request) => request.routeId === routeId && request.operation === operation && request.status === 'pending');
    if (existing) return existing;
    const request: BasicAuthRequest = { id: `authreq_${randomUUID()}`, routeId, operation, status: 'pending' };
    await this.write(serviceId, [...requests, request]);
    return request;
  }

  async get(serviceId: string, requestId: string) {
    const request = (await this.read(serviceId)).find((candidate) => candidate.id === requestId);
    if (!request) throw new Error(`Basic Auth request ${requestId} was not found`);
    return request;
  }

  async complete(serviceId: string, requestId: string) {
    const requests = await this.read(serviceId);
    const index = requests.findIndex((request) => request.id === requestId);
    if (index < 0) throw new Error(`Basic Auth request ${requestId} was not found`);
    requests[index] = { ...requests[index]!, status: 'completed' };
    await this.write(serviceId, requests);
    return requests[index]!;
  }

  private file(serviceId: string) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(serviceId)) throw new Error('Invalid application name');
    return path.join(this.appsDir, serviceId, 'route-access-requests.json');
  }

  private async read(serviceId: string): Promise<BasicAuthRequest[]> {
    try {
      return z.array(requestSchema).parse(JSON.parse(await readFile(this.file(serviceId), 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return [];
    }
  }

  private async write(serviceId: string, requests: BasicAuthRequest[]) {
    const file = this.file(serviceId);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(requests, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  }
}
