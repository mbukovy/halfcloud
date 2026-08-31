<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useChat } from '@ai-sdk/vue';
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses, type UIMessage } from 'ai';
import MarkdownIt from 'markdown-it';
import { api, type AppInfo, type ContainerInfo, type EnvironmentVariable, type LlmProvider, type LlmSettingsResponse, type ModelInfo, type ProviderMetadata, type PublicSettings, type ServerStats, type ServiceDomain } from './api';

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true });
markdown.renderer.rules.link_open = (tokens, index, options, environment, renderer) => {
  tokens[index]!.attrSet('target', '_blank');
  tokens[index]!.attrSet('rel', 'noopener noreferrer');
  return renderer.renderToken(tokens, index, options);
};

const authenticated = ref(false);
const loading = ref(true);
const accessCode = ref('');
const loginError = ref('');
const settings = ref<PublicSettings | null>(null);
const providers = ref<ProviderMetadata[]>([]);
const settingsForm = reactive({ provider: '' as LlmProvider | '', endpoint: '', apiKey: '', model: '', customModel: '' });
const settingsOpen = ref(false);
const settingsStage = ref<'summary' | 'picker' | 'configure'>('picker');
const savingSettings = ref(false);
const testingSettings = ref(false);
const credentialsVerified = ref(false);
const availableModels = ref<ModelInfo[]>([]);
const useCustomModel = ref(false);
const settingsError = ref('');
const apps = ref<AppInfo[]>([]);
const server = ref<ServerStats | null>(null);
const dashboardError = ref('');
const actionId = ref('');
const domainAction = ref('');
const editingAppId = ref('');
const appNameDraft = ref('');
const expandedAppIds = reactive(new Set<string>());
const environmentDialog = reactive<{
  container: ContainerInfo | null;
  variables: EnvironmentVariable[];
  loading: boolean;
  error: string;
  saving: boolean;
}>({ container: null, variables: [], loading: false, error: '', saving: false });
const environmentSnapshot = ref('[]');
const revealedEnvironmentValues = reactive(new Set<string>());
const environmentRequestForms = reactive<Record<string, { value: string; protectedFromAI: boolean; saving: boolean; error: string }>>({});
const basicAuthRequestForms = reactive<Record<string, { username: string; password: string; saving: boolean; error: string }>>({});
const logs = ref<{ id: string; name: string; content: string; tail: number; search: string; reverse: boolean; loading: boolean; error: string } | null>(null);
const prompt = ref('');
const transcript = ref<HTMLElement>();
const composerInput = ref<HTMLTextAreaElement>();
const respondingApprovalId = ref('');
const continuedRequestIds = reactive(new Set<string>());
type AgentStatus = { phase: 'pulling-image'; image: string } | { phase: 'activity'; label: string } | { phase: 'working' };
type AgentErrorDetails = { requestId: string; provider: string; model: string; details: string };
type HalfCloudMessage = UIMessage<unknown, { agentStatus: AgentStatus; agentError: AgentErrorDetails }>;
const agentStatus = ref<AgentStatus | null>(null);
const agentErrorDetails = ref<AgentErrorDetails | null>(null);
const activityElapsedSeconds = ref(0);
const mobileTab = ref<'operator' | 'apps' | 'server'>('operator');
let refreshTimer: number | undefined;
let activityTimer: number | undefined;

const authenticatedFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  if (response.status === 401) window.dispatchEvent(new Event('halfcloud:unauthorized'));
  return response;
};

const { messages, sendMessage, status, error: chatError, stop, clearError, addToolApprovalResponse } = useChat<HalfCloudMessage>({
  transport: new DefaultChatTransport({ api: '/api/chat', fetch: authenticatedFetch }),
  sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
  onData(part) {
    if (part.type === 'data-agentStatus') agentStatus.value = part.data.phase === 'working' ? null : part.data;
    if (part.type === 'data-agentError') agentErrorDetails.value = part.data;
  },
});

const chatBusy = computed(() => status.value === 'submitted' || status.value === 'streaming');
const agentActivityLabel = computed(() => {
  if (!chatBusy.value) return '';
  if (agentStatus.value?.phase === 'pulling-image') return `Pulling ${agentStatus.value.image}`;
  if (agentStatus.value?.phase === 'activity') return agentStatus.value.label;
  if (status.value === 'submitted') return 'Contacting AI provider';

  const latestMessage = messages.value.at(-1);
  if (latestMessage?.role === 'assistant') {
    for (let index = latestMessage.parts.length - 1; index >= 0; index -= 1) {
      const part = latestMessage.parts[index];
      if (textPart(part) && part.text) return 'Writing response';
      const currentTool = toolPart(part);
      if (!currentTool) continue;
      return toolState(currentTool) === 'working' ? toolLabel(currentTool) : 'Reviewing results';
    }
  }
  return 'Planning next step';
});
const environmentChanges = computed(() => environmentSnapshot.value !== environmentSignature(environmentDialog.variables));
const visibleLogs = computed(() => {
  if (!logs.value?.content) return 'No recent logs.';
  const search = logs.value.search.trim().toLowerCase();
  let lines = logs.value.content.split(/\r?\n/);
  if (search) lines = lines.filter((line) => line.toLowerCase().includes(search));
  if (logs.value.reverse) lines.reverse();
  return lines.join('\n') || 'No matching log lines.';
});
const selectedProvider = computed(() => providers.value.find((provider) => provider.id === settingsForm.provider));
const selectedModel = computed(() => useCustomModel.value ? settingsForm.customModel.trim() : settingsForm.model);
const activeProvider = computed(() => providers.value.find((provider) => provider.id === settings.value?.provider));

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value.toFixed(index >= 3 ? 1 : 0)} ${units[index]}`;
}

function formatUptime(seconds: number) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return days ? `${days}d ${hours}h` : `${hours}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function textPart(part: unknown): part is { type: 'text'; text: string } {
  return typeof part === 'object' && part !== null && (part as { type?: string }).type === 'text';
}

function renderMarkdown(text: string) {
  return markdown.render(text);
}

function privateAddresses(container: ContainerInfo) {
  return container.internalPorts
    .filter((port) => port.protocol === 'tcp')
    .map((port) => `${container.name}:${port.port}`);
}

function toggleApp(appId: string) {
  if (expandedAppIds.has(appId)) expandedAppIds.delete(appId);
  else expandedAppIds.add(appId);
}

function toolPart(part: unknown) {
  if (typeof part !== 'object' || part === null) return null;
  const value = part as Record<string, unknown>;
  if (typeof value.type !== 'string' || (!value.type.startsWith('tool-') && value.type !== 'dynamic-tool')) return null;
  return value;
}

function toolName(part: Record<string, unknown>) {
  const type = String(part.type);
  return type === 'dynamic-tool' ? String(part.toolName ?? 'tool') : type.slice(5);
}

type MessagePartGroup =
  | { kind: 'text'; key: string; part: { type: 'text'; text: string } }
  | { kind: 'tools'; key: string; parts: Record<string, unknown>[] };

function groupMessageParts(parts: readonly unknown[]): MessagePartGroup[] {
  const groups: MessagePartGroup[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (textPart(part)) {
      groups.push({ kind: 'text', key: `text-${index}`, part });
      continue;
    }

    const currentTool = toolPart(part);
    if (!currentTool) continue;
    const previous = groups.at(-1);
    if (previous?.kind === 'tools' && toolName(previous.parts[0]!) === toolName(currentTool)) {
      previous.parts.push(currentTool);
    } else {
      groups.push({ kind: 'tools', key: `tools-${index}`, parts: [currentTool] });
    }
  }
  return groups;
}

function latestTool(parts: Record<string, unknown>[]) {
  return parts[parts.length - 1]!;
}

function toolGroupDetails(parts: Record<string, unknown>[]) {
  return parts.flatMap((part) => toolDetails(part));
}

function toolLabel(part: Record<string, unknown>) {
  const name = toolName(part);
  if ((name === 'createApp' || name === 'addService') && toolState(part) === 'working') {
    if (agentStatus.value?.phase === 'pulling-image') return `Pulling ${agentStatus.value.image}`;
    if (agentStatus.value?.phase === 'activity') return agentStatus.value.label;
  }
  const labels: Record<string, string> = {
    searchContainerImages: 'Finding the right software',
    listApps: 'Inspecting Apps', createApp: 'Creating App', addService: 'Adding Service', renameApp: 'Renaming App',
    startApp: 'Starting App', stopApp: 'Stopping App', restartApp: 'Restarting App', recreateApp: 'Recreating App', startService: 'Starting Service', stopService: 'Stopping Service', restartService: 'Restarting Service', recreateService: 'Recreating Service', removeService: 'Removing Service', deleteApp: 'Deleting App',
    getAppLogs: 'Reading App logs', getServiceLogs: 'Reading Service logs', getApp: 'Inspecting App', getHostStatus: 'Inspecting host',
    setEnvironmentVariable: 'Updating application environment', listEnvironment: 'Inspecting application environment',
    inspectContainer: 'Inspecting application', requestEnvironmentVariable: 'Requesting an environment variable',
    listManagedVolumes: 'Inspecting managed storage', inspectManagedVolume: 'Inspecting managed volume',
    reconcileManagedVolume: 'Reconciling managed volume', deleteManagedVolume: 'Deleting managed volume',
    repairStorageOwnership: 'Repairing storage ownership',
    listServiceDomains: 'Inspecting service domains', addServiceDomain: 'Adding service domain',
    removeServiceDomain: 'Removing service domain', setPrimaryServiceDomain: 'Changing primary domain',
    inspectRouteAccess: 'Inspecting route access', requestBasicAuthSetup: 'Protecting route',
    requestBasicAuthPasswordChange: 'Changing route credentials', removeRouteProtection: 'Making route public',
    getContainerLogs: 'Reading logs', getContainerStats: 'Reading container metrics', getServerStats: 'Reading server metrics',
  };
  return labels[name] ?? name;
}

function basicAuthRequest(part: Record<string, unknown>) {
  const name = toolName(part);
  if (name !== 'requestBasicAuthSetup' && name !== 'requestBasicAuthPasswordChange') return undefined;
  const output = recordValue(part.output);
  const requestId = output?.requestId;
  const routeId = output?.routeId;
  if (!output || typeof requestId !== 'string' || typeof routeId !== 'string') return undefined;
  if (!basicAuthRequestForms[requestId]) basicAuthRequestForms[requestId] = { username: '', password: '', saving: false, error: '' };
  return {
    requestId,
    routeId,
    hostname: typeof output.hostname === 'string' ? output.hostname : 'this route',
    changing: output.operation === 'change',
    status: output.status === 'completed' ? 'completed' : 'pending',
    form: basicAuthRequestForms[requestId]!,
  };
}

async function submitBasicAuthRequest(part: Record<string, unknown>) {
  const request = basicAuthRequest(part);
  if (!request || request.status === 'completed' || !request.form.username || request.form.password.length < 8) return;
  request.form.saving = true;
  request.form.error = '';
  try {
    const result = await api<Record<string, unknown>>(`/api/routes/${encodeURIComponent(request.routeId)}/basic-auth-requests/${encodeURIComponent(request.requestId)}`, {
      method: 'PUT',
      body: JSON.stringify({ username: request.form.username, password: request.form.password }),
    });
    request.form.password = '';
    part.output = result;
    await refreshDashboard();
  } catch (error) {
    request.form.error = error instanceof Error ? error.message : 'Could not configure password protection';
  } finally {
    request.form.saving = false;
  }
}

function toolState(part: Record<string, unknown>) {
  const state = String(part.state ?? '');
  if (state === 'output-available') return 'complete';
  if (state === 'output-error' || state === 'output-denied') return 'failed';
  if (state === 'approval-requested') return 'approval';
  return 'working';
}

function toolStateLabel(part: Record<string, unknown>) {
  const state = String(part.state ?? '');
  if (state === 'input-streaming') return 'preparing';
  if (state === 'approval-requested') return 'confirmation';
  if (state === 'approval-responded') return recordValue(part.approval)?.approved ? 'confirmed' : 'dismissed';
  if (state === 'output-available') return 'complete';
  if (state === 'output-error') return 'failed';
  if (state === 'output-denied') return 'dismissed';
  return 'executing';
}

function recordValue(value: unknown) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function toolDetails(part: Record<string, unknown>) {
  const details: Array<{ text: string; href?: string }> = [];
  const name = toolName(part);
  const input = recordValue(part.input);
  const output = recordValue(part.output);

  if (name === 'listApps') details.push({ text: 'Reading Apps, Services, status, CPU and memory' });
  if (name === 'getHostStatus') details.push({ text: 'Reading host CPU, memory, disk and uptime' });
  if (name === 'createApp') {
    if (typeof input?.name === 'string') details.push({ text: `Name: ${input.name}` });
    if (Array.isArray(input?.services)) {
      for (const service of input.services) {
        const value = recordValue(service);
        if (typeof value?.name === 'string' && typeof value.image === 'string') details.push({ text: `${value.name}: ${value.image}` });
      }
    }
    const ports = recordValue(input?.ports);
    if (ports) for (const [host, container] of Object.entries(ports)) details.push({ text: `Port: ${host} → ${String(container)}` });
    const volumes = recordValue(input?.volumes);
    if (volumes) for (const [source, destination] of Object.entries(volumes)) details.push({ text: `Storage: ${source} → ${String(destination)}` });
    const namedVolumes = recordValue(input?.namedVolumes);
    if (namedVolumes) for (const [source, destination] of Object.entries(namedVolumes)) details.push({ text: `Named storage: ${source} → ${String(destination)}` });
    const environment = recordValue(input?.environment);
    if (environment && Object.keys(environment).length) details.push({ text: `Environment keys: ${Object.keys(environment).join(', ')}` });
    if (typeof input?.hostname === 'string') details.push({ text: `Hostname: ${input.hostname}` });
    if (Array.isArray(output?.steps)) {
      for (const step of output.steps) if (typeof step === 'string') details.push({ text: step });
    }
    if (typeof output?.url === 'string' && /^https?:\/\//.test(output.url)) details.push({ text: output.url, href: output.url });
  }
  const appTarget = input?.appId;
  let targetedApp: AppInfo | undefined;
  if (typeof appTarget === 'string') {
    targetedApp = apps.value.find((candidate) => candidate.id === appTarget || candidate.id.startsWith(appTarget) || candidate.name === appTarget);
    const appName = typeof output?.appName === 'string' ? output.appName : targetedApp?.name;
    details.push({ text: `App: ${appName ?? appTarget}` });
  }
  const serviceTarget = input?.containerId ?? input?.serviceId;
  if (typeof serviceTarget === 'string') {
    const candidates = (targetedApp ? [targetedApp] : apps.value).flatMap((app) => app.services.map((service) => ({ app, service })));
    const match = candidates.find(({ service }) => service.id === serviceTarget || service.id.startsWith(serviceTarget) || service.serviceId === serviceTarget || service.name === serviceTarget);
    details.push({ text: `Service: ${match ? `${match.app.name} / ${match.service.name}` : serviceTarget}` });
  }
  if (name === 'getApplicationLogs' && typeof input?.tail === 'number') details.push({ text: `Recent lines: ${input.tail}` });
  if (name === 'setEnvironmentVariable' && typeof input?.name === 'string') details.push({ text: `Environment key: ${input.name}` });
  if (typeof input?.volumeName === 'string') details.push({ text: `Volume: ${input.volumeName}` });
  if (typeof input?.mountTarget === 'string') details.push({ text: `Mount: ${input.mountTarget}` });
  if (typeof input?.hostname === 'string' && name.includes('ServiceDomain')) details.push({ text: `Domain: ${input.hostname}` });
  if (name === 'listApps' && Array.isArray(part.output)) details.push({ text: `Found ${part.output.length} App${part.output.length === 1 ? '' : 's'}` });
  if (typeof part.errorText === 'string') details.push({ text: part.errorText });
  return details;
}

function environmentRequest(part: Record<string, unknown>) {
  if (toolName(part) !== 'requestEnvironmentVariable') return undefined;
  const input = recordValue(part.input);
  const output = recordValue(part.output);
  const requestId = output?.requestId;
  const serviceId = output?.serviceId ?? input?.serviceId;
  const name = output?.name ?? input?.name;
  if (typeof requestId !== 'string' || typeof serviceId !== 'string' || typeof name !== 'string') return undefined;
  const rawTargets = Array.isArray(output?.targets)
    ? output.targets
    : [{ serviceId, name }, ...(Array.isArray(input?.additionalTargets) ? input.additionalTargets : [])];
  const targets = rawTargets.flatMap((target) => {
    const candidate = recordValue(target);
    return typeof candidate?.serviceId === 'string' && typeof candidate?.name === 'string'
      ? [{ serviceId: candidate.serviceId, name: candidate.name }]
      : [];
  });
  if (!environmentRequestForms[requestId]) environmentRequestForms[requestId] = { value: '', protectedFromAI: true, saving: false, error: '' };
  return {
    requestId,
    serviceId,
    name,
    targets: targets.length ? targets : [{ serviceId, name }],
    description: typeof output?.description === 'string' ? output.description : typeof input?.description === 'string' ? input.description : '',
    status: output?.status === 'completed' ? 'completed' : 'pending',
    form: environmentRequestForms[requestId]!,
  };
}

function environmentTargetLabel(target: { serviceId: string; name: string }) {
  for (const app of apps.value) {
    const service = app.services.find((candidate) => candidate.serviceId === target.serviceId || candidate.id === target.serviceId || candidate.name === target.serviceId);
    if (service) return `${app.name} / ${service.name}: ${target.name}`;
  }
  return target.name;
}

async function submitEnvironmentRequest(part: Record<string, unknown>) {
  const request = environmentRequest(part);
  if (!request || request.status === 'completed' || !request.form.value) return;
  request.form.saving = true;
  request.form.error = '';
  try {
    const result = await api<Record<string, unknown>>(`/api/containers/${encodeURIComponent(request.serviceId)}/environment-requests/${encodeURIComponent(request.requestId)}`, {
      method: 'PUT',
      body: JSON.stringify({ value: request.form.value, protectedFromAI: request.form.protectedFromAI }),
    });
    request.form.value = '';
    part.output = result;
    await refreshDashboard();
  } catch (error) {
    request.form.error = error instanceof Error ? error.message : 'Could not save environment variable';
  } finally {
    request.form.saving = false;
  }
}

async function continueAfterInput(requestId: string) {
  if (chatBusy.value || continuedRequestIds.has(requestId)) return;
  continuedRequestIds.add(requestId);
  try {
    await sendMessage({ text: 'Continue with the task now that I provided the requested information.' });
  } catch {
    continuedRequestIds.delete(requestId);
  }
}

function approvalRequest(part: Record<string, unknown>) {
  if (part.state !== 'approval-requested') return undefined;
  const approval = recordValue(part.approval);
  return typeof approval?.id === 'string' && approval.isAutomatic !== true ? approval.id : undefined;
}

function approvalCopy(part: Record<string, unknown>) {
  const name = toolName(part);
  if (name === 'deleteManagedVolume') return { title: 'Delete this volume permanently?', detail: 'All data in this managed volume will be permanently removed.' };
  if (name === 'removeService') return { title: 'Remove this Service?', detail: 'The Service will be removed from its App. Managed persistent data will remain.' };
  if (name === 'repairStorageOwnership') return { title: 'Repair this storage ownership?', detail: 'The application may be briefly stopped while ownership is changed recursively.' };
  if (name === 'removeRouteProtection') return { title: 'Make this route public?', detail: 'Anyone who knows the URL will be able to access it without a password.' };
  return { title: 'Delete this application permanently?', detail: 'The container will be removed. Its image and managed data will remain.' };
}

async function respondToApproval(part: Record<string, unknown>, approved: boolean) {
  const id = approvalRequest(part);
  if (!id || respondingApprovalId.value) return;
  respondingApprovalId.value = id;
  try {
    await addToolApprovalResponse({
      id,
      approved,
      reason: approved ? 'User explicitly approved the requested operation' : 'User dismissed the requested operation',
    });
  } finally {
    respondingApprovalId.value = '';
  }
}

async function bootstrap() {
  loading.value = true;
  try {
    const session = await api<{ authenticated: boolean }>('/api/auth/session');
    authenticated.value = session.authenticated;
    if (authenticated.value) await loadDashboard();
  } finally {
    loading.value = false;
  }
}

async function login() {
  loginError.value = '';
  try {
    await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ accessCode: accessCode.value }) });
    authenticated.value = true;
    accessCode.value = '';
    await loadDashboard();
  } catch (error) {
    loginError.value = error instanceof Error ? error.message : 'Sign in failed';
  }
}

async function logout() {
  await api('/api/auth/logout', { method: 'POST', body: '{}' });
  clearSession();
}

function clearSession() {
  stop();
  authenticated.value = false;
  apps.value = [];
  server.value = null;
  settings.value = null;
  settingsOpen.value = false;
  logs.value = null;
  closeEnvironmentDialog();
  prompt.value = '';
  messages.value = [];
  continuedRequestIds.clear();
  agentErrorDetails.value = null;
  if (refreshTimer) window.clearInterval(refreshTimer);
}

function closeEnvironmentDialog() {
  Object.assign(environmentDialog, { container: null, variables: [], loading: false, error: '' });
  environmentSnapshot.value = '[]';
  revealedEnvironmentValues.clear();
}

function environmentSignature(variables: EnvironmentVariable[]) {
  return JSON.stringify(variables.map(({ id, name, value, protectedFromAI }) => ({ id, name, value, protectedFromAI })));
}

async function openEnvironmentDialog(container: ContainerInfo) {
  closeEnvironmentDialog();
  environmentDialog.container = container;
  environmentDialog.loading = true;
  try {
    const result = await api<{ variables: EnvironmentVariable[] }>(`/api/containers/${encodeURIComponent(container.id)}/environment`);
    if (environmentDialog.container?.id === container.id) {
      environmentDialog.variables = result.variables;
      environmentSnapshot.value = environmentSignature(result.variables);
    }
  } catch (error) {
    environmentDialog.error = error instanceof Error ? error.message : 'Could not load environment';
  } finally {
    environmentDialog.loading = false;
  }
}

function addEnvironmentVariable() {
  const now = new Date().toISOString();
  environmentDialog.variables.push({
    id: `new:${crypto.randomUUID()}`,
    serviceId: environmentDialog.container?.name ?? '',
    name: '',
    value: '',
    protectedFromAI: true,
    createdAt: now,
    updatedAt: now,
  });
}

async function saveEnvironmentChanges() {
  const container = environmentDialog.container;
  if (!container || !environmentChanges.value) return;
  environmentDialog.saving = true;
  environmentDialog.error = '';
  try {
    const result = await api<{ variables: EnvironmentVariable[] }>(`/api/containers/${encodeURIComponent(container.id)}/environment`, {
      method: 'PUT',
      body: JSON.stringify({
        variables: environmentDialog.variables.map(({ id, name, value, protectedFromAI }) => ({
          ...(!id.startsWith('new:') ? { id } : {}),
          name,
          value,
          protectedFromAI,
        })),
      }),
    });
    environmentDialog.variables = result.variables;
    environmentSnapshot.value = environmentSignature(result.variables);
    revealedEnvironmentValues.clear();
    await refreshDashboard();
  } catch (error) {
    environmentDialog.error = error instanceof Error ? error.message : 'Could not save environment changes';
  } finally {
    environmentDialog.saving = false;
  }
}

function toggleEnvironmentValue(id: string) {
  if (revealedEnvironmentValues.has(id)) revealedEnvironmentValues.delete(id);
  else revealedEnvironmentValues.add(id);
}

function deleteEnvironmentVariable(variable: EnvironmentVariable) {
  environmentDialog.variables = environmentDialog.variables.filter((candidate) => candidate.id !== variable.id);
  revealedEnvironmentValues.delete(variable.id);
}

async function loadDashboard() {
  dashboardError.value = '';
  try {
    const [newSettings, newApps, newServer] = await Promise.all([
      api<LlmSettingsResponse>('/api/settings/llm'),
      api<AppInfo[]>('/api/apps'),
      api<ServerStats>('/api/server/stats'),
    ]);
    settings.value = newSettings;
    providers.value = newSettings.providers;
    apps.value = newApps;
    server.value = newServer;
    Object.assign(settingsForm, { provider: newSettings.provider ?? '', endpoint: newSettings.endpoint ?? '', apiKey: '', model: newSettings.model ?? '', customModel: '' });
    settingsStage.value = newSettings.configured ? 'summary' : 'picker';
    if (!newSettings.configured) settingsOpen.value = true;
    if (refreshTimer) window.clearInterval(refreshTimer);
    refreshTimer = window.setInterval(refreshDashboard, 7000);
  } catch (error) {
    dashboardError.value = error instanceof Error ? error.message : 'Could not load server state';
  }
}

async function refreshDashboard() {
  if (!authenticated.value) return;
  try {
    [apps.value, server.value] = await Promise.all([
      api<AppInfo[]>('/api/apps'),
      api<ServerStats>('/api/server/stats'),
    ]);
    dashboardError.value = '';
  } catch (error) {
    dashboardError.value = error instanceof Error ? error.message : 'Refresh failed';
  }
}

function openSettings() {
  settingsStage.value = settings.value?.configured ? 'summary' : 'picker';
  settingsOpen.value = true;
}

function chooseProvider(provider: ProviderMetadata) {
  Object.assign(settingsForm, {
    provider: provider.id,
    endpoint: settings.value?.provider === provider.id ? settings.value.endpoint ?? '' : '',
    apiKey: '',
    model: settings.value?.provider === provider.id ? settings.value.model ?? '' : '',
    customModel: '',
  });
  credentialsVerified.value = false;
  availableModels.value = [];
  useCustomModel.value = false;
  settingsError.value = '';
  settingsStage.value = 'configure';
}

async function testConnection() {
  if (!settingsForm.provider) return;
  testingSettings.value = true;
  credentialsVerified.value = false;
  settingsError.value = '';
  try {
    const result = await api<{ success: boolean; models: ModelInfo[] }>('/api/settings/llm/test', {
      method: 'POST',
      body: JSON.stringify({ provider: settingsForm.provider, apiKey: settingsForm.apiKey || undefined, endpoint: settingsForm.endpoint || undefined }),
    });
    availableModels.value = result.models;
    credentialsVerified.value = true;
    if (!settingsForm.model || !result.models.some((model) => model.id === settingsForm.model)) settingsForm.model = result.models[0]?.id ?? '';
    if (!result.models.length) useCustomModel.value = true;
  } catch (error) {
    settingsError.value = error instanceof Error ? error.message : 'Could not test connection';
  } finally {
    testingSettings.value = false;
  }
}

async function saveSettings() {
  if (!settingsForm.provider || !credentialsVerified.value || !selectedModel.value) return;
  savingSettings.value = true;
  settingsError.value = '';
  try {
    settings.value = await api<PublicSettings>('/api/settings/llm', {
      method: 'PUT',
      body: JSON.stringify({ provider: settingsForm.provider, endpoint: settingsForm.endpoint || undefined, apiKey: settingsForm.apiKey || undefined, model: selectedModel.value }),
    });
    settingsForm.apiKey = '';
    settingsStage.value = 'summary';
  } catch (error) {
    settingsError.value = error instanceof Error ? error.message : 'Could not save settings';
  } finally {
    savingSettings.value = false;
  }
}

async function submitPrompt() {
  const text = prompt.value.trim();
  if (!text || chatBusy.value || !settings.value?.configured) return;
  agentStatus.value = null;
  agentErrorDetails.value = null;
  prompt.value = '';
  await sendMessage({ text });
}

async function newConversation() {
  await stop();
  messages.value = [];
  prompt.value = '';
  clearError();
  agentStatus.value = null;
  agentErrorDetails.value = null;
  continuedRequestIds.clear();
}

async function runAction(container: ContainerInfo, action: 'start' | 'stop' | 'restart' | 'delete') {
  if (action === 'delete' && !window.confirm(`Delete ${container.name}? The container will be permanently removed; its image will remain.`)) return;
  actionId.value = container.id;
  dashboardError.value = '';
  try {
    await api(`/api/containers/${encodeURIComponent(container.id)}/${action}`, {
      method: 'POST',
      body: JSON.stringify(action === 'delete' ? { confirmed: true } : {}),
    });
    await refreshDashboard();
  } catch (error) {
    dashboardError.value = error instanceof Error ? error.message : `${action} failed`;
  } finally {
    actionId.value = '';
  }
}

async function runMenuAction(event: Event, container: ContainerInfo, action: 'start' | 'stop' | 'restart' | 'delete') {
  (event.currentTarget as HTMLElement).closest('details')?.removeAttribute('open');
  await runAction(container, action);
}

async function runAppAction(app: AppInfo, action: 'start' | 'stop' | 'restart' | 'recreate' | 'delete') {
  let body: Record<string, unknown> = {};
  if (action === 'delete') {
    if (!window.confirm(`Delete ${app.name}? Its Services and private network will be removed. Persistent data will be kept.`)) return;
    body = { confirmed: true, deleteData: false };
  }
  actionId.value = app.id;
  try {
    await api(`/api/apps/${encodeURIComponent(app.id)}/${action}`, { method: 'POST', body: JSON.stringify(body) });
    await refreshDashboard();
  } catch (error) {
    dashboardError.value = error instanceof Error ? error.message : `${action} failed`;
  } finally {
    actionId.value = '';
  }
}

async function beginRenameApp(app: AppInfo) {
  editingAppId.value = app.id;
  appNameDraft.value = app.name;
  await nextTick();
  document.getElementById(`app-name-${app.id}`)?.focus();
}

function cancelRenameApp() {
  editingAppId.value = '';
  appNameDraft.value = '';
}

async function saveAppName(app: AppInfo) {
  if (editingAppId.value !== app.id) return;
  const name = appNameDraft.value.trim();
  if (!name || name === app.name) {
    cancelRenameApp();
    return;
  }
  editingAppId.value = '';
  actionId.value = app.id;
  try {
    await api(`/api/apps/${encodeURIComponent(app.id)}`, { method: 'PATCH', body: JSON.stringify({ name }) });
    await refreshDashboard();
  } catch (error) {
    dashboardError.value = error instanceof Error ? error.message : 'Rename failed';
  } finally {
    appNameDraft.value = '';
    actionId.value = '';
  }
}

async function showAppLogs(app: AppInfo) {
  logs.value = { id: app.id, name: app.name, content: '', tail: 200, search: '', reverse: false, loading: true, error: '' };
  actionId.value = app.id;
  await refreshLogs(true);
  actionId.value = '';
}

async function showLogs(container: ContainerInfo) {
  logs.value = { id: container.id, name: container.name, content: '', tail: 200, search: '', reverse: false, loading: true, error: '' };
  actionId.value = container.id;
  await refreshLogs();
  actionId.value = '';
}

async function refreshLogs(appLevel = false) {
  if (!logs.value) return;
  const current = logs.value;
  current.loading = true;
  current.error = '';
  try {
    const base = appLevel || apps.value.some((app) => app.id === current.id) ? '/api/apps' : '/api/containers';
    const result = await api<{ logs: string }>(`${base}/${encodeURIComponent(current.id)}/logs?tail=${current.tail}`);
    if (logs.value === current) current.content = result.logs;
  } catch (error) {
    if (logs.value === current) current.error = error instanceof Error ? error.message : 'Could not read logs';
  } finally {
    if (logs.value === current) current.loading = false;
  }
}

async function setPrimaryDomain(container: ContainerInfo, domain: ServiceDomain) {
  domainAction.value = `${container.id}:${domain.hostname}`;
  dashboardError.value = '';
  try {
    const base = `/api/containers/${encodeURIComponent(container.id)}/domains/${encodeURIComponent(domain.hostname)}`;
    await api(`${base}/primary`, { method: 'PUT', body: '{}' });
    await refreshDashboard();
  } catch (error) {
    dashboardError.value = error instanceof Error ? error.message : 'Could not change primary domain';
  } finally {
    domainAction.value = '';
  }
}

watch(status, (current, previous) => {
  if (current === 'ready' && previous !== 'ready') {
    agentStatus.value = null;
    void refreshDashboard();
    void nextTick(() => composerInput.value?.focus());
  }
});
watch(agentActivityLabel, (current, previous) => {
  if (current !== previous) activityElapsedSeconds.value = 0;
  if (current && !activityTimer) {
    activityTimer = window.setInterval(() => { activityElapsedSeconds.value += 1; }, 1000);
  } else if (!current && activityTimer) {
    window.clearInterval(activityTimer);
    activityTimer = undefined;
  }
}, { immediate: true });
watch(messages, () => nextTick(() => transcript.value?.scrollTo({ top: transcript.value.scrollHeight, behavior: 'smooth' })), { deep: true });
onMounted(bootstrap);
onMounted(() => window.addEventListener('halfcloud:unauthorized', clearSession));
onBeforeUnmount(() => {
  if (refreshTimer) window.clearInterval(refreshTimer);
  if (activityTimer) window.clearInterval(activityTimer);
  window.removeEventListener('halfcloud:unauthorized', clearSession);
});
</script>

<template>
  <main v-if="loading" class="loading-screen">
    <img class="brand-mark" src="/halfcloud-logo-ui.png" alt="Halfcloud">
    <p>Connecting to host</p>
  </main>

  <main v-else-if="!authenticated" class="auth-shell">
    <section class="auth-intro">
      <p class="eyebrow">HALFCLOUD / NODE 01</p>
      <h1>Your server,<br><em>on speaking terms.</em></h1>
      <p class="auth-copy">A direct line to Docker on this machine. Tell it what should be running.</p>
      <div class="auth-signal"><span></span> HTTPS connection secured</div>
    </section>
    <section class="auth-panel">
      <div class="brand"><img class="brand-mark" src="/halfcloud-logo-ui.png" alt=""><strong>HalfCloud</strong></div>
      <form @submit.prevent="login">
        <p class="step-label">ADMIN ACCESS</p>
        <h2>Sign in to this host</h2>
        <p>Use the permanent access code printed by the installer.</p>
        <label for="access-code">Access code</label>
        <input id="access-code" v-model="accessCode" autofocus autocomplete="current-password" placeholder="XXXX-XXXX" required>
        <p v-if="loginError" class="form-error">{{ loginError }}</p>
        <button class="button primary wide" type="submit">Open HalfCloud <span>→</span></button>
      </form>
    </section>
  </main>

  <main v-else class="app-shell">
    <header class="topbar">
      <div class="brand"><img class="brand-mark" src="/halfcloud-logo-ui.png" alt=""><strong>HalfCloud</strong><span class="version">0.1</span></div>
      <div class="server-health"><span class="health-dot"></span><span>HOST HEALTHY</span></div>
      <div class="header-actions">
        <div v-if="settings?.llmReady && activeProvider" class="active-model" :title="`${activeProvider.label} · ${settings.model}`">
          <img :src="activeProvider.icon" alt="">
          <span>{{ settings.model }}</span>
        </div>
        <button class="text-button" @click="openSettings">AI settings</button>
        <button class="text-button" @click="logout">Sign out</button>
      </div>
    </header>

    <nav class="mobile-tabs" aria-label="Dashboard sections" role="tablist">
      <button type="button" role="tab" :aria-selected="mobileTab === 'operator'" aria-controls="operator-panel" @click="mobileTab = 'operator'">AI Operator</button>
      <button type="button" role="tab" :aria-selected="mobileTab === 'apps'" aria-controls="apps-panel" @click="mobileTab = 'apps'">Apps</button>
      <button type="button" role="tab" :aria-selected="mobileTab === 'server'" aria-controls="server-panel" @click="mobileTab = 'server'">Server</button>
    </nav>

    <section v-if="server" id="server-panel" class="metrics-strip" :class="{ 'mobile-panel-active': mobileTab === 'server' }" role="tabpanel">
      <div><span>CPU</span><strong>{{ server.cpuPercent.toFixed(1) }}%</strong><i><b :style="{ width: `${Math.min(server.cpuPercent, 100)}%` }"></b></i></div>
      <div><span>MEMORY</span><strong>{{ formatBytes(server.memoryUsed) }} / {{ formatBytes(server.memoryTotal) }}</strong><i><b :style="{ width: `${server.memoryTotal ? server.memoryUsed / server.memoryTotal * 100 : 0}%` }"></b></i></div>
      <div><span>DISK</span><strong>{{ formatBytes(server.diskUsed) }} / {{ formatBytes(server.diskTotal) }}</strong><i><b :style="{ width: `${server.diskTotal ? server.diskUsed / server.diskTotal * 100 : 0}%` }"></b></i></div>
      <div class="uptime"><span>UPTIME</span><strong>{{ formatUptime(server.uptimeSeconds) }}</strong></div>
    </section>

    <p v-if="dashboardError" class="global-error">{{ dashboardError }}</p>

    <div class="workspace">
      <section id="operator-panel" class="chat-panel" :class="{ 'mobile-panel-active': mobileTab === 'operator' }" role="tabpanel">
        <div class="section-heading">
           <div><p class="eyebrow">AI OPERATOR</p><h1>Ask HalfCloud</h1></div>
           <div class="chat-heading-actions">
             <button class="new-conversation-button" type="button" @click="newConversation">New conversation</button>
           </div>
        </div>
        <div ref="transcript" class="transcript">
          <div v-if="messages.length === 0" class="empty-chat">
            <img class="empty-chat-logo" src="/halfcloud-logo-ui.png" alt="HalfCloud">
            <h2>What should be running?</h2>
            <p>Describe the outcome. HalfCloud will inspect Docker, choose sensible defaults, and carry it out.</p>
            <div class="suggestions">
              <button @click="prompt = 'Run nginx'">Run nginx</button>
              <button @click="prompt = 'How is my server doing?'">How is my server doing?</button>
              <button @click="prompt = 'Inspect my Apps and tell me what needs attention'">Find Apps that need attention</button>
            </div>
          </div>
          <article v-for="message in messages" :key="message.id" class="message" :class="message.role">
            <span class="message-author">{{ message.role === 'user' ? 'YOU' : 'HALFCLOUD' }}</span>
            <template v-for="group in groupMessageParts(message.parts)" :key="group.key">
              <div v-if="group.kind === 'text'" class="message-text" v-html="renderMarkdown(group.part.text)"></div>
              <div v-else class="tool-event" :class="toolState(latestTool(group.parts))">
                <span class="tool-icon">{{ toolState(latestTool(group.parts)) === 'complete' ? '✓' : toolState(latestTool(group.parts)) === 'failed' ? '!' : '·' }}</span>
                <div class="tool-content">
                  <span>{{ toolLabel(latestTool(group.parts)) }}</span>
                  <ul v-if="toolGroupDetails(group.parts).length">
                    <li v-for="(detail, detailIndex) in toolGroupDetails(group.parts)" :key="detailIndex"><a v-if="detail.href" :href="detail.href" target="_blank" rel="noopener noreferrer">{{ detail.text }}</a><template v-else>{{ detail.text }}</template></li>
                  </ul>
                  <template v-for="(part, partIndex) in group.parts" :key="partIndex">
                  <div v-if="environmentRequest(part)" class="environment-request-widget">
                    <template v-if="environmentRequest(part)!.status === 'completed'">
                      <strong>{{ environmentRequest(part)!.targets.length === 1 ? environmentRequest(part)!.name : `Configured for ${environmentRequest(part)!.targets.length} variables` }}</strong>
                      <code v-for="target in environmentRequest(part)!.targets" :key="`${target.serviceId}:${target.name}`">{{ environmentTargetLabel(target) }}</code>
                      <p>Configured directly in HalfCloud. The value was not added to this conversation.</p>
                      <button
                        v-if="!continuedRequestIds.has(environmentRequest(part)!.requestId)"
                        class="button primary"
                        type="button"
                        :disabled="chatBusy"
                        @click="continueAfterInput(environmentRequest(part)!.requestId)"
                      >Continue</button>
                    </template>
                    <form v-else @submit.prevent="submitEnvironmentRequest(part)">
                      <strong>Environment variable required</strong>
                      <code v-for="target in environmentRequest(part)!.targets" :key="`${target.serviceId}:${target.name}`">{{ environmentTargetLabel(target) }}</code>
                      <p v-if="environmentRequest(part)!.description">{{ environmentRequest(part)!.description }}</p>
                      <label>Value</label>
                      <input
                        type="password"
                        autocomplete="off"
                        required
                        :value="environmentRequest(part)!.form.value"
                        @input="environmentRequest(part)!.form.value = ($event.target as HTMLInputElement).value"
                      >
                      <label class="protection-toggle">
                        <input
                          type="checkbox"
                          :checked="environmentRequest(part)!.form.protectedFromAI"
                          @change="environmentRequest(part)!.form.protectedFromAI = ($event.target as HTMLInputElement).checked"
                        >
                        <span>Protect this value from AI</span>
                      </label>
                      <p>This value is submitted directly to HalfCloud and is not included in the AI conversation.</p>
                      <p v-if="environmentRequest(part)!.form.error" class="form-error">{{ environmentRequest(part)!.form.error }}</p>
                      <button class="button primary" type="submit" :disabled="environmentRequest(part)!.form.saving">
                        {{ environmentRequest(part)!.form.saving ? 'Saving…' : 'Save' }}
                      </button>
                    </form>
                  </div>
                  <div v-if="basicAuthRequest(part)" class="environment-request-widget basic-auth-widget">
                    <template v-if="basicAuthRequest(part)!.status === 'completed'">
                      <strong>Password protection enabled</strong>
                      <p>Credentials were configured directly in HalfCloud and were not added to this conversation.</p>
                      <button
                        v-if="!continuedRequestIds.has(basicAuthRequest(part)!.requestId)"
                        class="button primary"
                        type="button"
                        :disabled="chatBusy"
                        @click="continueAfterInput(basicAuthRequest(part)!.requestId)"
                      >Continue</button>
                    </template>
                    <form v-else @submit.prevent="submitBasicAuthRequest(part)">
                      <strong>{{ basicAuthRequest(part)!.changing ? 'Change route credentials' : 'Protect with password' }}</strong>
                      <p>{{ basicAuthRequest(part)!.hostname }}</p>
                      <label>Username</label>
                      <input
                        :value="basicAuthRequest(part)!.form.username"
                        autocomplete="username"
                        maxlength="128"
                        pattern="[A-Za-z0-9][A-Za-z0-9._@-]*"
                        required
                        @input="basicAuthRequest(part)!.form.username = ($event.target as HTMLInputElement).value"
                      >
                      <label>Password</label>
                      <input
                        type="password"
                        autocomplete="new-password"
                        minlength="8"
                        maxlength="1024"
                        required
                        :value="basicAuthRequest(part)!.form.password"
                        @input="basicAuthRequest(part)!.form.password = ($event.target as HTMLInputElement).value"
                      >
                      <p>At least 8 characters. The password goes directly to HalfCloud, is immediately hashed, and is never sent to AI.</p>
                      <p v-if="basicAuthRequest(part)!.form.error" class="form-error">{{ basicAuthRequest(part)!.form.error }}</p>
                      <button class="button primary" type="submit" :disabled="basicAuthRequest(part)!.form.saving">
                        {{ basicAuthRequest(part)!.form.saving ? 'Applying…' : basicAuthRequest(part)!.changing ? 'Change credentials' : 'Enable protection' }}
                      </button>
                    </form>
                  </div>
                  <div v-if="approvalRequest(part)" class="approval-widget">
                    <strong>{{ approvalCopy(part).title }}</strong>
                    <p>{{ approvalCopy(part).detail }}</p>
                    <div>
                      <button class="confirm" type="button" :disabled="Boolean(respondingApprovalId)" @click="respondToApproval(part, true)">Continue</button>
                      <button type="button" :disabled="Boolean(respondingApprovalId)" @click="respondToApproval(part, false)">Dismiss</button>
                    </div>
                  </div>
                  </template>
                </div>
                <small>{{ toolStateLabel(latestTool(group.parts)) }}</small>
              </div>
            </template>
          </article>
          <div v-if="chatError" class="form-error chat-error" role="alert">
            <span>{{ chatError.message }}</span>
            <button v-if="agentErrorDetails" class="error-info" type="button" aria-label="Provider error details">
              i
              <span class="error-tooltip" role="tooltip"><b>Provider</b> {{ agentErrorDetails.provider }}<br><b>Model</b> {{ agentErrorDetails.model }}<br><b>Request ID</b> {{ agentErrorDetails.requestId }}<br><b>Error</b> {{ agentErrorDetails.details }}</span>
            </button>
          </div>
        </div>
        <div class="conversation-footer">
          <form class="composer" @submit.prevent="submitPrompt">
            <textarea ref="composerInput" v-model="prompt" :disabled="!settings?.llmReady || chatBusy" rows="2" :placeholder="!settings?.llmReady ? 'Configure an AI provider to start…' : chatBusy ? 'HalfCloud is working…' : 'Tell HalfCloud what should be running…'" @keydown.enter.exact.prevent="submitPrompt"></textarea>
            <button v-if="chatBusy" class="send-button stop" type="button" title="Stop" @click="stop">■</button>
            <button v-else class="send-button" type="submit" :disabled="!prompt.trim() || !settings?.llmReady" title="Send">↑</button>
          </form>
          <div class="conversation-loader" :class="{ active: chatBusy }" role="status" aria-live="polite">
            <span>{{ agentActivityLabel }}<template v-if="agentActivityLabel && activityElapsedSeconds"> · {{ activityElapsedSeconds }}s</template></span>
            <i aria-hidden="true"><b></b></i>
          </div>
        </div>
      </section>

      <section id="apps-panel" class="containers-panel" :class="{ 'mobile-panel-active': mobileTab === 'apps' }" role="tabpanel">
        <div class="section-heading compact">
          <div><p class="eyebrow">DEPLOYED SYSTEMS</p><h2>Apps <sup>{{ apps.length }}</sup></h2></div>
          <button class="refresh-button" title="Refresh" @click="refreshDashboard">↻</button>
        </div>
        <div v-if="apps.length === 0" class="empty-containers">
          <span>00</span><p>No Apps yet.</p><small>Ask HalfCloud to deploy one.</small>
        </div>
        <article v-for="app in apps" :key="app.id" class="container-card app-card" :class="{ 'multi-service': app.services.length > 1, expanded: expandedAppIds.has(app.id) }">
          <div class="app-card-summary">
            <button
              class="app-card-toggle"
              type="button"
              :aria-label="`${expandedAppIds.has(app.id) ? 'Collapse' : 'Expand'} ${app.name}`"
              :aria-expanded="expandedAppIds.has(app.id)"
              :aria-controls="`app-details-${app.id}`"
              @click="toggleApp(app.id)"
            ></button>
            <strong>{{ app.name }}</strong>
            <span class="app-card-domains">
              <template v-for="service in app.services" :key="service.serviceId">
                <a
                  v-for="domain in service.domains"
                  :key="domain.hostname"
                  :href="`https://${domain.hostname}`"
                  target="_blank"
                  rel="noopener noreferrer"
                  :class="{ protected: domain.access.type === 'basic_auth' }"
                  :aria-label="domain.access.type === 'basic_auth' ? `${domain.hostname}, password protected` : domain.hostname"
                  :title="domain.access.type === 'basic_auth' ? 'Password protected' : undefined"
                >
                  <svg v-if="domain.access.type === 'basic_auth'" aria-hidden="true" viewBox="0 0 12 12"><rect x="2.5" y="5" width="7" height="5.5" rx="1"></rect><path d="M4 5V3.5a2 2 0 0 1 4 0V5"></path></svg>
                  {{ domain.hostname }}
                </a>
              </template>
            </span>
            <svg aria-hidden="true" viewBox="0 0 12 12"><path d="m3 4.5 3 3 3-3"></path></svg>
          </div>
          <div v-show="expandedAppIds.has(app.id)" :id="`app-details-${app.id}`" class="app-card-expanded">
            <div class="container-title app-title">
            <span class="status-dot" :class="app.status === 'running' ? 'running' : 'exited'"></span>
            <div class="app-name-block">
              <div class="app-name-row">
                <input
                  v-if="editingAppId === app.id"
                  :id="`app-name-${app.id}`"
                  v-model="appNameDraft"
                  class="app-name-input"
                  maxlength="128"
                  aria-label="App name"
                  @blur="saveAppName(app)"
                  @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
                  @keydown.escape.prevent="cancelRenameApp"
                >
                <h3 v-else>{{ app.name }}</h3>
                <button v-if="editingAppId !== app.id" class="rename-button" type="button" title="Rename App" :aria-label="`Rename ${app.name}`" @click="beginRenameApp(app)">
                  <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 20h4l11-11a2.8 2.8 0 0 0-4-4L4 16v4Z"></path><path d="m13.5 6.5 4 4"></path></svg>
                </button>
              </div>
              <p>{{ app.services.length }} service{{ app.services.length === 1 ? '' : 's' }}</p>
            </div>
            <span class="state-label">{{ app.status.replace('_', ' ') }}</span>
            </div>
            <div class="container-data">
            <div><span>SERVICES</span><strong>{{ app.runningServices }}/{{ app.services.length }} running</strong></div>
            <div><span>CPU</span><strong>{{ app.cpuPercent.toFixed(2) }}%</strong></div>
            <div><span>RAM</span><strong>{{ formatBytes(app.memoryUsed) }}</strong></div>
            </div>
            <div class="app-services" :class="{ single: app.services.length === 1 }">
            <section v-for="service in app.services" :key="service.serviceId" class="service-card">
              <div v-if="app.services.length > 1" class="container-title service-title">
                <span class="status-dot" :class="service.state"></span>
                <div><h3>{{ service.name }}</h3><p>{{ service.image }}</p></div>
                <span class="state-label">{{ service.state }}</span>
              </div>
              <p v-else class="single-service-image">{{ service.image }}</p>
              <section v-if="service.domains.length" class="domains-block">
                <div class="domains-heading"><span>DOMAINS{{ app.services.length > 1 ? ` · ${service.name}` : '' }}</span></div>
                <div v-for="domain in service.domains" :key="domain.hostname" class="domain-row">
                  <span class="domain-state" :class="domain.state"></span>
                  <div class="domain-name"><strong>{{ domain.hostname }}</strong><small><b v-if="domain.primary">Primary</b><b v-if="domain.managed">HalfCloud domain</b><span class="access-state" :class="domain.access.type">{{ domain.access.type === 'basic_auth' ? 'Password protected' : 'Public' }}</span><span>{{ domain.httpsReady ? 'HTTPS ready' : domain.dnsConfigured ? 'HTTPS pending' : `Point DNS to ${domain.dnsTarget || 'this server'}` }}</span></small></div>
                  <div class="domain-actions"><a :href="`https://${domain.hostname}`" target="_blank" rel="noopener noreferrer">Open</a><button v-if="!domain.primary" :disabled="domainAction === `${service.id}:${domain.hostname}`" @click="setPrimaryDomain(service, domain)">Make primary</button></div>
                </div>
              </section>
              <div v-else class="service-endpoint private">
                <svg aria-hidden="true" viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="11" rx="2"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3"></path></svg>
                <span><small>PRIVATE IN THIS APP</small><strong>{{ privateAddresses(service).length ? privateAddresses(service).join(', ') : `${service.name}:<port>` }}</strong></span>
              </div>
              <div class="container-actions service-actions">
                <button class="environment-button" :disabled="actionId === service.id" @click="openEnvironmentDialog(service)">Environment</button>
                <button v-if="app.services.length > 1" class="logs-button" :disabled="actionId === service.id" @click="showLogs(service)">Logs</button>
                <button v-if="app.services.length > 1" :disabled="actionId === service.id" @click="runAction(service, 'restart')">Restart</button>
              </div>
            </section>
            </div>
            <div class="container-actions app-actions">
            <button class="logs-button" :disabled="actionId === app.id" @click="showAppLogs(app)">Logs</button>
            <details class="actions-menu">
              <summary>App actions <svg aria-hidden="true" viewBox="0 0 12 12"><path d="m3 4.5 3 3 3-3"></path></svg></summary>
              <div class="actions-menu-list">
                <button v-if="app.status === 'stopped'" :disabled="actionId === app.id" @click="runAppAction(app, 'start')">Start all</button>
                <button v-else :disabled="actionId === app.id" @click="runAppAction(app, 'stop')">Stop all</button>
                <button :disabled="actionId === app.id" @click="runAppAction(app, 'restart')">Restart all</button>
                <button :disabled="actionId === app.id" @click="runAppAction(app, 'recreate')">Recreate all</button>
                <button class="danger" :disabled="actionId === app.id" @click="runAppAction(app, 'delete')">Delete App</button>
              </div>
            </details>
            </div>
          </div>
        </article>
      </section>
    </div>

    <div v-if="settingsOpen" class="modal-backdrop" @click.self="settings?.configured && (settingsOpen = false)">
      <section class="modal settings-modal">
        <button v-if="settings?.configured" class="modal-close" @click="settingsOpen = false">×</button>
        <template v-if="settingsStage === 'summary' && settings?.configured">
          <p class="eyebrow">SETTINGS / AI PROVIDER</p>
          <h2>AI Provider</h2>
          <div class="provider-summary">
            <img v-if="activeProvider" :src="activeProvider.icon" alt="" @error="($event.target as HTMLImageElement).hidden = true">
            <div><span>Provider</span><strong>{{ activeProvider?.label }}</strong></div>
            <div><span>Model</span><strong>{{ settings.model }}</strong></div>
            <div><span>Status</span><strong class="connected"><i></i> Connected</strong></div>
            <div><span>API key</span><strong>••••••••••••</strong></div>
          </div>
          <div class="verification-list">
            <span>✓ Connection verified</span>
            <span v-if="settings.capabilities?.streaming">✓ Streaming supported</span>
            <span v-if="settings.capabilities?.tools">✓ Tool calling supported</span>
          </div>
          <div class="settings-actions">
            <button v-if="activeProvider" class="button" type="button" @click="chooseProvider(activeProvider)">Change model or key</button>
            <button class="button" type="button" @click="settingsStage = 'picker'">Change provider</button>
            <button class="button primary" type="button" @click="settingsOpen = false">Continue</button>
          </div>
        </template>

        <template v-else-if="settingsStage === 'picker'">
          <p class="eyebrow">AI SETUP</p>
          <h2>Choose your AI provider</h2>
          <p>Your provider powers the HalfCloud operator. You can change it later without reinstalling.</p>
          <div class="provider-grid">
            <button v-for="provider in providers" :key="provider.id" type="button" @click="chooseProvider(provider)">
              <span class="provider-icon-shell">
                <img :src="provider.icon" :alt="`${provider.label} icon`" @error="($event.target as HTMLImageElement).hidden = true">
                <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3 14.4 9.6 21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4L12 3Z"></path></svg>
              </span>
              <strong>{{ provider.label }}</strong>
            </button>
          </div>
        </template>

        <template v-else>
          <button class="settings-back" type="button" @click="settingsStage = 'picker'">← All providers</button>
          <p class="eyebrow">AI PROVIDER</p>
          <h2>{{ selectedProvider?.label }}</h2>
          <p>The API key stays on this VPS. It is never returned to the browser or exposed to the agent.</p>
          <form @submit.prevent="saveSettings">
            <template v-if="selectedProvider?.requiresEndpoint">
              <label for="endpoint">Endpoint</label>
              <input id="endpoint" v-model.trim="settingsForm.endpoint" type="url" placeholder="https://resource.openai.azure.com/openai/v1/" required @input="credentialsVerified = false">
              <small class="field-help">Use the OpenAI v1-compatible Azure Foundry endpoint ending in /openai/v1/.</small>
            </template>
            <label for="api-key">API key</label>
            <input id="api-key" v-model="settingsForm.apiKey" type="password" autocomplete="new-password" :placeholder="settings?.provider === settingsForm.provider ? '•••••••••••• (leave blank to keep)' : 'Enter API key'" :required="settings?.provider !== settingsForm.provider" @input="credentialsVerified = false">
            <button class="test-connection" type="button" :disabled="testingSettings || !settingsForm.provider || (!settingsForm.apiKey && settings?.provider !== settingsForm.provider)" @click="testConnection">
              {{ testingSettings ? 'Testing…' : credentialsVerified ? '✓ Connected' : 'Test connection' }}
            </button>

            <template v-if="credentialsVerified">
              <label for="model">Model</label>
              <select id="model" v-model="settingsForm.model" :disabled="useCustomModel" required>
                <option value="" disabled>Select a model</option>
                <option v-for="model in availableModels" :key="model.id" :value="model.id">
                  {{ model.name || model.id }}{{ model.id === selectedProvider?.recommendedModel ? ' — Recommended' : '' }}
                </option>
              </select>
              <label class="custom-model-toggle"><input v-model="useCustomModel" type="checkbox"> Other / Custom model</label>
              <template v-if="useCustomModel">
                <label for="custom-model">Model ID</label>
                <input id="custom-model" v-model.trim="settingsForm.customModel" autocomplete="off" placeholder="Provider model ID" required>
              </template>
              <div class="compatibility-note"><span>Next check</span><strong>Streaming and tool calling</strong><p>The active configuration changes only after this model passes both checks.</p></div>
            </template>
            <p v-if="settingsError" class="form-error">{{ settingsError }}</p>
            <button v-if="credentialsVerified" class="button primary wide" :disabled="savingSettings || !selectedModel" type="submit">{{ savingSettings ? 'Verifying model…' : 'Verify model and save' }}</button>
          </form>
        </template>
      </section>
    </div>

    <div v-if="logs" class="modal-backdrop" @click.self="logs = null">
      <section class="modal logs-modal">
        <button class="modal-close" @click="logs = null">×</button>
        <p class="eyebrow">RECENT OUTPUT / {{ logs.tail }} LINES</p>
        <h2>{{ logs.name }} logs</h2>
        <div class="logs-toolbar">
          <label class="logs-search">
            <span>Search logs</span>
            <span class="logs-search-field">
              <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"></circle><path d="m16 16 4 4"></path></svg>
              <input v-model="logs.search" type="search" placeholder="Filter log lines…" autocomplete="off">
            </span>
          </label>
          <label class="logs-lines">
            <span>Lines</span>
            <select v-model.number="logs.tail" :disabled="logs.loading" @change="refreshLogs()">
              <option :value="200">200</option>
              <option :value="500">500</option>
              <option :value="1000">1,000</option>
            </select>
          </label>
          <label class="logs-reverse" title="Show the latest log lines first">
            <input v-model="logs.reverse" type="checkbox">
            <span class="switch-track" aria-hidden="true"><i></i></span>
            <span>Reverse</span>
          </label>
          <button class="logs-refresh" :class="{ loading: logs.loading }" :disabled="logs.loading" type="button" @click="refreshLogs()">
            <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7"></path><path d="M20 5v6h-6"></path></svg>
            Refresh
          </button>
        </div>
        <div class="logs-output">
          <p v-if="logs.loading && !logs.content" class="logs-state">Loading logs…</p>
          <p v-else-if="logs.error && !logs.content" class="logs-state error">{{ logs.error }}</p>
          <template v-else>
            <p v-if="logs.error" class="logs-refresh-error" role="alert">{{ logs.error }}</p>
            <pre>{{ visibleLogs }}</pre>
          </template>
        </div>
      </section>
    </div>

    <div v-if="environmentDialog.container" class="modal-backdrop" @click.self="closeEnvironmentDialog">
      <section class="modal environment-modal">
        <button class="modal-close" @click="closeEnvironmentDialog">×</button>
        <p class="eyebrow">SERVICE CONFIGURATION</p>
        <h2>{{ environmentDialog.container.name }} environment</h2>
        <div class="protection-explanation"><strong>Protected from AI</strong><span>HalfCloud removes protected values from context just before it is sent to AI. The AI can still see variable names and whether they are configured.</span></div>

        <p v-if="environmentDialog.loading" class="environment-empty">Loading environment…</p>
        <form v-else class="environment-editor" @submit.prevent="saveEnvironmentChanges">
          <div class="environment-list">
            <div class="environment-list-heading"><span>Name</span><span>Value</span><span>Protect from AI</span><span></span></div>
            <div v-for="variable in environmentDialog.variables" :key="variable.id" class="environment-row">
              <input v-model.trim="variable.name" :disabled="environmentDialog.saving" aria-label="Variable name" autocomplete="off" placeholder="VARIABLE_NAME" pattern="[A-Za-z_][A-Za-z0-9_]*" required>
              <div class="environment-value-field">
                <input v-model="variable.value" :disabled="environmentDialog.saving" :type="revealedEnvironmentValues.has(variable.id) ? 'text' : 'password'" :aria-label="`${variable.name || 'New variable'} value`" autocomplete="new-password">
                <button type="button" :disabled="environmentDialog.saving" @click="toggleEnvironmentValue(variable.id)">{{ revealedEnvironmentValues.has(variable.id) ? 'Hide' : 'Show' }}</button>
              </div>
              <label class="environment-protection" :title="variable.protectedFromAI ? 'This value is omitted from AI data' : 'This value is visible to AI'">
                <input v-model="variable.protectedFromAI" :disabled="environmentDialog.saving" type="checkbox">
                <span v-if="variable.protectedFromAI">Protected</span>
              </label>
              <button class="environment-delete danger" type="button" :disabled="environmentDialog.saving" @click="deleteEnvironmentVariable(variable)">Delete</button>
            </div>
            <p v-if="!environmentDialog.variables.length" class="environment-empty">No environment variables configured.</p>
          </div>
          <p v-if="environmentDialog.error" class="form-error">{{ environmentDialog.error }}</p>
          <div class="environment-controls">
            <button class="environment-add-button" type="button" :disabled="environmentDialog.saving" @click="addEnvironmentVariable">+ Add new</button>
            <div v-if="environmentDialog.variables.length || environmentChanges" class="environment-save-bar">
              <span>{{ environmentChanges ? 'Unsaved environment changes' : 'Environment is up to date' }}</span>
              <button class="button primary" :class="{ loading: environmentDialog.saving }" type="submit" :disabled="!environmentChanges || environmentDialog.saving">{{ environmentDialog.saving ? 'Applying…' : 'Save changes' }}</button>
            </div>
          </div>
        </form>
      </section>
    </div>
  </main>
</template>
