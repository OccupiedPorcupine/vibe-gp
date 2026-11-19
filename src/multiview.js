// Multiview: a grid of small onboard monitors along the bottom of the screen, one per car
// in race order, each showing the view from the camera on top of that car's airbox (the
// T-cam). M turns it on and off, in free cam too; click a monitor to watch that car.
//
// Each tile is a render target drawn on a quad hung on the main camera (see fitQuad in
// incidents.js), on the monitors' layer, so no tile camera ever sees a tile. Every scene
// render is a whole extra frame of draw calls, so the tiles take turns: PER_FRAME of them
// are redrawn each frame (about 11 fps each at 60 fps with a full grid).
import * as THREE from 'three/webgpu';
import { texture, uv, vec2 } from 'three/tsl';
import { MONITOR_LAYER, fitQuad } from './incidents.js';

const TILES = 11;
const RES = [320, 180];
const PER_FRAME = 2;
const FAR = 600; // m: the onboard cameras see less far than the main view (fewer objects to draw)
const CAPTION_EVERY = 0.25; // s between caption updates
// T-cam on the airbox, in the car's body frame, and a point far ahead to look at
const TCAM = new THREE.Vector3(0, 1.22, -0.3);
const AHEAD = new THREE.Vector3(0, 0.6, 20);

export class Multiview {
  constructor(camera) {
    this.camera = camera;
    this.on = false;
    this.el = document.getElementById('multiview');
    this.onPick = null; // (race entry) => void: a tile was clicked
    this.tiles = [];
    for (let i = 0; i < TILES; i++) {
      const el = document.createElement('div');
      el.className = 'mv-tile';
      el.innerHTML = '<div class="mv-view"></div><div class="mv-caption"></div>';
      el.addEventListener('click', () => this.tiles[i].entry && this.onPick?.(this.tiles[i].entry));
      this.el.appendChild(el);
      const target = new THREE.RenderTarget(RES[0], RES[1], { type: THREE.HalfFloatType, samples: 4 });
      target.texture.colorSpace = THREE.LinearSRGBColorSpace; // as the mirrors (see car.js)
      const mat = new THREE.MeshBasicNodeMaterial({ fog: false, depthTest: false, depthWrite: false });
      const u = uv();
      mat.colorNode = texture(target.texture, vec2(u.x, u.y.oneMinus())).rgb;
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
      quad.layers.set(MONITOR_LAYER);
      quad.renderOrder = 1000;
      quad.frustumCulled = false;
      quad.visible = false;
      camera.add(quad);
      this.tiles.push({
        el, view: el.querySelector('.mv-view'), caption: el.querySelector('.mv-caption'),
        target, quad, cam: new THREE.PerspectiveCamera(70, RES[0] / RES[1], 0.1, FAR),
        entry: null, drawn: false, rect: null,
      });
    }
    this.turn = 0;
    this.captionAt = 0;
    this._v = new THREE.Vector3();
    addEventListener('resize', () => (this.rects = null));
  }

  /** M: on / off. */
  toggle(on = !this.on) {
    this.on = on;
    this.el.hidden = !on;
    document.getElementById('hud').classList.toggle('mv-on', on); // (not .multiview: that's the grid's own class)
    this.rects = null;
    for (const t of this.tiles) {
      t.quad.visible = false;
      t.drawn = false;
    }
  }

  /** Which car each tile shows (race order), and the captions now and then. */
  update(race, time) {
    if (!this.on) return;
    const order = race ? race.order : [];
    this.tiles.forEach((t, i) => {
      const e = order[i] ?? null;
      t.entry = e;
      if (t.el.hidden !== !e) this.rects = null; // fewer cars: the grid reflows
      t.el.hidden = !e;
    });
    if (time - this.captionAt < CAPTION_EVERY && this.captionAt <= time) return;
    this.captionAt = time;
    for (const t of this.tiles) {
      const e = t.entry;
      if (!e) continue;
      const kmh = Math.round(Math.abs(e.physics.speed) * 3.6);
      const state = e.retired ? 'OUT' : e.finished ? 'FIN' : e.physics.onPitLane ? 'PIT' : `${kmh}`;
      t.caption.innerHTML = `<b>P${e.position}</b><span>${e.isPlayer ? 'YOU' : e.team.name}</span><em>${state}</em>`;
      t.el.style.setProperty('--team', e.team.ui.primary);
      t.el.classList.toggle('me', e.isPlayer);
      t.el.classList.toggle('out', e.retired);
    }
  }

  /** Redraw this frame's share of the tiles (before the main render) and line the quads up. */
  render(renderer, scene, carOf) {
    if (!this.on) return;
    const live = this.tiles.filter((t) => t.entry && !t.entry.retired);
    const prev = renderer.getRenderTarget();
    for (let k = 0; k < Math.min(PER_FRAME, live.length); k++) {
      const t = live[(this.turn + k) % live.length];
      const body = carOf(t.entry).body;
      body.updateWorldMatrix(true, false);
      t.cam.position.copy(body.localToWorld(this._v.copy(TCAM)));
      t.cam.lookAt(body.localToWorld(this._v.copy(AHEAD)));
      renderer.setRenderTarget(t.target);
      renderer.render(scene, t.cam);
      t.drawn = true;
    }
    this.turn = (this.turn + PER_FRAME) % Math.max(1, live.length);
    renderer.setRenderTarget(prev);
    if (!this.rects) this.rects = this.tiles.map((t) => t.view.getBoundingClientRect());
    this.tiles.forEach((t, i) => {
      // a retired car's last picture stays up, dimmed by its frame
      t.quad.visible = !!t.entry && t.drawn;
      if (t.quad.visible) fitQuad(t.quad, this.rects[i], this.camera);
    });
  }

  /** Every car's T-cam position while the grid is on (for the AI cars' level of detail). */
  get viewpoints() {
    return this.on ? this.tiles.filter((t) => t.entry).map((t) => t.entry.physics.position) : null;
  }
}
