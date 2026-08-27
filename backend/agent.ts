import { createAzure } from '@ai-sdk/azure';
import { ToolLoopAgent, createAgentUIStreamResponse, tool, type UIMessage } from 'ai';
import { z } from 'zod';
import type { AiSettings } from './config.js';
import type { ApplicationService } from './applications.js';
import { getServerStats } from './metrics.js';

function redact(value: string, apiKey: string) {
  return value
    .replaceAll(apiKey, '[REDACTED]')
    .replace(/((?:api[-_ ]?key|authorization)["' ]*[:=]["' ]*)([^\s,"'}]+)/gi, '$1[REDACTED]')
    .replace(/Bearer\s+[^\s,"'}]+/gi, 'Bearer [REDACTED]');
}

function errorDetails(error: unknown, apiKey: string) {
  const details: string[] = [];
  let current: unknown = error;

  for (let depth = 0; current && depth < 4; depth++) {
    if (current instanceof Error) {
      const namedError = current as Error & { statusCode?: unknown; responseBody?: unknown; url?: unknown };
      const description = `${namedError.name}: ${namedError.message}`;
      if (!details.includes(description)) details.push(description);
      if (namedError.statusCode != null) details.push(`HTTP status: ${String(namedError.statusCode)}`);
      if (typeof namedError.url === 'string') details.push(`Request URL: ${namedError.url}`);
      if (typeof namedError.responseBody === 'string') details.push(`Azure response: ${namedError.responseBody}`);
      current = current.cause;
    } else {
      details.push(String(current));
      break;
    }
  }

  return redact(details.join('\n'), apiKey).slice(0, 4000) || 'Unknown error';
}

export function azureProviderOptions(settings: AiSettings) {
  const endpoint = new URL(settings.endpoint);
  const endpointPath = endpoint.pathname.replace(/\/+$/, '');
  const resourceMatch = endpoint.hostname.match(/^([^.]+)\.openai\.azure\.com$/);
  const foundryEndpoint = endpoint.hostname.endsWith('.services.ai.azure.com');

  if (resourceMatch && !['', '/openai', '/openai/v1'].includes(endpointPath)) {
    throw new Error(`Invalid Azure OpenAI endpoint path "${endpointPath}". Use the resource endpoint only, for example https://${resourceMatch[1]}.openai.azure.com`);
  }

  if (resourceMatch) return { resourceName: resourceMatch[1], apiKey: settings.apiKey };

  if (foundryEndpoint) {
    if (!['', '/openai', '/openai/v1', '/openai/v1/responses'].includes(endpointPath)) {
      throw new Error(`Invalid Azure AI Foundry endpoint path "${endpointPath}". Use ${endpoint.origin} or ${endpoint.origin}/openai/v1/responses`);
    }
    return { baseURL: `${endpoint.origin}/openai/v1`, apiKey: settings.apiKey };
  }

  const basePath = endpointPath.replace(/\/v1$/, '');
  return {
    baseURL: `${endpoint.origin}${basePath.endsWith('/openai') ? basePath : `${basePath}/openai`}`,
    apiKey: settings.apiKey,
  };
}

const SYSTEM_PROMPT = `You are HalfCloud, the operator of a real VPS. Docker tool calls affect the real machine.

Rules:
- Assume the user may have little experience with Docker, VPS administration, application deployment, networking, or domains. Use plain language, explain important choices and failures without jargon, and do not assume they know which settings an application needs.
- Inspect current Docker state before making assumptions. Prefer the provided tools over instructions involving Docker CLI.
- Only modify containers carrying the HalfCloud managed label. The tools enforce this boundary.
- Before creating an application, list applications to understand names and published ports. createApplication performs the final port check.
- Choose a sensible short container name when intent is clear. Use official images and explicit image tags (usually :latest) unless the user names another image.
- For common web images, infer their standard internal port. The ports object maps a localhost host port in the 10000-19999 range to a container port.
- Deployments run on rootless Docker. Never request privileged mode, host networking, devices, Docker sockets, or arbitrary host paths.
- If an application requires privileged host access, explain that it cannot currently be deployed safely by HalfCloud. Never suggest silently elevating it.
- When application data must survive container recreation, use namedVolumes by default and mount each volume at the path expected by the image. This includes databases, uploads, application state, configuration state, and persistent caches.
- Use volumes, which are bind mounts inside the application's HalfCloud-managed directory, only for configuration or other files that intentionally need host filesystem access. Do not use a bind mount merely out of habit.
- Never replace persistent data with an ephemeral container directory to work around permissions. Preserve persistence and fix the volume, mount target, ownership, or image configuration instead. Never use chmod 777 as a generic permissions fix.
- Before changing existing storage, inspect what is already deployed. Do not delete data, replace a volume, or perform a destructive migration without clearly explaining the risk and obtaining the user's approval.
- Never stop or delete a different container to resolve a port conflict. Offer the available port reported by the tool and ask the user before changing their requested port.
- Deletion is destructive. Call deleteApplication with the exact HalfCloud name when deletion is requested; the interface will require explicit user approval before the tool executes. If approval is denied, do not retry unless the user makes a new deletion request.
- Start, stop, restart, create, logs, stats, and listing do not need confirmation when the user's intent is clear.
- After every application creation, inspect its logs and list applications again to verify that it remains running. If Docker reports health for the image, verify that status too. A successful start alone is not success.
- If post-creation checks reveal a problem, diagnose and fix it when the correction is safe and consistent with the requested deployment. Prefer fixes that preserve the intended architecture, persistence, security, and private service exposure; do not call a deployment successful if the fix risks data loss after recreation or unnecessarily exposes a service.
- Explain important failures plainly. Never expose API keys or claim success unless the tool result confirms it.
- Keep responses concise and operational. After creating an application, state its name and public HTTPS URL.`;

export async function createChatResponse(
  settings: AiSettings,
  docker: ApplicationService,
  messages: UIMessage[],
  abortSignal?: AbortSignal,
  requestId = 'unknown',
) {
  const provider = createAzure(azureProviderOptions(settings));
  const containerId = z.string().min(1).describe('Container id or exact HalfCloud name');

  const tools = {
    listContainers: tool({
      description: 'List every HalfCloud-managed container, including current status, ports, CPU, and memory.',
      inputSchema: z.object({}),
      execute: () => docker.listContainers(),
    }),
    createApplication: tool({
      description: 'Deploy a rootless HalfCloud application, expose it through Caddy HTTPS, and verify it started.',
      inputSchema: z.object({
        name: z.string().min(1),
        image: z.string().min(1),
        ports: z.record(z.string(), z.string()).describe('Map of localhost host port (10000-19999) to container port, e.g. {"10023":"5678"}'),
        environment: z.record(z.string(), z.string()).optional(),
        namedVolumes: z.record(z.string(), z.string()).optional().describe('Map of application-local volume name to absolute container path; preferred for persistent application data'),
        volumes: z.record(z.string(), z.string()).optional().describe('Map of application-relative host path to absolute container path; use only when host filesystem access is needed'),
        hostname: z.string().optional().describe('Optional DNS hostname; defaults to <name>.<server-domain>'),
      }),
      execute: (input) => docker.createContainer(input),
    }),
    startApplication: tool({
      description: 'Start a stopped HalfCloud-managed container.',
      inputSchema: z.object({ containerId }),
      execute: ({ containerId }) => docker.startContainer(containerId),
    }),
    stopApplication: tool({
      description: 'Gracefully stop a running HalfCloud-managed container.',
      inputSchema: z.object({ containerId }),
      execute: ({ containerId }) => docker.stopContainer(containerId),
    }),
    restartApplication: tool({
      description: 'Restart a HalfCloud-managed container.',
      inputSchema: z.object({ containerId }),
      execute: ({ containerId }) => docker.restartContainer(containerId),
    }),
    deleteApplication: tool({
      description: 'Permanently delete a HalfCloud-managed container, but not its image or managed data. The interface requires explicit user approval before execution.',
      inputSchema: z.object({ containerId }),
      execute: ({ containerId }) => docker.deleteContainer(containerId),
    }),
    getApplicationLogs: tool({
      description: 'Get recent raw stdout/stderr logs for a HalfCloud-managed container.',
      inputSchema: z.object({ containerId, tail: z.number().int().min(1).max(1000).optional() }),
      execute: ({ containerId, tail }) => docker.getContainerLogs(containerId, tail),
    }),
    getApplicationStatus: tool({
      description: 'Get current CPU and memory use for one HalfCloud-managed container.',
      inputSchema: z.object({ containerId }),
      execute: ({ containerId }) => docker.getContainerStats(containerId),
    }),
    setEnvironmentVariable: tool({
      description: 'Set or replace one environment variable and safely recreate the application container. Secret values are not returned.',
      inputSchema: z.object({ containerId, key: z.string().min(1), value: z.string() }),
      execute: ({ containerId, key, value }) => docker.setEnvironmentVariable(containerId, key, value),
    }),
    getHostStatus: tool({
      description: 'Get current host CPU, memory, disk, and uptime.',
      inputSchema: z.object({}),
      execute: async () => ({ ...(await getServerStats()), docker: await docker.getRuntimeInfo() }),
    }),
  };

  const agent = new ToolLoopAgent({
    id: 'halfcloud-docker-operator',
    model: provider.responses(settings.deployment),
    instructions: SYSTEM_PROMPT,
    tools,
    toolApproval: { deleteApplication: 'user-approval' },
  });
  return createAgentUIStreamResponse({
    agent,
    uiMessages: messages,
    abortSignal,
    onError: (error) => {
      const details = errorDetails(error, settings.apiKey);
      console.error(`[chat:${requestId}] Azure OpenAI stream failed\n${details}`, error instanceof Error ? error.stack : '');
      return `Azure OpenAI request failed (request ID: ${requestId}).\nEndpoint: ${settings.endpoint}\nDeployment: ${settings.deployment}\n${details}`;
    },
  });
}
