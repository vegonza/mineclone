/**
 * Every texture in the game is painted procedurally at 16×16 with a seeded RNG,
 * so the build ships zero image assets and still looks hand-pixelled.
 *
 * The tiles end up as layers of a WebGL2 `TEXTURE_2D_ARRAY`, which means we get
 * per-tile mipmaps with no atlas bleeding at all.
 */
import { DataArrayTexture, LinearMipmapLinearFilter, NearestFilter, RGBAFormat, SRGBColorSpace, UnsignedByteType } from 'three';
import { mulberry32, hashSeed } from './noise.js';
import { TILE_NAMES, BLOCKS, PASS_CROSS, tileIndexOf } from './blocks.js';

export const TILE_SIZE = 16;

// ── Tiny pixel-art toolkit ──────────────────────────────────────────────────

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const shade = (c, k) => [c[0] * k, c[1] * k, c[2] * k];

class Painter {
  constructor(size, seed) {
    this.size = size;
    this.data = new Uint8ClampedArray(size * size * 4);
    this.rnd = mulberry32(seed);
  }

  rand(a = 0, b = 1) {
    return a + this.rnd() * (b - a);
  }

  randInt(a, b) {
    return Math.floor(this.rand(a, b + 1 - 1e-9));
  }

  set(x, y, c, a = 255) {
    const s = this.size;
    x = ((x % s) + s) % s;
    y = ((y % s) + s) % s;
    const i = (y * s + x) * 4;
    this.data[i] = clamp255(c[0]);
    this.data[i + 1] = clamp255(c[1]);
    this.data[i + 2] = clamp255(c[2]);
    this.data[i + 3] = clamp255(c[3] ?? a);
  }

  get(x, y) {
    const s = this.size;
    x = ((x % s) + s) % s;
    y = ((y % s) + s) % s;
    const i = (y * s + x) * 4;
    return [this.data[i], this.data[i + 1], this.data[i + 2], this.data[i + 3]];
  }

  /** Multiply an existing pixel's brightness. */
  mul(x, y, k) {
    const p = this.get(x, y);
    this.set(x, y, [p[0] * k, p[1] * k, p[2] * k], p[3]);
  }

  fill(c, a = 255) {
    for (let y = 0; y < this.size; y++) for (let x = 0; x < this.size; x++) this.set(x, y, c, a);
  }

  clear() {
    this.data.fill(0);
  }

  /** Flat colour with per-pixel brightness jitter. */
  noise(c, amount, a = 255) {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        const d = (this.rnd() - 0.5) * 2 * amount;
        this.set(x, y, [c[0] + d, c[1] + d, c[2] + d], a);
      }
    }
  }

  rect(x0, y0, w, h, c, a = 255) {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) this.set(x, y, c, a);
  }

  /** Soft-edged ellipse with jittered colour. */
  blob(cx, cy, rx, ry, c, jitter = 6, a = 255) {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const dx = (x - cx) / rx;
        const dy = (y - cy) / ry;
        if (dx * dx + dy * dy <= 1 + (this.rnd() - 0.5) * 0.5) {
          const d = (this.rnd() - 0.5) * 2 * jitter;
          this.set(x, y, [c[0] + d, c[1] + d, c[2] + d], a);
        }
      }
    }
  }

  specks(count, c, jitter = 10, a = 255) {
    for (let i = 0; i < count; i++) {
      const d = (this.rnd() - 0.5) * 2 * jitter;
      this.set(this.randInt(0, this.size - 1), this.randInt(0, this.size - 1), [c[0] + d, c[1] + d, c[2] + d], a);
    }
  }

  hline(y, c, a = 255) {
    for (let x = 0; x < this.size; x++) this.set(x, y, c, a);
  }

  vline(x, c, a = 255) {
    for (let y = 0; y < this.size; y++) this.set(x, y, c, a);
  }
}

// ── Palettes ────────────────────────────────────────────────────────────────

const C = {
  stone: [128, 128, 128],
  granite: [151, 108, 96],
  andesite: [136, 138, 138],
  dirt: [134, 96, 67],
  grass: [106, 160, 76],
  grassDark: [82, 132, 58],
  sand: [219, 207, 160],
  gravel: [131, 127, 126],
  clay: [160, 166, 179],
  cobble: [122, 122, 122],
  mortar: [88, 88, 88],
  brick: [150, 84, 68],
  bedrock: [85, 85, 85],
  obsidian: [21, 18, 30],
  wood: [104, 82, 50],
  woodTop: [154, 122, 74],
  planks: [162, 130, 78],
  birch: [216, 211, 199],
  birchPlanks: [196, 178, 124],
  birchLeaf: [116, 158, 84],
  leaf: [64, 110, 46],
  sandstone: [216, 203, 155],
  snow: [246, 248, 250],
  podzol: [110, 82, 44],
  water: [50, 110, 195],
  ice: [148, 190, 235],
  cactus: [85, 127, 53],
  pumpkin: [199, 118, 32],
};

// ── Painters ────────────────────────────────────────────────────────────────

/** @type {Record<string, (p: Painter) => void>} */
const PAINTERS = {
  stone(p) {
    p.noise(C.stone, 9);
    for (let i = 0; i < 5; i++) p.blob(p.rand(0, 16), p.rand(0, 16), p.rand(1.2, 2.6), p.rand(1, 2), shade(C.stone, 0.88), 6);
    p.specks(14, shade(C.stone, 1.08), 4);
  },
  granite(p) {
    p.noise(C.granite, 10);
    p.specks(26, shade(C.granite, 1.15), 8);
    p.specks(16, shade(C.granite, 0.8), 6);
  },
  andesite(p) {
    p.noise(C.andesite, 8);
    for (let i = 0; i < 6; i++) p.blob(p.rand(0, 16), p.rand(0, 16), p.rand(1, 2.2), p.rand(1, 2), shade(C.andesite, 0.9), 5);
  },
  dirt(p) {
    p.noise(C.dirt, 13);
    p.specks(18, shade(C.dirt, 0.82), 6);
    p.specks(10, shade(C.dirt, 1.14), 6);
  },
  grass_top(p) {
    p.noise(C.grass, 12);
    p.specks(30, C.grassDark, 8);
    p.specks(22, shade(C.grass, 1.16), 8);
  },
  grass_side(p) {
    PAINTERS.dirt(p);
    // irregular grass overhang along the top
    for (let x = 0; x < 16; x++) {
      const h = 3 + Math.round(p.rand(0, 2.4));
      for (let y = 0; y < h; y++) {
        const c = p.rnd() < 0.3 ? C.grassDark : C.grass;
        const d = (p.rnd() - 0.5) * 16;
        p.set(x, y, [c[0] + d, c[1] + d, c[2] + d]);
      }
    }
  },
  sand(p) {
    p.noise(C.sand, 8);
    p.specks(20, shade(C.sand, 0.9), 5);
  },
  gravel(p) {
    p.noise(shade(C.gravel, 0.75), 8);
    for (let i = 0; i < 16; i++) {
      const k = p.rand(0.85, 1.25);
      p.blob(p.rand(0, 16), p.rand(0, 16), p.rand(1.1, 2.2), p.rand(1.1, 2.0), shade(C.gravel, k), 8);
    }
  },
  clay(p) {
    p.noise(C.clay, 6);
    p.specks(12, shade(C.clay, 0.92), 4);
  },
  cobblestone(p) {
    p.fill(C.mortar);
    p.noise(C.mortar, 6);
    const stones = [
      [3, 3, 3.0, 2.4], [10, 3, 3.2, 2.2], [3, 9, 2.6, 2.6], [9, 9, 3.4, 2.6],
      [15, 6, 2.0, 2.4], [6, 14, 2.6, 1.8], [14, 13, 2.2, 2.0], [0, 13, 1.8, 2.0],
    ];
    for (const [x, y, rx, ry] of stones) {
      p.blob(x, y, rx, ry, shade(C.cobble, p.rand(0.92, 1.14)), 9);
      // subtle bottom-edge shadow for depth
      for (let dx = -rx; dx <= rx; dx++) p.mul(Math.round(x + dx), Math.round(y + ry), 0.82);
    }
  },
  mossy_cobblestone(p) {
    PAINTERS.cobblestone(p);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        if (p.rnd() < 0.34) {
          const c = p.get(x, y);
          p.set(x, y, mix(c, mix(C.grassDark, [70, 100, 50], p.rand(0, 1)), p.rand(0.45, 0.85)));
        }
      }
    }
  },
  stone_bricks(p) {
    p.noise(shade(C.cobble, 0.98), 7);
    const mortarC = shade(C.mortar, 0.86);
    p.hline(7, mortarC);
    p.hline(15, mortarC);
    for (let y = 0; y < 8; y++) p.set(7, y, mortarC);
    for (let y = 8; y < 16; y++) {
      p.set(3, y, mortarC);
      p.set(11, y, mortarC);
    }
    p.specks(18, shade(C.cobble, 1.08), 5);
  },
  bricks(p) {
    p.noise(C.brick, 10);
    const mortarC = [183, 172, 162];
    for (let y = 3; y < 16; y += 4) p.hline(y, mortarC);
    for (let row = 0; row < 4; row++) {
      const y0 = row * 4;
      const offset = row % 2 === 0 ? 0 : 8;
      for (let x = offset; x < 16 + offset; x += 8) for (let y = y0; y < y0 + 3; y++) p.set(x, y, mortarC);
    }
  },
  bedrock(p) {
    p.noise(C.bedrock, 22);
    for (let i = 0; i < 12; i++) p.blob(p.rand(0, 16), p.rand(0, 16), p.rand(1, 2.6), p.rand(1, 2.6), shade(C.bedrock, p.rand(0.45, 1.35)), 14);
  },
  obsidian(p) {
    p.noise(C.obsidian, 5);
    p.specks(22, [70, 52, 105], 16);
    p.specks(8, [96, 72, 140], 12);
  },

  log_side(p) {
    p.noise(C.wood, 7);
    for (let x = 0; x < 16; x++) {
      if (p.rnd() < 0.35) for (let y = 0; y < 16; y++) p.mul(x, y, p.rand(0.8, 0.92));
      if (p.rnd() < 0.2) for (let y = 0; y < 16; y++) p.mul(x, y, p.rand(1.06, 1.16));
    }
    for (let i = 0; i < 5; i++) {
      const x = p.randInt(0, 15);
      const y = p.randInt(0, 12);
      for (let k = 0; k < 3; k++) p.mul(x, y + k, 0.72);
    }
  },
  log_top(p) {
    p.noise(shade(C.woodTop, 1.0), 6);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const d = Math.hypot(x - 7.5, y - 7.5);
        if (d > 6.6) {
          p.set(x, y, shade(C.wood, p.rand(0.9, 1.05)));
        } else {
          const ring = Math.sin(d * 2.1) * 0.5 + 0.5;
          p.set(x, y, mix(shade(C.woodTop, 0.82), C.woodTop, ring * p.rand(0.85, 1)));
        }
      }
    }
  },
  birch_log_side(p) {
    p.noise(C.birch, 6);
    for (let i = 0; i < 8; i++) {
      const x = p.randInt(0, 14);
      const y = p.randInt(0, 15);
      const w = p.randInt(1, 4);
      for (let k = 0; k < w; k++) p.set(x + k, y, shade([70, 66, 62], p.rand(0.9, 1.2)));
    }
    p.specks(18, shade(C.birch, 0.92), 6);
  },
  birch_log_top(p) {
    p.noise([222, 216, 200], 5);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const d = Math.hypot(x - 7.5, y - 7.5);
        if (d > 6.6) p.set(x, y, shade(C.birch, p.rand(0.86, 0.98)));
        else p.set(x, y, mix([196, 188, 166], [226, 220, 200], Math.sin(d * 2.3) * 0.5 + 0.5));
      }
    }
  },
  planks(p) {
    p.noise(C.planks, 8);
    for (let y = 3; y < 16; y += 4) p.hline(y, shade(C.planks, 0.66));
    for (let i = 0; i < 22; i++) {
      const x = p.randInt(0, 15);
      const y = p.randInt(0, 15);
      const len = p.randInt(2, 5);
      for (let k = 0; k < len && x + k < 16; k++) if (y % 4 !== 3) p.mul(x + k, y, p.rand(0.9, 1.08));
    }
  },
  birch_planks(p) {
    p.noise(C.birchPlanks, 7);
    for (let y = 3; y < 16; y += 4) p.hline(y, shade(C.birchPlanks, 0.72));
    p.specks(20, shade(C.birchPlanks, 0.9), 6);
  },

  leaves(p) {
    p.noise(C.leaf, 14);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const r = p.rnd();
        if (r < 0.16) p.set(x, y, [0, 0, 0], 0);
        else if (r < 0.32) p.set(x, y, shade(C.leaf, p.rand(0.68, 0.82)));
        else if (r < 0.44) p.set(x, y, shade(C.leaf, p.rand(1.15, 1.32)));
      }
    }
  },
  birch_leaves(p) {
    p.noise(C.birchLeaf, 14);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const r = p.rnd();
        if (r < 0.16) p.set(x, y, [0, 0, 0], 0);
        else if (r < 0.3) p.set(x, y, shade(C.birchLeaf, p.rand(0.7, 0.85)));
        else if (r < 0.42) p.set(x, y, shade(C.birchLeaf, p.rand(1.12, 1.3)));
      }
    }
  },

  sandstone_top(p) {
    p.noise(C.sandstone, 6);
    p.specks(14, shade(C.sandstone, 0.92), 4);
  },
  sandstone_side(p) {
    p.noise(C.sandstone, 5);
    p.rect(0, 0, 16, 4, shade(C.sandstone, 1.05));
    p.hline(3, shade(C.sandstone, 0.78));
    p.hline(15, shade(C.sandstone, 0.8));
    for (let x = 0; x < 16; x++) if (p.rnd() < 0.3) for (let y = 4; y < 15; y++) p.mul(x, y, p.rand(0.94, 1.03));
  },
  snow(p) {
    p.noise(C.snow, 5);
    p.specks(12, [230, 236, 246], 4);
  },
  snowy_grass_side(p) {
    PAINTERS.dirt(p);
    for (let x = 0; x < 16; x++) {
      const h = 3 + Math.round(p.rand(0, 2.2));
      for (let y = 0; y < h; y++) {
        const d = (p.rnd() - 0.5) * 10;
        p.set(x, y, [C.snow[0] + d, C.snow[1] + d, C.snow[2] + d]);
      }
    }
  },
  podzol_top(p) {
    p.noise(C.podzol, 12);
    p.specks(26, [150, 106, 48], 12);
    p.specks(14, [70, 52, 30], 8);
  },
  podzol_side(p) {
    PAINTERS.dirt(p);
    for (let x = 0; x < 16; x++) {
      const h = 2 + Math.round(p.rand(0, 2));
      for (let y = 0; y < h; y++) {
        const d = (p.rnd() - 0.5) * 14;
        p.set(x, y, [C.podzol[0] + d, C.podzol[1] + d, C.podzol[2] + d]);
      }
    }
  },

  glass(p) {
    p.clear();
    const frame = [205, 232, 238];
    for (let x = 0; x < 16; x++) {
      p.set(x, 0, frame, 210);
      p.set(x, 15, frame, 210);
    }
    for (let y = 0; y < 16; y++) {
      p.set(0, y, frame, 210);
      p.set(15, y, frame, 210);
    }
    for (let i = 0; i < 5; i++) {
      const x = p.randInt(2, 12);
      const y = p.randInt(2, 12);
      p.set(x, y, [255, 255, 255], 120);
      p.set(x + 1, y - 1, [255, 255, 255], 90);
    }
    p.set(3, 12, frame, 150);
    p.set(4, 11, frame, 150);
    p.set(5, 10, frame, 150);
  },
  water(p) {
    p.noise(C.water, 5, 195);
    for (let i = 0; i < 5; i++) p.blob(p.rand(0, 16), p.rand(0, 16), p.rand(2.5, 4.5), p.rand(1.4, 2.4), shade(C.water, 1.05), 4, 195);
  },
  ice(p) {
    p.noise(C.ice, 7, 205);
    for (let i = 0; i < 5; i++) {
      let x = p.randInt(0, 15);
      let y = p.randInt(0, 15);
      for (let k = 0; k < 6; k++) {
        p.set(x, y, shade(C.ice, 1.16), 220);
        x += p.randInt(-1, 1);
        y += p.randInt(0, 1);
      }
    }
  },

  cactus_top(p) {
    p.noise(C.cactus, 8);
    p.blob(7.5, 7.5, 5, 5, shade(C.cactus, 1.1), 6);
    p.blob(7.5, 7.5, 2.5, 2.5, shade(C.cactus, 0.85), 5);
  },
  cactus_side(p) {
    p.noise(C.cactus, 7);
    p.rect(0, 0, 1, 16, shade(C.cactus, 0.7));
    p.rect(15, 0, 1, 16, shade(C.cactus, 0.7));
    for (let y = 1; y < 16; y += 4) {
      p.set(2, y, [30, 40, 20]);
      p.set(13, y + 2, [30, 40, 20]);
      p.set(7, y + 1, [30, 40, 20]);
    }
  },
  pumpkin_top(p) {
    p.noise(C.pumpkin, 9);
    for (let x = 1; x < 16; x += 4) p.vline(x, shade(C.pumpkin, 0.82));
    p.blob(7.5, 7.5, 2.2, 2.2, [120, 96, 40], 8);
  },
  pumpkin_side(p) {
    p.noise(C.pumpkin, 9);
    for (let x = 1; x < 16; x += 5) p.vline(x, shade(C.pumpkin, 0.8));
    p.hline(0, shade(C.pumpkin, 0.7));
    p.hline(15, shade(C.pumpkin, 0.72));
  },

  glowstone(p) {
    p.noise([146, 112, 68], 10);
    for (let i = 0; i < 9; i++) p.blob(p.rand(0, 16), p.rand(0, 16), p.rand(1.2, 2.4), p.rand(1.2, 2.4), [252, 224, 148], 14);
    p.specks(16, [255, 246, 200], 6);
  },
  sea_lantern(p) {
    p.noise([164, 196, 190], 8);
    for (let i = 0; i < 6; i++) p.blob(p.rand(0, 16), p.rand(0, 16), p.rand(1.4, 2.6), p.rand(1.4, 2.6), [222, 244, 238], 10);
    p.specks(14, [255, 255, 250], 5);
  },

  coal_ore: oreTile([32, 32, 32], 4, 2.3),
  iron_ore: oreTile([196, 156, 122], 4, 2.0),
  gold_ore: oreTile([246, 208, 62], 4, 1.9),
  diamond_ore: oreTile([92, 227, 220], 4, 1.8),
  redstone_ore: oreTile([204, 40, 40], 5, 1.8),

  tall_grass: plantTile([84, 140, 56], 9, 6, 12),
  fern: plantTile([62, 112, 44], 12, 7, 14),
  flower_red: flowerTile([196, 48, 48], [230, 210, 90]),
  flower_yellow: flowerTile([232, 200, 56], [250, 240, 170]),
  flower_blue: flowerTile([70, 110, 220], [235, 235, 245]),
  dead_bush(p) {
    p.clear();
    const c = [124, 96, 48];
    for (let i = 0; i < 7; i++) {
      let x = 7 + p.randInt(-1, 1);
      let y = 15;
      const dir = p.rnd() < 0.5 ? -1 : 1;
      const len = p.randInt(5, 11);
      for (let k = 0; k < len; k++) {
        p.set(x, y, shade(c, p.rand(0.8, 1.2)));
        y -= 1;
        if (p.rnd() < 0.5) x += dir;
        if (y < 1) break;
      }
    }
  },
  torch(p) {
    p.clear();
    for (let y = 8; y < 16; y++) {
      p.set(7, y, shade([124, 92, 54], p.rand(0.9, 1.1)));
      p.set(8, y, shade([98, 72, 42], p.rand(0.9, 1.1)));
    }
    p.rect(6, 5, 4, 3, [255, 196, 72]);
    p.rect(7, 6, 2, 2, [255, 246, 190]);
    p.set(6, 4, [255, 168, 48], 210);
    p.set(9, 4, [255, 168, 48], 210);
    p.set(7, 4, [255, 214, 120]);
    p.set(8, 4, [255, 214, 120]);
  },

  wool_white: woolTile([234, 236, 238]),
  wool_red: woolTile([161, 39, 34]),
  wool_orange: woolTile([216, 127, 51]),
  wool_yellow: woolTile([229, 197, 51]),
  wool_green: woolTile([94, 124, 22]),
  wool_cyan: woolTile([58, 142, 140]),
  wool_blue: woolTile([53, 57, 157]),
  wool_purple: woolTile([126, 61, 181]),
  wool_black: woolTile([27, 27, 31]),
};

function oreTile(oreColor, count, radius) {
  return (p) => {
    PAINTERS.stone(p);
    for (let i = 0; i < count; i++) {
      const cx = p.rand(2.5, 13.5);
      const cy = p.rand(2.5, 13.5);
      const r = p.rand(radius * 0.7, radius);
      p.blob(cx, cy, r, r * p.rand(0.7, 1.1), shade(oreColor, 0.72), 6);
      p.blob(cx, cy, r * 0.6, r * 0.6, oreColor, 12);
      p.set(Math.round(cx - r * 0.3), Math.round(cy - r * 0.3), shade(oreColor, 1.3));
    }
  };
}

function plantTile(color, blades, minH, maxH) {
  return (p) => {
    p.clear();
    for (let i = 0; i < blades; i++) {
      let x = p.randInt(1, 14);
      const h = p.randInt(minH, maxH);
      const drift = p.rnd() < 0.5 ? -1 : 1;
      for (let k = 0; k < h; k++) {
        const y = 15 - k;
        const c = shade(color, p.rand(0.78, 1.25));
        p.set(x, y, c);
        if (k > h * 0.55 && p.rnd() < 0.42) x += drift;
      }
    }
  };
}

function flowerTile(petal, center) {
  return (p) => {
    p.clear();
    const stem = [62, 116, 44];
    for (let y = 7; y < 16; y++) p.set(7, y, shade(stem, p.rand(0.85, 1.15)));
    p.set(6, 10, stem);
    p.set(5, 11, stem);
    p.set(8, 12, stem);
    p.set(9, 13, stem);
    const head = [
      [6, 3], [7, 3], [8, 3],
      [5, 4], [6, 4], [7, 4], [8, 4], [9, 4],
      [5, 5], [6, 5], [7, 5], [8, 5], [9, 5],
      [6, 6], [7, 6], [8, 6],
    ];
    for (const [x, y] of head) p.set(x, y, shade(petal, p.rand(0.85, 1.15)));
    p.set(7, 4, center);
    p.set(7, 5, center);
    p.set(6, 5, shade(center, 0.9));
  };
}

function woolTile(color) {
  return (p) => {
    p.noise(color, 8);
    for (let i = 0; i < 26; i++) {
      const x = p.randInt(0, 15);
      const y = p.randInt(0, 15);
      p.mul(x, y, p.rand(0.86, 1.14));
      p.mul(x + 1, y, p.rand(0.92, 1.08));
    }
  };
}

// ── Tile image cache ────────────────────────────────────────────────────────

let cachedTiles = null;

/** @returns {Uint8ClampedArray[]} RGBA rows top→bottom, one entry per tile. */
export function getTileImages() {
  if (cachedTiles) return cachedTiles;
  cachedTiles = TILE_NAMES.map((name) => {
    const painter = PAINTERS[name];
    if (!painter) throw new Error(`No painter registered for tile "${name}"`);
    const p = new Painter(TILE_SIZE, hashSeed(name) ^ 0x5eed);
    painter(p);
    return p.data;
  });
  return cachedTiles;
}

/** Builds the WebGL2 2D-array texture holding every tile as its own layer. */
export function createTextureArray(maxAnisotropy = 1) {
  const tiles = getTileImages();
  const layers = tiles.length;
  const s = TILE_SIZE;
  const data = new Uint8Array(s * s * 4 * layers);

  for (let l = 0; l < layers; l++) {
    const src = tiles[l];
    const base = l * s * s * 4;
    // Flip vertically: GL's first data row is v = 0 (bottom of the tile).
    for (let y = 0; y < s; y++) {
      const srcRow = (s - 1 - y) * s * 4;
      data.set(src.subarray(srcRow, srcRow + s * 4), base + y * s * 4);
    }
  }

  const tex = new DataArrayTexture(data, s, s, layers);
  tex.format = RGBAFormat;
  tex.type = UnsignedByteType;
  tex.magFilter = NearestFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = maxAnisotropy;
  tex.colorSpace = SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// ── Canvas helpers (UI icons) ───────────────────────────────────────────────

const tileCanvasCache = new Map();

export function tileCanvas(layerIndex) {
  if (tileCanvasCache.has(layerIndex)) return tileCanvasCache.get(layerIndex);
  const tiles = getTileImages();
  const canvas = document.createElement('canvas');
  canvas.width = TILE_SIZE;
  canvas.height = TILE_SIZE;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(tiles[layerIndex], TILE_SIZE, TILE_SIZE), 0, 0);
  tileCanvasCache.set(layerIndex, canvas);
  return canvas;
}

function tintedTile(layerIndex, brightness) {
  const src = tileCanvas(layerIndex);
  const c = document.createElement('canvas');
  c.width = TILE_SIZE;
  c.height = TILE_SIZE;
  const ctx = c.getContext('2d');
  ctx.drawImage(src, 0, 0);
  ctx.globalCompositeOperation = 'source-atop';
  if (brightness < 1) ctx.fillStyle = `rgba(0,0,0,${(1 - brightness).toFixed(3)})`;
  else ctx.fillStyle = `rgba(255,255,255,${(brightness - 1).toFixed(3)})`;
  ctx.fillRect(0, 0, TILE_SIZE, TILE_SIZE);
  return c;
}

/** Draws an isometric cube preview of a block, used by the hotbar/inventory. */
export function blockIconCanvas(blockId, px = 64) {
  const block = BLOCKS[blockId];
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  const layerFor = (face) => tileIndexOf(block.tiles[face]);

  if (block.pass === PASS_CROSS) {
    const t = tileCanvas(layerFor(0));
    ctx.drawImage(t, px * 0.06, px * 0.06, px * 0.88, px * 0.88);
    return canvas;
  }

  // Iso projection: unit-square face corners in canvas space.
  const S = px;
  const A = [0.5 * S, 0.06 * S];
  const B = [0.97 * S, 0.31 * S];
  const Cc = [0.5 * S, 0.56 * S];
  const D = [0.03 * S, 0.31 * S];
  const C2 = [0.5 * S, 0.99 * S];
  const D2 = [0.03 * S, 0.78 * S];

  const drawFace = (img, o, u, v) => {
    ctx.save();
    ctx.setTransform(u[0] / TILE_SIZE, u[1] / TILE_SIZE, v[0] / TILE_SIZE, v[1] / TILE_SIZE, o[0], o[1]);
    ctx.drawImage(img, 0, 0);
    ctx.restore();
  };
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];

  // top face (+Y = index 2), left/west face (-X = index 1), right/south face (+Z = index 4)
  drawFace(tintedTile(layerFor(2), 1.0), D, sub(A, D), sub(Cc, D));
  drawFace(tintedTile(layerFor(1), 0.62), D, sub(Cc, D), sub(D2, D));
  drawFace(tintedTile(layerFor(4), 0.8), Cc, sub(B, Cc), sub(C2, Cc));

  return canvas;
}
