// Headless AI race: every car (the "player" too) driven by the AI on the real physics.
//
//   node scripts/ai-check.mjs <trackId> [laps] [opponents] [level: easy|normal|hard|expert]
//   NORESETS=1 node scripts/ai-check.mjs ...   (no-resets mode: stuck cars recover or retire)
//   CHAOS=0..1 node scripts/ai-check.mjs ...    (the AI chaos setting; default 0.4)
//
// Prints each car's best lap, finishing order, wall contact (touch: frames touching a wall;
// wall: frames with wallHit over 0.05, which holds from a hit while the car stays touching;
// pinned: runs of over 1 s touching a wall below 2 m/s), off-track time, respawns and its tyres: the compound of each stint (S-M: started on softs, one stop for mediums).
// Pit stops: how many, the time from entering the pit lane to leaving it, and the wall
// contact frames in the pit lane, by box (0 = the garage nearest the pit entry).
// logos.js builds Path2D objects at import time (browser only): stub it for Node
globalThis.location ??= { search: "" };
globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {} });
globalThis.Path2D ??= class { constructor() {} addPath() {} moveTo() {} lineTo() {} bezierCurveTo() {} quadraticCurveTo() {} arc() {} ellipse() {} rect() {} closePath() {} };
const { TRACKS } = await import('../src/tracks/index.js');
const { TrackPath } = await import('../src/trackPath.js');
const { CarPhysics } = await import('../src/physics.js');
const { TEAMS } = await import('../src/teams.js');
const { Race, AIDriver, teamPace, CONTACTS } = await import('../src/ai.js');
const { formatTime } = await import('../src/race.js');

const id = process.argv[2] || 'suzuka';
const laps = +(process.argv[3] || 3);
const opponents = +(process.argv[4] ?? 10);
const level = process.argv[5] ?? 'normal';
const def = TRACKS.find((t) => t.id === id);
const P = new TrackPath(def);
const playerTeam = TEAMS[TEAMS.length - 1];
const player = new CarPhysics(P, P.gridPose(0));
const t0 = performance.now();
const race = new Race(P, playerTeam, player, TEAMS, { opponents, laps, level, seed: +(process.env.SEED ?? 1), chaos: +(process.env.CHAOS ?? 0.4) });
console.log(`racing line built in ${(performance.now() - t0).toFixed(0)} ms; ${race.entries.length} cars, ${laps} laps of ${def.name} (${P.length.toFixed(0)} m)`);
player.reset(race.playerGrid());
race.player.driver = new AIDriver(race.player, race.line, { pace: teamPace(TEAMS.length - 1, level), seed: 99 });

const stats = new Map(race.entries.map((e) => [e, { wall: 0, touch: 0, pinRun: 0, pinned: 0, pinnedTime: 0, off: 0, respawn: 0, lapStart: null, best: Infinity, lastLap: 0 }]));
const origRespawn = AIDriver.prototype.respawn;
AIDriver.prototype.respawn = function (field) {
  stats.get(this.entry).respawn++;
  return origRespawn.call(this, field);
};
const pits = { stops: 0, laneTime: 0, wall: 0, byBox: new Map(), boxes: new Set() }; // pit lane totals
const inLane = new Map(); // entry -> race time it entered the pit lane
const stints = new Map(race.entries.map((e) => [e, [e.physics.compound.letter]]));
race.onPit = (e) => stints.get(e).push(`${e.physics.compound.letter}@${(e.progress / P.length).toFixed(1)}`);
console.log(`tyre wear x${race.wearScale.toFixed(2)} for the race distance`);
const dt = 1 / 120;
let hold = 3.6;
const tSim = performance.now();
let frames = 0;
while (race.finishOrder.length < race.entries.filter((e) => !e.retired).length && race.time < 60 * 20) {
  const holding = hold > 0;
  hold -= dt;
  const ctl = race.player.driver.drive(race.entries, holding ? 0 : race.sinceGreen, dt);
  player.step(holding ? { ...ctl, hold: true } : ctl, dt);
  race.stepAI(holding, dt, { resets: !process.env.NORESETS });
  frames++;
  for (const e of race.entries) {
    const s = stats.get(e);
    if (e.physics.wallHit > 0.05) s.wall++;
    if (e.physics.wallTouch) s.touch++;
    // pinned: touching a wall at a crawl, frame after frame
    if (e.physics.wallTouch && Math.abs(e.physics.speed) < 2) {
      s.pinRun += dt;
      if (s.pinRun > 1 && s.pinRun - dt <= 1) s.pinned++;
    } else {
      if (s.pinRun > 1) s.pinnedTime += s.pinRun;
      s.pinRun = 0;
    }
    const box = e.pitStop?.box?.k;
    if (e.physics.onPitLane) {
      if (!inLane.has(e)) inLane.set(e, { t: race.time, stints: stints.get(e).length });
      if (e.physics.wallHit > 0.05) {
        pits.wall++;
        pits.byBox.set(box, (pits.byBox.get(box) ?? 0) + 1);
      }
    } else if (inLane.has(e)) {
      // a stop: serviced on this run down the lane (not a respawn out of it, or a missed box)
      const lane = inLane.get(e);
      if (stints.get(e).length > lane.stints) {
        pits.stops++;
        pits.laneTime += race.time - lane.t;
        pits.boxes.add(box);
      }
      inLane.delete(e);
    }
    if (['grass', 'gravel', 'runoff'].includes(e.physics.surface)) s.off++;
    if (e.lap !== s.lastLap && e.lap >= 1) {
      if (s.lapStart !== null && !e.finished) s.best = Math.min(s.best, race.time - s.lapStart);
      if (s.lapStart !== null && e.finished && s.lastLap < e.lap) s.best = Math.min(s.best, race.time - s.lapStart);
      s.lapStart = race.time;
      s.lastLap = e.lap;
    }
  }
}
const ms = performance.now() - tSim;
for (const s of stats.values()) if (s.pinRun > 1) s.pinnedTime += s.pinRun;
{
  const all = [...stats.values()], sum = (k) => all.reduce((a, s) => a + s[k], 0);
  console.log(`wall contact: ${sum('touch')} frames touching (${sum('wall')} with wallHit > 0.05); pinned ${sum('pinned')} times, ${sum('pinnedTime').toFixed(1)} s (over 1 s touching below 2 m/s)`);
}
console.log(`car-to-car contacts: ${CONTACTS.touches} (hard, > 5 m/s: ${CONTACTS.hard}), launches: ${CONTACTS.launches}`);
if (CONTACTS.parts.size) console.log(`  by parts: ${[...CONTACTS.parts].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}`);
console.log(`pit stops: ${pits.stops} (boxes ${[...pits.boxes].sort((a, b) => a - b).join(' ')}), pit lane ${pits.stops ? (pits.laneTime / pits.stops).toFixed(1) : '--'} s a stop on average; pit-lane wall frames ${pits.wall}${pits.wall ? ` (by box: ${[...pits.byBox].sort((a, b) => a[0] - b[0]).map(([k, n]) => `${k}: ${n}`).join(', ')})` : ''}`);
console.log(`simulated ${(race.time).toFixed(0)} s in ${(ms / 1000).toFixed(1)} s (${((ms / frames) * 1000 / race.entries.length).toFixed(0)} µs per car-step)`);
for (const e of race.order) {
  const s = stats.get(e);
  console.log(`P${String(e.position).padEnd(3)} ${e.team.name.padEnd(13)} grid ${String(e.slot + 1).padStart(2)}  ${e.finished ? formatTime(e.finishTime) : e.retired ? 'RETIRED  ' : 'DNF      '}  best ${s.best < Infinity ? formatTime(s.best) : '--'}  pace ${e.driver.pace.toFixed(3)} ${(e.style?.name ?? '').padEnd(10)} ${stints.get(e).join('-').padEnd(16)} wear ${Math.round(Math.max(...e.physics.wheels.map((w) => w.wear)) * 100)}%  touch ${String(s.touch).padStart(4)}  wall ${String(s.wall).padStart(4)}  pinned ${s.pinned}  off ${(s.off * dt).toFixed(1).padStart(5)} s  respawns ${s.respawn}  mistakes ${e.driver?.mistakes ?? 0}${e.driver?.missedBox ? `  MISSED BOX ${e.driver.missedBox}` : ''}`);
}
