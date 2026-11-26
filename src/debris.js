// Debris: parts that break off a car in a crash (car.js spawnDebris) are thrown onto the
// track as solid pieces. They fly, bounce off the road and the barriers and slide to a
// stop; any car that runs into one knocks it away and takes some damage where it touched
// (a cut tyre, a bent wing: CarDamage.hitPart). After DEBRIS.life seconds a piece shrinks
// away and is deleted.
//
// Each piece is a box (half sizes hx along, hy across, hz up) turning with its heading, tested
// against the cars' part boxes (carShape.js). The pieces belong to the car that shed them
// (car.pieces, made by car.js makePiece, drawn in car.debris); stepDebris() moves every car's pieces once per physics
// step and tests them against every car.
import * as THREE from 'three/webgpu';
import { carBoxes, boxOverlap, boxGone } from './carShape.js';

export const DEBRIS = {
  life: 25, // s a piece stays on the track ...
  fade: 1.5, // ... then shrinks away over this long and is deleted
  gravity: 9.81,
  bounce: 0.3, // share of the speed into the road or a barrier kept on the rebound
  slide: 6, // m/s² a piece on the road slows by (carbon on asphalt)
  rest: 0.4, // m/s: slower than this on the road, it lies still (still solid)
  grace: 0.6, // s before a piece can hit the car it came off
  // a car hitting a piece
  kick: 1.2, // the piece leaves at this times the speed the car hit it at (it is light) ...
  out: 0.25, // ... plus this times it out along the contact (out of the car's path)
  pop: 0.12, // and jumps up at this times the closing speed (m/s per m/s) ...
  popMax: 5, // ... at most this
  slow: 0.006, // the car loses this times the closing speed (a 5 kg part against an 850 kg car)
  hitMin: 10, // closing speed (m/s) for any damage ...
  hitFull: 90, // ... and for the full amount (≈ 320 km/h into a stationary part)
  damage: 0.35, // CarDamage.hitPart amount at hitFull (then scaled by the part's fragility)
  again: 0.4, // s before the same piece can damage the same car again
};

const _e = new THREE.Euler(), _q = new THREE.Quaternion();
const pieceBox = { cx: 0, cz: 0, fx: 0, fz: 1, hx: 0, hy: 0, h0: 0, h1: 0 };

/**
 * One physics step for every car's debris. fleet: [{ car, physics }] (car.pieces and the
 * physics the pieces hit); path: the TrackPath (road height, barriers).
 */
export function stepDebris(fleet, path, dt) {
  for (const { car } of fleet) {
    const list = car.pieces;
    for (let k = list.length - 1; k >= 0; k--) {
      const p = list[k];
      p.age += dt;
      if (p.age >= DEBRIS.life + DEBRIS.fade) {
        car.debris.remove(p.obj);
        list.splice(k, 1);
        continue;
      }
      if (p.age > DEBRIS.life) {
        p.obj.scale.setScalar(Math.max(0.01, 1 - (p.age - DEBRIS.life) / DEBRIS.fade));
        continue; // shrinking away: no longer in anyone's way
      }
      if (!p.rest) move(p, path, dt);
      for (const f of fleet) hitBy(p, f.physics, dt);
    }
  }
}

/** The piece's box (carShape.js format): along its heading, flat (a tumble isn't counted). */
function boxOf(p, b = pieceBox) {
  const o = p.obj;
  _e.setFromQuaternion(o.quaternion, 'YXZ');
  const yaw = _e.y + (p.yaw0 ?? 0); // the holder's turn on top of the car's heading it came off at
  b.cx = o.position.x; b.cz = o.position.z;
  b.fx = Math.sin(yaw); b.fz = Math.cos(yaw);
  b.hx = p.hx; b.hy = p.hy;
  b.h0 = o.position.y - p.hz; b.h1 = o.position.y + p.hz;
  return b;
}

/** Fly, bounce and slide: gravity, the road under it and the barriers (as the cars' walls). */
function move(p, path, dt) {
  const o = p.obj, v = p.v;
  const fromX = o.position.x, fromZ = o.position.z;
  v.y -= DEBRIS.gravity * dt;
  o.position.addScaledVector(v, dt);
  o.quaternion.premultiply(_q.setFromEuler(_e.set(p.spin.x * dt, p.spin.y * dt, p.spin.z * dt)));
  const q = path.query(o.position.x, o.position.z, p.hint);
  p.hint = q.i;
  // the barriers: the cars' own wall test (swept from where it was, so a fast piece can't
  // skip through), pushed back out and bouncing off
  const road = path.heightAt(q.s, q.lateral);
  for (let iter = 0; iter < 2; iter++) {
    const c = path.wallContactBox(boxOf(p), iter ? o.position.x : fromX, iter ? o.position.z : fromZ, road);
    if (!c) break;
    o.position.x -= c.nx * c.depth;
    o.position.z -= c.nz * c.depth;
    const into = v.x * c.nx + v.z * c.nz;
    if (into > 0) {
      v.x -= c.nx * into * (1 + DEBRIS.bounce);
      v.z -= c.nz * into * (1 + DEBRIS.bounce);
      p.spin.multiplyScalar(0.7);
    }
  }
  const ground = road + p.hz;
  // sliding, it follows the road down a slope (left to gravity alone, a piece sliding
  // downhill would skim just clear of the road, step after step, and never slow down)
  const sliding = p.sliding && v.y < 0.5 && o.position.y - ground < 0.1;
  p.sliding = false;
  if (o.position.y > ground && !sliding) return;
  o.position.y = ground;
  if (v.y < -1) {
    v.y = -v.y * DEBRIS.bounce; // a bounce
    v.x *= 0.7;
    v.z *= 0.7;
    p.spin.multiplyScalar(0.5);
    return;
  }
  // on the road: slides to a stop, lying flat
  v.y = 0;
  p.sliding = true;
  const sp = Math.hypot(v.x, v.z), slow = DEBRIS.slide * dt;
  if (sp > slow) {
    v.x *= 1 - slow / sp;
    v.z *= 1 - slow / sp;
  } else v.x = v.z = 0;
  p.spin.multiplyScalar(Math.max(0, 1 - 4 * dt));
  if (sp < DEBRIS.rest) {
    v.set(0, 0, 0);
    p.spin.set(0, 0, 0);
    _e.setFromQuaternion(o.quaternion, 'YXZ');
    o.quaternion.setFromEuler(_e.set(0, _e.y, 0, 'YXZ'));
    p.rest = true;
  }
}

/** A car running into the piece: the piece is knocked away, and the part it hit is damaged. */
function hitBy(p, car, dt) {
  if (car === p.owner && p.age < DEBRIS.grace) return;
  const o = p.obj;
  const dx = o.position.x - car.position.x, dz = o.position.z - car.position.z;
  if (dx * dx + dz * dz > 36) return;
  if (Math.abs(o.position.y - (car.height ?? 0)) > 3) return; // on a bridge over it, or under one
  // the piece's box, straight against the part boxes, not the car's hull first: the hull's
  // floor is level with the road under the car's middle, so on a slope it misses a thin
  // piece ahead
  const b = boxOf(p);
  // the part that got to it first: at speed the car runs a good way into the piece in one
  // step, overlapping several boxes, so of those the one furthest ahead along the way the
  // car is moving past the piece (a front wing before the floor behind it)
  const mx = car.vel.x - p.v.x, mz = car.vel.z - p.v.z;
  let hit = null, def = null, lead = -Infinity;
  for (const cb of carBoxes(car)) {
    if (boxGone(car, cb.def)) continue;
    const h = boxOverlap(cb, b);
    if (!h) continue;
    const ahead = (cb.cx - car.position.x) * mx + (cb.cz - car.position.z) * mz;
    if (ahead > lead) { hit = h; def = cb.def; lead = ahead; }
  }
  if (!hit) return;
  const { nx, nz } = hit; // from the car into the piece
  o.position.x += nx * hit.depth;
  o.position.z += nz * hit.depth;
  // the car's body at the contact: its CoG's velocity plus its spin about it. At speed the
  // car moves further in a step than the piece is wide, so the overlap's normal can come
  // out sideways while the car drives straight through it: the hit is the whole speed
  // between them, and the piece is thrown along it (and out of the way, along the normal)
  const vx = car.vel.x + car.yawRate * (hit.pz - car.position.z);
  const vz = car.vel.z - car.yawRate * (hit.px - car.position.x);
  const v = p.v;
  const rx = vx - v.x, rz = vz - v.z;
  const closing = Math.hypot(rx, rz);
  if (closing < 0.05 || rx * nx + rz * nz < -0.2 * closing) return; // it's already getting away
  // the piece is knocked ahead of the car and out of its path, and pops up spinning; the
  // car hardly notices
  v.x += rx * DEBRIS.kick + nx * closing * DEBRIS.out;
  v.z += rz * DEBRIS.kick + nz * closing * DEBRIS.out;
  v.y = Math.max(v.y, Math.min(DEBRIS.popMax, closing * DEBRIS.pop * (0.6 + 0.8 * Math.random())));
  p.spin.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(Math.min(30, closing));
  p.rest = false;
  car.vel.x -= rx * DEBRIS.slow;
  car.vel.z -= rz * DEBRIS.slow;
  // damage: once per hit (a piece dragged along under the car doesn't keep cutting)
  const last = p.hits.get(car) ?? -Infinity;
  p.hits.set(car, p.age);
  if (p.age - last < DEBRIS.again || !car.damageOn) return;
  const amount = DEBRIS.damage * Math.min(1.5, (closing - DEBRIS.hitMin) / (DEBRIS.hitFull - DEBRIS.hitMin));
  if (amount <= 0) return;
  // where it landed, in the car frame: which side, how far forward
  const sin = Math.sin(car.yaw), cos = Math.cos(car.yaw);
  const ox = hit.px - car.position.x, oz = hit.pz - car.position.z;
  const x = ox * sin + oz * cos, y = ox * cos - oz * sin;
  car.damage.hitPart(def.part, def.i ?? (y >= 0 ? 0 : 1), amount, x);
}
