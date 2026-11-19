// Free camera: V in a race or a solo run detaches the camera to fly anywhere. WASD move,
// Q / E down / up, Shift for speed, arrows or a mouse drag to look around, the wheel to
// dolly. While it's on the driving keys fly the camera, so the player's car drives itself
// (main.js puts it on the AI). V or C goes back to the camera views.
import * as THREE from 'three/webgpu';

const SPEED = 22; // m/s
const FAST = 5; // Shift multiplier
const TURN = 1.5; // rad/s with the arrow keys
const DRAG = 0.0035; // rad per pixel of mouse drag
const FOV = 60;

export class FreeCam {
  constructor(camera, dom) {
    this.camera = camera;
    this.active = false;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.drag = null;
    this.dolly = 0;
    dom.addEventListener('pointerdown', (e) => {
      if (!this.active || e.pointerType !== 'mouse' || e.button !== 0) return;
      this.drag = { x: e.clientX, y: e.clientY };
      dom.setPointerCapture?.(e.pointerId);
    });
    dom.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      this.yaw -= (e.clientX - this.drag.x) * DRAG;
      this.pitch -= (e.clientY - this.drag.y) * DRAG;
      this.drag = { x: e.clientX, y: e.clientY };
    });
    const end = () => (this.drag = null);
    dom.addEventListener('pointerup', end);
    dom.addEventListener('pointercancel', end);
    dom.addEventListener('wheel', (e) => {
      if (!this.active) return;
      e.preventDefault();
      this.dolly -= Math.sign(e.deltaY) * 3;
    }, { passive: false });
  }

  /** Start flying from wherever the camera is now, looking the same way. */
  start() {
    const cam = this.camera;
    this.active = true;
    this.pos.copy(cam.position);
    this.vel.set(0, 0, 0);
    const dir = cam.getWorldDirection(new THREE.Vector3());
    this.yaw = Math.atan2(dir.x, dir.z);
    this.pitch = Math.asin(Math.max(-1, Math.min(1, dir.y)));
    this.dolly = 0;
  }

  stop() {
    this.active = false;
    this.drag = null;
  }

  /** Once a frame while active (input: the keyboard Input). */
  update(input, dt) {
    const d = (code) => (input.down.has(code) ? 1 : 0);
    this.yaw += (d('ArrowLeft') - d('ArrowRight')) * TURN * dt;
    this.pitch += (d('ArrowUp') - d('ArrowDown')) * TURN * dt;
    this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch));
    const fwd = new THREE.Vector3(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch));
    const left = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const speed = SPEED * (input.down.has('ShiftLeft') || input.down.has('ShiftRight') ? FAST : 1);
    const want = new THREE.Vector3()
      .addScaledVector(fwd, d('KeyW') - d('KeyS'))
      .addScaledVector(left, d('KeyA') - d('KeyD'))
      .addScaledVector(new THREE.Vector3(0, 1, 0), d('KeyE') - d('KeyQ'));
    if (want.lengthSq() > 1) want.normalize();
    // ease in and out, so it glides like a camera on a crane rather than snapping
    this.vel.lerp(want.multiplyScalar(speed), 1 - Math.exp(-6 * dt));
    this.pos.addScaledVector(this.vel, dt);
    // mouse wheel: a quick dolly along the view
    if (this.dolly) {
      const step = this.dolly * Math.min(1, dt * 8);
      this.pos.addScaledVector(fwd, step * (speed / SPEED));
      this.dolly -= step;
      if (Math.abs(this.dolly) < 0.01) this.dolly = 0;
    }
    const cam = this.camera;
    cam.position.copy(this.pos);
    cam.lookAt(this.pos.x + fwd.x, this.pos.y + fwd.y, this.pos.z + fwd.z);
    cam.fov += (FOV - cam.fov) * (1 - Math.exp(-4 * dt));
    cam.updateProjectionMatrix();
  }
}
