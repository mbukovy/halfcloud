import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { CaddyService } from '../dist/backend/caddy.js';

test('identifies the request origin when loading Caddy configuration', async (t) => {
  let request;
  const server = createServer((incoming, response) => {
    let body = '';
    incoming.setEncoding('utf8');
    incoming.on('data', (chunk) => (body += chunk));
    incoming.on('end', () => {
      request = { body, headers: incoming.headers, method: incoming.method, url: incoming.url };
      response.writeHead(200).end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const address = server.address();
  assert(address && typeof address === 'object');
  const endpoint = `http://127.0.0.1:${address.port}`;
  process.env.CADDY_ADMIN_URL = endpoint;
  process.env.HALFCLOUD_HOSTNAME = 'halfcloud.example.com';

  await new CaddyService().sync([]);

  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/load');
  assert.equal(request.headers.origin, endpoint);
  assert.equal(request.headers['content-type'], 'text/caddyfile');
  assert.match(request.body, /halfcloud\.example\.com/);
});

test('routes every domain attached to an application', async (t) => {
  let body = '';
  const server = createServer((incoming, response) => {
    incoming.setEncoding('utf8');
    incoming.on('data', (chunk) => (body += chunk));
    incoming.on('end', () => response.writeHead(200).end());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const address = server.address();
  assert(address && typeof address === 'object');
  process.env.CADDY_ADMIN_URL = `http://127.0.0.1:${address.port}`;
  process.env.HALFCLOUD_HOSTNAME = 'halfcloud.example.com';

  await new CaddyService().sync([{
    domains: [
      { hostname: 'n8n.example.com', access: { type: 'public' } },
      { hostname: 'n8n.127.0.0.1.nip.io', access: { type: 'public' } },
    ],
    ports: [{ host: 10023, protocol: 'tcp' }],
    state: 'running',
  }]);

  assert.match(body, /n8n\.example\.com \{/);
  assert.match(body, /n8n\.127\.0\.0\.1\.nip\.io \{/);
  assert.match(body, /reverse_proxy 127\.0\.0\.1:10023/);
});

test('configures Basic Auth independently for one route', async (t) => {
  let body = '';
  const server = createServer((incoming, response) => {
    incoming.setEncoding('utf8');
    incoming.on('data', (chunk) => (body += chunk));
    incoming.on('end', () => response.writeHead(200).end());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');
  process.env.CADDY_ADMIN_URL = `http://127.0.0.1:${address.port}`;
  process.env.HALFCLOUD_HOSTNAME = 'halfcloud.example.com';

  await new CaddyService().sync([{
    domains: [
      { hostname: 'public.example.com', access: { type: 'public' } },
      { hostname: 'admin.example.com', access: { type: 'basic_auth', username: 'michal', passwordHash: '$argon2id$hash' } },
    ],
    ports: [{ host: 10023, protocol: 'tcp' }],
    state: 'running',
  }]);

  assert.doesNotMatch(body.match(/public\.example\.com \{[\s\S]*?\n\}/)?.[0] ?? '', /basic_auth/);
  assert.match(body, /admin\.example\.com \{\n  basic_auth argon2id \{\n    michal \$argon2id\$hash\n  \}/);
});
