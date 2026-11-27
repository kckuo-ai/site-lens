import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeMap } from '../js/storage.js';
import { ringUEs, createCustomSiteSpec, buildProjectBundle, importProjectBundle, PROJECT_SCHEMA_VERSION } from '../js/site-manager.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('public sites/index.json and site.json files are valid and consistent', () => {
  const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'sites/index.json'), 'utf8'));
  assert.ok(Array.isArray(index) && index.length >= 2);
  for (const entry of index) {
    const site = JSON.parse(fs.readFileSync(path.join(ROOT, `sites/${entry.id}/site.json`), 'utf8'));
    assert.ok(Number.isFinite(site.bs.lat) && Number.isFinite(site.bs.lon));
    assert.ok(Array.isArray(site.ues) && site.ues.length >= 1);
    if (site.v2File) {
      const v2 = JSON.parse(fs.readFileSync(path.join(ROOT, site.v2File), 'utf8'));
      assert.ok(Array.isArray(v2.rows) && v2.rows.length > 0);
    }
  }
});

test('sanitizeMap strips prototype-pollution keys and filters invalid values', () => {
  const malicious = JSON.parse('{"__proto__":{"polluted":true},"constructor":"bad","ok":12.5,"bad":-3}');
  const clean = sanitizeMap(malicious, v => typeof v === 'number' && v > 0);
  assert.deepEqual(clean, { ok: 12.5 });
  assert.equal(({}).polluted, undefined);
});

test('createCustomSiteSpec generates valid Taiwan and US site specs with 8 ring UEs', () => {
  const tw = createCustomSiteSpec({ name: '台北測試', lat: 25.033964, lon: 121.564468, region: 'tw', band: 'n79', radius: 600 });
  assert.equal(tw.site.tw, true);
  assert.equal(tw.site.matProfile, 'tw');
  assert.deepEqual(tw.site.bsrc, ['nlsc3d', 'osm']);
  assert.equal(tw.site.ues.length, 8);
  assert.equal(ringUEs(25.033964, 121.564468, 150).length, 8);

  const us = createCustomSiteSpec({ name: 'Seattle', lat: 47.6062, lon: -122.3321, region: 'us', band: 'n48', radius: 400 });
  assert.equal(us.site.tw, false);
  assert.equal(us.site.matProfile, 'us');
  assert.deepEqual(us.site.bsrc, ['osm']);
});

test('buildProjectBundle and importProjectBundle validate schema and reject malformed input', async () => {
  const { id, site } = createCustomSiteSpec({ name: 'Confidential Site', lat: 25.03, lon: 121.56, region: 'tw', band: 'n79' });
  const bundle = buildProjectBundle({ siteId: id, site, overrides: { hOv: { 'w/1': 15 } }, appVersion: '2026-11-27' });
  assert.equal(bundle.schemaVersion, PROJECT_SCHEMA_VERSION);

  await assert.rejects(() => importProjectBundle({ schemaVersion: 999, site }), /不支援的專案檔版本/);
  await assert.rejects(() => importProjectBundle({ schemaVersion: 1, site: { bs: { lat: 999, lon: 0 } } }), /超出合法範圍/);

  // Valid import works in Node (graceful fallback when indexedDB/localStorage are absent)
  const imported = await importProjectBundle(bundle);
  assert.equal(imported.name, 'Confidential Site');
  assert.ok(imported.siteId.startsWith('imp_'));
});
