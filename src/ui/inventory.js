import { BLOCKS, CREATIVE_BLOCKS } from '../core/blocks.js';
import { blockIconCanvas } from '../core/textures.js';

export class Inventory {
  constructor(onPick) {
    this.el = document.getElementById('inventory');
    this.gridEl = document.getElementById('inventory-grid');
    this.onPick = onPick;
    this.built = false;
  }

  get open() {
    return !this.el.hidden;
  }

  _build() {
    if (this.built) return;
    this.built = true;
    const frag = document.createDocumentFragment();
    for (const id of CREATIVE_BLOCKS) {
      const item = document.createElement('button');
      item.className = 'inv-item';
      item.title = BLOCKS[id].label;
      item.appendChild(blockIconCanvas(id, 64));
      item.addEventListener('click', () => this.onPick(id));
      frag.appendChild(item);
    }
    this.gridEl.appendChild(frag);
  }

  show() {
    this._build();
    this.el.hidden = false;
  }

  hide() {
    this.el.hidden = true;
  }

  toggle() {
    if (this.open) this.hide();
    else this.show();
    return this.open;
  }
}
