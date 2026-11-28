# -*- coding: utf-8 -*-
"""STEP-based 3D component collision audit for an EasyEDA Pro PCB.

Usage (normally invoked by scripts/audit3d.js):
  AUDIT3D_STEP=... AUDIT3D_PADS=... AUDIT3D_REPORT=... freecadcmd scripts/audit3d.py

<pads.json> is the {rows:[{d,x,y,rot,fp,xmin,xmax,ymin,ymax}]} dump produced
by scripts/audit3d.js. The script matches STEP solids to designators, checks
missing models, height/board overhang, and exact part-vs-part intersections.

Exit 1 when any component has no 3D solid or any exact intersection is found.
--strict also fails on height anomalies, out-of-board parts and unmapped solids.
"""
import Part, json, math, os, sys

STEP = os.environ['AUDIT3D_STEP']
PADS = os.environ['AUDIT3D_PADS']
OUT = os.environ['AUDIT3D_REPORT']
STRICT = os.environ.get('AUDIT3D_STRICT') == '1'
MIL = 0.0254

sh = Part.Shape()
sh.read(STEP)
solids = sh.Solids
if not solids:
    print('AUDIT3D_JSON:' + json.dumps({'ok': False, 'error': 'STEP has no solids'}))
    sys.exit(2)

sol = []
for i, s in enumerate(solids):
    bb = s.BoundBox
    sol.append(dict(i=i, xmin=bb.XMin, xmax=bb.XMax, ymin=bb.YMin, ymax=bb.YMax,
                    zmin=bb.ZMin, zmax=bb.ZMax, vol=s.Volume, area=s.Area))

def area(s):
    return (s['xmax'] - s['xmin']) * (s['ymax'] - s['ymin'])

board = max(sol, key=area)
BX0, BX1, BY0, BY1, BT = board['xmin'], board['xmax'], board['ymin'], board['ymax'], board['zmax']
BD = BY1 - BY0

comps = json.load(open(PADS, encoding='utf-8'))['rows']

def prep(flip_y):
    out = []
    for c in comps:
        if c.get('xmin') is None:
            cx, cy = c['x'] * MIL, c['y'] * MIL
            xmin, xmax, ymin, ymax = cx - 1, cx + 1, cy - 1, cy + 1
        else:
            xmin, xmax = c['xmin'] * MIL, c['xmax'] * MIL
            ymin, ymax = c['ymin'] * MIL, c['ymax'] * MIL
        if flip_y:
            ymin, ymax = BD - ymax, BD - ymin
        out.append(dict(d=c['d'], fp=c.get('fp'), rot=c.get('rot'),
                        xmin=xmin - 0.8, xmax=xmax + 0.8, ymin=ymin - 0.8, ymax=ymax + 0.8,
                        pxmin=xmin, pxmax=xmax, pymin=ymin, pymax=ymax,
                        cx=(xmin + xmax) / 2, cy=(ymin + ymax) / 2))
    return out

def dist_rect(px, py, r):
    dx = max(r['xmin'] - px, 0.0, px - r['xmax'])
    dy = max(r['ymin'] - py, 0.0, py - r['ymax'])
    return math.hypot(dx, dy)

def score(cmps):
    tot = 0.0
    for s in sol:
        if s is board:
            continue
        cx = (s['xmin'] + s['xmax']) / 2
        cy = (s['ymin'] + s['ymax']) / 2
        tot += min(dist_rect(cx, cy, c) for c in cmps)
    return tot

straight, flipped = prep(False), prep(True)
sc_s, sc_f = score(straight), score(flipped)
flip = sc_f < sc_s
cmps = flipped if flip else straight

assign, unassigned = {}, []
for s in sol:
    if s is board:
        continue
    cx = (s['xmin'] + s['xmax']) / 2
    cy = (s['ymin'] + s['ymax']) / 2
    best, bd = None, 1e9
    for c in cmps:
        d = dist_rect(cx, cy, c)
        if d < bd:
            bd, best = d, c
    if bd <= 4.0:
        assign.setdefault(best['d'], []).append(s)
    else:
        unassigned.append(dict(solid=s, dist=round(bd, 2)))

def bbox(ss):
    return dict(xmin=min(x['xmin'] for x in ss), xmax=max(x['xmax'] for x in ss),
                ymin=min(x['ymin'] for x in ss), ymax=max(x['ymax'] for x in ss),
                zmin=min(x['zmin'] for x in ss), zmax=max(x['zmax'] for x in ss))

report = []
for c in cmps:
    ss = assign.get(c['d'], [])
    if not ss:
        report.append(dict(d=c['d'], fp=c['fp'], solids=0))
        continue
    b = bbox(ss)
    report.append(dict(d=c['d'], fp=c['fp'], solids=len(ss),
                       w=round(b['xmax'] - b['xmin'], 2), dep=round(b['ymax'] - b['ymin'], 2),
                       h=round(b['zmax'] - b['zmin'], 2), zmin=round(b['zmin'], 3), zmax=round(b['zmax'], 3),
                       cx=round((b['xmin'] + b['xmax']) / 2, 2), cy=round((b['ymin'] + b['ymax']) / 2, 2),
                       vol=round(sum(x['vol'] for x in ss), 2)))

missing = [r['d'] for r in report if r['solids'] == 0]
height_out = []
for r in report:
    if r['solids'] == 0:
        continue
    dz = r['zmin'] - BT
    if dz < -0.05 or dz > 0.8:
        height_out.append(dict(d=r['d'], zmin=r['zmin'], dz=round(dz, 3)))

out_of_board = []
for r in report:
    if r['solids'] == 0:
        continue
    b = bbox(assign[r['d']])
    if b['xmin'] < BX0 - 0.05 or b['xmax'] > BX1 + 0.05 or b['ymin'] < BY0 - 0.05 or b['ymax'] > BY1 + 0.05:
        out_of_board.append(dict(d=r['d'], bbox=[round(b['xmin'], 1), round(b['xmax'], 1), round(b['ymin'], 1), round(b['ymax'], 1)]))

exact_hits = []
names = sorted(assign.keys())
for i in range(len(names)):
    a = names[i]
    A = bbox(assign[a])
    for j in range(i + 1, len(names)):
        b = names[j]
        B = bbox(assign[b])
        if (min(A['xmax'], B['xmax']) - max(A['xmin'], B['xmin']) <= 0 or
                min(A['ymax'], B['ymax']) - max(A['ymin'], B['ymin']) <= 0 or
                min(A['zmax'], B['zmax']) - max(A['zmin'], B['zmin']) <= 0):
            continue
        worst, cnt = 0.0, 0
        for x in assign[a]:
            for y in assign[b]:
                sa, sb = sol[x['i']], sol[y['i']]
                if (min(sa['xmax'], sb['xmax']) - max(sa['xmin'], sb['xmin']) <= 0 or
                        min(sa['ymax'], sb['ymax']) - max(sa['ymin'], sb['ymin']) <= 0 or
                        min(sa['zmax'], sb['zmax']) - max(sa['zmin'], sb['zmin']) <= 0):
                    continue
                try:
                    v = solids[sa['i']].common(solids[sb['i']]).Volume
                except Exception:
                    v = -1
                if v > 0.001:
                    cnt += 1
                    worst = max(worst, v)
        if cnt:
            exact_hits.append(dict(a=a, b=b, vol=round(worst, 3), n=cnt))

ok = not missing and not exact_hits
if STRICT and (height_out or out_of_board or unassigned):
    ok = False
summary = dict(ok=ok, board=dict(x0=round(BX0, 4), x1=round(BX1, 4), y0=round(BY0, 4), y1=round(BY1, 4), z0=round(board['zmin'], 4), z1=round(BT, 4)),
               solids=len(sol), components=len(cmps), matched=len(report) - len(missing), missing=missing,
               exact=exact_hits, height_out=height_out, out_of_board=out_of_board, unassigned=len(unassigned), flip=flip)
json.dump(dict(summary=summary, report=report, unassigned=unassigned), open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('AUDIT3D_JSON:' + json.dumps(summary, ensure_ascii=False))
sys.exit(0 if ok else 1)
