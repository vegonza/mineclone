import { BLOCKS, DEFAULT_HOTBAR } from '../core/blocks.js';
import { blockIconCanvas } from '../core/textures.js';

const HOTBAR_SIZE = 9;

export class Hud {
  constructor() {
    this.root = document.getElementById('hud');
    this.hotbarEl = document.getElementById('hotbar');
    this.heldNameEl = document.getElementById('held-name');
    this.debugEl = document.getElementById('debug');
    this.toastEl = document.getElementById('toast');
    this.underwaterEl = document.getElementById('underwater');
    this.damageEl = document.getElementById('damage-flash');

    this.slots = [...DEFAULT_HOTBAR];
    this.selected = 0;
    this.slotEls = [];

    this._nameTimer = 0;
    this._toastTimer = 0;
    this._debugTimer = 0;

    this._buildHotbar();
  }

  show() {
    this.root.hidden = false;
  }

  hide() {
    this.root.hidden = true;
  }

  _buildHotbar() {
    this.hotbarEl.innerHTML = '';
    this.slotEls = [];
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const el = document.createElement('div');
      el.className = 'slot';
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = String(i + 1);
      el.appendChild(num);
      this.hotbarEl.appendChild(el);
      this.slotEls.push(el);
    }
    this.refreshHotbar();
  }

  refreshHotbar() {
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const el = this.slotEls[i];
      el.classList.toggle('selected', i === this.selected);
      const existing = el.querySelector('canvas');
      if (existing) existing.remove();
      const id = this.slots[i];
      if (id != null) el.appendChild(blockIconCanvas(id, 64));
    }
  }

  get heldBlock() {
    return this.slots[this.selected];
  }

  setSlot(index, blockId) {
    this.slots[index] = blockId;
    this.refreshHotbar();
  }

  select(index) {
    if (index === this.selected) return;
    this.selected = ((index % HOTBAR_SIZE) + HOTBAR_SIZE) % HOTBAR_SIZE;
    this.refreshHotbar();
    this.showHeldName();
  }

  scroll(delta) {
    this.select(this.selected + delta);
  }

  showHeldName() {
    const block = BLOCKS[this.heldBlock];
    this.heldNameEl.textContent = block ? block.label : '';
    this.heldNameEl.classList.add('show');
    this._nameTimer = 1.6;
  }

  toast(message, seconds = 2) {
    this.toastEl.textContent = message;
    this.toastEl.classList.add('show');
    this._toastTimer = seconds;
  }

  setUnderwater(on) {
    this.underwaterEl.style.opacity = on ? '1' : '0';
  }

  flashDamage() {
    this.damageEl.style.opacity = '1';
    setTimeout(() => {
      this.damageEl.style.opacity = '0';
    }, 90);
  }

  toggleDebug() {
    this.debugEl.hidden = !this.debugEl.hidden;
    return !this.debugEl.hidden;
  }

  get debugVisible() {
    return !this.debugEl.hidden;
  }

  updateDebug(lines) {
    this.debugEl.textContent = lines.join('\n');
  }

  update(dt) {
    if (this._nameTimer > 0) {
      this._nameTimer -= dt;
      if (this._nameTimer <= 0) this.heldNameEl.classList.remove('show');
    }
    if (this._toastTimer > 0) {
      this._toastTimer -= dt;
      if (this._toastTimer <= 0) this.toastEl.classList.remove('show');
    }
  }
}
