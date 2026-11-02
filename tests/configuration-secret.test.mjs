import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationService } from '../dist/backend/applications.js';

test('Garage RPC secrets are generated as 32-byte hex values and remain protected from AI', async () => {
  const service = Object.create(ApplicationService.prototype);
  service.listEnvironment = async () => [];
  service.requestEnvironmentVariable = async () => ({ requestId: 'request' });
  let saved;
  service.completeEnvironmentRequest = async (id, requestId, value, protectedFromAI) => {
    saved = { value, protectedFromAI };
    return { configured: true };
  };
  const result = await service.generateEnvironmentSecret('garage', 'GARAGE_RPC_SECRET', [], 32, false, 'hex');
  assert.match(saved.value, /^[a-f0-9]{64}$/);
  assert.equal(saved.protectedFromAI, true);
  assert.ok(!JSON.stringify(result).includes(saved.value));
  await assert.rejects(service.generateEnvironmentSecret('garage', 'GARAGE_RPC_SECRET', [], 32, false, 'invalid'), /encoding/);
  service.listEnvironment = async () => [{ name: 'GARAGE_RPC_SECRET' }];
  await assert.rejects(service.generateEnvironmentSecret('garage', 'GARAGE_RPC_SECRET', [], 32, false, 'hex'), /already configured/);
});
