// The car's collision shape: a handful of 2.5D boxes, one per part. Each box is a
// rectangle in plan view that turns with the car's heading, plus a height range above the
// road. That is nearly as cheap as 2D, and it keeps the low front wing and the high rear
// wing apart: a nose can slide under a rear wing and hit the gearbox and rear tyres instead.
//
//   BOXES               the box table, in the car frame (x forward from the CoG, y left,
//                       h above the road)
//   carBoxes(car, out?) a car's boxes in world space (cached until the car moves)
//   boxOverlap(a, b)    separating-axis test of two world boxes: depth, normal and contact
//                       point, or null
//   boxCorners(b, out?) a world box's four plan-view corners
//
// Box positions come from the damage points (PARTS in damage.js) and the wheel layout
// (WHEELS in car.js), so each part's position is defined in one place. The heights are
// fitted to the car model (DEFAULT_SHAPE in car.js): press O in a race to see the boxes.

import { WHEELS } from './car.js';
import { PARTS } from './damage.js';

/** Plan-view bounds of the damage points of the named parts. */
function bounds(...names) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of PARTS) {
    if (!names.includes(p.part)) continue;
    for (const [x, y] of p.pts) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  }
  return { x0, x1, y0, y1 };
}

// Heights above the road (m), fitted to the car model
const H = {
  body: [0, 0.95], // floor up to the engine cover (the airbox pokes a little above)
  nose: [0.1, 0.55],
  wing: [0.04, 0.36], // front wing: the endplate's foot to its top
  rearWing: [0.6, 1.12], // rear wing: the endplate's foot to the flap's top
};
const NOSE = { tip: 2.95, halfWidth: 0.2 }; // the nose runs over the front wing to its tip

const body = bounds('floor', 'sidepod', 'engine'); // the floor edge, sidepods and gearbox
const wing = bounds('wing'); // both halves; each box takes one side
const rear = bounds('rearWing');
const CORNER = ['FL', 'FR', 'RL', 'RR'];

/**
 * The car's boxes in the car frame: x forward from the CoG, y left, h above the road.
 * part and i name the damage part (CarDamage) a box stands for, with i its side (0 left,
 * 1 right) or corner (FL, FR, RL, RR). 'body' covers the floor, sidepods and gearbox, and
 * 'nose' is the survival cell, which never breaks.
 * kind: 'solid' parts push cars apart, 'fragile' ones (wings) mostly break, 'wheel's push.
 */
export const BOXES = [
  { name: 'body', part: 'body', i: null, kind: 'solid', x0: body.x0, x1: body.x1, y0: body.y0, y1: body.y1, h0: H.body[0], h1: H.body[1] },
  { name: 'nose', part: 'nose', i: null, kind: 'solid', x0: body.x1, x1: NOSE.tip, y0: -NOSE.halfWidth, y1: NOSE.halfWidth, h0: H.nose[0], h1: H.nose[1] },
  { name: 'wingL', part: 'wing', i: 0, kind: 'fragile', x0: wing.x0, x1: wing.x1, y0: NOSE.halfWidth, y1: wing.y1, h0: H.wing[0], h1: H.wing[1] },
  { name: 'wingR', part: 'wing', i: 1, kind: 'fragile', x0: wing.x0, x1: wing.x1, y0: wing.y0, y1: -NOSE.halfWidth, h0: H.wing[0], h1: H.wing[1] },
  { name: 'rearWing', part: 'rearWing', i: null, kind: 'fragile', x0: rear.x0, x1: rear.x1, y0: rear.y0, y1: rear.y1, h0: H.rearWing[0], h1: H.rearWing[1] },
  ...WHEELS.map((w, c) => ({
    name: `wheel${CORNER[c]}`, part: 'tyre', i: c, kind: 'wheel',
    x0: w.x - w.r, x1: w.x + w.r, y0: w.y - w.w / 2, y1: w.y + w.w / 2, h0: 0, h1: 2 * w.r,
  })),
];

// each box's centre and half sizes in the car frame
const LOCAL = BOXES.map((d) => ({ mx: (d.x0 + d.x1) / 2, my: (d.y0 + d.y1) / 2, hx: (d.x1 - d.x0) / 2, hy: (d.y1 - d.y0) / 2 }));

const cache = new WeakMap(); // car → { x, z, yaw, h, boxes }

/**
 * The car's boxes in world space: { cx, cz, fx, fz, hx, hy, h0, h1, def }. Centre
 * (cx, cz); unit forward axis (fx, fz) = (sin yaw, cos yaw), left axis (fz, −fx); half
 * length hx, half width hy; world heights h0, h1 (road height + the box's); def its BOXES
 * entry. In BOXES order.
 *
 * Without `out`, the boxes are cached on the car and only worked out again once it has
 * moved, so a car is transformed once per step however many pairs it is tested in. The
 * returned objects are reused: read them, don't keep or change them. With `out`, fills
 * that array (and its objects) instead.
 */
export function carBoxes(car, out) {
  const p = car.position, yaw = car.yaw, h = car.height ?? 0;
  if (!out) {
    let c = cache.get(car);
    if (c && c.x === p.x && c.z === p.z && c.yaw === yaw && c.h === h) return c.boxes;
    if (!c) cache.set(car, (c = { boxes: [] }));
    c.x = p.x; c.z = p.z; c.yaw = yaw; c.h = h;
    out = c.boxes;
  }
  const fx = Math.sin(yaw), fz = Math.cos(yaw); // forward; left is (fz, -fx)
  for (let k = 0; k < BOXES.length; k++) {
    const def = BOXES[k], l = LOCAL[k];
    const b = (out[k] ??= {});
    b.cx = p.x + fx * l.mx + fz * l.my;
    b.cz = p.z + fz * l.mx - fx * l.my;
    b.fx = fx; b.fz = fz;
    b.hx = l.hx; b.hy = l.hy;
    b.h0 = h + def.h0; b.h1 = h + def.h1;
    b.def = def;
  }
  out.length = BOXES.length;
  return out;
}

/** A world box's plan-view corners, as [x, z, x, z, ...]: front left, front right, rear right, rear left. */
export function boxCorners(b, out = new Array(8)) {
  const ax = b.fx * b.hx, az = b.fz * b.hx; // half length along forward
  const bx = b.fz * b.hy, bz = -b.fx * b.hy; // half width along left
  out[0] = b.cx + ax + bx; out[1] = b.cz + az + bz;
  out[2] = b.cx + ax - bx; out[3] = b.cz + az - bz;
  out[4] = b.cx - ax - bx; out[5] = b.cz - az - bz;
  out[6] = b.cx - ax + bx; out[7] = b.cz - az + bz;
  return out;
}

// scratch space for the contact point: a's corners clipped against b (at most 8 points)
const polyA = new Float64Array(16), polyB = new Float64Array(16), cornersA = new Array(8);

/**
 * Overlap of two world boxes (from carBoxes): a separating-axis test over the four plan
 * axes (each box's forward and left) plus their height ranges. Boxes that only touch
 * don't overlap. Returns null, or { depth, nx, nz, px, pz }: how far they overlap along
 * the axis they overlap least on, that axis as the unit normal pointing from a to b
 * (moving b by depth along it separates them), and the contact point: the centre of the
 * area where the two rectangles overlap.
 */
export function boxOverlap(a, b) {
  if (a.h1 <= b.h0 || b.h1 <= a.h0) return null;
  const dx = b.cx - a.cx, dz = b.cz - a.cz;
  let depth = Infinity, nx = 0, nz = 0;
  for (let k = 0; k < 4; k++) {
    const box = k < 2 ? a : b;
    // forward (fx, fz), then left (fz, -fx)
    const ux = k % 2 ? box.fz : box.fx, uz = k % 2 ? -box.fx : box.fz;
    const ra = a.hx * Math.abs(a.fx * ux + a.fz * uz) + a.hy * Math.abs(a.fz * ux - a.fx * uz);
    const rb = b.hx * Math.abs(b.fx * ux + b.fz * uz) + b.hy * Math.abs(b.fz * ux - b.fx * uz);
    const d = dx * ux + dz * uz;
    const o = ra + rb - Math.abs(d);
    if (o <= 0) return null; // a separating axis
    if (o < depth - 1e-9) {
      depth = o;
      const s = d < 0 ? -1 : 1;
      nx = ux * s; nz = uz * s;
    }
  }
  const [px, pz] = overlapCentre(a, b);
  return { depth, nx, nz, px, pz };
}

/** Centre of the area where a and b overlap in plan view: a's rectangle clipped by b's four sides. */
function overlapCentre(a, b) {
  boxCorners(a, cornersA);
  let src = polyA, dst = polyB, n = 4;
  for (let k = 0; k < 8; k++) src[k] = cornersA[k];
  // b's sides: inside where (p − c)·u ≤ half size, for u = ±forward, ±left
  for (let side = 0; side < 4 && n > 0; side++) {
    const s = side < 2 ? 1 : -1;
    const ux = (side % 2 ? b.fz : b.fx) * s, uz = (side % 2 ? -b.fx : b.fz) * s;
    const lim = side % 2 ? b.hy : b.hx;
    let m = 0;
    for (let k = 0; k < n; k++) {
      const j = (k + 1) % n;
      const x0 = src[2 * k], z0 = src[2 * k + 1], x1 = src[2 * j], z1 = src[2 * j + 1];
      const d0 = (x0 - b.cx) * ux + (z0 - b.cz) * uz - lim, d1 = (x1 - b.cx) * ux + (z1 - b.cz) * uz - lim;
      if (d0 <= 0) { dst[2 * m] = x0; dst[2 * m + 1] = z0; m++; }
      if ((d0 < 0 && d1 > 0) || (d0 > 0 && d1 < 0)) {
        const t = d0 / (d0 - d1);
        dst[2 * m] = x0 + (x1 - x0) * t; dst[2 * m + 1] = z0 + (z1 - z0) * t; m++;
      }
    }
    [src, dst] = [dst, src];
    n = m;
  }
  if (n === 0) return [(a.cx + b.cx) / 2, (a.cz + b.cz) / 2]; // only rounding left between them
  // area-weighted centroid; the plain average of the points if the area is next to nothing
  let area = 0, sx = 0, sz = 0, ax = 0, az = 0;
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    const x0 = src[2 * k], z0 = src[2 * k + 1], x1 = src[2 * j], z1 = src[2 * j + 1];
    const cr = x0 * z1 - x1 * z0;
    area += cr; sx += (x0 + x1) * cr; sz += (z0 + z1) * cr;
    ax += x0; az += z0;
  }
  if (Math.abs(area) < 1e-9) return [ax / n, az / n];
  return [sx / (3 * area), sz / (3 * area)];
}
