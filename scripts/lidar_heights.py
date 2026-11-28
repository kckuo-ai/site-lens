#!/usr/bin/env python3
"""Per-building heights for the bundled OSM footprints from the NOAA 2015 Anchorage lidar.

For every OSM footprint:
  roof   = 90th percentile of the first-return surface (1 m cells) inside the footprint shrunk by 1 m
  ground = median of ground-classified cells in a ring 1.5-10 m outside the footprint
  height = roof - ground
Footprints whose height comes out below 2 m are listed as "flat": the lidar saw only ground there,
so the building is probably newer than the 2015 survey (or is a carport/slab) and keeps its default height.

Also writes a canopy height grid (lidar/canopy_anchorage.json + .bin.gz): first-return surface minus
gap-filled ground, with building footprints (+1.5 m) removed, heights < 2.5 m and blobs < 6 m2 dropped,
resampled (2x2 max) onto a 2 m east/north grid around REF, the same local frame the web page uses.

Runs in GitHub Actions (network access to NOAA's public S3 bucket). LIDAR_DIR=... reuses local .laz files.
"""
import argparse, gzip, json, os, sys, time, urllib.request
import numpy as np
import laspy
import shapely
from shapely.geometry import Polygon
from pyproj import CRS, Transformer
from scipy import ndimage

DEFAULT_CFG = {
    'prefix': 'anchorage',
    'source': 'NOAA OCM, 2015 Lidar: Municipality of Anchorage, AK (Digital Coast ID 8406), collected May 2015',
    'canopy_source': 'NOAA 2015 Anchorage lidar (ID 8406): first-return surface minus ground, buildings removed',
    'base': 'https://noaa-nos-coastal-lidar-pds.s3.amazonaws.com/laz/geoid12b/8406/',
    'tiles': ['20150510_AK_Anchorage_2015_%s.copc.laz' % t for t in
              ['63436785', '63446784', '63446785', '63446786', '63456784', '63456785', '63456786']],
    'aoi': [666100.0, 6784800.0, 669100.0, 6787300.0],     # UTM metres: drive-test extent + margin
    'ref': [61.1729384, -149.8841974],                      # site BS (lat, lon): origin of the canopy grid
    'buildings': 'buildings_osm.json',
    'cell': 1.0,
    'canopy_step': 2.0,
}
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(REPO, 'lidar')
NOISE = {7, 18}
GROUND = 2


def parse_args():
    p = argparse.ArgumentParser(description='Compute per-building roof heights and canopy grid from COPC/LAZ lidar tiles.')
    p.add_argument('--config', help='JSON config file overriding base, tiles, aoi, ref, buildings, prefix, etc.')
    p.add_argument('--prefix', help='Output filename prefix (default: anchorage)')
    p.add_argument('--buildings', help='Input buildings JSON path (default: buildings_osm.json)')
    p.add_argument('--out-dir', help='Output directory (default: lidar/)')
    p.add_argument('--lidar-dir', help='Local cache directory for .laz files (overrides LIDAR_DIR env)')
    p.add_argument('--ref-lat', type=float, help='Reference BS latitude')
    p.add_argument('--ref-lon', type=float, help='Reference BS longitude')
    return p.parse_args()


def load_cfg(args):
    cfg = dict(DEFAULT_CFG)
    if args.config:
        with open(args.config, encoding='utf-8') as f:
            cfg.update(json.load(f))
    if args.prefix:
        cfg['prefix'] = args.prefix
    if args.buildings:
        cfg['buildings'] = args.buildings
    if args.ref_lat is not None and args.ref_lon is not None:
        cfg['ref'] = [args.ref_lat, args.ref_lon]
    return cfg


def log(*a):
    print(*a, flush=True)


def fetch(base, name, d):
    p = os.path.join(d, name)
    if os.path.exists(p) and os.path.getsize(p) > 0:
        return p
    url = base + name
    for k in range(3):
        try:
            t = time.time()
            urllib.request.urlretrieve(url, p + '.part')
            os.replace(p + '.part', p)
            log(f'  downloaded {name} {os.path.getsize(p) / 1e6:.1f} MB in {time.time() - t:.0f} s')
            return p
        except Exception as e:  # noqa: BLE001
            log(f'  retry {k + 1} {name}: {e}')
            time.sleep(5)
    raise RuntimeError('download failed: ' + name)


def horizontal_crs(las):
    try:
        c = las.header.parse_crs()
    except Exception:  # noqa: BLE001
        c = None
    if c is None:
        return CRS.from_epsg(6334), 'EPSG:6334 (assumed: NAD83(2011) / UTM 5N)'
    if c.is_compound:
        c = c.sub_crs_list[0]
    return c, c.to_string()


def rasterize(chunks, aoi, cell):
    """Accumulate lidar points onto a 1 m grid in the projected CRS of `aoi`.
    chunks yields (x, y, z, classification, is_first_return, label) numpy arrays.
    Returns (dsm, gnd, npts): max first-return surface and mean ground (class 2) per cell."""
    x0, y0, x1, y1 = aoi
    nx, ny = int((x1 - x0) / cell), int((y1 - y0) / cell)
    dsm = np.full(nx * ny, -np.inf, dtype=np.float64)
    gsum = np.zeros(nx * ny); gcnt = np.zeros(nx * ny)
    npts = 0
    for x, y, z, cls, first, label in chunks:
        m = (x >= x0) & (x < x1) & (y >= y0) & (y < y1)
        ix = ((x[m] - x0) / cell).astype(np.int64); iy = ((y[m] - y0) / cell).astype(np.int64)
        idx = iy * nx + ix
        zc, cc, fc = z[m], cls[m], first[m]
        npts += int(m.sum())
        s = fc & ~np.isin(cc, list(NOISE))                       # surface: first returns, no noise
        np.maximum.at(dsm, idx[s], zc[s])
        g = cc == GROUND
        gsum += np.bincount(idx[g], weights=zc[g], minlength=nx * ny)
        gcnt += np.bincount(idx[g], minlength=nx * ny)
        if label:
            log(f'{label}: {m.sum():,} points in area, {g.sum():,} ground')
    dsm[~np.isfinite(dsm)] = np.nan
    gnd = np.where(gcnt > 0, gsum / np.maximum(gcnt, 1), np.nan)
    dsm = dsm.reshape(ny, nx); gnd = gnd.reshape(ny, nx)
    log(f'cells with surface {np.isfinite(dsm).mean():.1%}, with ground {np.isfinite(gnd).mean():.1%}; {npts:,} points')
    return dsm, gnd, npts


def building_heights(buildings, dsm, gnd, tf, aoi, cell):
    """Per-footprint roof height (see module docstring). Returns (heights, flat, skipped, bmask, stats)."""
    x0, y0, x1, y1 = aoi
    ny, nx = dsm.shape
    heights, flat, skipped = {}, [], 0
    bmask = np.zeros((ny, nx), dtype=bool)
    for b in buildings:
        xy = [tf.transform(lon, lat) for lon, lat in b['ll']]
        if len(xy) < 4:
            continue
        poly = Polygon(xy)
        if not poly.is_valid:
            poly = poly.buffer(0)
        if poly.is_empty:
            continue
        bx0, by0, bx1, by1 = poly.bounds
        if bx1 < x0 + 12 or bx0 > x1 - 12 or by1 < y0 + 12 or by0 > y1 - 12:
            continue
        grow = poly.buffer(1.5)
        gx0, gy0, gx1, gy1 = grow.bounds
        i0, i1 = max(0, int((gx0 - x0) / cell)), min(nx - 1, int((gx1 - x0) / cell))
        j0, j1 = max(0, int((gy0 - y0) / cell)), min(ny - 1, int((gy1 - y0) / cell))
        if i1 >= i0 and j1 >= j0:
            II, JJ = np.meshgrid(np.arange(i0, i1 + 1), np.arange(j0, j1 + 1))
            ins = shapely.contains_xy(grow, x0 + (II + .5) * cell, y0 + (JJ + .5) * cell)
            bmask[JJ[ins], II[ins]] = True
        inner = poly.buffer(-1.0)
        if inner.is_empty or inner.area < 4:
            inner = poly.buffer(-0.3) if not poly.buffer(-0.3).is_empty else poly
        ring = poly.buffer(10).difference(poly.buffer(1.5))

        def cells(geom, grid):
            gx0, gy0, gx1, gy1 = geom.bounds
            i0, i1 = max(0, int((gx0 - x0) / cell)), min(nx - 1, int((gx1 - x0) / cell))
            j0, j1 = max(0, int((gy0 - y0) / cell)), min(ny - 1, int((gy1 - y0) / cell))
            if i1 < i0 or j1 < j0:
                return np.array([])
            II, JJ = np.meshgrid(np.arange(i0, i1 + 1), np.arange(j0, j1 + 1))
            cx, cy = x0 + (II + .5) * cell, y0 + (JJ + .5) * cell
            inside = shapely.contains_xy(geom, cx, cy)
            return grid[JJ[inside], II[inside]]

        roof = cells(inner, dsm); roof = roof[np.isfinite(roof)]
        gr = cells(ring, gnd); gr = gr[np.isfinite(gr)]
        if roof.size < 3 or gr.size < 3:
            skipped += 1
            continue
        g0 = float(np.median(gr))
        h90 = float(np.percentile(roof, 90)) - g0
        h50 = float(np.percentile(roof, 50)) - g0
        if h90 < 2.0:
            flat.append(b['id'])
            continue
        heights[b['id']] = [round(h90, 1), round(h50, 1), int(roof.size)]

    hs = np.array([v[0] for v in heights.values()]) if heights else np.array([0.0])
    stats = {'count': len(heights), 'flat': len(flat), 'skipped_no_data': skipped,
             'p10': round(float(np.percentile(hs, 10)), 1), 'p25': round(float(np.percentile(hs, 25)), 1),
             'median': round(float(np.median(hs)), 1), 'p75': round(float(np.percentile(hs, 75)), 1),
             'p90': round(float(np.percentile(hs, 90)), 1), 'max': round(float(hs.max()), 1)}
    return heights, flat, skipped, bmask, stats


METHOD = 'height = p90 of 1 m first-return surface inside footprint shrunk 1 m, minus median ground (class 2) in a 1.5-10 m ring; < 2 m listed as flat'


def main():
    args = parse_args()
    cfg = load_cfg(args)
    base, tiles = cfg['base'], cfg['tiles']
    aoi = tuple(cfg['aoi'])
    cell = float(cfg['cell'])
    out_dir = args.out_dir or OUT_DIR
    d = args.lidar_dir or os.environ.get('LIDAR_DIR') or os.path.join(REPO, '.lidar_cache')
    os.makedirs(d, exist_ok=True)
    os.makedirs(out_dir, exist_ok=True)
    crs_box = {}

    def chunks():
        for name in tiles:
            las = laspy.read(fetch(base, name, d))
            if 'crs' not in crs_box:
                crs_box['crs'], crs_box['txt'] = horizontal_crs(las)
                log('CRS:', crs_box['txt'])
            yield (np.asarray(las.x), np.asarray(las.y), np.asarray(las.z), np.asarray(las.classification),
                   np.asarray(las.return_number) == 1, name)

    dsm, gnd, _ = rasterize(chunks(), aoi, cell)
    crs, crs_txt = crs_box['crs'], crs_box['txt']

    bpath = cfg['buildings'] if os.path.isabs(cfg['buildings']) else os.path.join(REPO, cfg['buildings'])
    src = json.load(open(bpath, encoding='utf-8'))
    tf = Transformer.from_crs('EPSG:4326', crs, always_xy=True)
    heights, flat, skipped, bmask, stats = building_heights(src['buildings'], dsm, gnd, tf, aoi, cell)
    prefix = cfg['prefix']
    out = {
        'source': cfg['source'],
        'url': base, 'tiles': tiles, 'crs': crs_txt, 'aoi_utm': list(aoi),
        'method': METHOD,
        'stats': stats, 'heights': heights, 'flat': flat,
    }
    with open(os.path.join(out_dir, f'heights_{prefix}.json'), 'w', encoding='utf-8') as f:
        json.dump(out, f, separators=(',', ':'))
    log('stats', json.dumps(stats))
    canopy(dsm, gnd, bmask, tf, crs, cfg, out_dir)


def canopy_grid(dsm, gnd, bmask, tf, crs, aoi, cell, can_step, ref):
    """Canopy height grid on a can_step east/north grid around ref.
    Returns (q, meta): q = uint8 array (0.2 m units, row = north index), meta = grid geometry + stats."""
    x0, y0, x1, y1 = aoi
    ny, nx = dsm.shape
    miss = ~np.isfinite(gnd)
    _, (ri, rj) = ndimage.distance_transform_edt(miss, return_indices=True)
    gf = gnd[ri, rj]                                              # ground filled from the nearest measured cell
    chm = dsm - gf
    chm[~np.isfinite(chm) | bmask] = 0
    chm[chm < 2.5] = 0
    chm = np.clip(chm, 0, 45)
    lab, n = ndimage.label(chm > 0, structure=np.ones((3, 3)))
    if n:
        sizes = ndimage.sum(np.ones_like(chm), lab, index=np.arange(1, n + 1))
        small = np.zeros(n + 1, dtype=bool); small[1:] = sizes < 6
        chm[small[lab]] = 0
    chm = ndimage.maximum_filter(chm, size=2)
    # 2 m east/north grid around ref, same approximation as the page (metres per degree at ref latitude)
    lat0, lon0 = tuple(ref)
    mlat, mlon = 111320.0, 111320.0 * np.cos(np.radians(lat0))
    back = Transformer.from_crs(crs, 'EPSG:4326', always_xy=True)
    cl = np.array([back.transform(x, y) for x, y in [(x0, y0), (x1, y0), (x0, y1), (x1, y1)]])
    ex0, ex1 = (cl[:, 0].min() - lon0) * mlon, (cl[:, 0].max() - lon0) * mlon
    nz0, nz1 = (cl[:, 1].min() - lat0) * mlat, (cl[:, 1].max() - lat0) * mlat
    gx0, gz0 = np.floor(ex0 / can_step) * can_step, np.floor(nz0 / can_step) * can_step
    gnx, gnz = int((ex1 - gx0) / can_step) + 1, int((nz1 - gz0) / can_step) + 1
    E, N = np.meshgrid(gx0 + np.arange(gnx) * can_step, gz0 + np.arange(gnz) * can_step)
    ux, uy = tf.transform(lon0 + E / mlon, lat0 + N / mlat)
    ii, jj = ((np.asarray(ux) - x0) / cell).astype(int), ((np.asarray(uy) - y0) / cell).astype(int)
    ok = (ii >= 0) & (ii < nx) & (jj >= 0) & (jj < ny)
    out = np.zeros(E.shape, dtype=np.float32)
    out[ok] = chm[jj[ok], ii[ok]]
    q = np.clip(np.round(out / 0.2), 0, 255).astype(np.uint8)  # 0.2 m units, row = north index
    tree = out > 0
    meta = {'ref': {'lat': lat0, 'lon': lon0}, 'x0': float(gx0), 'z0': float(gz0), 'step': can_step, 'nx': gnx, 'nz': gnz,
            'scale': 0.2,
            'stats': {'tree_fraction': round(float(tree.mean()), 3), 'median_h': round(float(np.median(out[tree])), 1) if tree.any() else 0,
                      'p90_h': round(float(np.percentile(out[tree], 90)), 1) if tree.any() else 0}}
    log('canopy', json.dumps(meta['stats']), f'grid {gnx}x{gnz}')
    return q, meta


def canopy(dsm, gnd, bmask, tf, crs, cfg, out_dir):
    prefix = cfg['prefix']
    q, g = canopy_grid(dsm, gnd, bmask, tf, crs, tuple(cfg['aoi']), float(cfg['cell']), float(cfg['canopy_step']), tuple(cfg['ref']))
    bin_name = f'canopy_{prefix}.bin.gz'
    with gzip.open(os.path.join(out_dir, bin_name), 'wb', compresslevel=9) as f:
        f.write(q.tobytes())
    meta = {'source': cfg['canopy_source'], 'ref': g['ref'], 'x0': g['x0'], 'z0': g['z0'], 'step': g['step'],
            'nx': g['nx'], 'nz': g['nz'], 'scale': g['scale'], 'file': bin_name, 'stats': g['stats']}
    with open(os.path.join(out_dir, f'canopy_{prefix}.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f)


if __name__ == '__main__':
    try:
        main()
    except Exception as e:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        sys.exit(1)
