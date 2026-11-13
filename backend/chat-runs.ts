import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';
import { ConversationStore, type Conversation } from './conversations.js';

export class ChatConflictError extends Error {}

export interface ChatRunSummary {
  id: string;
  status: 'running' | 'completed' | 'stopped' | 'error';
  agentStatus?: unknown;
  agentError?: unknown;
  error?: string;
}

export type ChatSnapshot = Conversation & { run?: ChatRunSummary };
export type ChatStreamFactory = (messages: UIMessage[], signal: AbortSignal, requestId: string) => Promise<ReadableStream<UIMessageChunk>>;

type ChatRun = {
  summary: ChatRunSummary;
  controller: AbortController;
  conversation: Conversation;
  messages: UIMessage[];
  dirty: boolean;
  stopRequested: boolean;
  saveTimer?: ReturnType<typeof setTimeout>;
};

// Agent execution belongs to this process. HTTP clients only submit commands and read snapshots.
export class ChatRuns {
  private readonly runs = new Map<string, ChatRun>();
  private readonly summaries = new Map<string, ChatRunSummary>();

  constructor(private readonly store: ConversationStore) {}

  get(id: string): ChatSnapshot | undefined {
    const run = this.runs.get(id);
    if (run) this.flush(run);
    const conversation = run?.conversation ?? this.store.get(id);
    if (!conversation) return undefined;
    const summary = this.summaries.get(id);
    return { ...conversation, ...(summary ? { run: { ...summary } } : {}) };
  }

  save(id: string, messages: UIMessage[], revision: number): ChatSnapshot {
    this.assertWritable(id, revision);
    this.store.save(id, messages);
    return this.get(id)!;
  }

  start(id: string, requestId: string, messages: UIMessage[], revision: number, createStream: ChatStreamFactory): ChatSnapshot {
    const existing = this.summaries.get(id);
    // Retry an unacknowledged POST safely, including after its run has finished.
    if (existing?.id === requestId) return this.get(id)!;
    this.assertWritable(id, revision);
    const conversation = this.store.save(id, messages);
    const run: ChatRun = {
      summary: { id: requestId, status: 'running' },
      controller: new AbortController(),
      conversation,
      messages: conversation.messages,
      dirty: false,
      stopRequested: false,
    };
    this.runs.set(id, run);
    this.summaries.set(id, run.summary);
    void this.execute(run, createStream);
    return this.get(id)!;
  }

  stop(id: string, requestId: string): ChatSnapshot | undefined {
    const run = this.runs.get(id);
    if (run?.summary.id === requestId && run.summary.status === 'running') {
      run.stopRequested = true;
      run.controller.abort();
    }
    return this.get(id);
  }

  private assertWritable(id: string, revision: number) {
    if (this.runs.get(id)?.summary.status === 'running') {
      throw new ChatConflictError('This conversation is still running. Reconnect to its progress or stop it first.');
    }
    if ((this.store.get(id)?.revision ?? -1) !== revision) {
      throw new ChatConflictError('This conversation has changed. Reload its latest messages before continuing.');
    }
  }

  private flush(run: ChatRun) {
    if (run.saveTimer) clearTimeout(run.saveTimer);
    run.saveTimer = undefined;
    if (!run.dirty) return;
    try {
      run.conversation = this.store.save(run.conversation.id, run.messages);
      run.dirty = false;
    } catch (error) {
      console.error(`[chat:${run.summary.id}] Could not save conversation`, error);
      run.summary.error = 'HalfCloud could not save this conversation. Check available server storage before continuing.';
      run.controller.abort();
    }
  }

  private async execute(run: ChatRun, createStream: ChatStreamFactory) {
    const lastMessage = run.messages.at(-1);
    const continuing = lastMessage?.role === 'assistant';
    const history = continuing ? run.messages.slice(0, -1) : run.messages.slice();
    try {
      const stream = await createStream(run.messages, run.controller.signal, run.summary.id);
      const observed = stream.pipeThrough(new TransformStream<UIMessageChunk, UIMessageChunk>({
        transform(chunk, controller) {
          if (chunk.type === 'data-agentStatus') run.summary.agentStatus = chunk.data;
          if (chunk.type === 'data-agentError') run.summary.agentError = chunk.data;
          if (chunk.type === 'error') run.summary.error = chunk.errorText;
          controller.enqueue(chunk);
        },
      }));
      for await (const message of readUIMessageStream({
        stream: observed,
        message: continuing ? lastMessage : undefined,
        onError: () => { run.summary.error ??= 'HalfCloud could not complete this operation. Please try again.'; },
      })) {
        run.messages = [...history, message];
        run.dirty = true;
        // Bound SQLite writes while preserving intermediate text and tool/approval state.
        run.saveTimer ??= setTimeout(() => this.flush(run), 250);
      }
    } catch (error) {
      console.error(`[chat:${run.summary.id}] Background run failed`, error);
      run.summary.error ??= 'HalfCloud could not complete this operation. Please try again.';
    } finally {
      run.summary.agentStatus = undefined;
      this.flush(run);
      run.summary.status = run.stopRequested ? 'stopped' : run.summary.error ? 'error' : 'completed';
      // Finished histories live in SQLite; retain only small run metadata for reconnects and retries.
      this.runs.delete(run.conversation.id);
    }
  }
}
