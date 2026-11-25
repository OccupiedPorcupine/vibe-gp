// Collision checks: the car-box geometry and scripted crashes on the real physics.
//
//   node scripts/collision-check.mjs
//
// 1. boxSegment: a box against a wall segment, on hand-worked cases.
// 2. TrackPath.wallContactBox on a real wall, including a box whose centre went through.
// 3. Wall scenarios (#17) on the Test Oval: the car is launched at a wall with the pedals
//    off and stepped on CarPhysics. After every step, each of the car's boxes is measured
//    against the walls (the wall is WALL_THICKNESS thick): "pen" is the deepest any box
//    ends up inside a wall. Each scenario lists what the old 1.4 m centre circle did
//    (BASELINE) next to what the physics does now.
//
// Exits 1 if any check fails.
globalThis.location ??= { search: '' };
globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {} });
globalThis.Path2D ??= class { constructor() {} addPath() {} moveTo() {} lineTo() {} bezierCurveTo() {} quadraticCurveTo() {} arc() {} ellipse() {} rect() {} closePath() {} };
const { TRACKS } = await import('../src/tracks/index.js');
const { TrackPath, boxSegment, WALL_THICKNESS } = await import('../src/trackPath.js');
const { CarPhysics } = await import('../src/physics.js');
const { CAR_DIMS } = await import('../src/car.js');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
};
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

// ---------------------------------------------------------------------------------------
// The car's boxes in world space. carShape.js (#15) provides carBoxes(); until it lands,
// a local copy of the box table from #15 stands in for it.
const D = CAR_DIMS;
const LOCAL_BOXES = [
  { name: 'body', kind: 'solid', x0: -2.5, x1: 1.2, y0: -0.85, y1: 0.85, h0: 0, h1: 0.95 },
  { name: 'nose', kind: 'solid', x0: 1.2, x1: 2.3, y0: -0.2, y1: 0.2, h0: 0.1, h1: 0.6 },
  { name: 'front wing L', kind: 'fragile', x0: 2.3, x1: 2.98, y0: 0.35, y1: 0.98, h0: 0.05, h1: 0.3 },
  { name: 'front wing R', kind: 'fragile', x0: 2.3, x1: 2.98, y0: -0.98, y1: -0.35, h0: 0.05, h1: 0.3 },
  { name: 'rear wing', kind: 'fragile', x0: -2.74, x1: -2.45, y0: -0.51, y1: 0.51, h0: 0.6, h1: 0.95 },
  ...[
    ['wheel FL', D.frontAxle, 1, D.frontRadius, D.frontWidth],
    ['wheel FR', D.frontAxle, -1, D.frontRadius, D.frontWidth],
    ['wheel RL', D.rearAxle, 1, D.rearRadius, D.rearWidth],
    ['wheel RR', D.rearAxle, -1, D.rearRadius, D.rearWidth],
  ].map(([name, x, side, r, w]) => ({
    name, kind: 'wheel', x0: x - r, x1: x + r, y0: side * D.track - w / 2, y1: side * D.track + w / 2, h0: 0, h1: 2 * r,
  })),
];
const shape = await import('../src/carShape.js').catch(() => null);
const carBoxes = shape?.carBoxes ?? ((car) => {
  const fx = Math.sin(car.yaw), fz = Math.cos(car.yaw), lx = fz, lz = -fx;
  return LOCAL_BOXES.map((def) => {
    const mx = (def.x0 + def.x1) / 2, my = (def.y0 + def.y1) / 2;
    return {
      cx: car.position.x + fx * mx + lx * my, cz: car.position.z + fz * mx + lz * my,
      fx, fz, hx: (def.x1 - def.x0) / 2, hy: (def.y1 - def.y0) / 2,
      h0: (car.height ?? 0) + def.h0, h1: (car.height ?? 0) + def.h1, def,
    };
  });
});
const box = (cx, cz, yaw, hx, hy) => ({ cx, cz, fx: Math.sin(yaw), fz: Math.cos(yaw), hx, hy });

// ---------------------------------------------------------------------------------------
console.log('boxSegment (wall along x from (-10, 0) to (10, 0); its left is +z)');
{
  const r = 0.3;
  const seg = (b, side = 0, a = [-10, 0, 10, 0]) => boxSegment(b, ...a, r, side);
  const same = (c, depth, nx, nz) => c && near(c.depth, depth) && near(c.nx, nx) && near(c.nz, nz);
  const show = (c) => (c ? `depth ${c.depth.toFixed(4)} n (${c.nx.toFixed(3)}, ${c.nz.toFixed(3)})` : 'null');
  let c;
  check(seg(box(0, 3, 0, 1, 0.5)) === null, 'apart: null');
  c = seg(box(0, 1.2, 0, 1, 0.5));
  check(same(c, 0.1, 0, -1), 'inside the wall thickness only: depth = r − gap', show(c));
  c = seg(box(0, 0.5, 0, 1, 0.5));
  check(same(c, 0.8, 0, -1), 'end face through the line: out to its own side', show(c));
  c = seg(box(0, 0.9, Math.PI / 4, 1, 0.5));
  check(same(c, 0.3 + 1.5 * Math.SQRT1_2 - 0.9, 0, -1), 'rotated 45°, corner first', show(c));
  c = seg(box(4, 0.4, Math.PI / 2, 1, 0.5));
  check(same(c, 0.4, 0, -1), 'side on, sliding along it', show(c));
  c = seg(box(0.9, 0, -Math.PI / 2, 1, 0.5), 0, [-10, 0, 0, 0]);
  check(same(c, 0.4, -1, 0), 'nose into the end of a thin wall, on its line: pushed back', show(c));
  c = seg(box(0.6, 0.6, 0, 0.5, 0.5), 0, [-10, 0, 0, 0]);
  check(same(c, 0.3 - Math.hypot(0.1, 0.1), -Math.SQRT1_2, -Math.SQRT1_2), 'corner by the rounded end', show(c));
  c = seg(box(0, -1.5, 0, 1, 0.5), 1);
  check(same(c, 0.3 + 1 + 1.5, 0, -1), 'centre went through (side +1): back across', show(c));
  check(seg(box(0, -1.5, 0, 1, 0.5)) === null, 'same box, no side given: apart on the far side');
  c = seg(box(0, 0.1, 0, 1, 0.5), 0, [-0.2, 0, 0.2, 0]);
  check(c && near(c.depth, 1) && near(Math.abs(c.nx), 1), 'short wall wholly inside the box', show(c));
  c = seg(box(0, 1.2, 0, 1, 0.5), 0, [10, 0, -10, 0]);
  check(same(c, 0.1, 0, -1), 'segment direction does not matter', show(c));
  const cp = seg(box(0, 0.5, 0, 1, 0.5));
  check(cp && near(cp.pz, 0) && Math.abs(cp.px) <= 0.5 + 1e-9, 'contact point on the wall, under the box', `(${cp?.px.toFixed(3)}, ${cp?.pz.toFixed(3)})`);
}

// ---------------------------------------------------------------------------------------
const def = TRACKS.find((t) => t.id === 'oval');
const P = new TrackPath(def);
// a stretch of the outer wall far from the pit lane: W on the wall line, t along it and
// n pointing from the wall towards the track
const outer = P.walls.find((l) => l.kind === 'main' && l.closed);
const probe = P.poseAt(P.length / 2);
let k = 0;
outer.pts.forEach((p, i) => {
  if (Math.hypot(p[0] - probe.x, p[1] - probe.z) < Math.hypot(outer.pts[k][0] - probe.x, outer.pts[k][1] - probe.z)) k = i;
});
const W = outer.pts[k], m = outer.pts.length;
const unit = (x, z) => {
  const l = Math.hypot(x, z);
  return [x / l, z / l];
};
const t = unit(outer.pts[(k + 2) % m][0] - outer.pts[(k + m - 2) % m][0], outer.pts[(k + 2) % m][1] - outer.pts[(k + m - 2) % m][1]);
let n = [-t[1], t[0]];
if (n[0] * (probe.x - W[0]) + n[1] * (probe.z - W[1]) < 0) n = [-n[0], -n[1]];
const yawOf = (x, z) => Math.atan2(x, z);

console.log('TrackPath.wallContactBox (Test Oval, outer wall)');
{
  // facing the wall, its front end 0.25 m into the wall's face
  const cx = W[0] + n[0] * (WALL_THICKNESS / 2 + 1 - 0.25), cz = W[1] + n[1] * (WALL_THICKNESS / 2 + 1 - 0.25);
  const b = box(cx, cz, yawOf(-n[0], -n[1]), 1, 0.5);
  let c = P.wallContactBox(b, cx, cz, 0);
  check(c && near(c.depth, 0.25, 0.01) && c.nx * -n[0] + c.nz * -n[1] > 0.999, 'nose 0.25 m into the face', c ? `depth ${c.depth.toFixed(3)}` : 'null');
  // the centre went 2 m beyond the wall's line during the step, from 3 m in front of it
  const b2 = box(W[0] - n[0] * 2, W[1] - n[1] * 2, yawOf(-n[0], -n[1]), 1, 0.5);
  c = P.wallContactBox(b2, W[0] + n[0] * 3, W[1] + n[1] * 3, 0);
  check(c && near(c.depth, 3.3, 0.02) && c.nx * -n[0] + c.nz * -n[1] > 0.999, 'went through in one step: back to the track side', c ? `depth ${c.depth.toFixed(3)}` : 'null');
  c = P.wallContactBox(b2, b2.cx, b2.cz, 0);
  check(c === null, 'same box already beyond the wall, no sweep: no contact');
  c = P.wallContactBox(b, cx, cz, 50);
  check(c === null, 'a wall on another level (bridge) is ignored');
}

// ---------------------------------------------------------------------------------------
// Wall scenarios. BASELINE: what the 1.4 m centre circle (collideWalls before #17) did.
// (Recorded on fork/main at 04e1219. The 0.6 m pit wall fits between the front wing
// halves, 0.7 m apart, so head-on at its end only the nose reaches it.)
const BASELINE = {
  head30: { pen: 1.23, part: 'front wing L' },
  swipe: { pen: 0.55, part: 'front wing L' },
  reverse: { pen: 1.64, part: 'rear wing' },
  nose: { pen: 0.5, part: 'nose' },
  noseOff: { pen: 0.58, part: 'front wing L' },
};
const PEN_TOL = 0.05; // m a box may end a step inside a wall
const dt = 1 / 120;

/**
 * Deepest overlap of any of the car's boxes with any wall, and which box. Swept from the
 * car's centre, so a box whose centre is past a wall's line (a part through the wall)
 * counts in full, not as a shallow overlap from the far side.
 */
function penetration(car) {
  let pen = 0, part = '';
  for (const b of carBoxes(car)) {
    const c = P.wallContactBox(b, car.position.x, car.position.z, car.height);
    if (c && c.depth > pen) [pen, part] = [c.depth, b.def.name];
  }
  return { pen, part };
}

/** Did the move (x0, z0) → (x1, z1) cross a wall segment? */
function crossesWall(x0, z0, x1, z1) {
  const S = P.seg;
  const o = (ax, az, bx, bz, px, pz) => (bx - ax) * (pz - az) - (bz - az) * (px - ax);
  for (let s = 0; s < S.n; s++) {
    if (o(S.ax[s], S.az[s], S.bx[s], S.bz[s], x0, z0) * o(S.ax[s], S.az[s], S.bx[s], S.bz[s], x1, z1) < 0 &&
      o(x0, z0, x1, z1, S.ax[s], S.az[s]) * o(x0, z0, x1, z1, S.bx[s], S.bz[s]) < 0) return true;
  }
  return false;
}

/** Launch a car at (x, z) facing (hx, hz) at `speed` (negative = reversing) and coast it. */
function run({ x, z, hx, hz, speed, time = 2 }) {
  const car = new CarPhysics(P, { x, z, yaw: yawOf(hx, hz), y: 0 });
  car.vel.x = hx * speed;
  car.vel.z = hz * speed;
  car.speed = speed;
  for (const w of car.wheels) w.omega = speed / w.r;
  let worst = { pen: 0, part: '' }, through = false;
  for (let i = 0; i < time / dt; i++) {
    const px = car.position.x, pz = car.position.z;
    car.step({ throttle: 0, brake: 0, steer: 0 }, dt);
    if (crossesWall(px, pz, car.position.x, car.position.z)) through = true;
    const p = penetration(car);
    if (p.pen > worst.pen) worst = p;
  }
  return { car, ...worst, through };
}

// the pit wall's nose at the pit entry: the open main-wall end nearest the lane's start,
// facing the cars that go straight on past the entry
const ends = P.walls.filter((l) => l.kind === 'main' && !l.closed).map((l) => ({ p: l.pts[0], q: l.pts[3] }));
const lane0 = [P.pit.px[0], P.pit.pz[0]];
const nose = ends.reduce((a, b) => (Math.hypot(b.p[0] - lane0[0], b.p[1] - lane0[1]) < Math.hypot(a.p[0] - lane0[0], a.p[1] - lane0[1]) ? b : a));
const d = unit(nose.q[0] - nose.p[0], nose.q[1] - nose.p[1]);

const fromWall = (perp, along, hx, hz) => ({
  x: W[0] + n[0] * perp + t[0] * along, z: W[1] + n[1] * perp + t[1] * along, hx, hz,
});
const into30 = [t[0] * Math.cos(Math.PI / 6) - n[0] * Math.sin(Math.PI / 6), t[1] * Math.cos(Math.PI / 6) - n[1] * Math.sin(Math.PI / 6)];
const SCENARIOS = [
  {
    id: 'head30', label: 'head-on at 30° to the wall, 30 m/s',
    ...fromWall(6, -6 / Math.tan(Math.PI / 6), ...into30), speed: 30,
  },
  {
    id: 'swipe', label: 'side swipe, parallel at 50 m/s',
    ...fromWall(WALL_THICKNESS / 2 + 1 + 0.5, -20, ...t), speed: 50,
  },
  {
    id: 'reverse', label: 'reversing into the wall, 6 m/s',
    ...fromWall(WALL_THICKNESS / 2 + 2.74 + 2, 0, ...n), speed: -6,
  },
  {
    id: 'nose', label: 'pit-wall end, head-on along its line, 20 m/s',
    x: nose.p[0] - d[0] * 9, z: nose.p[1] - d[1] * 9, hx: d[0], hz: d[1], speed: 20,
  },
  {
    id: 'noseOff', label: 'pit-wall end, 0.7 m off its line (wing tip), 20 m/s',
    x: nose.p[0] - d[0] * 9 - d[1] * 0.7, z: nose.p[1] - d[1] * 9 + d[0] * 0.7, hx: d[0], hz: d[1], speed: 20,
  },
];

console.log(`wall scenarios (Test Oval; pen = deepest any box ends a step inside a wall, target ≤ ${PEN_TOL} m)`);
const fmt = (pen, part) => (pen === null ? '   n/a' : `${pen.toFixed(2).padStart(5)} m${part ? ` ${part}` : ''}`);
for (const s of SCENARIOS) {
  const res = run(s);
  const base = BASELINE[s.id];
  const hit = res.car.impact > 0;
  const ok = res.pen <= PEN_TOL && !res.through && hit;
  check(ok, s.label.padEnd(52),
    `circle ${fmt(base.pen, base.part)} | now pen ${fmt(res.pen, res.part)}${res.through ? ', WENT THROUGH' : ''}${hit ? `, hit ${res.car.impact.toFixed(1)} m/s` : ', NO HIT'}`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks pass');
process.exit(failures ? 1 : 0);
