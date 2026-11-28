/* ===== 產生站點資訊 (site generator): run scripts/make_site.py in GitHub Actions, import the result =====
   Flow: the page makes a fresh RSA key pair (the private key never leaves this browser's IndexedDB), dispatches
   the make-site workflow with the public key, waits for the encrypted result on the sitegen-out branch,
   decrypts it here and turns it into a custom project. The repository is public, so the result is only ever
   stored encrypted; the workflow inputs (coordinates, radius) are not printed in the run log. */
import { idbGet, idbSet } from './storage.js';
import { createCustomSiteSpec, sanitizeEmbedded } from './site-manager.js';

export const SITEGEN = {
  repo: 'kckuo-ai/site-lens',
  workflow: 'make-site.yml',
  ref: 'main',
  outBranch: 'sitegen-out',
  api: 'https://api.github.com',
};
const TOKEN_KEY = 'sitegenToken';
const JOBS_KEY = 'sitegenJobs';
export const PAYLOAD_VERSION = 1;

/* ---------- token (fine-grained PAT: this repo only; Actions read/write, Contents read/write) ---------- */
export function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
export function setToken(t) { try { t ? localStorage.setItem(TOKEN_KEY, t.trim()) : localStorage.removeItem(TOKEN_KEY); } catch (e) {} }

/* ---------- crypto ---------- */
const b64 = {
  enc: buf => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); },
  dec: str => { const s = atob(str); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; },
};
export { b64 };

export async function newKeyPair(subtle = globalThis.crypto.subtle) {
  // private key is non-extractable: it can be stored in IndexedDB and used, but never read out
  const kp = await subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, false, ['encrypt', 'decrypt']);
  const spki = await subtle.exportKey('spki', kp.publicKey);
  return { publicB64: b64.enc(spki), privateKey: kp.privateKey };
}

async function gunzip(bytes) {
  if (typeof DecompressionStream === 'undefined') throw new Error('這個瀏覽器不支援解壓縮');
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}

export async function decryptResult(enc, privateKey, subtle = globalThis.crypto.subtle) {
  if (!enc || enc.v !== 1 || enc.alg !== 'RSA-OAEP-256+A256GCM') throw new Error('結果檔格式不符');
  const raw = await subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, b64.dec(enc.key));
  const aes = await subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt']);
  let plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: b64.dec(enc.iv) }, aes, b64.dec(enc.data)));
  if (enc.gz) plain = await gunzip(plain);
  return JSON.parse(new TextDecoder().decode(plain));
}

/* ---------- jobs kept in IndexedDB so a reload (or closing the phone screen) does not lose them ---------- */
export async function listJobs() { const j = await idbGet(JOBS_KEY); return j && typeof j === 'object' ? j : {}; }
async function putJob(job) { const all = await listJobs(); all[job.req] = job; await idbSet(JOBS_KEY, all); return job; }
export async function dropJob(req) { const all = await listJobs(); delete all[req]; await idbSet(JOBS_KEY, all); }
export async function updateJob(req, patch) { const all = await listJobs(); if (!all[req]) return null; Object.assign(all[req], patch); await idbSet(JOBS_KEY, all); return all[req]; }

/* ---------- GitHub REST ---------- */
async function gh(token, path, opts = {}) {
  const res = await fetch(SITEGEN.api + path, {
    ...opts,
    headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token, 'X-GitHub-Api-Version': '2022-11-28', ...(opts.headers || {}) },
  });
  return res;
}
const ghErr = async (res, what) => {
  let msg = ''; try { msg = (await res.json()).message || ''; } catch (e) {}
  if (res.status === 401) return new Error(`${what}：token 無效或已過期（401）`);
  if (res.status === 403 || res.status === 404) return new Error(`${what}：token 沒有這個 repo 的權限，或 workflow 尚未合併到 main（${res.status}${msg ? '，' + msg : ''}）`);
  return new Error(`${what}失敗（HTTP ${res.status}${msg ? '，' + msg : ''}）`);
};

export async function checkToken(token) {
  const res = await gh(token, `/repos/${SITEGEN.repo}/actions/workflows/${SITEGEN.workflow}`);
  if (!res.ok) throw await ghErr(res, '檢查 token');
  return true;
}

const reqId = () => 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export async function startJob({ token, name, lat, lon, radius, band }) {
  const { publicB64, privateKey } = await newKeyPair();
  const req = reqId();
  const job = { req, name, lat, lon, radius, band, privateKey, state: 'queued', startedAt: Date.now() };
  await putJob(job);
  const res = await gh(token, `/repos/${SITEGEN.repo}/actions/workflows/${SITEGEN.workflow}/dispatches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: SITEGEN.ref, inputs: { req, lat: String(lat), lon: String(lon), radius: String(radius), pubkey: publicB64 } }),
  });
  if (!res.ok) { await dropJob(req); throw await ghErr(res, '啟動產生流程'); }
  return job;
}

// The run is named "make-site <req>" (run-name in the workflow), which lets us find it without exposing anything else.
export async function findRun(token, req) {
  const res = await gh(token, `/repos/${SITEGEN.repo}/actions/workflows/${SITEGEN.workflow}/runs?event=workflow_dispatch&per_page=20`);
  if (!res.ok) throw await ghErr(res, '查詢執行狀態');
  const j = await res.json();
  return (j.workflow_runs || []).find(r => (r.display_title || r.name || '').includes(req)) || null;
}

const outPath = req => `out/${req}.json`;

export async function fetchResult(token, req) {
  const res = await gh(token, `/repos/${SITEGEN.repo}/contents/${outPath(req)}?ref=${SITEGEN.outBranch}`, { headers: { Accept: 'application/vnd.github.raw+json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw await ghErr(res, '讀取結果');
  return res.json();
}

export async function deleteResult(token, req) {
  try {
    const meta = await gh(token, `/repos/${SITEGEN.repo}/contents/${outPath(req)}?ref=${SITEGEN.outBranch}`);
    if (!meta.ok) return false;
    const { sha } = await meta.json();
    const res = await gh(token, `/repos/${SITEGEN.repo}/contents/${outPath(req)}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `sitegen: remove ${req}`, sha, branch: SITEGEN.outBranch }),
    });
    return res.ok;
  } catch (e) { return false; }   // the workflow also prunes results older than a day
}

/* One poll step. Returns { state, run?, payload?, error? } with state in queued|running|done|failed. */
export async function pollJob(token, job) {
  const enc = await fetchResult(token, job.req);
  if (enc) {
    const payload = await decryptResult(enc, job.privateKey);
    return { state: payload.error ? 'failed' : 'done', payload, error: payload.error || null };
  }
  const run = await findRun(token, job.req);
  if (!run) return { state: 'queued' };
  if (run.status !== 'completed') return { state: run.status === 'in_progress' ? 'running' : 'queued', run };
  if (run.conclusion !== 'success') return { state: 'failed', run, error: `GitHub Actions 執行失敗（${run.conclusion}）` };
  return { state: 'running', run };   // completed, result commit not visible yet
}

/* ---------- payload → custom project ---------- */
export function payloadToSite(payload, { name, band, lat, lon, radius }) {
  if (!payload || payload.v !== PAYLOAD_VERSION) throw new Error('結果版本不符');
  const { id, site } = createCustomSiteSpec({ name, lat, lon, region: 'us', band, radius });
  const emb = sanitizeEmbedded({ buildings: payload.buildings, lidar: payload.lidar, canopy: payload.canopy });
  if (emb) {
    site.embedded = emb;
    if (emb.buildings) site.bsrc = ['osmb', 'osm'];
  }
  site.generated = { at: String(payload.created || '').slice(0, 25), notes: (payload.notes || []).map(n => String(n).slice(0, 300)).slice(0, 10) };
  return { id, site };
}

export function summarize(payload) {
  const nb = payload.buildings && payload.buildings.buildings ? payload.buildings.buildings.length : 0;
  const L = payload.lidar;
  return { buildings: nb, lidarCount: L ? L.stats.count : 0, lidarLabel: L ? L.label : '', year: L ? L.year : null, canopy: !!payload.canopy, notes: payload.notes || [] };
}
