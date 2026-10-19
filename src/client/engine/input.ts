// Keyboard + mouse state. Pointer lock is requested by the game on click.
// Where pointer lock does not exist or is refused (iPad Safari, even with a Magic Keyboard), the input falls
// back to a "soft lock": locked is true, the cursor is hidden over the canvas, and look comes from movementX/Y
// or, when the browser reports none, from the change in clientX/Y. In soft mode the real cursor is not
// captured, so look stops when it reaches the screen edge; lift and re-place a finger on the trackpad or
// press Escape and click again. A one-finger drag on the canvas also looks around (touch-only iPads).
export interface Bindings { forward: string[]; back: string[]; left: string[]; right: string[]; jump: string[]; crouch: string[]; reload: string[]; walk: string[]; scoreboard: string[]; chat: string[]; menu: string[] }

export const DEFAULT_BINDINGS: Bindings = {
  forward: ['KeyW', 'ArrowUp'], back: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
  jump: ['Space'], crouch: ['ControlLeft', 'KeyC', 'ShiftLeft'], reload: ['KeyR'], walk: ['ShiftRight'],
  scoreboard: ['Tab'], chat: ['Enter', 'KeyT'], menu: ['Escape'],
};

/** How long to wait for pointerlockchange before falling back to soft lock. */
const SOFT_LOCK_WAIT_MS = 300;

export class Input {
  keys = new Set<string>();
  mouseDX = 0; mouseDY = 0;
  fire = false;        // left button held
  fireQueued = false;  // a click that happened this frame (semi-auto)
  aim = false;         // right button held
  wheel = 0;
  locked = false;
  /** True while locked without the Pointer Lock API (see the header comment). */
  soft = false;
  sensitivity = 0.0022;
  onKey: (code: string, down: boolean) => void = () => {};
  onLockChange: (locked: boolean) => void = () => {};
  /** False where the browser has no Pointer Lock API at all. */
  readonly hardLockAvailable = typeof HTMLElement !== 'undefined' && 'requestPointerLock' in HTMLElement.prototype;
  private el: HTMLElement;
  private hardWorked = false;          // pointer lock succeeded once: later refusals are transient (desktop re-lock cooldown)
  private lockTimer = 0;
  private lastX: number | null = null; private lastY: number | null = null;
  private touchId: number | null = null; private touchX = 0; private touchY = 0;

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
      if (!this.soft) { this.mouseDX += e.movementX; this.mouseDY += e.movementY; return; }
      let dx = e.movementX || 0, dy = e.movementY || 0;
      if (!dx && !dy && this.lastX !== null && this.lastY !== null) { dx = e.clientX - this.lastX; dy = e.clientY - this.lastY; }
      this.lastX = e.clientX; this.lastY = e.clientY;
      this.mouseDX += dx; this.mouseDY += dy;
    });
    document.addEventListener('mousedown', e => {
      if (!this.locked) return;
      // soft mode: the cursor is free, so only presses on the canvas itself count (not menu buttons or chat)
      if (this.soft && e.target !== this.el) return;
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
      const hard = document.pointerLockElement === this.el;
      if (hard) { this.hardWorked = true; clearTimeout(this.lockTimer); this.soft = false; this.el.style.cursor = ''; }
      else if (this.soft) return; // a late or failed hard request must not drop a soft lock
      this.locked = hard;
      if (!this.locked) { this.keys.clear(); this.fire = false; this.aim = false; }
      this.onLockChange(this.locked);
    });
    // touch look: one-finger drag on the canvas while soft-locked
    el.addEventListener('touchstart', e => {
      if (!this.soft || this.touchId !== null) return;
      const t = e.changedTouches[0];
      this.touchId = t.identifier; this.touchX = t.clientX; this.touchY = t.clientY;
    }, { passive: true });
    el.addEventListener('touchmove', e => {
      if (!this.soft) return;
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier !== this.touchId) continue;
        this.mouseDX += t.clientX - this.touchX; this.mouseDY += t.clientY - this.touchY;
        this.touchX = t.clientX; this.touchY = t.clientY;
        e.preventDefault();
      }
    }, { passive: false });
    const endTouch = (e: TouchEvent) => { for (const t of Array.from(e.changedTouches)) if (t.identifier === this.touchId) this.touchId = null; };
    el.addEventListener('touchend', endTouch);
    el.addEventListener('touchcancel', endTouch);
  }

  lock() {
    if (this.locked) return;
    const el = this.el as HTMLElement & { requestPointerLock?: (o?: unknown) => Promise<void> | void };
    if (typeof el.requestPointerLock !== 'function') { this.softLock(); return; }
    const fallback = () => { if (!this.locked && !this.hardWorked) this.softLock(); };
    clearTimeout(this.lockTimer);
    this.lockTimer = window.setTimeout(fallback, SOFT_LOCK_WAIT_MS);
    try {
      const p = el.requestPointerLock({ unadjustedMovement: true });
      p?.catch?.(() => {
        try { (el.requestPointerLock() as Promise<void> | undefined)?.catch?.(fallback); } catch { fallback(); }
      });
    } catch { fallback(); }
  }

  unlock() {
    if (this.soft) {
      clearTimeout(this.lockTimer);
      this.soft = false; this.locked = false; this.el.style.cursor = '';
      this.keys.clear(); this.fire = false; this.aim = false; this.touchId = null;
      this.onLockChange(false);
      return;
    }
    document.exitPointerLock?.();
  }

  private softLock() {
    if (this.locked) return;
    this.soft = true; this.locked = true;
    this.lastX = this.lastY = null;
    this.el.style.cursor = 'none';
    this.el.style.touchAction = 'none';
    this.onLockChange(true);
  }

  down(codes: string[]) { for (const c of codes) if (this.keys.has(c)) return true; return false; }

  /** Consume per-frame deltas. */
  take() {
    const r = { dx: this.mouseDX, dy: this.mouseDY, wheel: this.wheel, fireQueued: this.fireQueued };
    this.mouseDX = 0; this.mouseDY = 0; this.wheel = 0; this.fireQueued = false;
    return r;
  }
}
