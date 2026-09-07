import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export interface GitHubWebhookTarget {
  appId: string;
  appName: string;
  repository: string; // Normalized GitHub owner/repo, supplied by the trusted metadata callback.
  branch: string;
  ready: boolean;
}

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

export interface GitHubWebhookCallbacks {
  target: (appIdOrName: string) => Promise<GitHubWebhookTarget>;
  update: (appId: string) => Promise<{ commit: string; updated: boolean }>;
  busy: (appId: string) => boolean;
}

export class GitHubWebhookError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'GitHubWebhookError';
  }
}

const failureMessage = 'Automatic update failed; inspect the App';
const interruptedMessage = 'Automatic update interrupted; inspect the App';
export const githubWebhookBodyLimit = 25 * 1024 * 1024;
const maxDocumentBytes = 32 * 1024 * 1024;
const replayAge = 7 * 24 * 60 * 60 * 1000;
const appIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const repositorySchema = z.string().max(140).regex(/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/)
  .refine((value) => !['.', '..'].includes(value.split('/')[1]));
const branchSchema = z.string().min(1).max(255)
  .refine((value) => !/[\x00-\x20\x7f~^:?*\[\\]/.test(value)
    && !value.startsWith('-') && !value.endsWith('.') && !value.includes('..') && !value.includes('@{')
    && value !== '@' && value.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.lock')));
const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
const eventSchema = z.string().regex(/^[a-z_]{1,64}$/);
const deliverySchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const timeSchema = z.iso.datetime();
const updateSchema = z.object({
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'interrupted']),
  updatedAt: timeSchema,
  commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).optional(),
  message: z.enum([failureMessage, interruptedMessage]).optional(),
}).strict();
const hookSchema = z.object({
  appId: appIdSchema,
  hookId: tokenSchema,
  secret: tokenSchema,
  repository: repositorySchema,
  branch: branchSchema,
  enabled: z.boolean(),
  verified: z.boolean(),
  repositoryId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  lastDeliveryAt: timeSchema.optional(),
  lastEvent: eventSchema.optional(),
  lastUpdate: updateSchema.optional(),
  pending: z.boolean(),
  inFlight: z.uuid().optional(),
  // Replay protection is bounded, not permanent: the last 128 admissions, at most seven days.
  deliveries: z.array(z.object({ id: deliverySchema, hash: tokenSchema, at: timeSchema }).strict()).max(128),
}).strict().refine((hook) => (!hook.enabled || hook.verified) && (!hook.pending || hook.enabled)
  && (Boolean(hook.inFlight) === (hook.lastUpdate?.status === 'running')));
const documentSchema = z.object({ version: z.literal(1), hooks: z.array(hookSchema).max(1000) }).strict()
  .refine(({ hooks }) => new Set(hooks.map((hook) => hook.appId)).size === hooks.length
    && new Set(hooks.map((hook) => hook.hookId)).size === hooks.length);
type Hook = z.infer<typeof hookSchema>;
type Document = z.infer<typeof documentSchema>;

/** Single-process owner of the private journal. Call start() only after App update recovery. */
export class GitHubWebhookService {
  private readonly file: string;
  private readonly hostname: string;
  private document: Document = { version: 1, hooks: [] };
  private loading?: Promise<void>;
  private lock: Promise<unknown> = Promise.resolve();
  private storageFailed = false;
  private started = false;
  private lifecycle = 0;
  private startup?: Promise<void>;
  private worker?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly callbacks: GitHubWebhookCallbacks, dataDir: string, hostname = process.env.HALFCLOUD_HOSTNAME) {
    if (!hostname || hostname.length > 253 || !hostname.split('.').every((label) =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) {
      throw new GitHubWebhookError(400, 'A trusted control plane hostname is required');
    }
    this.hostname = hostname.toLowerCase();
    this.file = path.join(path.resolve(dataDir), 'github-webhooks.json');
  }

  async requestSetup(appId: string): Promise<GitHubWebhookSetup> {
    const target = await this.target(appId);
    return this.access((document) => {
      const existing = document.hooks.find((hook) => hook.appId === target.appId);
      if (existing) {
        this.assertTarget(existing, target);
        return this.safe(existing);
      }
      if (document.hooks.length >= 1000) throw new GitHubWebhookError(409, 'Webhook limit reached');
      const hook: Hook = {
        appId: target.appId, repository: target.repository, branch: target.branch,
        hookId: randomBytes(32).toString('hex'), secret: randomBytes(32).toString('hex'),
        enabled: false, verified: false, pending: false, deliveries: [],
      };
      document.hooks.push(hook);
      return this.safe(hook);
    }, true);
  }

  async getSetup(appId: string): Promise<GitHubWebhookSetup | undefined> {
    return this.access((document) => {
      const hook = document.hooks.find((entry) => entry.appId === appId);
      return hook ? this.safe(hook) : undefined;
    });
  }

  /** Trusted widget only: never expose this method through agent tools or public routes. */
  async getSecret(appId: string, hookId: string): Promise<{ secret: string }> {
    return this.access((document) => ({ secret: this.hook(document, appId, hookId).secret }));
  }

  async setEnabled(appId: string, hookId: string, enabled: boolean): Promise<GitHubWebhookSetup> {
    if (typeof enabled !== 'boolean') throw new GitHubWebhookError(400, 'Invalid enabled value');
    const target = enabled ? await this.target(appId) : undefined;
    return this.access((document) => {
      const hook = this.hook(document, appId, hookId);
      if (target) {
        this.assertTarget(hook, target);
        if (!hook.verified) throw new GitHubWebhookError(409, 'A signed GitHub delivery is required before enabling');
      }
      hook.enabled = enabled;
      if (!enabled) {
        hook.pending = false;
        if (hook.lastUpdate?.status === 'queued') delete hook.lastUpdate;
      }
      return this.safe(hook);
    }, true);
  }

  async rotateSecret(appId: string, hookId: string): Promise<GitHubWebhookSetup> {
    return this.access((document) => {
      const hook = this.hook(document, appId, hookId);
      hook.hookId = randomBytes(32).toString('hex');
      hook.secret = randomBytes(32).toString('hex');
      hook.enabled = false;
      hook.verified = false;
      hook.pending = false;
      hook.deliveries = [];
      delete hook.inFlight;
      delete hook.lastUpdate;
      delete hook.lastDeliveryAt;
      delete hook.lastEvent;
      // Keep the repository ID pin. A different target requires remove() and a new setup.
      return this.safe(hook);
    }, true);
  }

  async remove(appId: string): Promise<void> {
    await this.access((document) => { document.hooks = document.hooks.filter((hook) => hook.appId !== appId); }, true);
  }

  async receive(hookId: string, raw: Buffer, signature: string, event: string, delivery: string): Promise<{ status: number; body: object }> {
    if (!Buffer.isBuffer(raw) || raw.length > githubWebhookBodyLimit) throw new GitHubWebhookError(413, 'Webhook body exceeds the limit');
    if (typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/.test(signature)) throw new GitHubWebhookError(401, 'Invalid webhook signature');
    if (!eventSchema.safeParse(event).success || !deliverySchema.safeParse(delivery).success) throw new GitHubWebhookError(400, 'Invalid webhook headers');
    // Own the bytes before waiting for the journal, so callers cannot change a verified buffer.
    const bytes = Buffer.from(raw);
    const result = await this.access((document) => {
      const hook = document.hooks.find((entry) => entry.hookId === hookId);
      if (!hook) throw new GitHubWebhookError(404, 'Webhook not found');
      const expected = createHmac('sha256', hook.secret).update(bytes).digest();
      if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'))) throw new GitHubWebhookError(401, 'Invalid webhook signature');
      let payload: unknown;
      try { payload = JSON.parse(bytes.toString('utf8')); }
      catch { throw new GitHubWebhookError(400, 'Invalid webhook JSON'); }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new GitHubWebhookError(400, 'Invalid webhook JSON');
      const now = new Date().toISOString();
      const hash = createHash('sha256').update(bytes).digest('hex');
      hook.deliveries = hook.deliveries.filter((entry) => Date.parse(entry.at) > Date.now() - replayAge);
      if (hook.deliveries.some((entry) => entry.id === delivery || entry.hash === hash)) {
        return { status: 200, body: { duplicate: true } };
      }
      hook.deliveries.push({ id: delivery, hash, at: now });
      hook.deliveries = hook.deliveries.slice(-128);
      hook.lastDeliveryAt = now;
      hook.lastEvent = event;
      const body = payload as Record<string, unknown>;
      const repository = body.repository as { full_name?: unknown; id?: unknown } | undefined;
      const repositoryId = repository?.id;
      const validId = typeof repositoryId === 'number' && Number.isSafeInteger(repositoryId) && repositoryId > 0;
      const matchesRepository = typeof repository?.full_name === 'string'
        && repository.full_name.toLowerCase() === hook.repository
        && (repositoryId === undefined || validId)
        && (hook.repositoryId === undefined || hook.repositoryId === repositoryId);
      const push = event === 'push' && validId && body.ref === `refs/heads/${hook.branch}`
        && body.deleted === false && typeof body.after === 'string' && /^[a-f0-9]{40}$/.test(body.after) && !/^0+$/.test(body.after);
      if (!matchesRepository || (event !== 'ping' && !push)) return { status: 200, body: { ignored: true } };
      hook.verified = true;
      if (validId) hook.repositoryId = repositoryId;
      if (!push || !hook.enabled) return { status: 200, body: { verified: true } };
      hook.pending = true;
      if (!hook.inFlight) hook.lastUpdate = { status: 'queued', updatedAt: now };
      return { status: 202, body: { queued: true } };
    }, true);
    if (result.status === 202) this.schedule();
    return result;
  }

  async start(): Promise<void> {
    const lifecycle = this.lifecycle;
    if (!this.startup) {
      this.startup = this.access((document) => {
        for (const hook of document.hooks) if (hook.inFlight) {
          delete hook.inFlight;
          hook.lastUpdate = { status: 'interrupted', updatedAt: new Date().toISOString(), message: interruptedMessage };
        }
      }, true);
    }
    await this.startup;
    if (lifecycle !== this.lifecycle) return;
    this.started = true;
    this.schedule();
  }

  /** Does not cancel an updater already running; its result is still journaled. */
  stop(): void {
    this.lifecycle++;
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Drain runnable work; busy Apps stay queued for an unref'ed deferred retry. */
  async drain(): Promise<void> {
    if (this.worker) return this.worker;
    if (!this.started) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.worker = this.dispatch();
    try { await this.worker; }
    catch (error) { this.stop(); throw error; }
    finally {
      this.worker = undefined;
      if (this.started && await this.access((document) => document.hooks.some((hook) => hook.pending))) this.schedule(1000);
    }
  }

  private schedule(delay = 10): void {
    if (!this.started || this.worker || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain().catch(() => { this.stop(); });
    }, delay);
    this.timer.unref();
  }

  private async dispatch(): Promise<void> {
    const deferred = new Set<string>();
    while (this.started) {
      const candidate = await this.access((document) => {
        const hook = document.hooks.find((entry) => entry.pending && !deferred.has(entry.appId));
        return hook ? { appId: hook.appId, hookId: hook.hookId, repository: hook.repository, branch: hook.branch } : undefined;
      });
      if (!candidate) return;
      try {
        if (this.callbacks.busy(candidate.appId)) { deferred.add(candidate.appId); continue; }
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'app_busy') {
          deferred.add(candidate.appId);
          continue;
        }
        await this.access((document) => {
          const hook = document.hooks.find((entry) => entry.hookId === candidate.hookId);
          if (hook?.pending) {
            hook.pending = false;
            hook.lastUpdate = { status: 'failed', updatedAt: new Date().toISOString(), message: failureMessage };
          }
        }, true);
        continue;
      }
      const run = randomUUID();
      const admitted = await this.access((document) => {
        const hook = document.hooks.find((entry) => entry.hookId === candidate.hookId);
        if (!this.started || !hook?.pending || !hook.enabled || !hook.verified) return false;
        hook.pending = false;
        hook.inFlight = run;
        hook.lastUpdate = { status: 'running', updatedAt: new Date().toISOString() };
        return true;
      }, true);
      if (!admitted) continue;
      let status: 'succeeded' | 'failed' | 'queued' | 'interrupted' = 'failed';
      let commit: string | undefined;
      try {
        this.assertTarget(candidate, await this.target(candidate.appId));
        const valid = await this.access((document) => document.hooks.some((hook) =>
          hook.hookId === candidate.hookId && hook.inFlight === run && hook.enabled && hook.verified));
        if (!valid) { status = 'interrupted'; continue; }
        if (!this.started || this.callbacks.busy(candidate.appId)) {
          status = 'queued';
        } else {
          // The updater fetches the stored branch's latest commit; no payload URL/SHA is executed.
          const result = await this.callbacks.update(candidate.appId);
          if (!updateSchema.shape.commit.safeParse(result.commit).success || !result.commit) throw new Error();
          commit = result.commit;
          status = 'succeeded';
        }
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'app_busy') status = 'queued';
      } finally {
        if (status === 'queued') deferred.add(candidate.appId);
        await this.access((document) => {
          const hook = document.hooks.find((entry) => entry.hookId === candidate.hookId && entry.inFlight === run);
          if (!hook) return;
          delete hook.inFlight;
          if (status === 'queued' && hook.enabled) hook.pending = true;
          hook.lastUpdate = {
            status: status === 'queued' && !hook.enabled ? 'interrupted' : status,
            updatedAt: new Date().toISOString(),
            ...(commit ? { commit } : {}),
            ...(status === 'failed' ? { message: failureMessage } : {}),
          };
        }, true);
      }
    }
  }

  private async target(appId: string): Promise<GitHubWebhookTarget> {
    try {
      const target = await this.callbacks.target(appId);
      if (target.ready !== true || !appIdSchema.safeParse(target.appId).success
        || !repositorySchema.safeParse(target.repository).success || !branchSchema.safeParse(target.branch).success) throw new Error();
      return { appId: target.appId, appName: target.appName, repository: target.repository, branch: target.branch, ready: true };
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'app_busy') {
        throw Object.assign(new GitHubWebhookError(409, 'App is busy'), { code: 'app_busy' });
      }
      throw new GitHubWebhookError(409, 'App is not ready for GitHub webhooks');
    }
  }

  private assertTarget(hook: Pick<Hook, 'appId' | 'repository' | 'branch'>, target: GitHubWebhookTarget): void {
    if (hook.appId !== target.appId || hook.repository !== target.repository || hook.branch !== target.branch) {
      throw new GitHubWebhookError(409, 'Webhook target changed; remove it and request a new setup');
    }
  }

  private hook(document: Document, appId: string, hookId: string): Hook {
    const hook = document.hooks.find((entry) => entry.appId === appId && entry.hookId === hookId);
    if (!hook) throw new GitHubWebhookError(404, 'Webhook not found');
    return hook;
  }

  private safe(hook: Hook): GitHubWebhookSetup {
    return {
      kind: 'github-webhook', appId: hook.appId, hookId: hook.hookId,
      repository: hook.repository, branch: hook.branch,
      payloadUrl: `https://${this.hostname}/api/webhooks/github/${hook.hookId}`,
      settingsUrl: `https://github.com/${hook.repository}/settings/hooks`,
      enabled: hook.enabled, verified: hook.verified,
      ...(hook.lastDeliveryAt ? { lastDeliveryAt: hook.lastDeliveryAt } : {}),
      ...(hook.lastEvent ? { lastEvent: hook.lastEvent } : {}),
      ...(hook.lastUpdate ? { lastUpdate: {
        status: hook.lastUpdate.status, updatedAt: hook.lastUpdate.updatedAt,
        ...(hook.lastUpdate.commit ? { commit: hook.lastUpdate.commit } : {}),
        ...(hook.lastUpdate.message ? { message: hook.lastUpdate.message } : {}),
      } } : {}),
    };
  }

  private async load(): Promise<void> {
    try {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const file = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > maxDocumentBytes) throw new Error();
        await file.chmod(0o600);
        this.document = documentSchema.parse(JSON.parse(await file.readFile('utf8')));
      } finally { await file.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new GitHubWebhookError(503, 'Webhook store unavailable');
    }
  }

  // Callbacks must be synchronous: target/busy/update I/O never runs under this lock.
  private async access<T>(action: (document: Document) => T, write = false): Promise<T> {
    await (this.loading ??= this.load());
    const operation = this.lock.then(async () => {
      if (this.storageFailed) throw new GitHubWebhookError(503, 'Webhook store unavailable');
      const document = write ? structuredClone(this.document) : this.document;
      const result = action(document);
      if (write && JSON.stringify(document) !== JSON.stringify(this.document)) {
        try {
          const contents = JSON.stringify(documentSchema.parse(document));
          if (Buffer.byteLength(contents) > maxDocumentBytes) throw new Error();
          await this.write(contents);
          this.document = document;
        } catch {
          // A failed directory sync may follow a successful rename. Fail closed until restart.
          this.storageFailed = true;
          throw new GitHubWebhookError(503, 'Webhook store unavailable');
        }
      }
      return result;
    });
    this.lock = operation.catch(() => {});
    return operation;
  }

  private async write(contents: string): Promise<void> {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(contents); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, this.file);
      const directory = await open(path.dirname(this.file), 'r');
      try { await directory.sync(); }
      finally { await directory.close(); }
    } finally { await rm(temporary, { force: true }); }
  }
}
