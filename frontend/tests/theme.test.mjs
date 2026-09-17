import assert from 'node:assert/strict';
import test from 'node:test';
import { effectScope } from 'vue';
import { useTheme } from '../src/theme.ts';

function setup(t, { saved = null, dark = false, storageBlocked = false } = {}) {
  const storage = new Map(saved ? [['halfcloud:theme', saved]] : []);
  const root = { dataset: {} };
  let browserColor;
  globalThis.window = {
    matchMedia: () => ({ matches: dark }),
    localStorage: {
      getItem(key) {
        if (storageBlocked) throw new Error('Storage blocked');
        return storage.get(key) ?? null;
      },
      setItem(key, value) {
        if (storageBlocked) throw new Error('Storage blocked');
        storage.set(key, value);
      },
    },
  };
  globalThis.document = {
    documentElement: root,
    querySelector: () => ({ setAttribute: (_name, value) => { browserColor = value; } }),
  };
  const scope = effectScope();
  t.after(() => {
    scope.stop();
    delete globalThis.window;
    delete globalThis.document;
  });
  return { ...scope.run(useTheme), root, storage, browserColor: () => browserColor, reload: () => scope.run(useTheme) };
}

test('initial theme follows the system preference', (t) => {
  const view = setup(t, { dark: true });
  assert.equal(view.theme.value, 'dark');
  assert.equal(view.root.dataset.theme, 'dark');
  assert.equal(view.browserColor(), '#151c19');
});

test('saved preference takes precedence and toggling persists across reloads', (t) => {
  const view = setup(t, { saved: 'light', dark: true });
  assert.equal(view.theme.value, 'light');
  view.toggleTheme();
  assert.equal(view.root.dataset.theme, 'dark');
  assert.equal(view.storage.get('halfcloud:theme'), 'dark');
  assert.equal(view.reload().theme.value, 'dark');
  view.toggleTheme();
  assert.equal(view.root.dataset.theme, 'light');
  assert.equal(view.browserColor(), '#f2efe7');
  assert.equal(view.storage.get('halfcloud:theme'), 'light');
});

test('invalid preferences fall back to the system theme', (t) => {
  const view = setup(t, { saved: 'invalid' });
  assert.equal(view.theme.value, 'light');
});

test('unavailable storage does not prevent initialization or switching', (t) => {
  const view = setup(t, { storageBlocked: true, dark: true });
  assert.equal(view.theme.value, 'dark');
  assert.doesNotThrow(() => view.toggleTheme());
  assert.equal(view.root.dataset.theme, 'light');
});
