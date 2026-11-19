// AI opponents: computer-driven cars that race the player on the same physics.
//
// - racingLine(): a minimum-curvature line inside the track edges (iterative smoothing of
//   a lateral offset per centreline sample) and the speed profile along it (corner speed
//   from the tyre grip summary in PARAMS, then braking zones worked backwards).
// - AIDriver: steers at a point ahead on that line (pure pursuit), holds the profile speed
//   scaled by its own pace, and reacts to traffic: it follows a slower car, pulls out to
//   pass it on the side with more room, and keeps clear of a car alongside.
// - collideCars(): car-to-car contact. Each car is three circles along its length; overlaps
//   are pushed apart and the closing speed is exchanged (equal masses), with some spin and
//   (if damage is on) damage to both cars.
// - Race: the whole field (player + AI): grid, progress along the lap, positions, laps and
//   the chequered flag.
import { CarPhysics, PARAMS } from './physics.js';
import { TYRE } from './tyres.js';
import { AI_PACE } from './tracks/aipace.js';

const LINE_MARGIN = 1.5; // m between the racing line and the edge of the asphalt (car half width + a bit)
const WALL_MARGIN = 2.2; // m between the racing line and a wall face
const CAR_R = 1.0; // collision circle radius, m
const CAR_CIRCLES = [-1.75, 0, 1.75]; // circle centres along the car, m from the CoG (car is ~5.6 m long)
const RETIRE_TRIES = 6; // no-resets mode: recoveries that fail in a row before a car retires
const STAMP = 20, STAMP_OFFSET = 400; // timing loops every 20 m, from 400 m behind the line
const MASS = PARAMS.mass, INERTIA = PARAMS.yawInertia;

/** Minimum-curvature racing line and its speed profile for a TrackPath. */
export const AI_SEG = 20; // m: the learned speed profile (scripts/ai-learn.mjs) scales corner speeds per segment of this length

/**
 * `learned`: { brake, seg: [scale per AI_SEG m] } from src/tracks/aipace.js (made by
 * scripts/ai-learn.mjs); by default the track's own entry, or the plain estimate.
 */
export function racingLine(P, { gripUse = 1.15, learned = AI_PACE[P.def?.id] } = {}) {
  const N = P.N;
  const lat = new Float64Array(N);
  const lo = new Float64Array(N), hi = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    // inside the asphalt, and clear of walls that squeeze into it (street circuits)
    hi[i] = Math.max(0, Math.min(P.hw - LINE_MARGIN, P.wallL[i] - WALL_MARGIN)); // left (+)
    lo[i] = -Math.max(0, Math.min(P.hw - LINE_MARGIN, P.wallR[i] - WALL_MARGIN));
  }
  // the walls' limits, smoothed a little so they don't twitch the line
  const minAround = (arr, w) => Float64Array.from(arr, (_, i) => {
    let m = Infinity;
    for (let k = -w; k <= w; k++) m = Math.min(m, Math.abs(arr[P.wrap(i + k)]));
    return m;
  });
  const win = Math.max(1, Math.round(6 / P.ds));
  const hiS = minAround(hi, win), loS = minAround(lo, win);
  for (let i = 0; i < N; i++) { hi[i] = hiS[i]; lo[i] = -loS[i]; }
  // smoothing over a span of ~12 m, many passes: converges towards the line of least curvature
  const k = Math.max(1, Math.round(12 / P.ds));
  const lx = (i) => P.leftX(i), lz = (i) => P.leftZ(i);
  const qx = (i) => P.px[i] + lx(i) * lat[i], qz = (i) => P.pz[i] + lz(i) * lat[i];
  for (let it = 0; it < 600; it++) {
    for (let i = 0; i < N; i++) {
      const a = P.wrap(i - k), b = P.wrap(i + k);
      const mx = (qx(a) + qx(b)) / 2, mz = (qz(a) + qz(b)) / 2;
      const want = (mx - P.px[i]) * lx(i) + (mz - P.pz[i]) * lz(i);
      lat[i] = Math.min(hi[i], Math.max(lo[i], lat[i] + (want - lat[i]) * 0.6));
    }
  }
  // curvature of the line and the length of each step along it
  const X = new Float64Array(N), Z = new Float64Array(N), seg = new Float64Array(N), head = new Float64Array(N);
  for (let i = 0; i < N; i++) { X[i] = qx(i); Z[i] = qz(i); }
  for (let i = 0; i < N; i++) {
    const j = P.wrap(i + 1);
    seg[i] = Math.hypot(X[j] - X[i], Z[j] - Z[i]) || P.ds;
    head[i] = Math.atan2(X[j] - X[i], Z[j] - Z[i]);
  }
  // corner speed from the tyre grip summary (cold tyres, so on the safe side) and crests;
  // the learned per-segment scales go on top of this
  const g = (v) => PARAMS.baseGrip + PARAMS.downforceGrip * v * v;
  const vc = new Float64Array(N), vcap = new Float64Array(N), curv = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const a = P.wrap(i - 3), c = P.wrap(i + 3);
    let span = 0;
    for (let m = -3; m < 3; m++) span += seg[P.wrap(i + m)];
    const dh = Math.atan2(Math.sin(head[c] - head[a]), Math.cos(head[c] - head[a]));
    const kk = Math.max(Math.abs(dh) / span, 1e-5);
    curv[i] = kk;
    let v = 10;
    for (let n = 0; n < 25; n++) v = Math.sqrt((g(v) * gripUse) / kk);
    vc[i] = v;
    // crests unload the car: keep v²·κ well under g there
    const crest = -P.vcurv[i];
    vcap[i] = Math.min(95, crest > 0 ? Math.sqrt((9.81 * 0.7) / crest) : 95);
  }
  const K = Math.ceil(P.length / AI_SEG);
  const segOf = (i) => Math.min(K - 1, Math.floor((i * P.ds) / AI_SEG));
  const vlim = new Float64Array(N);
  /**
   * (Re)build the speed profile: corner speeds × scale[segment], then braking zones worked
   * backwards. The braking uses the grip there is at each speed (downforce: about three
   * times as much at 300 km/h as at walking pace), times `brakeUse`.
   */
  function profile(scale = null, brakeUse = 0.86) {
    for (let i = 0; i < N; i++) vlim[i] = Math.min(vcap[i], vc[i] * (scale ? scale[segOf(i)] : 1));
    // the slowest point of a corner governs the few metres around it (hairpin apexes are
    // sharper than a few samples can measure)
    const w = Math.max(1, Math.round(8 / P.ds));
    const src = Float64Array.from(vlim);
    for (let i = 0; i < N; i++) {
      let m = src[i];
      for (let k = -w; k <= w; k++) m = Math.min(m, src[P.wrap(i + k)]);
      vlim[i] = m;
    }
    const decel = (v) => brakeUse * (PARAMS.brakeDecel + TYRE.muLongScale * PARAMS.downforceGrip * v * v);
    for (let pass = 0; pass < 2; pass++) {
      for (let i = N - 1; i >= 0; i--) {
        const j = P.wrap(i + 1);
        vlim[i] = Math.min(vlim[i], Math.sqrt(vlim[j] ** 2 + 2 * decel(vlim[j]) * seg[i]));
      }
    }
  }
  profile(learned?.seg, learned?.brake ?? 0.86);
  const at = (arr, s) => {
    const f = (((s % P.length) + P.length) % P.length) / P.ds;
    const i = Math.floor(f) % N;
    return arr[i];
  };
  return {
    lat,
    vlim,
    segments: K,
    segOf,
    profile,
    /** Room for a car at s: { left, right } lateral limits (right is negative). */
    limits: (s) => ({ left: at(hi, s) + 0.3, right: at(lo, s) - 0.3 }),
    /** |curvature| of the line at s (1/m), the tightest within `ahead` metres. */
    curvAt(s, ahead = 0) {
      let m = 0;
      for (let d = 0; d <= ahead; d += P.ds * 2) m = Math.max(m, at(curv, s + d));
      return m;
    },
    latAt(s) {
      const f = (((s % P.length) + P.length) % P.length) / P.ds;
      const i = Math.floor(f) % N, j = P.wrap(i + 1), t = f - Math.floor(f);
      return lat[i] + (lat[j] - lat[i]) * t;
    },
    vAt(s) {
      const f = (((s % P.length) + P.length) % P.length) / P.ds;
      const i = Math.floor(f) % N, j = P.wrap(i + 1), t = f - Math.floor(f);
      return vlim[i] + (vlim[j] - vlim[i]) * t;
    },
  };
}

/** Damage an AI car can't race on (no-resets mode): broken suspension or a dead engine. */
function wrecked(d) {
  return d.suspension.some((x) => x >= 0.6) || d.engine >= 0.95;
}

/** Signed distance from s0 to s1 along the lap, in (-L/2, L/2]. */
function lapDelta(s1, s0, L) {
  let d = s1 - s0;
  if (d > L / 2) d -= L;
  if (d <= -L / 2) d += L;
  return d;
}

/** Computer driver for one car. */
export class AIDriver {
  constructor(entry, line, { pace = 0.95, reaction = 0.25, seed = 1 } = {}) {
    this.entry = entry;
    this.line = line;
    this.pace = pace; // share of the line's profile speed this driver carries
    this.reaction = reaction; // s from green to the throttle
    this.offset = 0; // extra lateral offset for traffic (m, + = left)
    this.offsetTarget = 0;
    this.stuck = 0;
    this.resets = true; // false: no-resets mode, a stuck car gets itself out or retires
    this.rec = null; // no-resets recovery in progress: { phase, t }
    this.tries = 0; // recoveries since the car last got properly going
    this.rand = mulberry32(seed);
    this.wobble = 0; // slow-varying small pace variation, so they don't drive like trains
    this.wobbleT = 0;
  }

  /** Controls for this step. field: every entry in the race. */
  drive(field, sinceGreen, dt) {
    const car = this.entry.physics;
    const P = car.track;
    const L = P.length;
    if (sinceGreen < this.reaction) return { steer: 0, throttle: 0, brake: 1 };
    // a car too badly damaged to race (it can't pit): with resets it's put back on the line
    // repaired; in no-resets mode it pulls over and retires
    if (this.resets && wrecked(car.damage)) {
      this.respawn(field);
      return { steer: 0, throttle: 0, brake: 0 };
    }
    if (!this.resets && (this.parking || wrecked(car.damage))) return this.pullOver();

    this.wobbleT -= dt;
    if (this.wobbleT <= 0) {
      this.wobbleT = 2 + this.rand() * 4;
      this.wobbleGoal = (this.rand() - 0.5) * 0.02;
    }
    this.wobble += ((this.wobbleGoal ?? 0) - this.wobble) * Math.min(1, dt * 0.5);

    const s = car.trackS;
    const v = Math.max(0, car.speed);
    const lineLat = this.line.latAt(s);
    // the target a little ahead: the brake pedal takes a moment to come on
    let vt = this.line.vAt(s + 3 + v * 0.08) * (this.pace + this.wobble);
    // the car's own damage: no point charging at the limit with half a front wing
    vt *= 1 - 0.12 * Math.min(1, car.damage.wing[0] + car.damage.wing[1]);

    // --- traffic ---
    const { left: limL, right: limR } = this.line.limits(s);
    const clampLat = (x) => Math.max(limR, Math.min(limL, x));
    let follow = Infinity;
    let urgent = false; // something is closing fast: move across quicker
    this.closeBehind = null; // { d, lat } of a car we're about to hit
    const range = 40 + v * 2.2; // look further up the road the faster we go
    let blocker = null, blockerD = Infinity, blockerLine = 0, blockerExtra = 0, beside = null, besideDl = 0, besideExtra = 0;
    // the first seconds after the start the pack is bunched: give everyone more room
    const startGap = sinceGreen < 8 ? 4 : 0;
    for (const o of field) {
      if (o === this.entry) continue;
      const op = o.physics;
      const d = lapDelta(op.trackS, s, L);
      if (d <= -6 || d >= range) continue;
      const dl = op.lateral - car.lateral;
      // a human driver can brake or swerve without warning: more room around the player
      const extra = o.isPlayer ? 0.4 : 0;
      // where our (offset) line will be when we get to it: the line can swing across the
      // road between here and there (Eau Rouge), so judge it there, not here
      const planned = this.line.latAt(s + d) + this.offset;
      const width = 2.6 + extra; // centre to centre: closer than this and we'd touch
      const inPath = (d < 15 && Math.abs(dl) < width) || Math.abs(op.lateral - planned) < width;
      if (d > 4 && inPath) {
        // the speed it's about to slow to: a car ahead brakes for the corner too, and
        // following its present speed is how you run into the back of it
        // (and how hard it's braking already: its speed a moment from now)
        const opNow = Math.max(0, op.speed + Math.min(0, op.longAccel ?? 0) * 0.6);
        const opV = Math.min(opNow, this.line.vAt(op.trackS + 5 + Math.max(0, op.speed) * 0.4));
        const closing = v - opV;
        if (closing > 15 && d < closing * 3) urgent = true; // a slow or stopped car ahead
        // about to hit it: closer than a car's length plus the distance to shed the closing
        // speed (at ~2 g) and a moment to react. Brake, and swerve to the side with room.
        if (Math.abs(dl) < 2.4 && closing > 2 && d < 5.5 + (closing * closing) / 40 + closing * 0.15 && (!this.closeBehind || d < this.closeBehind.d)) {
          this.closeBehind = { d, lat: op.lateral };
        }
        // don't run into it: be at its speed by the time we're a following gap behind,
        // unless we'll already be clear of it by the time we get there
        const gap = d - (7 + v * 0.15 + startGap + (o.isPlayer ? 3 : 0));
        const safe = Math.sqrt(opV ** 2 + 2 * PARAMS.brakeDecel * 0.6 * Math.max(0, gap));
        if (Math.abs(op.lateral - planned) < width || d < 12) follow = Math.min(follow, gap <= 0 ? opV - 2 : safe);
        // the nearest car we're catching is the one to pass
        const needPass = closing > 1.5 || (vt > opV + 2 && d < 20);
        if (needPass && d < blockerD) {
          blocker = op;
          blockerD = d;
          blockerLine = planned - this.offset;
          blockerExtra = extra;
        }
      } else if (Math.abs(d) <= 6 + startGap && Math.abs(dl) < 3.5 + extra && (!beside || Math.abs(dl) < Math.abs(besideDl))) {
        beside = op;
        besideDl = dl;
        besideExtra = extra;
      }
    }
    let want = 0; // offset from the line we'd like (m)
    // off the start: keep to our own side of the grid for the first seconds, blending onto
    // the line, rather than every car converging on it at once
    if (this.gridLat === undefined && sinceGreen > 0) this.gridLat = car.lateral;
    const laneHold = sinceGreen < 3 ? 1 : sinceGreen < 8 ? (8 - sinceGreen) / 5 : 0;
    if (laneHold > 0 && this.gridLat !== undefined) want = clampLat(this.gridLat) - lineLat;
    want *= laneHold;
    // in trouble (getting going again, stuck, off the track or crawling) with a much faster
    // car coming up behind: keep out of its way on the side we're on, rather than rejoin
    // across it. (A car merely accelerating out of a corner doesn't count.)
    let yieldTo = null;
    const offTrack = Math.abs(car.lateral) > P.hw + 0.5;
    if (this.rec || this.stuck > 0.5 || offTrack || (v < 15 && v < this.line.vAt(s) * 0.4)) {
      for (const o of field) {
        if (o === this.entry) continue;
        const d = lapDelta(o.physics.trackS, s, L);
        if (d < -3 && d > -90 && o.physics.speed > v + 8) yieldTo = o;
      }
    }
    if (yieldTo && !blocker) {
      const side = car.lateral >= lineLat ? 1 : -1;
      want = (side > 0 ? limL : limR) - lineLat;
    } else if (laneHold > 0.5) {
      // still sorting out after the start: no dives for a gap, just keep a car's width from
      // anyone alongside
      if (beside) {
        const side = besideDl > 0 ? -1 : 1;
        const apart = clampLat(beside.lateral + side * (3.3 + besideExtra)) - lineLat;
        if (side > 0 ? apart > want : apart < want) want = apart;
      }
    } else if (blocker) {
      // pass on the side with more room, but never across a car alongside us
      // (room and offsets measured where the other car is)
      const there = this.line.limits(s + blockerD);
      const roomL = there.left - blocker.lateral, roomR = blocker.lateral - there.right;
      let side = roomL > roomR ? 1 : -1;
      if (beside) side = besideDl > 0 ? -1 : 1;
      if ((side > 0 ? roomL : roomR) < 3) side = -side; // no room that side after all
      want = Math.max(there.right, Math.min(there.left, blocker.lateral + side * (3.2 + blockerExtra))) - blockerLine;
    } else if (beside) {
      // alongside: hold our side, give each other a car's width
      const side = besideDl > 0 ? -1 : 1; // the other car is left of us: lean right
      want = clampLat(beside.lateral + side * (3.3 + besideExtra)) - lineLat;
    }
    vt = Math.min(vt, follow);
    // emergency: about to run into the back of someone, whatever the plan
    if (this.closeBehind) {
      // brake hard, keep steering for the line (swerving at speed under full braking spun
      // cars into the next one more often than it saved a hit)
      this.brakeNow = true;
    }
    // the profile is for the racing line: off it (passing, giving room) a corner is tighter,
    // so slow down by about what the smaller radius costs: v ~ sqrt(R)
    const off = Math.max(Math.abs(this.offset), Math.abs(want));
    if (off > 0.3) vt *= Math.sqrt(Math.max(0.5, 1 - off * this.line.curvAt(s, 25 + v * 0.6)));
    this.offsetTarget = want;
    const rate = (urgent ? 7 : 2.5) * dt; // m per step the line can move sideways
    this.offset += Math.max(-rate, Math.min(rate, this.offsetTarget - this.offset));

    // --- steering: pure pursuit on the (offset) line ---
    const look = 7 + v * 0.28;
    const ahead = this.line.limits(s + look);
    const tLat = Math.max(ahead.right, Math.min(ahead.left, this.line.latAt(s + look) + this.offset));
    const tgt = P.poseAt(s + look, tLat);
    const aim = Math.atan2(tgt.x - car.position.x, tgt.z - car.position.z);
    const err = Math.atan2(Math.sin(aim - car.yaw), Math.cos(aim - car.yaw));

    // --- recovery: stuck against something or facing the wrong way ---
    const heading = P.heading[P.wrap(car.trackIndex < 0 ? 0 : car.trackIndex)];
    const back = Math.abs(Math.atan2(Math.sin(heading - car.yaw), Math.cos(heading - car.yaw))) > 1.8;
    if (v < 2 || back) this.stuck += dt;
    else this.stuck = Math.max(0, this.stuck - dt * 2);
    if (this.resets) {
      this.rec = null;
      if (this.stuck > 3.5) {
        this.stuck = 0;
        this.respawn(field);
        return { steer: 0, throttle: 0, brake: 0 };
      }
    } else {
      if (!this.rec && v > 15 && !back) this.tries = 0; // properly going again
      const r = this.recover(err, back, dt);
      if (r) return r;
    }

    if (this.brakeNow) {
      this.brakeNow = false;
      return { steer: Math.max(-1, Math.min(1, err * 3.5)), throttle: 0, brake: 1 };
    }
    return {
      steer: Math.max(-1, Math.min(1, err * 3.5)),
      throttle: v < vt ? 1 : 0,
      brake: v > vt + 0.3 ? Math.min(1, (v - vt) / 1.5) : 0,
    };
  }

  /**
   * No-resets mode: a stuck or spun car gets itself going. It backs away from whatever it
   * is stuck on, steering so the nose swings towards the line, then drives off slowly at
   * up to full lock; facing the wrong way, the two together make a three-point turn and
   * repeat until it points down the track. After RETIRE_TRIES tries in a row that get it
   * nowhere, it retires (Race parks it). Returns this step's controls, or null to drive.
   */
  recover(err, back, dt) {
    const car = this.entry.physics;
    if (!this.rec) {
      if (this.stuck < 1.5) return null;
      // turn the same way for the whole episode: near 180° the shorter way flips back and
      // forth, and the reverse and forward moves would undo each other
      if (this.tries === 0) this.turnDir = err >= 0 ? 1 : -1;
      // back away first only when it's against something or has to turn round
      const reverse = back || car.wallHit > 0 || this.lastFailed;
      this.rec = { phase: reverse ? 'reverse' : 'forward', t: 0, x: car.position.x, z: car.position.z };
    }
    const r = this.rec;
    r.t += dt;
    // facing the wrong way: full lock round; otherwise steer for the line
    const steer = back ? this.turnDir : Math.max(-1, Math.min(1, err * 3.5));
    if (r.phase === 'reverse') {
      if (r.t > 1.8 || (car.wallHit > 0.05 && r.t > 0.4)) {
        r.phase = 'forward';
        r.t = 0;
      }
      // in reverse the nose swings the opposite way to the steering. The brake key backs
      // the car up once it has stopped; hold it under ~9 km/h backwards.
      return { steer: -steer, throttle: 0, brake: car.speed > -2.5 ? 1 : 0 };
    }
    const going = car.speed > 6 && !back;
    if (going || r.t > 4 || (car.wallHit > 0.05 && r.t > 0.5)) {
      // a try counts against the car only if it got nowhere (a crawl through gravel is
      // progress, if slow)
      const moved = Math.hypot(car.position.x - r.x, car.position.z - r.z);
      this.lastFailed = !going && moved < 3;
      this.tries = this.lastFailed ? this.tries + 1 : going ? 0 : this.tries;
      this.rec = null;
      if (this.tries > RETIRE_TRIES) {
        this.entry.retire?.();
        return { steer: 0, throttle: 0, brake: 0 };
      }
      this.stuck = going ? 0 : 1.5; // not going yet: the next try starts at once
      return null;
    }
    return { steer, throttle: car.speed < 8 ? 1 : 0, brake: 0 };
  }

  /** Coast and brake to just off the asphalt on the nearer side, stop, and retire. */
  pullOver() {
    const car = this.entry.physics;
    const P = car.track;
    const v = Math.abs(car.speed);
    this.parking ??= { side: car.lateral >= 0 ? 1 : -1 };
    if (v < 1) {
      this.entry.retire?.();
      return { steer: 0, throttle: 0, brake: 0 };
    }
    const look = 6 + v * 0.3;
    const lim = this.line.limits(car.trackS + look);
    const tgt = P.poseAt(car.trackS + look, this.parking.side > 0 ? lim.left + 1.5 : lim.right - 1.5);
    const aim = Math.atan2(tgt.x - car.position.x, tgt.z - car.position.z);
    const err = Math.atan2(Math.sin(aim - car.yaw), Math.cos(aim - car.yaw));
    return { steer: Math.max(-1, Math.min(1, err * 3)), throttle: 0, brake: v > 12 ? 0.6 : 0.3 };
  }

  /** Put a stuck car back on the racing line, a little behind where it was, out of the way. */
  respawn(field) {
    const car = this.entry.physics;
    const P = car.track;
    let s = car.trackS - 10;
    for (let tries = 0; tries < 10; tries++) {
      const clear = field.every((o) => o === this.entry || Math.abs(lapDelta(o.physics.trackS, s, P.length)) > 25);
      if (clear) break;
      s -= 20;
    }
    const pose = P.poseAt(s, this.line.latAt(s));
    this.entry.respawned(s); // before the reset, which forgets where the car was
    const keep = { compound: car.compound };
    car.reset(pose);
    car.compound = keep.compound;
    this.offset = this.offsetTarget = 0;
  }
}

/** Car-to-car contacts so far (for scripts/ai-check.mjs): any closing touch, and hard ones (> 5 m/s). */
export const CONTACTS = { touches: 0, hard: 0, involving: new Map() };
let stepNo = 0;

/** Car-to-car contact for every pair in the field. */
export function collideCars(field) {
  stepNo++;
  for (let a = 0; a < field.length; a++) {
    for (let b = a + 1; b < field.length; b++) {
      const hit = collidePair(field[a].physics, field[b].physics);
      if (!hit) continue;
      CONTACTS.touches++;
      if (hit > 5) CONTACTS.hard++;
      for (const e of [field[a], field[b]]) CONTACTS.involving.set(e, (CONTACTS.involving.get(e) ?? 0) + 1);
    }
  }
}

function collidePair(A, B) {
  const dx = B.position.x - A.position.x, dz = B.position.z - A.position.z;
  if (dx * dx + dz * dz > 49) return; // further apart than two car lengths
  if (Math.abs((A.height ?? 0) - (B.height ?? 0)) > 3) return; // Suzuka's crossover: one is on the bridge
  const fa = { x: Math.sin(A.yaw), z: Math.cos(A.yaw) }, fb = { x: Math.sin(B.yaw), z: Math.cos(B.yaw) };
  let best = null;
  for (const oa of CAR_CIRCLES) {
    const ax = A.position.x + fa.x * oa, az = A.position.z + fa.z * oa;
    for (const ob of CAR_CIRCLES) {
      const bx = B.position.x + fb.x * ob, bz = B.position.z + fb.z * ob;
      const ex = bx - ax, ez = bz - az;
      const d = Math.hypot(ex, ez);
      const pen = 2 * CAR_R - d;
      if (pen > 0 && (!best || pen > best.pen)) best = { pen, nx: d > 1e-4 ? ex / d : fa.x, nz: d > 1e-4 ? ez / d : fa.z, cx: (ax + bx) / 2, cz: (az + bz) / 2 };
    }
  }
  if (!best) return;
  const { pen, nx, nz } = best; // n points from A to B
  A.position.x -= nx * pen / 2; A.position.z -= nz * pen / 2;
  B.position.x += nx * pen / 2; B.position.z += nz * pen / 2;
  const vr = (B.vel.x - A.vel.x) * nx + (B.vel.z - A.vel.z) * nz; // < 0: closing
  if (vr >= 0) return 0;
  const e = 0.25;
  const j = (-(1 + e) * vr) / 2; // Δv each (equal masses)
  A.vel.x -= nx * j; A.vel.z -= nz * j;
  B.vel.x += nx * j; B.vel.z += nz * j;
  // a little side-to-side friction, so a tap from behind doesn't feel like ice
  const tx = -nz, tz = nx;
  const vt = (B.vel.x - A.vel.x) * tx + (B.vel.z - A.vel.z) * tz;
  const ft = Math.max(-j * 0.3, Math.min(j * 0.3, vt / 2));
  A.vel.x += tx * ft; A.vel.z += tz * ft;
  B.vel.x -= tx * ft; B.vel.z -= tz * ft;
  // spin from where the hit lands (off-centre hits turn the car)
  spin(A, best.cx, best.cz, -nx * j - tx * ft, -nz * j - tz * ft);
  spin(B, best.cx, best.cz, nx * j + tx * ft, nz * j + tz * ft);
  const speed = -vr;
  hurt(A, nx, nz, speed);
  hurt(B, -nx, -nz, speed);
  // a new touch, not the same one carried over: this pair hasn't touched for half a second
  const seen = (A.lastTouch ??= new Map());
  const fresh = stepNo - (seen.get(B) ?? -1e9) > 60;
  seen.set(B, stepNo);
  return fresh && speed > 1 ? speed : 0;
}

/** Yaw kick from an impulse (Δv in m/s, world) applied at world point (cx, cz). */
function spin(car, cx, cz, jx, jz) {
  const rx = cx - car.position.x, rz = cz - car.position.z;
  const f = { x: Math.sin(car.yaw), z: Math.cos(car.yaw) }, l = { x: Math.cos(car.yaw), z: -Math.sin(car.yaw) };
  const a = rx * f.x + rz * f.z, b = rx * l.x + rz * l.z; // contact point in the car frame
  // a +yaw rotation moves the point along (a·left − b·forward)
  const arm = (jx * (a * l.x - b * f.x) + jz * (a * l.z - b * f.z));
  car.yawRate += (arm * MASS * 0.5) / INERTIA;
}

/** Impact sound and (if on) damage for a car hit towards (nx, nz) at `speed` m/s. */
function hurt(car, nx, nz, speed) {
  if (speed > car.impact) {
    car.impact = speed;
    car.impactSide = nx * Math.cos(car.yaw) - nz * Math.sin(car.yaw);
  }
  if (car.damageOn && speed > 3) {
    const sin = Math.sin(car.yaw), cos = Math.cos(car.yaw);
    car.damage.impact(nx * sin + nz * cos, nx * cos - nz * sin, speed * 0.8);
  }
}

/** One car in the race: the player's or an AI's. */
export class Entry {
  constructor({ team, physics, isPlayer = false, gridS = 0 }) {
    this.team = team;
    this.physics = physics;
    this.isPlayer = isPlayer;
    this.driver = null; // AIDriver for AI cars
    this.progress = gridS; // metres since the start line (negative on the grid)
    this.prevS = null;
    this.lap = 0; // laps started (0 = before the line)
    this.finished = false;
    this.finishTime = null;
    this.retired = false; // no-resets mode: gave up, parked where it stopped
    this.position = 0;
    this.stamps = []; // race time when the car first reached each STAMP metres of progress
  }

  /** Track progress along the lap from the car's new position. */
  track(L, time) {
    const s = this.physics.trackS;
    if (this.prevS !== null) this.progress += lapDelta(s, this.prevS, L);
    this.prevS = s;
    const k = Math.floor((this.progress + STAMP_OFFSET) / STAMP);
    for (let j = this.stamps.length; j <= k; j++) this.stamps[j] = time;
  }

  respawned(s) {
    this.progress += lapDelta(s, this.physics.trackS, this.physics.track.length);
    this.prevS = null;
  }
}

/** Pace ladder: the 2025 constructors' order (TEAMS order), quickest first. */
/**
 * Difficulty levels: the leading team's share of the learned speed profile, how much each
 * team down the 2025 constructors' order gives away, and the range of reaction times at
 * the start. The profile itself is near the car's limit (scripts/ai-learn.mjs learns it at
 * 1.02 of it, so even Expert keeps a little margin in traffic).
 */
export const LEVELS = {
  easy: { top: 0.86, spread: 0.005, reaction: [0.3, 0.6] },
  normal: { top: 0.885, spread: 0.005, reaction: [0.2, 0.45] },
  hard: { top: 0.95, spread: 0.004, reaction: [0.15, 0.35] },
  expert: { top: 0.98, spread: 0.0025, reaction: [0.1, 0.22] },
};

/** Pace ladder: the team at `index` in TEAMS order (quickest first) at difficulty `level`. */
export function teamPace(index, level = 'normal') {
  const L = LEVELS[level] ?? LEVELS.normal;
  return L.top - index * L.spread;
}

/**
 * The race: the player plus `opponents` AI cars from the other teams. The grid lines up
 * in pace order with the player at the back (or `playerSlot`).
 */
export class Race {
  constructor(path, playerTeam, playerPhysics, teams, { opponents = 10, laps = 5, level = 'normal', playerSlot = null } = {}) {
    this.path = path;
    this.laps = laps;
    this.line = racingLine(path);
    this.time = 0;
    this.sinceGreen = 0;
    const rivals = teams.filter((t) => t.id !== playerTeam.id).slice(0, opponents);
    const n = rivals.length + 1;
    const pSlot = playerSlot ?? n - 1;
    this.entries = [];
    let k = 0;
    for (let slot = 0; slot < n; slot++) {
      if (slot === pSlot) {
        this.player = new Entry({ team: playerTeam, physics: playerPhysics, isPlayer: true });
        this.player.slot = slot;
        this.entries.push(this.player);
        continue;
      }
      const team = rivals[k++];
      const physics = new CarPhysics(path, path.gridPose(slot));
      const e = new Entry({ team, physics });
      e.slot = slot;
      e.retire = () => {
        if (e.retired || e.finished) return;
        e.retired = true;
        this.onRetire?.(e);
      };
      const ti = teams.indexOf(team);
      e.driver = new AIDriver(e, this.line, {
        pace: teamPace(ti, level),
        reaction: (([a, b]) => a + (b - a) * (((slot * 37) % 10) / 9))((LEVELS[level] ?? LEVELS.normal).reaction),
        seed: slot * 7919 + 13,
      });
      this.entries.push(e);
    }
    this.finishOrder = [];
    this.reset();
  }

  get ai() {
    return this.entries.filter((e) => !e.isPlayer);
  }

  /** Back to the grid. The player's physics is reset by the caller. */
  reset() {
    this.time = 0;
    this.sinceGreen = 0;
    this.finishOrder = [];
    this.leaderDone = false;
    for (const e of this.entries) {
      const pose = this.path.gridPose(e.slot);
      if (!e.isPlayer) {
        e.physics.reset(pose);
      }
      // grid slot sits behind the line: progress starts negative
      e.progress = -(11 + e.slot * 8);
      e.prevS = null;
      e.stamps = [];
      e.lap = 0;
      e.finished = false;
      e.finishTime = null;
      e.flagAt = undefined;
      e.retired = false;
      if (e.driver) {
        e.driver.gridLat = undefined;
        e.driver.offset = e.driver.offsetTarget = 0;
        e.driver.stuck = 0;
        e.driver.rec = null;
        e.driver.tries = 0;
        e.driver.parking = null;
      }
    }
    this.rank();
  }

  /** The grid pose of the player's slot. */
  playerGrid() {
    return this.path.gridPose(this.player.slot);
  }

  /**
   * Step every AI car (the player's car is stepped by the caller first), then car-to-car
   * contact, progress and positions.
   */
  stepAI(holding, dt, settings = {}) {
    this.time += dt;
    if (!holding) this.sinceGreen += dt;
    for (const e of this.entries) {
      if (e.isPlayer) continue;
      const p = e.physics;
      if (settings.damage !== undefined) p.damageOn = settings.damage;
      if (settings.resets !== undefined) e.driver.resets = settings.resets;
      // retired: parked where it stopped (other cars can still shove it)
      if (e.retired) {
        p.step({ hold: true }, dt);
        continue;
      }
      // finished: cruise round at a gentle pace
      const ctl = e.driver.drive(this.entries, holding ? 0 : this.sinceGreen, dt);
      if (e.finished) {
        ctl.throttle = p.speed < 35 ? ctl.throttle : 0;
      }
      p.step(holding ? { ...ctl, hold: true } : ctl, dt);
    }
    collideCars(this.entries);
    const L = this.path.length;
    for (const e of this.entries) {
      e.track(L, this.time);
      const lap = Math.floor(e.progress / L) + 1; // lap 1 starts at the line
      if (lap > e.lap && e.progress >= 0) e.lap = lap;
      if (!e.finished && !e.retired && e.progress >= (e.flagAt ?? this.laps * L)) {
        e.finished = true;
        e.finishTime = this.sinceGreen;
        this.finishOrder.push(e);
        if (!this.leaderDone) {
          // the leader has the flag: everyone else finishes the next time they cross the line
          this.leaderDone = true;
          for (const o of this.entries) if (!o.finished && !o.retired) o.flagAt = Math.min(this.laps * L, (Math.floor(o.progress / L) + 1) * L);
        }
        this.onFinish?.(e, this.finishOrder.length);
      }
    }
    this.rank();
  }

  rank() {
    const sorted = [...this.entries].sort((a, b) => {
      if (a.finished && b.finished) return this.finishOrder.indexOf(a) - this.finishOrder.indexOf(b);
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.retired !== b.retired) return a.retired ? 1 : -1; // retired cars at the bottom
      return b.progress - a.progress;
    });
    sorted.forEach((e, i) => (e.position = i + 1));
    this.order = sorted;
  }

  /** Time gap (s) from `e` back to `ahead`: how long ago `ahead` was where `e` is now. */
  gapTo(e, ahead) {
    const k = Math.floor((e.progress + STAMP_OFFSET) / STAMP);
    const t = ahead.stamps[k];
    return t === undefined ? 0 : Math.max(0, this.time - t);
  }
}

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
