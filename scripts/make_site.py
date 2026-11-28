#!/usr/bin/env python3
"""Generate SiteLens site data for any location in the United States, without AI / ML inference.

  buildings : Overture Maps buildings theme (merged OpenStreetMap, Microsoft, Esri Community Maps ... footprints;
              height / num_floors where a source provides them)
  heights   : USGS 3DEP lidar, read straight from the public Entwine Point Tile (EPT) bucket
              s3://usgs-lidar-public, same per-footprint method as lidar_heights.py
  vegetation: canopy height grid from the same lidar (first-return surface minus ground, buildings removed)

The result is one JSON payload that the web page imports as a custom project. Because this runs in a public
repository's Actions, the payload is encrypted for the requesting browser (RSA-OAEP-256 wrapped AES-256-GCM key):
only the page that holds the matching private key can read it. Logs never contain coordinates or project names;
errors are reported inside the encrypted payload instead.

Usage:
  python scripts/make_site.py --lat 47.6062 --lon -122.3321 --radius 500 --pubkey PUB.b64 --out out.json
  python scripts/make_site.py ... --plain plain.json          # also write the unencrypted payload (local testing)
"""
import argparse, base64, gzip, io, json, math, os, re, sys, time, traceback
from concurrent.futures import ThreadPoolExecutor
import urllib.request

import numpy as np
import laspy
import shapely
from shapely.geometry import Polygon, Point
from pyproj import CRS, Transformer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lidar_heights import rasterize, building_heights, canopy_grid, METHOD  # noqa: E402

PAYLOAD_VERSION = 1
EPT_INDEX = 'https://raw.githubusercontent.com/hobuinc/usgs-lidar/master/boundaries/resources.geojson'
MAX_RADIUS = 1500          # m; keeps a run well inside the Actions time limit
MARGIN = 60                # m of extra lidar around the circle (ground ring + edge buildings)
MAX_BUILDINGS = 20000
MAX_POINTS = 120_000_000   # stop reading deeper EPT levels past this many points in the AOI bounding box
STAGE = {'name': 'start'}


def log(msg):
    print(f'[{time.strftime("%H:%M:%S")}] {msg}', flush=True)


def stage(name):
    STAGE['name'] = name
    log('stage: ' + name)


def http_get(url, tries=4, timeout=90):
    last = None
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'SiteLens-make-site/1'})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise
            last = e
        except Exception as e:  # noqa: BLE001
            last = e
        time.sleep(2 + 3 * k)
    raise RuntimeError(f'download failed after {tries} tries: {type(last).__name__}')


def utm_crs(lat, lon):
    zone = int((lon + 180) // 6) + 1
    return CRS.from_epsg((32600 if lat >= 0 else 32700) + zone)


# ---------------------------------------------------------------- buildings (Overture)
def overture_buildings(lat, lon, radius):
    from overturemaps import core
    mlat, mlon = 111320.0, 111320.0 * math.cos(math.radians(lat))
    r = radius + MARGIN
    bbox = (lon - r / mlon, lat - r / mlat, lon + r / mlon, lat + r / mlat)
    tbl = core.record_batch_reader('building', bbox).read_all()
    cols = set(tbl.column_names)
    rows = tbl.to_pylist()
    center = Point(0, 0)
    out = []
    for row in rows:
        g = row.get('geometry')
        if g is None:
            continue
        geom = shapely.from_wkb(g) if isinstance(g, (bytes, bytearray)) else shapely.from_wkt(g) if isinstance(g, str) else None
        if geom is None or geom.is_empty:
            continue
        polys = list(geom.geoms) if geom.geom_type == 'MultiPolygon' else [geom] if geom.geom_type == 'Polygon' else []
        for k, poly in enumerate(polys):
            ring = list(poly.exterior.coords)
            if len(ring) < 4:
                continue
            local = Polygon([((x - lon) * mlon, (y - lat) * mlat) for x, y in ring])
            dist = local.distance(center)
            if dist > r * 1.5:      # outside the lidar square (corners are r*sqrt(2) away)
                continue
            h = row.get('height') if 'height' in cols else None
            fl = row.get('num_floors') if 'num_floors' in cols else None
            h = float(h) if isinstance(h, (int, float)) and 1 <= h <= 600 else None
            fl = int(fl) if isinstance(fl, (int, float)) and 0 < fl < 200 else None
            names = row.get('names') or {}
            bid = 'ovt/' + str(row.get('id', ''))[:48] + (f'#{k}' if k else '')
            out.append({
                'id': bid,
                'name': (names.get('primary') or '')[:80] if isinstance(names, dict) else '',
                'h': round(h, 1) if h else (round(fl * 3.5, 1) if fl else None),
                'src': 'height' if h else 'levels' if fl else 'default',
                'tagH': f'{h:g}' if h else '',
                'levels': str(fl) if fl else '',
                'btype': str(row.get('class') or row.get('subtype') or '')[:40],
                'll': [[round(x, 7), round(y, 7)] for x, y in ring],
                '_in': dist <= radius + 20,
            })
    out.sort(key=lambda b: Polygon(b['ll']).centroid.distance(Point(lon, lat)))
    out = out[:MAX_BUILDINGS]
    # every footprint masks the canopy grid; only those within the radius go into the site
    site = [{k: v for k, v in b.items() if k != '_in'} for b in out if b['_in']]
    mask = [{k: v for k, v in b.items() if k != '_in'} for b in out]
    return site, mask


# ---------------------------------------------------------------- lidar (3DEP EPT)
def year_of(name):
    ys = [int(y) for y in re.findall(r'(?<!\d)(19[89]\d|20[0-4]\d)(?!\d)', name)]
    return max(ys) if ys else 0


def pick_ept_resources(lat, lon, radius):
    """Return candidate EPT resources covering the site, newest first."""
    idx = json.loads(http_get(EPT_INDEX))
    mlat, mlon = 111320.0, 111320.0 * math.cos(math.radians(lat))
    site = Polygon([(lon + radius / mlon * math.cos(a), lat + radius / mlat * math.sin(a))
                    for a in np.linspace(0, 2 * math.pi, 33)])
    cands = []
    for f in idx.get('features', []):
        try:
            g = shapely.geometry.shape(f['geometry'])
        except Exception:  # noqa: BLE001
            continue
        if not g.intersects(site):
            continue
        cover = g.intersection(site).area / site.area
        p = f.get('properties', {})
        cands.append({'name': p.get('name', ''), 'url': p.get('url', ''), 'count': p.get('count', 0),
                      'cover': cover, 'year': year_of(p.get('name', ''))})
    # prefer full coverage of the circle, then the newest survey
    cands.sort(key=lambda c: (c['cover'] < 0.9, -c['year'], -c['cover']))
    return cands


class EPT:
    def __init__(self, url):
        self.base = url.rsplit('/', 1)[0] + '/'
        self.info = json.loads(http_get(self.base + 'ept.json'))
        b = self.info['bounds']
        self.b0, self.b1 = np.array(b[:3], float), np.array(b[3:], float)
        srs = self.info.get('srs', {})
        if srs.get('authority') and srs.get('horizontal'):
            self.crs = CRS.from_user_input(f"{srs['authority']}:{srs['horizontal']}")
        else:
            self.crs = CRS.from_wkt(srs['wkt'])
        if self.crs.is_compound:
            self.crs = self.crs.sub_crs_list[0]
        self.hier = {}

    def _hier(self, key):
        h = json.loads(http_get(self.base + f'ept-hierarchy/{key}.json'))
        self.hier.update(h)

    def nodes(self, qx0, qy0, qx1, qy1, max_points):
        """Keys of all nodes (every depth) whose cube intersects the query box, breadth first."""
        self._hier('0-0-0-0')
        out, frontier, total = [], [(0, 0, 0, 0)], 0
        while frontier:
            nxt = []
            for d, x, y, z in frontier:
                key = f'{d}-{x}-{y}-{z}'
                cnt = self.hier.get(key)
                if cnt is None:
                    continue
                if cnt == -1:
                    self._hier(key)
                    cnt = self.hier.get(key, 0)
                size = (self.b1 - self.b0) / (2 ** d)
                lo = self.b0 + size * np.array([x, y, z])
                hi = lo + size
                if hi[0] < qx0 or lo[0] > qx1 or hi[1] < qy0 or lo[1] > qy1:
                    continue
                if cnt > 0:
                    out.append((key, cnt))
                    frac = max(0.0, min(hi[0], qx1) - max(lo[0], qx0)) * max(0.0, min(hi[1], qy1) - max(lo[1], qy0))
                    total += cnt * frac / max(size[0] * size[1], 1e-9)
                for dx in (0, 1):
                    for dy in (0, 1):
                        for dz in (0, 1):
                            nxt.append((d + 1, 2 * x + dx, 2 * y + dy, 2 * z + dz))
            if total > max_points:
                log(f'point budget reached at depth {frontier[0][0]}; using {len(out)} nodes')
                break
            frontier = nxt
        return out

    def read(self, key):
        data = http_get(self.base + f'ept-data/{key}.laz')
        return laspy.read(io.BytesIO(data))


def lidar_products(lat, lon, radius, buildings, mask_buildings=None):
    stage('lidar index')
    cands = pick_ept_resources(lat, lon, radius)
    if not cands:
        return None, None, 'no 3DEP lidar covers this location'
    utm = utm_crs(lat, lon)
    to_utm = Transformer.from_crs('EPSG:4326', utm, always_xy=True)
    cx, cy = to_utm.transform(lon, lat)
    r = radius + MARGIN
    aoi = (math.floor(cx - r), math.floor(cy - r), math.ceil(cx + r), math.ceil(cy + r))
    last_err = None
    for c in cands[:3]:
        try:
            stage('lidar read')
            ept = EPT(c['url'])
            to_ept = Transformer.from_crs(utm, ept.crs, always_xy=True)
            ex, ey = to_ept.transform([aoi[0], aoi[2], aoi[0], aoi[2]], [aoi[1], aoi[1], aoi[3], aoi[3]])
            keys = ept.nodes(min(ex), min(ey), max(ex), max(ey), MAX_POINTS)
            log(f'{len(keys)} EPT nodes')
            back = Transformer.from_crs(ept.crs, utm, always_xy=True)

            def chunks():
                with ThreadPoolExecutor(12) as pool:
                    for i, las in enumerate(pool.map(ept.read, [k for k, _ in keys])):
                        x, y = back.transform(np.asarray(las.x), np.asarray(las.y))
                        yield (np.asarray(x), np.asarray(y), np.asarray(las.z), np.asarray(las.classification),
                               np.asarray(las.return_number) == 1, None)
                        if i % 50 == 0:
                            log(f'  nodes read {i + 1}/{len(keys)}')

            dsm, gnd, npts, vdsm, ccount = rasterize(chunks(), aoi, 1.0, veg=True)
            if npts < 1000 or not np.isfinite(gnd).any():
                last_err = 'lidar survey has no ground-classified points here'
                continue
            stage('heights')
            heights, flat, skipped, _, stats = building_heights(buildings, dsm, gnd, to_utm, aoi, 1.0)
            # footprints across the whole lidar square mask the canopy (not only those inside the radius)
            *_, bmask, _ = building_heights(mask_buildings or buildings, dsm, gnd, to_utm, aoi, 1.0)
            stage('canopy')
            nveg = int(ccount[3] + ccount[4] + ccount[5])
            classified = nveg > 0.01 * npts and ccount[6] > 0
            q, cmeta = canopy_grid(vdsm if classified else dsm, gnd, bmask, to_utm, utm, aoi, 1.0, 2.0, (lat, lon))
            log(f"canopy from {'vegetation-classified points' if classified else 'first-return surface'}")
            label = f"USGS 3DEP {c['name']}"
            lidar = {
                'source': f"USGS 3D Elevation Program lidar, project {c['name']} (EPT: {ept.base})",
                'label': label, 'project': c['name'], 'year': c['year'] or None, 'cover': round(c['cover'], 3),
                'crs': utm.to_string(), 'aoi_utm': list(aoi), 'points': int(npts),
                'method': METHOD, 'stats': stats, 'heights': heights, 'flat': flat,
            }
            canopy = dict(cmeta)
            canopy['source'] = (f"{label}: vegetation-classified points (ASPRS 3-5) minus ground, buildings removed" if classified
                                else f"{label}: first-return surface minus ground, buildings removed")
            lidar['classes'] = {str(k): int(v) for k, v in enumerate(ccount) if v}
            canopy['data'] = base64.b64encode(gzip.compress(q.tobytes(), 9)).decode()
            return lidar, canopy, None
        except Exception as e:  # noqa: BLE001
            last_err = f'{type(e).__name__}: {e}'
            log(f'lidar candidate failed ({type(e).__name__}); trying next')
    return None, None, last_err


# ---------------------------------------------------------------- encryption
def encrypt(payload_bytes, pub_b64):
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    pub = serialization.load_der_public_key(base64.b64decode(pub_b64))
    key, iv = AESGCM.generate_key(256), os.urandom(12)
    ct = AESGCM(key).encrypt(iv, payload_bytes, None)
    wrapped = pub.encrypt(key, padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None))
    return {'v': 1, 'alg': 'RSA-OAEP-256+A256GCM', 'key': base64.b64encode(wrapped).decode(),
            'iv': base64.b64encode(iv).decode(), 'data': base64.b64encode(ct).decode()}


# ---------------------------------------------------------------- main
def build_payload(lat, lon, radius):
    t0 = time.time()
    notes = []
    payload = {'v': PAYLOAD_VERSION, 'generator': 'SiteLens make_site.py', 'created': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
               'center': {'lat': lat, 'lon': lon}, 'radius': radius, 'buildings': None, 'lidar': None, 'canopy': None, 'notes': notes}
    stage('buildings')
    try:
        bl, mask_bl = overture_buildings(lat, lon, radius)
        payload['buildings'] = {'attribution': '© Overture Maps Foundation (ODbL, includes © OpenStreetMap contributors)',
                                'source': 'overture', 'date': payload['created'][:10], 'buildings': bl}
        log(f'{len(bl)} buildings')
        if not bl:
            notes.append('Overture has no buildings within the radius')
    except Exception as e:  # noqa: BLE001
        notes.append(f'buildings failed: {type(e).__name__}: {e}')
        log('buildings failed; the page will fall back to live OpenStreetMap')
        bl, mask_bl = [], []
    try:
        lidar, canopy, err = lidar_products(lat, lon, radius, bl, mask_bl)
        payload['lidar'], payload['canopy'] = lidar, canopy
        if err:
            notes.append('lidar: ' + err)
    except Exception as e:  # noqa: BLE001
        notes.append(f'lidar failed: {type(e).__name__}: {e}')
    payload['seconds'] = round(time.time() - t0)
    return payload


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--lat', type=float)
    ap.add_argument('--lon', type=float)
    ap.add_argument('--radius', type=float, default=500)
    ap.add_argument('--pubkey', help='file with base64 SPKI RSA public key')
    ap.add_argument('--from-event', help='read lat/lon/radius/pubkey from a GitHub workflow_dispatch event JSON '
                    '(keeps the values out of env vars, which Actions prints in the log)')
    ap.add_argument('--out', required=True, help='encrypted output path')
    ap.add_argument('--plain', help='also write the unencrypted payload here (testing only)')
    a = ap.parse_args()
    pub = open(a.pubkey).read().strip() if a.pubkey else ''
    if a.from_event:
        inp = (json.load(open(a.from_event)).get('inputs') or {})
        try:
            a.lat, a.lon, a.radius = float(inp['lat']), float(inp['lon']), float(inp.get('radius') or 500)
        except (KeyError, TypeError, ValueError):
            sys.exit('event inputs lat/lon/radius missing or not numbers')
        pub = str(inp.get('pubkey') or '').strip()
        if not re.fullmatch(r'[A-Za-z0-9+/=]{200,1200}', pub):
            sys.exit('event input pubkey is not a base64 SPKI key')
    if a.lat is None or a.lon is None:
        sys.exit('lat/lon required')
    if not pub and not a.plain:
        sys.exit('no public key given')
    if not (-90 <= a.lat <= 90 and -180 <= a.lon <= 180):
        sys.exit('lat/lon out of range')
    radius = max(100.0, min(MAX_RADIUS, a.radius))
    try:
        payload = build_payload(a.lat, a.lon, radius)
    except Exception as e:  # noqa: BLE001
        payload = {'v': PAYLOAD_VERSION, 'error': f'{STAGE["name"]}: {type(e).__name__}: {e}',
                   'trace': traceback.format_exc()[-3000:]}
        log(f'failed at stage {STAGE["name"]} ({type(e).__name__})')
    raw = json.dumps(payload, separators=(',', ':')).encode()
    if a.plain:
        with open(a.plain, 'wb') as f:
            f.write(raw)
    if pub:
        enc = encrypt(gzip.compress(raw, 6), pub)
        enc['gz'] = True
        with open(a.out, 'w') as f:
            json.dump(enc, f)
    nb = len(payload.get('buildings', {}) and payload['buildings']['buildings'] or []) if isinstance(payload.get('buildings'), dict) else 0
    log(f"done: {nb} buildings, lidar={'yes' if payload.get('lidar') else 'no'}, canopy={'yes' if payload.get('canopy') else 'no'}, "
        f"notes={len(payload.get('notes', []))}, error={'yes' if payload.get('error') else 'no'}, {len(raw) / 1e6:.1f} MB")


if __name__ == '__main__':
    main()
