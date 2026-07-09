import { CHUNK_AREA, CHUNK_SX, CHUNK_SY, CHUNK_VOLUME, STRIDE_Y, STRIDE_Z } from '../core/constants.js';

export const ChunkState = {
  EMPTY: 0,
  GENERATING: 1,
  READY: 2, // blocks present, lighting applied
};

export class Chunk {
  constructor(cx, cz) {
    this.cx = cx;
    this.cz = cz;
    this.key = 0;
    this.state = ChunkState.EMPTY;

    /** @type {Uint8Array|null} block ids */
    this.blocks = null;
    /** @type {Uint8Array} sky light in the high nibble, block light in the low nibble */
    this.light = new Uint8Array(CHUNK_VOLUME);
    /** @type {Uint8Array|null} per-column biome id */
    this.biomes = null;
    /** @type {Uint8Array|null} per-column terrain height */
    this.heights = null;

    /** Highest non-air block per column, used to bound the sky-light fill. */
    this.topmost = new Uint8Array(CHUNK_AREA);
    this.maxTop = 0;

    this.meshDirty = false;
    this.meshPending = false;
    /** @type {{opaque:any, cutout:any, transparent:any}} */
    this.meshes = { opaque: null, cutout: null, transparent: null };

    /** Block edits made by the player, index → id. Persisted. */
    this.edits = null;
  }

  static index(x, y, z) {
    return x + z * STRIDE_Z + y * STRIDE_Y;
  }

  get(x, y, z) {
    if (y < 0 || y >= CHUNK_SY) return 0;
    return this.blocks[x + z * STRIDE_Z + y * STRIDE_Y];
  }

  set(x, y, z, id) {
    this.blocks[x + z * STRIDE_Z + y * STRIDE_Y] = id;
  }

  getSky(i) {
    return this.light[i] >> 4;
  }

  getBlockLight(i) {
    return this.light[i] & 15;
  }

  setSky(i, v) {
    this.light[i] = (this.light[i] & 0x0f) | (v << 4);
  }

  setBlockLight(i, v) {
    this.light[i] = (this.light[i] & 0xf0) | v;
  }

  recordEdit(x, y, z, id) {
    if (!this.edits) this.edits = new Map();
    this.edits.set(x + z * STRIDE_Z + y * STRIDE_Y, id);
  }

  applyEdits(edits) {
    if (!edits) return;
    this.edits = edits;
    for (const [i, id] of edits) this.blocks[i] = id;
  }

  /** Recomputes the per-column highest non-air block. */
  computeTopmost() {
    const { blocks, topmost } = this;
    topmost.fill(0);
    let max = 0;
    for (let z = 0; z < CHUNK_SX; z++) {
      for (let x = 0; x < CHUNK_SX; x++) {
        const col = x + z * STRIDE_Z;
        for (let y = CHUNK_SY - 1; y >= 0; y--) {
          if (blocks[col + y * STRIDE_Y] !== 0) {
            topmost[col] = y;
            if (y > max) max = y;
            break;
          }
        }
      }
    }
    this.maxTop = max;
  }

  dispose() {
    for (const key of ['opaque', 'cutout', 'transparent']) {
      const mesh = this.meshes[key];
      if (mesh) {
        mesh.geometry.dispose();
        mesh.parent?.remove(mesh);
        this.meshes[key] = null;
      }
    }
  }
}
