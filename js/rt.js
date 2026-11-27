/* ===== Ray engine (local ENU: x = east, y = up, z = north, meters) ===== */
export function createRT() {
  let B = [], F = [], GR = 700, GF = { kind: 'ground', g: 0 };
  // terrain: regular grid of ground heights relative to the BS ground (y = 0); null = flat
  let TER = null;
  function setTerrain(t) { TER = t && t.h && t.nx > 1 ? t : null; }
  function ground(x, z) {
    if (!TER) return 0;
    let fx = (x - TER.x0) / TER.step, fz = (z - TER.z0) / TER.step;
    fx = Math.max(0, Math.min(TER.nx - 1.000001, fx)); fz = Math.max(0, Math.min(TER.nz - 1.000001, fz));
    const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j, H = TER.h, n = TER.nx, k = j * n + i;
    return (H[k] * (1 - u) + H[k + 1] * u) * (1 - v) + (H[k + n] * (1 - u) + H[k + n + 1] * u) * v;
  }
  // samples along a segment where the terrain rises above the ray (ends within 3 m ignored: the UE stands on the slope)
  function terrProfile(a, b, fn) {
    const D = Math.hypot(b[0] - a[0], b[2] - a[2]), n = Math.max(2, Math.ceil(D / (TER.step * 0.6)));
    for (let k = 1; k < n; k++) {
      const t = k / n; if (t * D < 3 || (1 - t) * D < 3) continue;
      const x = a[0] + (b[0] - a[0]) * t, z = a[2] + (b[2] - a[2]) * t;
      if (fn(t, x, ground(x, z), a[1] + (b[1] - a[1]) * t, D) === false) return;
    }
  }
  // vegetation: canopy height above ground on a regular grid (null = none). Trees attenuate (Weissberger),
  // they are not treated as specular reflectors; the canopy top also competes as a diffraction edge.
  // building penetration by material (3GPP TR 38.901 Table 7.4.3-1, f in GHz); roof = wall + 5 dB
  const MATL = { wood: f => 4.85 + 0.12 * f, glass: f => 2 + 0.2 * f, concrete: f => 5 + 4 * f, irrGlass: f => 23 + 0.3 * f };
  const mixL = (a, wa, b, wb, f) => 5 - 10 * Math.log10(wa * Math.pow(10, -MATL[a](f) / 10) + wb * Math.pow(10, -MATL[b](f) / 10));
  function wallLoss(mat, f) {
    if (mat === 'wood') return MATL.wood(f);
    if (mat === 'concrete') return MATL.concrete(f);
    if (mat === 'irr') return mixL('irrGlass', 0.7, 'concrete', 0.3, f);   // 38.901 high-loss: IRR glass + concrete
    return mixL('glass', 0.3, 'concrete', 0.7, f);                         // 'mixed', 38.901 low-loss: glass + concrete
  }
  let CAN = null;
  function setCanopy(c) { CAN = c && c.h && c.nx > 1 ? c : null; }
  function canopyAt(x, z) {
    if (!CAN) return 0;
    const i = Math.round((x - CAN.x0) / CAN.step), j = Math.round((z - CAN.z0) / CAN.step);
    return i < 0 || j < 0 || i >= CAN.nx || j >= CAN.nz ? 0 : CAN.h[j * CAN.nx + i];
  }
  function vegDepth(a, b) {
    const H = Math.hypot(b[0] - a[0], b[2] - a[2]), D3 = Math.hypot(H, b[1] - a[1]), n = Math.max(2, Math.ceil(H / (CAN.step * 0.75)));
    let inside = 0;
    for (let k = 0; k < n; k++) {
      const t = (k + .5) / n, x = a[0] + (b[0] - a[0]) * t, z = a[2] + (b[2] - a[2]) * t, c = canopyAt(x, z);
      if (c <= 0) continue;
      const y = a[1] + (b[1] - a[1]) * t, g = ground(x, z);
      if (y < g + c && y > g + Math.max(2, 0.3 * c)) inside++;   // crown layer only: trunks and the space under the crown don't count
    }
    return inside / n * D3;
  }
  // Weissberger modified exponential decay (d in m, f in GHz), capped at 400 m of foliage
  const vegLoss = (d, fG) => d <= 0 ? 0 : d <= 14 ? 0.45 * Math.pow(fG, 0.284) * d : 1.33 * Math.pow(fG, 0.284) * Math.pow(Math.min(d, 400), 0.588);
  function terrBlocked(a, b) { if (!TER) return false; let blk = false; terrProfile(a, b, (t, x, g, y) => { if (g > y + 0.2) { blk = true; return false; } }); return blk; }
  const CELL = 40; let grid = new Map(), gx0 = 0, gz0 = 0, stamp = new Int32Array(0), stampN = 0;
  const area = p => { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i][0] * q[1] - q[0] * p[i][1]; } return a / 2; };
  const pip = (poly, x, z) => { let ins = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const xi = poly[i][0], zi = poly[i][1], xj = poly[j][0], zj = poly[j][1]; if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) ins = !ins; } return ins; };
  const ckey = (cx, cz) => (cx + 50000) * 100000 + (cz + 50000);
  function setBuildings(list, groundR) {
    GR = groundR; B = []; F = []; grid = new Map();
    list.forEach((src, si) => {
      let poly = src.poly.slice();
      if (poly.length > 3) { const f = poly[0], l = poly[poly.length - 1]; if (Math.abs(f[0] - l[0]) < 1e-6 && Math.abs(f[1] - l[1]) < 1e-6) poly.pop(); }
      if (poly.length < 3 || Math.abs(area(poly)) < 4) return;
      if (area(poly) < 0) poly.reverse();
      let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
      poly.forEach(([x, z]) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); });
      const base = TER ? Math.min(...poly.map(([x, z]) => ground(x, z))) : 0;
      src.y0 = base;
      const b = { src: si, y0: base, h: base + src.h, mat: src.mat || null, poly, x0, x1, z0, z1, faces: [] }, bi = B.length; B.push(b);
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], c = poly[(i + 1) % poly.length], dx = c[0] - a[0], dz = c[1] - a[1], len = Math.hypot(dx, dz);
        if (len < 0.3) continue;
        const nx = dz / len, nz = -dx / len;
        const f = { kind: 'wall', b: bi, ax: a[0], az: a[1], dx, dz, len2: len * len, nx, nz, c: nx * a[0] + nz * a[1], y0: b.y0, h: b.h };
        F.push(f); b.faces.push(f);
      }
    });
    gx0 = Math.min(0, ...B.map(b => b.x0)) - CELL; gz0 = Math.min(0, ...B.map(b => b.z0)) - CELL;
    B.forEach((b, i) => {
      for (let cx = Math.floor((b.x0 - 1 - gx0) / CELL); cx <= Math.floor((b.x1 + 1 - gx0) / CELL); cx++)
        for (let cz = Math.floor((b.z0 - 1 - gz0) / CELL); cz <= Math.floor((b.z1 + 1 - gz0) / CELL); cz++) {
          const k = ckey(cx, cz); let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(i);
        }
    });
    stamp = new Int32Array(B.length); stampN = 0; visCache = new Map();
    GF = { kind: 'ground', g: 0 }; F.push(GF);
  }
  const sd = (f, p) => f.kind === 'ground' ? p[1] - f.g : f.nx * p[0] + f.nz * p[2] - f.c;
  const side = (f, p) => sd(f, p) > 1e-6;
  const mirror = (p, f) => { if (f.kind === 'ground') return [p[0], 2 * f.g - p[1], p[2]]; const d = sd(f, p); return [p[0] - 2 * d * f.nx, p[1], p[2] - 2 * d * f.nz]; };
  function cross(a, b, f) {
    const da = sd(f, a), db = sd(f, b); if (da * db >= 0) return null;
    const t = da / (da - db); if (t <= 1e-6 || t >= 1 - 1e-6) return null;
    return { t, p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t] };
  }
  function buildingAt(x, z) {
    const a = grid.get(ckey(Math.floor((x - gx0) / CELL), Math.floor((z - gz0) / CELL))); if (!a) return -1;
    for (const i of a) { const b = B[i]; if (x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1 && pip(b.poly, x, z)) return i; }
    return -1;
  }
  function inFace(f, p) {
    if (f.kind === 'ground') return p[0] * p[0] + p[2] * p[2] <= GR * GR && buildingAt(p[0], p[2]) < 0;
    if (p[1] <= f.y0 || p[1] >= f.h) return false;
    const s = ((p[0] - f.ax) * f.dx + (p[2] - f.az) * f.dz) / f.len2;
    return s > 1e-6 && s < 1 - 1e-6;
  }
  // visit buildings in grid cells along the segment (2D DDA)
  function segBuildings(a, b, fn) {
    stampN++; if (stampN > 2e9) { stamp.fill(0); stampN = 1; }
    const ax = a[0] - gx0, az = a[2] - gz0, dx = b[0] - a[0], dz = b[2] - a[2];
    let cx = Math.floor(ax / CELL), cz = Math.floor(az / CELL);
    const ex = Math.floor((b[0] - gx0) / CELL), ez = Math.floor((b[2] - gz0) / CELL);
    const sx = dx > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
    let tMx = dx !== 0 ? ((cx + (dx > 0 ? 1 : 0)) * CELL - ax) / dx : Infinity, tMz = dz !== 0 ? ((cz + (dz > 0 ? 1 : 0)) * CELL - az) / dz : Infinity;
    const tDx = dx !== 0 ? CELL / Math.abs(dx) : Infinity, tDz = dz !== 0 ? CELL / Math.abs(dz) : Infinity;
    for (let n = 0; n < 20000; n++) {
      const list = grid.get(ckey(cx, cz));
      if (list) for (const i of list) if (stamp[i] !== stampN) { stamp[i] = stampN; fn(i); }
      if (cx === ex && cz === ez) break;
      if (tMx < tMz) { tMx += tDx; cx += sx; } else { tMz += tDz; cz += sz; }
      if (Math.min(tMx, tMz) > 1 + 1e-9 && cx === ex && cz === ez) { /* reached */ }
    }
  }
  function crossings(a, b, limit = Infinity) {
    const out = [];
    const mnx = Math.min(a[0], b[0]), mxx = Math.max(a[0], b[0]), mnz = Math.min(a[2], b[2]), mxz = Math.max(a[2], b[2]), mny = Math.min(a[1], b[1]);
    segBuildings(a, b, i => {
      if (out.length > limit) return;
      const bl = B[i];
      if (bl.x1 < mnx || bl.x0 > mxx || bl.z1 < mnz || bl.z0 > mxz || mny >= bl.h) return;
      for (const f of bl.faces) { const c = cross(a, b, f); if (c && inFace(f, c.p)) out.push({ b: i, kind: 'wall', t: c.t, p: c.p }); }
      if ((a[1] - bl.h) * (b[1] - bl.h) < 0) {
        const t = (a[1] - bl.h) / (a[1] - b[1]);
        if (t > 1e-6 && t < 1 - 1e-6) { const p = [a[0] + (b[0] - a[0]) * t, bl.h, a[2] + (b[2] - a[2]) * t]; if (pip(bl.poly, p[0], p[2])) out.push({ b: i, kind: 'roof', t, p }); }
      }
    });
    return out;
  }
  // faces with an unobstructed view from point p (sampled at a few spots on each wall)
  let visCache = new Map();
  function visibleFaces(p, maxR) {
    const key = p.map(v => v.toFixed(2)).join(',') + '|' + maxR;
    if (visCache.has(key)) return visCache.get(key);
    const out = [];
    for (const f of F) {
      if (f.kind === 'ground') { out.push(f); continue; }
      if (!side(f, p)) continue;
      const mx = f.ax + f.dx / 2 - p[0], mz = f.az + f.dz / 2 - p[2];
      if (Math.hypot(mx, mz) - Math.sqrt(f.len2) / 2 > maxR) continue;
      const H = f.h - f.y0, ys = [f.y0 + Math.min(1.5, H * .5), f.y0 + H * .5, f.y0 + H * .85];
      let vis = false;
      for (const s of [.5, .1, .9, .3, .7]) {
        for (const y of ys) {
          const q = [f.ax + f.dx * s + f.nx * .05, y, f.az + f.dz * s + f.nz * .05];
          if (crossings(p, q, 0).length === 0) { vis = true; break; }
        }
        if (vis) break;
      }
      if (vis) out.push(f);
    }
    if (visCache.size > 400) visCache.clear();
    visCache.set(key, out);
    return out;
  }
  function trace(tx, rx, o) {
    const C = 299792458, lam = C / o.fHz, paths = [];
    const useT = !!TER && o.terrain !== false, useV = !!CAN && o.veg !== false;
    GF.g = useT ? ground(rx[0], rx[2]) : 0;   // ground reflection off the local ground level at the UE
    const add = (pts, type, via) => {
      const pen = [];
      for (let k = 1; k < pts.length; k++) { for (const c of crossings(pts[k - 1], pts[k], o.maxPen)) pen.push(c); if (pen.length > o.maxPen) return; }
      if (useT) for (let k = 1; k < pts.length; k++) if (terrBlocked(pts[k - 1], pts[k])) return;   // no path through the ground
      let veg = 0; if (useV) for (let k = 1; k < pts.length; k++) veg += vegDepth(pts[k - 1], pts[k]);
      paths.push({ pts, type, via, pen, veg });
    };
    add([tx, rx], 'los', []);
    if (o.diff) {
      // single dominant knife edge (ITU-R P.526 approximation): rooftops on the blocked direct path, and terrain ridges
      const cr = crossings(tx, rx), D = Math.hypot(rx[0] - tx[0], rx[2] - tx[2]);
      const tBlk = useT && terrBlocked(tx, rx);
      let best = null;
      const cand = (t, x, h, z, y) => {
        const d1 = t * D, d2 = (1 - t) * D; if (d1 < 0.5 || d2 < 0.5) return;
        const v = (h - y) * Math.sqrt(2 * D / (lam * d1 * d2));
        if (!best || v > best.v) best = { v, p: [x, h, z], terr: h === undefined };
      };
      for (const c of cr) cand(c.t, c.p[0], B[c.b].h, c.p[2], tx[1] + (rx[1] - tx[1]) * c.t);
      if (useV && vegDepth(tx, rx) > 2) {   // direct path goes through trees: the canopy top is a candidate edge too
        const n = Math.max(2, Math.ceil(D / (CAN.step * 0.75)));
        for (let k = 1; k < n; k++) {
          const t = k / n, x = tx[0] + (rx[0] - tx[0]) * t, z = tx[2] + (rx[2] - tx[2]) * t, c = canopyAt(x, z);
          if (c > 0) { const b0 = best; cand(t, x, ground(x, z) + c, z, tx[1] + (rx[1] - tx[1]) * t); if (best !== b0) best.terr = false; }
        }
      }
      if (useT && (cr.length || tBlk)) terrProfile(tx, rx, (t, x, g, y) => { const z = tx[2] + (rx[2] - tx[2]) * t; const b0 = best; cand(t, x, g, z, y); if (best !== b0) best.terr = true; });
      if (best && best.v > -0.78) {
        const J = 6.9 + 20 * Math.log10(Math.sqrt((best.v - 0.1) ** 2 + 1) + best.v - 0.1);
        const veg = useV ? vegDepth(tx, best.p) + vegDepth(best.p, rx) : 0;
        paths.push({ pts: [tx, best.p, rx], type: 'diff', via: [], pen: [], veg, dl: J, terr: !!best.terr });
      }
    }
    const cand = F.filter(f => side(f, tx)), imgs = cand.map(f => mirror(tx, f));
    cand.forEach((f, i) => { if (!side(f, rx)) return; const c = cross(rx, imgs[i], f); if (c && inFace(f, c.p)) add([tx, c.p, rx], 'r1', [f]); });
    if (o.maxOrder >= 2) {
      // second order: first leg leaves from a wall the BS can see, last leg arrives from a wall the UE can see
      const VT = visibleFaces(tx, 800), VR = visibleFaces(rx, 500).filter(f => side(f, rx));
      for (const f1 of VT) {
        const T1 = mirror(tx, f1);
        for (const f2 of VR) {
          if (f2 === f1 || !side(f2, T1)) continue;
          const c2 = cross(rx, mirror(T1, f2), f2); if (!c2 || !inFace(f2, c2.p) || !side(f1, c2.p)) continue;
          const c1 = cross(c2.p, T1, f1); if (!c1 || !inFace(f1, c1.p) || !side(f2, c1.p)) continue;
          add([tx, c1.p, c2.p, rx], 'r2', [f1, f2]);
        }
      }
    }
    for (const p of paths) {
      p.legs = []; let d = 0;
      for (let i = 1; i < p.pts.length; i++) { const l = Math.hypot(p.pts[i][0] - p.pts[i - 1][0], p.pts[i][1] - p.pts[i - 1][1], p.pts[i][2] - p.pts[i - 1][2]); p.legs.push(l); d += l; }
      p.d = d; p.tau = d / C * 1e9;
      let pl = 20 * Math.log10(4 * Math.PI * Math.max(d, 0.1) / lam);
      for (const f of p.via) pl += f.kind === 'ground' ? o.reflG : o.reflW;
      p.penDb = 0;
      for (const c of p.pen) {
        const m = B[c.b] && B[c.b].mat, w = m && o.mat !== false ? wallLoss(m, o.fHz / 1e9) : null;
        const l = w == null ? (c.kind === 'roof' ? o.penR : o.penW) : (c.kind === 'roof' ? w + 5 : w);
        pl += l; p.penDb += l;
      }
      if (p.dl) pl += p.dl;
      if (p.veg > 0.5) { p.vl = vegLoss(p.veg, o.fHz / 1e9) * (o.vegK ?? 1); pl += p.vl; } else p.vl = 0;
      p.pl = pl;
    }
    for (const p of paths) {
      const a = p.pts[0], b = p.pts[1], dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
      p.az = (Math.atan2(dx, dz) * 180 / Math.PI + 360) % 360;
      p.el = Math.atan2(dy, Math.hypot(dx, dz)) * 180 / Math.PI;
    }
    return { paths, total: paths.length };
  }
  return { wallLoss, setBuildings, setTerrain, setCanopy, canopyAt, ground, terrBlocked, trace, buildingAt, building: i => B[i], count: () => B.length, faceCount: () => F.length - 1 };
}

export const RT = createRT();
