// Keyboard + mouse state. Pointer lock is requested by the game on click.
export interface Bindings { forward: string[]; back: string[]; left: string[]; right: string[]; jump: string[]; crouch: string[]; reload: string[]; walk: string[]; scoreboard: string[]; chat: string[]; menu: string[] }

export const DEFAULT_BINDINGS: Bindings = {
  forward: ['KeyW', 'ArrowUp'], back: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
  jump: ['Space'], crouch: ['ControlLeft', 'KeyC', 'ShiftLeft'], reload: ['KeyR'], walk: ['ShiftRight'],
  scoreboard: ['Tab'], chat: ['Enter', 'KeyT'], menu: ['Escape'],
};

export class Input {
  keys = new Set<string>();
  mouseDX = 0; mouseDY = 0;
  fire = false;        // left button held
  fireQueued = false;  // a click that happened this frame (semi-auto)
  aim = false;         // right button held
  wheel = 0;
  locked = false;
  sensitivity = 0.0022;
  onKey: (code: string, down: boolean) => void = () => {};
  onLockChange: (locked: boolean) => void = () => {};
  private el: HTMLElement;

  constructor(el: HTMLElement) {
    this.el = el;
    window.addEventListener('keydown', e => {
      if (e.repeat) { if (e.code === 'Tab') e.preventDefault(); return; }
      this.keys.add(e.code);
      this.onKey(e.code, true);
      if (['Tab', 'Space'].includes(e.code) && this.locked) e.preventDefault();
    });
    window.addEventListener('keyup', e => { this.keys.delete(e.code); this.onKey(e.code, false); });
    window.addEventListener('blur', () => { this.keys.clear(); this.fire = false; this.aim = false; });
    document.addEventListener('mousemove', e => {
      if (!this.locked) return;
      this.mouseDX += e.movementX; this.mouseDY += e.movementY;
    });
    document.addEventListener('mousedown', e => {
      if (!this.locked) return;
      if (e.button === 0) { this.fire = true; this.fireQueued = true; }
      if (e.button === 2) this.aim = true;
    });
    document.addEventListener('mouseup', e => {
      if (e.button === 0) this.fire = false;
      if (e.button === 2) this.aim = false;
    });
    document.addEventListener('contextmenu', e => { if (this.locked) e.preventDefault(); });
    document.addEventListener('wheel', e => { if (this.locked) this.wheel += Math.sign(e.deltaY); }, { passive: true });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.el;
      if (!this.locked) { this.keys.clear(); this.fire = false; this.aim = false; }
      this.onLockChange(this.locked);
    });
  }

  lock() { this.el.requestPointerLock?.({ unadjustedMovement: true } as any)?.catch?.(() => this.el.requestPointerLock()); }
  unlock() { document.exitPointerLock(); }

  down(codes: string[]) { for (const c of codes) if (this.keys.has(c)) return true; return false; }

  /** Consume per-frame deltas. */
  take() {
    const r = { dx: this.mouseDX, dy: this.mouseDY, wheel: this.wheel, fireQueued: this.fireQueued };
    this.mouseDX = 0; this.mouseDY = 0; this.wheel = 0; this.fireQueued = false;
    return r;
  }
}
