// Director window: M opens a second browser window (put it on another screen) laid out like
// a broadcast director's monitor wall:
//  - a main screen with one car's onboard view (C in that window: onboard / chase),
//  - a highlights screen: the incident monitor's crashes, spins and their replays
//    (src/incidents.js), shown whenever there is one,
//  - the running order, and a strip of small onboard monitors, one per car.
// Click any small monitor (or the highlight) to put that car on the main screen.
//
// The game's own renderer draws into the window's canvases (three.js CanvasTarget: one GPU
// device, several canvases), so nothing is loaded twice. The small monitors take turns,
// TILE_PER_FRAME a frame, as each one is a whole extra render of the scene.
import * as THREE from 'three/webgpu';

const TILES = 11;
const TILE_PER_FRAME = 2;
const MAIN_FAR = 2500, TILE_FAR = 600; // m
const CAPTION_EVERY = 0.25; // s
// T-cam on the airbox, in the car's body frame, and a point far ahead to look at
const TCAM = new THREE.Vector3(0, 1.22, -0.3);
const AHEAD = new THREE.Vector3(0, 0.6, 20);
const VIEWS = ['onboard', 'chase'];

const CSS = `
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:#07090d;color:#fff;font:13px/1.3 system-ui,-apple-system,sans-serif;overflow:hidden}
body{display:grid;grid-template-columns:1fr minmax(260px,26vw);grid-template-rows:minmax(0,1fr) auto;gap:8px;padding:8px}
.screen{position:relative;border-radius:8px;overflow:hidden;background:#000;cursor:pointer}
.screen canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.cap{position:absolute;left:0;right:0;bottom:0;display:flex;gap:8px;align-items:baseline;padding:4px 10px;white-space:nowrap;overflow:hidden;background:linear-gradient(transparent,rgba(0,0,0,.75));text-shadow:0 1px 2px #000}
.cap b{font-weight:800}.cap small{margin-left:auto;color:#aab2c0;font-size:11px}
#main{grid-row:1;grid-column:1;box-shadow:inset 0 0 0 2px var(--team,#333);cursor:default}
#main .cap{font-size:16px;padding:8px 14px}
#side{grid-row:1;grid-column:2;display:flex;flex-direction:column;gap:8px;min-height:0}
#hl{aspect-ratio:16/9;flex:none;box-shadow:inset 0 0 0 2px var(--team,#2a2f3a)}
#hl .empty{position:absolute;inset:0;display:grid;place-items:center;padding:16px;text-align:center;color:#59606d;font-size:12px;letter-spacing:.12em}
[hidden]{display:none!important}
#hl i{font-style:normal;font-weight:800;font-size:11px;padding:1px 6px;border-radius:4px;background:rgba(0,0,0,.55)}
#hl i.live{color:#ff4d4d}#hl i.replay{color:#ffd400}
h3{margin:2px 2px 0;font-size:11px;letter-spacing:.14em;color:#8b93a3}
#order{list-style:none;margin:0;padding:0;overflow:auto;flex:1;min-height:0}
#order li{display:grid;grid-template-columns:22px 4px 1fr auto;gap:6px;align-items:center;padding:2px 6px;border-radius:4px;cursor:pointer}
#order li:hover{background:#ffffff14}#order li.on{background:#3d7bff33}
#order li i{height:13px;border-radius:2px}#order li .p{color:#8b93a3;text-align:right}#order li .g{color:#c9cfdb;font-variant-numeric:tabular-nums}
#tiles{grid-row:2;grid-column:1/3;display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px}
.tile{aspect-ratio:16/9;box-shadow:inset 0 0 0 1.5px color-mix(in srgb,var(--team,#666) 70%,transparent)}
.tile .cap{font-size:11px;padding:2px 6px}
.tile.on{box-shadow:inset 0 0 0 3px #fff}.tile.out{opacity:.4}.tile:hover{box-shadow:inset 0 0 0 2px #fff}
`;

export class Director {
  constructor() {
    this.win = null;
    this.focus = null; // the race entry on the main screen
    this.view = 0; // index into VIEWS
    this.turn = 0;
    this.captionAt = -1;
    this.chaseYaw = null;
    this._v = new THREE.Vector3();
  }

  get open() {
    return !!this.win && !this.win.closed;
  }

  /** Is the director window the one with the focus (so the game shouldn't pause)? */
  hasFocus() {
    try {
      return this.open && this.win.document.hasFocus();
    } catch {
      return false;
    }
  }

  /** M: open or close. Returns 'open', 'closed' or 'blocked' (pop-ups blocked). */
  toggle() {
    if (this.open) {
      this.win.close();
      this.cleanup();
      return 'closed';
    }
    return this.openWindow() ? 'open' : 'blocked';
  }

  openWindow() {
    const w = window.open('', 'vibegp-director', 'popup,width=1320,height=860');
    if (!w) return false;
    this.cleanup();
    this.win = w;
    const d = w.document;
    d.title = 'Vibe GP · Director';
    d.head.innerHTML = `<meta charset="utf-8"><style>${CSS}</style>`;
    d.body.innerHTML = `
      <div id="main" class="screen"><canvas></canvas><div class="cap"></div></div>
      <div id="side">
        <div id="hl" class="screen"><canvas></canvas><div class="empty">HIGHLIGHTS · CRASHES AND SPINS SHOW UP HERE</div><div class="cap"></div></div>
        <h3>RUNNING ORDER</h3><ol id="order"></ol>
      </div>
      <div id="tiles"></div>`;
    const screen = (el, far) => {
      const canvas = el.querySelector('canvas');
      return { el, canvas, ct: new THREE.CanvasTarget(canvas), cam: new THREE.PerspectiveCamera(60, 16 / 9, 0.1, far), cap: el.querySelector('.cap') };
    };
    this.main = screen(d.getElementById('main'), MAIN_FAR);
    this.hl = screen(d.getElementById('hl'), 2500);
    this.hl.empty = d.querySelector('#hl .empty');
    this.hl.el.addEventListener('click', () => this.hlEntry && this.pick(this.hlEntry));
    this.tiles = [];
    const strip = d.getElementById('tiles');
    for (let i = 0; i < TILES; i++) {
      const el = d.createElement('div');
      el.className = 'screen tile';
      el.innerHTML = '<canvas></canvas><div class="cap"></div>';
      strip.appendChild(el);
      const t = { ...screen(el, TILE_FAR), entry: null, drawn: false };
      t.cam.fov = 70;
      el.addEventListener('click', () => t.entry && this.pick(t.entry));
      this.tiles.push(t);
    }
    this.order = d.getElementById('order');
    this.order.addEventListener('click', (ev) => {
      const li = ev.target.closest('li[data-i]');
      const e = li && this.race?.entries[+li.dataset.i];
      if (e) this.pick(e);
    });
    w.addEventListener('keydown', (ev) => {
      if (ev.code === 'KeyC') this.view = (this.view + 1) % VIEWS.length;
    });
    w.addEventListener('resize', () => (this.sized = false));
    w.addEventListener('pagehide', () => this.cleanup());
    this.sized = false;
    this.captionAt = -1;
    return true;
  }

  /** The window went away: let go of its canvases. */
  cleanup() {
    for (const s of [this.main, this.hl, ...(this.tiles ?? [])]) s?.ct.dispose();
    this.main = this.hl = this.tiles = null;
    this.win = null;
  }

  pick(e) {
    this.focus = e;
    this.chaseYaw = null;
    this.captionAt = -1;
  }

  /** Size every canvas to its box in the window. */
  resize() {
    const dpr = Math.min(this.win.devicePixelRatio || 1, 1.5);
    for (const s of [this.main, this.hl, ...this.tiles]) {
      const r = s.el.getBoundingClientRect();
      const w = Math.max(16, Math.round(r.width)), h = Math.max(9, Math.round(r.height));
      s.ct.setPixelRatio(s === this.main ? dpr : 1);
      s.ct.setSize(w, h, false);
      s.cam.aspect = w / h;
      s.cam.updateProjectionMatrix();
    }
    this.sized = true;
  }

  /**
   * Which car each screen shows, and (now and then) the captions and running order. monitor:
   * the IncidentMonitor, for the highlights screen's caption.
   */
  update(race, time, monitor) {
    if (!this.open) {
      if (this.win) this.cleanup();
      return;
    }
    this.race = race;
    const order = race ? race.order : [];
    if (!this.focus || !order.includes(this.focus)) this.pick(order[0] ?? null);
    this.tiles.forEach((t, i) => {
      t.entry = order[i] ?? null;
      t.el.hidden = !t.entry;
    });
    // highlights
    const s = monitor.shown;
    this.hlEntry = s?.entry ?? null;
    this.hl.empty.hidden = !!s;
    this.hl.canvas.style.visibility = s ? 'visible' : 'hidden';
    if (s) {
      if (this.hl.cap.innerHTML !== monitor.captionHTML) this.hl.cap.innerHTML = monitor.captionHTML;
      this.hl.el.style.setProperty('--team', s.entry.team.ui.primary);
    } else this.hl.cap.innerHTML = '';
    if (time - this.captionAt < CAPTION_EVERY && this.captionAt >= 0) return;
    this.captionAt = time;
    const kmh = (e) => Math.round(Math.abs(e.physics.speed) * 3.6);
    const state = (e) => (e.retired ? 'OUT' : e.finished ? 'FINISHED' : e.physics.onPitLane ? 'PIT' : `${kmh(e)} km/h`);
    const name = (e) => (e.isPlayer ? 'YOU' : e.team.name);
    for (const t of this.tiles) {
      const e = t.entry;
      if (!e) continue;
      t.cap.innerHTML = `<b>P${e.position}</b>${name(e)}<small>${state(e)}</small>`;
      t.el.style.setProperty('--team', e.team.ui.primary);
      t.el.classList.toggle('on', e === this.focus);
      t.el.classList.toggle('out', e.retired);
    }
    const f = this.focus;
    if (f) {
      const lap = race ? ` · LAP ${Math.min(Math.max(f.lap, 1), race.laps)}/${race.laps}` : '';
      this.main.cap.innerHTML = `<b>P${f.position}</b>${name(f).toUpperCase()}<span>${state(f)}${lap}</span><small>${VIEWS[this.view].toUpperCase()} · C: ${VIEWS[(this.view + 1) % VIEWS.length].toUpperCase()} · CLICK A MONITOR TO PUT IT HERE</small>`;
      this.main.el.style.setProperty('--team', f.team.ui.primary);
    }
    const leader = order[0];
    this.order.innerHTML = order.map((e) => {
      const gap = e.retired ? 'OUT' : e.physics.onPitLane ? 'PIT' : e === leader ? 'LEADER' : `+${race.gapTo(e, leader).toFixed(1)}`;
      return `<li data-i="${race.entries.indexOf(e)}" class="${e === f ? 'on' : ''}"><span class="p">${e.position}</span><i style="background:${e.team.ui.primary}"></i><span>${name(e)} <small style="color:${e.physics.compound?.css}">${e.physics.compound?.letter ?? ''}</small></span><span class="g">${gap}</span></li>`;
    }).join('');
  }

  /** Point a camera from car c's T-cam, or chase it (the main screen's chase view). */
  aim(cam, c, p, chase, dt) {
    const body = c.body;
    body.updateWorldMatrix(true, false);
    if (!chase) {
      cam.position.copy(body.localToWorld(this._v.copy(TCAM)));
      cam.lookAt(body.localToWorld(this._v.copy(AHEAD)));
      return;
    }
    const vl = Math.hypot(p.vel.x, p.vel.z);
    const want = vl > 3 ? p.yaw + Math.atan2(Math.sin(Math.atan2(p.vel.x, p.vel.z) - p.yaw), Math.cos(Math.atan2(p.vel.x, p.vel.z) - p.yaw)) * 0.35 : p.yaw;
    if (this.chaseYaw === null) this.chaseYaw = want;
    this.chaseYaw += Math.atan2(Math.sin(want - this.chaseYaw), Math.cos(want - this.chaseYaw)) * (1 - Math.exp(-6 * dt));
    const back = 6.5 + Math.abs(p.speed) * 0.012, y = (p.height ?? 0);
    cam.position.set(p.position.x - Math.sin(this.chaseYaw) * back, y + 2.1, p.position.z - Math.cos(this.chaseYaw) * back);
    cam.lookAt(p.position.x + Math.sin(p.yaw) * 4, y + 0.9, p.position.z + Math.cos(p.yaw) * 4);
  }

  /** The highlights screen's canvas target (for the incident monitor to draw into), or null. */
  get highlightTarget() {
    return this.open && this.sized ? this.hl.ct : null;
  }

  /** Draw the main screen and this frame's share of the small monitors. */
  render(renderer, scene, carOf, dt) {
    if (!this.open || !this.race) return;
    if (!this.sized) this.resize();
    const prev = renderer.getCanvasTarget();
    if (this.focus) {
      this.aim(this.main.cam, carOf(this.focus), this.focus.physics, VIEWS[this.view] === 'chase', dt);
      renderer.setCanvasTarget(this.main.ct);
      renderer.render(scene, this.main.cam);
    }
    const live = this.tiles.filter((t) => t.entry && !t.entry.retired);
    for (let k = 0; k < Math.min(TILE_PER_FRAME, live.length); k++) {
      const t = live[(this.turn + k) % live.length];
      this.aim(t.cam, carOf(t.entry), t.entry.physics, false, dt);
      renderer.setCanvasTarget(t.ct);
      renderer.render(scene, t.cam);
    }
    this.turn = (this.turn + TILE_PER_FRAME) % Math.max(1, live.length);
    renderer.setCanvasTarget(prev);
  }

  /** Every car's position while the window is open (the AI cars' level of detail). */
  get viewpoints() {
    return this.open && this.race ? this.race.entries.map((e) => e.physics.position) : null;
  }
}
