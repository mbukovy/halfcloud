<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import {
  getGitHubWebhookSecret, getGitHubWebhookSetup, rotateGitHubWebhookSecret,
  safeGitHubWebhookSetup, setGitHubWebhookEnabled, type GitHubWebhookSetup,
} from '../api';

const props = defineProps<{ setup: GitHubWebhookSetup; scope: AbortSignal }>();
const emit = defineEmits<{ update: [setup: GitHubWebhookSetup] }>();
const current = ref<GitHubWebhookSetup | null>(null);
const reconciled = ref(false);
const busy = ref('');
const error = ref('');
const notice = ref('');
const confirmingRotation = ref(false);
// This value is never emitted, persisted, or passed to the chat transport.
const revealedSecret = ref('');
let secretTimer: ReturnType<typeof setTimeout> | undefined;
let request: AbortController | undefined;
let generation = 0;
let scope: AbortSignal | undefined;

function hideSecret() {
  revealedSecret.value = '';
  clearTimeout(secretTimer);
  secretTimer = undefined;
}

function invalidate() {
  generation += 1;
  request?.abort();
  hideSecret();
  busy.value = '';
  reconciled.value = false;
  confirmingRotation.value = false;
}

type Action = 'check' | 'enable' | 'disable' | 'rotate' | 'copy-url' | 'copy-secret' | 'reveal';
async function run(action: Action) {
  if (busy.value || props.scope.aborted) return;
  const setup = current.value;
  if (action !== 'check' && (!setup || !reconciled.value)) return;
  if (action === 'enable' && !setup?.verified) return;
  if (action === 'rotate' && !confirmingRotation.value) return;
  hideSecret();
  busy.value = action;
  error.value = '';
  notice.value = '';
  const version = generation;
  const controller = new AbortController();
  request = controller;
  const isCurrent = () => version === generation && !props.scope.aborted && !controller.signal.aborted;
  try {
    if (action === 'copy-url') {
      await navigator.clipboard.writeText(setup!.payloadUrl);
      if (isCurrent()) notice.value = 'Payload URL copied.';
    } else if (action === 'copy-secret' || action === 'reveal') {
      let secret = '';
      try {
        secret = await getGitHubWebhookSecret(setup!.appId, setup!.hookId, controller.signal);
        if (!isCurrent()) return;
        if (action === 'copy-secret') {
          const copying = navigator.clipboard.writeText(secret);
          secret = '';
          await copying;
          if (isCurrent()) notice.value = 'Secret copied. Paste it only into GitHub, not into this conversation.';
        } else {
          revealedSecret.value = secret;
          secretTimer = setTimeout(hideSecret, 30_000);
        }
      } finally {
        secret = '';
      }
    } else {
      const result = action === 'check'
        ? await getGitHubWebhookSetup(props.setup.appId, controller.signal)
        : action === 'rotate'
          ? await rotateGitHubWebhookSecret(setup!.appId, setup!.hookId, controller.signal)
          : await setGitHubWebhookEnabled(setup!.appId, setup!.hookId, action === 'enable', controller.signal);
      if (!isCurrent()) return;
      const safe = safeGitHubWebhookSetup(result)!;
      current.value = safe;
      reconciled.value = true;
      confirmingRotation.value = false;
      notice.value = action === 'rotate'
        ? 'Secret rotated. Update both the payload URL and secret in GitHub, send a new ping, and check the connection again.'
        : action === 'check'
          ? safe.verified ? 'Connection verified by a signed GitHub delivery.' : 'No verified delivery yet. Save the webhook in GitHub or redeliver its ping, then check again.'
          : action === 'disable' ? 'Automatic updates disabled. An active rollout will still finish.' : 'Automatic updates enabled.';
      emit('update', safe);
    }
  } catch {
    if (!isCurrent()) return;
    // A failed mutation can have reached the server. Require GET before retrying.
    if (action === 'check' || action === 'enable' || action === 'disable' || action === 'rotate') reconciled.value = false;
    error.value = action === 'copy-url' ? 'Could not copy the URL. Select it and copy manually.'
      : action === 'copy-secret' ? 'Could not copy the secret. Try Reveal secret and copy it directly into GitHub.'
        : action === 'reveal' ? 'Could not retrieve the secret. Please try again.'
          : 'Could not confirm webhook status. Check again before making changes.';
  } finally {
    if (isCurrent()) busy.value = '';
  }
}

watch(() => [props.setup.appId, props.setup.hookId, props.scope] as const, () => {
  // An emitted rotation may change the prop identity; its response is already fresh.
  if (scope === props.scope && current.value?.appId === props.setup.appId && current.value.hookId === props.setup.hookId) return;
  scope?.removeEventListener('abort', invalidate);
  invalidate();
  scope = props.scope;
  scope.addEventListener('abort', invalidate, { once: true });
  current.value = null;
  error.value = '';
  notice.value = '';
  void run('check');
}, { immediate: true, flush: 'sync' });

onBeforeUnmount(() => {
  scope?.removeEventListener('abort', invalidate);
  invalidate();
});
</script>

<template>
  <section class="environment-request-widget repository-setup-widget github-webhook-widget" aria-label="GitHub webhook setup" :aria-busy="Boolean(busy)">
    <strong>GitHub automatic updates</strong>
    <p>No repository token is required. Repository access stays unchanged; private repositories use their separate deploy key.</p>
    <p v-if="!reconciled" role="status">{{ busy === 'check' ? 'Checking current webhook status...' : 'Current status is not confirmed. Check the connection before continuing.' }}</p>
    <template v-if="current">
      <dl>
        <div><dt>Repository</dt><dd>{{ current.repository }}</dd></div>
        <div><dt>Branch</dt><dd>{{ current.branch }}</dd></div>
        <div><dt>Automatic updates</dt><dd>{{ !reconciled ? 'Not confirmed' : current.enabled ? 'Enabled' : 'Disabled' }}</dd></div>
        <div><dt>Connection</dt><dd>{{ !reconciled ? 'Not confirmed' : current.verified ? 'Verified' : 'Awaiting signed ping' }}</dd></div>
      </dl>
      <template v-if="reconciled && (!current.enabled || !current.verified)">
        <p>Add a webhook in GitHub under Repository Settings / Webhooks / Add webhook.</p>
        <ol class="webhook-steps">
          <li>
            <span>Payload URL (HTTPS)</span>
            <code class="webhook-value" tabindex="0">{{ current.payloadUrl }}</code>
            <button class="button" type="button" :disabled="Boolean(busy)" @click="run('copy-url')">Copy payload URL</button>
          </li>
          <li>Content type: <code>application/json</code></li>
          <li>
            <span>Secret: generated securely by HalfCloud</span>
            <div class="repository-setup-actions">
              <button class="button" type="button" :disabled="Boolean(busy)" @click="run('copy-secret')">{{ busy === 'copy-secret' ? 'Copying...' : 'Copy secret' }}</button>
              <button v-if="!revealedSecret" class="button" type="button" :disabled="Boolean(busy)" @click="run('reveal')">{{ busy === 'reveal' ? 'Retrieving...' : 'Reveal secret' }}</button>
              <button v-else class="button" type="button" @click="hideSecret">Hide secret</button>
            </div>
            <code v-if="revealedSecret" class="webhook-value" tabindex="0" aria-label="Webhook secret" @keydown.esc="hideSecret">{{ revealedSecret }}</code>
            <p>Never paste the secret into chat. It is fetched directly for copy or reveal, never sent to AI or saved in conversation history. Revealed secrets hide after 30 seconds.</p>
          </li>
          <li>Events: select <b>Just the push event</b>.</li>
          <li>SSL verification: <b>Enable SSL verification</b>.</li>
          <li>Keep <b>Active</b> checked, then save the webhook.</li>
        </ol>
        <p>GitHub sends a signed ping when you save. Click Check connection to verify it; this does not enable updates.</p>
      </template>
      <dl v-if="reconciled && (current.lastDeliveryAt || current.lastEvent || current.lastUpdate)">
        <div v-if="current.lastDeliveryAt"><dt>Last delivery</dt><dd><time :datetime="current.lastDeliveryAt">{{ new Date(current.lastDeliveryAt).toLocaleString() }}</time></dd></div>
        <div v-if="current.lastEvent"><dt>Last event</dt><dd>{{ current.lastEvent }}</dd></div>
        <template v-if="current.lastUpdate">
          <div><dt>Recent update</dt><dd>{{ current.lastUpdate.status }}</dd></div>
          <div><dt>Updated</dt><dd><time :datetime="current.lastUpdate.updatedAt">{{ new Date(current.lastUpdate.updatedAt).toLocaleString() }}</time></dd></div>
          <div v-if="current.lastUpdate.commit"><dt>Commit</dt><dd>{{ current.lastUpdate.commit.slice(0, 12) }}</dd></div>
          <div v-if="current.lastUpdate.message"><dt>Outcome</dt><dd>{{ current.lastUpdate.message }}</dd></div>
        </template>
      </dl>
      <p v-else-if="reconciled && current.enabled">No automatic update outcome yet.</p>
      <p v-if="reconciled && !current.enabled">Enabling allows pushes to {{ current.branch }} to rebuild and deploy this App. Services may briefly restart during each update.</p>
      <p v-if="reconciled && current.enabled">Pushes to {{ current.branch }} rebuild and deploy this App, with a possible brief restart. Disabling prevents future automatic updates; it does not cancel an active rollout.</p>
    </template>
    <div class="repository-setup-actions">
      <a v-if="current && reconciled" class="button" :href="current.settingsUrl" target="_blank" rel="noopener noreferrer">Open GitHub Webhooks</a>
      <button class="button" type="button" :disabled="Boolean(busy) || scope?.aborted" @click="run('check')">{{ busy === 'check' ? 'Checking...' : current?.enabled && reconciled ? 'Check status' : 'Check connection' }}</button>
      <template v-if="current && reconciled">
        <button v-if="!current.enabled" class="button primary" type="button" :disabled="Boolean(busy) || !current.verified" @click="run('enable')">{{ busy === 'enable' ? 'Enabling...' : 'Enable automatic updates' }}</button>
        <button v-else class="button" type="button" :disabled="Boolean(busy)" @click="run('disable')">{{ busy === 'disable' ? 'Disabling...' : 'Disable automatic updates' }}</button>
        <button class="button" type="button" :disabled="Boolean(busy)" @click="hideSecret(); confirmingRotation = true">Rotate secret</button>
      </template>
    </div>
    <div v-if="confirmingRotation && reconciled" class="approval-widget">
      <strong>Rotate webhook secret?</strong>
      <p>The old secret will stop working. Update both the payload URL and secret in GitHub, then send a new ping and reverify before enabling automatic updates again. An active rollout is not canceled.</p>
      <div>
        <button class="confirm" type="button" :disabled="Boolean(busy)" @click="run('rotate')">{{ busy === 'rotate' ? 'Rotating...' : 'Confirm rotation' }}</button>
        <button type="button" :disabled="Boolean(busy)" @click="confirmingRotation = false">Cancel</button>
      </div>
    </div>
    <p v-if="notice" role="status">{{ notice }}</p>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
  </section>
</template>
