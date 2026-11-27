/* ===== Web Worker for parallel heatmap ray tracing ===== */
import { createRT } from './rt.js';

export function packPaths(r) {
  return {
    az: Float32Array.from(r.paths, q => q.az),
    el: Float32Array.from(r.paths, q => q.el),
    pl: Float32Array.from(r.paths, q => q.pl),
  };
}

export function traceHeatChunk(rt, chunk, txs, multi, opts) {
  const out = new Array(chunk.length);
  for (let k = 0; k < chunk.length; k++) {
    const pt = chunk[k];
    const rx = [pt.x, pt.y, pt.z];
    if (multi) {
      out[k] = { m: pt.m, i: pt.i, j: pt.j, x: pt.x, z: pt.z, ru: txs.map(t => packPaths(rt.trace(t, rx, opts))) };
    } else {
      out[k] = { m: pt.m, i: pt.i, j: pt.j, x: pt.x, z: pt.z, ...packPaths(rt.trace(txs[0], rx, opts)) };
    }
  }
  return out;
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof window === 'undefined') {
  const rt = createRT();
  self.onmessage = e => {
    const msg = e.data;
    if (msg.type === 'init') {
      rt.setTerrain(msg.terrain || null);
      rt.setCanopy(msg.canopy || null);
      rt.setBuildings(msg.buildings || [], msg.groundR || 700);
      self.postMessage({ type: 'ready', sceneId: msg.sceneId });
    } else if (msg.type === 'chunk') {
      const results = traceHeatChunk(rt, msg.chunk, msg.txs, msg.multi, msg.opts);
      self.postMessage({ type: 'chunkDone', jobId: msg.jobId, workerId: msg.workerId, results });
    }
  };
}
