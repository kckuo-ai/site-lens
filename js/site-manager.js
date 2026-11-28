/* ===== Site catalog, local custom projects, and .sitelens.json project bundle import/export ===== */
import { idbGetWithMigration, idbSet, sanitizeMap, clearSiteKeys } from './storage.js';

const CUSTOM_KEY = 'sitelens_custom_sites_v1';
export const PROJECT_SCHEMA_VERSION = 1;

export function ringUEs(lat, lon, radiusM = 150) {
  const mLat = 111320, mLon = 111320 * Math.cos(lat * Math.PI / 180);
  const dirs = [
    [0, 1], [0.707, 0.707], [1, 0], [0.707, -0.707],
    [0, -1], [-0.707, -0.707], [-1, 0], [-0.707, 0.707],
  ];
  return dirs.map(([de, dn]) => ({
    lat: +(lat + dn * radiusM / mLat).toFixed(7),
    lon: +(lon + de * radiusM / mLon).toFixed(7),
  }));
}

export async function getCustomSites() {
  const raw = await idbGetWithMigration(CUSTOM_KEY);
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

export async function saveCustomSite(id, siteObj) {
  const all = await getCustomSites();
  all[id] = { ...siteObj, custom: true };
  await idbSet(CUSTOM_KEY, all);
  return all[id];
}

export async function deleteCustomSite(id) {
  const all = await getCustomSites();
  const s = all[id];
  if (!s) return false;
  delete all[id];
  await idbSet(CUSTOM_KEY, all);
  if (s.store) await clearSiteKeys(s.store, { ueKey: s.ueKey, includeCaches: true });
  return true;
}

export function createCustomSiteSpec({ name, lat, lon, region = 'tw', band = 'n79', radius = 500 }) {
  const cleanName = String(name || '').trim() || '自訂站點';
  const slug = 'p_' + Date.now().toString(36);
  const isTw = region === 'tw';
  const isUs = region === 'us';
  const defR = Math.max(100, Math.min(1500, Math.round(+radius || 500)));
  const bandDef = {
    n48: { fMHz: 3625, bw: 40, scs: 30, ruP: 31, defH: isUs ? 6 : 10 },
    n77: { fMHz: 3750, bw: 100, scs: 30, ruP: 37, defH: 10 },
    n78: { fMHz: 3500, bw: 100, scs: 30, ruP: 37, defH: 10 },
    n79: { fMHz: 4850, bw: 100, scs: 30, ruP: 35.2, defH: 10 },
  }[band] || { fMHz: 3625, bw: 40, scs: 30, ruP: 31, defH: 10 };

  return {
    id: slug,
    site: {
      name: cleanName,
      store: slug + '_',
      band,
      tw: isTw,
      approx: true,
      custom: true,
      matProfile: isUs ? 'us' : 'tw',
      bs: { lat: +lat.toFixed(7), lon: +lon.toFixed(7) },
      area: { lat: +lat.toFixed(7), lon: +lon.toFixed(7), r: defR },
      ues: ringUEs(lat, lon, Math.min(200, Math.round(defR * 0.35))),
      bsrc: isTw ? ['nlsc3d', 'osm'] : ['osm'],
      files: {},
      defaults: { ...bandDef, nPort: 4, mast: 3, hR: Math.min(300, defR), hStep: 10 },
    },
  };
}

export async function loadSiteCatalog(baseUrl = '.') {
  let pub = [];
  try {
    const res = await fetch(`${baseUrl}/sites/index.json`);
    if (res.ok) pub = await res.json();
  } catch (e) {
    console.warn('Failed to fetch sites/index.json:', e);
  }
  const customMap = await getCustomSites();
  const custom = Object.entries(customMap).map(([id, s]) => ({
    id,
    name: s.name || id,
    nameEn: s.nameEn || s.name || id,
    band: s.band || 'n48',
    hasV2: !!(s.v2 && Array.isArray(s.v2.rows) && s.v2.rows.length),
    approx: !!s.approx,
    custom: true,
  }));
  return { pub, custom, all: [...pub, ...custom] };
}

export async function loadSiteDefinition(siteId, baseUrl = '.') {
  const customMap = await getCustomSites();
  if (customMap[siteId]) {
    return { id: siteId, site: sanitizeStoredSite(structuredClone(customMap[siteId])), custom: true };
  }
  const res = await fetch(`${baseUrl}/sites/${encodeURIComponent(siteId)}/site.json`);
  if (!res.ok) throw new Error(`無法載入站點設定（${siteId}：HTTP ${res.status}）`);
  const site = await res.json();
  if (site.v2File) {
    const v2Res = await fetch(`${baseUrl}/${site.v2File}`);
    if (v2Res.ok) site.v2 = await v2Res.json();
  }
  return { id: siteId, site, custom: false };
}

export function buildProjectBundle({ siteId, site, overrides, appVersion }) {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    app: 'SiteLens',
    appVersion: appVersion || '',
    exportedAt: new Date().toISOString(),
    siteId,
    site,
    overrides,
  };
}

/* ----- Untrusted-input sanitizers for imported / locally stored projects -----
   .sitelens.json bundles travel between people, so every field that can reach the DOM
   is validated here (structure, types, lengths, id charset); rendering still escapes. */
const RU_ID_RE = /^[A-Za-z0-9_.-]{1,40}$/;
const finiteOr = (v, d = null) => (v != null && v !== '' && Number.isFinite(+v) ? +v : d);
const cleanStr = (v, max = 120) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max) : '');
const validLat = v => Number.isFinite(v) && Math.abs(v) <= 90;
const validLon = v => Number.isFinite(v) && Math.abs(v) <= 180;

export function sanitizeRus(rus) {
  if (!rus || typeof rus !== 'object' || !Array.isArray(rus.list)) return null;
  const seen = new Set();
  const list = [];
  for (const u of rus.list.slice(0, 64)) {
    if (!u || typeof u !== 'object') continue;
    const id = typeof u.id === 'string' ? u.id.trim() : '';
    const lat = finiteOr(u.lat), lon = finiteOr(u.lon), cell = finiteOr(u.cell);
    if (!RU_ID_RE.test(id) || seen.has(id) || !validLat(lat) || !validLon(lon)) continue;
    if (!Number.isInteger(cell) || cell < 0 || cell > 1007) continue;
    seen.add(id);
    const az = finiteOr(u.az);
    list.push({
      id, cell, lat, lon,
      az: az == null ? null : ((az % 360) + 360) % 360,
      indoor: !!u.indoor,
      panel: !!u.panel,
      loc: cleanStr(u.loc, 60),
      mount: cleanStr(u.mount, 80),
      use: cleanStr(u.use, 80),
    });
  }
  if (!list.length) return null;
  const out = { src: cleanStr(rus.src, 160) || '匯入專案', list };
  const tilt = finiteOr(rus.tilt);
  if (tilt != null) out.tilt = Math.max(-30, Math.min(30, tilt));
  const azVer = finiteOr(rus.azVer);
  if (Number.isInteger(azVer) && azVer > 0) out.azVer = azVer;
  return out;
}

export function sanitizeCover(cover) {
  if (!cover || typeof cover !== 'object' || !Array.isArray(cover.poly)) return null;
  const poly = cover.poly.slice(0, 2000)
    .filter(p => Array.isArray(p) && p.length >= 2 && validLon(+p[0]) && validLat(+p[1]))
    .map(p => [+p[0], +p[1]]);
  return poly.length >= 3 ? { name: cleanStr(cover.name, 80) || '涵蓋範圍', poly } : null;
}

export function sanitizeV2(v2) {
  if (!v2 || typeof v2 !== 'object' || !Array.isArray(v2.rows)) return null;
  const rows = [];
  for (const r of v2.rows.slice(0, 20000)) {
    if (!Array.isArray(r) || r.length < 3) continue;
    const row = r.slice(0, 12).map(x => finiteOr(x));
    if (row[0] == null || !validLat(row[1]) || !validLon(row[2])) continue;
    rows.push(row);
  }
  if (!rows.length) return null;
  const t = Array.isArray(v2.tower) ? [finiteOr(v2.tower[0]), finiteOr(v2.tower[1])] : null;
  return {
    tower: t && validLat(t[0]) && validLon(t[1]) ? t : null,
    utc: cleanStr(v2.utc, 40),
    rows,
  };
}

// Re-validate a stored custom site (projects saved before these checks existed may be unsanitized).
export function sanitizeStoredSite(s) {
  const out = { ...s };
  out.name = cleanStr(s.name, 80) || '自訂站點';
  if ('rus' in s) { const r = sanitizeRus(s.rus); if (r) out.rus = r; else delete out.rus; }
  if ('cover' in s) { const c = sanitizeCover(s.cover); if (c) out.cover = c; else delete out.cover; }
  if ('v2' in s) { const v = sanitizeV2(s.v2); if (v) out.v2 = v; else delete out.v2; }
  return out;
}

export async function importProjectBundle(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('檔案內容不是有效的 JSON 物件');
  if (raw.schemaVersion !== PROJECT_SCHEMA_VERSION) {
    throw new Error(`不支援的專案檔版本（schemaVersion=${raw.schemaVersion}）`);
  }
  const s = raw.site;
  if (!s || typeof s !== 'object' || !s.bs || !Number.isFinite(+s.bs.lat) || !Number.isFinite(+s.bs.lon)) {
    throw new Error('專案檔缺少有效的基站座標（site.bs）');
  }
  const lat = +s.bs.lat, lon = +s.bs.lon;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error('基站座標超出合法範圍');

  const id = 'imp_' + Date.now().toString(36);
  const store = id + '_';
  const cleanSite = {
    name: cleanStr(String(s.name || ''), 80) || '匯入專案',
    store,
    band: ['n48', 'n77', 'n78', 'n79'].includes(s.band) ? s.band : 'n48',
    tw: !!s.tw,
    approx: !!s.approx,
    custom: true,
    matProfile: s.matProfile === 'us' ? 'us' : 'tw',
    bs: { lat, lon },
    area: s.area && Number.isFinite(+s.area.lat) && Number.isFinite(+s.area.lon) && Number.isFinite(+s.area.r)
      ? { lat: +s.area.lat, lon: +s.area.lon, r: Math.max(100, Math.min(2000, +s.area.r)) }
      : { lat, lon, r: 500 },
    ues: Array.isArray(s.ues) && s.ues.length && s.ues.every(u => u && Number.isFinite(+u.lat) && Number.isFinite(+u.lon))
      ? s.ues.map(u => ({ lat: +u.lat, lon: +u.lon }))
      : ringUEs(lat, lon, 150),
    bsrc: Array.isArray(s.bsrc) && s.bsrc.length ? s.bsrc.filter(x => ['nlsc3d', 'osm', 'osmb', 'kmz'].includes(x)) : (s.tw ? ['nlsc3d', 'osm'] : ['osm']),
    files: {},
    defaults: sanitizeMap(s.defaults, v => typeof v === 'number' || typeof v === 'string'),
  };
  if (s.nlscCode != null && Number.isInteger(+s.nlscCode)) cleanSite.nlscCode = +s.nlscCode;
  const rus = sanitizeRus(s.rus); if (rus) cleanSite.rus = rus;
  const cover = sanitizeCover(s.cover); if (cover) cleanSite.cover = cover;
  const v2 = sanitizeV2(s.v2); if (v2) cleanSite.v2 = v2;
  if (!cleanSite.bsrc.length) cleanSite.bsrc = ['osm'];

  await saveCustomSite(id, cleanSite);

  const ov = raw.overrides && typeof raw.overrides === 'object' ? raw.overrides : {};
  const setLS = (k, v) => { if (v != null) try { localStorage.setItem(store + k, JSON.stringify(v)); } catch (e) {} };
  if (ov.bs && Number.isFinite(+ov.bs.lat) && Number.isFinite(+ov.bs.lon)) setLS('BS', { lat: +ov.bs.lat, lon: +ov.bs.lon });
  if (Array.isArray(ov.ues)) setLS('UEs', ov.ues.filter(u => u && Number.isFinite(+u.lat) && Number.isFinite(+u.lon)).map(u => ({ lat: +u.lat, lon: +u.lon })));
  if (ov.rus && typeof ov.rus === 'object') setLS('RUs', sanitizeMap(ov.rus));
  if (ov.hOv) setLS('BH', sanitizeMap(ov.hOv, v => typeof v === 'number' && Number.isFinite(v) && v > 0));
  if (ov.matOv) setLS('Mat', sanitizeMap(ov.matOv, v => ['wood', 'mixed', 'concrete', 'irr'].includes(v)));
  if (ov.h3d) setLS('H3D', sanitizeMap(ov.h3d, v => Array.isArray(v) && v.length >= 1 && Number.isFinite(v[0])));
  if (Array.isArray(ov.drawn)) setLS('Drawn', ov.drawn.filter(b => b && typeof b.id === 'string' && Array.isArray(b.ll)));
  if (ov.cal && typeof ov.cal === 'object') setLS('Cal', sanitizeMap(ov.cal));
  if (ov.extra && typeof ov.extra === 'object') setLS('Extra', sanitizeMap(ov.extra));
  if (Array.isArray(ov.traced) && ov.traced.length) await idbSet(store + 'Traced', ov.traced);

  return { siteId: id, name: cleanSite.name };
}
