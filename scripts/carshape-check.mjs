// Checks of the car collision boxes (src/carShape.js): the box table, the world transform
// and its cache, and the box-against-box overlap test.
//
//   node scripts/carshape-check.mjs
//
// Exits non-zero if any check fails.
// carShape.js reads the wheel layout from car.js, which pulls in logos.js: it builds Path2D
// objects at import time (browser only), so stub it for Node
globalThis.location ??= { search: '' };
globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {} });
globalThis.Path2D ??= class { constructor() {} addPath() {} moveTo() {} lineTo() {} bezierCurveTo() {} quadraticCurveTo() {} arc() {} ellipse() {} rect() {} closePath() {} };
const { BOXES, carBoxes, boxOverlap, boxCorners } = await import('../src/carShape.js');

let failed = 0, passed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else {
    failed++;
    console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const fmt = (r) => (r ? `depth ${r.depth.toFixed(4)} n (${r.nx.toFixed(3)}, ${r.nz.toFixed(3)}) p (${r.px.toFixed(3)}, ${r.pz.toFixed(3)})` : 'null');

/** A world box by hand: centre, heading (yaw, rad), half length / width, heights. */
function box(cx, cz, yaw, hx, hy, h0 = 0, h1 = 1) {
  return { cx, cz, fx: Math.sin(yaw), fz: Math.cos(yaw), hx, hy, h0, h1, def: null };
}
/** Check a and b both ways round: same depth and contact point, opposite normal. */
function overlap(name, a, b, want) {
  const r = boxOverlap(a, b), q = boxOverlap(b, a);
  if (want === null) {
    check(name, r === null && q === null, `${fmt(r)} / ${fmt(q)}`);
    return;
  }
  const ok = r && q
    && near(r.depth, want.depth, 1e-6) && near(r.nx, want.nx, 1e-6) && near(r.nz, want.nz, 1e-6)
    && (want.px === undefined || (near(r.px, want.px, 1e-6) && near(r.pz, want.pz, 1e-6)))
    && near(q.depth, r.depth) && near(q.nx, -r.nx) && near(q.nz, -r.nz) && near(q.px, r.px) && near(q.pz, r.pz);
  check(name, ok, `${fmt(r)} / reversed ${fmt(q)}; want ${JSON.stringify(want)}`);
}

// --- the box table
check('9 boxes', BOXES.length === 9, `${BOXES.length}`);
for (const d of BOXES) {
  check(`${d.name}: extents in order`, d.x0 < d.x1 && d.y0 < d.y1 && d.h0 < d.h1 && d.h0 >= 0, JSON.stringify(d));
  check(`${d.name}: kind`, ['solid', 'fragile', 'wheel'].includes(d.kind), d.kind);
}
const by = Object.fromEntries(BOXES.map((d) => [d.name, d]));
check('body ends where the nose starts', by.body.x1 === by.nose.x0);
check('front wing halves mirror each other', by.wingL.y0 === -by.wingR.y1 && by.wingL.y1 === -by.wingR.y0 && by.wingL.x0 === by.wingR.x0);
check('rear wing is above the front wing', by.rearWing.h0 > by.wingL.h1);
check('the nose fits under the rear wing', by.nose.h1 < by.rearWing.h0 && by.nose.h1 > by.body.h0);
check('wheels in FL FR RL RR order', ['FL', 'FR', 'RL', 'RR'].every((c, i) => by[`wheel${c}`].i === i && by[`wheel${c}`].part === 'tyre'));
check('left wheels are on the left', by.wheelFL.y0 > 0 && by.wheelRL.y0 > 0 && by.wheelFR.y1 < 0 && by.wheelRR.y1 < 0);

// --- world transform
{
  // car heading +X (yaw = π/2): forward is +X, left is (cos, −sin) = −Z
  const car = { position: { x: 10, z: 20 }, yaw: Math.PI / 2, height: 5 };
  const boxes = carBoxes(car);
  check('one world box per BOXES entry', boxes.length === BOXES.length && boxes.every((b, k) => b.def === BOXES[k]));
  const fl = boxes.find((b) => b.def.name === 'wheelFL'), d = fl.def;
  const mx = (d.x0 + d.x1) / 2, my = (d.y0 + d.y1) / 2;
  check('front-left wheel centre in world', near(fl.cx, 10 + mx) && near(fl.cz, 20 - my), `${fl.cx}, ${fl.cz}`);
  check('axes', near(fl.fx, 1) && near(fl.fz, 0));
  check('half sizes', near(fl.hx, (d.x1 - d.x0) / 2) && near(fl.hy, (d.y1 - d.y0) / 2));
  check('heights include the road', near(fl.h0, 5 + d.h0) && near(fl.h1, 5 + d.h1));
  // corners: front left is the forward-most, left-most
  const c = boxCorners(fl);
  check('front-left corner', near(c[0], 10 + d.x1) && near(c[1], 20 - d.y1), `${c[0]}, ${c[1]}`);
  // cache: the same objects back until the car moves, then updated in place
  check('cached while the car stands still', carBoxes(car) === boxes && boxes[0].cx === carBoxes(car)[0].cx);
  const before = boxes[0].cx;
  car.position.x += 1;
  check('worked out again once the car moves', carBoxes(car) === boxes && near(boxes[0].cx, before + 1));
  car.yaw = 0;
  check('...or turns', near(carBoxes(car)[0].fz, 1));
  // with out: a separate array, the cache untouched
  const out = carBoxes({ position: { x: 0, z: 0 }, yaw: 0 }, []);
  check('fills out', out.length === BOXES.length && out !== boxes && near(out[0].h0, BOXES[0].h0));
}

// --- overlap: two unit-ish boxes along z
const A = box(0, 0, 0, 2, 1); // 4 long (z), 2 wide (x)
overlap('apart', A, box(0, 5, 0, 2, 1), null);
overlap('touching end to end', A, box(0, 4, 0, 2, 1), null);
overlap('touching side by side', A, box(2, 0, 0, 2, 1), null);
// a box 3.5 ahead: 0.5 deep along forward; overlap area z 1.5..2, x −1..1
overlap('overlapping end to end', A, box(0, 3.5, 0, 2, 1), { depth: 0.5, nx: 0, nz: 1, px: 0, pz: 1.75 });
// 1.8 to the side (−X is right of a yaw-0 box... the normal just points from a to b)
overlap('overlapping side by side', A, box(-1.8, 0.5, 0, 2, 1), { depth: 0.2, nx: -1, nz: 0, px: -0.9, pz: 0.25 });
// small box inside a big one: the least-overlap axis is the short way out
overlap('one inside the other', box(0, 0, 0, 3, 2), box(0.5, 0, 0, 0.5, 0.5), { depth: 2, nx: 1, nz: 0, px: 0.5, pz: 0 });

// --- rotated 45°: a diamond's tip pushed into a box's side
{
  const r = Math.SQRT1_2; // the diamond's tip is √2 from its centre
  const D = (x) => box(x, 0, Math.PI / 4, 1, 1);
  const S = box(0, 0, 0, 2, 1); // side face at x = 1
  overlap('45°: corner short of a face', S, D(1 + Math.SQRT2 + 0.01), null);
  // tip 0.2 into the face: depth 0.2 along x; contact centre inside the little triangle
  overlap('45°: corner into a face', S, D(1 + Math.SQRT2 - 0.2), { depth: 0.2, nx: 1, nz: 0, px: 1 - 0.2 / 3, pz: 0 });
  // two diamonds corner to corner along x: the 45° axes are the shallow ones
  const Da = box(0, 0, Math.PI / 4, 1, 1), Db = box(2 * Math.SQRT2 - 0.1, 0, Math.PI / 4, 1, 1);
  const hit = boxOverlap(Da, Db);
  check('45°: corner to corner', hit && near(hit.depth, 0.1 * r, 1e-9) && near(Math.abs(hit.nx), r) && near(Math.abs(hit.nz), r) && hit.nx > 0, fmt(hit));
  // and the separating gap a plain circle or AABB test would miss: diamonds side by side
  // whose bounding squares overlap but faces don't
  overlap('45°: bounding boxes overlap, boxes don\'t', box(0, 0, Math.PI / 4, 1, 1), box(1.5, 1.5, Math.PI / 4, 1, 1), null);
}

// --- heights
{
  const nose = box(0, 0, 0, 0.5, 0.2, 0.1, 0.55);
  overlap('heights: nose under a rear wing', nose, box(0, 0.3, 0, 0.2, 0.5, 0.6, 1.12), null);
  overlap('heights: touching heights', nose, box(0, 0.3, 0, 0.2, 0.5, 0.55, 1), null);
  overlap('heights: nose into a gearbox', nose, box(0, 0.6, 0, 0.2, 0.5, 0, 0.95), { depth: 0.1, nx: 0, nz: 1 });
  // a car on a bridge over another: same plan position, 8 m up
  overlap('heights: on a bridge', box(0, 0, 0, 2, 1, 0, 1), box(0, 0, 1, 2, 1, 8, 9), null);
}

// --- whole cars
{
  const make = (x, z, yaw, height = 0) => ({ position: { x, z }, yaw, height });
  const hits = (A, B) => {
    const r = [];
    for (const a of carBoxes(A)) for (const b of carBoxes(B)) {
      const h = boxOverlap(a, b);
      if (h) r.push(`${a.def.name}>${b.def.name}`);
    }
    return r;
  };
  const pair = (name, A, B, test) => { const h = hits(A, B); check(name, test(h), h.join(' ') || 'no contact'); };
  // cars nose to tail, 5.6 m apart (CoG to CoG): just short of touching
  pair('in line, a car length apart: no contact', make(0, 0, 0), make(0, 6.0, 0), (h) => h.length === 0);
  // nose 0.27 m into the gearbox: it passes under the rear wing and hits the body
  pair('nose into a gearbox: under the rear wing', make(0, 0, 0), make(0, 5.2, 0), (h) => h.includes('nose>body') && !h.some((s) => s.startsWith('nose>rearWing')));
  // offset by a car width: the left endplate clips the other car's right rear tyre
  pair('endplate clips a rear tyre', make(0, 0, 0), make(1.75, 4.5, 0), (h) => h.includes('wingL>wheelRR') && !h.some((s) => s.startsWith('body') || s.startsWith('nose')));
  // side by side, 1.97 m apart: the rear wheels (the widest point) just touch, nothing else
  pair('side by side, wheel to wheel', make(0, 0, 0), make(1.97, 0, 0), (h) => h.length > 0 && h.every((s) => /wheel.*>wheel/.test(s)));
  // T-bone: B across A's path, A's nose in B's sidepod
  pair('T-bone', make(0, 0, 0), make(0, 3.5, Math.PI / 2), (h) => h.includes('nose>body'));
  pair('on a bridge', make(0, 0, 0, 0), make(0, 0, 1, 8), (h) => h.length === 0);
}

// --- speed: one full 9×9 part test
{
  const A = { position: { x: 0, z: 0 }, yaw: 0.1 }, B = { position: { x: 0.5, z: 3 }, yaw: 0.3 };
  const n = 20000, t0 = performance.now();
  let k = 0;
  for (let i = 0; i < n; i++) {
    A.position.x = (i % 7) * 0.01; // moves, so carBoxes works it out again
    for (const a of carBoxes(A)) for (const b of carBoxes(B)) if (boxOverlap(a, b)) k++;
  }
  const us = ((performance.now() - t0) * 1000) / n;
  console.log(`car pair, all 81 part tests: ${us.toFixed(2)} µs (${(k / n).toFixed(1)} overlapping)`);
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
