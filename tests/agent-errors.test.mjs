import assert from 'node:assert/strict';
import test from 'node:test';
import { APICallError, RetryError } from 'ai';
import { isProviderRequestError } from '../dist/backend/agent.js';

test('agent error classification does not mistake operation failures for provider failures', () => {
  assert.equal(isProviderRequestError(new Error('Docker image build failed')), false);
});

test('agent error classification recognizes direct and retried provider failures', () => {
  const providerError = new APICallError({
    message: 'Provider unavailable',
    url: 'https://provider.example/v1/chat',
    requestBodyValues: {},
    statusCode: 503,
  });
  const retryError = new RetryError({
    message: 'Failed after retries',
    reason: 'maxRetriesExceeded',
    errors: [providerError],
  });

  assert.equal(isProviderRequestError(providerError), true);
  assert.equal(isProviderRequestError(retryError), true);
});
