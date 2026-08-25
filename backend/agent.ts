import { createAzure } from '@ai-sdk/azure';
import { ToolLoopAgent, createAgentUIStreamResponse, tool, type UIMessage } from 'ai';
import { z } from 'zod';
import type { AiSettings } from './config.js';
import type { DockerService } from './docker.js';
import { getServerStats } from './metrics.js';

const SYSTEM_PROMPT = `You are HalfCloud, the operator of a real VPS. Docker tool calls affect the real machine.

Rules:
- Inspect current Docker state before making assumptions. Prefer the provided tools over instructions involving Docker CLI.
- Only modify containers carrying the HalfCloud managed label. The tools enforce this boundary.
- Before creating a container, list containers to understand names and published ports. createContainer performs the final port check.
- Choose a sensible short container name when intent is clear. Use official images and explicit image tags (usually :latest) unless the user names another image.
- For common web images, infer their standard internal port. The ports object maps host port strings to container port strings.
- Never stop or delete a different container to resolve a port conflict. Offer the available port reported by the tool and ask the user before changing their requested port.
- Deletion is destructive. First explain that the container will be permanently removed while its image remains, put its exact HalfCloud name in backticks, and ask for confirmation. Only call deleteContainer with that exact name after the user explicitly confirms in a later message, and set confirmed=true.
- Start, stop, restart, create, logs, stats, and listing do not need confirmation when the user's intent is clear.
- Explain important failures plainly. Never expose API keys or claim success unless the tool result confirms it.
- Keep responses concise and operational. After creating a container, state its name and published host port.`;

function textOf(message: UIMessage) {
  return message.parts.filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text').map((part) => part.text).join(' ');
}

function deletionConfirmed(messages: UIMessage[]) {
  const lastUserIndex = messages.findLastIndex((message) => message.role === 'user');
  if (lastUserIndex < 1) return false;
  const text = textOf(messages[lastUserIndex]!).trim().toLowerCase();
  const priorAssistant = [...messages.slice(0, lastUserIndex)].reverse().find((message) => message.role === 'assistant');
  const confirmationWasRequested = priorAssistant && /delet|permanent|confirm/i.test(textOf(priorAssistant));
  return Boolean(confirmationWasRequested && /^(yes|y|confirm|confirmed|do it|delete it|go ahead|please delete|yes,? delete)([.! ]|$)/.test(text));
}

export async function createChatResponse(
  settings: AiSettings,
  docker: DockerService,
  messages: UIMessage[],
  abortSignal?: AbortSignal,
) {
  const azureEndpoint = new URL(settings.endpoint);
  const resourceMatch = azureEndpoint.pathname === '/' && azureEndpoint.hostname.match(/^([^.]+)\.openai\.azure\.com$/);
  const endpointPath = azureEndpoint.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
  const azureBaseUrl = `${azureEndpoint.origin}${endpointPath.endsWith('/openai') ? endpointPath : `${endpointPath}/openai`}`;
  const provider = createAzure({
    ...(resourceMatch ? { resourceName: resourceMatch[1] } : { baseURL: azureBaseUrl }),
    apiKey: settings.apiKey,
  });
  const mayDelete = deletionConfirmed(messages);
  const containerId = z.string().min(1).describe('Container id or exact HalfCloud name');

  const tools = {
    listContainers: tool({
      description: 'List every HalfCloud-managed container, including current status, ports, CPU, and memory.',
      inputSchema: z.object({}),
      execute: () => docker.listContainers(),
    }),
    createContainer: tool({
      description: 'Pull if needed, create, label, publish ports, start, and verify a new HalfCloud container.',
      inputSchema: z.object({
        name: z.string().min(1),
        image: z.string().min(1),
        ports: z.record(z.string(), z.string()).describe('Map of host port to container port, e.g. {"8080":"80"}'),
        environment: z.record(z.string(), z.string()).optional(),
      }),
      execute: (input) => docker.createContainer(input),
    }),
    startContainer: tool({
      description: 'Start a stopped HalfCloud-managed container.',
      inputSchema: z.object({ containerId }),
      execute: ({ containerId }) => docker.startContainer(containerId),
    }),
    stopContainer: tool({
      description: 'Gracefully stop a running HalfCloud-managed container.',
      inputSchema: z.object({ containerId }),
      execute: ({ containerId }) => docker.stopContainer(containerId),
    }),
    restartContainer: tool({
      description: 'Restart a HalfCloud-managed container.',
      inputSchema: z.object({ containerId }),
      execute: ({ containerId }) => docker.restartContainer(containerId),
    }),
    deleteContainer: tool({
      description: 'Permanently delete a HalfCloud-managed container, but not its image. Requires explicit confirmation from the user in a later message.',
      inputSchema: z.object({ containerId, confirmed: z.literal(true) }),
      execute: ({ containerId }) => {
        if (!mayDelete) throw new Error('Deletion blocked: ask the user for explicit confirmation, then wait for their next message.');
        return docker.deleteContainer(containerId);
      },
    }),
    getContainerLogs: tool({
      description: 'Get recent raw stdout/stderr logs for a HalfCloud-managed container.',
      inputSchema: z.object({ containerId, tail: z.number().int().min(1).max(1000).optional() }),
      execute: ({ containerId, tail }) => docker.getContainerLogs(containerId, tail),
    }),
    getContainerStats: tool({
      description: 'Get current CPU and memory use for one HalfCloud-managed container.',
      inputSchema: z.object({ containerId }),
      execute: ({ containerId }) => docker.getContainerStats(containerId),
    }),
    getServerStats: tool({
      description: 'Get current host CPU, memory, disk, and uptime.',
      inputSchema: z.object({}),
      execute: getServerStats,
    }),
  };

  const agent = new ToolLoopAgent({
    id: 'halfcloud-docker-operator',
    model: provider.responses(settings.deployment),
    instructions: SYSTEM_PROMPT,
    tools,
  });
  return createAgentUIStreamResponse({ agent, uiMessages: messages, abortSignal });
}
