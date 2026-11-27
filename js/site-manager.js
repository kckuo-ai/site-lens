/* ===== Site catalog, local custom projects, and .sitelens.json project bundle import/export ===== */
import { idbGetWithMigration, idbSet, idbDel, sanitizeMap } from './storage.js';

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
  if (s.store) {
    const keys = ['RUs', 'UEs', s.ueKey || 'UEs', 'BS', 'BH', 'BHseedFix', 'Mat', 'Cal', 'Extra', 'Traced', 'Drawn', 'H3D', 'OSM', 'NLSC3D'];
    for (const k of keys) {
      try { localStorage.removeItem(s.store + k); } catch (e) {}
      await idbDel(s.store + k);
    }
  }
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
    return { id: siteId, site: structuredClone(customMap[siteId]), custom: true };
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
    name: String(s.name || '匯入專案').trim().slice(0, 80),
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
  if (s.rus && Array.isArray(s.rus.list)) cleanSite.rus = s.rus;
  if (s.cover && Array.isArray(s.cover.poly)) cleanSite.cover = s.cover;
  if (s.v2 && Array.isArray(s.v2.rows)) cleanSite.v2 = s.v2;
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
