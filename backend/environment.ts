import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface EnvironmentVariable {
  id: string;
  serviceId: string;
  name: string;
  value: string;
  protectedFromAI: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface EnvironmentRequest {
  id: string;
  serviceId: string;
  name: string;
  description?: string;
  status: 'pending' | 'completed' | 'cancelled';
}

export type AgentEnvironmentVariable =
  | { name: string; configured: true; protectedFromAI: true }
  | { name: string; value: string; protectedFromAI: false };

interface EnvironmentDocument {
  version: 1;
  variables: EnvironmentVariable[];
  requests: EnvironmentRequest[];
}

const variableNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const serviceNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

export function assertEnvironmentVariableName(name: string) {
  if (!variableNamePattern.test(name)) throw new Error(`Invalid environment variable name ${name}`);
}

export function serializeEnvironmentForAgent(variables: EnvironmentVariable[]): AgentEnvironmentVariable[] {
  return variables.map((variable) => variable.protectedFromAI
    ? { name: variable.name, configured: true, protectedFromAI: true }
    : { name: variable.name, value: variable.value, protectedFromAI: false });
}

export class EnvironmentStore {
  private readonly appsDir: string;

  constructor(appsDir = process.env.HALFCLOUD_APPS_DIR ?? `${process.env.HOME ?? '/home/halfcloudrunner'}/.halfcloud/apps`) {
    this.appsDir = path.resolve(appsDir);
  }

  async list(serviceId: string, runtimeEnvironment?: Record<string, string>) {
    const document = await this.read(serviceId);
    if (!runtimeEnvironment) return document.variables;

    const now = new Date().toISOString();
    const existing = new Map(document.variables.map((variable) => [variable.name, variable]));
    const variables = Object.entries(runtimeEnvironment).map(([name, value]) => {
      const variable = existing.get(name);
      return variable
        ? { ...variable, serviceId, value, updatedAt: variable.value === value ? variable.updatedAt : now }
        : { id: `env_${randomUUID()}`, serviceId, name, value, protectedFromAI: true, createdAt: now, updatedAt: now };
    });
    if (JSON.stringify(variables) !== JSON.stringify(document.variables)) await this.write(serviceId, { ...document, variables });
    return variables;
  }

  async replaceVariables(serviceId: string, variables: EnvironmentVariable[]) {
    const document = await this.read(serviceId);
    await this.write(serviceId, { ...document, variables });
  }

  async initialize(serviceId: string, environment: Record<string, string>, protectedFromAI: boolean) {
    const document = await this.read(serviceId);
    const now = new Date().toISOString();
    document.variables = Object.entries(environment).map(([name, value]) => ({
      id: `env_${randomUUID()}`,
      serviceId,
      name,
      value,
      protectedFromAI,
      createdAt: now,
      updatedAt: now,
    }));
    await this.write(serviceId, document);
    return document.variables;
  }

  async createRequest(serviceId: string, name: string, description?: string) {
    assertEnvironmentVariableName(name);
    const document = await this.read(serviceId);
    const existing = document.requests.find((request) => request.name === name && request.status === 'pending');
    if (existing) return existing;
    const request: EnvironmentRequest = {
      id: `envreq_${randomUUID()}`,
      serviceId,
      name,
      ...(description?.trim() ? { description: description.trim() } : {}),
      status: 'pending',
    };
    document.requests.push(request);
    await this.write(serviceId, document);
    return request;
  }

  async getRequest(serviceId: string, requestId: string) {
    const request = (await this.read(serviceId)).requests.find((candidate) => candidate.id === requestId);
    if (!request) throw new Error(`Environment request ${requestId} was not found`);
    return request;
  }

  async setRequestStatus(serviceId: string, requestId: string, status: EnvironmentRequest['status']) {
    const document = await this.read(serviceId);
    const index = document.requests.findIndex((request) => request.id === requestId);
    if (index < 0) throw new Error(`Environment request ${requestId} was not found`);
    document.requests[index] = { ...document.requests[index]!, status };
    await this.write(serviceId, document);
    return document.requests[index]!;
  }

  private file(serviceId: string) {
    if (!serviceNamePattern.test(serviceId)) throw new Error('Invalid application name');
    return path.join(this.appsDir, serviceId, 'environment.json');
  }

  private async read(serviceId: string): Promise<EnvironmentDocument> {
    try {
      const parsed = JSON.parse(await readFile(this.file(serviceId), 'utf8')) as Partial<EnvironmentDocument>;
      return {
        version: 1,
        variables: Array.isArray(parsed.variables) ? parsed.variables : [],
        requests: Array.isArray(parsed.requests) ? parsed.requests : [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { version: 1, variables: [], requests: [] };
    }
  }

  private async write(serviceId: string, document: EnvironmentDocument) {
    const file = this.file(serviceId);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  }
}
