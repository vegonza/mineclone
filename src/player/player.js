import { Vector3 } from 'three';
import {
  FLY_SPEED, FLY_SPRINT_SPEED, GRAVITY, JUMP_SPEED, PLAYER_EYE, PLAYER_HEIGHT, PLAYER_WIDTH,
  SNEAK_EYE, SNEAK_SPEED, SPRINT_SPEED, SWIM_SPEED, TERMINAL_VELOCITY, WALK_SPEED,
  WATER_TERMINAL_VELOCITY, CHUNK_SY,
} from '../core/constants.js';
import { IS_LIQUID, IS_SOLID } from '../core/blocks.js';

const EPS = 1e-3;
const HALF = PLAYER_WIDTH / 2;

/** Highest speed we allow inside one substep, in blocks. */
const MAX_STEP = 0.35;

export class Player {
  constructor(world) {
    this.world = world;
    this.position = new Vector3(0, 80, 0);
    this.velocity = new Vector3();
    this.yaw = 0;
    this.pitch = 0;

    this.onGround = false;
    this.inWater = false;
    this.headInWater = false;
    this.flying = false;
    this.sprinting = false;
    this.sneaking = false;

    this.bobPhase = 0;
    this.bobAmount = 0;
    this.eyeHeight = PLAYER_EYE;
    this.fovBoost = 0;

    this.lastFootstep = 0;
    this.spawn = new Vector3(0, 80, 0);
  }

  get height() {
    return this.sneaking && this.onGround ? PLAYER_HEIGHT - 0.3 : PLAYER_HEIGHT;
  }

  eyePosition(out = new Vector3()) {
    return out.set(this.position.x, this.position.y + this.eyeHeight, this.position.z);
  }

  lookDirection(out = new Vector3()) {
    const cp = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }

  respawn() {
    this.position.copy(this.spawn);
    this.velocity.set(0, 0, 0);
    this.flying = false;
  }

  update(dt, input) {
    const world = this.world;

    // Fluid state is sampled before we move so jumps out of water feel right.
    this.headInWater = IS_LIQUID[world.getBlock(
      Math.floor(this.position.x),
      Math.floor(this.position.y + this.eyeHeight),
      Math.floor(this.position.z),
    )] === 1;
    this.inWater = this._feetInWater();

    this.sneaking = input.sneak && !this.flying;
    this.sprinting = input.sprint && (input.forward > 0.1) && !this.sneaking;

    if (this.flying && this.inWater) this.flying = false;

    // ── Desired horizontal velocity ─────────────────────────────────────────
    const speed = this.flying
      ? (input.sprint ? FLY_SPRINT_SPEED : FLY_SPEED)
      : this.inWater
        ? SWIM_SPEED
        : this.sneaking
          ? SNEAK_SPEED
          : this.sprinting
            ? SPRINT_SPEED
            : WALK_SPEED;

    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    let wishX = -input.strafe * cos - input.forward * sin;
    let wishZ = input.strafe * sin - input.forward * cos;

    const len = Math.hypot(wishX, wishZ);
    if (len > 1) {
      wishX /= len;
      wishZ /= len;
    }

    const targetX = wishX * speed;
    const targetZ = wishZ * speed;

    const control = this.flying ? 9 : this.inWater ? 5.5 : this.onGround ? 14 : 3.2;
    const blend = 1 - Math.exp(-control * dt);
    this.velocity.x += (targetX - this.velocity.x) * blend;
    this.velocity.z += (targetZ - this.velocity.z) * blend;

    // ── Vertical ────────────────────────────────────────────────────────────
    if (this.flying) {
      const vy = (input.jump ? 1 : 0) - (input.sneak ? 1 : 0);
      this.velocity.y += (vy * speed * 0.8 - this.velocity.y) * (1 - Math.exp(-11 * dt));
    } else if (this.inWater) {
      this.velocity.y -= GRAVITY * 0.28 * dt;
      if (input.jump) this.velocity.y += 22 * dt;
      else if (this.velocity.y < 0) this.velocity.y *= Math.exp(-3.4 * dt); // slow sinking
      this.velocity.y = Math.max(this.velocity.y, -WATER_TERMINAL_VELOCITY);
      this.velocity.y = Math.min(this.velocity.y, 4.2);
    } else {
      this.velocity.y -= GRAVITY * dt;
      this.velocity.y = Math.max(this.velocity.y, -TERMINAL_VELOCITY);
      if (input.jump && this.onGround) {
        this.velocity.y = JUMP_SPEED;
        this.onGround = false;
      }
    }

    // ── Integrate with substepped AABB collision ────────────────────────────
    const dx = this.velocity.x * dt;
    const dy = this.velocity.y * dt;
    const dz = this.velocity.z * dt;
    const maxComp = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
    const steps = Math.max(1, Math.ceil(maxComp / MAX_STEP));

    const wasOnGround = this.onGround;
    this.onGround = false;

    for (let i = 0; i < steps; i++) {
      this._moveAxis(1, dy / steps);
      this._moveAxis(0, dx / steps);
      this._moveAxis(2, dz / steps);
    }

    // Sneaking on a ledge: refuse to walk off the block you are standing on.
    if (this.sneaking && wasOnGround && !this.onGround && this.velocity.y <= 0) {
      this.position.x -= dx;
      this.position.z -= dz;
      if (this._supported()) {
        this.onGround = true;
        this.velocity.x = 0;
        this.velocity.z = 0;
      } else {
        this.position.x += dx;
        this.position.z += dz;
      }
    }

    if (this.onGround && this.velocity.y < 0) this.velocity.y = 0;

    // ── Camera feel ─────────────────────────────────────────────────────────
    const horizSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    if (this.onGround && horizSpeed > 0.6) this.bobPhase += dt * horizSpeed * 2.1;
    const wantBob = this.onGround && horizSpeed > 0.6 ? Math.min(horizSpeed / SPRINT_SPEED, 1) : 0;
    this.bobAmount += (wantBob - this.bobAmount) * (1 - Math.exp(-11 * dt));

    const targetEye = this.sneaking ? SNEAK_EYE : PLAYER_EYE;
    this.eyeHeight += (targetEye - this.eyeHeight) * (1 - Math.exp(-16 * dt));

    const wantFov = (this.sprinting && horizSpeed > 1 ? 1 : 0) + (this.flying && input.sprint ? 0.7 : 0);
    this.fovBoost += (wantFov - this.fovBoost) * (1 - Math.exp(-8 * dt));

    if (this.position.y < -12) this.respawn();
  }

  _feetInWater() {
    const x = Math.floor(this.position.x);
    const z = Math.floor(this.position.z);
    const y0 = Math.floor(this.position.y + 0.1);
    const y1 = Math.floor(this.position.y + 0.9);
    return IS_LIQUID[this.world.getBlock(x, y0, z)] === 1 || IS_LIQUID[this.world.getBlock(x, y1, z)] === 1;
  }

  /** Is there solid ground directly beneath the (possibly moved) AABB? */
  _supported() {
    const y = Math.floor(this.position.y - 0.06);
    const minX = Math.floor(this.position.x - HALF + EPS);
    const maxX = Math.floor(this.position.x + HALF - EPS);
    const minZ = Math.floor(this.position.z - HALF + EPS);
    const maxZ = Math.floor(this.position.z + HALF - EPS);
    for (let x = minX; x <= maxX; x++) {
      for (let z = minZ; z <= maxZ; z++) {
        if (IS_SOLID[this.world.getBlock(x, y, z)]) return true;
      }
    }
    return false;
  }

  /**
   * Moves the AABB along one axis and snaps it out of whatever it hit.
   * @param {0|1|2} axis
   */
  _moveAxis(axis, delta) {
    if (delta === 0) return;
    const pos = this.position;
    const comp = axis === 0 ? 'x' : axis === 1 ? 'y' : 'z';
    pos[comp] += delta;

    const height = this.height;
    const minX = pos.x - HALF;
    const maxX = pos.x + HALF;
    const minY = pos.y;
    const maxY = pos.y + height;
    const minZ = pos.z - HALF;
    const maxZ = pos.z + HALF;

    const bx0 = Math.floor(minX + EPS);
    const bx1 = Math.floor(maxX - EPS);
    const by0 = Math.floor(minY + EPS);
    const by1 = Math.floor(maxY - EPS);
    const bz0 = Math.floor(minZ + EPS);
    const bz1 = Math.floor(maxZ - EPS);

    let snap = delta > 0 ? Infinity : -Infinity;
    let hit = false;

    for (let y = by0; y <= by1; y++) {
      if (y < 0 || y >= CHUNK_SY) continue;
      for (let z = bz0; z <= bz1; z++) {
        for (let x = bx0; x <= bx1; x++) {
          if (!IS_SOLID[this.world.getBlock(x, y, z)]) continue;
          hit = true;
          const b = axis === 0 ? x : axis === 1 ? y : z;
          if (delta > 0) snap = Math.min(snap, b);
          else snap = Math.max(snap, b);
        }
      }
    }

    if (!hit) return;

    if (axis === 1) {
      if (delta > 0) {
        pos.y = snap - height - EPS;
        this.velocity.y = Math.min(this.velocity.y, 0);
      } else {
        pos.y = snap + 1 + EPS;
        this.onGround = true;
        this.velocity.y = Math.max(this.velocity.y, 0);
      }
    } else {
      if (delta > 0) pos[comp] = snap - HALF - EPS;
      else pos[comp] = snap + 1 + HALF + EPS;
      this.velocity[comp] = 0;
    }
  }

  /** True if the given block-space AABB would intersect the player. */
  intersectsBlock(bx, by, bz) {
    const p = this.position;
    return (
      bx + 1 > p.x - HALF && bx < p.x + HALF &&
      by + 1 > p.y && by < p.y + this.height &&
      bz + 1 > p.z - HALF && bz < p.z + HALF
    );
  }
}
