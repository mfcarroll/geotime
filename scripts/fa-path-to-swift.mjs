#!/usr/bin/env node
// Turns a Font Awesome solid icon into a SwiftUI Shape, the way ShipShape in
// GeoTimeWidget.swift was made by hand.
//
//   node scripts/fa-path-to-swift.mjs faAnchor AnchorShape
//
// Why generated rather than traced: the anchor's outline uses SVG elliptical
// ARCS, which SwiftUI's Path has no direct equivalent for — its addArc is
// circular and centre-parameterised, where SVG's is endpoint-parameterised with
// radii, rotation and two flags. Converting by eye invites a glyph that is
// subtly wrong in a way nobody notices until it is on a home screen. This does
// the standard endpoint->centre conversion and splits each arc into <=90 degree
// cubic Beziers, which is exact enough to be indistinguishable.

import * as icons from '@fortawesome/free-solid-svg-icons';

const [, , iconName, shapeName] = process.argv;
const icon = icons[iconName];
if (!icon) throw new Error(`no such icon: ${iconName}`);
const [vbW, vbH, , , d] = icon.icon;

// ---- parse ----
const tokens = d.match(/[A-Za-z]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
let i = 0;
const num = () => Number(tokens[i++]);
let cx = 0, cy = 0, startX = 0, startY = 0, cmd = '';
let lastCtrlX = null, lastCtrlY = null;
const out = [];   // {op, pts}

function arcToCubics(x1, y1, rx, ry, phiDeg, largeArc, sweep, x2, y2) {
  if (rx === 0 || ry === 0) return [{ op: 'line', pts: [x2, y2] }];
  const phi = (phiDeg * Math.PI) / 180;
  const cosP = Math.cos(phi), sinP = Math.sin(phi);
  const dx2 = (x1 - x2) / 2, dy2 = (y1 - y2) / 2;
  const x1p = cosP * dx2 + sinP * dy2;
  const y1p = -sinP * dx2 + cosP * dy2;
  rx = Math.abs(rx); ry = Math.abs(ry);
  // Scale the radii up if they are too small to span the endpoints (F.6.6).
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }
  const sign = largeArc === sweep ? -1 : 1;
  let num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = sign * Math.sqrt(Math.max(0, num / den));
  const cxp = (co * rx * y1p) / ry;
  const cyp = (-co * ry * x1p) / rx;
  const ccx = cosP * cxp - sinP * cyp + (x1 + x2) / 2;
  const ccy = sinP * cxp + cosP * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const theta1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dTheta = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
  if (sweep && dTheta < 0) dTheta += 2 * Math.PI;

  const segs = Math.ceil(Math.abs(dTheta) / (Math.PI / 2));
  const delta = dTheta / segs;
  const t = (4 / 3) * Math.tan(delta / 4);
  const res = [];
  let th = theta1;
  for (let s = 0; s < segs; s++) {
    const th2 = th + delta;
    const p = (a) => [
      cosP * rx * Math.cos(a) - sinP * ry * Math.sin(a) + ccx,
      sinP * rx * Math.cos(a) + cosP * ry * Math.sin(a) + ccy,
    ];
    const dp = (a) => [
      -cosP * rx * Math.sin(a) - sinP * ry * Math.cos(a),
      -sinP * rx * Math.sin(a) + cosP * ry * Math.cos(a),
    ];
    const [px1, py1] = p(th), [px2, py2] = p(th2);
    const [dx1, dy1] = dp(th), [dxx2, dyy2] = dp(th2);
    res.push({ op: 'curve', pts: [px2, py2, px1 + t * dx1, py1 + t * dy1, px2 - t * dxx2, py2 - t * dyy2] });
    th = th2;
  }
  return res;
}

while (i < tokens.length) {
  if (/[A-Za-z]/.test(tokens[i])) cmd = tokens[i++];
  const rel = cmd === cmd.toLowerCase();
  const C = cmd.toUpperCase();
  const ax = (v) => (rel ? cx + v : v);
  const ay = (v) => (rel ? cy + v : v);

  if (C === 'M') {
    const x = ax(num()), y = ay(num());
    out.push({ op: 'move', pts: [x, y] });
    cx = startX = x; cy = startY = y; lastCtrlX = lastCtrlY = null;
    cmd = rel ? 'l' : 'L';
  } else if (C === 'L') {
    const x = ax(num()), y = ay(num());
    out.push({ op: 'line', pts: [x, y] }); cx = x; cy = y; lastCtrlX = lastCtrlY = null;
  } else if (C === 'H') {
    const x = ax(num()); out.push({ op: 'line', pts: [x, cy] }); cx = x; lastCtrlX = lastCtrlY = null;
  } else if (C === 'V') {
    const y = ay(num()); out.push({ op: 'line', pts: [cx, y] }); cy = y; lastCtrlX = lastCtrlY = null;
  } else if (C === 'C' || C === 'S') {
    let c1x, c1y;
    if (C === 'C') { c1x = ax(num()); c1y = ay(num()); }
    else { c1x = lastCtrlX === null ? cx : 2 * cx - lastCtrlX; c1y = lastCtrlY === null ? cy : 2 * cy - lastCtrlY; }
    const c2x = ax(num()), c2y = ay(num());
    const x = ax(num()), y = ay(num());
    out.push({ op: 'curve', pts: [x, y, c1x, c1y, c2x, c2y] });
    lastCtrlX = c2x; lastCtrlY = c2y; cx = x; cy = y;
  } else if (C === 'A') {
    const rx = num(), ry = num(), rot = num(), la = num(), sw = num();
    const x = ax(num()), y = ay(num());
    out.push(...arcToCubics(cx, cy, rx, ry, rot, la, sw, x, y));
    cx = x; cy = y; lastCtrlX = lastCtrlY = null;
  } else if (C === 'Z') {
    out.push({ op: 'close' }); cx = startX; cy = startY; lastCtrlX = lastCtrlY = null;
  } else {
    throw new Error(`unhandled path command: ${cmd}`);
  }
}

// ---- emit ----
const f = (n) => (Math.round(n * 100) / 100).toString();
const lines = out.map((s) => {
  if (s.op === 'move') return `        p.move(to: P(${f(s.pts[0])}, ${f(s.pts[1])}))`;
  if (s.op === 'line') return `        p.addLine(to: P(${f(s.pts[0])}, ${f(s.pts[1])}))`;
  if (s.op === 'close') return `        p.closeSubpath()`;
  const [x, y, c1x, c1y, c2x, c2y] = s.pts;
  return `        p.addCurve(to: P(${f(x)}, ${f(y)}), control1: P(${f(c1x)}, ${f(c1y)}), control2: P(${f(c2x)}, ${f(c2y)}))`;
});

console.log(`// Generated by scripts/fa-path-to-swift.mjs from Font Awesome '${icon.iconName}'.
// The same glyph the web app draws, so the two surfaces agree. Regenerate rather
// than editing by hand; SVG arcs are converted to cubics, which is not something
// to redo by eye.
struct ${shapeName}: Shape {
    func path(in rect: CGRect) -> Path {
        // Fit the glyph's box into the frame without distorting it, and centre
        // what is left over.
        let s = min(rect.width / ${vbW}, rect.height / ${vbH})
        let ox = rect.minX + (rect.width - ${vbW} * s) / 2
        let oy = rect.minY + (rect.height - ${vbH} * s) / 2
        func P(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: ox + x * s, y: oy + y * s)
        }

        var p = Path()
${lines.join('\n')}
        return p
    }
}`);
