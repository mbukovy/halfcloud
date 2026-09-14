import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { normalizeHostname } from './domains.js';

const redirectSchema = z.object({
  id: z.string().startsWith('redirect_'),
  hostname: z.string(),
  targetHostname: z.string(),
});
const redirectsSchema = z.array(redirectSchema);

export type RedirectRoute = z.infer<typeof redirectSchema>;

export class RedirectStore {
  private readonly filePath: string;

  constructor(dataDir = process.env.HALFCLOUD_DATA_DIR ?? `${process.env.HOME ?? '/home/halfcloudrunner'}/.halfcloud/data`) {
    this.filePath = path.join(path.resolve(dataDir), 'redirects.json');
  }

  async list(): Promise<RedirectRoute[]> {
    try {
      return this.validate(JSON.parse(await readFile(this.filePath, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async add(hostname: string, targetHostname: string) {
    const source = normalizeHostname(hostname);
    const target = normalizeHostname(targetHostname);
    if (source === target) throw new Error('Redirect source and target must be different');
    const redirects = await this.list();
    if (redirects.some((redirect) => redirect.hostname === source)) throw new Error(`${source} already has a redirect`);
    const redirect = { id: `redirect_${randomUUID()}`, hostname: source, targetHostname: target };
    await this.save([...redirects, redirect]);
    return redirect;
  }

  async remove(hostname: string) {
    const normalized = normalizeHostname(hostname);
    const redirects = await this.list();
    const redirect = redirects.find((candidate) => candidate.hostname === normalized);
    if (!redirect) throw new Error(`Redirect for ${normalized} was not found`);
    await this.save(redirects.filter((candidate) => candidate.hostname !== normalized));
    return redirect;
  }

  async replace(redirects: RedirectRoute[]) {
    await this.save(redirects);
  }

  private validate(value: unknown) {
    const redirects = redirectsSchema.parse(value).map((redirect) => ({
      ...redirect,
      hostname: normalizeHostname(redirect.hostname),
      targetHostname: normalizeHostname(redirect.targetHostname),
    }));
    if (new Set(redirects.map((redirect) => redirect.hostname)).size !== redirects.length) throw new Error('Redirect hostnames must be unique');
    if (redirects.some((redirect) => redirect.hostname === redirect.targetHostname)) throw new Error('Redirect source and target must be different');
    return redirects;
  }

  private async save(redirects: RedirectRoute[]) {
    const validated = this.validate(redirects);
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}
