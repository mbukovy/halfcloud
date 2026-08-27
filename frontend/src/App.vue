<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useChat } from '@ai-sdk/vue';
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses } from 'ai';
import MarkdownIt from 'markdown-it';
import { api, type ContainerInfo, type PublicSettings, type ServerStats } from './api';

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
const logs = ref<{ name: string; content: string } | null>(null);
const prompt = ref('');
const transcript = ref<HTMLElement>();
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

function publicUrl(container: ContainerInfo) {
  return container.hostname && container.ports.some((port) => port.protocol === 'tcp')
    ? `https://${container.hostname}`
    : undefined;
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
    setEnvironmentVariable: 'Updating application environment',
    listManagedVolumes: 'Inspecting managed storage', inspectManagedVolume: 'Inspecting managed volume',
    reconcileManagedVolume: 'Reconciling managed volume', deleteManagedVolume: 'Deleting managed volume',
    repairStorageOwnership: 'Repairing storage ownership',
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
  const target = input?.containerId;

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
  if (name === 'setEnvironmentVariable' && typeof input?.key === 'string') details.push({ text: `Environment key: ${input.key}` });
  if (typeof input?.volumeName === 'string') details.push({ text: `Volume: ${input.volumeName}` });
  if (typeof input?.mountTarget === 'string') details.push({ text: `Mount: ${input.mountTarget}` });
  if (name === 'listContainers' && Array.isArray(part.output)) details.push({ text: `Found ${part.output.length} managed application${part.output.length === 1 ? '' : 's'}` });
  if (typeof part.errorText === 'string') details.push({ text: part.errorText });
  return details;
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
  prompt.value = '';
  messages.value = [];
  if (refreshTimer) window.clearInterval(refreshTimer);
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

async function showLogs(container: ContainerInfo) {
  actionId.value = container.id;
  try {
    const result = await api<{ logs: string }>(`/api/containers/${encodeURIComponent(container.id)}/logs?tail=200`);
    logs.value = { name: container.name, content: result.logs || 'No recent logs.' };
  } catch (error) {
    dashboardError.value = error instanceof Error ? error.message : 'Could not read logs';
  } finally {
    actionId.value = '';
  }
}

watch(status, (current, previous) => {
  if (current === 'ready' && previous !== 'ready') void refreshDashboard();
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
    <div class="brand-mark">H</div>
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
      <div class="brand"><span class="brand-mark">H</span><strong>HalfCloud</strong></div>
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
      <div class="brand"><span class="brand-mark">H</span><strong>HalfCloud</strong><span class="version">0.1</span></div>
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
            <div class="prompt-glyph">⌁</div>
            <h2>What should be running?</h2>
            <p>Describe the outcome. HalfCloud will inspect Docker, choose sensible defaults, and carry it out.</p>
            <div class="suggestions">
              <button @click="prompt = 'Run nginx on port 8080'">Run nginx on port 8080</button>
              <button @click="prompt = 'How is my server doing?'">How is my server doing?</button>
              <button @click="prompt = 'Show me all running containers'">Show running containers</button>
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
            <textarea v-model="prompt" :disabled="!settings?.configured" rows="2" :placeholder="settings?.configured ? 'Tell HalfCloud what should be running…' : 'Configure Azure OpenAI to start…'" @keydown.enter.exact.prevent="submitPrompt"></textarea>
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
          <a v-if="publicUrl(container)" class="service-endpoint public" :href="publicUrl(container)" target="_blank" rel="noopener noreferrer">
            <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"></circle><path d="M3 12h18M12 3c2.4 2.5 3.6 5.5 3.6 9s-1.2 6.5-3.6 9c-2.4-2.5-3.6-5.5-3.6-9S9.6 5.5 12 3Z"></path></svg>
            <span><small>PUBLIC URL</small><strong>{{ publicUrl(container) }}</strong></span>
            <i aria-hidden="true">↗</i>
          </a>
          <div v-else class="service-endpoint private">
            <svg aria-hidden="true" viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="11" rx="2"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3"></path></svg>
            <span>
              <small>PRIVATE NETWORK · USE IN ENV</small>
              <strong>{{ privateAddresses(container).length ? privateAddresses(container).join(', ') : `${container.name}:<port>` }}</strong>
            </span>
          </div>
          <div class="container-actions">
            <button v-if="container.state !== 'running'" :disabled="actionId === container.id" @click="runAction(container, 'start')">Start</button>
            <button v-else :disabled="actionId === container.id" @click="runAction(container, 'stop')">Stop</button>
            <button :disabled="actionId === container.id" @click="runAction(container, 'restart')">Restart</button>
            <button :disabled="actionId === container.id" @click="showLogs(container)">Logs</button>
            <button class="danger" :disabled="actionId === container.id" @click="runAction(container, 'delete')">Delete</button>
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
        <p class="eyebrow">RECENT OUTPUT / 200 LINES</p>
        <h2>{{ logs.name }} logs</h2>
        <pre>{{ logs.content }}</pre>
      </section>
    </div>
  </main>
</template>
