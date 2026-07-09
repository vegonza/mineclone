import { BufferAttribute, BufferGeometry, Group, Mesh, Sphere, Vector3 } from 'three';
import {
  CHUNK_SX, CHUNK_SY, CHUNK_SZ, PAD_AREA, PAD_SX, PAD_VOLUME,
  STRIDE_Y, STRIDE_Z, MAX_LIGHT, MAX_CHUNK_UPLOADS_PER_FRAME,
} from '../core/constants.js';
import { AIR, ATTENUATION, IS_OPAQUE, IS_SOLID, LIGHT_EMIT } from '../core/blocks.js';
import { Chunk, ChunkState } from './chunk.js';
import { BIOME_NAMES } from './generator.js';

/** Numeric chunk key — avoids string allocation in very hot lookups. */
const ckey = (cx, cz) => (cx + 0x8000) * 0x10000 + (cz + 0x8000);

/** Six axis neighbours, flattened. */
const NB = [1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1];

// ── Worker pool ─────────────────────────────────────────────────────────────

class WorkerPool {
  constructor(size, seed, onMessage) {
    this.workers = [];
    this.busy = [];
    this.queue = [];
    this.onMessage = onMessage;
    this.pending = 0;

    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => {
        if (e.data.type === 'ready') return;
        this.busy[i] = false;
        this.pending--;
        this.onMessage(e.data);
        this._drain();
      };
      w.postMessage({ type: 'init', seed });
      this.workers.push(w);
      this.busy.push(false);
    }
  }

  post(msg, transfer) {
    this.queue.push([msg, transfer]);
    this._drain();
  }

  _drain() {
    for (let i = 0; i < this.workers.length && this.queue.length; i++) {
      if (this.busy[i]) continue;
      const [msg, transfer] = this.queue.shift();
      this.busy[i] = true;
      this.pending++;
      this.workers[i].postMessage(msg, transfer ?? []);
    }
  }

  get queued() {
    return this.queue.length + this.pending;
  }

  dispose() {
    for (const w of this.workers) w.terminate();
    this.workers.length = 0;
  }
}

// ── Flat FIFO for light propagation ─────────────────────────────────────────

class LightQueue {
  constructor(stride) {
    this.stride = stride;
    this.data = new Int32Array(8192 * stride);
    this.head = 0;
    this.tail = 0;
  }

  push(a, b, c, d) {
    if ((this.tail + 1) * this.stride > this.data.length) this._grow();
    const i = this.tail * this.stride;
    const data = this.data;
    data[i] = a;
    data[i + 1] = b;
    data[i + 2] = c;
    if (this.stride === 4) data[i + 3] = d;
    this.tail++;
  }

  _grow() {
    if (this.head > 0) {
      this.data.copyWithin(0, this.head * this.stride, this.tail * this.stride);
      this.tail -= this.head;
      this.head = 0;
      if ((this.tail + 1) * this.stride <= this.data.length) return;
    }
    const next = new Int32Array(this.data.length * 2);
    next.set(this.data);
    this.data = next;
  }

  get size() {
    return this.tail - this.head;
  }

  clear() {
    this.head = this.tail = 0;
  }
}

// ── World ───────────────────────────────────────────────────────────────────

export class World {
  constructor(seed, opts) {
    this.seed = seed >>> 0;
    this.opts = opts;
    /** @type {Map<number, Chunk>} */
    this.chunks = new Map();
    this.group = new Group();

    this.renderDistance = opts.renderDistance ?? 8;
    this.centerCX = Infinity;
    this.centerCZ = Infinity;

    /** @type {Set<Chunk>} */
    this.dirtyMeshes = new Set();
    this.meshResults = [];
    this.pendingMeshable = 0;
    this.generationRequests = 0;
    this.generatedCount = 0;

    this.sunAdd = new LightQueue(3);
    this.sunRemove = new LightQueue(4);
    this.blockAdd = new LightQueue(3);
    this.blockRemove = new LightQueue(4);

    this.pool = new WorkerPool(
      Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 1)),
      this.seed,
      (msg) => this._onWorkerMessage(msg),
    );

    this._ccx = Infinity;
    this._ccz = Infinity;
    this._cc = undefined;
    this._meshRevision = new Map();
  }

  dispose() {
    this.pool.dispose();
    for (const chunk of this.chunks.values()) chunk.dispose();
    this.chunks.clear();
    this.group.clear();
  }

  // ── Chunk access ──────────────────────────────────────────────────────────

  /** Cached lookup: BFS walks hit the same chunk over and over. */
  _chunk(cx, cz) {
    if (cx === this._ccx && cz === this._ccz) return this._cc;
    const c = this.chunks.get(ckey(cx, cz));
    const r = c && c.blocks ? c : undefined;
    this._ccx = cx;
    this._ccz = cz;
    this._cc = r;
    return r;
  }

  _invalidateCache() {
    this._ccx = Infinity;
    this._ccz = Infinity;
    this._cc = undefined;
  }

  getChunk(cx, cz) {
    return this.chunks.get(ckey(cx, cz));
  }

  getBlock(wx, wy, wz) {
    if (wy < 0 || wy >= CHUNK_SY) return AIR;
    const chunk = this._chunk(wx >> 4, wz >> 4);
    if (!chunk) return AIR;
    return chunk.blocks[(wx & 15) + (wz & 15) * STRIDE_Z + wy * STRIDE_Y];
  }

  /** -1 when the chunk isn't loaded, so callers can tell air from unknown. */
  getBlockOrNull(wx, wy, wz) {
    if (wy < 0 || wy >= CHUNK_SY) return -1;
    const chunk = this._chunk(wx >> 4, wz >> 4);
    if (!chunk) return -1;
    return chunk.blocks[(wx & 15) + (wz & 15) * STRIDE_Z + wy * STRIDE_Y];
  }

  isSolid(wx, wy, wz) {
    return IS_SOLID[this.getBlock(wx, wy, wz)] === 1;
  }

  isLoadedAt(wx, wz) {
    return !!this._chunk(wx >> 4, wz >> 4);
  }

  getBiomeName(wx, wz) {
    const chunk = this._chunk(wx >> 4, wz >> 4);
    if (!chunk || !chunk.biomes) return '—';
    return BIOME_NAMES[chunk.biomes[(wx & 15) + (wz & 15) * CHUNK_SX]] ?? '—';
  }

  getLightAt(wx, wy, wz) {
    if (wy < 0) return 0;
    if (wy >= CHUNK_SY) return 0xf0;
    const chunk = this._chunk(wx >> 4, wz >> 4);
    if (!chunk) return 0;
    return chunk.light[(wx & 15) + (wz & 15) * STRIDE_Z + wy * STRIDE_Y];
  }

  // ── Streaming ─────────────────────────────────────────────────────────────

  updateStreaming(px, pz) {
    const cx = Math.floor(px) >> 4;
    const cz = Math.floor(pz) >> 4;
    if (cx === this.centerCX && cz === this.centerCZ) return;
    this.centerCX = cx;
    this.centerCZ = cz;

    const r = this.renderDistance + 1;
    const rr = r * r;
    const wanted = new Set();
    const toLoad = [];

    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const d2 = dx * dx + dz * dz;
        if (d2 > rr) continue;
        const key = ckey(cx + dx, cz + dz);
        wanted.add(key);
        if (!this.chunks.has(key)) toLoad.push([cx + dx, cz + dz, d2]);
      }
    }

    toLoad.sort((a, b) => a[2] - b[2]);
    for (const [x, z] of toLoad) this._requestChunk(x, z);

    for (const [key, chunk] of this.chunks) {
      if (wanted.has(key)) continue;
      if (chunk.state === ChunkState.GENERATING || chunk.meshPending) continue;
      this.opts.store?.flushChunk(chunk);
      chunk.dispose();
      this.chunks.delete(key);
      this.dirtyMeshes.delete(chunk);
    }
    this._invalidateCache();
  }

  _requestChunk(cx, cz) {
    const key = ckey(cx, cz);
    if (this.chunks.has(key)) return;
    const chunk = new Chunk(cx, cz);
    chunk.key = key;
    chunk.state = ChunkState.GENERATING;
    this.chunks.set(key, chunk);
    this._invalidateCache();
    this.generationRequests++;
    this.pool.post({ type: 'generate', cx, cz });
  }

  _onWorkerMessage(msg) {
    if (msg.type === 'generated') {
      const chunk = this.getChunk(msg.cx, msg.cz);
      if (!chunk) return; // unloaded while the job was in flight
      chunk.blocks = msg.blocks;
      chunk.biomes = msg.biomes;
      chunk.heights = msg.heights;
      chunk.state = ChunkState.READY;
      this.generatedCount++;
      this._invalidateCache();

      const edits = this.opts.store?.getEdits(msg.cx, msg.cz);
      if (edits) chunk.applyEdits(edits);

      chunk.computeTopmost();
      this._initialLight(chunk);
      this._markDirtyWithNeighbours(msg.cx, msg.cz);
    } else if (msg.type === 'meshed') {
      const chunk = this.getChunk(msg.cx, msg.cz);
      if (!chunk) return;
      chunk.meshPending = false;
      if (this._meshRevision.get(chunk.key) !== msg.revision) return; // stale
      this.meshResults.push(msg);
    }
  }

  _markDirty(chunk) {
    if (chunk.meshDirty) return;
    chunk.meshDirty = true;
    this.dirtyMeshes.add(chunk);
  }

  _markDirtyWithNeighbours(cx, cz) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const c = this._chunk(cx + dx, cz + dz);
        if (c) this._markDirty(c);
      }
    }
  }

  // ── Lighting ──────────────────────────────────────────────────────────────

  /**
   * Sky light streams straight down each column; the fill only *seeds* the BFS
   * at cells that can actually change something — i.e. cells at or below the
   * tallest neighbouring column. Everything above is uniformly full-bright.
   */
  _initialLight(chunk) {
    const { blocks, light, topmost } = chunk;
    light.fill(0);

    const ox = chunk.cx * CHUNK_SX;
    const oz = chunk.cz * CHUNK_SZ;

    // 18×18 height field including a 1-block border from loaded neighbours.
    const tops = new Int16Array(PAD_SX * PAD_SX);
    for (let z = -1; z <= CHUNK_SZ; z++) {
      for (let x = -1; x <= CHUNK_SX; x++) {
        let t;
        if (x >= 0 && x < CHUNK_SX && z >= 0 && z < CHUNK_SZ) {
          t = topmost[x + z * CHUNK_SX];
        } else {
          const n = this._chunk(chunk.cx + (x < 0 ? -1 : x >= CHUNK_SX ? 1 : 0), chunk.cz + (z < 0 ? -1 : z >= CHUNK_SZ ? 1 : 0));
          t = n ? n.topmost[(x & 15) + (z & 15) * CHUNK_SX] : topmost[Math.min(Math.max(x, 0), 15) + Math.min(Math.max(z, 0), 15) * CHUNK_SX];
        }
        tops[x + 1 + (z + 1) * PAD_SX] = t;
      }
    }

    for (let z = 0; z < CHUNK_SZ; z++) {
      for (let x = 0; x < CHUNK_SX; x++) {
        const col = x + z * STRIDE_Z;
        const p = x + 1 + (z + 1) * PAD_SX;
        const seedCeil = Math.max(tops[p - 1], tops[p + 1], tops[p - PAD_SX], tops[p + PAD_SX]) + 1;

        let level = MAX_LIGHT;
        for (let y = CHUNK_SY - 1; y >= 0; y--) {
          const i = col + y * STRIDE_Y;
          const att = ATTENUATION[blocks[i]];
          if (att >= MAX_LIGHT) break;
          if (att > 0) level -= att;
          if (level <= 0) break;
          light[i] = level << 4;
          if (y <= seedCeil) this.sunAdd.push(ox + x, y, oz + z);
        }
      }
    }

    // Only player edits can introduce emitters, so skip the scan otherwise.
    if (chunk.edits) {
      for (const [i, id] of chunk.edits) {
        const emit = LIGHT_EMIT[id];
        if (emit === 0) continue;
        light[i] = (light[i] & 0xf0) | emit;
        const y = (i / STRIDE_Y) | 0;
        const rem = i - y * STRIDE_Y;
        const z = (rem / STRIDE_Z) | 0;
        this.blockAdd.push(ox + (rem - z * STRIDE_Z), y, oz + z);
      }
    }

    // Let already-loaded neighbours bleed their light into the new chunk.
    for (let s = 0; s < 4; s++) {
      const dx = s === 0 ? -1 : s === 1 ? 1 : 0;
      const dz = s === 2 ? -1 : s === 3 ? 1 : 0;
      const n = this._chunk(chunk.cx + dx, chunk.cz + dz);
      if (!n) continue;

      const ceil = Math.min(CHUNK_SY - 1, Math.max(chunk.maxTop, n.maxTop) + 1);
      const nox = n.cx * CHUNK_SX;
      const noz = n.cz * CHUNK_SZ;
      const fx = dx === -1 ? CHUNK_SX - 1 : dx === 1 ? 0 : -1;
      const fz = dz === -1 ? CHUNK_SZ - 1 : dz === 1 ? 0 : -1;

      for (let y = 0; y <= ceil; y++) {
        for (let t = 0; t < CHUNK_SX; t++) {
          const lx = fx === -1 ? t : fx;
          const lz = fz === -1 ? t : fz;
          const l = n.light[lx + lz * STRIDE_Z + y * STRIDE_Y];
          if (l === 0) continue;
          if (l & 0xf0) this.sunAdd.push(nox + lx, y, noz + lz);
          if (l & 0x0f) this.blockAdd.push(nox + lx, y, noz + lz);
        }
      }
    }
  }

  _setSky(wx, wy, wz, v) {
    const chunk = this._chunk(wx >> 4, wz >> 4);
    if (!chunk) return;
    const lx = wx & 15;
    const lz = wz & 15;
    const i = lx + lz * STRIDE_Z + wy * STRIDE_Y;
    chunk.light[i] = (chunk.light[i] & 0x0f) | (v << 4);
    this._touch(chunk, lx, lz);
  }

  _setBlockLight(wx, wy, wz, v) {
    const chunk = this._chunk(wx >> 4, wz >> 4);
    if (!chunk) return;
    const lx = wx & 15;
    const lz = wz & 15;
    const i = lx + lz * STRIDE_Z + wy * STRIDE_Y;
    chunk.light[i] = (chunk.light[i] & 0xf0) | v;
    this._touch(chunk, lx, lz);
  }

  /** A cell on a chunk border is sampled by the neighbour's mesh too. */
  _touch(chunk, lx, lz) {
    this._markDirty(chunk);
    if (lx !== 0 && lx !== 15 && lz !== 0 && lz !== 15) return;
    const dxs = lx === 0 ? -1 : lx === 15 ? 1 : 0;
    const dzs = lz === 0 ? -1 : lz === 15 ? 1 : 0;
    if (dxs) {
      const n = this._chunk(chunk.cx + dxs, chunk.cz);
      if (n) this._markDirty(n);
    }
    if (dzs) {
      const n = this._chunk(chunk.cx, chunk.cz + dzs);
      if (n) this._markDirty(n);
    }
    if (dxs && dzs) {
      const n = this._chunk(chunk.cx + dxs, chunk.cz + dzs);
      if (n) this._markDirty(n);
    }
  }

  _sky(wx, wy, wz) {
    return this.getLightAt(wx, wy, wz) >> 4;
  }

  _blockLight(wx, wy, wz) {
    return this.getLightAt(wx, wy, wz) & 15;
  }

  processLight(budget = 90000) {
    let work = 0;
    work += this._removal(this.sunRemove, true, budget - work);
    work += this._removal(this.blockRemove, false, budget - work);
    work += this._addition(this.sunAdd, true, budget - work);
    work += this._addition(this.blockAdd, false, budget - work);
    return work;
  }

  _addition(queue, isSky, budget) {
    let work = 0;
    const data = queue.data;

    while (queue.head < queue.tail && work < budget) {
      const i = queue.head * 3;
      const wx = data[i];
      const wy = data[i + 1];
      const wz = data[i + 2];
      queue.head++;
      work++;

      const level = isSky ? this._sky(wx, wy, wz) : this._blockLight(wx, wy, wz);
      if (level <= 0) continue;

      for (let d = 0; d < 18; d += 3) {
        const nx = wx + NB[d];
        const ny = wy + NB[d + 1];
        const nz = wz + NB[d + 2];
        if (ny < 0 || ny >= CHUNK_SY) continue;

        const nb = this.getBlockOrNull(nx, ny, nz);
        if (nb < 0) continue; // unloaded — it pulls light in when it arrives
        const att = ATTENUATION[nb];
        if (att >= MAX_LIGHT) continue;

        const target = isSky && NB[d + 1] === -1 && level === MAX_LIGHT && att === 0
          ? MAX_LIGHT
          : level - (att > 1 ? att : 1);
        if (target <= 0) continue;

        const cur = isSky ? this._sky(nx, ny, nz) : this._blockLight(nx, ny, nz);
        if (cur < target) {
          if (isSky) this._setSky(nx, ny, nz, target);
          else this._setBlockLight(nx, ny, nz, target);
          queue.push(nx, ny, nz);
        }
      }
    }
    if (queue.head >= queue.tail) queue.clear();
    return work;
  }

  _removal(queue, isSky, budget) {
    let work = 0;
    const addQueue = isSky ? this.sunAdd : this.blockAdd;

    while (queue.head < queue.tail && work < budget) {
      const data = queue.data;
      const i = queue.head * 4;
      const wx = data[i];
      const wy = data[i + 1];
      const wz = data[i + 2];
      const level = data[i + 3];
      queue.head++;
      work++;

      for (let d = 0; d < 18; d += 3) {
        const nx = wx + NB[d];
        const ny = wy + NB[d + 1];
        const nz = wz + NB[d + 2];
        if (ny < 0 || ny >= CHUNK_SY) continue;
        if (this.getBlockOrNull(nx, ny, nz) < 0) continue;

        const nLevel = isSky ? this._sky(nx, ny, nz) : this._blockLight(nx, ny, nz);
        if (nLevel === 0) continue;

        // A sunlight shaft keeps level 15 all the way down, so an *equal*
        // value below a removed cell must be cleared as well.
        const shaft = isSky && NB[d + 1] === -1 && level === MAX_LIGHT;

        if (nLevel < level || shaft) {
          if (isSky) this._setSky(nx, ny, nz, 0);
          else this._setBlockLight(nx, ny, nz, 0);
          queue.push(nx, ny, nz, nLevel);
        } else {
          addQueue.push(nx, ny, nz);
        }
      }
    }
    if (queue.head >= queue.tail) queue.clear();
    return work;
  }

  // ── Block edits ───────────────────────────────────────────────────────────

  setBlock(wx, wy, wz, id, { record = true } = {}) {
    if (wy < 0 || wy >= CHUNK_SY) return false;
    const chunk = this._chunk(wx >> 4, wz >> 4);
    if (!chunk) return false;

    const lx = wx & 15;
    const lz = wz & 15;
    const i = lx + lz * STRIDE_Z + wy * STRIDE_Y;
    const old = chunk.blocks[i];
    if (old === id) return false;

    chunk.blocks[i] = id;
    if (record) {
      chunk.recordEdit(lx, wy, lz, id);
      this.opts.store?.markDirty(chunk);
    }

    const col = lx + lz * CHUNK_SX;
    if (id !== AIR && wy > chunk.topmost[col]) {
      chunk.topmost[col] = wy;
      if (wy > chunk.maxTop) chunk.maxTop = wy;
    } else if (id === AIR && wy === chunk.topmost[col]) {
      let y = wy;
      const base = lx + lz * STRIDE_Z;
      while (y > 0 && chunk.blocks[base + y * STRIDE_Y] === AIR) y--;
      chunk.topmost[col] = y;
    }

    this._relightAfterEdit(wx, wy, wz, old, id);
    this._touch(chunk, lx, lz);
    return true;
  }

  _relightAfterEdit(wx, wy, wz, oldId, newId) {
    const oldSky = this._sky(wx, wy, wz);
    const oldBlock = this._blockLight(wx, wy, wz);

    if (oldSky > 0) {
      this._setSky(wx, wy, wz, 0);
      this.sunRemove.push(wx, wy, wz, oldSky);
    }
    if (oldBlock > 0) {
      this._setBlockLight(wx, wy, wz, 0);
      this.blockRemove.push(wx, wy, wz, oldBlock);
    }

    if (ATTENUATION[newId] < MAX_LIGHT) {
      // The cell still lets light through: re-seed from all six neighbours.
      for (let d = 0; d < 18; d += 3) {
        const nx = wx + NB[d];
        const ny = wy + NB[d + 1];
        const nz = wz + NB[d + 2];
        if (ny < 0 || ny >= CHUNK_SY) continue;
        if (this.getBlockOrNull(nx, ny, nz) < 0) continue;
        this.sunAdd.push(nx, ny, nz);
        this.blockAdd.push(nx, ny, nz);
      }
      if (wy === CHUNK_SY - 1) {
        this._setSky(wx, wy, wz, MAX_LIGHT);
        this.sunAdd.push(wx, wy, wz);
      }
    }

    const emit = LIGHT_EMIT[newId];
    if (emit > 0) {
      this._setBlockLight(wx, wy, wz, emit);
      this.blockAdd.push(wx, wy, wz);
    }
  }

  // ── Meshing ───────────────────────────────────────────────────────────────

  _canMesh(cx, cz) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!this._chunk(cx + dx, cz + dz)) return false;
      }
    }
    return true;
  }

  _buildPadded(chunk) {
    const pb = new Uint8Array(PAD_VOLUME);
    const pl = new Uint8Array(PAD_VOLUME);

    for (let y = 0; y < CHUNK_SY; y++) {
      const src = y * STRIDE_Y;
      const dst = y * PAD_AREA;
      for (let z = 0; z < CHUNK_SZ; z++) {
        const s = src + z * STRIDE_Z;
        const d = dst + (z + 1) * PAD_SX + 1;
        pb.set(chunk.blocks.subarray(s, s + CHUNK_SX), d);
        pl.set(chunk.light.subarray(s, s + CHUNK_SX), d);
      }
    }

    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        const n = this._chunk(chunk.cx + dx, chunk.cz + dz);
        if (!n) continue;

        const x0 = dx === 0 ? 0 : dx === -1 ? CHUNK_SX - 1 : 0;
        const x1 = dx === 0 ? CHUNK_SX : dx === -1 ? CHUNK_SX : 1;
        const z0 = dz === 0 ? 0 : dz === -1 ? CHUNK_SZ - 1 : 0;
        const z1 = dz === 0 ? CHUNK_SZ : dz === -1 ? CHUNK_SZ : 1;

        for (let y = 0; y < CHUNK_SY; y++) {
          for (let z = z0; z < z1; z++) {
            const pz = dz === 0 ? z : dz === -1 ? -1 : CHUNK_SZ;
            for (let x = x0; x < x1; x++) {
              const px = dx === 0 ? x : dx === -1 ? -1 : CHUNK_SX;
              const s = x + z * STRIDE_Z + y * STRIDE_Y;
              const d = px + 1 + (pz + 1) * PAD_SX + y * PAD_AREA;
              pb[d] = n.blocks[s];
              pl[d] = n.light[s];
            }
          }
        }
      }
    }

    return [pb, pl];
  }

  _dispatchMeshes(px, pz, budget) {
    this.pendingMeshable = 0;
    if (this.dirtyMeshes.size === 0) return;

    // Chunks on the outermost generated ring can never mesh — they are missing
    // a neighbour — so they stay dirty forever and must not count as pending.
    const jobs = [];
    for (const chunk of this.dirtyMeshes) {
      if (!chunk.blocks || chunk.meshPending) continue;
      if (!this._canMesh(chunk.cx, chunk.cz)) continue;
      const dx = chunk.cx * CHUNK_SX + 8 - px;
      const dz = chunk.cz * CHUNK_SZ + 8 - pz;
      jobs.push([chunk, dx * dx + dz * dz]);
    }
    if (jobs.length === 0) return;
    jobs.sort((a, b) => a[1] - b[1]);
    this.pendingMeshable = jobs.length;

    let count = 0;
    for (const [chunk] of jobs) {
      if (count >= budget) break;
      this.dirtyMeshes.delete(chunk);
      chunk.meshDirty = false;
      chunk.meshPending = true;
      const revision = (this._meshRevision.get(chunk.key) ?? 0) + 1;
      this._meshRevision.set(chunk.key, revision);
      const [pb, pl] = this._buildPadded(chunk);
      this.pool.post(
        { type: 'mesh', cx: chunk.cx, cz: chunk.cz, blocks: pb, light: pl, revision },
        [pb.buffer, pl.buffer],
      );
      count++;
    }
    this.pendingMeshable -= count;
  }

  _applyMeshResults(limit) {
    let applied = 0;
    while (this.meshResults.length && applied < limit) {
      const msg = this.meshResults.shift();
      const chunk = this.getChunk(msg.cx, msg.cz);
      if (!chunk) continue;

      for (const pass of ['opaque', 'cutout', 'transparent']) {
        const data = msg[pass];
        const existing = chunk.meshes[pass];

        if (existing) {
          this.group.remove(existing);
          existing.geometry.dispose();
          chunk.meshes[pass] = null;
        }
        if (!data) continue;

        const geo = new BufferGeometry();
        geo.setAttribute('position', new BufferAttribute(data.positions, 3));
        geo.setAttribute('aLight', new BufferAttribute(data.light, 3, true));
        geo.setAttribute('aTile', new BufferAttribute(data.tile, 2, false));
        geo.setIndex(new BufferAttribute(data.indices, 1));

        const midY = (data.minY + data.maxY) / 2;
        const halfY = (data.maxY - data.minY) / 2;
        geo.boundingSphere = new Sphere(new Vector3(8, midY, 8), Math.hypot(11.4, halfY) + 0.5);

        const mesh = new Mesh(geo, this.opts.getMaterial(pass));
        mesh.position.set(msg.cx * CHUNK_SX, 0, msg.cz * CHUNK_SZ);
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        mesh.renderOrder = pass === 'transparent' ? 2 : pass === 'cutout' ? 1 : 0;
        chunk.meshes[pass] = mesh;
        this.group.add(mesh);
      }
      applied++;
    }
  }

  update(px, py, pz) {
    this.updateStreaming(px, pz);
    this.processLight();
    this._dispatchMeshes(px, pz, this.pool.queued < 8 ? 4 : 1);
    this._applyMeshResults(MAX_CHUNK_UPLOADS_PER_FRAME);
  }

  get loadProgress() {
    if (this.generationRequests === 0) return 0;
    return this.generatedCount / this.generationRequests;
  }

  get busy() {
    return this.pool.queued + this.pendingMeshable + this.meshResults.length;
  }

  /**
   * Topmost spot at (x, z) with a full opaque block underfoot and two blocks of
   * head room. Requiring opacity keeps you from spawning on top of leaves.
   */
  findSpawn(x, z) {
    if (!this._chunk(x >> 4, z >> 4)) return null;
    for (let y = CHUNK_SY - 2; y > 1; y--) {
      if (IS_OPAQUE[this.getBlock(x, y - 1, z)] && this.getBlock(x, y, z) === AIR && this.getBlock(x, y + 1, z) === AIR) {
        return new Vector3(x + 0.5, y + 0.02, z + 0.5);
      }
    }
    return null;
  }
}
