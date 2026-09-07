// Run with: node --import tsx --test frontend/tests/github-webhook.test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { compileScript, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { createRenderer, h, nextTick, reactive } from 'vue';
import {
  getGitHubWebhookSecret, getGitHubWebhookSetup, rotateGitHubWebhookSecret,
  safeGitHubWebhookSetup, setGitHubWebhookEnabled,
} from '../src/api.ts';

const setup = {
  kind: 'github-webhook', appId: 'app_1', hookId: 'hook_1', repository: 'owner/repo', branch: 'main',
  payloadUrl: 'https://control/api/webhooks/github/hook_1',
  settingsUrl: 'https://github.com/owner/repo/settings/hooks', enabled: false, verified: false,
};
const secret = 'test-only-secret-not-for-history';
const response = (body, status = 200) => ({ ok: status === 200, status, json: async () => structuredClone(body) });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const flush = async () => { await new Promise(setImmediate); await nextTick(); };

test('safe setup reconstructs allowlisted fields, including nested update metadata', () => {
  const update = { status: 'failed', updatedAt: '2026-09-07T12:00:00Z', commit: 'abcdef', message: 'Build failed' };
  const safe = safeGitHubWebhookSetup({
    ...setup, secret, debug: secret, lastDeliveryAt: update.updatedAt, lastEvent: 'push',
    lastUpdate: { ...update, secret, rawResponse: secret },
  });
  assert.deepEqual(safe, { ...setup, lastDeliveryAt: update.updatedAt, lastEvent: 'push', lastUpdate: update });
  assert.ok(!JSON.stringify(safe).includes(secret));
  assert.equal(safeGitHubWebhookSetup({ ...setup, enabled: 'false' }), undefined);
  assert.equal(safeGitHubWebhookSetup({ ...setup, payloadUrl: 'http://control/api/webhooks/github/hook_1' }), undefined);
  assert.equal(safeGitHubWebhookSetup({ ...setup, payloadUrl: `${setup.payloadUrl}?secret=${secret}` }), undefined);
  assert.equal(safeGitHubWebhookSetup({ ...setup, settingsUrl: 'javascript:alert(1)' }), undefined);
  assert.equal(safeGitHubWebhookSetup({ ...setup, lastUpdate: { ...update, status: 'unknown' } }).lastUpdate, undefined);
});

test('webhook API uses trusted session routes and strips extras from all safe responses', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return response(url.endsWith('/secret') ? { secret, debug: secret } : { ...setup, secret });
  });
  const signal = new AbortController().signal;
  assert.deepEqual(await getGitHubWebhookSetup(setup.appId, signal), setup);
  assert.deepEqual(await setGitHubWebhookEnabled(setup.appId, setup.hookId, true, signal), setup);
  assert.deepEqual(await rotateGitHubWebhookSecret(setup.appId, setup.hookId, signal), setup);
  assert.equal(await getGitHubWebhookSecret(setup.appId, setup.hookId, signal), secret);
  assert.deepEqual(calls.map(({ url, options }) => [url, options.method, options.body]), [
    ['/api/apps/app_1/github-webhook', 'GET', undefined],
    ['/api/apps/app_1/github-webhook', 'PUT', JSON.stringify({ hookId: setup.hookId, enabled: true })],
    ['/api/apps/app_1/github-webhook/rotate', 'POST', JSON.stringify({ hookId: setup.hookId })],
    ['/api/apps/app_1/github-webhook/secret', 'POST', JSON.stringify({ hookId: setup.hookId })],
  ]);
  for (const { options } of calls) {
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.redirect, 'error');
    assert.equal(options.signal, signal);
    assert.ok(!JSON.stringify(options).includes(secret));
  }
});

test('API failures never expose response or transport errors, and 401 clears the session', async (t) => {
  globalThis.window = new EventTarget();
  t.after(() => { delete globalThis.window; });
  let unauthorized = false;
  window.addEventListener('halfcloud:unauthorized', () => { unauthorized = true; });
  t.mock.method(globalThis, 'fetch', async () => response({ error: secret }, 401));
  await assert.rejects(getGitHubWebhookSecret(setup.appId, setup.hookId, new AbortController().signal), (error) => !error.message.includes(secret));
  assert.equal(unauthorized, true);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error(secret); });
  await assert.rejects(getGitHubWebhookSetup(setup.appId, new AbortController().signal), (error) => !error.message.includes(secret));
  t.mock.method(globalThis, 'fetch', async () => response({ ...setup, appId: 'other-app' }));
  await assert.rejects(getGitHubWebhookSetup(setup.appId, new AbortController().signal), /Could not read/);
});

// Use Vue's real compiler and renderer without adding a browser-test dependency.
const filename = new URL('../src/components/GitHubWebhookSetup.vue', import.meta.url);
const { descriptor } = parse(await readFile(filename, 'utf8'));
const compiled = compileScript(descriptor, { id: 'webhook-test', inlineTemplate: true }).content;
const javascript = ts.transpileModule(compiled, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  .replace(/from (['"])vue\1/g, `from ${JSON.stringify(import.meta.resolve('vue'))}`)
  .replace(/from (['"])\.\.\/api\1/g, `from ${JSON.stringify(new URL('../src/api.ts', import.meta.url).href)}`);
const Component = (await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`)).default;
const node = (type, text = '') => ({ type, text, children: [], props: {}, parent: null });
const renderer = createRenderer({
  createElement: node,
  createText: (text) => node('text', text),
  createComment: () => node('comment'),
  setText: (element, text) => { element.text = text; },
  setElementText: (element, text) => { element.text = text; element.children = []; },
  patchProp: (element, key, _old, value) => { element.props[key] = value; },
  parentNode: (element) => element.parent,
  nextSibling: (element) => element.parent?.children[element.parent.children.indexOf(element) + 1],
  insert(element, parent, anchor) {
    if (element.parent) element.parent.children.splice(element.parent.children.indexOf(element), 1);
    element.parent = parent;
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    if (index < 0) parent.children.push(element);
    else parent.children.splice(index, 0, element);
  },
  remove(element) {
    element.parent?.children.splice(element.parent.children.indexOf(element), 1);
    element.parent = null;
  },
});
const text = (element) => `${element.text}${element.children.map(text).join('')}`;
const all = (element) => [element, ...element.children.flatMap(all)];
function mount(t, initial = setup) {
  const events = [];
  const scope = new AbortController();
  const props = reactive({ setup: initial, scope: scope.signal });
  const root = node('root');
  const app = renderer.createApp({ render: () => h(Component, { ...props, onUpdate: (value) => { events.push(value); props.setup = value; } }) });
  app.mount(root);
  t.after(() => app.unmount());
  const button = (label) => all(root).find((element) => element.type === 'button' && text(element) === label);
  return {
    app, props, events, scope, root, button,
    async click(label) {
      const element = button(label);
      assert.ok(element, `Missing button: ${label}`);
      assert.ok(!element.props.disabled, `Disabled button: ${label}`);
      element.props.onClick({});
      await flush();
    },
  };
}

test('restored enabled history is reconciled; signed ping gates enable, disable does not cancel rollout', async (t) => {
  let fresh = { ...setup };
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'PUT') fresh = { ...fresh, enabled: JSON.parse(options.body).enabled };
    return response({ ...fresh, secret });
  });
  const view = mount(t, { ...setup, enabled: true, verified: true });
  assert.ok(!view.button('Disable automatic updates'));
  await flush();
  assert.equal(view.button('Enable automatic updates').props.disabled, true);
  assert.equal(calls.length, 1);
  fresh.verified = true;
  await view.click('Check connection');
  assert.equal(view.button('Enable automatic updates').props.disabled, false);
  assert.equal(calls.filter(({ options }) => options.method === 'PUT').length, 0);
  await view.click('Enable automatic updates');
  assert.ok(text(view.root).includes('does not cancel an active rollout'));
  await view.click('Disable automatic updates');
  assert.equal(view.events.at(-1).enabled, false);
  assert.ok(!JSON.stringify(view.events).includes(secret));
});

test('copy and reveal fetch secrets separately; hide, expiry, hook changes, and scope abort clear them', async (t) => {
  const copied = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value) => { copied.push(value); } } });
  t.after(() => { delete navigator.clipboard; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let fresh = { ...setup };
  let secretRequests = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.endsWith('/secret')) { secretRequests += 1; return response({ secret }); }
    return response(fresh);
  });
  const view = mount(t);
  await flush();
  assert.equal(secretRequests, 0);
  await view.click('Copy payload URL');
  await view.click('Copy secret');
  assert.deepEqual(copied, [setup.payloadUrl, secret]);
  assert.ok(!text(view.root).includes(secret));
  await view.click('Reveal secret');
  assert.ok(text(view.root).includes(secret));
  await view.click('Hide secret');
  assert.ok(!text(view.root).includes(secret));
  await view.click('Reveal secret');
  t.mock.timers.tick(30_000);
  await flush();
  assert.ok(!text(view.root).includes(secret));
  await view.click('Reveal secret');
  fresh = { ...setup, hookId: 'hook_2', payloadUrl: 'https://control/api/webhooks/github/hook_2' };
  view.props.setup = fresh;
  await flush();
  assert.ok(!text(view.root).includes(secret));
  await view.click('Reveal secret');
  view.scope.abort();
  await flush();
  assert.ok(!text(view.root).includes(secret));
  assert.ok(!JSON.stringify(view.events).includes(secret));
  assert.equal(secretRequests, 5);
});

test('late secret and status responses after navigation or unmount are ignored', async (t) => {
  const pendingSecret = deferred();
  const pendingStatus = deferred();
  let gets = 0;
  let signal;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    signal = options.signal;
    if (url.endsWith('/secret')) return pendingSecret.promise;
    gets += 1;
    return gets === 1 ? response(setup) : pendingStatus.promise;
  });
  const view = mount(t);
  await flush();
  await view.click('Reveal secret');
  view.scope.abort();
  assert.equal(signal.aborted, true);
  pendingSecret.resolve(response({ secret }));
  await flush();
  assert.ok(!text(view.root).includes(secret));
  assert.equal(view.events.length, 1);
  view.props.scope = new AbortController().signal;
  await flush();
  view.app.unmount();
  assert.equal(signal.aborted, true);
  pendingStatus.resolve(response({ ...setup, enabled: true, verified: true }));
  await flush();
  assert.equal(view.events.length, 1);
});

test('rotation requires confirmation, updates identity, and requires reverification', async (t) => {
  let fresh = { ...setup, enabled: true, verified: true };
  let rotations = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/rotate')) {
      assert.deepEqual(JSON.parse(options.body), { hookId: setup.hookId });
      rotations += 1;
      fresh = { ...setup, hookId: 'hook_2', payloadUrl: 'https://control/api/webhooks/github/hook_2' };
    }
    return response({ ...fresh, secret });
  });
  const view = mount(t);
  await flush();
  await view.click('Rotate secret');
  assert.equal(rotations, 0);
  assert.ok(text(view.root).includes('Update both the payload URL and secret in GitHub'));
  await view.click('Cancel');
  assert.equal(rotations, 0);
  await view.click('Rotate secret');
  await view.click('Confirm rotation');
  assert.equal(rotations, 1);
  assert.equal(view.events.at(-1).hookId, 'hook_2');
  assert.equal(view.button('Enable automatic updates').props.disabled, true);
  assert.ok(text(view.root).includes('https://control/api/webhooks/github/hook_2'));
  assert.ok(!JSON.stringify(view.events).includes(secret));
});

test('failed mutations require reconciliation and never render raw errors', async (t) => {
  let fail = false;
  t.mock.method(globalThis, 'fetch', async () => fail ? response({ error: secret }, 500) : response({ ...setup, verified: true }));
  const view = mount(t);
  await flush();
  fail = true;
  await view.click('Enable automatic updates');
  assert.ok(!view.button('Enable automatic updates'));
  assert.ok(text(view.root).includes('Check again before making changes'));
  assert.ok(!text(view.root).includes(secret));
  fail = false;
  await view.click('Check connection');
  assert.ok(view.button('Enable automatic updates'));
});
