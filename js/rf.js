/* ===== Pure 3GPP RF constants, link-budget helpers, antenna patterns, and building material classification ===== */

// 3GPP TS 38.101-1 Table 5.3.2-1 (FR1 max transmission bandwidth, N_RB)
export const NRB = {
  15: { 10: 52, 20: 106, 40: 216, 50: 270 },
  30: { 10: 24, 20: 51, 40: 106, 50: 133, 80: 217, 90: 245, 100: 273 },
  60: { 10: 11, 20: 24, 40: 51, 50: 65, 80: 107, 90: 121, 135: 135, 100: 135 },
};
delete NRB[60][135];

// TDD bands (TS 38.101-1 Tables 5.2-1, 5.3.5-1)
export const BANDS = {
  n48: { lo: 3550, hi: 3700, f: 3625, bws: [10, 20, 40, 50, 80, 90, 100], sas: true, lbl: 'n48 CBRS（3550–3700 MHz）' },
  n77: { lo: 3300, hi: 4200, f: 3750, bws: [10, 20, 40, 50, 80, 90, 100], lbl: 'n77（3300–4200 MHz）' },
  n78: { lo: 3300, hi: 3800, f: 3500, bws: [10, 20, 40, 50, 80, 90, 100], lbl: 'n78（3300–3800 MHz）' },
  n79: { lo: 4400, hi: 5000, f: 4850, bws: [40, 50, 80, 90, 100], lbl: 'n79（4400–5000 MHz）' },
};

export const RSRP_LV = [
  [-80, '很好', '#3ddc84'],
  [-90, '好', '#a8e05f'],
  [-100, '普通', '#ffd23f'],
  [-110, '弱', '#ff9f43'],
  [-Infinity, '很差', '#ff5e5e'],
];

export const SINR_LV = [
  [20, '很好', '#3ddc84'],
  [13, '好', '#a8e05f'],
  [0, '普通', '#ffd23f'],
  [-3, '弱', '#ff9f43'],
  [-Infinity, '很差', '#ff5e5e'],
];

export const rsrpLv = v => RSRP_LV.find(x => v >= x[0]);
export const fmt = (n, d = 1) => (n < 0 ? '−' : '') + Math.abs(n).toFixed(d);
export const wrap180 = a => ((a + 180) % 360 + 360) % 360 - 180;
export const sectorAz = (a, k) => ((a.azs[k] % 360) + 360) % 360;

// 3GPP TR 38.901 sector/omni antenna pattern
export function patt(a, k, p) {
  if (a.mode === 'omni') return -Math.min(12 * ((-p.el - a.tilts[0]) / a.vp) ** 2, a.slav) - a.rip;
  const AH = -Math.min(12 * (wrap180(p.az - sectorAz(a, k)) / a.hp) ** 2, a.fb);
  const AV = -Math.min(12 * ((-p.el - a.tilts[k]) / a.vp) ** 2, a.slav);
  return -Math.min(-(AH + AV), a.fb);
}

export function ruPatt(a, u, p) {
  const AH = -Math.min(12 * (wrap180(p.az - u.az) / a.hp) ** 2, a.fb);
  const AV = -Math.min(12 * ((-p.el - (u.tilt + a.mech)) / a.vp) ** 2, a.slav);
  return -Math.min(-(AH + AV), a.fb);
}

// Building material auto-classification by region profile
const B_RES = new Set(['house', 'detached', 'residential', 'bungalow', 'cabin', 'semidetached_house', 'terrace', 'shed', 'garage', 'garages', 'carport', 'static_caravan']);
const B_APT = new Set(['apartments', 'dormitory']);
const B_COM = new Set(['commercial', 'retail', 'office', 'supermarket', 'hotel', 'school', 'university', 'college', 'hospital', 'civic', 'public', 'government', 'church', 'kindergarten', 'train_station']);
const B_IND = new Set(['industrial', 'warehouse', 'manufacture', 'hangar']);

export const polyArea = p => Math.abs(p.reduce((a, q, i) => {
  const r = p[(i + 1) % p.length];
  return a + q[0] * r[1] - r[0] * q[1];
}, 0)) / 2;

export function autoMat(btype, h, area, profile = 'tw') {
  const t = btype || '';
  if (profile === 'us') {
    if (B_RES.has(t)) return 'wood';
    if (B_APT.has(t)) return h <= 14 ? 'wood' : 'mixed';
    if (B_COM.has(t) || B_IND.has(t)) return 'mixed';
    return h <= 14 && area <= 3000 ? 'wood' : 'mixed';
  }
  if (B_COM.has(t)) return 'mixed';
  return 'concrete';
}
