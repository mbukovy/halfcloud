import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SettingsStore } from '../dist/backend/config.js';
import { listModels, providerMetadata, redactProviderError } from '../dist/backend/llm/index.js';

test('provider metadata contains every supported provider without remote icons', () => {
  assert.deepEqual(providerMetadata.map(({ id }) => id), ['mistral', 'openai', 'anthropic', 'azure-foundry', 'cerebras', 'grok', 'gemini']);
  assert.ok(providerMetadata.every(({ icon }) => icon.startsWith('/providers/')));
  assert.deepEqual(providerMetadata.find(({ id }) => id === 'mistral'), {
    id: 'mistral',
    label: 'Mistral AI',
    icon: '/providers/mistral.svg',
    requiresEndpoint: false,
    recommendedModel: 'mistral-large-latest',
    promotionalText: 'Free API available - use Halfcloud completely free of charge',
    pricingUrl: 'https://mistral.ai/pricing',
  });
});

test('Mistral models are discovered with bearer authentication', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'https://api.mistral.ai/v1/models');
      assert.equal(options.headers.authorization, 'Bearer mistral-secret');
      return Response.json({ data: [{ id: 'mistral-small-latest' }, { id: 'mistral-large-latest' }] });
    };
    assert.deepEqual(await listModels({ provider: 'mistral', apiKey: 'mistral-secret' }), [
      { id: 'mistral-large-latest', name: 'mistral-large-latest' },
      { id: 'mistral-small-latest', name: 'mistral-small-latest' },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('settings public value never returns the API key', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-llm-'));
  try {
    const store = new SettingsStore(directory);
    await store.save({
      provider: 'grok',
      apiKey: 'secret-provider-key',
      model: 'test-model',
      capabilities: { streaming: true, tools: true },
      verifiedAt: new Date().toISOString(),
    });
    const publicValue = await store.publicValue();
    assert.equal(JSON.stringify(publicValue).includes('secret-provider-key'), false);
    assert.equal(publicValue.llmReady, true);
    assert.equal((await stat(path.join(directory, 'settings.json'))).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('legacy Azure settings are migrated in memory to Foundry v1', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfcloud-legacy-'));
  try {
    await writeFile(path.join(directory, 'settings.json'), JSON.stringify({
      provider: 'azure', endpoint: 'https://example.openai.azure.com', apiKey: 'secret', deployment: 'deployment',
    }));
    const value = await new SettingsStore(directory).get();
    assert.equal(value?.provider, 'azure-foundry');
    assert.equal(value?.endpoint, 'https://example.openai.azure.com/openai/v1');
    assert.equal(value?.model, 'deployment');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('provider errors redact credentials', () => {
  assert.equal(redactProviderError(new Error('Bearer top-secret failed for top-secret'), 'top-secret').includes('top-secret'), false);
});
