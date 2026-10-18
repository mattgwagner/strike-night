// Local first-person controller over the shared box physics.
import { PLAYER, WEAPONS, type WeaponId } from '../../shared/constants';
import type { MapBox } from '../../shared/map';
import { canStand, eyeHeight, stepBody, type Body } from '../../shared/physics';
import type { Vec3 } from '../../shared/protocol';
import { DEFAULT_BINDINGS, type Input } from './input';

export class LocalPlayer {
  body: Body = { p: [0, 0, 0], v: [0, 0, 0], crouch: false, ground: true };
  yaw = 0; pitch = 0;
  alive = true;
  weapon: WeaponId = 'rifle';
  moving = false;
  speedFrac = 0;      // 0..1 how fast we're moving relative to walk speed
  bobPhase = 0;
  private wantJump = false;

  constructor(private input: Input, private solids: MapBox[]) {}

  spawn(p: Vec3, yaw: number) {
    this.body.p = [...p] as Vec3; this.body.v = [0, 0, 0]; this.body.ground = true; this.body.crouch = false;
    this.yaw = yaw; this.pitch = 0; this.alive = true;
  }

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
      if (inp.down(b.jump)) this.wantJump = true;
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
    // air control: keep momentum, nudge toward wish
    let vx = wx, vz = wz;
    if (!this.body.ground) {
      vx = this.body.v[0] * 0.98 + wx * 0.04;
      vz = this.body.v[2] * 0.98 + wz * 0.04;
    }
    stepBody(this.body, [vx, vz], dt, this.solids, this.wantJump && this.alive);
    this.wantJump = false;
    this.moving = (fx !== 0 || fz !== 0) && this.body.ground;
    this.speedFrac = Math.min(1, Math.hypot(this.body.v[0], this.body.v[2]) / PLAYER.walkSpeed);
    if (this.moving) this.bobPhase += dt * 10 * this.speedFrac; else this.bobPhase *= 0.9;
  }
}
