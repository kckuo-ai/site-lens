import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE_SETTING_KEYS, SITE_CACHE_KEYS, clearSiteKeys } from '../js/storage.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALL = new Set([...SITE_SETTING_KEYS, ...SITE_CACHE_KEYS]);

test('every per-site key used in the app is listed in storage.js', () => {
  const used = new Set();
  for (const f of ['js/app.js', 'js/site-manager.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of src.matchAll(/SK\('([A-Za-z0-9]+)'\)/g)) used.add(m[1]);
    for (const m of src.matchAll(/(?:store|setLS)\s*(?:\+\s*|\()'([A-Za-z0-9]+)'/g)) used.add(m[1]);
  }
  assert.ok(used.size >= 10, `found only ${used.size} keys — has the SK() helper been renamed?`);
  const missing = [...used].filter(k => !ALL.has(k));
  assert.deepEqual(missing, [], `add these to SITE_SETTING_KEYS or SITE_CACHE_KEYS: ${missing.join(', ')}`);
});

test('clearSiteKeys removes settings (and caches only when asked) for that site only', async () => {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: k => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: k => mem.delete(k),
  };
  try {
    for (const k of [...ALL, 'UEsK']) { mem.set('a_' + k, '1'); mem.set('b_' + k, '1'); }
    mem.set('lastSite', 'a');

    await clearSiteKeys('a_', { ueKey: 'UEsK' });
    for (const k of SITE_SETTING_KEYS) assert.equal(mem.has('a_' + k), false, k);
    assert.equal(mem.has('a_UEsK'), false);
    for (const k of SITE_CACHE_KEYS) assert.equal(mem.has('a_' + k), true, `cache ${k} kept on reset`);

    await clearSiteKeys('a_', { includeCaches: true });
    for (const k of SITE_CACHE_KEYS) assert.equal(mem.has('a_' + k), false, k);

    for (const k of ALL) assert.equal(mem.has('b_' + k), true, `other site untouched: ${k}`);
    assert.equal(mem.get('lastSite'), 'a');
  } finally {
    delete globalThis.localStorage;
  }
});
