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

const LINE_MARGIN = 1.5; // m between the racing line and the edge of the asphalt (car half width + a bit)
const WALL_MARGIN = 2.2; // m between the racing line and a wall face
const CAR_R = 1.0; // collision circle radius, m
const CAR_CIRCLES = [-1.75, 0, 1.75]; // circle centres along the car, m from the CoG (car is ~5.6 m long)
const STAMP = 20, STAMP_OFFSET = 400; // timing loops every 20 m, from 400 m behind the line
const MASS = PARAMS.mass, INERTIA = PARAMS.yawInertia;

/** Minimum-curvature racing line and its speed profile for a TrackPath. */
export function racingLine(P, { gripUse = 1.15, brakeUse = 0.86 } = {}) {
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
  const g = (v) => PARAMS.baseGrip + PARAMS.downforceGrip * v * v;
  const vlim = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const a = P.wrap(i - 3), c = P.wrap(i + 3);
    let span = 0;
    for (let m = -3; m < 3; m++) span += seg[P.wrap(i + m)];
    const dh = Math.atan2(Math.sin(head[c] - head[a]), Math.cos(head[c] - head[a]));
    const kk = Math.max(Math.abs(dh) / span, 1e-5);
    let v = 10;
    for (let n = 0; n < 25; n++) v = Math.sqrt((g(v) * gripUse) / kk);
    // crests unload the car: keep v²·κ well under g there
    const crest = -P.vcurv[i];
    if (crest > 0) v = Math.min(v, Math.sqrt((9.81 * 0.7) / crest));
    vlim[i] = Math.min(v, 95);
  }
  // the slowest point of a corner governs the few metres around it (hairpin apexes are
  // sharper than a few samples can measure)
  {
    const w = Math.max(1, Math.round(8 / P.ds));
    const src = Float64Array.from(vlim);
    for (let i = 0; i < N; i++) {
      let m = src[i];
      for (let k = -w; k <= w; k++) m = Math.min(m, src[P.wrap(i + k)]);
      vlim[i] = m;
    }
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let i = N - 1; i >= 0; i--) {
      const j = P.wrap(i + 1);
      vlim[i] = Math.min(vlim[i], Math.sqrt(vlim[j] ** 2 + 2 * PARAMS.brakeDecel * brakeUse * seg[i]));
    }
  }
  const at = (arr, s) => {
    const f = (((s % P.length) + P.length) % P.length) / P.ds;
    const i = Math.floor(f) % N;
    return arr[i];
  };
  return {
    lat,
    vlim,
    /** Room for a car at s: { left, right } lateral limits (right is negative). */
    limits: (s) => ({ left: at(hi, s) + 0.3, right: at(lo, s) - 0.3 }),
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

    this.wobbleT -= dt;
    if (this.wobbleT <= 0) {
      this.wobbleT = 2 + this.rand() * 4;
      this.wobbleGoal = (this.rand() - 0.5) * 0.02;
    }
    this.wobble += ((this.wobbleGoal ?? 0) - this.wobble) * Math.min(1, dt * 0.5);

    const s = car.trackS;
    const v = Math.max(0, car.speed);
    const lineLat = this.line.latAt(s);
    let vt = this.line.vAt(s + 3) * (this.pace + this.wobble);
    // the car's own damage: no point charging at the limit with half a front wing
    vt *= 1 - 0.12 * Math.min(1, car.damage.wing[0] + car.damage.wing[1]);

    // --- traffic ---
    const { left: limL, right: limR } = this.line.limits(s);
    const clampLat = (x) => Math.max(limR, Math.min(limL, x));
    let follow = Infinity;
    let urgent = false; // something is closing fast: move across quicker
    const range = 40 + v * 2.2; // look further up the road the faster we go
    let blocker = null, blockerD = Infinity, blockerLine = 0, beside = null, besideDl = 0;
    for (const o of field) {
      if (o === this.entry) continue;
      const op = o.physics;
      const d = lapDelta(op.trackS, s, L);
      if (d <= -6 || d >= range) continue;
      const dl = op.lateral - car.lateral;
      // where our (offset) line will be when we get to it: the line can swing across the
      // road between here and there (Eau Rouge), so judge it there, not here
      const planned = this.line.latAt(s + d) + this.offset;
      const inPath = (d < 15 && Math.abs(dl) < 2.4) || Math.abs(op.lateral - planned) < 2.4;
      if (d > 4 && inPath) {
        const closing = v - op.speed;
        if (closing > 15 && d < closing * 3) urgent = true; // a slow or stopped car ahead
        // don't run into it: brake to its speed by the time we get within 7 m, unless
        // we'll already be clear of it by the time we get there
        const gap = d - 7;
        const safe = Math.sqrt(Math.max(0, op.speed) ** 2 + 2 * PARAMS.brakeDecel * 0.6 * Math.max(0, gap));
        if (Math.abs(op.lateral - planned) < 2.4 || d < 12) follow = Math.min(follow, gap <= 0 ? op.speed - 2 : safe);
        // the nearest car we're catching is the one to pass
        const needPass = closing > 1.5 || (vt > op.speed + 2 && d < 20);
        if (needPass && d < blockerD) {
          blocker = op;
          blockerD = d;
          blockerLine = planned - this.offset;
        }
      } else if (Math.abs(d) <= 6 && Math.abs(dl) < 3.2 && (!beside || Math.abs(dl) < Math.abs(besideDl))) {
        beside = op;
        besideDl = dl;
      }
    }
    let want = 0; // offset from the line we'd like (m)
    if (blocker) {
      // pass on the side with more room, but never across a car alongside us
      // (room and offsets measured where the other car is)
      const there = this.line.limits(s + blockerD);
      const roomL = there.left - blocker.lateral, roomR = blocker.lateral - there.right;
      let side = roomL > roomR ? 1 : -1;
      if (beside) side = besideDl > 0 ? -1 : 1;
      if ((side > 0 ? roomL : roomR) < 2.6) side = -side; // no room that side after all
      want = Math.max(there.right, Math.min(there.left, blocker.lateral + side * 2.9)) - blockerLine;
    } else if (beside) {
      // alongside: hold our side, give each other a car's width
      const side = besideDl > 0 ? -1 : 1; // the other car is left of us: lean right
      want = clampLat(beside.lateral + side * 3.0) - lineLat;
    }
    vt = Math.min(vt, follow);
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
    if (this.stuck > 3.5) {
      this.stuck = 0;
      this.respawn(field);
      return { steer: 0, throttle: 0, brake: 0 };
    }

    return {
      steer: Math.max(-1, Math.min(1, err * 3.5)),
      throttle: v < vt ? 1 : 0,
      brake: v > vt + 1.5 ? Math.min(1, (v - vt) / 4) : 0,
    };
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

/** Car-to-car contact for every pair in the field. */
export function collideCars(field) {
  for (let a = 0; a < field.length; a++) {
    for (let b = a + 1; b < field.length; b++) collidePair(field[a].physics, field[b].physics);
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
  if (vr >= 0) return;
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
export function teamPace(index, difficulty = 1) {
  return Math.min(0.985, (0.955 - index * 0.006) * difficulty);
}

/**
 * The race: the player plus `opponents` AI cars from the other teams. The grid lines up
 * in pace order with the player at the back (or `playerSlot`).
 */
export class Race {
  constructor(path, playerTeam, playerPhysics, teams, { opponents = 10, laps = 5, difficulty = 1, playerSlot = null } = {}) {
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
      const ti = teams.indexOf(team);
      e.driver = new AIDriver(e, this.line, {
        pace: teamPace(ti, difficulty),
        reaction: 0.15 + ((slot * 37) % 10) / 40,
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
      if (e.driver) {
        e.driver.offset = e.driver.offsetTarget = 0;
        e.driver.stuck = 0;
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
      if (!e.finished && e.progress >= (e.flagAt ?? this.laps * L)) {
        e.finished = true;
        e.finishTime = this.sinceGreen;
        this.finishOrder.push(e);
        if (!this.leaderDone) {
          // the leader has the flag: everyone else finishes the next time they cross the line
          this.leaderDone = true;
          for (const o of this.entries) if (!o.finished) o.flagAt = Math.min(this.laps * L, (Math.floor(o.progress / L) + 1) * L);
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
