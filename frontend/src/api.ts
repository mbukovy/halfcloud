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

export interface ServiceDomain {
  hostname: string;
  primary: boolean;
  managed: boolean;
  dnsConfigured: boolean;
  httpsReady: boolean;
  state: 'pending' | 'ready' | 'error';
  dnsTarget?: string;
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
  provider: 'azure';
  endpoint: string;
  deployment: string;
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
