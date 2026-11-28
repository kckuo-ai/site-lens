import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decryptResult, newKeyPair, payloadToSite, b64 } from '../js/sitegen.js';
import { sanitizeEmbedded, sanitizeStoredSite, buildProjectBundle, importProjectBundle } from '../js/site-manager.js';
import { inUS } from '../js/sitegen-ui.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const subtle = globalThis.crypto.subtle;

// localStorage / IndexedDB are absent in Node: storage.js falls back to localStorage, so give it one.
const mem = new Map();
globalThis.localStorage = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };

test('payload encrypted by scripts/make_site.py (Python) decrypts in the browser code', async () => {
  // test-only key pair: tests/fixtures/sitegen_test_priv.jwk is public on purpose and protects nothing
  const jwk = JSON.parse(fs.readFileSync(path.join(FIX, 'sitegen_test_priv.jwk'), 'utf8'));
  const priv = await subtle.importKey('jwk', jwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
  const enc = JSON.parse(fs.readFileSync(path.join(FIX, 'sitegen_enc.json'), 'utf8'));
  const p = await decryptResult(enc, priv);
  assert.equal(p.v, 1);
  assert.equal(p.buildings.buildings[0].id, 'ovt/abc-1');
  assert.equal(p.lidar.heights['ovt/abc-1'][0], 41.2);

  // tampered ciphertext must fail (AES-GCM authentication)
  const bad = { ...enc, data: enc.data.slice(0, -8) + (enc.data.slice(-8, -7) === 'A' ? 'B' : 'A') + enc.data.slice(-7) };
  await assert.rejects(() => decryptResult(bad, priv));
});

test('newKeyPair: public key exports as SPKI base64, private key is not extractable', async () => {
  const { publicB64, privateKey } = await newKeyPair();
  assert.match(publicB64, /^[A-Za-z0-9+/=]{300,700}$/);
  assert.equal(privateKey.extractable, false);
  // round trip through the same format the workflow uses
  const pub = await subtle.importKey('spki', b64.dec(publicB64), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const ct = await subtle.encrypt({ name: 'RSA-OAEP' }, pub, new TextEncoder().encode('hi'));
  assert.equal(new TextDecoder().decode(await subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, ct)), 'hi');
});

test('payloadToSite builds a US custom project with sanitized embedded data', async () => {
  const jwk = JSON.parse(fs.readFileSync(path.join(FIX, 'sitegen_test_priv.jwk'), 'utf8'));
  const priv = await subtle.importKey('jwk', jwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
  const p = await decryptResult(JSON.parse(fs.readFileSync(path.join(FIX, 'sitegen_enc.json'), 'utf8')), priv);
  const { id, site } = payloadToSite(p, { name: 'Seattle', band: 'n48', lat: 47.6062, lon: -122.3321, radius: 300 });
  assert.match(id, /^p_/);
  assert.equal(site.matProfile, 'us');
  assert.deepEqual(site.bsrc, ['osmb', 'osm']);
  assert.equal(site.embedded.buildings.buildings.length, 1, 'building with an invalid id is dropped');
  assert.ok(!/[<>]/.test(site.embedded.buildings.buildings[0].name));
  assert.equal(site.embedded.lidar.label, 'USGS 3DEP WA_Test_2021');
  assert.equal(site.embedded.canopy, undefined);
  assert.deepEqual(site.generated.notes, ['fixture note']);

  // export → import keeps the embedded data; stored copy is re-sanitized on load
  const imp = await importProjectBundle(buildProjectBundle({ siteId: id, site: { ...site, files: { osmb: 'blob:x' } }, overrides: {} }));
  assert.ok(imp.siteId.startsWith('imp_'));
  const again = sanitizeStoredSite(site);
  assert.deepEqual(again.embedded, site.embedded);
  assert.deepEqual(again.files, {});
});

test('sanitizeEmbedded rejects malformed canopy grids and keeps a valid one', () => {
  const ok = { ref: { lat: 47.6, lon: -122.3 }, x0: -400, z0: -400, step: 2, nx: 401, nz: 401, scale: 0.2, stats: { tree_fraction: 0.1 }, data: 'H4sIAAAAAAAA/w==' };
  assert.ok(sanitizeEmbedded({ canopy: ok }).canopy);
  assert.equal(sanitizeEmbedded({ canopy: { ...ok, nx: 99999 } }), null);
  assert.equal(sanitizeEmbedded({ canopy: { ...ok, data: '<script>' } }), null);
  assert.equal(sanitizeEmbedded({ canopy: { ...ok, ref: { lat: 200, lon: 0 } } }), null);
  assert.equal(sanitizeEmbedded(null), null);
});

test('inUS covers CONUS, Alaska, Hawaii and rejects Taiwan', () => {
  assert.ok(inUS(47.6062, -122.3321));
  assert.ok(inUS(61.1729, -149.8842));
  assert.ok(inUS(21.3069, -157.8583));
  assert.ok(!inUS(22.7815, 120.4188));
});
