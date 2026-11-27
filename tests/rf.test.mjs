import test from 'node:test';
import assert from 'node:assert/strict';
import { NRB, BANDS, rsrpLv, fmt, wrap180, patt, ruPatt, polyArea, autoMat } from '../js/rf.js';
import { escHtml, trEN } from '../js/i18n.js';

test('3GPP NRB and BANDS definitions are valid', () => {
  assert.equal(NRB[30][40], 106);
  assert.equal(NRB[30][100], 273);
  assert.equal(BANDS.n48.sas, true);
  assert.equal(BANDS.n79.f, 4850);
  assert.equal(rsrpLv(-75)[1], '很好');
  assert.equal(rsrpLv(-115)[1], '很差');
  assert.equal(fmt(-12.34), '−12.3');
});

test('antenna patterns peak at boresight and respect FB/SLA limits', () => {
  assert.equal(wrap180(370), 10);
  assert.equal(wrap180(-190), 170);
  const a = { mode: 'sector', azs: [30, 150, 270], tilts: [4, 4, 4], hp: 65, vp: 7, fb: 30, slav: 18, mech: 0, rip: 0 };
  assert.ok(Math.abs(patt(a, 0, { az: 30, el: -4 })) < 1e-9);
  assert.equal(patt(a, 0, { az: 210, el: -4 }), -30);
  assert.ok(Math.abs(ruPatt(a, { az: 100, tilt: 6 }, { az: 100, el: -6 })) < 1e-9);
});

test('autoMat classifies US vs Taiwan buildings accurately', () => {
  assert.equal(autoMat('house', 8, 120, 'us'), 'wood');
  assert.equal(autoMat('commercial', 12, 1000, 'us'), 'mixed');
  assert.equal(autoMat('', 8, 120, 'tw'), 'concrete');
  assert.equal(autoMat('office', 20, 800, 'tw'), 'mixed');
  assert.equal(polyArea([[0, 0], [10, 0], [10, 20], [0, 20]]), 200);
});

test('escHtml and trEN sanitize HTML and translate UI strings', () => {
  assert.equal(escHtml('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  assert.ok(/Load map/i.test(trEN('載入地圖並計算')));
  assert.equal(trEN('already English'), 'already English');
});
