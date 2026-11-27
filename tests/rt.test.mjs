import test from 'node:test';
import assert from 'node:assert/strict';
import { createRT } from '../js/rt.js';

const BASE_OPTS = {
  fHz: 3.625e9,
  reflW: 6,
  reflG: 3,
  penW: 15,
  penR: 20,
  maxPen: 4,
  maxOrder: 1,
  diff: true,
  terrain: false,
  veg: false,
};

test('LOS free-space path loss and ground reflection on open ground', () => {
  const rt = createRT();
  rt.setBuildings([], 500);
  const res = rt.trace([0, 10, 0], [100, 1.5, 0], BASE_OPTS);
  const los = res.paths.find(p => p.type === 'los');
  const r1 = res.paths.find(p => p.type === 'r1');
  assert.ok(los, 'should find LOS path');
  assert.ok(r1, 'should find ground reflection path');
  const d = Math.hypot(100, -8.5);
  const lam = 299792458 / BASE_OPTS.fHz;
  const expectedPl = 20 * Math.log10(4 * Math.PI * d / lam);
  assert.ok(Math.abs(los.pl - expectedPl) < 1e-6);
  assert.equal(los.pen.length, 0);
  assert.equal(r1.via[0].kind, 'ground');
});

test('d === 0 guard prevents -Infinity path loss', () => {
  const rt = createRT();
  rt.setBuildings([], 500);
  const res = rt.trace([0, 10, 0], [0, 10, 0], BASE_OPTS);
  assert.ok(res.paths.length >= 1);
  for (const p of res.paths) {
    assert.ok(Number.isFinite(p.pl), `path loss must be finite, got ${p.pl}`);
  }
});

test('3GPP TR 38.901 wallLoss matches expected values at 3.6 GHz and 4.85 GHz', () => {
  const rt = createRT();
  assert.ok(Math.abs(rt.wallLoss('wood', 3.6) - 5.282) < 0.05);
  assert.ok(Math.abs(rt.wallLoss('concrete', 3.6) - 19.4) < 0.05);
  assert.ok(Math.abs(rt.wallLoss('concrete', 4.85) - 24.4) < 0.05);
  assert.ok(Math.abs(rt.wallLoss('mixed', 3.6) - 12.7) < 0.15);
  assert.ok(Math.abs(rt.wallLoss('irr', 4.85) - 29.4) < 0.2);
});

test('building blockage produces penetration and rooftop diffraction paths', () => {
  const rt = createRT();
  // 20 m x 20 m concrete box centered at (50, 0), height 15 m
  rt.setBuildings([
    { poly: [[40, -10], [60, -10], [60, 10], [40, 10]], h: 15, mat: 'concrete' },
  ], 500);
  const res = rt.trace([0, 10, 0], [100, 1.5, 0], BASE_OPTS);
  const los = res.paths.find(p => p.type === 'los');
  const diff = res.paths.find(p => p.type === 'diff');
  assert.ok(los, 'direct penetrated path should exist');
  assert.equal(los.pen.length, 2, 'should penetrate 2 walls');
  assert.ok(Math.abs(los.penDb - 2 * rt.wallLoss('concrete', 3.625)) < 1e-6);
  assert.ok(diff, 'rooftop diffraction path should exist');
  assert.equal(diff.terr, false);
  assert.ok(diff.dl > 10, `expected significant diffraction loss, got ${diff.dl}`);
});

test('terrain ridge blocks direct path and creates terrain diffraction', () => {
  const rt = createRT();
  rt.setBuildings([], 500);
  // 10 m grid from x=-20..120, z=-20..20 with a 25 m ridge at x=50
  const nx = 15, nz = 5, step = 10, x0 = -20, z0 = -20;
  const h = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = x0 + i * step;
      h[j * nx + i] = Math.abs(x - 50) <= 5 ? 25 : 0;
    }
  }
  rt.setTerrain({ x0, z0, step, nx, nz, h });
  const res = rt.trace([0, 10, 0], [100, 1.5, 0], { ...BASE_OPTS, terrain: true });
  const los = res.paths.find(p => p.type === 'los');
  const diff = res.paths.find(p => p.type === 'diff');
  assert.equal(los, undefined, 'direct path through terrain ridge must be dropped');
  assert.ok(diff, 'terrain ridge diffraction path should exist');
  assert.equal(diff.terr, true);
  assert.ok(diff.dl > 20, `expected >20 dB ridge diffraction loss, got ${diff.dl}`);
});

test('canopy adds Weissberger attenuation to LOS and diffraction paths', () => {
  const rt = createRT();
  rt.setBuildings([], 500);
  const nx = 60, nz = 10, step = 2, x0 = 0, z0 = -10;
  const h = new Float32Array(nx * nz);
  // 12 m tall trees spanning x = 30..60 m
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = x0 + i * step;
      if (x >= 30 && x <= 60) h[j * nx + i] = 12;
    }
  }
  rt.setCanopy({ x0, z0, step, nx, nz, h });
  const noVeg = rt.trace([0, 8, 0], [100, 6, 0], { ...BASE_OPTS, veg: false });
  const withVeg = rt.trace([0, 8, 0], [100, 6, 0], { ...BASE_OPTS, veg: true });
  const losNo = noVeg.paths.find(p => p.type === 'los');
  const losVeg = withVeg.paths.find(p => p.type === 'los');
  assert.ok(losVeg.veg > 20, `expected >20 m foliage depth, got ${losVeg.veg}`);
  assert.ok(losVeg.vl > 5, `expected >5 dB Weissberger loss, got ${losVeg.vl}`);
  assert.ok(losVeg.pl > losNo.pl + 5);
});
