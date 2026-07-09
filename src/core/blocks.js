/**
 * Block registry.
 *
 * This module is pure data + typed lookup tables so it can be imported by both
 * the main thread and the web workers without dragging in any DOM/Three deps.
 *
 * Face order everywhere is: +X, -X, +Y, -Y, +Z, -Z (see FACES in constants.js).
 */

/** Render pass a block belongs to. */
export const PASS_NONE = 0; // air, never rendered
export const PASS_OPAQUE = 1; // fully opaque cubes
export const PASS_CUTOUT = 2; // alpha-tested cubes (leaves, glass)
export const PASS_CROSS = 3; // alpha-tested X-shaped sprites (grass, flowers)
export const PASS_TRANSPARENT = 4; // blended (water, ice)

const defs = [];

function def(name, opts) {
  const id = defs.length;
  const block = {
    id,
    name,
    label: opts.label ?? name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    tiles: opts.tiles ?? [opts.tile, opts.tile, opts.tile, opts.tile, opts.tile, opts.tile],
    pass: opts.pass ?? PASS_OPAQUE,
    solid: opts.solid ?? true,
    opaque: opts.opaque ?? (opts.pass ?? PASS_OPAQUE) === PASS_OPAQUE,
    attenuation: opts.attenuation ?? 0,
    light: opts.light ?? 0,
    liquid: opts.liquid ?? false,
    climbable: opts.climbable ?? false,
    hurts: opts.hurts ?? false,
    sound: opts.sound ?? 'stone',
    creative: opts.creative ?? true,
    /** Multiplies the sampled texture — lets one tile serve several blocks. */
    tint: opts.tint ?? null,
  };
  defs.push(block);
  return block;
}

/** Convenience: [top, side, bottom] → face array. */
const tsb = (top, side, bottom) => [side, side, top, bottom, side, side];
/** Convenience: pillar (log-like) → face array. */
const pillar = (top, side) => [side, side, top, top, side, side];

// ── Registry ────────────────────────────────────────────────────────────────

export const AIR = def('air', { tile: 'stone', pass: PASS_NONE, solid: false, opaque: false, creative: false }).id;

export const STONE = def('stone', { tile: 'stone', sound: 'stone' }).id;
export const GRANITE = def('granite', { tile: 'granite', sound: 'stone' }).id;
export const ANDESITE = def('andesite', { tile: 'andesite', sound: 'stone' }).id;
export const DIRT = def('dirt', { tile: 'dirt', sound: 'gravel' }).id;
export const GRASS = def('grass_block', { label: 'Grass Block', tiles: tsb('grass_top', 'grass_side', 'dirt'), sound: 'grass' }).id;
export const SAND = def('sand', { tile: 'sand', sound: 'sand' }).id;
export const GRAVEL = def('gravel', { tile: 'gravel', sound: 'gravel' }).id;
export const CLAY = def('clay', { tile: 'clay', sound: 'gravel' }).id;
export const COBBLESTONE = def('cobblestone', { tile: 'cobblestone', sound: 'stone' }).id;
export const MOSSY_COBBLESTONE = def('mossy_cobblestone', { tile: 'mossy_cobblestone', sound: 'stone' }).id;
export const STONE_BRICKS = def('stone_bricks', { tile: 'stone_bricks', sound: 'stone' }).id;
export const BRICKS = def('bricks', { tile: 'bricks', sound: 'stone' }).id;
export const BEDROCK = def('bedrock', { tile: 'bedrock', sound: 'stone', creative: false }).id;
export const OBSIDIAN = def('obsidian', { tile: 'obsidian', sound: 'stone' }).id;

export const OAK_LOG = def('oak_log', { tiles: pillar('log_top', 'log_side'), sound: 'wood' }).id;
export const OAK_LEAVES = def('oak_leaves', {
  tile: 'leaves',
  pass: PASS_CUTOUT,
  opaque: false,
  attenuation: 1,
  sound: 'grass',
}).id;
export const BIRCH_LOG = def('birch_log', { tiles: pillar('birch_log_top', 'birch_log_side'), sound: 'wood' }).id;
export const BIRCH_LEAVES = def('birch_leaves', {
  tile: 'birch_leaves',
  pass: PASS_CUTOUT,
  opaque: false,
  attenuation: 1,
  sound: 'grass',
}).id;
export const PLANKS = def('oak_planks', { tile: 'planks', sound: 'wood' }).id;
export const BIRCH_PLANKS = def('birch_planks', { tile: 'birch_planks', sound: 'wood' }).id;

export const SANDSTONE = def('sandstone', { tiles: tsb('sandstone_top', 'sandstone_side', 'sandstone_top'), sound: 'stone' }).id;
export const SNOW = def('snow_block', { label: 'Snow Block', tile: 'snow', sound: 'snow' }).id;
export const SNOWY_GRASS = def('snowy_grass', { tiles: tsb('snow', 'snowy_grass_side', 'dirt'), sound: 'snow' }).id;
export const PODZOL = def('podzol', { tiles: tsb('podzol_top', 'podzol_side', 'dirt'), sound: 'grass' }).id;

export const COAL_ORE = def('coal_ore', { tile: 'coal_ore', sound: 'stone' }).id;
export const IRON_ORE = def('iron_ore', { tile: 'iron_ore', sound: 'stone' }).id;
export const GOLD_ORE = def('gold_ore', { tile: 'gold_ore', sound: 'stone' }).id;
export const DIAMOND_ORE = def('diamond_ore', { tile: 'diamond_ore', sound: 'stone' }).id;
export const REDSTONE_ORE = def('redstone_ore', { tile: 'redstone_ore', sound: 'stone' }).id;

export const GLOWSTONE = def('glowstone', { tile: 'glowstone', light: 15, sound: 'glass' }).id;
export const SEA_LANTERN = def('sea_lantern', { tile: 'sea_lantern', light: 14, sound: 'glass' }).id;

export const CACTUS = def('cactus', { tiles: tsb('cactus_top', 'cactus_side', 'cactus_top'), sound: 'grass', hurts: true }).id;
export const PUMPKIN = def('pumpkin', { tiles: tsb('pumpkin_top', 'pumpkin_side', 'pumpkin_top'), sound: 'wood' }).id;

export const GLASS = def('glass', { tile: 'glass', pass: PASS_CUTOUT, opaque: false, sound: 'glass' }).id;

export const WATER = def('water', {
  tile: 'water',
  pass: PASS_TRANSPARENT,
  solid: false,
  opaque: false,
  liquid: true,
  attenuation: 1,
  sound: 'water',
  creative: false,
}).id;
export const ICE = def('ice', { tile: 'ice', pass: PASS_TRANSPARENT, opaque: false, attenuation: 1, sound: 'glass' }).id;

export const TALL_GRASS = def('tall_grass', { tile: 'tall_grass', pass: PASS_CROSS, solid: false, opaque: false, sound: 'grass' }).id;
export const FERN = def('fern', { tile: 'fern', pass: PASS_CROSS, solid: false, opaque: false, sound: 'grass' }).id;
export const FLOWER_RED = def('poppy', { tile: 'flower_red', pass: PASS_CROSS, solid: false, opaque: false, sound: 'grass' }).id;
export const FLOWER_YELLOW = def('dandelion', { tile: 'flower_yellow', pass: PASS_CROSS, solid: false, opaque: false, sound: 'grass' }).id;
export const FLOWER_BLUE = def('cornflower', { tile: 'flower_blue', pass: PASS_CROSS, solid: false, opaque: false, sound: 'grass' }).id;
export const DEAD_BUSH = def('dead_bush', { tile: 'dead_bush', pass: PASS_CROSS, solid: false, opaque: false, sound: 'grass' }).id;
export const TORCH = def('torch', { tile: 'torch', pass: PASS_CROSS, solid: false, opaque: false, light: 14, sound: 'wood' }).id;

export const WOOL_WHITE = def('white_wool', { tile: 'wool_white', sound: 'wool' }).id;
export const WOOL_RED = def('red_wool', { tile: 'wool_red', sound: 'wool' }).id;
export const WOOL_ORANGE = def('orange_wool', { tile: 'wool_orange', sound: 'wool' }).id;
export const WOOL_YELLOW = def('yellow_wool', { tile: 'wool_yellow', sound: 'wool' }).id;
export const WOOL_GREEN = def('green_wool', { tile: 'wool_green', sound: 'wool' }).id;
export const WOOL_CYAN = def('cyan_wool', { tile: 'wool_cyan', sound: 'wool' }).id;
export const WOOL_BLUE = def('blue_wool', { tile: 'wool_blue', sound: 'wool' }).id;
export const WOOL_PURPLE = def('purple_wool', { tile: 'wool_purple', sound: 'wool' }).id;
export const WOOL_BLACK = def('black_wool', { tile: 'wool_black', sound: 'wool' }).id;

export const BLOCKS = defs;
export const BLOCK_COUNT = defs.length;

export const byName = Object.fromEntries(defs.map((b) => [b.name, b]));

// ── Typed lookup tables (hot path friendly) ─────────────────────────────────

export const IS_OPAQUE = new Uint8Array(BLOCK_COUNT);
export const IS_SOLID = new Uint8Array(BLOCK_COUNT);
export const IS_LIQUID = new Uint8Array(BLOCK_COUNT);
export const IS_CROSS = new Uint8Array(BLOCK_COUNT);
export const IS_HURT = new Uint8Array(BLOCK_COUNT);
export const PASS_OF = new Uint8Array(BLOCK_COUNT);
export const LIGHT_EMIT = new Uint8Array(BLOCK_COUNT);
export const ATTENUATION = new Uint8Array(BLOCK_COUNT);

for (const b of defs) {
  IS_OPAQUE[b.id] = b.opaque ? 1 : 0;
  IS_SOLID[b.id] = b.solid ? 1 : 0;
  IS_LIQUID[b.id] = b.liquid ? 1 : 0;
  IS_CROSS[b.id] = b.pass === PASS_CROSS ? 1 : 0;
  IS_HURT[b.id] = b.hurts ? 1 : 0;
  PASS_OF[b.id] = b.pass;
  LIGHT_EMIT[b.id] = b.light;
  ATTENUATION[b.id] = Math.max(b.attenuation, b.opaque ? 15 : 0);
}

/** Blocks that a placed block can replace (grass, water, air…). */
export function isReplaceable(id) {
  return id === AIR || id === WATER || IS_CROSS[id] === 1;
}

/** Does a face of `id` get culled by neighbour `other`? */
export function occludes(id, other) {
  if (IS_OPAQUE[other]) return true;
  // Same non-opaque cube types merge (glass↔glass, water↔water, ice↔ice)
  if (id === other && (other === GLASS || other === WATER || other === ICE)) return true;
  // Water is hidden by any solid, non-opaque cube sitting next to it
  if (id === WATER && (other === ICE || other === GLASS)) return true;
  return false;
}

// ── Texture atlas layout ────────────────────────────────────────────────────
// Tile names are collected in registry order, which makes the layer index of
// every tile deterministic and identical on the main thread and in workers.

const tileNames = [];
const tileIndex = new Map();
for (const b of defs) {
  for (const t of b.tiles) {
    if (!tileIndex.has(t)) {
      tileIndex.set(t, tileNames.length);
      tileNames.push(t);
    }
  }
}

export const TILE_NAMES = tileNames;
export const TILE_COUNT = tileNames.length;
export const tileIndexOf = (name) => tileIndex.get(name);

/** BLOCK_TILES[id * 6 + face] → texture-array layer. */
export const BLOCK_TILES = new Uint16Array(BLOCK_COUNT * 6);
for (const b of defs) {
  for (let f = 0; f < 6; f++) BLOCK_TILES[b.id * 6 + f] = tileIndex.get(b.tiles[f]);
}

/** Which block goes in each of the 9 default hotbar slots. */
export const DEFAULT_HOTBAR = [GRASS, DIRT, STONE, COBBLESTONE, PLANKS, OAK_LOG, GLASS, SAND, TORCH];

/** All blocks shown in the creative inventory, in registry order. */
export const CREATIVE_BLOCKS = defs.filter((b) => b.creative).map((b) => b.id);
