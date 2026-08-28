<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useChat } from '@ai-sdk/vue';
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses } from 'ai';
import MarkdownIt from 'markdown-it';
import { api, type ContainerInfo, type EnvironmentVariable, type PublicSettings, type ServerStats, type ServiceDomain } from './api';

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
const settingsForm = reactive({ endpoint: '', apiKey: '', deployment: 'gpt-5.6-sol' });
const settingsOpen = ref(false);
const savingSettings = ref(false);
const settingsError = ref('');
const containers = ref<ContainerInfo[]>([]);
const server = ref<ServerStats | null>(null);
const dashboardError = ref('');
const actionId = ref('');
const domainAction = ref('');
const domainDialog = reactive<{ container: ContainerInfo | null; hostname: string; error: string; saving: boolean }>({ container: null, hostname: '', error: '', saving: false });
const environmentDialog = reactive<{
  container: ContainerInfo | null;
  variables: EnvironmentVariable[];
  loading: boolean;
  error: string;
  name: string;
  value: string;
  protectedFromAI: boolean;
  saving: boolean;
}>({ container: null, variables: [], loading: false, error: '', name: '', value: '', protectedFromAI: true, saving: false });
const environmentSnapshot = ref('[]');
const revealedEnvironmentValues = reactive(new Set<string>());
const environmentRequestForms = reactive<Record<string, { value: string; protectedFromAI: boolean; saving: boolean; error: string }>>({});
const logs = ref<{ id: string; name: string; content: string; tail: number; search: string; reverse: boolean; loading: boolean; error: string } | null>(null);
const prompt = ref('');
const transcript = ref<HTMLElement>();
const composerInput = ref<HTMLTextAreaElement>();
const respondingApprovalId = ref('');
let refreshTimer: number | undefined;

const authenticatedFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  if (response.status === 401) window.dispatchEvent(new Event('halfcloud:unauthorized'));
  return response;
};

const { messages, sendMessage, status, error: chatError, stop, clearError, addToolApprovalResponse } = useChat({
  transport: new DefaultChatTransport({ api: '/api/chat', fetch: authenticatedFetch }),
  sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
});

const chatBusy = computed(() => status.value === 'submitted' || status.value === 'streaming');
const environmentChanges = computed(() => environmentSnapshot.value !== environmentSignature(environmentDialog.variables));
const visibleLogs = computed(() => {
  if (!logs.value?.content) return 'No recent logs.';
  const search = logs.value.search.trim().toLowerCase();
  let lines = logs.value.content.split(/\r?\n/);
  if (search) lines = lines.filter((line) => line.toLowerCase().includes(search));
  if (logs.value.reverse) lines.reverse();
  return lines.join('\n') || 'No matching log lines.';
});

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

function toolLabel(part: Record<string, unknown>) {
  const name = toolName(part);
  const labels: Record<string, string> = {
    listContainers: 'Inspecting applications', createApplication: 'Creating application', startApplication: 'Starting application',
    stopApplication: 'Stopping application', restartApplication: 'Restarting application', deleteApplication: 'Deleting application',
    getApplicationLogs: 'Reading application logs', getApplicationStatus: 'Inspecting application', getHostStatus: 'Inspecting host',
    setEnvironmentVariable: 'Updating application environment', listEnvironment: 'Inspecting application environment',
    inspectContainer: 'Inspecting application', requestEnvironmentVariable: 'Requesting an environment variable',
    listManagedVolumes: 'Inspecting managed storage', inspectManagedVolume: 'Inspecting managed volume',
    reconcileManagedVolume: 'Reconciling managed volume', deleteManagedVolume: 'Deleting managed volume',
    repairStorageOwnership: 'Repairing storage ownership',
    listServiceDomains: 'Inspecting service domains', addServiceDomain: 'Adding service domain',
    removeServiceDomain: 'Removing service domain', setPrimaryServiceDomain: 'Changing primary domain',
    getContainerLogs: 'Reading logs', getContainerStats: 'Reading container metrics', getServerStats: 'Reading server metrics',
  };
  return labels[name] ?? name;
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
  const target = input?.containerId ?? input?.serviceId;

  if (name === 'listContainers') details.push({ text: 'Reading status, published ports, CPU and memory' });
  if (name === 'getHostStatus') details.push({ text: 'Reading host CPU, memory, disk and uptime' });
  if (name === 'createApplication') {
    if (typeof input?.name === 'string') details.push({ text: `Name: ${input.name}` });
    if (typeof input?.image === 'string') details.push({ text: `Image: ${input.image}` });
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
  if (typeof target === 'string') details.push({ text: `Application: ${target}` });
  if (name === 'getApplicationLogs' && typeof input?.tail === 'number') details.push({ text: `Recent lines: ${input.tail}` });
  if (name === 'setEnvironmentVariable' && typeof input?.name === 'string') details.push({ text: `Environment key: ${input.name}` });
  if (typeof input?.volumeName === 'string') details.push({ text: `Volume: ${input.volumeName}` });
  if (typeof input?.mountTarget === 'string') details.push({ text: `Mount: ${input.mountTarget}` });
  if (typeof input?.hostname === 'string' && name.includes('ServiceDomain')) details.push({ text: `Domain: ${input.hostname}` });
  if (name === 'listContainers' && Array.isArray(part.output)) details.push({ text: `Found ${part.output.length} managed application${part.output.length === 1 ? '' : 's'}` });
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
  if (!environmentRequestForms[requestId]) environmentRequestForms[requestId] = { value: '', protectedFromAI: true, saving: false, error: '' };
  return {
    requestId,
    serviceId,
    name,
    description: typeof output?.description === 'string' ? output.description : typeof input?.description === 'string' ? input.description : '',
    status: output?.status === 'completed' ? 'completed' : 'pending',
    form: environmentRequestForms[requestId]!,
  };
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

function approvalRequest(part: Record<string, unknown>) {
  if (part.state !== 'approval-requested') return undefined;
  const approval = recordValue(part.approval);
  return typeof approval?.id === 'string' && approval.isAutomatic !== true ? approval.id : undefined;
}

function approvalCopy(part: Record<string, unknown>) {
  const name = toolName(part);
  if (name === 'deleteManagedVolume') return { title: 'Delete this volume permanently?', detail: 'All data in this managed volume will be permanently removed.' };
  if (name === 'repairStorageOwnership') return { title: 'Repair this storage ownership?', detail: 'The application may be briefly stopped while ownership is changed recursively.' };
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
  containers.value = [];
  server.value = null;
  settings.value = null;
  settingsOpen.value = false;
  logs.value = null;
  closeEnvironmentDialog();
  prompt.value = '';
  messages.value = [];
  if (refreshTimer) window.clearInterval(refreshTimer);
}

function resetEnvironmentForm() {
  Object.assign(environmentDialog, { name: '', value: '', protectedFromAI: true, saving: false });
}

function closeEnvironmentDialog() {
  Object.assign(environmentDialog, { container: null, variables: [], loading: false, error: '' });
  environmentSnapshot.value = '[]';
  revealedEnvironmentValues.clear();
  resetEnvironmentForm();
}

function environmentSignature(variables: EnvironmentVariable[]) {
  return JSON.stringify(variables.map(({ id, name, value, protectedFromAI }) => ({ id, name, value, protectedFromAI })));
}

async function openEnvironmentDialog(container: ContainerInfo) {
  closeEnvironmentDialog();
  environmentDialog.container = container;
  environmentDialog.loading = true;
  try {
    const result = await api<{ variables: EnvironmentVariable[] }>(`/api/containers/${encodeURIComponent(container.name)}/environment`);
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

function sensitiveEnvironmentName(name: string) {
  return /(?:PASSWORD|PASS|SECRET|TOKEN|KEY|API_KEY|PRIVATE|CREDENTIAL|AUTH|DATABASE_URL)/i.test(name);
}

async function saveEnvironmentVariable() {
  const container = environmentDialog.container;
  if (!container) return;
  environmentDialog.saving = true;
  environmentDialog.error = '';
  try {
    const variable = await api<EnvironmentVariable>(`/api/containers/${encodeURIComponent(container.name)}/environment/new`, {
      method: 'PUT',
      body: JSON.stringify({ name: environmentDialog.name, value: environmentDialog.value, protectedFromAI: environmentDialog.protectedFromAI }),
    });
    const index = environmentDialog.variables.findIndex((candidate) => candidate.id === variable.id);
    if (index >= 0) environmentDialog.variables[index] = variable;
    else environmentDialog.variables.push(variable);
    environmentSnapshot.value = environmentSignature(environmentDialog.variables);
    resetEnvironmentForm();
    await refreshDashboard();
  } catch (error) {
    environmentDialog.error = error instanceof Error ? error.message : 'Could not save environment variable';
  } finally {
    environmentDialog.saving = false;
  }
}

async function saveEnvironmentChanges() {
  const container = environmentDialog.container;
  if (!container || !environmentChanges.value) return;
  environmentDialog.saving = true;
  environmentDialog.error = '';
  try {
    const result = await api<{ variables: EnvironmentVariable[] }>(`/api/containers/${encodeURIComponent(container.name)}/environment`, {
      method: 'PUT',
      body: JSON.stringify({ variables: environmentDialog.variables }),
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

async function deleteEnvironmentVariable(variable: EnvironmentVariable) {
  const container = environmentDialog.container;
  if (!container || !window.confirm(`Delete ${variable.name} from ${container.name}? The container will be recreated.`)) return;
  environmentDialog.saving = true;
  environmentDialog.error = '';
  try {
    await api(`/api/containers/${encodeURIComponent(container.name)}/environment/${encodeURIComponent(variable.id)}`, { method: 'DELETE', body: '{}' });
    environmentDialog.variables = environmentDialog.variables.filter((candidate) => candidate.id !== variable.id);
    environmentSnapshot.value = environmentSignature(environmentDialog.variables);
    revealedEnvironmentValues.delete(variable.id);
    await refreshDashboard();
  } catch (error) {
    environmentDialog.error = error instanceof Error ? error.message : 'Could not delete environment variable';
  } finally {
    environmentDialog.saving = false;
  }
}

async function loadDashboard() {
  dashboardError.value = '';
  try {
    const [newSettings, newContainers, newServer] = await Promise.all([
      api<PublicSettings>('/api/settings'),
      api<ContainerInfo[]>('/api/containers'),
      api<ServerStats>('/api/server/stats'),
    ]);
    settings.value = newSettings;
    containers.value = newContainers;
    server.value = newServer;
    Object.assign(settingsForm, { endpoint: newSettings.endpoint, apiKey: '', deployment: newSettings.deployment });
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
    [containers.value, server.value] = await Promise.all([
      api<ContainerInfo[]>('/api/containers'),
      api<ServerStats>('/api/server/stats'),
    ]);
    dashboardError.value = '';
  } catch (error) {
    dashboardError.value = error instanceof Error ? error.message : 'Refresh failed';
  }
}

async function saveSettings() {
  savingSettings.value = true;
  settingsError.value = '';
  try {
    settings.value = await api<PublicSettings>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ provider: 'azure', ...settingsForm }),
    });
    settingsForm.apiKey = '';
    settingsOpen.value = false;
  } catch (error) {
    settingsError.value = error instanceof Error ? error.message : 'Could not save settings';
  } finally {
    savingSettings.value = false;
  }
}

async function submitPrompt() {
  const text = prompt.value.trim();
  if (!text || chatBusy.value || !settings.value?.configured) return;
  prompt.value = '';
  await sendMessage({ text });
}

async function newConversation() {
  await stop();
  messages.value = [];
  prompt.value = '';
  clearError();
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

async function showLogs(container: ContainerInfo) {
  logs.value = { id: container.id, name: container.name, content: '', tail: 200, search: '', reverse: false, loading: true, error: '' };
  actionId.value = container.id;
  await refreshLogs();
  actionId.value = '';
}

async function refreshLogs() {
  if (!logs.value) return;
  const current = logs.value;
  current.loading = true;
  current.error = '';
  try {
    const result = await api<{ logs: string }>(`/api/containers/${encodeURIComponent(current.id)}/logs?tail=${current.tail}`);
    if (logs.value === current) current.content = result.logs;
  } catch (error) {
    if (logs.value === current) current.error = error instanceof Error ? error.message : 'Could not read logs';
  } finally {
    if (logs.value === current) current.loading = false;
  }
}

function openDomainDialog(container: ContainerInfo) {
  Object.assign(domainDialog, { container, hostname: '', error: '', saving: false });
}

async function addDomain() {
  if (!domainDialog.container) return;
  domainDialog.saving = true;
  domainDialog.error = '';
  try {
    await api(`/api/containers/${encodeURIComponent(domainDialog.container.id)}/domains`, {
      method: 'POST',
      body: JSON.stringify({ hostname: domainDialog.hostname }),
    });
    domainDialog.container = null;
    await refreshDashboard();
  } catch (error) {
    domainDialog.error = error instanceof Error ? error.message : 'Could not add domain';
  } finally {
    domainDialog.saving = false;
  }
}

async function setPrimaryDomain(container: ContainerInfo, domain: ServiceDomain) {
  await runDomainAction(container, domain, 'primary');
}

async function removeDomain(container: ContainerInfo, domain: ServiceDomain) {
  const warning = domain.managed
    ? `Remove HalfCloud-managed domain ${domain.hostname}? This removes the permanent fallback address.`
    : `Remove ${domain.hostname} from ${container.name}?`;
  if (!window.confirm(warning)) return;
  await runDomainAction(container, domain, 'remove');
}

async function runDomainAction(container: ContainerInfo, domain: ServiceDomain, action: 'primary' | 'remove') {
  domainAction.value = `${container.id}:${domain.hostname}`;
  dashboardError.value = '';
  try {
    const base = `/api/containers/${encodeURIComponent(container.id)}/domains/${encodeURIComponent(domain.hostname)}`;
    await api(action === 'primary' ? `${base}/primary` : base, {
      method: action === 'primary' ? 'PUT' : 'DELETE',
      body: JSON.stringify(action === 'remove' ? { allowManaged: domain.managed } : {}),
    });
    await refreshDashboard();
  } catch (error) {
    dashboardError.value = error instanceof Error ? error.message : `Domain ${action} failed`;
  } finally {
    domainAction.value = '';
  }
}

watch(status, (current, previous) => {
  if (current === 'ready' && previous !== 'ready') {
    void refreshDashboard();
    void nextTick(() => composerInput.value?.focus());
  }
});
watch(messages, () => nextTick(() => transcript.value?.scrollTo({ top: transcript.value.scrollHeight, behavior: 'smooth' })), { deep: true });
onMounted(bootstrap);
onMounted(() => window.addEventListener('halfcloud:unauthorized', clearSession));
onBeforeUnmount(() => {
  if (refreshTimer) window.clearInterval(refreshTimer);
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
        <button class="text-button" @click="settingsOpen = true">AI settings</button>
        <button class="text-button" @click="logout">Sign out</button>
      </div>
    </header>

    <section v-if="server" class="metrics-strip">
      <div><span>CPU</span><strong>{{ server.cpuPercent.toFixed(1) }}%</strong><i><b :style="{ width: `${Math.min(server.cpuPercent, 100)}%` }"></b></i></div>
      <div><span>MEMORY</span><strong>{{ formatBytes(server.memoryUsed) }} / {{ formatBytes(server.memoryTotal) }}</strong><i><b :style="{ width: `${server.memoryTotal ? server.memoryUsed / server.memoryTotal * 100 : 0}%` }"></b></i></div>
      <div><span>DISK</span><strong>{{ formatBytes(server.diskUsed) }} / {{ formatBytes(server.diskTotal) }}</strong><i><b :style="{ width: `${server.diskTotal ? server.diskUsed / server.diskTotal * 100 : 0}%` }"></b></i></div>
      <div class="uptime"><span>UPTIME</span><strong>{{ formatUptime(server.uptimeSeconds) }}</strong></div>
    </section>

    <p v-if="dashboardError" class="global-error">{{ dashboardError }}</p>

    <div class="workspace">
      <section class="chat-panel">
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
              <button @click="prompt = 'Inspect my containers and tell me what needs attention'">Find containers that need attention</button>
            </div>
          </div>
          <article v-for="message in messages" :key="message.id" class="message" :class="message.role">
            <span class="message-author">{{ message.role === 'user' ? 'YOU' : 'HALFCLOUD' }}</span>
            <template v-for="(part, index) in message.parts" :key="index">
              <div v-if="textPart(part)" class="message-text" v-html="renderMarkdown(part.text)"></div>
              <div v-else-if="toolPart(part)" class="tool-event" :class="toolState(toolPart(part)!)">
                <span class="tool-icon">{{ toolState(toolPart(part)!) === 'complete' ? '✓' : toolState(toolPart(part)!) === 'failed' ? '!' : '·' }}</span>
                <div class="tool-content">
                  <span>{{ toolLabel(toolPart(part)!) }}</span>
                  <ul v-if="toolDetails(toolPart(part)!).length">
                    <li v-for="(detail, detailIndex) in toolDetails(toolPart(part)!)" :key="detailIndex"><a v-if="detail.href" :href="detail.href" target="_blank" rel="noopener noreferrer">{{ detail.text }}</a><template v-else>{{ detail.text }}</template></li>
                  </ul>
                  <div v-if="environmentRequest(toolPart(part)!)" class="environment-request-widget">
                    <template v-if="environmentRequest(toolPart(part)!)!.status === 'completed'">
                      <strong>{{ environmentRequest(toolPart(part)!)!.name }}</strong>
                      <p>Configured directly in HalfCloud. The value was not added to this conversation.</p>
                    </template>
                    <form v-else @submit.prevent="submitEnvironmentRequest(toolPart(part)!)">
                      <strong>Environment variable required</strong>
                      <code>{{ environmentRequest(toolPart(part)!)!.name }}</code>
                      <p v-if="environmentRequest(toolPart(part)!)!.description">{{ environmentRequest(toolPart(part)!)!.description }}</p>
                      <label>Value</label>
                      <input
                        type="password"
                        autocomplete="off"
                        required
                        :value="environmentRequest(toolPart(part)!)!.form.value"
                        @input="environmentRequest(toolPart(part)!)!.form.value = ($event.target as HTMLInputElement).value"
                      >
                      <label class="protection-toggle">
                        <input
                          type="checkbox"
                          :checked="environmentRequest(toolPart(part)!)!.form.protectedFromAI"
                          @change="environmentRequest(toolPart(part)!)!.form.protectedFromAI = ($event.target as HTMLInputElement).checked"
                        >
                        <span>Protect this value from AI</span>
                      </label>
                      <p>This value is submitted directly to HalfCloud and is not included in the AI conversation.</p>
                      <p v-if="environmentRequest(toolPart(part)!)!.form.error" class="form-error">{{ environmentRequest(toolPart(part)!)!.form.error }}</p>
                      <button class="button primary" type="submit" :disabled="environmentRequest(toolPart(part)!)!.form.saving">
                        {{ environmentRequest(toolPart(part)!)!.form.saving ? 'Saving…' : 'Save' }}
                      </button>
                    </form>
                  </div>
                  <div v-if="approvalRequest(toolPart(part)!)" class="approval-widget">
                    <strong>{{ approvalCopy(toolPart(part)!).title }}</strong>
                    <p>{{ approvalCopy(toolPart(part)!).detail }}</p>
                    <div>
                      <button class="confirm" type="button" :disabled="Boolean(respondingApprovalId)" @click="respondToApproval(toolPart(part)!, true)">Confirm</button>
                      <button type="button" :disabled="Boolean(respondingApprovalId)" @click="respondToApproval(toolPart(part)!, false)">Dismiss</button>
                    </div>
                  </div>
                </div>
                <small>{{ toolStateLabel(toolPart(part)!) }}</small>
              </div>
            </template>
          </article>
          <pre v-if="chatError" class="form-error chat-error">{{ chatError.message }}</pre>
        </div>
        <div class="conversation-footer">
          <form class="composer" @submit.prevent="submitPrompt">
            <textarea ref="composerInput" v-model="prompt" :disabled="!settings?.configured || chatBusy" rows="2" :placeholder="!settings?.configured ? 'Configure Azure OpenAI to start…' : chatBusy ? 'HalfCloud is working…' : 'Tell HalfCloud what should be running…'" @keydown.enter.exact.prevent="submitPrompt"></textarea>
            <button v-if="chatBusy" class="send-button stop" type="button" title="Stop" @click="stop">■</button>
            <button v-else class="send-button" type="submit" :disabled="!prompt.trim() || !settings?.configured" title="Send">↑</button>
          </form>
          <div class="conversation-loader" :class="{ active: chatBusy }" role="status" aria-live="polite">
            <span>{{ chatBusy ? 'Working' : '' }}</span>
            <i aria-hidden="true"><b></b></i>
          </div>
        </div>
      </section>

      <section class="containers-panel">
        <div class="section-heading compact">
          <div><p class="eyebrow">DOCKER ENGINE</p><h2>Containers <sup>{{ containers.length }}</sup></h2></div>
          <button class="refresh-button" title="Refresh" @click="refreshDashboard">↻</button>
        </div>
        <div v-if="containers.length === 0" class="empty-containers">
          <span>00</span><p>No managed containers yet.</p><small>Ask HalfCloud to run one.</small>
        </div>
        <article v-for="container in containers" :key="container.id" class="container-card">
          <div class="container-title">
            <span class="status-dot" :class="container.state"></span>
            <div><h3>{{ container.name }}</h3><p>{{ container.image }}</p></div>
            <span class="state-label">{{ container.state }}</span>
          </div>
          <div class="container-data">
            <div><span>PUBLISHED</span><strong>{{ container.ports.length ? container.ports.map(p => `${p.host} → ${p.container}`).join(', ') : 'None' }}</strong></div>
            <div><span>CPU</span><strong>{{ container.cpuPercent.toFixed(2) }}%</strong></div>
            <div><span>RAM</span><strong>{{ formatBytes(container.memoryUsed) }}</strong></div>
          </div>
          <section v-if="container.domains.length" class="domains-block">
            <div class="domains-heading"><span>DOMAINS</span><button type="button" @click="openDomainDialog(container)">+ Add domain</button></div>
            <div v-for="domain in container.domains" :key="domain.hostname" class="domain-row">
              <span class="domain-state" :class="domain.state" :title="domain.httpsReady ? 'HTTPS ready' : domain.dnsConfigured ? 'DNS configured; waiting for HTTPS' : 'DNS not pointed to this server'"></span>
              <div class="domain-name">
                <strong>{{ domain.hostname }}</strong>
                <small>
                  <b v-if="domain.primary">Primary</b>
                  <b v-if="domain.managed">HalfCloud domain</b>
                  <span>{{ domain.httpsReady ? 'HTTPS ready' : domain.dnsConfigured ? 'DNS ready · HTTPS pending' : `Point DNS to ${domain.dnsTarget || 'this server'}` }}</span>
                </small>
              </div>
              <div class="domain-actions">
                <a :href="`https://${domain.hostname}`" target="_blank" rel="noopener noreferrer">Open</a>
                <button v-if="!domain.primary" :disabled="domainAction === `${container.id}:${domain.hostname}`" @click="setPrimaryDomain(container, domain)">Make primary</button>
                <button class="danger" :disabled="container.domains.length === 1 || domainAction === `${container.id}:${domain.hostname}`" @click="removeDomain(container, domain)">Remove</button>
              </div>
            </div>
          </section>
          <div v-else class="service-endpoint private">
            <svg aria-hidden="true" viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="11" rx="2"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3"></path></svg>
            <span>
              <small>PRIVATE NETWORK · USE IN ENV</small>
              <strong>{{ privateAddresses(container).length ? privateAddresses(container).join(', ') : `${container.name}:<port>` }}</strong>
            </span>
          </div>
          <div class="container-actions">
            <button class="environment-button" :disabled="actionId === container.id" @click="openEnvironmentDialog(container)">Environment</button>
            <button class="logs-button" :disabled="actionId === container.id" @click="showLogs(container)">
              <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m7 8 4 4-4 4"></path><path d="M13 16h4"></path><rect x="3" y="4" width="18" height="16" rx="2"></rect></svg>
              Logs
            </button>
            <details class="actions-menu">
              <summary>
                Actions
                <svg aria-hidden="true" viewBox="0 0 12 12"><path d="m3 4.5 3 3 3-3"></path></svg>
              </summary>
              <div class="actions-menu-list">
                <button v-if="container.state !== 'running'" :disabled="actionId === container.id" @click="runMenuAction($event, container, 'start')">Start</button>
                <button v-else :disabled="actionId === container.id" @click="runMenuAction($event, container, 'stop')">Stop</button>
                <button :disabled="actionId === container.id" @click="runMenuAction($event, container, 'restart')">Restart</button>
                <button class="danger" :disabled="actionId === container.id" @click="runMenuAction($event, container, 'delete')">Delete</button>
              </div>
            </details>
          </div>
        </article>
      </section>
    </div>

    <div v-if="settingsOpen" class="modal-backdrop" @click.self="settings?.configured && (settingsOpen = false)">
      <section class="modal settings-modal">
        <button v-if="settings?.configured" class="modal-close" @click="settingsOpen = false">×</button>
        <p class="eyebrow">MODEL CONNECTION</p>
        <h2>Azure OpenAI</h2>
        <p>Credentials stay on this VPS and are never returned to the browser.</p>
        <form @submit.prevent="saveSettings">
          <label for="endpoint">Endpoint</label>
          <input id="endpoint" v-model="settingsForm.endpoint" type="url" placeholder="https://resource.openai.azure.com" required>
          <label for="api-key">API key</label>
          <input id="api-key" v-model="settingsForm.apiKey" type="password" autocomplete="off" :placeholder="settings?.configured ? 'Enter key to replace current credentials' : 'Azure OpenAI API key'" required>
          <label for="deployment">Deployment / model</label>
          <input id="deployment" v-model="settingsForm.deployment" required>
          <p v-if="settingsError" class="form-error">{{ settingsError }}</p>
          <button class="button primary wide" :disabled="savingSettings" type="submit">{{ savingSettings ? 'Saving…' : 'Save connection' }}</button>
        </form>
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
            <select v-model.number="logs.tail" :disabled="logs.loading" @change="refreshLogs">
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
          <button class="logs-refresh" :class="{ loading: logs.loading }" :disabled="logs.loading" type="button" @click="refreshLogs">
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

    <div v-if="domainDialog.container" class="modal-backdrop" @click.self="domainDialog.container = null">
      <section class="modal domain-modal">
        <button class="modal-close" @click="domainDialog.container = null">×</button>
        <p class="eyebrow">PUBLIC ROUTING</p>
        <h2>Add domain to {{ domainDialog.container.name }}</h2>
        <p>The existing HalfCloud address stays active. Point the new hostname's DNS record to this server.</p>
        <form @submit.prevent="addDomain">
          <label for="domain-hostname">Hostname</label>
          <input id="domain-hostname" v-model="domainDialog.hostname" autofocus inputmode="url" autocomplete="off" placeholder="app.example.com" required>
          <p v-if="domainDialog.error" class="form-error">{{ domainDialog.error }}</p>
          <button class="button primary wide" :disabled="domainDialog.saving" type="submit">{{ domainDialog.saving ? 'Adding…' : 'Add domain' }}</button>
        </form>
      </section>
    </div>

    <div v-if="environmentDialog.container" class="modal-backdrop" @click.self="closeEnvironmentDialog">
      <section class="modal environment-modal">
        <button class="modal-close" @click="closeEnvironmentDialog">×</button>
        <p class="eyebrow">SERVICE CONFIGURATION</p>
        <h2>{{ environmentDialog.container.name }} environment</h2>
        <div class="protection-explanation"><strong>Protected from AI</strong><span>HalfCloud removes protected values from data before it is sent to AI. The AI can still see variable names and whether they are configured.</span></div>

        <p v-if="environmentDialog.loading" class="environment-empty">Loading environment…</p>
        <form v-else-if="environmentDialog.variables.length" class="environment-editor" @submit.prevent="saveEnvironmentChanges">
          <div class="environment-list">
            <div class="environment-list-heading"><span>Name</span><span>Value</span><span>Protect from AI</span><span></span></div>
            <div v-for="variable in environmentDialog.variables" :key="variable.id" class="environment-row">
              <input v-model.trim="variable.name" aria-label="Variable name" autocomplete="off" pattern="[A-Za-z_][A-Za-z0-9_]*" required>
              <div class="environment-value-field">
                <input v-model="variable.value" :type="revealedEnvironmentValues.has(variable.id) ? 'text' : 'password'" :aria-label="`${variable.name} value`" autocomplete="new-password">
                <button type="button" @click="toggleEnvironmentValue(variable.id)">{{ revealedEnvironmentValues.has(variable.id) ? 'Hide' : 'Show' }}</button>
              </div>
              <label class="environment-protection" :title="variable.protectedFromAI ? 'This value is omitted from AI data' : 'This value is visible to AI'">
                <input v-model="variable.protectedFromAI" type="checkbox">
                <span>{{ variable.protectedFromAI ? 'Protected' : 'Visible' }}</span>
              </label>
              <button class="environment-delete danger" type="button" :disabled="environmentChanges || environmentDialog.saving" title="Save or discard pending edits before deleting" @click="deleteEnvironmentVariable(variable)">Delete</button>
            </div>
          </div>
          <p v-if="environmentDialog.error" class="form-error">{{ environmentDialog.error }}</p>
          <div class="environment-save-bar">
            <span>{{ environmentChanges ? 'Unsaved environment changes' : 'Environment is up to date' }}</span>
            <button class="button primary" type="submit" :disabled="!environmentChanges || environmentDialog.saving">{{ environmentDialog.saving ? 'Applying…' : 'Save changes' }}</button>
          </div>
        </form>
        <p v-else-if="!environmentDialog.loading" class="environment-empty">No environment variables configured.</p>

        <form class="environment-form" @submit.prevent="saveEnvironmentVariable">
          <h3>Add variable</h3>
          <label for="environment-name">Name</label>
          <input id="environment-name" v-model.trim="environmentDialog.name" autocomplete="off" placeholder="STRIPE_SECRET_KEY" pattern="[A-Za-z_][A-Za-z0-9_]*" required>
          <label for="environment-value">Value</label>
          <input id="environment-value" v-model="environmentDialog.value" autocomplete="off">
          <label class="protection-toggle">
            <input v-model="environmentDialog.protectedFromAI" type="checkbox">
            <span>Protect this value from AI</span>
          </label>
          <p class="environment-help">Recommended for passwords, API keys, tokens, credentials, and other sensitive configuration.</p>
          <p v-if="!environmentDialog.protectedFromAI && sensitiveEnvironmentName(environmentDialog.name)" class="credential-warning">This variable looks like a credential. We recommend keeping AI protection enabled.</p>
          <p v-if="environmentChanges" class="environment-help">Save the changes above before adding another variable.</p>
          <p v-if="environmentDialog.error && !environmentDialog.variables.length" class="form-error">{{ environmentDialog.error }}</p>
          <div class="environment-form-actions">
            <button class="button primary" :disabled="environmentDialog.saving || environmentChanges" type="submit">{{ environmentDialog.saving ? 'Applying…' : 'Add variable' }}</button>
          </div>
        </form>
      </section>
    </div>
  </main>
</template>
