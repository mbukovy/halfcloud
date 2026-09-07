import express, { type ErrorRequestHandler } from 'express';
import { GitHubWebhookError, githubWebhookBodyLimit, type GitHubWebhookService } from './github-webhooks.js';

// Mount this exact ingress before JSON, browser CSRF, and session middleware.
export function githubWebhookReceiver(service: () => GitHubWebhookService) {
  const router = express.Router();
  router.use((request, _response, next) => {
    if (request.method !== 'POST') return next('router');
    next();
  });
  router.post('/:hookId', (request, response, next) => {
    if (!request.is('application/json')) {
      response.status(415).json({ error: 'GitHub webhooks require application/json' });
      return;
    }
    next();
  }, express.raw({ type: 'application/json', limit: githubWebhookBodyLimit, inflate: false }), async (request, response) => {
    const headers = ['x-hub-signature-256', 'x-github-event', 'x-github-delivery'];
    for (const header of headers) {
      const count = request.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === header).length;
      if (count !== 1) throw new GitHubWebhookError(400, 'Missing or duplicate GitHub webhook headers');
    }
    const result = await service().receive(request.params.hookId, request.body, request.get(headers[0]!)!, request.get(headers[1]!)!, request.get(headers[2]!)!);
    response.status(result.status).json(result.body);
  });
  const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    const parserStatus = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
    const status = error instanceof GitHubWebhookError ? error.status : parserStatus === 413 || parserStatus === 415 || parserStatus === 400 ? parserStatus : 503;
    // Do not log payloads, signatures, parser input, or callback errors.
    response.status(status).json({ error: error instanceof GitHubWebhookError ? error.message : 'GitHub webhook request could not be accepted' });
  };
  router.use(errorHandler);
  return router;
}
