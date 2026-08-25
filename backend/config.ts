import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const settingsSchema = z.object({
  provider: z.literal('azure'),
  endpoint: z.string().url().refine((value) => value.startsWith('https://'), 'Endpoint must use HTTPS'),
  apiKey: z.string().min(1),
  deployment: z.string().min(1),
});

export type AiSettings = z.infer<typeof settingsSchema>;

export class SettingsStore {
  readonly dataDir: string;
  private readonly settingsPath: string;

  constructor(dataDir = process.env.HALFCLOUD_DATA_DIR ?? '/opt/halfcloud/data') {
    this.dataDir = dataDir;
    this.settingsPath = path.join(dataDir, 'settings.json');
  }

  async get(): Promise<AiSettings | null> {
    try {
      return settingsSchema.parse(JSON.parse(await readFile(this.settingsPath, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async publicValue() {
    const settings = await this.get();
    return settings
      ? { configured: true, provider: settings.provider, endpoint: settings.endpoint, deployment: settings.deployment }
      : { configured: false, provider: 'azure' as const, endpoint: '', deployment: 'gpt-5.6-sol' };
  }

  async save(value: unknown) {
    const settings = settingsSchema.parse(value);
    settings.endpoint = settings.endpoint.replace(/\/+$/, '');
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.settingsPath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.settingsPath);
    return this.publicValue();
  }
}
