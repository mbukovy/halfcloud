import test from 'node:test';
import assert from 'node:assert/strict';
import { azureProviderOptions } from '../dist/backend/agent.js';

const settings = (endpoint) => ({
  provider: 'azure',
  endpoint,
  apiKey: 'test-key',
  deployment: 'test-deployment',
});

test('normalizes an Azure AI Foundry resource endpoint', () => {
  assert.deepEqual(azureProviderOptions(settings('https://michal-swe.services.ai.azure.com')), {
    baseURL: 'https://michal-swe.services.ai.azure.com/openai/v1',
    apiKey: 'test-key',
  });
});

test('normalizes a full Azure AI Foundry responses endpoint', () => {
  assert.deepEqual(azureProviderOptions(settings('https://michal-swe.services.ai.azure.com/openai/v1/responses')), {
    baseURL: 'https://michal-swe.services.ai.azure.com/openai/v1',
    apiKey: 'test-key',
  });
});

test('keeps classic Azure OpenAI resource endpoints deployment-aware', () => {
  assert.deepEqual(azureProviderOptions(settings('https://example.openai.azure.com/openai/v1')), {
    resourceName: 'example',
    apiKey: 'test-key',
  });
});
