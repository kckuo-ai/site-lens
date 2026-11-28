#!/usr/bin/env python3
"""Stage the sitegen-out tree: keep results younger than MAX_AGE, add the new one.
Request ids are 'r' + base36(milliseconds) + random, so the age is read from the file name."""
import os, re, shutil, sys, time

MAX_AGE_H = 24


def age_hours(name, now_ms):
    m = re.fullmatch(r'r([0-9a-z]{6,10})[0-9a-z]{0,8}\.json', name)
    if not m:
        return None
    for n in range(len(m.group(1)), 5, -1):      # the timestamp part is 8 chars today; be lenient
        try:
            t = int(m.group(1)[:n], 36)
            if 1.6e12 < t < 4e12:
                return (now_ms - t) / 3.6e6
        except ValueError:
            pass
    return None


def main(tree, result, req):
    if not re.fullmatch(r'r[0-9a-z]{8,24}', req):
        sys.exit('bad request id')
    out = os.path.join(tree, 'out')
    os.makedirs(out, exist_ok=True)
    now = time.time() * 1000
    for f in os.listdir(out):
        a = age_hours(f, now)
        if a is None or a > MAX_AGE_H or a < -1:   # unparseable, stale, or from the future
            os.remove(os.path.join(out, f))
    shutil.copyfile(result, os.path.join(out, req + '.json'))
    with open(os.path.join(tree, 'README.md'), 'w') as f:
        f.write('Encrypted results of the SiteLens "產生站點資訊" workflow (make-site.yml).\n'
                'Each file can only be decrypted by the browser that requested it; files older than a day are pruned.\n')


if __name__ == '__main__':
    main(*sys.argv[1:4])
