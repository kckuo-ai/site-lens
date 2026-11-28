/* ===== 產生站點資訊 panel: token, start, background polling, import ===== */
import { escHtml } from './i18n.js';
import { saveCustomSite } from './site-manager.js';
import { getToken, setToken, checkToken, startJob, pollJob, listJobs, updateJob, dropJob, deleteResult, payloadToSite, summarize } from './sitegen.js';

const POLL_MS = 15000;
const TIMEOUT_MS = 45 * 60 * 1000;
const ACTIVE = ['queued', 'running', 'done'];
const STATE_T = { queued: '排隊中', running: '計算中', done: '匯入中', imported: '已完成', failed: '失敗' };

// rough boxes: CONUS, Alaska, Hawaii, Puerto Rico / USVI, Guam
const US_BOXES = [[24, 50, -125, -66], [51, 72, -180, -129], [18, 23, -161, -154], [17.5, 18.8, -68, -64.5], [13, 14, 144.5, 145.2]];
export const inUS = (lat, lon) => US_BOXES.some(([a, b, c, d]) => lat >= a && lat <= b && lon >= c && lon <= d);

export function initSitegen({ status, toast, here }) {
  const $ = id => document.getElementById(id);
  const form = $('genForm');
  if (!form) return;
  let timer = null, busy = false;

  const syncTok = () => {
    const t = getToken();
    $('sgTokState').textContent = t ? '（已設定）' : '（尚未設定）';
    if (!t) $('sgTokWrap').open = true;
  };

  const ago = ms => { const m = Math.round(ms / 60000); return m < 1 ? '不到 1 分鐘' : m + ' 分鐘'; };
  async function render() {
    const jobs = Object.values(await listJobs()).sort((a, b) => b.startedAt - a.startedAt);
    $('sgJobs').innerHTML = jobs.map(j => {
      const s = j.summary;
      const info = j.state === 'imported' && s
        ? `建築 ${s.buildings} 棟${s.lidarCount ? `；${escHtml(s.lidarLabel)}${s.year ? `（${s.year}）` : ''} 量得 ${s.lidarCount} 棟高度` : '；這裡沒有可用的光達'}${s.canopy ? '；含樹冠' : ''}`
        : j.state === 'failed' ? escHtml(j.error || '')
        : `已經過 ${ago(Date.now() - j.startedAt)}`;
      const notes = j.state === 'imported' && s && s.notes.length ? `<br><small>${s.notes.map(escHtml).join('<br>')}</small>` : '';
      return `<div class="sgjob" style="padding:6px 0;border-top:1px solid var(--bd)">
        <b>${escHtml(j.name || '未命名')}</b> · ${STATE_T[j.state] || escHtml(j.state)}<br><small class="sub">${info}</small>${notes}
        <div class="tools" style="margin-top:4px">${j.state === 'imported' ? `<button type="button" data-open="${escHtml(j.siteId)}">開啟專案</button>` : ''}<button type="button" data-drop="${escHtml(j.req)}">${ACTIVE.includes(j.state) ? '取消追蹤' : '移除紀錄'}</button></div>
      </div>`;
    }).join('');
    return jobs;
  }

  $('sgJobs').addEventListener('click', async e => {
    const open = e.target.closest('[data-open]'), drop = e.target.closest('[data-drop]');
    if (open) { try { localStorage.setItem('lastSite', open.dataset.open); } catch (err) {} location.search = '?site=' + encodeURIComponent(open.dataset.open); }
    if (drop) { await dropJob(drop.dataset.drop); render(); }
  });

  async function importJob(job, payload) {
    const { id, site } = payloadToSite(payload, job);
    await saveCustomSite(id, site);
    const summary = summarize(payload);
    await updateJob(job.req, { state: 'imported', siteId: id, summary, privateKey: null, finishedAt: Date.now() });
    deleteResult(getToken(), job.req);
    toast(`「${escHtml(job.name)}」的站點資訊已產生：建築 ${summary.buildings} 棟` + (summary.lidarCount ? `，光達高度 ${summary.lidarCount} 棟` : '，這裡沒有可用的光達') + '。到「產生站點資訊」按「開啟專案」。');
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const token = getToken();
      const jobs = Object.values(await listJobs()).filter(j => ACTIVE.includes(j.state));
      for (const j of jobs) {
        if (!token) break;
        if (Date.now() - j.startedAt > TIMEOUT_MS) { await updateJob(j.req, { state: 'failed', error: '超過 45 分鐘沒有結果，請到 GitHub Actions 查看。', privateKey: null }); continue; }
        try {
          const r = await pollJob(token, j);
          if (r.state === 'done') { await updateJob(j.req, { state: 'done' }); await importJob(j, r.payload); }
          else if (r.state === 'failed') { await updateJob(j.req, { state: 'failed', error: r.error, privateKey: null }); if (r.payload) deleteResult(token, j.req); status(`「${j.name}」產生失敗：${r.error}`, true); }
          else if (r.state !== j.state) await updateJob(j.req, { state: r.state });
        } catch (err) { console.warn('sitegen poll', err); }
      }
      const left = (await render()).some(j => ACTIVE.includes(j.state));
      if (!left && timer) { clearInterval(timer); timer = null; }
    } finally { busy = false; }
  }
  const ensurePolling = () => { if (!timer) timer = setInterval(tick, POLL_MS); };

  $('projGen').onclick = () => {
    form.hidden = !form.hidden;
    if (!form.hidden) {
      const f = $('projForm'); if (f) f.hidden = true;
      if (!$('sgLat').value && here && inUS(here.lat, here.lon)) { $('sgLat').value = here.lat.toFixed(6); $('sgLon').value = here.lon.toFixed(6); }
      syncTok(); render();
    }
  };
  $('sgCancel').onclick = () => { form.hidden = true; };
  $('sgTokSave').onclick = async () => {
    const t = $('sgTok').value.trim();
    if (!t) { status('請貼上 token。', true); return; }
    try { await checkToken(t); setToken(t); $('sgTok').value = ''; $('sgTokWrap').open = false; syncTok(); toast('token 可以使用。'); }
    catch (e) { status(e.message, true); }
  };
  $('sgTokClear').onclick = () => { setToken(''); syncTok(); toast('已清除 token。'); };

  $('sgStart').onclick = async () => {
    const lat = +$('sgLat').value, lon = +$('sgLon').value, radius = Math.max(100, Math.min(1500, +$('sgRad').value || 500));
    const name = $('sgName').value.trim() || `產生的站點 ${lat.toFixed(4)}, ${lon.toFixed(4)}`;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !$('sgLat').value || !$('sgLon').value) { status('請輸入中心經緯度。', true); return; }
    if (!inUS(lat, lon)) { status('目前只支援美國的地點（建築高度來自 USGS 3DEP 光達）。', true); return; }
    const token = getToken();
    if (!token) { $('sgTokWrap').open = true; status('請先設定 GitHub token。', true); return; }
    $('sgStart').disabled = true;
    try {
      await startJob({ token, name, lat, lon, radius, band: $('sgBand').value });
      toast('已送出，約 2–10 分鐘。可以先做別的事，完成後會通知。');
      await render(); ensurePolling(); setTimeout(tick, 5000);
    } catch (e) { status(e.message, true); }
    finally { $('sgStart').disabled = false; }
  };

  // resume jobs started before a reload
  listJobs().then(all => { if (Object.values(all).some(j => ACTIVE.includes(j.state))) { ensurePolling(); tick(); } });
}
