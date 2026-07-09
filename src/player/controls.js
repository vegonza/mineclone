/**
 * Keyboard + mouse input with pointer lock.
 * Raw state lives in `input`; discrete actions are dispatched as callbacks.
 */
const LOOK_SENSITIVITY = 0.0022;
const PITCH_LIMIT = Math.PI / 2 - 0.0015;
const DOUBLE_TAP_MS = 280;

export class Controls {
  constructor(canvas, player, handlers = {}) {
    this.canvas = canvas;
    this.player = player;
    this.handlers = handlers;

    this.locked = false;
    this.enabled = true;
    this.sensitivity = 1;

    this.input = {
      forward: 0,
      strafe: 0,
      jump: false,
      sneak: false,
      sprint: false,
    };

    this.mouse = [false, false, false];
    this.breakTimer = 0;
    this.placeTimer = 0;

    this._keys = new Set();
    this._lastSpace = 0;

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseUp = this._onMouseUp.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._onPointerLockChange = this._onPointerLockChange.bind(this);
    this._onContextMenu = (e) => e.preventDefault();

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('wheel', this._onWheel, { passive: false });
    window.addEventListener('blur', () => this._releaseAll());
    document.addEventListener('pointerlockchange', this._onPointerLockChange);
    canvas.addEventListener('contextmenu', this._onContextMenu);
  }

  requestLock() {
    this.canvas.requestPointerLock?.();
  }

  exitLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  _onPointerLockChange() {
    this.locked = document.pointerLockElement === this.canvas;
    document.body.classList.toggle('playing', this.locked);
    if (!this.locked) {
      this._releaseAll();
      this.handlers.onLockLost?.();
    }
  }

  _releaseAll() {
    this._keys.clear();
    this.input.forward = 0;
    this.input.strafe = 0;
    this.input.jump = false;
    this.input.sneak = false;
    this.input.sprint = false;
    this.mouse[0] = this.mouse[1] = this.mouse[2] = false;
  }

  _syncAxes() {
    const k = this._keys;
    this.input.forward = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    this.input.strafe = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    this.input.jump = k.has('Space');
    this.input.sneak = k.has('ShiftLeft') || k.has('ShiftRight');
    this.input.sprint = k.has('ControlLeft') || k.has('ControlRight');
  }

  _onKeyDown(e) {
    if (e.repeat) {
      if (e.code === 'F3' || e.code === 'F5') e.preventDefault();
      return;
    }

    // These work whether or not the pointer is locked.
    switch (e.code) {
      case 'Escape':
        this.handlers.onPause?.();
        return;
      case 'KeyE':
        e.preventDefault();
        this.handlers.onToggleInventory?.();
        return;
      case 'F3':
        e.preventDefault();
        this.handlers.onToggleDebug?.();
        return;
      case 'F5':
        e.preventDefault();
        this.handlers.onCycleCamera?.();
        return;
      case 'F11':
        return; // let the browser handle fullscreen
    }

    if (!this.enabled || !this.locked) return;

    if (e.code.startsWith('Digit')) {
      const n = Number(e.code.slice(5));
      if (n >= 1 && n <= 9) {
        this.handlers.onSelectSlot?.(n - 1);
        return;
      }
    }

    switch (e.code) {
      case 'Space': {
        const now = performance.now();
        if (now - this._lastSpace < DOUBLE_TAP_MS) {
          this.handlers.onToggleFly?.();
          this._lastSpace = 0;
        } else {
          this._lastSpace = now;
        }
        e.preventDefault();
        break;
      }
      case 'KeyT':
        this.handlers.onSkipTime?.();
        break;
      case 'KeyN':
        this.handlers.onFreezeTime?.();
        break;
      case 'KeyR':
        this.handlers.onRespawn?.();
        break;
      case 'Tab':
        e.preventDefault();
        break;
    }

    this._keys.add(e.code);
    this._syncAxes();
  }

  _onKeyUp(e) {
    this._keys.delete(e.code);
    this._syncAxes();
  }

  _onMouseMove(e) {
    if (!this.locked || !this.enabled) return;
    const p = this.player;
    p.yaw -= e.movementX * LOOK_SENSITIVITY * this.sensitivity;
    p.pitch -= e.movementY * LOOK_SENSITIVITY * this.sensitivity;
    p.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, p.pitch));
    if (p.yaw > Math.PI) p.yaw -= Math.PI * 2;
    else if (p.yaw < -Math.PI) p.yaw += Math.PI * 2;
  }

  _onMouseDown(e) {
    if (!this.enabled) return;
    if (!this.locked) {
      if (e.target === this.canvas) this.handlers.onCanvasClick?.();
      return;
    }
    this.mouse[e.button] = true;
    if (e.button === 0) {
      this.breakTimer = 0;
      this.handlers.onBreak?.();
    } else if (e.button === 2) {
      this.placeTimer = 0;
      this.handlers.onPlace?.();
    } else if (e.button === 1) {
      e.preventDefault();
      this.handlers.onPick?.();
    }
  }

  _onMouseUp(e) {
    this.mouse[e.button] = false;
  }

  _onWheel(e) {
    if (!this.locked || !this.enabled) return;
    e.preventDefault();
    this.handlers.onScrollSlot?.(Math.sign(e.deltaY));
  }

  /** Handles auto-repeat while a mouse button is held down. */
  update(dt) {
    if (!this.locked || !this.enabled) return;
    if (this.mouse[0]) {
      this.breakTimer -= dt;
      if (this.breakTimer <= 0) {
        this.breakTimer = 0.19;
        this.handlers.onBreak?.();
      }
    }
    if (this.mouse[2]) {
      this.placeTimer -= dt;
      if (this.placeTimer <= 0) {
        this.placeTimer = 0.22;
        this.handlers.onPlace?.();
      }
    }
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mouseup', this._onMouseUp);
    window.removeEventListener('wheel', this._onWheel);
    document.removeEventListener('pointerlockchange', this._onPointerLockChange);
    this.canvas.removeEventListener('contextmenu', this._onContextMenu);
  }
}
