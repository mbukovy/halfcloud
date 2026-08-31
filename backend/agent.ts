import { ToolLoopAgent, createAgentUIStream, createUIMessageStream, createUIMessageStreamResponse, tool, type UIMessage, type UIMessageStreamWriter } from 'ai';
import { z } from 'zod';
import type { AiSettings } from './config.js';
import type { ApplicationService } from './applications.js';
import { getServerStats } from './metrics.js';
import { createLanguageModel, redactProviderError } from './llm/index.js';
import type { DeploymentProgress } from './docker.js';
export { legacyAzureProviderOptions as azureProviderOptions } from './llm/index.js';

export function sanitizeAgentMessages(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => ({
    ...message,
    parts: message.parts.flatMap((part) => {
      if (typeof part !== 'object' || part === null) return [part];
      const record = part as unknown as Record<string, unknown>;
      const type = typeof record.type === 'string' ? record.type : '';
      const name = type === 'dynamic-tool' ? record.toolName : type.startsWith('tool-') ? type.slice(5) : undefined;

      // Tool history is browser-controlled context. Never replay an environment mutation value to the provider.
      if (name === 'setEnvironmentVariable') return [];
      if (name === 'requestEnvironmentVariable') {
        const input = record.input as Record<string, unknown> | undefined;
        const output = record.output as Record<string, unknown> | undefined;
        const safeTargets = (value: unknown) => Array.isArray(value)
          ? value.flatMap((target) => {
            if (typeof target !== 'object' || target === null) return [];
            const candidate = target as Record<string, unknown>;
            return typeof candidate.serviceId === 'string' && typeof candidate.name === 'string'
              ? [{ serviceId: candidate.serviceId, name: candidate.name }]
              : [];
          })
          : undefined;
        return [{
          ...record,
          input: {
            ...(typeof input?.serviceId === 'string' ? { serviceId: input.serviceId } : {}),
            ...(typeof input?.name === 'string' ? { name: input.name } : {}),
            ...(safeTargets(input?.additionalTargets) ? { additionalTargets: safeTargets(input?.additionalTargets) } : {}),
            ...(typeof input?.description === 'string' ? { description: input.description } : {}),
          },
          ...(output ? { output: {
            ...(typeof output.requestId === 'string' ? { requestId: output.requestId } : {}),
            ...(typeof output.appId === 'string' ? { appId: output.appId } : {}),
            ...(typeof output.serviceId === 'string' ? { serviceId: output.serviceId } : {}),
            ...(typeof output.name === 'string' ? { name: output.name } : {}),
            ...(safeTargets(output.targets) ? { targets: safeTargets(output.targets) } : {}),
            ...(typeof output.description === 'string' ? { description: output.description } : {}),
            ...(typeof output.status === 'string' ? { status: output.status } : {}),
            ...(typeof output.protectedFromAI === 'boolean' ? { protectedFromAI: output.protectedFromAI } : {}),
          } } : {}),
        } as typeof part];
      }
      if (name === 'requestBasicAuthSetup' || name === 'requestBasicAuthPasswordChange') {
        const input = record.input as Record<string, unknown> | undefined;
        const output = record.output as Record<string, unknown> | undefined;
        return [{
          ...record,
          input: typeof input?.routeId === 'string' ? { routeId: input.routeId } : {},
          ...(output ? { output: {
            ...(typeof output.requestId === 'string' ? { requestId: output.requestId } : {}),
            ...(typeof output.routeId === 'string' ? { routeId: output.routeId } : {}),
            ...(typeof output.hostname === 'string' ? { hostname: output.hostname } : {}),
            ...(typeof output.operation === 'string' ? { operation: output.operation } : {}),
            ...(typeof output.status === 'string' ? { status: output.status } : {}),
            ...(typeof output.access === 'string' ? { access: output.access } : {}),
            ...(typeof output.username === 'string' ? { username: output.username } : {}),
            ...(typeof output.success === 'boolean' ? { success: output.success } : {}),
          } } : {}),
        } as typeof part];
      }
      if ((name !== 'createApp' && name !== 'addService' && name !== 'createApplication') || typeof record.input !== 'object' || record.input === null) return [part];
      const input = record.input as Record<string, unknown>;
      if (name === 'createApplication') {
        const { environment: _environment, ...safeInput } = input;
        return [{ ...record, input: safeInput } as typeof part];
      }
      const safeInput = name === 'createApp' && Array.isArray(input.services)
        ? { ...input, services: input.services.map((service) => {
          if (typeof service !== 'object' || service === null) return service;
          const { environment: _environment, ...safeService } = service as Record<string, unknown>;
          return safeService;
        }) }
        : name === 'addService' && typeof input.service === 'object' && input.service !== null
          ? { ...input, service: (() => { const { environment: _environment, ...safeService } = input.service as Record<string, unknown>; return safeService; })() }
        : (() => { const { environment: _environment, ...safe } = input; return safe; })();
      return [{ ...record, input: safeInput } as typeof part];
    }),
  }));
}

const SYSTEM_PROMPT = `You are HalfCloud, the operator of a real VPS. Docker tool calls affect the real machine.

Rules:
- Always treat the user as a non-technical beginner unless they explicitly ask for technical detail. Use plain language and focus on outcomes, not Docker, package, module, process, protocol, or image internals.
- Operate the App for the user. Diagnose logs, choose safe fixes, apply them, and retry without asking the user to interpret errors or propose technical solutions.
- Do not report transient technical failures that you can resolve yourself. If you cannot proceed, explain only what the user needs to know, what you already tried, and the exact action or decision you need from them. Include raw errors or implementation details only when the user explicitly asks.
- Keep the user informed before each meaningful or potentially slow operation with one short, plain-language sentence. Do not narrate routine internal reasoning, but never leave a long-running task without saying what outcome you are working toward.
- Ask the user only for information that cannot be discovered, safely inferred, or fixed with the available tools, such as a secret value, an external account choice, or approval for a destructive action.
- Tools marked as requiring approval collect that approval through the interface. Briefly explain the consequence, then call the tool in the same response so the user receives an approval button. Do not ask for approval in plain chat and wait for a typed reply before calling the tool.
- Treat Apps as the primary organizational and operational unit. Every Service belongs to one App; containers are an internal runtime detail.
- Inspect current App state before making assumptions. Prefer the provided tools over instructions involving Docker CLI.
- Only modify containers carrying the HalfCloud managed label. The tools enforce this boundary.
- Before creating an App, list Apps to understand names and published ports. createApp performs the final port check.
- Use container image search when you need to deploy software but do not confidently know the appropriate image. Prefer searching instead of guessing an unfamiliar image name.
- Treat search results as candidates: consider relevance, description, popularity, official status, and your existing knowledge. Prefer an official image when it appropriately satisfies the request, but do not blindly select the result with the most stars.
- Container image search is optional when the user explicitly provides an image or the correct image is already clear. If materially different candidates require a user preference, ask; otherwise make a reasonable choice and continue the deployment flow.
- Prefer descriptive App names. Choose short stable Service names such as web, worker, mysql, or redis. Use official images and explicit image tags (usually :latest) unless the user names another image.
- Each App has an isolated private network. Services in the same App reach each other by Service name on internal ports; Services in other Apps are not reachable. Use an empty ports object for databases, queues, workers, and other private-only Services.
- A request such as "deploy WordPress with MySQL" means one App with wordpress and mysql Services. A request to add a database, worker, cache, queue, or supporting component to an App must use addService and must not create another App.
- For public web images, infer their standard internal port. The ports object maps a localhost host port in the 10000-19999 range to a container port.
- Deployments run on rootless Docker. Never request privileged mode, host networking, devices, Docker sockets, or arbitrary host paths.
- If an application requires privileged host access, explain that it cannot currently be deployed safely by HalfCloud. Never suggest silently elevating it.
- When application data must survive container recreation, use namedVolumes by default and mount each volume at the path expected by the image. This includes databases, uploads, application state, configuration state, and persistent caches.
- Use volumes, which are bind mounts inside the application's HalfCloud-managed directory, only for configuration or other files that intentionally need host filesystem access. Do not use a bind mount merely out of habit.
- Never replace persistent data with an ephemeral container directory to work around permissions. Preserve persistence and fix the volume, mount target, ownership, or image configuration instead. Never use chmod 777 as a generic permissions fix.
- Before changing existing storage, inspect what is already deployed. Do not delete data, replace a volume, or perform a destructive migration without clearly explaining the risk and obtaining the user's approval.
- Use the managed storage tools to inspect or reconcile storage. Volume deletion and ownership repair require explicit approval. Ownership repair is restricted to storage already mounted by the selected HalfCloud application.
- When the user asks about data retained after deleting an App, search managed volumes by its exact appId, not its display name. If the appId is unavailable or that search is empty, list all orphaned volumes and use their returned appId and serviceId labels to identify candidates. Never conclude retained data is absent after searching only by App name or Service ID.
- When the user wants to reclaim storage space, list orphaned managed volumes first. Explain that deleting a volume permanently removes its data, then call deleteManagedVolume for each volume the user wants removed so the interface can collect approval.
- Never stop or delete a different container to resolve a port conflict. Offer the available port reported by the tool and ask the user before changing their requested port.
- App deletion is destructive. Persistent data is kept unless deleteData is explicitly true. Never set deleteData to true without an explicit user request to delete all data; the interface requires approval.
- Start, stop, restart, create, logs, stats, and listing do not need confirmation when the user's intent is clear.
- A service may have multiple public domains. HalfCloud-generated domains should normally remain attached as permanent fallback and debug addresses.
- When the user adds the first custom domain, prefer making it primary while preserving the HalfCloud-generated domain. Do not remove or replace any existing domain unless explicitly requested or required to resolve a conflict.
- The primary domain is the preferred public URL, but every configured domain continues routing directly to the service. Changing it does not imply changing arbitrary application environment variables.
- External DNS is the user's responsibility. When adding a custom domain, report the DNS target returned by the tool and explain that HTTPS becomes ready after DNS points to this server; Caddy manages the certificate.
- HTTP routes may be public or password protected independently, even when they route to the same application. Use inspectRouteAccess when the route's access state is unknown.
- Never ask for a Basic Auth username or password in chat and never pass credentials as tool arguments. Use requestBasicAuthSetup or requestBasicAuthPasswordChange so the trusted HalfCloud widget collects credentials outside AI context.
- Removing route protection makes that hostname publicly accessible. Clearly state this consequence before calling removeRouteProtection; the interface requires explicit user approval.
- Environment variables may be protected from AI. For protected variables, you can see their name and configuration status but never their value.
- Never ask the user to paste API keys, passwords, tokens, credentials, or other sensitive values into chat. Use requestEnvironmentVariable so the user can submit the value directly to HalfCloud with AI protection enabled by default. When the same credential is required by multiple Services in one App, request it once and use additionalTargets to apply that exact value everywhere.
- Configure all non-sensitive database initialization variables before requesting a shared database credential. Database image password variables commonly apply only on first initialization, so do not repeatedly change one side or delete persistent data when authentication fails; inspect logs and configuration first.
- Use setEnvironmentVariable only for non-sensitive configuration that may remain visible to AI, such as NODE_ENV, LOG_LEVEL, PORT, or a public APP_URL. Never use it for credentials.
- createApp and addService deliberately stage new Services without starting them. Configure every required non-sensitive variable, collect every required sensitive value, and only then use startApp or startService. Never start a database or another initialization-sensitive Service before its complete first-run environment is set.
- After starting a new App or Service, inspect relevant logs and list Apps again to verify that every Service remains running. If Docker reports health for an image, verify that status too. A successful start alone is not success.
- If post-creation checks reveal a problem, diagnose and fix it when the correction is safe and consistent with the requested deployment. Prefer fixes that preserve the intended architecture, persistence, security, and private service exposure; do not call a deployment successful if the fix risks data loss after recreation or unnecessarily exposes a service.
- Explain unresolved failures plainly in terms of their user-visible effect and next action. Never expose API keys or claim success unless the tool result confirms it.
- Keep responses concise and operational. After creating a public App, state its name and public HTTPS URL. For a private Service, state its Service name and internal port instead.`;

export async function createChatResponse(
  settings: AiSettings,
  docker: ApplicationService,
  messages: UIMessage[],
  abortSignal?: AbortSignal,
  requestId = 'unknown',
) {
  type AgentMessage = UIMessage<unknown, {
    agentStatus: DeploymentProgress;
    agentError: { requestId: string; provider: string; model: string; details: string };
  }>;
  let progressWriter: UIMessageStreamWriter<AgentMessage> | undefined;
  const reportProgress = (progress: DeploymentProgress) => {
    progressWriter?.write({ type: 'data-agentStatus', data: progress, transient: true });
  };
  const withProgress = async <T>(operation: () => Promise<T>) => {
    try {
      return await operation();
    } finally {
      reportProgress({ phase: 'working' });
    }
  };
  const serviceId = z.string().min(1).describe('Service ID');
  const appId = z.string().min(1).describe('App ID or exact App display name');
  const serviceSchema = z.object({
    name: z.string().min(1).describe('Stable lowercase Service name used for private DNS'),
    image: z.string().min(1),
    ports: z.record(z.string(), z.string()).describe('Map of localhost host port (10000-19999) to container port; use {} for a private Service'),
    environment: z.record(z.string(), z.string()).optional(),
    namedVolumes: z.record(z.string(), z.string()).optional(),
    volumes: z.record(z.string(), z.string()).optional(),
    hostname: z.string().optional(),
  });

  const tools = {
    searchContainerImages: tool({
      description: 'Search Docker Hub for container image candidates. Use this when the appropriate image is not confidently known; results are candidates and must be evaluated before deployment.',
      inputSchema: z.object({
        query: z.string().trim().min(1).describe('Software or capability to search for'),
        limit: z.number().int().min(1).max(25).default(10),
        officialOnly: z.boolean().optional(),
        minStars: z.number().int().min(0).optional(),
      }),
      execute: (input) => docker.searchContainerImages(input),
    }),
    listApps: tool({
      description: 'List Apps with their Services, aggregate status, domains, CPU, and memory.',
      inputSchema: z.object({}),
      execute: () => docker.listApps(),
    }),
    createApp: tool({
      description: 'Create one App containing one or more stopped Services on its own isolated private network. Configure all required environment values before calling startApp. Use one call for systems such as WordPress plus MySQL.',
      inputSchema: z.object({ name: z.string().min(1), services: z.array(serviceSchema).min(1) }),
      execute: (input) => withProgress(() => docker.createApp(input, reportProgress)),
    }),
    addService: tool({
      description: 'Add a stopped supporting Service to an existing App and its isolated network. Configure all required environment values before calling startService.',
      inputSchema: z.object({ appId, service: serviceSchema }),
      execute: ({ appId, service }) => withProgress(() => docker.addService(appId, service, reportProgress)),
    }),
    renameApp: tool({
      description: 'Change only an App display name without recreating or renaming runtime resources.',
      inputSchema: z.object({ appId, name: z.string().min(1).max(128) }),
      execute: ({ appId, name }) => docker.renameApp(appId, name),
    }),
    startApp: tool({ description: 'Start every Service in an App.', inputSchema: z.object({ appId }), execute: ({ appId }) => docker.startApp(appId) }),
    stopApp: tool({ description: 'Stop every Service in an App.', inputSchema: z.object({ appId }), execute: ({ appId }) => docker.stopApp(appId) }),
    restartApp: tool({ description: 'Restart every Service in an App.', inputSchema: z.object({ appId }), execute: ({ appId }) => docker.restartApp(appId) }),
    recreateApp: tool({ description: 'Recreate every runtime Service in an App while preserving managed volumes.', inputSchema: z.object({ appId }), execute: ({ appId }) => docker.recreateApp(appId) }),
    startService: tool({ description: 'Start only one Service in an App.', inputSchema: z.object({ appId, serviceId }), execute: ({ appId, serviceId }) => docker.startService(appId, serviceId) }),
    stopService: tool({ description: 'Stop only one Service in an App.', inputSchema: z.object({ appId, serviceId }), execute: ({ appId, serviceId }) => docker.stopService(appId, serviceId) }),
    restartService: tool({ description: 'Restart only one Service in an App.', inputSchema: z.object({ appId, serviceId }), execute: ({ appId, serviceId }) => docker.restartService(appId, serviceId) }),
    recreateService: tool({ description: 'Recreate only one Service in an App while preserving managed volumes.', inputSchema: z.object({ appId, serviceId }), execute: ({ appId, serviceId }) => docker.recreateService(appId, serviceId) }),
    removeService: tool({ description: 'Remove one Service from a multi-Service App while retaining managed data. Requires approval.', inputSchema: z.object({ appId, serviceId }), execute: ({ appId, serviceId }) => docker.removeService(appId, serviceId) }),
    deleteApp: tool({
      description: 'Delete an App and its runtime Services/network. Data is retained unless deleteData is explicitly true. Requires approval.',
      inputSchema: z.object({ appId, deleteData: z.boolean().default(false) }),
      execute: ({ appId, deleteData }) => docker.deleteApp(appId, deleteData),
    }),
    getAppLogs: tool({ description: 'Get combined recent logs for all Services in an App with Service prefixes.', inputSchema: z.object({ appId, tail: z.number().int().min(1).max(1000).optional() }), execute: ({ appId, tail }) => docker.getAppLogs(appId, tail) }),
    getServiceLogs: tool({ description: 'Get recent logs from only one Service.', inputSchema: z.object({ serviceId, tail: z.number().int().min(1).max(1000).optional() }), execute: ({ serviceId, tail }) => docker.getContainerLogs(serviceId, tail) }),
    getApp: tool({ description: 'Get one App with its Services, status, domains, CPU, and memory.', inputSchema: z.object({ appId }), execute: ({ appId }) => docker.getApp(appId) }),
    inspectContainer: tool({
      description: 'Inspect one managed container through a controlled schema, including AI-safe environment metadata. Raw Docker inspect output is never returned.',
      inputSchema: z.object({ serviceId }),
      execute: ({ serviceId }) => docker.inspectContainerForAgent(serviceId),
    }),
    listEnvironment: tool({
      description: 'List environment variables for a service. Values protected from AI are omitted and represented only as configured.',
      inputSchema: z.object({ serviceId }),
      execute: ({ serviceId }) => docker.listEnvironmentForAgent(serviceId),
    }),
    setEnvironmentVariable: tool({
      description: 'Set or replace a non-sensitive environment variable that may remain visible to AI, then safely recreate the application container.',
      inputSchema: z.object({ serviceId, name: z.string().min(1), value: z.string() }),
      execute: ({ serviceId, name, value }) => docker.setEnvironmentVariableForAgent(serviceId, name, value),
    }),
    requestEnvironmentVariable: tool({
      description: 'Request one sensitive value through a dedicated direct-to-HalfCloud input and apply it to one or more environment variables in the same App. Use additionalTargets whenever Services must share an exact credential. This tool intentionally has no value argument.',
      inputSchema: z.object({
        serviceId,
        name: z.string().min(1),
        additionalTargets: z.array(z.object({ serviceId, name: z.string().min(1) })).max(19).optional(),
        description: z.string().max(500).optional(),
      }),
      execute: ({ serviceId, name, description, additionalTargets }) => docker.requestEnvironmentVariable(serviceId, name, description, additionalTargets),
    }),
    listServiceDomains: tool({
      description: 'List all routing domains for a public HalfCloud application, including primary, managed, DNS, and HTTPS state.',
      inputSchema: z.object({ containerId: serviceId }),
      execute: ({ containerId }) => docker.listDomains(containerId),
    }),
    addServiceDomain: tool({
      description: 'Add a custom routing domain without replacing existing domains. The first custom domain automatically becomes primary.',
      inputSchema: z.object({ containerId: serviceId, hostname: z.string().min(1) }),
      execute: ({ containerId, hostname }) => docker.addDomain(containerId, hostname),
    }),
    removeServiceDomain: tool({
      description: 'Remove one routing domain. HalfCloud-managed domains are preserved unless allowManaged is true following an explicit user request.',
      inputSchema: z.object({ containerId: serviceId, hostname: z.string().min(1), allowManaged: z.boolean().optional() }),
      execute: ({ containerId, hostname, allowManaged }) => docker.removeDomain(containerId, hostname, allowManaged),
    }),
    setPrimaryServiceDomain: tool({
      description: 'Make one existing routing domain the preferred public URL without changing application environment variables.',
      inputSchema: z.object({ containerId: serviceId, hostname: z.string().min(1) }),
      execute: ({ containerId, hostname }) => docker.setPrimaryDomain(containerId, hostname),
    }),
    inspectRouteAccess: tool({
      description: 'Inspect whether one HTTP route is public or password protected. Password hashes are never returned.',
      inputSchema: z.object({ routeId: z.string().startsWith('route_') }),
      execute: ({ routeId }) => docker.inspectRouteAccess(routeId),
    }),
    requestBasicAuthSetup: tool({
      description: 'Open a trusted credential widget to password protect a public HTTPS route. This tool intentionally accepts no credentials.',
      inputSchema: z.object({ routeId: z.string().startsWith('route_') }),
      execute: ({ routeId }) => docker.requestBasicAuthSetup(routeId),
    }),
    requestBasicAuthPasswordChange: tool({
      description: 'Open a trusted credential widget to replace credentials for a protected HTTPS route. This tool intentionally accepts no credentials.',
      inputSchema: z.object({ routeId: z.string().startsWith('route_') }),
      execute: ({ routeId }) => docker.requestBasicAuthPasswordChange(routeId),
    }),
    removeRouteProtection: tool({
      description: 'Remove password protection and make an HTTP route publicly accessible. Requires explicit user approval.',
      inputSchema: z.object({ routeId: z.string().startsWith('route_') }),
      execute: ({ routeId }) => docker.removeRouteProtection(routeId),
    }),
    listManagedVolumes: tool({
      description: 'List HalfCloud-managed named volumes and show whether each is attached or orphaned. Use appId to find storage retained after App deletion. To inventory all unused storage, set orphaned to true and omit IDs.',
      inputSchema: z.object({
        appId: z.string().startsWith('app_').optional().describe('Exact immutable App ID from an App or prior deletion result'),
        serviceId: z.string().startsWith('service_').optional().describe('Exact immutable Service ID'),
        orphaned: z.boolean().optional().describe('True returns only volumes unused by every existing container'),
      }),
      execute: (filter) => docker.listManagedVolumes(filter),
    }),
    inspectManagedVolume: tool({
      description: 'Inspect one HalfCloud-managed named volume without exposing unmanaged Docker storage.',
      inputSchema: z.object({ volumeName: z.string().min(1) }),
      execute: ({ volumeName }) => docker.inspectManagedVolume(volumeName),
    }),
    reconcileManagedVolume: tool({
      description: 'Validate and recognize a correctly labeled orphaned HalfCloud volume so it can be safely reused.',
      inputSchema: z.object({ application: z.string().min(1), localName: z.string().min(1) }),
      execute: ({ application, localName }) => docker.reconcileManagedVolume(application, localName),
    }),
    deleteManagedVolume: tool({
      description: 'Permanently delete one HalfCloud-managed named volume. Fails if it is in use and requires explicit user approval.',
      inputSchema: z.object({ volumeName: z.string().min(1) }),
      execute: ({ volumeName }) => docker.deleteManagedVolume(volumeName),
    }),
    repairStorageOwnership: tool({
      description: 'Recursively repair ownership of one mounted managed storage path to match the application image user. Requires explicit user approval.',
      inputSchema: z.object({ containerId: serviceId, mountTarget: z.string().startsWith('/') }),
      execute: ({ containerId, mountTarget }) => docker.repairStorageOwnership(containerId, mountTarget),
    }),
    getHostStatus: tool({
      description: 'Get current host CPU, memory, disk, and uptime.',
      inputSchema: z.object({}),
      execute: async () => ({ ...(await getServerStats()), docker: await docker.getRuntimeInfo() }),
    }),
  };

  const agent = new ToolLoopAgent({
    id: 'halfcloud-docker-operator',
    model: createLanguageModel(settings),
    instructions: SYSTEM_PROMPT,
    tools,
    toolApproval: { deleteApp: 'user-approval', removeService: 'user-approval', deleteManagedVolume: 'user-approval', repairStorageOwnership: 'user-approval', removeRouteProtection: 'user-approval' },
  });
  const onError = (error: unknown) => {
    const details = redactProviderError(error, settings.apiKey);
    console.error(`[chat:${requestId}] LLM stream failed (${settings.provider}/${settings.model})\n${details}`);
    progressWriter?.write({
      type: 'data-agentError',
      data: { requestId, provider: settings.provider, model: settings.model, details },
      transient: true,
    });
    return `AI provider request failed (request ID: ${requestId}). Please check the AI Provider settings and try again.`;
  };
  const stream = createUIMessageStream<AgentMessage>({
    onError,
    execute: async ({ writer }) => {
      progressWriter = writer;
      const agentStream = await createAgentUIStream({
        agent,
        uiMessages: sanitizeAgentMessages(messages),
        abortSignal,
        onError,
      });
      // The agent stream has no custom data parts, so it is safe to merge into our richer message stream.
      writer.merge(agentStream as unknown as Parameters<typeof writer.merge>[0]);
    },
  });
  return createUIMessageStreamResponse({ stream });
}
