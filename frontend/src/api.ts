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
