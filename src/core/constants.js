/** Horizontal size of a chunk, in blocks. */
export const CHUNK_SX = 16;
export const CHUNK_SZ = 16;
/** Vertical size of a chunk == world height. Chunks are full-height columns. */
export const CHUNK_SY = 128;

export const CHUNK_AREA = CHUNK_SX * CHUNK_SZ;
export const CHUNK_VOLUME = CHUNK_AREA * CHUNK_SY;

/** Strides for the block/light arrays: idx = x + z * SX + y * AREA. */
export const STRIDE_X = 1;
export const STRIDE_Z = CHUNK_SX;
export const STRIDE_Y = CHUNK_AREA;

/** Padded neighbourhood used by the mesher: one block of margin on X/Z. */
export const PAD_SX = CHUNK_SX + 2;
export const PAD_SZ = CHUNK_SZ + 2;
export const PAD_AREA = PAD_SX * PAD_SZ;
export const PAD_VOLUME = PAD_AREA * CHUNK_SY;

export const SEA_LEVEL = 62;
export const MAX_LIGHT = 15;

/** Player / world tuning. */
export const GRAVITY = 30;
export const JUMP_SPEED = 8.6;
export const WALK_SPEED = 4.317;
export const SPRINT_SPEED = 5.9;
export const SNEAK_SPEED = 1.4;
export const FLY_SPEED = 11;
export const FLY_SPRINT_SPEED = 26;
export const SWIM_SPEED = 3.2;
export const TERMINAL_VELOCITY = 78;
export const WATER_TERMINAL_VELOCITY = 5;

export const PLAYER_WIDTH = 0.6;
export const PLAYER_HEIGHT = 1.8;
export const PLAYER_EYE = 1.62;
export const SNEAK_EYE = 1.42;
export const STEP_HEIGHT = 0.55;

export const REACH = 5.2;

/** Chunk streaming. */
export const RENDER_DISTANCE = 9;
export const MAX_CHUNK_UPLOADS_PER_FRAME = 2;

/** Length of a full day/night cycle, in seconds. */
export const DAY_LENGTH = 900;

export const chunkKey = (cx, cz) => `${cx},${cz}`;

/** Face directions, ordered: +X, -X, +Y, -Y, +Z, -Z. */
export const FACES = [
  { dir: [1, 0, 0], name: 'east' },
  { dir: [-1, 0, 0], name: 'west' },
  { dir: [0, 1, 0], name: 'top' },
  { dir: [0, -1, 0], name: 'bottom' },
  { dir: [0, 0, 1], name: 'south' },
  { dir: [0, 0, -1], name: 'north' },
];
