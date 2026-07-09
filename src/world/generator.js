/**
 * Procedural world generation.
 *
 * Everything here is a pure function of (seed, worldX, worldY, worldZ), so a
 * chunk can be regenerated identically at any time, in any order, from any
 * worker thread. Structures (trees, cacti) are generated for a 3-block margin
 * around the chunk so they seamlessly cross chunk borders.
 */
import { Perlin, hash2, hash3, clamp, smoothstep } from '../core/noise.js';
import { CHUNK_SX, CHUNK_SZ, CHUNK_SY, CHUNK_AREA, CHUNK_VOLUME, SEA_LEVEL } from '../core/constants.js';
import {
  AIR, STONE, GRANITE, ANDESITE, DIRT, GRASS, SAND, GRAVEL, CLAY, BEDROCK, WATER, ICE,
  OAK_LOG, OAK_LEAVES, BIRCH_LOG, BIRCH_LEAVES, SANDSTONE, SNOW, SNOWY_GRASS, PODZOL,
  COAL_ORE, IRON_ORE, GOLD_ORE, DIAMOND_ORE, REDSTONE_ORE,
  CACTUS, TALL_GRASS, FERN, FLOWER_RED, FLOWER_YELLOW, FLOWER_BLUE, DEAD_BUSH,
} from '../core/blocks.js';

export const BIOME_NAMES = [
  'Ocean', 'Frozen Ocean', 'Beach', 'Snowy Beach', 'Plains', 'Forest',
  'Birch Forest', 'Taiga', 'Snowy Plains', 'Desert', 'Mountains', 'Snowy Peaks',
];

export const BIOME = {
  OCEAN: 0, FROZEN_OCEAN: 1, BEACH: 2, SNOWY_BEACH: 3, PLAINS: 4, FOREST: 5,
  BIRCH_FOREST: 6, TAIGA: 7, SNOWY_PLAINS: 8, DESERT: 9, MOUNTAINS: 10, SNOWY_PEAKS: 11,
};

const MIN_HEIGHT = 3;
const MAX_HEIGHT = CHUNK_SY - 8;

const idx = (x, y, z) => x + z * CHUNK_SX + y * CHUNK_AREA;

export class WorldGen {
  constructor(seed) {
    this.seed = seed >>> 0;
    const s = this.seed;
    this.continent = new Perlin(s + 1);
    this.erosion = new Perlin(s + 2);
    this.detail = new Perlin(s + 3);
    this.ridge = new Perlin(s + 4);
    this.temperature = new Perlin(s + 5);
    this.humidity = new Perlin(s + 6);
    this.caveA = new Perlin(s + 7);
    this.caveB = new Perlin(s + 8);
    this.cheese = new Perlin(s + 9);
    this.oreNoise = new Perlin(s + 10);
    this.rockNoise = new Perlin(s + 11);
    this.surfaceNoise = new Perlin(s + 12);

    /** Small memo for height lookups; structures re-query neighbours a lot. */
    this._hCache = new Map();
  }

  // ── Climate & shape ───────────────────────────────────────────────────────

  continentalness(x, z) {
    return this.continent.fbm2(x * 0.0015, z * 0.0015, 4);
  }

  heightAt(x, z) {
    const key = (x & 0xffff) * 65536 + (z & 0xffff);
    const memo = this._hCache.get(key);
    if (memo !== undefined) return memo;

    const c = this.continentalness(x, z);
    const e = this.erosion.fbm2(x * 0.0032 + 31.7, z * 0.0032 - 12.3, 3);
    const d = this.detail.fbm2(x * 0.025, z * 0.025, 3);

    // Mountains only appear well inland and where erosion is low.
    const mask = smoothstep(0.06, 0.55, c) * smoothstep(-0.25, 0.35, e);
    const r = this.ridge.ridged2(x * 0.0045, z * 0.0045, 4);

    let h = SEA_LEVEL + 2 + (c < 0 ? c * 42 : c * 20);
    h += mask * (r * 54 - 8);
    h += d * (3 + mask * 7);

    h = clamp(Math.round(h), MIN_HEIGHT, MAX_HEIGHT);
    if (this._hCache.size > 40000) this._hCache.clear();
    this._hCache.set(key, h);
    return h;
  }

  tempAt(x, z) {
    // Cooler at high altitude, like a real lapse rate.
    return this.temperature.fbm2(x * 0.0009 + 90.5, z * 0.0009 - 40.2, 2);
  }

  humidAt(x, z) {
    return this.humidity.fbm2(x * 0.0011 - 55.1, z * 0.0011 + 22.9, 2);
  }

  biomeAt(x, z, h = this.heightAt(x, z)) {
    const temp = this.tempAt(x, z) - Math.max(0, h - 78) * 0.012;
    const hum = this.humidAt(x, z);

    if (h < SEA_LEVEL - 1) return temp < -0.35 ? BIOME.FROZEN_OCEAN : BIOME.OCEAN;
    if (h <= SEA_LEVEL + 1) return temp < -0.3 ? BIOME.SNOWY_BEACH : BIOME.BEACH;
    if (h > 96) return temp < -0.1 ? BIOME.SNOWY_PEAKS : BIOME.MOUNTAINS;

    if (temp < -0.32) return hum > -0.05 ? BIOME.TAIGA : BIOME.SNOWY_PLAINS;
    if (temp > 0.3 && hum < -0.08) return BIOME.DESERT;
    if (hum > 0.18) return BIOME.FOREST;
    if (hum > 0.02) return BIOME.BIRCH_FOREST;
    return BIOME.PLAINS;
  }

  // ── Caves ─────────────────────────────────────────────────────────────────

  isCave(x, y, z, surface) {
    if (y < 2 || y > surface - 2) return false;

    // Tunnels: intersection of two "near-zero" noise shells → worm-like caves.
    const width = 0.055 + smoothstep(48, 8, y) * 0.02;
    const a = this.caveA.noise3(x * 0.017, y * 0.031, z * 0.017);
    if (Math.abs(a) > width) {
      // Cheese caverns, deep only.
      if (y > 46) return false;
      const ch = this.cheese.fbm3(x * 0.012, y * 0.024, z * 0.012, 2);
      return ch > 0.61;
    }
    const b = this.caveB.noise3(x * 0.017 + 7.3, y * 0.031 + 3.1, z * 0.017 - 4.7);
    return Math.abs(b) <= width;
  }

  // ── Ores & rock variants ──────────────────────────────────────────────────

  oreAt(x, y, z) {
    const n = this.oreNoise;
    if (y < 16 && n.noise3(x * 0.13 + 40, y * 0.13, z * 0.13) > 0.74) return DIAMOND_ORE;
    if (y < 26 && n.noise3(x * 0.12 - 90, y * 0.12 + 5, z * 0.12) > 0.7) return REDSTONE_ORE;
    if (y < 32 && n.noise3(x * 0.11 + 12, y * 0.11 - 8, z * 0.11) > 0.72) return GOLD_ORE;
    if (y < 58 && n.noise3(x * 0.1 - 30, y * 0.1 + 60, z * 0.1) > 0.66) return IRON_ORE;
    if (y < 84 && n.noise3(x * 0.09 + 77, y * 0.09 + 21, z * 0.09) > 0.62) return COAL_ORE;

    const r = this.rockNoise.noise3(x * 0.045, y * 0.045, z * 0.045);
    if (r > 0.55) return GRANITE;
    if (r < -0.55) return ANDESITE;
    return STONE;
  }

  // ── Chunk assembly ────────────────────────────────────────────────────────

  generateChunk(cx, cz) {
    const blocks = new Uint8Array(CHUNK_VOLUME);
    const biomes = new Uint8Array(CHUNK_AREA);
    const heights = new Uint8Array(CHUNK_AREA);
    const ox = cx * CHUNK_SX;
    const oz = cz * CHUNK_SZ;

    for (let z = 0; z < CHUNK_SZ; z++) {
      for (let x = 0; x < CHUNK_SX; x++) {
        const wx = ox + x;
        const wz = oz + z;
        const h = this.heightAt(wx, wz);
        const biome = this.biomeAt(wx, wz, h);
        biomes[x + z * CHUNK_SX] = biome;
        heights[x + z * CHUNK_SX] = h;
        this.buildColumn(blocks, x, z, wx, wz, h, biome);
      }
    }

    this.decorate(blocks, cx, cz);

    return { blocks, biomes, heights };
  }

  buildColumn(blocks, x, z, wx, wz, h, biome) {
    const surfaceJitter = this.surfaceNoise.noise2(wx * 0.08, wz * 0.08);
    const soilDepth = 3 + Math.round(surfaceJitter * 1.5);

    for (let y = 0; y <= h; y++) {
      let block;
      if (y === 0) {
        block = BEDROCK;
      } else if (y <= 2 && hash3(wx, y, wz, this.seed ^ 0xbed0) < 0.5 - y * 0.16) {
        block = BEDROCK;
      } else if (this.isCave(wx, y, wz, h)) {
        block = AIR;
      } else if (y === h) {
        block = this.topBlock(biome, h, wx, wz);
      } else if (y > h - soilDepth) {
        block = this.soilBlock(biome, h, y);
      } else {
        block = this.oreAt(wx, y, wz);
      }
      blocks[idx(x, y, z)] = block;
    }

    // Oceans, lakes, rivers.
    if (h < SEA_LEVEL) {
      const frozen = biome === BIOME.FROZEN_OCEAN;
      for (let y = h + 1; y <= SEA_LEVEL; y++) {
        blocks[idx(x, y, z)] = frozen && y === SEA_LEVEL ? ICE : WATER;
      }
    }
  }

  topBlock(biome, h, wx, wz) {
    switch (biome) {
      case BIOME.OCEAN:
      case BIOME.FROZEN_OCEAN: {
        if (h > SEA_LEVEL - 5) return SAND;
        const n = this.surfaceNoise.noise2(wx * 0.06 + 11, wz * 0.06 - 3);
        if (n > 0.42) return CLAY;
        if (n < -0.45) return GRAVEL;
        return DIRT;
      }
      case BIOME.BEACH:
        return SAND;
      case BIOME.SNOWY_BEACH:
        return SNOW;
      case BIOME.DESERT:
        return SAND;
      case BIOME.SNOWY_PLAINS:
        return SNOWY_GRASS;
      case BIOME.TAIGA:
        return this.surfaceNoise.noise2(wx * 0.07, wz * 0.07) > 0.25 ? PODZOL : SNOWY_GRASS;
      case BIOME.SNOWY_PEAKS:
        return SNOW;
      case BIOME.MOUNTAINS:
        if (h > 104) return SNOW;
        if (h > 88) return this.surfaceNoise.noise2(wx * 0.09, wz * 0.09) > 0 ? STONE : GRAVEL;
        return GRASS;
      default:
        return GRASS;
    }
  }

  soilBlock(biome, h, y) {
    switch (biome) {
      case BIOME.DESERT:
        return h - y < 4 ? SAND : SANDSTONE;
      case BIOME.BEACH:
        return h - y < 3 ? SAND : SANDSTONE;
      case BIOME.SNOWY_BEACH:
        return SAND;
      case BIOME.SNOWY_PEAKS:
        return h - y < 2 ? SNOW : STONE;
      case BIOME.MOUNTAINS:
        return h > 88 ? STONE : DIRT;
      case BIOME.OCEAN:
      case BIOME.FROZEN_OCEAN:
        return h > SEA_LEVEL - 5 ? SAND : DIRT;
      default:
        return DIRT;
    }
  }

  // ── Decoration (trees, plants, cacti) ─────────────────────────────────────

  /**
   * Runs over the chunk plus a 3-block margin so structures rooted in
   * neighbouring chunks correctly spill into this one.
   */
  decorate(blocks, cx, cz) {
    const ox = cx * CHUNK_SX;
    const oz = cz * CHUNK_SZ;
    const M = 3;

    for (let z = -M; z < CHUNK_SZ + M; z++) {
      for (let x = -M; x < CHUNK_SX + M; x++) {
        const wx = ox + x;
        const wz = oz + z;
        const h = this.heightAt(wx, wz);
        if (h <= SEA_LEVEL) continue;
        const biome = this.biomeAt(wx, wz, h);

        const tree = this.treeAt(wx, wz, biome);
        if (tree) this.placeTree(blocks, x, h + 1, z, tree, wx, wz);

        // Plants only matter for columns actually inside this chunk.
        if (x >= 0 && x < CHUNK_SX && z >= 0 && z < CHUNK_SZ && !tree) {
          this.placePlant(blocks, x, h, z, wx, wz, biome);
        }
      }
    }
  }

  /** Returns a tree kind, or null. Uses a 5×5 local-minimum test for spacing. */
  treeAt(wx, wz, biome) {
    let density;
    let kind;
    switch (biome) {
      case BIOME.FOREST: density = 0.11; kind = 'oak'; break;
      case BIOME.BIRCH_FOREST: density = 0.09; kind = 'birch'; break;
      case BIOME.TAIGA: density = 0.08; kind = 'pine'; break;
      case BIOME.PLAINS: density = 0.008; kind = 'oak'; break;
      case BIOME.SNOWY_PLAINS: density = 0.005; kind = 'pine'; break;
      case BIOME.MOUNTAINS: density = 0.012; kind = 'oak'; break;
      case BIOME.DESERT: density = 0.014; kind = 'cactus'; break;
      default: return null;
    }

    const seed = this.seed ^ 0x7ee5;
    const r = hash2(wx, wz, seed);
    if (r > density) return null;

    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (dx === 0 && dz === 0) continue;
        if (hash2(wx + dx, wz + dz, seed) < r) return null;
      }
    }

    if (kind === 'cactus') return 'cactus';
    // No trees on stony mountain tops.
    if (biome === BIOME.MOUNTAINS && this.heightAt(wx, wz) > 88) return null;
    return kind;
  }

  setLocal(blocks, x, y, z, block, overwrite = false) {
    if (x < 0 || x >= CHUNK_SX || z < 0 || z >= CHUNK_SZ || y < 0 || y >= CHUNK_SY) return;
    const i = idx(x, y, z);
    if (!overwrite && blocks[i] !== AIR && blocks[i] !== WATER) return;
    blocks[i] = block;
  }

  placeTree(blocks, x, y, z, kind, wx, wz) {
    const rnd = (salt) => hash3(wx, salt, wz, this.seed ^ 0x1234);

    if (kind === 'cactus') {
      const h = 1 + Math.floor(rnd(1) * 3);
      for (let i = 0; i < h; i++) this.setLocal(blocks, x, y + i, z, CACTUS);
      return;
    }

    if (kind === 'pine') {
      const trunk = 6 + Math.floor(rnd(2) * 4);
      for (let i = 0; i < trunk; i++) this.setLocal(blocks, x, y + i, z, OAK_LOG, true);
      let radius = 2;
      for (let i = trunk - 1; i >= 2; i--) {
        const layer = trunk - 1 - i;
        radius = layer % 2 === 0 ? 1 : 2;
        if (layer > 5) radius = 1;
        if (layer === 0) radius = 0;
        for (let dz = -radius; dz <= radius; dz++) {
          for (let dx = -radius; dx <= radius; dx++) {
            if (Math.abs(dx) === radius && Math.abs(dz) === radius) continue;
            this.setLocal(blocks, x + dx, y + i, z + dz, OAK_LEAVES);
          }
        }
      }
      this.setLocal(blocks, x, y + trunk, z, OAK_LEAVES);
      this.setLocal(blocks, x, y + trunk - 1, z, OAK_LEAVES);
      return;
    }

    const log = kind === 'birch' ? BIRCH_LOG : OAK_LOG;
    const leaf = kind === 'birch' ? BIRCH_LEAVES : OAK_LEAVES;
    const trunk = (kind === 'birch' ? 5 : 4) + Math.floor(rnd(3) * 3);

    for (let i = 0; i < trunk; i++) this.setLocal(blocks, x, y + i, z, log, true);

    const top = y + trunk;
    // Two wide layers, then a 3×3 cap, then a single crown block.
    for (let layer = 0; layer < 2; layer++) {
      const ly = top - 2 + layer;
      for (let dz = -2; dz <= 2; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
          const corner = Math.abs(dx) === 2 && Math.abs(dz) === 2;
          if (corner && (layer === 1 || rnd(10 + layer * 7 + dx * 3 + dz) < 0.5)) continue;
          this.setLocal(blocks, x + dx, ly, z + dz, leaf);
        }
      }
    }
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const corner = Math.abs(dx) === 1 && Math.abs(dz) === 1;
        if (corner && rnd(31 + dx + dz * 5) < 0.45) continue;
        this.setLocal(blocks, x + dx, top, z + dz, leaf);
      }
    }
    this.setLocal(blocks, x, top + 1, z, leaf);
  }

  placePlant(blocks, x, hy, z, wx, wz, biome) {
    const ground = blocks[idx(x, hy, z)];
    const above = hy + 1 < CHUNK_SY ? blocks[idx(x, hy + 1, z)] : AIR;
    if (above !== AIR) return;

    const r = hash3(wx, 77, wz, this.seed ^ 0xf10a);

    if (ground === GRASS) {
      if (r < 0.18) this.setLocal(blocks, x, hy + 1, z, TALL_GRASS);
      else if (r < 0.2) this.setLocal(blocks, x, hy + 1, z, FLOWER_RED);
      else if (r < 0.22) this.setLocal(blocks, x, hy + 1, z, FLOWER_YELLOW);
      else if (r < 0.232) this.setLocal(blocks, x, hy + 1, z, FLOWER_BLUE);
    } else if (ground === PODZOL || ground === SNOWY_GRASS) {
      if (r < 0.12) this.setLocal(blocks, x, hy + 1, z, FERN);
    } else if (ground === SAND && biome === BIOME.DESERT) {
      if (r < 0.02) this.setLocal(blocks, x, hy + 1, z, DEAD_BUSH);
    }
  }
}
