import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

// This client calls the server-owned updater, so CLI and chat share the same locks and recovery.
async function main() {
  const appId = process.argv[2];
  if (!appId || process.argv.length !== 3) throw new Error('Usage: npm run update:app -- "App name or ID"');
  const accessCode = process.env.HALFCLOUD_ACCESS_CODE;
  if (!accessCode) throw new Error('Set HALFCLOUD_ACCESS_CODE in the environment; do not pass it as an argument');
  const url = new URL(process.env.HALFCLOUD_URL ?? 'http://127.0.0.1:9000');
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
    throw new Error('HALFCLOUD_URL must use HTTPS, or HTTP on localhost, without embedded credentials');
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Origin: url.origin };
  const login = await fetch(new URL('/api/auth/login', url), { method: 'POST', headers, body: JSON.stringify({ accessCode }), redirect: 'error' });
  if (!login.ok) throw new Error(`HalfCloud login failed (HTTP ${login.status})`);
  headers.Cookie = login.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; ');
  await login.body?.cancel();
  if (!headers.Cookie) throw new Error('HalfCloud login did not return a session');
  // Native requests have no five-minute fetch response-header deadline; a multi-Service build may take longer.
  const result = await new Promise<unknown>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(new URL(`/api/apps/${encodeURIComponent(appId)}/update`, url), { method: 'POST', headers }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > 1024 * 1024) response.destroy(new Error('Update response exceeds safety limits'));
      });
      response.once('error', reject);
      response.once('end', () => {
        try {
          const value = JSON.parse(body) as { error?: string };
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) throw new Error(value.error ?? `Update failed (HTTP ${response.statusCode})`);
          resolve(value);
        } catch (error) { reject(error); }
      });
    });
    request.once('error', reject);
    request.end('{}');
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Update failed');
  process.exitCode = 1;
});
