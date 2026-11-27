import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRT } from '../js/rt.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadAnchorageV2() {
  const site = JSON.parse(fs.readFileSync(path.join(ROOT, 'sites/anchorage/site.json'), 'utf8'));
  const v2 = JSON.parse(fs.readFileSync(path.join(ROOT, site.v2File), 'utf8'));
  return { bs: site.bs, rows: v2.rows };
}

const B_RES = new Set(['house', 'detached', 'residential', 'bungalow', 'cabin', 'semidetached_house', 'terrace', 'shed', 'garage', 'garages', 'carport', 'static_caravan']);
const B_APT = new Set(['apartments', 'dormitory']);
const B_COM = new Set(['commercial', 'retail', 'office', 'supermarket', 'hotel', 'school', 'university', 'college', 'hospital', 'civic', 'public', 'government', 'church', 'kindergarten', 'train_station']);
const B_IND = new Set(['industrial', 'warehouse', 'manufacture', 'hangar']);
const polyArea = p => Math.abs(p.reduce((a, q, i) => { const r = p[(i + 1) % p.length]; return a + q[0] * r[1] - r[0] * q[1]; }, 0)) / 2;
function autoMatUS(btype, h, area) {
  const t = btype || '';
  if (B_RES.has(t)) return 'wood';
  if (B_APT.has(t)) return h <= 14 ? 'wood' : 'mixed';
  if (B_COM.has(t) || B_IND.has(t)) return 'mixed';
  return h <= 14 && area <= 3000 ? 'wood' : 'mixed';
}

const wrap180 = a => ((a + 180) % 360 + 360) % 360 - 180;
function patt3GPP(az, tilt, p) {
  const AH = -Math.min(12 * (wrap180(p.az - az) / 65) ** 2, 30);
  const AV = -Math.min(12 * ((-p.el - tilt) / 7) ** 2, 18);
  return -Math.min(-(AH + AV), 30);
}

test('Anchorage V2 drive-test regression (OSM + NOAA lidar + US auto materials, uncalibrated)', () => {
  const { bs, rows } = loadAnchorageV2();
  const osm = JSON.parse(fs.readFileSync(path.join(ROOT, 'buildings_osm.json'), 'utf8'));
  const lidar = JSON.parse(fs.readFileSync(path.join(ROOT, 'lidar/heights_anchorage.json'), 'utf8'));

  const mLat = 111320, mLon = 111320 * Math.cos(bs.lat * Math.PI / 180);
  const toLocal = (lon, lat) => [(lon - bs.lon) * mLon, (lat - bs.lat) * mLat];

  const defH = 6;
  const list = osm.buildings.map(b => {
    const lh = lidar.heights[b.id];
    const h = lh ? lh[0] : (b.h ?? defH);
    const poly = b.ll.map(([lon, lat]) => toLocal(lon, lat));
    return { h, poly, mat: autoMatUS(b.btype, h, polyArea(poly)) };
  });

  const rt = createRT();
  rt.setBuildings(list, 1500);
  const bsBi = rt.buildingAt(0, 0);
  assert.ok(bsBi >= 0, 'BS should fall inside its host building');
  const tx = [0, list[rt.building(bsBi).src].h + 3, 0];

  // Anchorage n48 defaults: 3625 MHz, 40 MHz / 30 kHz (106 RB = 1272 RE), SAS 37 dBm/MHz, 4 ports, extra = 14 + 8 = 22 dB
  const nre = 12 * 106;
  const eirpCap = Math.min(31 - 1 + 17.7, 37 + 10 * Math.log10(40) - 10 * Math.log10(4));
  const eirp = eirpCap - 22;
  const off = 10 * Math.log10(nre);
  const azs = [30, 150, 270], pcis = [13, 15, 14];
  const opts = { fHz: 3625e6, reflW: 6, reflG: 3, penW: 15, penR: 20, maxPen: 4, maxOrder: 1, diff: true, terrain: false, veg: false };

  const errsAll = [], errsLos = [], errsNlos = [];
  let pciMatch = 0, pciTotal = 0;

  for (const r of rows) {
    const [, lat, lon, meas, , , pci] = r;
    if (meas == null) continue;
    const [x, z] = toLocal(lon, lat);
    const g = rt.trace(tx, [x, 1.5, z], opts);
    const los = g.paths.some(p => p.type === 'los' && !p.pen.length);
    const prx = [0, 1, 2].map(k => {
      const lin = g.paths.reduce((s, p) => s + Math.pow(10, (eirp - (p.pl - patt3GPP(azs[k], 4, p))) / 10), 0);
      return lin > 0 ? 10 * Math.log10(lin) : -Infinity;
    });
    let serve = 0;
    for (let k = 1; k < 3; k++) if (prx[k] > prx[serve]) serve = k;
    const k = pcis.indexOf(pci);
    if (k < 0 || !Number.isFinite(prx[k])) continue;
    const err = (prx[k] - off) - meas;
    errsAll.push(err);
    (los ? errsLos : errsNlos).push(err);
    pciTotal++;
    if (serve === k) pciMatch++;
  }

  const stat = a => {
    const m = a.reduce((x, y) => x + y, 0) / a.length;
    const sd = Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length);
    return { n: a.length, mean: m, sd };
  };
  const all = stat(errsAll), los = stat(errsLos), nlos = stat(errsNlos);

  // Deterministic flat-earth baseline (OSM + NOAA lidar + US auto materials, uncalibrated, tilt=4°):
  // ALL: +1.04 ±9.89 dB (n=41), LOS: +5.42 ±5.75 dB (n=15), NLOS: -1.48 ±10.85 dB (n=26), PCI: 39/41
  assert.equal(all.n, 41, 'expected 41 measured V2 points with RSRP');
  assert.equal(los.n, 15, 'expected 15 LOS points');
  assert.equal(nlos.n, 26, 'expected 26 NLOS points');
  assert.ok(Math.abs(all.mean - 1.04) < 0.2, `ALL mean error drifted: ${all.mean.toFixed(2)} dB`);
  assert.ok(Math.abs(los.mean - 5.42) < 0.2, `LOS mean error drifted: ${los.mean.toFixed(2)} dB`);
  assert.ok(Math.abs(nlos.mean - (-1.48)) < 0.2, `NLOS mean error drifted: ${nlos.mean.toFixed(2)} dB`);
  assert.ok(Math.abs(all.sd - 9.89) < 0.2, `overall SD drifted: ±${all.sd.toFixed(2)} dB`);
  assert.equal(pciMatch, 39, `PCI match count drifted: ${pciMatch}/${pciTotal}`);
});
