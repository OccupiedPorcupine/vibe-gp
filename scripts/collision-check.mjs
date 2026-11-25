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
// 4. Car-to-car scenarios (#16) on Suzuka's start straight: an endplate clipping a rear
//    tyre, a nose under a rear wing, a T-bone and a 2 s rub side by side. Each checks which
//    parts took damage and how the cars moved.
//
// Exits 1 if any check fails.
globalThis.location ??= { search: '' };
globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {} });
globalThis.Path2D ??= class { constructor() {} addPath() {} moveTo() {} lineTo() {} bezierCurveTo() {} quadraticCurveTo() {} arc() {} ellipse() {} rect() {} closePath() {} };
const { TRACKS } = await import('../src/tracks/index.js');
const { TrackPath, boxSegment, WALL_THICKNESS } = await import('../src/trackPath.js');
const { CarPhysics } = await import('../src/physics.js');
const { carBoxes, boxOverlap } = await import('../src/carShape.js');
const { collideCars, CONTACTS } = await import('../src/ai.js');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
};
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

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
  head30: { pen: 1.23, part: 'wingL' },
  swipe: { pen: 0.55, part: 'wingL' },
  reverse: { pen: 1.64, part: 'rearWing' },
  nose: { pen: 0.5, part: 'nose' },
  noseOff: { pen: 0.58, part: 'wingL' },
  spin: { pen: 1.99, part: 'wingR' },
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

/**
 * Launch a car at (x, z) facing (hx, hz) at `speed` (negative = reversing) and coast it.
 * slide: extra velocity [x, z] (a sideways slide); yawRate: spinning (rad/s, + = to the left).
 */
function run({ x, z, hx, hz, speed, slide = [0, 0], yawRate = 0, time = 2 }) {
  const car = new CarPhysics(P, { x, z, yaw: yawOf(hx, hz), y: 0 });
  car.vel.x = hx * speed + slide[0];
  car.vel.z = hz * speed + slide[1];
  car.speed = speed;
  car.yawRate = yawRate;
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
  {
    // the nose and wings sweep an arc: each box is swept from its own place a step ago
    id: 'spin', label: 'spinning at 6 rad/s, sliding into the wall at 12 m/s',
    ...fromWall(WALL_THICKNESS / 2 + 3 + 3, 0, ...t), speed: 20, slide: [-n[0] * 12, -n[1] * 12], yawRate: 6,
  },
];

console.log(`wall scenarios (Test Oval; pen = deepest any box ends a step inside a wall, target ≤ ${PEN_TOL} m)`);
const fmt = (pen, part) => (pen === null ? '   n/a' : `${pen.toFixed(2).padStart(5)} m${part ? ` ${part}` : ''}`);
for (const s of SCENARIOS) {
  const res = run(s);
  const base = BASELINE[s.id];
  const hit = res.car.impact > 0;
  const ok = res.pen <= PEN_TOL && !res.through && hit;
  check(ok, s.label.padEnd(54),
    `circle ${fmt(base.pen, base.part)} | now pen ${fmt(res.pen, res.part)}${res.through ? ', WENT THROUGH' : ''}${hit ? `, hit ${res.car.impact.toFixed(1)} m/s` : ', NO HIT'}`);
}

// ---------------------------------------------------------------------------------------
// Car-to-car scenarios (#16): two cars on Suzuka's start straight, stepped at 120 Hz with
// collideCars() after each step as in a race. Each checks which parts took damage and how
// the cars moved.
console.log('\ncar-to-car scenarios (Suzuka start straight)');
{
  const DT = 1 / 120;
  const SZ = new TrackPath(TRACKS.find((t) => t.id === 'suzuka'));
  const S0 = -120; // m: on the grid straight

  const expect = (label, ok, detail) => check(ok, label, detail);

  /** A car on the straight, s metres along and `lat` to the left, at `speed` (yaw offset `turn`). */
  function car(s, lat, speed, turn = 0) {
    const pose = SZ.poseAt(S0 + s, lat);
    const c = new CarPhysics(SZ, { ...pose, yaw: pose.yaw + turn });
    c.damageOn = true;
    const heading = pose.yaw; // moving along the track, whichever way the car points
    c.vel.x = Math.sin(heading) * speed;
    c.vel.z = Math.cos(heading) * speed;
    c.speed = speed * Math.cos(turn);
    for (const w of c.wheels) w.omega = c.speed / w.r;
    return c;
  }
  const track = SZ.poseAt(S0, 0);
  const F = { x: Math.sin(track.yaw), z: Math.cos(track.yaw) }, L = { x: Math.cos(track.yaw), z: -Math.sin(track.yaw) };
  const along = (c) => c.position.x * F.x + c.position.z * F.z;
  const across = (c) => c.position.x * L.x + c.position.z * L.z;
  const vAcross = (c) => c.vel.x * L.x + c.vel.z * L.z;
  const vAlong = (c) => c.vel.x * F.x + c.vel.z * F.z;

  /** Are any of the two cars' boxes overlapping? */
  function overlapping(A, B) {
    for (const a of carBoxes(A)) for (const b of carBoxes(B)) if (boxOverlap(a, b)) return true;
    return false;
  }

  /** Deepest overlap of solid parts between two cars (how far one has sunk into the other). */
  function sunk(A, B) {
    let d = 0;
    for (const a of carBoxes(A)) for (const b of carBoxes(B)) {
      if (a.def.kind === 'fragile' || b.def.kind === 'fragile') continue;
      const h = boxOverlap(a, b);
      if (h) d = Math.max(d, h.depth);
    }
    return d;
  }

  /** Step both cars `steps` times; `each(k)` after every step. Returns the contacts counted. */
  function run(A, B, steps, inA = {}, inB = {}, each) {
    const field = [{ physics: A }, { physics: B }];
    const t0 = CONTACTS.touches, h0 = CONTACTS.hard;
    for (let k = 0; k < steps; k++) {
      A.step(typeof inA === 'function' ? inA(k) : inA, DT);
      B.step(typeof inB === 'function' ? inB(k) : inB, DT);
      collideCars(field);
      each?.(k);
    }
    return { touches: CONTACTS.touches - t0, hard: CONTACTS.hard - h0 };
  }

  /** Every damaged part of a car, as "part[side] level". */
  function damaged(c) {
    const d = c.damage, out = [];
    for (const k of ['wing', 'rearWing', 'floor', 'sidepod', 'mirror', 'suspension', 'tyre', 'engine']) {
      const v = d[k];
      if (Array.isArray(v)) v.forEach((x, i) => x > 0 && out.push(`${k}[${i}] ${x.toFixed(2)}`));
      else if (v > 0) out.push(`${k} ${v.toFixed(2)}`);
    }
    return out.join(', ') || 'none';
  }
  const total = (c) => ['wing', 'rearWing', 'floor', 'sidepod', 'mirror', 'suspension', 'tyre', 'engine']
    .reduce((s, k) => s + [c.damage[k]].flat().reduce((a, b) => a + b, 0), 0);

  // The car hit in the first scenarios, run alone, to compare how much the contact moved it
  function alone(make, steps, input = {}) {
    const B = make();
    const far = car(-200, 0, 0); // a parked car far away, so the same code runs
    run(far, B, steps, {}, input);
    return B;
  }

  // --- 1. Front wing endplate clips a rear tyre at a slow closing speed
  {
    // A's left endplate lines up with B's right rear tyre: B is 1.75 m to A's left, A brakes
    // from 7 m/s faster, its endplate 0.2 m short of the tyre
    const mkB = () => car(5.2, 1.75, 50);
    const A = car(0, 0, 57), B = mkB();
    const c = run(A, B, 60, { brake: 1 });
    const ref = alone(mkB, 60);
    // B against itself driving alone: speed gained along the track, and pushed off its line
    const dv = vAlong(B) - vAlong(ref), side = across(B) - across(ref), dyaw = B.yawRate - ref.yawRate;
    const solidDv = (1.25 * 7) / 2; // what a solid part closing at 7 m/s would give it
    console.log(`    endplate clip: A ${damaged(A)} | B ${damaged(B)} | B +${dv.toFixed(3)} m/s (a solid hit: ${solidDv.toFixed(1)}), ${(side * 1000).toFixed(0)} mm off its line, yaw rate ${dyaw.toFixed(3)} | touches ${c.touches}`);
    expect('endplate clip: front wing damaged', A.damage.wing[0] > 0.05, damaged(A));
    expect('endplate clip: other wing half untouched', A.damage.wing[1] === 0, damaged(A));
    expect('endplate clip: the tyre it clipped barely touched', B.damage.tyre[3] < 0.1 && total(B) < 0.15, damaged(B));
    expect('endplate clip: other car barely moves', dv < solidDv / 10 && Math.abs(side) < 0.1 && Math.abs(dyaw) < 0.05, `+${dv.toFixed(3)} m/s, ${(side * 1000).toFixed(0)} mm off line, yaw rate ${dyaw.toFixed(3)}`);
  }

  // --- 2. Nose under a rear wing: straight into the back of a car at 8 m/s closing
  {
    // A's nose tip 0.2 m behind B's crash structure; A coasts in from 8 m/s faster
    const A = car(0, 0, 48), B = car(5.67, 0, 40);
    let depth = 0;
    const c = run(A, B, 120, {}, {}, () => (depth = Math.max(depth, sunk(A, B))));
    console.log(`    nose under rear wing: A ${damaged(A)} | B ${damaged(B)} | deepest ${depth.toFixed(3)} m | touches ${c.touches} hard ${c.hard}`);
    expect('nose under rear wing: rear wing undamaged', B.damage.rearWing === 0, damaged(B));
    expect('nose under rear wing: gearbox or diffuser hit', B.damage.engine > 0 || B.damage.floor.some((d) => d > 0), damaged(B));
    expect('nose under rear wing: the hitting car\'s front wing takes it too', A.damage.wing[0] > 0 && A.damage.wing[1] > 0, damaged(A));
    expect('nose under rear wing: no pass-through', depth < 0.3 && along(B) - along(A) > 5, `deepest ${depth.toFixed(3)} m, gap ${(along(B) - along(A)).toFixed(2)} m`);
    expect('nose under rear wing: one hard contact', c.hard === 1, `${c.hard}`);
  }

  // --- 3. T-bone at speed: into the side of a car stopped across the track
  {
    // B stands across the track, pointing left, so its left side faces A; A's nose tip
    // 0.3 m from B's sidepods
    const A = car(0, 0, 25), B = car(2.95 + 0.85 + 0.3, 0, 0, Math.PI / 2);
    let depth = 0, minGap = Infinity;
    const c = run(A, B, 120, {}, { brake: 1 }, () => {
      depth = Math.max(depth, sunk(A, B));
      minGap = Math.min(minGap, along(B) - along(A));
    });
    console.log(`    T-bone: A ${damaged(A)} | B ${damaged(B)} | deepest ${depth.toFixed(3)} m, closest ${minGap.toFixed(2)} m | B now ${vAlong(B).toFixed(1)} m/s | touches ${c.touches} hard ${c.hard}`);
    expect('T-bone: no pass-through', depth < 0.3 && minGap > 2.95 + 0.85 - 0.3, `deepest ${depth.toFixed(3)} m, closest ${minGap.toFixed(2)} m`);
    expect('T-bone: sidepod or floor damaged', B.damage.sidepod[0] > 0 || B.damage.floor[0] > 0 || B.damage.sidepod[1] > 0 || B.damage.floor[1] > 0, damaged(B));
    expect('T-bone: on the side it was hit (its left)', B.damage.floor[0] > 0 && B.damage.floor[1] === 0, damaged(B));
    expect('T-bone: the hit car is shoved down the track', vAlong(B) > 5, `${vAlong(B).toFixed(1)} m/s`);
    expect('T-bone: the hitting car\'s front wing', A.damage.wing[0] > 0 && A.damage.wing[1] > 0, damaged(A));
  }

  // --- 4. Side by side, a light rub for 2 s
  {
    // wheel to wheel at 50 m/s, 1.95 m apart (the rear tyres 0.05 m into each other), and A
    // steers a touch to the left, leaning on B the whole time
    const A = car(0, 0, 50), B = car(0, 1.95, 50);
    // jitter: the cars knocked back and forth step to step. Watch each step's push (how far
    // collideCars moves B), and count the times B's sideways speed jumps one way and then
    // the other (after the first touch has sorted out the overlap they started with)
    let steps = 0, maxPush = 0, maxYaw = 0, prevV = 0, prevKick = 0, flips = 0;
    const field = [{ physics: A }, { physics: B }];
    const t0 = CONTACTS.touches, h0 = CONTACTS.hard;
    for (let k = 0; k < 240; k++) {
      A.step({ throttle: 0.6, steer: 0.01 }, DT);
      B.step({ throttle: 0.6 }, DT);
      const before = across(B);
      collideCars(field);
      if (overlapping(A, B) || across(B) !== before) steps++;
      const v = vAcross(B);
      const kick = v - prevV;
      if (k > 12) {
        maxPush = Math.max(maxPush, Math.abs(across(B) - before));
        if (Math.abs(kick) > 0.02) {
          if (prevKick && Math.sign(kick) !== Math.sign(prevKick)) flips++;
          prevKick = kick;
        }
      }
      prevV = v;
      maxYaw = Math.max(maxYaw, Math.abs(A.yawRate), Math.abs(B.yawRate));
    }
    const c = { touches: CONTACTS.touches - t0, hard: CONTACTS.hard - h0 };
    const apart = across(B) - across(A);
    console.log(`    side by side: A ${damaged(A)} | B ${damaged(B)} | in contact ${steps} of 240 steps, biggest push ${(maxPush * 1000).toFixed(2)} mm, ${flips} back-and-forth kicks, max yaw rate ${maxYaw.toFixed(3)} rad/s, apart ${apart.toFixed(2)} m, B now ${vAcross(B).toFixed(2)} m/s sideways | new touches ${c.touches} hard ${c.hard}`);
    expect('side by side: they rub', steps > 100, `${steps} steps`);
    expect('side by side: no jitter over 2 s', maxPush < 0.002 && flips <= 2 && maxYaw < 0.1, `push ${(maxPush * 1000).toFixed(2)} mm, ${flips} back-and-forth kicks, yaw rate ${maxYaw.toFixed(3)} rad/s`);
    expect('side by side: a small shove, not a bounce', apart > 1.9 && apart < 2.5, `${apart.toFixed(2)} m apart`);
    expect('side by side: no hard contact, no damage', c.hard === 0 && total(A) + total(B) === 0, `hard ${c.hard}; A ${damaged(A)} | B ${damaged(B)}`);
  }
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks pass');
process.exit(failures ? 1 : 0);
