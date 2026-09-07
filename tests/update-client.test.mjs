import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const clientPath = fileURLToPath(new URL('../dist/backend/update-app.js', import.meta.url));
const accessCode = 'fixture-access-code';

async function runClient(url, args = ['Fixture App'], env = {}) {
  const child = spawn(process.execPath, [clientPath, ...args], {
    // Do not inherit real access codes, provider keys, or Node preload options.
    env: { HALFCLOUD_URL: url, HALFCLOUD_ACCESS_CODE: accessCode, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
    killSignal: 'SIGKILL',
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const [code, signal] = await once(child, 'close');
  assert.equal(signal, null, `CLI terminated by a signal: ${stderr}`);
  return { code, stdout, stderr };
}

async function mockServer(t, status = 200, result = { success: true }) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8').on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests.push({
        method: request.method,
        url: request.url,
        contentType: request.headers['content-type'],
        origin: request.headers.origin,
        cookie: request.headers.cookie,
        body,
      });
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/api/auth/login') {
        response.setHeader('Set-Cookie', [
          'session=fixture-session; HttpOnly; Path=/; SameSite=Strict',
          'other=fixture-other; Path=/',
        ]);
        response.end('{}');
      } else {
        response.statusCode = status;
        response.end(JSON.stringify(result));
      }
    });
  });
  t.after(() => new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

test('update CLI authenticates, encodes the app name, and forwards cookies with an empty update body', async (t) => {
  const result = { success: true, appId: 'app_fixture' };
  const { url, requests } = await mockServer(t, 200, result);
  const output = await runClient(url, ['Fixture App/blue?#%']);

  assert.equal(output.code, 0, output.stderr);
  assert.equal(output.stderr, '');
  assert.deepEqual(JSON.parse(output.stdout), result);
  assert.deepEqual(requests, [
    {
      method: 'POST',
      url: '/api/auth/login',
      contentType: 'application/json',
      origin: url,
      cookie: undefined,
      body: JSON.stringify({ accessCode }),
    },
    {
      method: 'POST',
      url: '/api/apps/Fixture%20App%2Fblue%3F%23%25/update',
      contentType: 'application/json',
      origin: url,
      cookie: 'session=fixture-session; other=fixture-other',
      body: '{}',
    },
  ]);
});

test('update CLI exits nonzero and reports the server error when the update fails', async (t) => {
  const { url, requests } = await mockServer(t, 409, { error: 'Fixture update is already running' });
  const output = await runClient(url, ['app_fixture']);

  assert.equal(output.code, 1);
  assert.equal(output.stdout, '');
  assert.equal(output.stderr.trim(), 'Fixture update is already running');
  assert.deepEqual(requests.map((request) => request.url), [
    '/api/auth/login', '/api/apps/app_fixture/update',
  ]);
});

test('update CLI rejects missing access codes and invalid arguments before sending HTTP requests', async (t) => {
  const { url, requests } = await mockServer(t);
  const cases = [
    { args: ['app_fixture'], env: { HALFCLOUD_ACCESS_CODE: undefined }, error: /Set HALFCLOUD_ACCESS_CODE/ },
    { args: [], error: /Usage: npm run update:app/ },
    { args: [''], error: /Usage: npm run update:app/ },
    { args: ['app_fixture', accessCode], error: /Usage: npm run update:app/ },
  ];
  for (const { args, env, error } of cases) {
    const output = await runClient(url, args, env);
    assert.equal(output.code, 1, JSON.stringify(args));
    assert.equal(output.stdout, '');
    assert.match(output.stderr, error);
    assert.ok(!output.stderr.includes(accessCode));
  }
  assert.deepEqual(requests, []);
});

test('update CLI rejects remote HTTP and URLs with embedded credentials', async (t) => {
  const { url, requests } = await mockServer(t);
  for (const unsafeUrl of [
    'http://halfcloud.invalid',
    url.replace('http://', 'http://fixture-user@'),
    url.replace('http://', 'http://:fixture-password@'),
    'https://fixture-user:fixture-password@halfcloud.invalid',
  ]) {
    const output = await runClient(unsafeUrl);
    assert.equal(output.code, 1, unsafeUrl);
    assert.equal(output.stdout, '');
    assert.equal(output.stderr.trim(), 'HALFCLOUD_URL must use HTTPS, or HTTP on localhost, without embedded credentials');
  }
  assert.deepEqual(requests, []);
});
