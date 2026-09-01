import { createAnthropic } from '@ai-sdk/anthropic';
import { createAzure } from '@ai-sdk/azure';
import { createCerebras } from '@ai-sdk/cerebras';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createMistral } from '@ai-sdk/mistral';
import { createOpenAI } from '@ai-sdk/openai';
import { createXai } from '@ai-sdk/xai';
import { streamText, tool, type LanguageModel } from 'ai';
import { z } from 'zod';
import type { LlmCredentials, LlmProvider, LlmProviderConfig, ModelCapabilities, ModelInfo, ProviderMetadata } from './types.js';

export const providerMetadata: ProviderMetadata[] = [
  {
    id: 'mistral',
    label: 'Mistral AI',
    icon: '/providers/mistral.svg',
    requiresEndpoint: false,
    recommendedModel: 'mistral-large-latest',
    promotionalText: 'Free API available - use Halfcloud completely free of charge',
    pricingUrl: 'https://mistral.ai/pricing',
  },
  { id: 'openai', label: 'OpenAI', icon: '/providers/openai.png', requiresEndpoint: false, recommendedModel: 'gpt-5.4-mini' },
  { id: 'anthropic', label: 'Anthropic', icon: '/providers/anthropic.svg', requiresEndpoint: false, recommendedModel: 'claude-sonnet-4-5' },
  { id: 'azure-foundry', label: 'Azure Foundry', icon: '/providers/azure-foundry.png', requiresEndpoint: true },
  { id: 'cerebras', label: 'Cerebras', icon: '/providers/cerebras.png', requiresEndpoint: false, recommendedModel: 'gpt-oss-120b' },
  { id: 'grok', label: 'Grok', icon: '/providers/grok.svg', requiresEndpoint: false, recommendedModel: 'grok-latest' },
  { id: 'gemini', label: 'Google Gemini', icon: '/providers/gemini.png', requiresEndpoint: false, recommendedModel: 'gemini-2.5-flash' },
];

const fallbackModels: Record<LlmProvider, string[]> = {
  openai: [], anthropic: [], 'azure-foundry': [], cerebras: [], grok: [], gemini: [], mistral: [],
};

function azureBaseUrl(endpointValue: string) {
  const endpoint = new URL(endpointValue);
  const path = endpoint.pathname.replace(/\/+$/, '');
  if (!['/openai/v1', '/openai/v1/models'].includes(path)) {
    throw new Error(`Could not connect to this Azure Foundry endpoint. Expected an OpenAI v1 endpoint such as https://<resource>.openai.azure.com/openai/v1/`);
  }
  return `${endpoint.origin}/openai/v1`;
}

// Kept as a public compatibility shim for existing integrations; runtime model creation uses the v1 path above.
export function legacyAzureProviderOptions(settings: { endpoint: string; apiKey: string }) {
  const endpoint = new URL(settings.endpoint);
  const endpointPath = endpoint.pathname.replace(/\/+$/, '');
  const resourceMatch = endpoint.hostname.match(/^([^.]+)\.openai\.azure\.com$/);
  if (resourceMatch) return { resourceName: resourceMatch[1], apiKey: settings.apiKey };
  if (endpoint.hostname.endsWith('.services.ai.azure.com')) return { baseURL: `${endpoint.origin}/openai/v1`, apiKey: settings.apiKey };
  const basePath = endpointPath.replace(/\/v1$/, '');
  return { baseURL: `${endpoint.origin}${basePath.endsWith('/openai') ? basePath : `${basePath}/openai`}`, apiKey: settings.apiKey };
}

function modelEndpoint(credentials: LlmCredentials) {
  switch (credentials.provider) {
    case 'openai': return { url: 'https://api.openai.com/v1/models', headers: { authorization: `Bearer ${credentials.apiKey}` } };
    case 'anthropic': return { url: 'https://api.anthropic.com/v1/models', headers: { 'x-api-key': credentials.apiKey, 'anthropic-version': '2023-06-01' } };
    case 'azure-foundry': return { url: `${azureBaseUrl(credentials.endpoint!)}/models`, headers: { 'api-key': credentials.apiKey } };
    case 'cerebras': return { url: 'https://api.cerebras.ai/v1/models', headers: { authorization: `Bearer ${credentials.apiKey}` } };
    case 'grok': return { url: 'https://api.x.ai/v1/models', headers: { authorization: `Bearer ${credentials.apiKey}` } };
    case 'gemini': return { url: 'https://generativelanguage.googleapis.com/v1beta/models', headers: { 'x-goog-api-key': credentials.apiKey } };
    case 'mistral': return { url: 'https://api.mistral.ai/v1/models', headers: { authorization: `Bearer ${credentials.apiKey}` } };
  }
}

export function createLanguageModel(config: LlmProviderConfig | (LlmCredentials & { model: string })): LanguageModel {
  switch (config.provider) {
    case 'openai': return createOpenAI({ apiKey: config.apiKey }).responses(config.model);
    case 'anthropic': return createAnthropic({ apiKey: config.apiKey })(config.model);
    case 'azure-foundry': return createAzure({ apiKey: config.apiKey, baseURL: azureBaseUrl(config.endpoint!) }).responses(config.model);
    case 'cerebras': return createCerebras({ apiKey: config.apiKey })(config.model);
    case 'grok': return createXai({ apiKey: config.apiKey })(config.model);
    case 'gemini': return createGoogleGenerativeAI({ apiKey: config.apiKey })(config.model);
    case 'mistral': return createMistral({ apiKey: config.apiKey })(config.model);
  }
}

function providerError(error: unknown) {
  const status = typeof error === 'object' && error !== null && 'statusCode' in error ? Number(error.statusCode) : undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (status === 401 || status === 403 || /unauthorized|invalid api key|authentication/i.test(message)) return new Error('Authentication failed. Check your API key and try again.');
  if (status === 404 || /model.*not found|unknown model/i.test(message)) return new Error('The selected model is not available for this provider.');
  if (status === 429 || /rate.?limit/i.test(message)) return new Error('The provider accepted your credentials but the request was rate-limited. Your configuration appears valid.');
  return new Error('Could not connect to the provider. Check the configuration and try again.');
}

export async function listModels(credentials: LlmCredentials): Promise<ModelInfo[]> {
  const request = modelEndpoint(credentials);
  let response: Response;
  try {
    response = await fetch(request.url, { headers: request.headers, signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    if (credentials.provider === 'azure-foundry' && error instanceof Error) throw error;
    throw new Error('Could not reach the provider. Check the connection and try again.');
  }
  if (!response.ok) {
    const error = Object.assign(new Error(await response.text()), { statusCode: response.status });
    throw providerError(error);
  }
  const body = await response.json() as { data?: Array<{ id?: string; display_name?: string }>; models?: Array<{ name?: string; displayName?: string; supportedGenerationMethods?: string[] }> };
  const discovered = credentials.provider === 'gemini'
    ? (body.models ?? []).filter((model) => model.supportedGenerationMethods?.includes('generateContent')).map((model) => ({ id: (model.name ?? '').replace(/^models\//, ''), name: model.displayName ?? model.name ?? '' }))
    : (body.data ?? []).map((model) => ({ id: model.id ?? '', name: model.display_name ?? model.id ?? '' }));
  const models = discovered.filter((model) => model.id);
  return (models.length ? models : fallbackModels[credentials.provider].map((id) => ({ id, name: id }))).sort((a, b) => a.id.localeCompare(b.id));
}

export async function testModel(credentials: LlmCredentials, model: string): Promise<ModelCapabilities> {
  try {
    const result = streamText({
      model: createLanguageModel({ ...credentials, model }),
      prompt: 'Call the compatibility tool once with status set to "ok". Do not write any text.',
      tools: { compatibility: tool({ description: 'HalfCloud compatibility check', inputSchema: z.object({ status: z.string() }) }) },
      toolChoice: { type: 'tool', toolName: 'compatibility' },
      // Reasoning models can consume the initial output budget before emitting their tool call.
      maxOutputTokens: 256,
    });
    let called = false;
    for await (const part of result.fullStream) if (part.type === 'tool-call' && part.toolName === 'compatibility') called = true;
    if (!called) throw new Error('tool calling unavailable');
    return { streaming: true, tools: true };
  } catch (error) {
    if (error instanceof Error && error.message === 'tool calling unavailable') {
      throw new Error('This model does not support the capabilities required by the HalfCloud agent. Please select another model.');
    }
    throw providerError(error);
  }
}

export function redactProviderError(error: unknown, apiKey: string) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(apiKey, '[REDACTED]').replace(/Bearer\s+[^\s,"'}]+/gi, 'Bearer [REDACTED]').slice(0, 2000);
}
