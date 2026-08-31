import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const appSchema = z.object({
  id: z.string().startsWith('app_'),
  name: z.string().trim().min(1).max(128),
  createdAt: z.string(),
  updatedAt: z.string(),
  source: z.object({
    type: z.literal('git'),
    url: z.string().url(),
    branch: z.string().min(1).optional(),
    resolvedCommit: z.string().regex(/^[a-f0-9]{40}$/).optional(),
    currentCommit: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  }).optional(),
  deployment: z.object({
    status: z.enum(['in_progress', 'running', 'failed']),
    stage: z.enum(['cloning', 'inspecting', 'planning', 'preparing', 'building', 'deploying', 'initializing', 'verifying', 'running', 'failed']),
    message: z.string().max(500).optional(),
    errorCode: z.enum(['invalid_url', 'not_found', 'not_public', 'dns_failure', 'network_failure', 'clone_failed', 'inspection_failed', 'build_failed', 'deployment_failed', 'initialization_failed', 'verification_failed']).optional(),
    buildAttempts: z.number().int().min(0).optional(),
    initializationAttempts: z.number().int().min(0).optional(),
    image: z.string().max(255).optional(),
    updatedAt: z.string(),
  }).optional(),
});

const documentSchema = z.object({ version: z.literal(1), apps: z.array(appSchema) });
const fileLocks = new Map<string, Promise<void>>();

export type AppRecord = z.infer<typeof appSchema>;

export class AppStore {
  private readonly filePath: string;

  constructor(dataDir = process.env.HALFCLOUD_DATA_DIR ?? `${process.env.HOME ?? '/home/halfcloudrunner'}/.halfcloud/data`) {
    this.filePath = path.join(path.resolve(dataDir), 'apps.json');
  }

  async list() {
    return (await this.read()).apps;
  }

  async create(name: string, metadata: Pick<AppRecord, 'source' | 'deployment'> = {}) {
    return this.mutate(async (document) => {
      const normalized = this.name(name);
      if (document.apps.some((app) => app.name.toLowerCase() === normalized.toLowerCase())) {
        throw new Error(`An App named ${normalized} already exists`);
      }
      const now = new Date().toISOString();
      const app: AppRecord = { id: `app_${randomUUID()}`, name: normalized, createdAt: now, updatedAt: now, ...metadata };
      document.apps.push(app);
      return app;
    });
  }

  async get(idOrName: string) {
    const apps = await this.list();
    const exact = apps.filter((app) => app.id === idOrName || app.name.toLowerCase() === idOrName.trim().toLowerCase());
    const matches = exact.length ? exact : apps.filter((app) => app.id.startsWith(idOrName));
    if (!matches.length) throw new Error(`App ${idOrName} was not found`);
    if (matches.length > 1) throw new Error(`App ${idOrName} is ambiguous; use its full ID`);
    return matches[0]!;
  }

  async renameApp(idOrName: string, name: string) {
    return this.mutate(async (document) => {
      const app = this.find(document.apps, idOrName);
      const normalized = this.name(name);
      if (document.apps.some((candidate) => candidate.id !== app.id && candidate.name.toLowerCase() === normalized.toLowerCase())) {
        throw new Error(`An App named ${normalized} already exists`);
      }
      const updated = { ...app, name: normalized, updatedAt: new Date().toISOString() };
      document.apps = document.apps.map((candidate) => candidate.id === app.id ? updated : candidate);
      return updated;
    });
  }

  async update(idOrName: string, changes: Pick<AppRecord, 'source' | 'deployment'>) {
    return this.mutate(async (document) => {
      const app = this.find(document.apps, idOrName);
      const updated = appSchema.parse({ ...app, ...changes, updatedAt: new Date().toISOString() });
      document.apps = document.apps.map((candidate) => candidate.id === app.id ? updated : candidate);
      return updated;
    });
  }

  async deleteApp(idOrName: string) {
    return this.mutate(async (document) => {
      const app = this.find(document.apps, idOrName);
      document.apps = document.apps.filter((candidate) => candidate.id !== app.id);
      return app;
    });
  }

  private name(value: string) {
    const name = value.trim().replace(/\s+/g, ' ');
    if (!name || name.length > 128) throw new Error('App name must contain 1-128 characters');
    return name;
  }

  private find(apps: AppRecord[], idOrName: string) {
    const exact = apps.filter((app) => app.id === idOrName || app.name.toLowerCase() === idOrName.trim().toLowerCase());
    const matches = exact.length ? exact : apps.filter((app) => app.id.startsWith(idOrName));
    if (!matches.length) throw new Error(`App ${idOrName} was not found`);
    if (matches.length > 1) throw new Error(`App ${idOrName} is ambiguous; use its full ID`);
    return matches[0]!;
  }

  private async read(): Promise<{ version: 1; apps: AppRecord[] }> {
    try {
      return documentSchema.parse(JSON.parse(await readFile(this.filePath, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, apps: [] };
      throw error;
    }
  }

  private async write(document: { version: 1; apps: AppRecord[] }) {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(documentSchema.parse(document), null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.filePath);
  }

  private async mutate<T>(change: (document: { version: 1; apps: AppRecord[] }) => Promise<T>) {
    const previous = fileLocks.get(this.filePath) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    fileLocks.set(this.filePath, queued);
    await previous;
    try {
      const document = await this.read();
      const result = await change(document);
      await this.write(document);
      return result;
    } finally {
      release();
      if (fileLocks.get(this.filePath) === queued) fileLocks.delete(this.filePath);
    }
  }
}
