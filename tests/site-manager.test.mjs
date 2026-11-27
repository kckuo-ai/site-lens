import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeMap } from '../js/storage.js';
import { ringUEs, createCustomSiteSpec, buildProjectBundle, importProjectBundle, PROJECT_SCHEMA_VERSION, sanitizeRus, sanitizeCover, sanitizeV2, sanitizeStoredSite } from '../js/site-manager.js';

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

test('sanitizeRus rejects script-bearing ids, coerces cells, strips markup from text fields', () => {
  const evil = {
    src: '<img src=x onerror=alert(1)>RU plan',
    tilt: 6, azVer: 2,
    list: [
      { id: '<img src=x onerror=alert(1)>', cell: 1, lat: 22.78, lon: 120.41, az: 10 },
      { id: 'RU-C1-01-P', cell: '1"><script>alert(1)</script>', lat: 22.78, lon: 120.41, az: 10 },
      { id: 'RU-C1-02-P', cell: 2, lat: 22.781, lon: 120.417, az: 380, loc: '<b onmouseover=x>西棟</b>', mount: 'roof', use: 'x' },
      { id: 'RU-C1-02-P', cell: 2, lat: 22.781, lon: 120.417, az: 20 },   // duplicate id dropped
      { id: 'RU-C3-01-Indoor', cell: 3, lat: 91, lon: 120.4, indoor: true }, // invalid lat dropped
    ],
  };
  const r = sanitizeRus(evil);
  assert.equal(r.list.length, 1);
  const u = r.list[0];
  assert.equal(u.id, 'RU-C1-02-P');
  assert.equal(u.cell, 2);
  assert.equal(u.az, 20);
  assert.ok(!/[<>]/.test(u.loc) && !/[<>]/.test(r.src));
  assert.equal(r.tilt, 6);
  assert.equal(sanitizeRus({ list: [] }), null);
  assert.equal(sanitizeRus('nope'), null);
});

test('sanitizeCover and sanitizeV2 keep only numeric geometry', () => {
  const c = sanitizeCover({ name: '<svg onload=1>', poly: [[120.42, 22.78], [120.43, 22.78], ['x', 1], [120.43, 22.79]] });
  assert.equal(c.poly.length, 3);
  assert.ok(!/[<>]/.test(c.name));
  assert.equal(sanitizeCover({ poly: [[1, 2]] }), null);

  const v = sanitizeV2({ tower: [61.17, -149.88], utc: '<x>2026-11-04', rows: [[38, 61.17, -149.88, -99, '<b>', 17], [null, 61, -149], 'bad'] });
  assert.equal(v.rows.length, 1);
  assert.deepEqual(v.rows[0], [38, 61.17, -149.88, -99, null, 17]);
  assert.ok(!/[<>]/.test(v.utc));
});

test('importProjectBundle sanitizes a malicious bundle; stored legacy sites are re-sanitized on load', async () => {
  const { id, site } = createCustomSiteSpec({ name: 'Evil', lat: 22.78, lon: 120.41, region: 'tw', band: 'n79' });
  site.name = '<img src=x onerror=alert(1)>Evil';
  site.rus = { src: 'x', list: [{ id: '"><script>alert(1)</script>', cell: 1, lat: 22.78, lon: 120.41 }, { id: 'RU-1', cell: 1, lat: 22.78, lon: 120.41, loc: '<i>a</i>' }] };
  site.cover = { name: 'c', poly: 'not-an-array' };
  const imported = await importProjectBundle(buildProjectBundle({ siteId: id, site, overrides: {} }));
  assert.ok(!/[<>]/.test(imported.name));

  const legacy = sanitizeStoredSite({ name: '<b>x</b>', rus: site.rus, cover: site.cover, v2: { rows: 'x' } });
  assert.ok(!/[<>]/.test(legacy.name));
  assert.deepEqual(legacy.rus.list.map(u => u.id), ['RU-1']);
  assert.ok(!/[<>]/.test(legacy.rus.list[0].loc));
  assert.equal(legacy.cover, undefined);
  assert.equal(legacy.v2, undefined);
});

test('public Kaohsiung RU plan survives sanitizeRus unchanged in every field the app uses', () => {
  const site = JSON.parse(fs.readFileSync(path.join(ROOT, 'sites/kaohsiung/site.json'), 'utf8'));
  const r = sanitizeRus(site.rus);
  assert.equal(r.list.length, site.rus.list.length);
  site.rus.list.forEach((u, i) => {
    for (const k of ['id', 'cell', 'lat', 'lon', 'az', 'indoor', 'loc']) assert.deepEqual(r.list[i][k], u[k] ?? (k === 'indoor' ? false : k === 'loc' ? '' : null), `${u.id}.${k}`);
  });
  assert.equal(r.tilt, site.rus.tilt);
  assert.equal(r.azVer, site.rus.azVer);
});
