// Debris checks (debris.js) on Suzuka's start straight, on the real physics at 120 Hz:
//
//   node scripts/debris-check.mjs
//
// 1. A piece thrown up lands, bounces and slides to a stop on the road (not under it, not
//    frozen in the air), and stays inside the barriers; sliding downhill, friction still
//    stops it.
// 2. A car running into a piece lying on the road knocks it away and takes damage on the
//    part it hit (a front wing or a tyre); a slow car only nudges it, without damage.
// 3. The car a piece came off can't hit it for its first moments (it's thrown from inside
//    the car's boxes).
// 4. After DEBRIS.life the piece shrinks away and is deleted.
//
// Exits 1 if any check fails.
globalThis.location ??= { search: '' };
globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {} });
globalThis.Path2D ??= class { constructor() {} addPath() {} moveTo() {} lineTo() {} bezierCurveTo() {} quadraticCurveTo() {} arc() {} ellipse() {} rect() {} closePath() {} };
const THREE = await import('three/webgpu');
const { TRACKS } = await import('../src/tracks/index.js');
const { TrackPath, WALL_THICKNESS } = await import('../src/trackPath.js');
const { CarPhysics } = await import('../src/physics.js');
const { stepDebris, DEBRIS } = await import('../src/debris.js');

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  (${detail})` : ''}`);
};

const DT = 1 / 120;
const P = new TrackPath(TRACKS.find((t) => t.id === 'suzuka'));
const S0 = -120; // on the grid straight

/** A car s metres along the straight, `lat` left, at `speed`. */
function car(s, lat, speed) {
  const pose = P.poseAt(S0 + s, lat);
  const c = new CarPhysics(P, pose);
  c.damageOn = true;
  c.vel.x = Math.sin(pose.yaw) * speed;
  c.vel.z = Math.cos(pose.yaw) * speed;
  c.speed = speed;
  for (const w of c.wheels) w.omega = c.speed / w.r;
  return c;
}

/** A piece of debris as car.js makes one: a 0.9 × 0.3 × 0.06 m wing half, at rest or thrown. */
function piece(s, lat, { up = 0, v = [0, 0, 0], owner = null } = {}) {
  const pose = P.poseAt(S0 + s, lat);
  const obj = new THREE.Group();
  obj.position.set(pose.x, P.heightAt(S0 + s, lat) + 0.03 + up, pose.z);
  return {
    obj, v: new THREE.Vector3(...v), spin: new THREE.Vector3(3, 1, 2), owner,
    hx: 0.45, hy: 0.15, hz: 0.03, age: 0, rest: false, hint: -1, hits: new Map(),
  };
}
/** The cars' visual side, as stepDebris wants it: { car: { pieces, debris }, physics }. */
const holder = (physics, pieces = []) => {
  const debris = new THREE.Group();
  for (const p of pieces) debris.add(p.obj);
  return { car: { pieces, debris }, physics };
};
const run = (fleet, seconds, each = () => {}) => {
  for (let t = 0; t < seconds; t += DT) {
    for (const f of fleet) if (f.physics.drive) f.physics.step(f.physics.drive, DT);
    stepDebris(fleet, P, DT);
    each();
  }
};
const ground = (p) => {
  const q = P.query(p.obj.position.x, p.obj.position.z);
  return { h: P.heightAt(q.s, q.lateral), lat: q.lateral };
};
const damageTotal = (c) => {
  const d = c.damage;
  return [...d.wing, d.rearWing, ...d.floor, ...d.sidepod, ...d.mirror, ...d.suspension, ...d.tyre, d.engine].reduce((a, b) => a + b, 0);
};

console.log('debris on Suzuka start straight');

// 1. thrown up and sideways: lands, slides to a stop on the road, inside the barriers
{
  const p = piece(0, 0, { up: 2, v: [12, 4, 30] });
  const f = holder({ position: { x: 1e6, z: 1e6 }, vel: { x: 0, z: 0 } }, [p]); // no car nearby
  let minAbove = Infinity, maxLat = 0;
  run([f], 6, () => {
    const g = ground(p);
    minAbove = Math.min(minAbove, p.obj.position.y - g.h);
    maxLat = Math.max(maxLat, Math.abs(g.lat));
  });
  const g = ground(p);
  const wall = Math.max(P.wallL[0], P.wallR[0]);
  check(p.rest, 'thrown piece comes to rest', `after 6 s, speed ${p.v.length().toFixed(2)} m/s`);
  check(Math.abs(p.obj.position.y - g.h - p.hz) < 0.02, 'it lies on the road', `${(p.obj.position.y - g.h).toFixed(3)} m above it`);
  check(minAbove > -0.01, 'never sinks into the road', `lowest ${minAbove.toFixed(3)} m`);
  check(maxLat < wall + 0.5, 'stays inside the barriers', `widest ${maxLat.toFixed(1)} m, wall ${wall.toFixed(1)} m`);
}

// 1a. thrown hard at the barrier: it bounces off and never ends up in or behind it (the
// wall's face is half its thickness in front of the wall line)
{
  const pose = P.poseAt(S0, 0);
  const lx = Math.cos(pose.yaw), lz = -Math.sin(pose.yaw); // the track's left
  const p = piece(0, 0, { up: 0.3, v: [lx * 45, 2, lz * 45] });
  const f = holder({ position: { x: 1e6, z: 1e6 }, vel: { x: 0, z: 0 } }, [p]);
  let widest = 0, back = false;
  for (let t = 0; t < 3; t += DT) {
    stepDebris([f], P, DT);
    const q = P.query(p.obj.position.x, p.obj.position.z);
    widest = Math.max(widest, q.lateral + Math.min(p.hx, p.hy));
    back ||= p.v.x * lx + p.v.z * lz < -1;
  }
  const i = P.query(p.obj.position.x, p.obj.position.z).i, face = P.wallL[i] - WALL_THICKNESS / 2;
  check(back && widest <= face + 0.05, 'a piece thrown at the barrier bounces off it', `nearest edge ${widest.toFixed(2)} m out, face at ${face.toFixed(2)} m`);
}

// 1b. sliding down the start straight's slope: it stays on the road and friction stops it
// in about the time DEBRIS.slide says (it doesn't skim just clear of the road)
{
  const pose = P.poseAt(S0, 3);
  const p = piece(0, 3, { v: [Math.sin(pose.yaw) * 20, 0, Math.cos(pose.yaw) * 20] });
  const f = holder({ position: { x: 1e6, z: 1e6 }, vel: { x: 0, z: 0 } }, [p]);
  let t = 0;
  for (; t < 10 && !p.rest; t += DT) stepDebris([f], P, DT);
  check(p.rest && t < 20 / DEBRIS.slide + 1, 'a piece sliding downhill at 20 m/s stops', `${t.toFixed(1)} s`);
}

// 2. a car at 70 m/s, coasting, runs into a piece in its path. Against the same car with
// nothing in the way: it hardly slows, the piece flies off, and the part that reached it
// first is damaged. A wing half standing on its endplate (0.25 m tall) catches the front
// wing; a flat strip of floor (6 cm) passes under the wing (5 cm off the road) and is hit
// by the floor; one in a tyre's path is run over by it.
for (const [label, lat, hz, part] of [['standing wing half', 0.6, 0.12, 'wing'], ['flat floor strip', 0.6, 0.03, 'floor'], ['piece in a tyre track', 0.95, 0.03, 'tyre']]) {
  const c = car(0, 0, 70), clear = car(0, 0, 70);
  c.drive = clear.drive = { steer: 0, throttle: 0, brake: 0 };
  const p = piece(40, -lat); // right of the centre line: the car's right wing / tyre
  p.hz = hz;
  const q = P.query(p.obj.position.x, p.obj.position.z);
  p.obj.position.y = P.heightAt(q.s, q.lateral) + p.hz;
  let hit = false, peak = 0;
  run([holder(c, [p]), holder(clear)], 1.2, () => { hit ||= p.hits.size > 0; peak = Math.max(peak, p.v.length()); });
  const d = c.damage;
  const lvl = part === 'tyre' ? Math.max(...d.tyre) : Math.max(...d[part]);
  check(hit, `car runs into a ${label}`);
  check(peak > 40, '  it is knocked away fast', `${peak.toFixed(0)} m/s`);
  check(lvl > 0.05 && lvl < 0.7, `  ${part} damaged, not destroyed`, `${lvl.toFixed(2)}; total ${damageTotal(c).toFixed(2)}`);
  check(clear.speed - c.speed < 1.5, '  the car hardly slows', `${(clear.speed - c.speed).toFixed(2)} m/s slower than with no piece`);
}

// 2b. a car creeping at 5 m/s pushes a piece along without damage
{
  const c = car(0, 0, 5);
  c.drive = { steer: 0, throttle: 0.05, brake: 0 };
  const p = piece(6, -0.6);
  const q = P.query(p.obj.position.x, p.obj.position.z);
  p.obj.position.y = P.heightAt(q.s, q.lateral) + p.hz;
  const start = p.obj.position.clone();
  run([holder(c, [p])], 3);
  check(p.obj.position.distanceTo(start) > 1, 'slow car nudges a piece along', `${p.obj.position.distanceTo(start).toFixed(1)} m`);
  check(damageTotal(c) === 0, '  without damage', `${damageTotal(c).toFixed(2)}`);
}

// 3. the car it came off: thrown from inside its boxes, no hit for the grace period
{
  const c = car(0, 0, 50);
  c.drive = { steer: 0, throttle: 1, brake: 0 };
  const p = piece(2.6, 0.5, { up: 0.2, v: [c.vel.x * 0.75, 3, c.vel.z * 0.75], owner: c });
  run([holder(c, [p])], DEBRIS.grace * 0.9);
  check(p.hits.size === 0 && damageTotal(c) === 0, 'its own car does not hit it while it is thrown off');
}

// 4. lifetime: gone after life + fade
{
  const p = piece(0, 3);
  const f = holder({ position: { x: 1e6, z: 1e6 }, vel: { x: 0, z: 0 } }, [p]);
  run([f], DEBRIS.life - 0.1);
  check(f.car.pieces.length === 1, 'piece still there before its life is up');
  run([f], DEBRIS.fade * 0.5);
  check(p.obj.scale.x < 1 && p.obj.scale.x > 0, '  then shrinks', `scale ${p.obj.scale.x.toFixed(2)}`);
  run([f], DEBRIS.fade);
  check(f.car.pieces.length === 0 && f.car.debris.children.length === 0, '  and is deleted');
}

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall debris checks passed');
