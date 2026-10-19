// Local first-person controller over the shared box physics.
import { PLAYER, WEAPONS, type WeaponId } from '../../shared/constants';
import type { MapBox } from '../../shared/map';
import { canStand, eyeHeight, stepBody, type Body } from '../../shared/physics';
import type { Vec3 } from '../../shared/protocol';
import { DEFAULT_BINDINGS, type Input } from './input';

const GROUND_ACCEL = 10;    // × max speed per second
const GROUND_FRICTION = 10;
const AIR_ACCEL = 2.2;      // × wish per second
const STRIDE = 2.1;         // m between footsteps at full speed

export class LocalPlayer {
  body: Body = { p: [0, 0, 0], v: [0, 0, 0], crouch: false, ground: true };
  yaw = 0; pitch = 0;
  alive = true;
  weapon: WeaponId = 'semi';
  moving = false;
  speedFrac = 0;      // 0..1 how fast we're moving relative to walk speed
  bobPhase = 0;
  /** Smoothed eye height for the camera (physics crouch is instant). */
  viewEye: number = PLAYER.eyeHeight;
  /** Set on the step we touch down: 0..1 strength from fall speed. Consumer clears it. */
  landImpact = 0;
  /** Horizontal ground distance since the last footstep. */
  stepDist = 0;
  /** Set when a footstep is due (consumer clears it). Value = loudness 0..1. */
  footstep = 0;
  private jumpBuffer = 0;   // a press just before landing still jumps
  private jumpHeld = false;

  constructor(private input: Input, private solids: MapBox[]) {}

  spawn(p: Vec3, yaw: number) {
    this.body.p = [...p] as Vec3; this.body.v = [0, 0, 0]; this.body.ground = true; this.body.crouch = false;
    this.yaw = yaw; this.pitch = 0; this.alive = true;
    this.viewEye = PLAYER.eyeHeight; this.landImpact = 0; this.stepDist = 0; this.footstep = 0; this.jumpHeld = false; this.jumpBuffer = 0;
  }

  /** Camera eye: physics feet + smoothed eye height. Shots still use eye(). */
  viewEyePos(): Vec3 { return [this.body.p[0], this.body.p[1] + this.viewEye, this.body.p[2]]; }

  eye(): Vec3 { return [this.body.p[0], this.body.p[1] + eyeHeight(this.body.crouch), this.body.p[2]]; }

  look(dx: number, dy: number, sensMul = 1) {
    this.yaw -= dx * this.input.sensitivity * sensMul;
    this.pitch -= dy * this.input.sensitivity * sensMul;
    const lim = Math.PI / 2 - 0.01;
    if (this.pitch > lim) this.pitch = lim; if (this.pitch < -lim) this.pitch = -lim;
  }

  update(dt: number, allowMove: boolean) {
    const b = DEFAULT_BINDINGS;
    const inp = this.input;
    let fx = 0, fz = 0;
    if (allowMove && this.alive) {
      if (inp.down(b.forward)) fz += 1;
      if (inp.down(b.back)) fz -= 1;
      if (inp.down(b.right)) fx += 1;
      if (inp.down(b.left)) fx -= 1;
      // one jump per press: holding space does not auto-hop
      const jump = inp.down(b.jump);
      if (jump && !this.jumpHeld) this.jumpBuffer = 0.12;
      this.jumpHeld = jump;
      const wantCrouch = inp.down(b.crouch);
      if (wantCrouch && !this.body.crouch) this.body.crouch = true;
      else if (!wantCrouch && this.body.crouch && canStand(this.body.p, this.solids)) this.body.crouch = false;
    }
    const len = Math.hypot(fx, fz) || 1;
    fx /= len; fz /= len;
    const base = this.body.crouch ? PLAYER.crouchSpeed : PLAYER.walkSpeed;
    const walk = allowMove && inp.down(b.walk) ? 0.5 : 1;
    const speed = base * WEAPONS[this.weapon].speedMul * walk;
    // forward = (-sin yaw, -cos yaw); right = (cos yaw, -sin yaw)
    const wx = (-Math.sin(this.yaw) * fz + Math.cos(this.yaw) * fx) * speed;
    const wz = (-Math.cos(this.yaw) * fz - Math.sin(this.yaw) * fx) * speed;
    const v = this.body.v;
    const wishing = fx !== 0 || fz !== 0;
    let vx = v[0], vz = v[2];
    if (this.body.ground) {
      // accelerate toward the wish velocity; ~0.1 s to full speed or to a stop
      const accel = (wishing ? GROUND_ACCEL : GROUND_FRICTION) * Math.max(speed, PLAYER.crouchSpeed);
      const dx = wx - vx, dz = wz - vz;
      const dl = Math.hypot(dx, dz);
      const maxD = accel * dt;
      if (dl <= maxD) { vx = wx; vz = wz; } else { vx += dx / dl * maxD; vz += dz / dl * maxD; }
    } else if (wishing) {
      // air control: steer momentum, never gain speed beyond what we had (no bhop)
      const cap = Math.max(Math.hypot(vx, vz), speed * 0.35);
      vx += wx * AIR_ACCEL * dt; vz += wz * AIR_ACCEL * dt;
      const l = Math.hypot(vx, vz);
      if (l > cap) { vx *= cap / l; vz *= cap / l; }
    }
    const wasGround = this.body.ground, fallV = v[1];
    const px = this.body.p[0], pz = this.body.p[2];
    const doJump = this.jumpBuffer > 0 && this.body.ground && this.alive;
    stepBody(this.body, [vx, vz], dt, this.solids, doJump);
    this.jumpBuffer = doJump ? 0 : Math.max(0, this.jumpBuffer - dt);
    if (!wasGround && this.body.ground && fallV < -3) this.landImpact = Math.max(this.landImpact, Math.min(1, (-fallV - 3) / 11));
    if (!wasGround && this.body.ground && fallV < -3) this.footstep = Math.max(this.footstep, 0.8);
    this.moving = wishing && this.body.ground;
    this.speedFrac = Math.min(1, Math.hypot(this.body.v[0], this.body.v[2]) / PLAYER.walkSpeed);
    if (this.moving) this.bobPhase += dt * 10 * this.speedFrac; else this.bobPhase *= 0.9;
    // footsteps: one per stride, silent when walking slowly (shift-walk / crouch)
    if (this.body.ground) {
      this.stepDist += Math.hypot(this.body.p[0] - px, this.body.p[2] - pz);
      if (this.stepDist > STRIDE) { this.stepDist = 0; if (this.speedFrac > 0.6) this.footstep = Math.max(this.footstep, this.speedFrac); }
    }
    // smooth eye height (~120 ms for a full crouch)
    const target = eyeHeight(this.body.crouch);
    const rate = (PLAYER.eyeHeight - PLAYER.crouchEyeHeight) / 0.12 * dt;
    this.viewEye += Math.max(-rate, Math.min(rate, target - this.viewEye));
  }
}
