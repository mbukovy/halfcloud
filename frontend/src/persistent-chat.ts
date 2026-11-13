import { lastAssistantMessageIsCompleteWithApprovalResponses, type UIMessage } from 'ai';
import { onScopeDispose, ref, watch, type Ref } from 'vue';

export type AgentStatus = { phase: 'pulling-image'; image: string } | { phase: 'activity'; label: string } | { phase: 'working' };
export type AgentErrorDetails = { requestId: string; provider: string; model: string; details: string };
export type TokenUsage = { input: number; output: number; thinking: number; cacheRead: number; cacheWrite: number };
export type HalfCloudMessage = UIMessage<{ tokenUsage: TokenUsage }, { agentStatus: AgentStatus; agentError: AgentErrorDetails }>;
export type ConversationSummary = { id: string; title: string; createdAt: string; updatedAt: string };
export type ConversationRecord = ConversationSummary & {
  messages: HalfCloudMessage[];
  revision: number;
  run?: {
    id: string;
    status: 'running' | 'completed' | 'stopped' | 'error';
    agentStatus?: AgentStatus;
    agentError?: AgentErrorDetails;
    error?: string;
  };
};

class RequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

const storageKey = 'halfcloud:active-conversation';
export function savedConversationId() {
  try { return window.localStorage.getItem(storageKey) ?? ''; } catch { return ''; }
}

export function usePersistentChat(activeId: Ref<string>, onSummary: (summary: ConversationSummary) => void) {
  const messages = ref<HalfCloudMessage[]>([]);
  const status = ref<'ready' | 'submitted' | 'streaming' | 'error'>('ready');
  const error = ref<Error>();
  const agentStatus = ref<AgentStatus | null>(null);
  const agentErrorDetails = ref<AgentErrorDetails | null>(null);
  const reconnecting = ref(false);
  let revision = -1;
  let run: ConversationRecord['run'];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let epoch = 0;
  let syncing = false;
  let saving = false;
  let savePromise: Promise<void> | undefined;
  let stopRequested = false;
  let pending: { conversationId: string; requestId: string; messages: HalfCloudMessage[]; revision: number } | undefined;

  watch(activeId, (id) => {
    try {
      if (id) window.localStorage.setItem(storageKey, id);
      else window.localStorage.removeItem(storageKey);
    } catch { /* Conversation recovery also works through server history. */ }
  }, { flush: 'sync' });

  async function request<T>(url: string, signal: AbortSignal, body?: unknown, method = 'POST'): Promise<T> {
    const response = await fetch(url, {
      method: body === undefined ? 'GET' : method,
      cache: 'no-store',
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    if (response.status === 401) window.dispatchEvent(new Event('halfcloud:unauthorized'));
    const value = await response.json();
    if (!response.ok) throw new RequestError(value.error ?? `Request failed (${response.status})`, response.status);
    return value as T;
  }

  function apply(conversation: ConversationRecord, force = false) {
    if (conversation.id !== activeId.value) return;
    if (force || conversation.revision !== revision) messages.value = conversation.messages;
    revision = conversation.revision;
    run = conversation.run;
    if (run?.status !== 'running') stopRequested = false;
    agentStatus.value = run?.agentStatus?.phase === 'working' ? null : run?.agentStatus ?? null;
    agentErrorDetails.value = run?.agentError ?? null;
    error.value = run?.status === 'error' ? new Error(run.error ?? 'HalfCloud could not complete this operation.') : undefined;
    status.value = run?.status === 'running' ? 'streaming' : error.value ? 'error' : 'ready';
    reconnecting.value = false;
    onSummary(conversation);
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    if (activeId.value) timer = setTimeout(() => void sync(), run?.status === 'running' || pending || reconnecting.value ? 750 : 5000);
  }

  async function sync(force = false) {
    if (!activeId.value || saving || (syncing && !force)) return;
    if (timer) clearTimeout(timer);
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    const current = ++epoch;
    const id = activeId.value;
    const submission = pending;
    syncing = true;
    try {
      const stopping = !submission && stopRequested && run?.status === 'running';
      const conversation = await request<ConversationRecord>(
        submission ? '/api/chat' : `/api/conversations/${encodeURIComponent(id)}${stopping ? '/stop' : ''}`,
        signal, submission ?? (stopping ? { requestId: run!.id } : undefined),
      );
      if (current !== epoch) return;
      if (submission) pending = undefined;
      apply(conversation, !!submission);
    } catch (failure) {
      if (current !== epoch) return;
      if (failure instanceof RequestError) {
        pending = undefined;
        error.value = failure;
        status.value = 'error';
        reconnecting.value = false;
        // A stale tab must recover server-owned history instead of overwriting it.
        if (failure.status === 409) {
          try {
            const conversation = await request<ConversationRecord>(`/api/conversations/${encodeURIComponent(id)}`, signal);
            if (current === epoch) apply(conversation, true);
          } catch { reconnecting.value = true; }
        }
      } else {
        // Keep the command/run alive and retry its acknowledgement, never manufacture a failed message.
        reconnecting.value = true;
        error.value = undefined;
        status.value = pending ? 'submitted' : run?.status === 'running' ? 'streaming' : 'submitted';
      }
    } finally {
      if (current === epoch) {
        syncing = false;
        schedule();
      }
    }
  }

  function detach() {
    ++epoch;
    controller?.abort();
    if (timer) clearTimeout(timer);
    timer = undefined;
    syncing = false;
    pending = undefined;
    stopRequested = false;
    revision = -1;
    run = undefined;
    status.value = 'ready';
    error.value = undefined;
    reconnecting.value = false;
    agentStatus.value = null;
    agentErrorDetails.value = null;
  }

  function activate(conversation: ConversationRecord) {
    detach();
    activeId.value = conversation.id;
    apply(conversation, true);
    schedule();
  }

  async function sendMessage(message?: { text: string }) {
    const id = activeId.value;
    while (savePromise) await savePromise;
    if (!id || activeId.value !== id || pending || run?.status === 'running') return;
    controller?.abort();
    if (message) messages.value = [...messages.value, { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text: message.text }] }];
    pending = {
      conversationId: activeId.value,
      requestId: crypto.randomUUID(),
      messages: JSON.parse(JSON.stringify(messages.value)),
      revision,
    };
    status.value = 'submitted';
    error.value = undefined;
    agentStatus.value = null;
    agentErrorDetails.value = null;
    await sync(true);
  }

  function persistConversation(): Promise<void> {
    const id = activeId.value;
    if (savePromise) return savePromise.then(() => activeId.value === id ? persistConversation() : undefined);
    savePromise = saveConversation().finally(() => { savePromise = undefined; });
    return savePromise;
  }

  async function saveConversation() {
    if (!activeId.value || pending || run?.status === 'running' || saving || !messages.value.some((message) => message.role === 'user')) return;
    const id = activeId.value;
    const current = ++epoch;
    controller?.abort();
    controller = new AbortController();
    syncing = false;
    saving = true;
    try {
      const conversation = await request<ConversationRecord>(`/api/conversations/${encodeURIComponent(id)}`, controller.signal,
        { messages: messages.value, revision }, 'PUT');
      if (current === epoch) {
        // Keep live widget objects attached while recording their new revision.
        revision = conversation.revision;
        onSummary(conversation);
      }
    } catch (failure) {
      if (current === epoch) error.value = failure instanceof Error ? failure : new Error('Conversation could not be saved');
    } finally {
      saving = false;
      schedule();
    }
  }

  async function addToolApprovalResponse(response: { id: string; approved: boolean; reason: string }) {
    if (run?.status === 'running' || pending) return;
    for (const part of messages.value.at(-1)?.parts ?? []) {
      if (!('approval' in part) || part.approval?.id !== response.id || part.state !== 'approval-requested') continue;
      Object.assign(part, { state: 'approval-responded', approval: { ...part.approval, approved: response.approved, reason: response.reason } });
    }
    if (lastAssistantMessageIsCompleteWithApprovalResponses({ messages: messages.value })) await sendMessage();
    else await persistConversation();
  }

  async function stop() {
    if (!pending && run?.status !== 'running') return;
    // Retry explicit Stop too if the phone is offline, always targeting this exact run.
    stopRequested = true;
    await sync(true);
    if (stopRequested) await sync(true);
  }

  function recover() {
    if (document.visibilityState !== 'hidden') void sync(true);
  }
  window.addEventListener('online', recover);
  window.addEventListener('focus', recover);
  document.addEventListener('visibilitychange', recover);
  onScopeDispose(() => {
    detach();
    window.removeEventListener('online', recover);
    window.removeEventListener('focus', recover);
    document.removeEventListener('visibilitychange', recover);
  });

  return { messages, status, error, agentStatus, agentErrorDetails, reconnecting, sendMessage, stop, detach, activate, persistConversation, addToolApprovalResponse, clearError: () => { error.value = undefined; } };
}
