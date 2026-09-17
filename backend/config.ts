import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { llmConfigurationSchema, llmProviders, type LlmProviderConfig, type PublicLlmSettings } from './llm/types.js';

const legacySettingsSchema = z.object({
  provider: z.literal('azure'),
  endpoint: z.string().url(),
  apiKey: z.string().min(1),
  deployment: z.string().min(1),
});

const instanceSettingsSchema = z.object({ name: z.string().trim().min(1).max(64) });

export type AiSettings = LlmProviderConfig;

export class SettingsStore {
  readonly dataDir: string;
  private readonly settingsPath: string;
  private readonly instanceSettingsPath: string;

  constructor(dataDir = process.env.HALFCLOUD_DATA_DIR ?? `${process.env.HOME ?? '/home/halfcloudrunner'}/.halfcloud/data`) {
    this.dataDir = dataDir;
    this.settingsPath = path.join(dataDir, 'settings.json');
    this.instanceSettingsPath = path.join(dataDir, 'instance.json');
  }

  async get(): Promise<LlmProviderConfig | null> {
    try {
      const value: unknown = JSON.parse(await readFile(this.settingsPath, 'utf8'));
      const legacy = legacySettingsSchema.safeParse(value);
      if (legacy.success) {
        const endpoint = new URL(legacy.data.endpoint);
        return llmConfigurationSchema.parse({
          provider: 'azure-foundry',
          endpoint: `${endpoint.origin}/openai/v1`,
          apiKey: legacy.data.apiKey,
          model: legacy.data.deployment,
          capabilities: { streaming: true, tools: true },
          verifiedAt: new Date(0).toISOString(),
        });
      }
      const settings = llmConfigurationSchema.safeParse(value);
      if (settings.success) return settings.data;
      if (
        typeof value === 'object'
        && value !== null
        && 'provider' in value
        && typeof value.provider === 'string'
        && !llmProviders.some((provider) => provider === value.provider)
      ) return null;
      throw settings.error;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async publicValue(): Promise<PublicLlmSettings> {
    const settings = await this.get();
    return settings
      ? {
          configured: true,
          providerConfigured: true,
          llmReady: true,
          provider: settings.provider,
          model: settings.model,
          endpoint: settings.endpoint,
          hasApiKey: true,
          capabilities: settings.capabilities,
          verifiedAt: settings.verifiedAt,
        }
      : { configured: false, providerConfigured: false, llmReady: false, hasApiKey: false };
  }

  async save(value: unknown) {
    const settings = llmConfigurationSchema.parse(value);
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.settingsPath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.settingsPath);
    return this.publicValue();
  }

  async getInstance() {
    try {
      return instanceSettingsSchema.parse(JSON.parse(await readFile(this.instanceSettingsPath, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { name: 'My server' };
      throw error;
    }
  }

  async saveInstance(value: unknown) {
    const instance = instanceSettingsSchema.parse(value);
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.instanceSettingsPath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(instance, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.instanceSettingsPath);
    return instance;
  }
}
