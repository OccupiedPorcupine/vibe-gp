// Set-up car-to-car crashes on the real physics: two cars on Suzuka's start straight,
// stepped at the game's 120 Hz, with collideCars() after each step as in a race.
//
//   node scripts/car-contact-check.mjs [-v]
//
// Each scenario checks where the contact landed (which parts took damage) and how the cars
// moved. -v prints the details of every scenario. Exits non-zero if any check fails.
// logos.js builds Path2D objects at import time (browser only): stub it for Node
globalThis.location ??= { search: '' };
globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {} });
globalThis.Path2D ??= class { constructor() {} addPath() {} moveTo() {} lineTo() {} bezierCurveTo() {} quadraticCurveTo() {} arc() {} ellipse() {} rect() {} closePath() {} };
const { TRACKS } = await import('../src/tracks/index.js');
const { TrackPath } = await import('../src/trackPath.js');
const { CarPhysics } = await import('../src/physics.js');
const { collideCars, CONTACTS } = await import('../src/ai.js');
const { carBoxes, boxOverlap } = await import('../src/carShape.js');

const verbose = process.argv.includes('-v');
const DT = 1 / 120;
const P = new TrackPath(TRACKS.find((t) => t.id === 'suzuka'));
const S0 = -120; // m: on the grid straight

let failed = 0, passed = 0;
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  if (!ok || verbose) console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
}

/** A car on the straight, s metres along and `lat` to the left, at `speed` (yaw offset `turn`). */
function car(s, lat, speed, turn = 0) {
  const pose = P.poseAt(S0 + s, lat);
  const c = new CarPhysics(P, { ...pose, yaw: pose.yaw + turn });
  c.damageOn = true;
  const heading = pose.yaw; // moving along the track, whichever way the car points
  c.vel.x = Math.sin(heading) * speed;
  c.vel.z = Math.cos(heading) * speed;
  c.speed = speed * Math.cos(turn);
  for (const w of c.wheels) w.omega = c.speed / w.r;
  return c;
}
const track = P.poseAt(S0, 0);
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
  if (verbose) console.log(`  endplate clip: A ${damaged(A)} | B ${damaged(B)} | B +${dv.toFixed(3)} m/s (a solid hit: ${solidDv.toFixed(1)}), ${(side * 1000).toFixed(0)} mm off its line, yaw rate ${dyaw.toFixed(3)} | touches ${c.touches}`);
  check('endplate clip: front wing damaged', A.damage.wing[0] > 0.05, damaged(A));
  check('endplate clip: other wing half untouched', A.damage.wing[1] === 0, damaged(A));
  check('endplate clip: the tyre it clipped barely touched', B.damage.tyre[3] < 0.1 && total(B) < 0.15, damaged(B));
  check('endplate clip: other car barely moves', dv < solidDv / 10 && Math.abs(side) < 0.1 && Math.abs(dyaw) < 0.05, `+${dv.toFixed(3)} m/s, ${(side * 1000).toFixed(0)} mm off line, yaw rate ${dyaw.toFixed(3)}`);
}

// --- 2. Nose under a rear wing: straight into the back of a car at 8 m/s closing
{
  // A's nose tip 0.2 m behind B's crash structure; A coasts in from 8 m/s faster
  const A = car(0, 0, 48), B = car(5.67, 0, 40);
  let depth = 0;
  const c = run(A, B, 120, {}, {}, () => (depth = Math.max(depth, sunk(A, B))));
  if (verbose) console.log(`  nose under rear wing: A ${damaged(A)} | B ${damaged(B)} | deepest ${depth.toFixed(3)} m | touches ${c.touches} hard ${c.hard}`);
  check('nose under rear wing: rear wing undamaged', B.damage.rearWing === 0, damaged(B));
  check('nose under rear wing: gearbox or diffuser hit', B.damage.engine > 0 || B.damage.floor.some((d) => d > 0), damaged(B));
  check('nose under rear wing: the hitting car\'s front wing takes it too', A.damage.wing[0] > 0 && A.damage.wing[1] > 0, damaged(A));
  check('nose under rear wing: no pass-through', depth < 0.3 && along(B) - along(A) > 5, `deepest ${depth.toFixed(3)} m, gap ${(along(B) - along(A)).toFixed(2)} m`);
  check('nose under rear wing: one hard contact', c.hard === 1, `${c.hard}`);
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
  if (verbose) console.log(`  T-bone: A ${damaged(A)} | B ${damaged(B)} | deepest ${depth.toFixed(3)} m, closest ${minGap.toFixed(2)} m | B now ${vAlong(B).toFixed(1)} m/s | touches ${c.touches} hard ${c.hard}`);
  check('T-bone: no pass-through', depth < 0.3 && minGap > 2.95 + 0.85 - 0.3, `deepest ${depth.toFixed(3)} m, closest ${minGap.toFixed(2)} m`);
  check('T-bone: sidepod or floor damaged', B.damage.sidepod[0] > 0 || B.damage.floor[0] > 0 || B.damage.sidepod[1] > 0 || B.damage.floor[1] > 0, damaged(B));
  check('T-bone: on the side it was hit (its left)', B.damage.floor[0] > 0 && B.damage.floor[1] === 0, damaged(B));
  check('T-bone: the hit car is shoved down the track', vAlong(B) > 5, `${vAlong(B).toFixed(1)} m/s`);
  check('T-bone: the hitting car\'s front wing', A.damage.wing[0] > 0 && A.damage.wing[1] > 0, damaged(A));
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
  if (verbose) console.log(`  side by side: A ${damaged(A)} | B ${damaged(B)} | in contact ${steps} of 240 steps, biggest push ${(maxPush * 1000).toFixed(2)} mm, ${flips} back-and-forth kicks, max yaw rate ${maxYaw.toFixed(3)} rad/s, apart ${apart.toFixed(2)} m, B now ${vAcross(B).toFixed(2)} m/s sideways | new touches ${c.touches} hard ${c.hard}`);
  check('side by side: they rub', steps > 100, `${steps} steps`);
  check('side by side: no jitter over 2 s', maxPush < 0.002 && flips <= 2 && maxYaw < 0.1, `push ${(maxPush * 1000).toFixed(2)} mm, ${flips} back-and-forth kicks, yaw rate ${maxYaw.toFixed(3)} rad/s`);
  check('side by side: a small shove, not a bounce', apart > 1.9 && apart < 2.5, `${apart.toFixed(2)} m apart`);
  check('side by side: no hard contact, no damage', c.hard === 0 && total(A) + total(B) === 0, `hard ${c.hard}; A ${damaged(A)} | B ${damaged(B)}`);
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
