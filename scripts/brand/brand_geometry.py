"""Generates the Akflix monochrome brand geometry (mark, wordmark, icons) as SVG.

The mark is a geometric single-storey lowercase "a" whose counter is a rounded
play triangle. The wordmark "akflix" is drawn from the same construction (heavy
monoline strokes, horizontal terminals) so no font is needed anywhere.

Usage: python3 scripts/brand/brand_geometry.py assets/brand src/brand/logo.json
Writes the SVG sources (mark, wordmark, macOS/iOS icon, menu-bar template) to
the first directory and the path data the React <Brand/> component renders to
the JSON file. PNG/ICNS icons are rasterised from these SVGs (see README in
assets/brand).
"""
import json
import math
import os
import sys

OUT = sys.argv[1]
JSON_OUT = sys.argv[2]
os.makedirs(OUT, exist_ok=True)


def f(v):
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return "0" if s == "-0" else s


def rounded_triangle(pts, r):
    """Closed path for a polygon with circular-arc corners of radius r."""
    n = len(pts)
    out = []
    for i in range(n):
        p0, p1, p2 = pts[i - 1], pts[i], pts[(i + 1) % n]
        v1 = (p0[0] - p1[0], p0[1] - p1[1])
        v2 = (p2[0] - p1[0], p2[1] - p1[1])
        l1, l2 = math.hypot(*v1), math.hypot(*v2)
        u1, u2 = (v1[0] / l1, v1[1] / l1), (v2[0] / l2, v2[1] / l2)
        ang = math.acos(max(-1, min(1, u1[0] * u2[0] + u1[1] * u2[1])))
        d = r / math.tan(ang / 2)
        a = (p1[0] + u1[0] * d, p1[1] + u1[1] * d)
        b = (p1[0] + u2[0] * d, p1[1] + u2[1] * d)
        cross = v1[0] * v2[1] - v1[1] * v2[0]
        sweep = 1 if cross < 0 else 0
        out.append(("L" if out else "M") + f"{f(a[0])} {f(a[1])}")
        out.append(f"A{f(r)} {f(r)} 0 0 {sweep} {f(b[0])} {f(b[1])}")
    return "".join(out) + "Z"


# ── Glyph construction (font units, y down, baseline at y = BASE) ───────────
XH = 600          # x-height (diameter of the "a" bowl)
ASC = 860         # ascender height
BASE = ASC        # baseline y in SVG coordinates
S = 140           # stroke weight for k f l i x
A_STEM = 150      # stem weight of the "a"
R = XH / 2


def a_glyph(x0):
    """Single-storey a: bowl ∪ stem, with a rounded play-triangle counter."""
    cx, cy = x0 + R, BASE - R
    sx = cx + R - A_STEM                     # stem left edge
    dy = math.sqrt(R * R - (sx - cx) ** 2)   # where the stem meets the bowl
    outer = (
        f"M{f(sx)} {f(cy - R)}H{f(cx + R)}V{f(cy + R)}H{f(sx)}V{f(cy + dy)}"
        f"A{f(R)} {f(R)} 0 1 1 {f(sx)} {f(cy - dy)}Z"
    )
    th, tw = 330, 286                         # counter height / width
    tx = cx - 94
    # Counter-clockwise so the nonzero fill rule cuts it out of the clockwise bowl.
    tri = [(tx, cy - th / 2), (tx, cy + th / 2), (tx + tw, cy)]
    hole = rounded_triangle(tri, 34)
    return outer + hole, x0 + XH


def rect(x, y, w, h):
    return f"M{f(x)} {f(y)}h{f(w)}v{f(h)}h{f(-w)}Z"


def signed_area(pts):
    return sum(pts[i - 1][0] * pts[i][1] - pts[i][0] * pts[i - 1][1] for i in range(len(pts))) / 2


def poly(pts):
    """Clockwise (screen space) polygon so overlapping strokes union under nonzero fill."""
    if signed_area(pts) < 0:
        pts = list(reversed(pts))
    return "M" + "L".join(f"{f(x)} {f(y)}" for x, y in pts) + "Z"


def k_glyph(x0):
    t = 1.43                                  # tan of the diagonal angle (≈55°)
    stem_r = x0 + S
    band = S / math.cos(math.atan(t))         # vertical band width at the stem
    y = lambda h: BASE - h                    # height above baseline → svg y
    arm_lo = 230
    arm = [
        (stem_r - 1, y(arm_lo)), (stem_r - 1, y(arm_lo + band)),
        (stem_r + (XH - arm_lo - band) / t, y(XH)), (stem_r + (XH - arm_lo) / t, y(XH)),
    ]
    leg_lo = 140
    leg = [
        (stem_r - 1, y(leg_lo)), (stem_r - 1, y(leg_lo + band)),
        (stem_r + (leg_lo + band) / t, y(0)), (stem_r + leg_lo / t, y(0)),
    ]
    right = max(p[0] for p in arm + leg)
    return rect(x0, 0, S, ASC) + poly(arm) + poly(leg), right


def f_glyph(x0, bar_left):
    ro, ri = 250, 250 - S
    cx, cy = x0 + ro, ro                      # hook centre (svg coords)
    stem = f"M{f(x0)} {f(BASE)}V{f(cy)}A{f(ro)} {f(ro)} 0 0 1 {f(cx)} 0H{f(cx + 70)}V{f(S)}H{f(cx)}A{f(ri)} {f(ri)} 0 0 0 {f(x0 + S)} {f(cy)}V{f(BASE)}Z"
    bar_h = 124
    bar = rect(bar_left, BASE - XH, (x0 + S + 128) - bar_left, bar_h)
    return stem + bar, max(cx + 70, x0 + S + 128)


def l_glyph(x0):
    return rect(x0, 0, S, ASC), x0 + S


def i_glyph(x0):
    r = 84
    dot = (
        f"M{f(x0 + S / 2 - r)} {f(BASE - XH - 76 - r)}"
        f"a{f(r)} {f(r)} 0 1 0 {f(2 * r)} 0a{f(r)} {f(r)} 0 1 0 {f(-2 * r)} 0Z"
    )
    return rect(x0, BASE - XH, S, XH) + dot, x0 + S


def x_glyph(x0):
    width = 410
    w = 152                                   # horizontal band width
    top, bot = BASE - XH, BASE
    b1 = [(x0, bot), (x0 + w, bot), (x0 + width, top), (x0 + width - w, top)]
    b2 = [(x0 + width - w, bot), (x0 + width, bot), (x0 + w, top), (x0, top)]
    return poly(b1) + poly(b2), x0 + width


def wordmark():
    gap = 66
    parts = []
    p, x = a_glyph(0); parts.append(p)
    p, x = k_glyph(x + gap); parts.append(p)
    k_right = x
    f_x = k_right + gap + 54
    p, x = f_glyph(f_x, k_right + gap - 6); parts.append(p)
    p, x = l_glyph(x + gap); parts.append(p)
    p, x = i_glyph(x + gap); parts.append(p)
    p, x = x_glyph(x + gap - 8); parts.append(p)
    return "".join(parts), x


mark_path, _ = a_glyph(0)
mark_box = (0, BASE - XH, XH, XH)            # tight viewBox of the mark
word_path, word_w = wordmark()
word_box = (0, 0, word_w, ASC)

# ── Files ───────────────────────────────────────────────────────────────────
HEADER = "<!-- Akflix brand. Generated by scripts/brand/brand_geometry.py; do not edit by hand. -->\n"


def svg(view, body, w=None, h=None):
    size = f' width="{w}" height="{h}"' if w else ""
    return (HEADER + f'<svg xmlns="http://www.w3.org/2000/svg"{size} viewBox="{" ".join(f(v) for v in view)}">'
            + body + "</svg>\n")


def write(name, text):
    with open(os.path.join(OUT, name), "w") as fh:
        fh.write(text)


write("akflix-mark.svg", svg(mark_box, f'<path fill="#ffffff" d="{mark_path}"/>'))
write("akflix-mark-black.svg", svg(mark_box, f'<path fill="#000000" d="{mark_path}"/>'))
write("akflix-wordmark.svg", svg(word_box, f'<path fill="#ffffff" d="{word_path}"/>'))
write("akflix-wordmark-black.svg", svg(word_box, f'<path fill="#000000" d="{word_path}"/>'))


def icon(kind):
    """1024 app icons. macOS: squircle on transparent canvas (Apple grid 824/100).
    iOS: full-bleed opaque square (the system applies the mask)."""
    if kind == "macos":
        inset, size, radius, scale = 100, 824, 185, 0.70
    else:
        inset, size, radius, scale = 0, 1024, 0, 0.82
    glyph = XH * scale                       # rendered glyph size
    gx = inset + (size - glyph) / 2 - glyph * 0.025   # optical centring (stem mass)
    gy = inset + (size - glyph) / 2
    tx = f"translate({f(gx)} {f(gy)}) scale({f(scale)}) translate(0 {f(-(BASE - XH))})"
    shape = (f'<rect x="{inset}" y="{inset}" width="{size}" height="{size}" rx="{radius}" fill="url(#bg)"/>'
             if radius else f'<rect width="1024" height="1024" fill="url(#bg)"/>')
    rim = (f'<rect x="{inset + 3}" y="{inset + 3}" width="{size - 6}" height="{size - 6}" rx="{radius - 3}" '
           f'fill="none" stroke="#ffffff" stroke-opacity="0.14" stroke-width="6"/>') if radius else ""
    defs = (
        '<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1" gradientUnits="objectBoundingBox">'
        '<stop offset="0" stop-color="#1c1c1c"/><stop offset="0.55" stop-color="#080808"/>'
        '<stop offset="1" stop-color="#000000"/></linearGradient></defs>'
    )
    body = defs + shape + rim + f'<path fill="#ffffff" transform="{tx}" d="{mark_path}"/>'
    return svg((0, 0, 1024, 1024), body, 1024, 1024)


write("akflix-icon-macos.svg", icon("macos"))
write("akflix-icon-ios.svg", icon("ios"))
# Menu-bar template image: glyph only, black on transparent (macOS tints it).
tray_scale = 0.84
tray_tx = f"translate({f((1024 - XH * tray_scale) / 2)} {f((1024 - XH * tray_scale) / 2)}) scale({f(tray_scale)}) translate(0 {f(-(BASE - XH))})"
write("akflix-tray-template.svg", svg((0, 0, 1024, 1024),
      f'<path fill="#000000" transform="{tray_tx}" d="{mark_path}"/>', 1024, 1024))

with open(JSON_OUT, "w") as fh:
    json.dump({
        "mark": {"viewBox": " ".join(f(v) for v in mark_box), "path": mark_path},
        "wordmark": {"viewBox": " ".join(f(v) for v in word_box), "path": word_path},
    }, fh, indent=2)
    fh.write("\n")
print("wordmark width", f(word_w), "aspect", round(word_w / ASC, 3))
