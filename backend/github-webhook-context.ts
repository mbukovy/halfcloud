import type { UIMessage } from 'ai';
import { z } from 'zod';

const setupSchema = z.object({
  kind: z.literal('github-webhook'),
  appId: z.string().min(1).max(128),
  hookId: z.string().regex(/^[a-f0-9]{64}$/),
  repository: z.string().max(140),
  branch: z.string().max(255),
  payloadUrl: z.string().url().max(500),
  settingsUrl: z.string().url().max(500),
  enabled: z.boolean(),
  verified: z.boolean(),
  lastDeliveryAt: z.iso.datetime().optional(),
  lastEvent: z.string().regex(/^[a-z_]{1,64}$/).optional(),
  lastUpdate: z.object({
    status: z.enum(['queued', 'running', 'succeeded', 'failed', 'interrupted']),
    updatedAt: z.iso.datetime(),
    commit: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/).optional(),
    message: z.enum(['Automatic update failed; inspect the App', 'Automatic update interrupted; inspect the App']).optional(),
  }).optional(),
});

// Apply at storage and provider boundaries too: widget secrets never belong in tool context.
export function sanitizeGitHubWebhookMessages(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) => {
      if (!part || typeof part !== 'object') return part;
      const record = part as unknown as Record<string, unknown>;
      const type = typeof record.type === 'string' ? record.type : '';
      const name = type === 'dynamic-tool' ? record.toolName : type.startsWith('tool-') ? type.slice(5) : undefined;
      if (name !== 'requestGitHubWebhookSetup' && name !== 'getGitHubWebhookSetup') return part;
      const input = record.input as Record<string, unknown> | undefined;
      const output = setupSchema.safeParse(record.output);
      return {
        type,
        ...(type === 'dynamic-tool' ? { toolName: name } : {}),
        ...(typeof record.toolCallId === 'string' ? { toolCallId: record.toolCallId } : {}),
        ...(typeof record.state === 'string' ? { state: record.state } : {}),
        input: typeof input?.appId === 'string' ? { appId: input.appId } : {},
        ...(output.success ? { output: output.data } : {}),
        ...(record.state === 'output-error' ? { errorText: 'GitHub webhook setup could not be completed' } : {}),
      } as unknown as typeof part;
    }),
  }));
}
