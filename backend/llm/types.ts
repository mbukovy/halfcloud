import { z } from 'zod';

export const llmProviders = ['openai', 'anthropic', 'azure-foundry', 'cerebras', 'grok', 'gemini', 'groq'] as const;
export const llmProviderSchema = z.enum(llmProviders);
export type LlmProvider = z.infer<typeof llmProviderSchema>;

export interface ModelInfo {
  id: string;
  name: string;
}

export interface ModelCapabilities {
  streaming: boolean;
  tools: boolean;
  vision?: boolean;
  reasoning?: boolean;
}

export const credentialsSchema = z.object({
  provider: llmProviderSchema,
  apiKey: z.string().min(1, 'API key is required'),
  endpoint: z.string().url().optional(),
}).superRefine((value, context) => {
  if (value.provider === 'azure-foundry' && !value.endpoint) {
    context.addIssue({ code: 'custom', path: ['endpoint'], message: 'Azure Foundry endpoint is required' });
  }
  if (value.endpoint && !value.endpoint.startsWith('https://')) {
    context.addIssue({ code: 'custom', path: ['endpoint'], message: 'Endpoint must use HTTPS' });
  }
});

export const llmConfigurationSchema = z.object({
  provider: llmProviderSchema,
  apiKey: z.string().min(1),
  endpoint: z.string().url().optional(),
  model: z.string().min(1),
  capabilities: z.object({ streaming: z.boolean(), tools: z.boolean(), vision: z.boolean().optional(), reasoning: z.boolean().optional() }),
  verifiedAt: z.iso.datetime(),
}).superRefine((value, context) => {
  if (value.provider === 'azure-foundry' && !value.endpoint) context.addIssue({ code: 'custom', path: ['endpoint'], message: 'Azure Foundry endpoint is required' });
});

export type LlmCredentials = z.infer<typeof credentialsSchema>;
export type LlmProviderConfig = z.infer<typeof llmConfigurationSchema>;

export interface PublicLlmSettings {
  configured: boolean;
  providerConfigured: boolean;
  llmReady: boolean;
  provider?: LlmProvider;
  model?: string;
  endpoint?: string;
  hasApiKey: boolean;
  capabilities?: ModelCapabilities;
  verifiedAt?: string;
}

export interface ProviderMetadata {
  id: LlmProvider;
  label: string;
  icon: string;
  requiresEndpoint: boolean;
  recommendedModel?: string;
  promotionalText?: string;
  pricingUrl?: string;
}
