import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const appSchema = z.object({
  id: z.string().startsWith('app_'),
  name: z.string().trim().min(1).max(128),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const documentSchema = z.object({ version: z.literal(1), apps: z.array(appSchema) });

export type AppRecord = z.infer<typeof appSchema>;

export class AppStore {
  private readonly filePath: string;

  constructor(dataDir = process.env.HALFCLOUD_DATA_DIR ?? `${process.env.HOME ?? '/home/halfcloudrunner'}/.halfcloud/data`) {
    this.filePath = path.join(path.resolve(dataDir), 'apps.json');
  }

  async list() {
    return (await this.read()).apps;
  }

  async create(name: string) {
    const document = await this.read();
    const normalized = this.name(name);
    if (document.apps.some((app) => app.name.toLowerCase() === normalized.toLowerCase())) {
      throw new Error(`An App named ${normalized} already exists`);
    }
    const now = new Date().toISOString();
    const app: AppRecord = { id: `app_${randomUUID()}`, name: normalized, createdAt: now, updatedAt: now };
    document.apps.push(app);
    await this.write(document);
    return app;
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
    const document = await this.read();
    const app = await this.get(idOrName);
    const normalized = this.name(name);
    if (document.apps.some((candidate) => candidate.id !== app.id && candidate.name.toLowerCase() === normalized.toLowerCase())) {
      throw new Error(`An App named ${normalized} already exists`);
    }
    const updated = { ...app, name: normalized, updatedAt: new Date().toISOString() };
    document.apps = document.apps.map((candidate) => candidate.id === app.id ? updated : candidate);
    await this.write(document);
    return updated;
  }

  async deleteApp(idOrName: string) {
    const document = await this.read();
    const app = await this.get(idOrName);
    document.apps = document.apps.filter((candidate) => candidate.id !== app.id);
    await this.write(document);
    return app;
  }

  private name(value: string) {
    const name = value.trim().replace(/\s+/g, ' ');
    if (!name || name.length > 128) throw new Error('App name must contain 1-128 characters');
    return name;
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
}
