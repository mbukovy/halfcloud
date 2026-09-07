export interface ServerStats {
  cpuPercent: number;
  memoryUsed: number;
  memoryTotal: number;
  diskUsed: number;
  diskTotal: number;
  uptimeSeconds: number;
  os: string;
  architecture: string;
  cpuCount: number;
  docker: {
    dockerVersion: string;
    rootless: boolean;
    cgroupVersion: string;
    cpuCount: number;
    memoryTotal: number;
  };
}

export interface ContainerInfo {
  id: string;
  appId: string;
  serviceId: string;
  runtimeName: string;
  name: string;
  image: string;
  state: string;
  status: string;
  hostname?: string;
  domains: ServiceDomain[];
  ports: Array<{ host: number; container: number; protocol: string }>;
  internalPorts: Array<{ port: number; protocol: string }>;
  cpuPercent: number;
  memoryUsed: number;
  memoryLimit: number;
}

export interface AppInfo {
  id: string;
  name: string;
  status: 'running' | 'partially_running' | 'stopped' | 'degraded' | 'failed' | 'deploying';
  services: ContainerInfo[];
  cpuPercent: number;
  memoryUsed: number;
  runningServices: number;
  createdAt: string;
  updatedAt: string;
  source?: {
    type: 'git';
    url: string;
    gitUrl?: string;
    provider?: 'github';
    owner?: string;
    repository?: string;
    settingsUrl?: string;
    authentication?: 'ssh-deploy-key';
    branch?: string;
    resolvedCommit?: string;
    currentCommit?: string;
  };
  deployment?: {
    status: 'in_progress' | 'running' | 'failed';
    stage: 'cloning' | 'awaiting_deploy_key' | 'inspecting' | 'planning' | 'preparing' | 'building' | 'deploying' | 'initializing' | 'verifying' | 'running' | 'failed';
    message?: string;
    errorCode?: 'invalid_url' | 'not_found' | 'not_public' | 'authentication_required' | 'host_verification_failed' | 'dns_failure' | 'network_failure' | 'clone_failed' | 'inspection_failed' | 'build_failed' | 'deployment_failed' | 'initialization_failed' | 'verification_failed';
    buildAttempts?: number;
    initializationAttempts?: number;
    image?: string;
    updatedAt: string;
  };
}

export interface ServiceDomain {
  id: string;
  hostname: string;
  primary: boolean;
  managed: boolean;
  dnsConfigured: boolean;
  httpsReady: boolean;
  state: 'pending' | 'ready' | 'error';
  dnsTarget?: string;
  access: { type: 'public' } | { type: 'basic_auth'; username: string };
}

export interface EnvironmentVariable {
  id: string;
  serviceId: string;
  name: string;
  value: string;
  protectedFromAI: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PublicSettings {
  configured: boolean;
  providerConfigured: boolean;
  llmReady: boolean;
  provider?: LlmProvider;
  endpoint?: string;
  model?: string;
  hasApiKey: boolean;
  capabilities?: ModelCapabilities;
  verifiedAt?: string;
}

export type LlmProvider = 'openai' | 'anthropic' | 'azure-foundry' | 'cerebras' | 'grok' | 'gemini' | 'groq';
export interface ModelCapabilities { streaming: boolean; tools: boolean; vision?: boolean; reasoning?: boolean }
export interface ModelInfo { id: string; name: string }
export interface ProviderMetadata { id: LlmProvider; label: string; icon: string; requiresEndpoint: boolean; recommendedModel?: string }
export interface LlmSettingsResponse extends PublicSettings { providers: ProviderMetadata[] }

export interface GitHubWebhookSetup {
  kind: 'github-webhook';
  appId: string;
  hookId: string;
  repository: string;
  branch: string;
  payloadUrl: string;
  settingsUrl: string;
  enabled: boolean;
  verified: boolean;
  lastDeliveryAt?: string;
  lastEvent?: string;
  lastUpdate?: {
    status: 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted';
    updatedAt: string;
    commit?: string;
    message?: string;
  };
}

// Reconstruct, never spread: only this metadata may enter conversation history.
export function safeGitHubWebhookSetup(value: unknown): GitHubWebhookSetup | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (item.kind !== 'github-webhook'
    || typeof item.appId !== 'string' || !item.appId
    || typeof item.hookId !== 'string' || !item.hookId
    || typeof item.repository !== 'string' || !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(item.repository)
    || typeof item.branch !== 'string' || !item.branch
    || typeof item.payloadUrl !== 'string'
    || item.settingsUrl !== `https://github.com/${item.repository}/settings/hooks`
    || typeof item.enabled !== 'boolean' || typeof item.verified !== 'boolean') return undefined;
  try {
    const url = new URL(item.payloadUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || url.pathname !== `/api/webhooks/github/${encodeURIComponent(item.hookId)}`) return undefined;
  } catch {
    return undefined;
  }
  const safe: GitHubWebhookSetup = {
    kind: 'github-webhook', appId: item.appId, hookId: item.hookId,
    repository: item.repository, branch: item.branch,
    payloadUrl: item.payloadUrl, settingsUrl: item.settingsUrl,
    enabled: item.enabled, verified: item.verified,
  };
  if (typeof item.lastDeliveryAt === 'string' && Number.isFinite(Date.parse(item.lastDeliveryAt))) safe.lastDeliveryAt = item.lastDeliveryAt;
  if (typeof item.lastEvent === 'string') safe.lastEvent = item.lastEvent;
  if (item.lastUpdate && typeof item.lastUpdate === 'object' && !Array.isArray(item.lastUpdate)) {
    const update = item.lastUpdate as Record<string, unknown>;
    const status = update.status;
    if ((status === 'queued' || status === 'running' || status === 'succeeded' || status === 'failed' || status === 'interrupted')
      && typeof update.updatedAt === 'string' && Number.isFinite(Date.parse(update.updatedAt))) {
      safe.lastUpdate = { status, updatedAt: update.updatedAt };
      if (typeof update.commit === 'string') safe.lastUpdate.commit = update.commit;
      if (typeof update.message === 'string') safe.lastUpdate.message = update.message;
    }
  }
  return safe;
}

// These endpoints must not expose response bodies through the general API error path.
async function githubWebhookRequest(appId: string, suffix: '' | '/secret' | '/rotate', options: RequestInit): Promise<unknown> {
  try {
    const response = await fetch(`/api/apps/${encodeURIComponent(appId)}/github-webhook${suffix}`, {
      ...options, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: options.body ? { 'content-type': 'application/json' } : undefined,
    });
    if (response.status === 401) window.dispatchEvent(new Event('halfcloud:unauthorized'));
    if (!response.ok) throw new Error();
    return await response.json();
  } catch {
    throw new Error('Could not complete the GitHub webhook request. Please try again.');
  }
}

function requireGitHubWebhookSetup(value: unknown, appId: string): GitHubWebhookSetup {
  const setup = safeGitHubWebhookSetup(value);
  if (!setup || setup.appId !== appId) throw new Error('Could not read GitHub webhook status. Please check again.');
  return setup;
}

export async function getGitHubWebhookSetup(appId: string, signal: AbortSignal) {
  return requireGitHubWebhookSetup(await githubWebhookRequest(appId, '', { method: 'GET', signal }), appId);
}

export async function setGitHubWebhookEnabled(appId: string, hookId: string, enabled: boolean, signal: AbortSignal) {
  return requireGitHubWebhookSetup(await githubWebhookRequest(appId, '', {
    method: 'PUT', body: JSON.stringify({ hookId, enabled }), signal,
  }), appId);
}

export async function rotateGitHubWebhookSecret(appId: string, hookId: string, signal: AbortSignal) {
  return requireGitHubWebhookSetup(await githubWebhookRequest(appId, '/rotate', {
    method: 'POST', body: JSON.stringify({ hookId }), signal,
  }), appId);
}

export async function getGitHubWebhookSecret(appId: string, hookId: string, signal: AbortSignal): Promise<string> {
  const value = await githubWebhookRequest(appId, '/secret', { method: 'POST', body: JSON.stringify({ hookId }), signal });
  if (!value || typeof value !== 'object' || !('secret' in value) || typeof value.secret !== 'string' || !value.secret) {
    throw new Error('Could not retrieve the webhook secret. Please try again.');
  }
  return value.secret;
}

export async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: options?.body ? { 'content-type': 'application/json', ...options.headers } : options?.headers,
  });
  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) window.dispatchEvent(new Event('halfcloud:unauthorized'));
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body as T;
}
