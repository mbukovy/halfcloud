import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z, ZodError } from 'zod';
import { AuthService } from './auth.js';
import { SettingsStore } from './config.js';
import { DockerService } from './docker.js';
import { ApplicationService } from './applications.js';
import { createChatResponse } from './agent.js';
import { GitRepositoryError } from './repositories.js';
import { getServerStats } from './metrics.js';
import { credentialsSchema } from './llm/types.js';
import { listModels, providerMetadata, testModel } from './llm/index.js';
import type { LlmCredentials } from './llm/types.js';

const app = express();
const port = Number(process.env.PORT ?? 9000);
const auth = await AuthService.create();
const settings = new SettingsStore();
const docker = new ApplicationService(new DockerService());
await docker.assertRootless();
await docker.syncRoutes();
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

async function resolveLlmCredentials(value: unknown): Promise<LlmCredentials> {
  const input = z.object({ provider: z.enum(['openai', 'anthropic', 'azure-foundry', 'cerebras', 'grok', 'gemini']), apiKey: z.string().optional(), endpoint: z.string().optional() }).parse(value);
  const active = await settings.get();
  const apiKey = input.apiKey || (active?.provider === input.provider ? active.apiKey : undefined);
  const endpoint = input.endpoint || (active?.provider === input.provider ? active.endpoint : undefined);
  return credentialsSchema.parse({ provider: input.provider, apiKey, endpoint });
}

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use('/api', (request, response, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return next();
  const origin = request.get('origin');
  const expectedOrigin = `${request.protocol}://${request.get('host')}`;
  if (request.get('sec-fetch-site') === 'cross-site' || (origin && origin !== expectedOrigin)) {
    response.status(403).json({ error: 'Cross-origin request blocked' });
    return;
  }
  if (!request.is('application/json')) {
    response.status(415).json({ error: 'JSON request required' });
    return;
  }
  next();
});

app.get('/api/health', async (_request, response) => {
  try {
    await docker.ping();
    response.json({ status: 'healthy' });
  } catch {
    response.status(503).json({ status: 'unhealthy' });
  }
});

app.get('/api/auth/session', (request, response) => response.json({ authenticated: auth.isAuthenticated(request) }));
app.post('/api/auth/login', (request, response) => {
  const key = request.ip ?? 'unknown';
  const now = Date.now();
  const attempt = loginAttempts.get(key);
  if (attempt && attempt.resetAt > now && attempt.count >= 8) {
    response.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    return;
  }
  if (!auth.verifyAccessCode(request.body?.accessCode)) {
    loginAttempts.set(key, attempt && attempt.resetAt > now ? { ...attempt, count: attempt.count + 1 } : { count: 1, resetAt: now + 15 * 60_000 });
    response.status(401).json({ error: 'Invalid access code' });
    return;
  }
  loginAttempts.delete(key);
  auth.setSession(response);
  response.json({ authenticated: true });
});
app.post('/api/auth/logout', auth.middleware, (_request, response) => {
  auth.clearSession(response);
  response.status(204).end();
});

app.use('/api', (request, response, next) => {
  if (request.path === '/health' || request.path.startsWith('/auth/')) return next();
  auth.middleware(request, response, next);
});

app.get('/api/settings', async (_request, response) => response.json(await settings.publicValue()));
app.get('/api/settings/llm', async (_request, response) => response.json({ ...(await settings.publicValue()), providers: providerMetadata }));
app.get('/api/settings/llm/models', async (_request, response) => {
  const active = await settings.get();
  if (!active) return response.status(409).json({ error: 'Configure an AI provider first' });
  response.json({ models: await listModels(active) });
});
app.post('/api/settings/llm/test', async (request, response) => {
  const credentials = await resolveLlmCredentials(request.body);
  const models = await listModels(credentials);
  if (!request.body?.model) {
    response.json({ success: true, models });
    return;
  }
  const model = z.string().min(1).parse(request.body.model);
  const capabilities = await testModel(credentials, model);
  response.json({ success: true, models, capabilities });
});
app.put('/api/settings/llm', async (request, response) => {
  const credentials = await resolveLlmCredentials(request.body);
  const model = z.string().min(1).parse(request.body.model);
  const capabilities = await testModel(credentials, model);
  response.json(await settings.save({ ...credentials, model, capabilities, verifiedAt: new Date().toISOString() }));
});
app.get('/api/server/stats', async (_request, response) => response.json({ ...(await getServerStats()), docker: await docker.getRuntimeInfo() }));
app.get('/api/apps', async (_request, response) => response.json(await docker.listApps()));
app.get('/api/apps/:appId', async (request, response) => response.json(await docker.getApp(request.params.appId)));
app.patch('/api/apps/:appId', async (request, response) => response.json(await docker.renameApp(request.params.appId, z.string().min(1).max(128).parse(request.body?.name))));
app.get('/api/apps/:appId/logs', async (request, response) => response.json(await docker.getAppLogs(request.params.appId, Number(request.query.tail ?? 200))));
app.post('/api/apps/:appId/:action', async (request, response) => {
  const action = z.enum(['start', 'stop', 'restart', 'recreate', 'delete']).parse(request.params.action);
  if (action === 'delete') {
    if (request.body?.confirmed !== true) return response.status(400).json({ error: 'Deletion requires confirmation' });
    response.json(await docker.deleteApp(request.params.appId, request.body?.deleteData === true));
    return;
  }
  const methods = { start: docker.startApp.bind(docker), stop: docker.stopApp.bind(docker), restart: docker.restartApp.bind(docker), recreate: docker.recreateApp.bind(docker) };
  response.json(await methods[action](request.params.appId));
});
app.post('/api/apps/:appId/repository/verify', async (request, response) => {
  response.json(await docker.verifyRepositoryDeployKey(request.params.appId));
});
app.get('/api/containers', async (_request, response) => response.json(await docker.listContainers()));
app.get('/api/containers/:id/environment', async (request, response) => {
  response.json({ variables: await docker.listEnvironment(request.params.id) });
});
app.get('/api/containers/:id/logs', async (request, response) => {
  response.json(await docker.getContainerLogs(request.params.id, Number(request.query.tail ?? 200)));
});
app.post('/api/containers/:id/:action', async (request, response) => {
  const action = z.enum(['start', 'stop', 'restart', 'delete']).parse(request.params.action);
  const id = request.params.id;
  if (action === 'delete') {
    if (request.body?.confirmed !== true) {
      response.status(400).json({ error: 'Deletion requires confirmation' });
      return;
    }
    response.json(await docker.deleteContainer(id));
    return;
  }
  const methods = { start: docker.startContainer.bind(docker), stop: docker.stopContainer.bind(docker), restart: docker.restartContainer.bind(docker) };
  response.json(await methods[action](id));
});
app.put('/api/containers/:id/environment/:key', async (request, response) => {
  response.json(await docker.saveEnvironmentVariable(request.params.id, {
    variableId: request.params.key === 'new' ? undefined : request.params.key,
    name: z.string().parse(request.body?.name),
    value: z.string().parse(request.body?.value),
    protectedFromAI: z.boolean().optional().parse(request.body?.protectedFromAI),
  }));
});
app.put('/api/containers/:id/environment', async (request, response) => {
  const variables = z.array(z.object({
    id: z.string().min(1).optional(),
    name: z.string().min(1),
    value: z.string(),
    protectedFromAI: z.boolean(),
  })).max(500).parse(request.body?.variables);
  response.json(await docker.saveEnvironmentVariables(request.params.id, variables));
});
app.delete('/api/containers/:id/environment/:variableId', async (request, response) => {
  response.json(await docker.deleteEnvironmentVariable(request.params.id, request.params.variableId));
});
app.put('/api/containers/:id/environment-requests/:requestId', async (request, response) => {
  response.json(await docker.completeEnvironmentRequest(
    request.params.id,
    request.params.requestId,
    z.string().min(1).max(65536).parse(request.body?.value),
    z.boolean().optional().parse(request.body?.protectedFromAI) ?? true,
  ));
});
app.get('/api/containers/:id/domains', async (request, response) => {
  response.json(await docker.listDomains(request.params.id));
});
app.post('/api/containers/:id/domains', async (request, response) => {
  response.json(await docker.addDomain(request.params.id, z.string().parse(request.body?.hostname)));
});
app.put('/api/containers/:id/domains/:hostname/primary', async (request, response) => {
  response.json(await docker.setPrimaryDomain(request.params.id, request.params.hostname));
});
app.delete('/api/containers/:id/domains/:hostname', async (request, response) => {
  response.json(await docker.removeDomain(request.params.id, request.params.hostname, request.body?.allowManaged === true));
});
app.put('/api/routes/:routeId/basic-auth-requests/:requestId', async (request, response) => {
  response.json(await docker.completeBasicAuthRequest(
    request.params.routeId,
    request.params.requestId,
    z.string().min(1).max(128).parse(request.body?.username),
    z.string().min(8).max(1024).parse(request.body?.password),
  ));
});

app.post('/api/chat', async (request, response) => {
  const requestId = randomUUID();
  response.setHeader('x-request-id', requestId);
  const aiSettings = await settings.get();
  if (!aiSettings) {
    response.status(409).json({ error: 'Configure an AI provider before using chat' });
    return;
  }
  const messages = z.array(z.object({ id: z.string(), role: z.enum(['system', 'user', 'assistant']), parts: z.array(z.any()) }).passthrough()).max(100).parse(request.body?.messages);
  const abortController = new AbortController();
  request.once('aborted', () => abortController.abort());
  response.once('close', () => {
    if (!response.writableFinished) abortController.abort();
  });
  console.log(`[chat:${requestId}] Starting LLM request (provider=${aiSettings.provider}, model=${aiSettings.model}, messages=${messages.length})`);
  const webResponse = await createChatResponse(aiSettings, docker, messages, abortController.signal, requestId);
  response.status(webResponse.status);
  webResponse.headers.forEach((value, key) => response.setHeader(key, value));
  if (!webResponse.body) {
    response.end();
    return;
  }
  const stream = Readable.fromWeb(webResponse.body as import('node:stream/web').ReadableStream);
  stream.once('error', (error) => {
    console.error(`[chat:${requestId}] Response stream failed`, error);
    abortController.abort();
  });
  stream.pipe(response);
});

const publicPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
app.use(express.static(publicPath, { index: false, maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
app.get('*splat', (_request, response) => response.sendFile(path.join(publicPath, 'index.html')));

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  const message = error instanceof ZodError ? error.issues[0]?.message ?? 'Invalid request' : error instanceof Error ? error.message : 'Unexpected error';
  console.error(error instanceof Error ? error.message : error);
  const status = error instanceof ZodError ? 400
    : error instanceof GitRepositoryError
      ? error.code === 'invalid_url' ? 400 : error.code === 'not_found' ? 404 : error.code === 'authentication_required' ? 409 : 502
      : 500;
  if (!response.headersSent) response.status(status).json({ error: message });
});

app.listen(port, '127.0.0.1', () => console.log(`HalfCloud listening on 127.0.0.1:${port}`));
