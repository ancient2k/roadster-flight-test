#!/usr/bin/env python3
"""
Generates "RFT Display", the project's own HUD/headline typeface, in three weights.

Why our own font: the Tesla stream HUD uses a squarish, rounded-corner display face with a slashed
zero and tabular figures. Shipping a third-party font would need a download and licence review, so we
draw a compatible stroke font ourselves (uppercase, digits, German umlauts, HUD punctuation).
Lowercase code points map to the uppercase glyphs (the display face is caps-only).

Glyphs are defined as centre-line polylines on a 0..700 cap-height grid; points may carry a fillet
radius (x, y, r). The script strokes them into outline polygons (miter joins, bevel on sharp outer
corners, butt caps), fixes contour direction and writes WOFF files with fontTools.

Usage:  python3 src/ui/fonts/build_font.py   ->  public/assets/fonts/rft-display-{400,600,800}.woff
"""
import math
import os
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

CAP = 700
OUT = os.path.join(os.path.dirname(__file__), '..', '..', '..', 'public', 'assets', 'fonts')
WEIGHTS = {400: 62, 600: 90, 800: 124}  # weight -> stroke width (font units)
SIDE = 64                                # side bearing beyond the stroke
# optical side-bearing corrections (left, right) for open shapes, font units
SIDE_ADJ = {'L': (0, -46), 'T': (-34, -34), 'A': (-22, -22), 'V': (-22, -22), 'W': (-18, -18), 'Y': (-26, -26),
            'F': (0, -24), 'J': (-10, 0), 'P': (0, -10), 'K': (0, -14), 'X': (-14, -14), 'Z': (-6, -6), 'Ä': (-22, -22)}

H = CAP
# --------------------------------------------------------------------------- glyph definitions
# Each glyph: (centre-line width, [paths]); path = ('o'|'c', [pts]) open/closed; pts (x,y) or (x,y,r).
# Special path kinds: ('dot', (x, y)) square dot of stroke size * 1.25.
R = 120  # default rounding
D = 420  # digit width (tabular)


def rr(x0, y0, x1, y1, r):
    return ('c', [(x0, y0, r), (x0, y1, r), (x1, y1, r), (x1, y0, r)])


G = {}
# digits ------------------------------------------------------------------
G['0'] = (D, [rr(0, 0, D, H, 130), ('o', [(86, 150), (D - 86, H - 150)])])
G['1'] = (D, [('o', [(70, H - 150), (250, H, 30), (250, 0)])])
G['2'] = (D, [('o', [(0, H - 170), (0, H, R), (D, H, R), (D, 410, 90), (0, 140, 60), (0, 0), (D, 0)])])
G['3'] = (D, [('o', [(0, H), (D, H, R), (D, 0, R), (0, 0)]), ('o', [(120, 370), (D, 370)])])
G['4'] = (D, [('o', [(0, H), (0, 250, 40), (D, 250)]), ('o', [(320, 470), (320, 0)])])
G['5'] = (D, [('o', [(D, H), (0, H), (0, 400), (D, 400, R), (D, 0, R), (0, 0)])])
G['6'] = (D, [('o', [(D - 20, H), (0, H, R), (0, 0, R), (D, 0, R), (D, 400, R), (0, 400)])])
G['7'] = (D, [('o', [(0, H), (D, H, 40), (D, 560, 60), (150, 0)])])
G['8'] = (D, [rr(0, 0, D, 390, 115), rr(25, 390, D - 25, H, 105)])
G['9'] = (D, [('o', [(20, 0), (D, 0, R), (D, H, R), (0, H, R), (0, 300, R), (D, 300)])])

W = 440
G['A'] = (W, [('o', [(0, 0), (W / 2, H, 10), (W, 0)]), ('o', [(70, 230), (W - 70, 230)])])
G['B'] = (W, [('o', [(0, 360), (W - 50, 360, 100), (W - 50, H, 100), (0, H), (0, 0), (W, 0, 110), (W, 360, 110), (W - 120, 360)])])
G['C'] = (W, [('o', [(W, H), (0, H, 140), (0, 0, 140), (W, 0)])])
G['D'] = (W, [('c', [(0, 0), (0, H), (W, H, 170), (W, 0, 170)])])
G['E'] = (W - 20, [('o', [(W - 20, H), (0, H), (0, 0), (W - 20, 0)]), ('o', [(0, 360), (W - 70, 360)])])
G['F'] = (W - 30, [('o', [(W - 30, H), (0, H), (0, 0)]), ('o', [(0, 360), (W - 80, 360)])])
G['G'] = (W, [('o', [(W, H), (0, H, 140), (0, 0, 140), (W, 0, 100), (W, 320), (230, 320)])])
G['H'] = (W, [('o', [(0, 0), (0, H)]), ('o', [(W, 0), (W, H)]), ('o', [(0, 360), (W, 360)])])
G['I'] = (0, [('o', [(0, 0), (0, H)])])
G['J'] = (W - 40, [('o', [(W - 40, H), (W - 40, 0, 130), (0, 0, 130), (0, 200)])])
G['K'] = (W, [('o', [(0, 0), (0, H)]), ('o', [(W, H), (0, 300)]), ('o', [(150, 430), (W, 0)])])
G['L'] = (W - 40, [('o', [(0, H), (0, 0), (W - 40, 0)])])
G['M'] = (560, [('o', [(0, 0), (0, H), (280, 300), (560, H), (560, 0)])])
G['N'] = (W, [('o', [(0, 0), (0, H), (W, 0), (W, H)])])
G['O'] = (W + 20, [rr(0, 0, W + 20, H, 150)])
G['P'] = (W, [('o', [(0, 0), (0, H), (W, H, 120), (W, 320, 120), (0, 320)])])
G['Q'] = (W + 20, [rr(0, 0, W + 20, H, 150), ('o', [(260, 170), (W + 60, -40)])])
G['R'] = (W, [('o', [(0, 0), (0, H), (W, H, 120), (W, 340, 120), (0, 340)]), ('o', [(260, 340), (W, 0)])])
G['S'] = (W, [('o', [(W, H), (0, H, 120), (0, 360, 100), (W, 360, 100), (W, 0, 120), (0, 0)])])
G['T'] = (W, [('o', [(0, H), (W, H)]), ('o', [(W / 2, H), (W / 2, 0)])])
G['U'] = (W, [('o', [(0, H), (0, 0, 150), (W, 0, 150), (W, H)])])
G['V'] = (W + 20, [('o', [(0, H), ((W + 20) / 2, 0, 10), (W + 20, H)])])
G['W'] = (640, [('o', [(0, H), (140, 0), (320, 560), (500, 0), (640, H)])])
G['X'] = (W, [('o', [(0, H), (W, 0)]), ('o', [(0, 0), (W, H)])])
G['Y'] = (W, [('o', [(0, H), (W / 2, 330), (W, H)]), ('o', [(W / 2, 330), (W / 2, 0)])])
G['Z'] = (W, [('o', [(0, H), (W, H), (0, 0), (W, 0)])])
G['ẞ'] = (W, [('o', [(0, 0), (0, H, 110), (W - 30, H, 30), (190, 400), (W, 360, 110), (W, 0, 110), (130, 0)])])


def with_dots(base, xs, extra_w=0):
    w, paths = G[base]
    return (w + extra_w, paths + [('dot', (x, 860)) for x in xs])


G['Ä'] = with_dots('A', [W / 2 - 110, W / 2 + 110])
G['Ö'] = with_dots('O', [(W + 20) / 2 - 110, (W + 20) / 2 + 110])
G['Ü'] = with_dots('U', [W / 2 - 110, W / 2 + 110])

# punctuation --------------------------------------------------------------
G['.'] = (0, [('dot', (0, 0))])
G[','] = (40, [('o', [(40, 70), (0, -110)])])
G[':'] = (0, [('dot', (0, 0)), ('dot', (0, 460))])
G[';'] = (40, [('o', [(40, 70), (0, -110)]), ('dot', (40, 460))])
G['-'] = (260, [('o', [(0, 330), (260, 330)])])
G['–'] = (440, [('o', [(0, 330), (440, 330)])])
G['—'] = (760, [('o', [(0, 330), (760, 330)])])
G['_'] = (440, [('o', [(0, -80), (440, -80)])])
G['/'] = (340, [('o', [(0, -60), (340, H + 60)])])
G['%'] = (480, [rr(0, 430, 170, H, 60), rr(310, 0, 480, 270, 60), ('o', [(0, 0), (480, H)])])
G['°'] = (200, [rr(0, 480, 200, H, 80)])
G['('] = (170, [('o', [(170, H + 80), (0, H + 80, 130), (0, -80, 130), (170, -80)])])
G[')'] = (170, [('o', [(0, H + 80), (170, H + 80, 130), (170, -80, 130), (0, -80)])])
G['['] = (150, [('o', [(150, H + 80), (0, H + 80), (0, -80), (150, -80)])])
G[']'] = (150, [('o', [(0, H + 80), (150, H + 80), (150, -80), (0, -80)])])
G['+'] = (420, [('o', [(0, 330), (420, 330)]), ('o', [(210, 120), (210, 540)])])
G['='] = (420, [('o', [(0, 230), (420, 230)]), ('o', [(0, 430), (420, 430)])])
G['<'] = (380, [('o', [(380, 610), (0, 330), (380, 50)])])
G['>'] = (380, [('o', [(0, 610), (380, 330), (0, 50)])])
G['!'] = (0, [('o', [(0, 230), (0, H)]), ('dot', (0, 0))])
G['?'] = (420, [('o', [(0, 540), (0, H, 120), (420, H, 120), (420, 420, 100), (200, 360, 60), (200, 230)]), ('dot', (200, 0))])
G["'"] = (0, [('o', [(0, H), (0, 500)])])
G['"'] = (180, [('o', [(0, H), (0, 500)]), ('o', [(180, H), (180, 500)])])
G['·'] = (0, [('dot', (0, 300))])
G['×'] = (380, [('o', [(0, 140), (380, 520)]), ('o', [(0, 520), (380, 140)])])
G['#'] = (460, [('o', [(140, 0), (180, H)]), ('o', [(300, 0), (340, H)]), ('o', [(20, 230), (460, 230)]), ('o', [(0, 470), (440, 470)])])
G['&'] = (480, [('o', [(480, 0), (60, 450, 60), (60, H, 100), (330, H, 100), (330, 470, 60), (0, 250, 80), (0, 0, 110), (300, 0, 110), (480, 250)])])
G['↑'] = (440, [('o', [(220, 0), (220, H)]), ('o', [(0, 480), (220, H), (440, 480)])])
G['↓'] = (440, [('o', [(220, H), (220, 0)]), ('o', [(0, 220), (220, 0), (440, 220)])])
G['←'] = (640, [('o', [(640, 330), (0, 330)]), ('o', [(220, 550), (0, 330), (220, 110)])])
G['→'] = (640, [('o', [(0, 330), (640, 330)]), ('o', [(420, 550), (640, 330), (420, 110)])])
G['^'] = (380, [('o', [(0, 450), (190, H), (380, 450)])])


# --------------------------------------------------------------------------- geometry
def sub(a, b): return (a[0] - b[0], a[1] - b[1])
def add(a, b): return (a[0] + b[0], a[1] + b[1])
def mul(a, s): return (a[0] * s, a[1] * s)
def dot(a, b): return a[0] * b[0] + a[1] * b[1]
def cross(a, b): return a[0] * b[1] - a[1] * b[0]
def length(a): return math.hypot(a[0], a[1])
def norm(a):
    l = length(a)
    return (a[0] / l, a[1] / l) if l > 1e-9 else (0.0, 0.0)


def fillet(pts, closed):
    """Replace vertices that carry a radius with sampled circular arcs."""
    n = len(pts)
    out = []
    for i in range(n):
        p = pts[i]
        r = p[2] if len(p) > 2 else 0
        B = (p[0], p[1])
        if r <= 0 or (not closed and (i == 0 or i == n - 1)):
            out.append(B)
            continue
        A = pts[(i - 1) % n][:2]
        C = pts[(i + 1) % n][:2]
        u1, u2 = norm(sub(A, B)), norm(sub(C, B))
        cosang = max(-1.0, min(1.0, dot(u1, u2)))
        theta = math.acos(cosang)
        if theta < 1e-3 or theta > math.pi - 1e-3:
            out.append(B)
            continue
        t = r / math.tan(theta / 2)
        # neighbours that are endpoints of an open path may be consumed fully; shared edges only half
        la, lc = length(sub(A, B)), length(sub(C, B))
        ka = 0.95 if (not closed and i - 1 == 0) else 0.5
        kc = 0.95 if (not closed and i + 1 == n - 1) else 0.5
        t = min(t, la * ka, lc * kc)
        r_eff = t * math.tan(theta / 2)
        P1, P2 = add(B, mul(u1, t)), add(B, mul(u2, t))
        bis = norm(add(u1, u2))
        Cc = add(B, mul(bis, r_eff / math.sin(theta / 2)))
        a1 = math.atan2(P1[1] - Cc[1], P1[0] - Cc[0])
        a2 = math.atan2(P2[1] - Cc[1], P2[0] - Cc[0])
        da = a2 - a1
        while da > math.pi: da -= 2 * math.pi
        while da < -math.pi: da += 2 * math.pi
        steps = max(2, int(math.ceil(abs(da) / (math.pi / 2) * 14)))
        for k in range(steps + 1):
            a = a1 + da * k / steps
            out.append((Cc[0] + r_eff * math.cos(a), Cc[1] + r_eff * math.sin(a)))
    # drop near-duplicates
    clean = []
    for q in out:
        if not clean or length(sub(q, clean[-1])) > 0.5:
            clean.append(q)
    if closed and len(clean) > 1 and length(sub(clean[0], clean[-1])) < 0.5:
        clean.pop()
    return clean


def offset_side(pts, closed, h, side):
    """Offset a polyline by h on one side (side=+1 left, -1 right). Miter, bevel on sharp convex corners."""
    n = len(pts)
    res = []
    for i in range(n):
        P = pts[i]
        has_prev = closed or i > 0
        has_next = closed or i < n - 1
        d0 = norm(sub(P, pts[(i - 1) % n])) if has_prev else None
        d1 = norm(sub(pts[(i + 1) % n], P)) if has_next else None
        if d0 is None: d0 = d1
        if d1 is None: d1 = d0
        n0 = mul((-d0[1], d0[0]), side)
        n1 = mul((-d1[1], d1[0]), side)
        m = norm(add(n0, n1))
        c = dot(m, n0)
        turn = cross(d0, d1) * side  # >0: this side is the inner side of the turn
        if c < 1e-3:
            res.append(add(P, mul(n0, h))); res.append(add(P, mul(n1, h)))
            continue
        miter = h / c
        if turn < 0 and miter > 1.6 * h:  # sharp outer corner -> bevel
            res.append(add(P, mul(n0, h))); res.append(add(P, mul(n1, h)))
        else:
            res.append(add(P, mul(m, min(miter, 4 * h))))
    return res


def area(poly):
    s = 0
    for i in range(len(poly)):
        x0, y0 = poly[i]; x1, y1 = poly[(i + 1) % len(poly)]
        s += x0 * y1 - x1 * y0
    return s / 2


def orient(poly, clockwise):
    a = area(poly)
    if (a < 0) != clockwise:
        poly = poly[::-1]
    return poly


def stroke_path(kind, pts, w):
    h = w / 2
    if kind == 'dot':
        x, y = pts
        s = w * 1.2
        return [orient([(x - s / 2, y), (x - s / 2, y + s), (x + s / 2, y + s), (x + s / 2, y)], True)]
    closed = kind == 'c'
    cl = fillet(pts, closed)
    if closed:
        outer = offset_side(cl, True, h, 1)
        inner = offset_side(cl, True, h, -1)
        # outer ring is the one with larger |area|
        if abs(area(outer)) < abs(area(inner)):
            outer, inner = inner, outer
        return [orient(outer, True), orient(inner, False)]
    left = offset_side(cl, False, h, 1)
    right = offset_side(cl, False, h, -1)
    return [orient(left + right[::-1], True)]


def build(weight, w):
    h = w / 2
    order = ['.notdef', 'space', 'nbsp']
    glyphs, metrics, cmap = {}, {}, {}

    def empty(adv):
        pen = TTGlyphPen(None)
        return pen.glyph(), adv

    # .notdef: hollow box
    pen = TTGlyphPen(None)
    for poly in stroke_path('c', [(0, 0), (0, H), (380, H), (380, 0)], w):
        pen.moveTo(poly[0])
        for q in poly[1:]: pen.lineTo(q)
        pen.closePath()
    glyphs['.notdef'] = pen.glyph(); metrics['.notdef'] = (int(380 + w + 2 * SIDE), SIDE)
    for name, adv in (('space', 300), ('nbsp', 300)):
        g, a = empty(adv); glyphs[name] = g; metrics[name] = (a, 0)
    cmap[0x20] = 'space'; cmap[0xA0] = 'nbsp'; cmap[0x202F] = 'nbsp'

    sy = (CAP - w) / CAP  # vertical scale so that the outline cap height is exactly CAP
    for ch, (cw, paths) in G.items():
        name = 'uni%04X' % ord(ch)
        pen = TTGlyphPen(None)
        xmin = 1e9
        polys = []
        for p in paths:
            kind, data = p
            if kind == 'dot':
                x, y = data
                y = y * sy
                polys += stroke_path('dot', (x, y), w)
            else:
                pts = [(q[0], q[1] * sy + h) + tuple(q[2:]) for q in data]
                polys += stroke_path(kind, pts, w)
        for poly in polys:
            xmin = min(xmin, min(q[0] for q in poly))
        xmax = max(max(q[0] for q in poly) for poly in polys)
        dx = SIDE - xmin
        la, ra = SIDE_ADJ.get(ch, (0, 0))
        dx += la
        if ch in '0123456789':  # centre in the tabular advance
            dx = (D + w + 2 * SIDE - (xmax - xmin)) / 2 - xmin
        for poly in polys:
            pen.moveTo((round(poly[0][0] + dx), round(poly[0][1])))
            for q in poly[1:]:
                pen.lineTo((round(q[0] + dx), round(q[1])))
            pen.closePath()
        glyphs[name] = pen.glyph()
        adv = int(round(cw + w + 2 * SIDE)) if ch not in '.:!·' else int(round(w * 1.2 + 2 * SIDE))
        adv += la + ra
        if ch in '0123456789':
            adv = int(round(D + w + 2 * SIDE))  # tabular figures
        metrics[name] = (adv, SIDE)
        order.append(name)
        cmap[ord(ch)] = name
        low = ch.lower()
        if low != ch and len(low) == 1:
            cmap[ord(low)] = name
    cmap[ord('ß')] = 'uni1E9E'
    cmap[0x2212] = 'uni002D'  # minus sign -> hyphen

    fb = FontBuilder(1000, isTTF=True)
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap(cmap)
    fb.setupGlyf(glyphs)
    # recompute lsb from glyph bounds
    glyf = fb.font['glyf']
    hm = {}
    for n in order:
        g = glyf[n]
        g.recalcBounds(glyf)
        hm[n] = (metrics[n][0], getattr(g, 'xMin', 0) or 0)
    fb.setupHorizontalMetrics(hm)
    fb.setupHorizontalHeader(ascent=900, descent=-250)
    style = {400: 'Regular', 600: 'SemiBold', 800: 'Bold'}[weight]
    fb.setupNameTable({'familyName': 'RFT Display', 'styleName': style,
                       'copyright': 'Roadster Flight Test project font (own work)',
                       'uniqueFontIdentifier': f'RFTDisplay-{style}'})
    fb.setupOS2(sTypoAscender=900, sTypoDescender=-250, usWinAscent=950, usWinDescent=300,
                usWeightClass=weight, sCapHeight=CAP, sxHeight=CAP, achVendID='RFT ')
    fb.setupPost()
    os.makedirs(OUT, exist_ok=True)
    fb.font.flavor = 'woff'
    path = os.path.join(OUT, f'rft-display-{weight}.woff')
    fb.save(path)
    return path


if __name__ == '__main__':
    for wgt, sw in WEIGHTS.items():
        print(build(wgt, sw))
