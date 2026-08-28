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
import { getServerStats } from './metrics.js';

const app = express();
const port = Number(process.env.PORT ?? 9000);
const auth = await AuthService.create();
const settings = new SettingsStore();
const docker = new ApplicationService(new DockerService());
await docker.assertRootless();
await docker.ensureNetwork();
await docker.syncRoutes();
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

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
app.put('/api/settings', async (request, response) => response.json(await settings.save({ ...request.body, provider: 'azure' })));
app.get('/api/server/stats', async (_request, response) => response.json({ ...(await getServerStats()), docker: await docker.getRuntimeInfo() }));
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
app.delete('/api/containers/:id/environment/:variableId', async (request, response) => {
  response.json(await docker.deleteEnvironmentVariable(request.params.id, request.params.variableId));
});
app.put('/api/containers/:id/environment-requests/:requestId', async (request, response) => {
  response.json(await docker.completeEnvironmentRequest(
    request.params.id,
    request.params.requestId,
    z.string().parse(request.body?.value),
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

app.post('/api/chat', async (request, response) => {
  const requestId = randomUUID();
  response.setHeader('x-request-id', requestId);
  const aiSettings = await settings.get();
  if (!aiSettings) {
    response.status(409).json({ error: 'Configure Azure OpenAI before using chat' });
    return;
  }
  const messages = z.array(z.object({ id: z.string(), role: z.enum(['system', 'user', 'assistant']), parts: z.array(z.any()) }).passthrough()).max(100).parse(request.body?.messages);
  const abortController = new AbortController();
  request.once('aborted', () => abortController.abort());
  response.once('close', () => {
    if (!response.writableFinished) abortController.abort();
  });
  console.log(`[chat:${requestId}] Starting Azure OpenAI request (endpoint=${aiSettings.endpoint}, deployment=${aiSettings.deployment}, messages=${messages.length})`);
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
  if (!response.headersSent) response.status(error instanceof ZodError ? 400 : 500).json({ error: message });
});

app.listen(port, '127.0.0.1', () => console.log(`HalfCloud listening on 127.0.0.1:${port}`));
