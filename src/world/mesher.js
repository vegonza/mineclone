/**
 * Chunk mesher.
 *
 * Consumes a padded 18×128×18 neighbourhood (blocks + light) and emits compact
 * vertex buffers for three render passes. Faces touching an opaque neighbour
 * are culled, and every vertex carries baked ambient occlusion plus smoothed
 * sky/block light sampled from the four cells that touch it.
 *
 * Vertex layout (17 bytes):
 *   position  float32 × 3
 *   aLight    uint8   × 3  (ao brightness, sky light, block light) — normalized
 *   aTile     uint8   × 2  (texture layer, packed face/corner/wave code)
 */
import { CHUNK_SX, CHUNK_SY, CHUNK_SZ, PAD_SX, PAD_AREA } from '../core/constants.js';
import {
  AIR, WATER, BLOCK_TILES, IS_OPAQUE, PASS_OF, PASS_CROSS, PASS_OPAQUE, PASS_CUTOUT, occludes, STONE,
} from '../core/blocks.js';
import { hash3 } from '../core/noise.js';

/** Per-face geometry: corner positions + the three AO/light sample offsets. */
const FACE_TABLE = [
  { // +X (east)
    verts: [
      { p: [1, 0, 1], s1: [1, -1, 0], s2: [1, 0, 1], c: [1, -1, 1] },
      { p: [1, 0, 0], s1: [1, -1, 0], s2: [1, 0, -1], c: [1, -1, -1] },
      { p: [1, 1, 0], s1: [1, 1, 0], s2: [1, 0, -1], c: [1, 1, -1] },
      { p: [1, 1, 1], s1: [1, 1, 0], s2: [1, 0, 1], c: [1, 1, 1] },
    ],
    dir: [1, 0, 0],
  },
  { // -X (west)
    verts: [
      { p: [0, 0, 0], s1: [-1, -1, 0], s2: [-1, 0, -1], c: [-1, -1, -1] },
      { p: [0, 0, 1], s1: [-1, -1, 0], s2: [-1, 0, 1], c: [-1, -1, 1] },
      { p: [0, 1, 1], s1: [-1, 1, 0], s2: [-1, 0, 1], c: [-1, 1, 1] },
      { p: [0, 1, 0], s1: [-1, 1, 0], s2: [-1, 0, -1], c: [-1, 1, -1] },
    ],
    dir: [-1, 0, 0],
  },
  { // +Y (top)
    verts: [
      { p: [0, 1, 0], s1: [-1, 1, 0], s2: [0, 1, -1], c: [-1, 1, -1] },
      { p: [0, 1, 1], s1: [-1, 1, 0], s2: [0, 1, 1], c: [-1, 1, 1] },
      { p: [1, 1, 1], s1: [1, 1, 0], s2: [0, 1, 1], c: [1, 1, 1] },
      { p: [1, 1, 0], s1: [1, 1, 0], s2: [0, 1, -1], c: [1, 1, -1] },
    ],
    dir: [0, 1, 0],
  },
  { // -Y (bottom)
    verts: [
      { p: [0, 0, 0], s1: [-1, -1, 0], s2: [0, -1, -1], c: [-1, -1, -1] },
      { p: [1, 0, 0], s1: [1, -1, 0], s2: [0, -1, -1], c: [1, -1, -1] },
      { p: [1, 0, 1], s1: [1, -1, 0], s2: [0, -1, 1], c: [1, -1, 1] },
      { p: [0, 0, 1], s1: [-1, -1, 0], s2: [0, -1, 1], c: [-1, -1, 1] },
    ],
    dir: [0, -1, 0],
  },
  { // +Z (south)
    verts: [
      { p: [0, 0, 1], s1: [-1, 0, 1], s2: [0, -1, 1], c: [-1, -1, 1] },
      { p: [1, 0, 1], s1: [1, 0, 1], s2: [0, -1, 1], c: [1, -1, 1] },
      { p: [1, 1, 1], s1: [1, 0, 1], s2: [0, 1, 1], c: [1, 1, 1] },
      { p: [0, 1, 1], s1: [-1, 0, 1], s2: [0, 1, 1], c: [-1, 1, 1] },
    ],
    dir: [0, 0, 1],
  },
  { // -Z (north)
    verts: [
      { p: [1, 0, 0], s1: [1, 0, -1], s2: [0, -1, -1], c: [1, -1, -1] },
      { p: [0, 0, 0], s1: [-1, 0, -1], s2: [0, -1, -1], c: [-1, -1, -1] },
      { p: [0, 1, 0], s1: [-1, 0, -1], s2: [0, 1, -1], c: [-1, 1, -1] },
      { p: [1, 1, 0], s1: [1, 0, -1], s2: [0, 1, -1], c: [1, 1, -1] },
    ],
    dir: [0, 0, -1],
  },
];

/** ao level (0 = fully occluded corner) → brightness. */
const AO_BRIGHTNESS = [0.42, 0.62, 0.82, 1.0];

const WATER_TOP = 0.885;
const CROSS_A = 0.5 - 0.5 / Math.SQRT2;
const CROSS_B = 0.5 + 0.5 / Math.SQRT2;

class Builder {
  constructor() {
    this.cap = 1024;
    this.n = 0;
    this.pos = new Float32Array(this.cap * 3);
    this.light = new Uint8Array(this.cap * 3);
    this.tile = new Uint8Array(this.cap * 2);
    this.idxCap = 1536;
    this.idx = new Uint32Array(this.idxCap);
    this.iCount = 0;
    this.minY = Infinity;
    this.maxY = -Infinity;
  }

  _grow() {
    this.cap *= 2;
    const pos = new Float32Array(this.cap * 3);
    pos.set(this.pos);
    this.pos = pos;
    const light = new Uint8Array(this.cap * 3);
    light.set(this.light);
    this.light = light;
    const tile = new Uint8Array(this.cap * 2);
    tile.set(this.tile);
    this.tile = tile;
  }

  _growIdx() {
    this.idxCap *= 2;
    const idx = new Uint32Array(this.idxCap);
    idx.set(this.idx);
    this.idx = idx;
  }

  /**
   * @param {number[][]} p  four corner positions
   * @param {number[]} ao   four ao levels (0..3)
   * @param {number[]} sky  four sky levels (0..15, fractional)
   * @param {number[]} blk  four block-light levels
   */
  quad(p, ao, sky, blk, layer, faceCode, wave) {
    while (this.n + 4 > this.cap) this._grow();
    while (this.iCount + 6 > this.idxCap) this._growIdx();

    const base = this.n;
    for (let i = 0; i < 4; i++) {
      const v = base + i;
      this.pos[v * 3] = p[i][0];
      this.pos[v * 3 + 1] = p[i][1];
      this.pos[v * 3 + 2] = p[i][2];
      if (p[i][1] < this.minY) this.minY = p[i][1];
      if (p[i][1] > this.maxY) this.maxY = p[i][1];
      this.light[v * 3] = Math.round(AO_BRIGHTNESS[ao[i]] * 255);
      this.light[v * 3 + 1] = Math.round((sky[i] / 15) * 255);
      this.light[v * 3 + 2] = Math.round((blk[i] / 15) * 255);
      this.tile[v * 2] = layer;
      this.tile[v * 2 + 1] = faceCode | (wave && p[i][1] % 1 !== 0 ? 8 : 0) | (i << 4);
    }
    this.n += 4;

    // Flip the split so the AO gradient never breaks across the diagonal.
    const flip = ao[0] + ao[2] > ao[1] + ao[3];
    const i = this.iCount;
    if (flip) {
      this.idx[i] = base + 1; this.idx[i + 1] = base + 2; this.idx[i + 2] = base + 3;
      this.idx[i + 3] = base + 1; this.idx[i + 4] = base + 3; this.idx[i + 5] = base;
    } else {
      this.idx[i] = base; this.idx[i + 1] = base + 1; this.idx[i + 2] = base + 2;
      this.idx[i + 3] = base; this.idx[i + 4] = base + 2; this.idx[i + 5] = base + 3;
    }
    this.iCount += 6;
  }

  finish() {
    if (this.n === 0) return null;
    return {
      positions: this.pos.slice(0, this.n * 3),
      light: this.light.slice(0, this.n * 3),
      tile: this.tile.slice(0, this.n * 2),
      indices: this.idx.slice(0, this.iCount),
      vertexCount: this.n,
      minY: this.minY,
      maxY: this.maxY,
    };
  }
}

/**
 * @param {Uint8Array} blocks padded block ids, PAD_SX × CHUNK_SY × PAD_SZ
 * @param {Uint8Array} light  padded light bytes (sky << 4 | blockLight)
 */
export function meshChunk(blocks, light, cx, cz) {
  const opaque = new Builder();
  const cutout = new Builder();
  const transparent = new Builder();

  // Padded index; x,z ∈ [-1, 16]
  const pi = (x, y, z) => x + 1 + (z + 1) * PAD_SX + y * PAD_AREA;

  const blockAt = (x, y, z) => {
    if (y < 0) return STONE; // treat below-world as solid so we skip bottom faces
    if (y >= CHUNK_SY) return AIR;
    return blocks[pi(x, y, z)];
  };
  const lightAt = (x, y, z) => {
    if (y < 0) return 0;
    if (y >= CHUNK_SY) return 0xf0; // open sky above the world
    return light[pi(x, y, z)];
  };

  const p = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const ao = [0, 0, 0, 0];
  const sky = [0, 0, 0, 0];
  const blk = [0, 0, 0, 0];

  for (let y = 0; y < CHUNK_SY; y++) {
    for (let z = 0; z < CHUNK_SZ; z++) {
      for (let x = 0; x < CHUNK_SX; x++) {
        const id = blocks[pi(x, y, z)];
        if (id === AIR) continue;

        const pass = PASS_OF[id];
        if (pass === PASS_CROSS) {
          emitCross(cutout, blocks, light, x, y, z, id, cx, cz, pi);
          continue;
        }

        const builder = pass === PASS_OPAQUE ? opaque : pass === PASS_CUTOUT ? cutout : transparent;
        const isWater = id === WATER;
        const lowerTop = isWater && blockAt(x, y + 1, z) !== WATER;

        for (let f = 0; f < 6; f++) {
          const face = FACE_TABLE[f];
          const nx = x + face.dir[0];
          const ny = y + face.dir[1];
          const nz = z + face.dir[2];
          if (occludes(id, blockAt(nx, ny, nz))) continue;

          for (let v = 0; v < 4; v++) {
            const vert = face.verts[v];
            const lx = vert.p[0];
            const ly = vert.p[1];
            const lz = vert.p[2];

            p[v][0] = x + lx;
            p[v][1] = y + (lowerTop && ly === 1 ? WATER_TOP : ly);
            p[v][2] = z + lz;

            const b1 = blockAt(x + vert.s1[0], y + vert.s1[1], z + vert.s1[2]);
            const b2 = blockAt(x + vert.s2[0], y + vert.s2[1], z + vert.s2[2]);
            const bc = blockAt(x + vert.c[0], y + vert.c[1], z + vert.c[2]);
            const o1 = IS_OPAQUE[b1];
            const o2 = IS_OPAQUE[b2];
            const oc = IS_OPAQUE[bc];

            ao[v] = o1 && o2 ? 0 : 3 - (o1 + o2 + oc);

            // Smooth lighting: average the non-opaque cells touching this corner.
            let s = lightAt(nx, ny, nz);
            let sSum = s >> 4;
            let bSum = s & 15;
            let count = 1;
            if (!o1) {
              s = lightAt(x + vert.s1[0], y + vert.s1[1], z + vert.s1[2]);
              sSum += s >> 4; bSum += s & 15; count++;
            }
            if (!o2) {
              s = lightAt(x + vert.s2[0], y + vert.s2[1], z + vert.s2[2]);
              sSum += s >> 4; bSum += s & 15; count++;
            }
            if (!(o1 && o2) && !oc) {
              s = lightAt(x + vert.c[0], y + vert.c[1], z + vert.c[2]);
              sSum += s >> 4; bSum += s & 15; count++;
            }
            sky[v] = sSum / count;
            blk[v] = bSum / count;
          }

          builder.quad(p, ao, sky, blk, BLOCK_TILES[id * 6 + f], f, lowerTop);
        }
      }
    }
  }

  return {
    opaque: opaque.finish(),
    cutout: cutout.finish(),
    transparent: transparent.finish(),
  };
}

function emitCross(builder, blocks, light, x, y, z, id, cx, cz, pi) {
  const wx = cx * CHUNK_SX + x;
  const wz = cz * CHUNK_SZ + z;
  const ox = (hash3(wx, 1, wz, 0x51ab) - 0.5) * 0.34;
  const oz = (hash3(wx, 2, wz, 0x51ab) - 0.5) * 0.34;

  const l = light[pi(x, y, z)];
  const s = l >> 4;
  const b = l & 15;
  const sky = [s, s, s, s];
  const blk = [b, b, b, b];
  const ao = [3, 3, 3, 3];
  const layer = BLOCK_TILES[id * 6];

  const a = CROSS_A;
  const bb = CROSS_B;
  const quads = [
    [[a, 0, a], [bb, 0, bb], [bb, 1, bb], [a, 1, a]],
    [[bb, 0, a], [a, 0, bb], [a, 1, bb], [bb, 1, a]],
  ];

  for (const q of quads) {
    const p = q.map(([px, py, pz]) => [x + px + ox, y + py, z + pz + oz]);
    builder.quad(p, ao, sky, blk, layer, 6, false);
  }
}
