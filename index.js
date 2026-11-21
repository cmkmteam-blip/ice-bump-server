import http from 'http';
import { WebSocketServer } from 'ws';

/**
 * Ice Bump: Push Party Online v2.0 — Authoritative Global Multiplayer & Leaderboard Server
 * - Global Ranked Quick Match (level-bracketed ±6 levels + smart bot fill!)
 * - Private 4-Letter Friend Rooms (Fair Mode: equalized level for all friends!)
 * - Biomes (Snow / Desert / Grass), Tilt Arena, Meltdown, Special Bombs (Frost / Mega / Homing)
 * - Global & Country Leaderboard REST API (/leaderboard, /score)
 */

const PORT = Number(process.env.PORT || 8080);
const TICK_HZ = 20;
const TICK_DT = 1 / TICK_HZ;
const ROUND_DURATION = 90;
const STAMINA_REGEN = 46;
const ICE_ACCEL = 24;
const ICE_FRICTION = 2.65;
const TEETER_DURATION = 2.1;
const TEETER_TAPS_REQUIRED = 2;
const INSTANT_KO_SPEED = 14.5;
const BOMB_RADIUS = 2.15;
const BOMB_THROW_SPEED = 13.8;

const CHAR_SPECS = {
  foxy: { dashCost: 50, dashSpeed: 14.2, dashDuration: 0.24, pushForce: 1.0, mass: 1.0, moveSpeed: 6.2 },
  beep: { dashCost: 100, dashSpeed: 15.4, dashDuration: 0.24, pushForce: 1.48, mass: 0.92, moveSpeed: 5.9 },
  bambu: { dashCost: 72, dashSpeed: 15.6, dashDuration: 0.27, pushForce: 1.32, mass: 1.35, moveSpeed: 5.5 },
  zappy: { dashCost: 58, dashSpeed: 15.0, dashDuration: 0.25, pushForce: 1.12, mass: 0.96, moveSpeed: 6.5 },
};
const CHAR_LIST = ['foxy', 'beep', 'bambu', 'zappy'];
const BOT_NAMES = ['Waffles', 'Nugget', 'Pickles', 'Biscuit', 'Noodle', 'Taco', 'Mochi', 'Toast'];
const SPAWN_ANGLES = [Math.PI * 0.25, Math.PI * 0.75, Math.PI * 1.25, Math.PI * 1.75];
const BIOME_LIST = ['snow', 'desert', 'grass'];

const ARENAS = {
  chaos: { baseRadius: 8.2, hasEdgeLip: false, shrinks: false, tilts: false, hasBombs: true },
  tilt: { baseRadius: 8.3, hasEdgeLip: false, shrinks: false, tilts: true, hasBombs: true },
  meltdown: { baseRadius: 8.4, hasEdgeLip: false, shrinks: true, tilts: false, hasBombs: true },
  classic: { baseRadius: 8.6, hasEdgeLip: true, shrinks: false, tilts: false, hasBombs: false },
};

const BOT_DIFFS = {
  easy: { speedMult: 0.45, pushBase: 3.2, regenMult: 0.32, dashChance: 0.002, teeterDelay: 1.9, graceSec: 5.0 },
  medium: { speedMult: 0.62, pushBase: 5.2, regenMult: 0.48, dashChance: 0.006, teeterDelay: 1.35, graceSec: 3.5 },
  hard: { speedMult: 0.78, pushBase: 7.5, regenMult: 0.65, dashChance: 0.014, teeterDelay: 0.85, graceSec: 2.0 },
};

function levelBonus(level, fairMode) {
  if (fairMode) return { speedMult: 1, pushMult: 1, regenMult: 1 };
  const l = Math.max(1, Math.min(50, Number(level) || 1)) - 1;
  return { speedMult: 1 + l * 0.0035, pushMult: 1 + l * 0.005, regenMult: 1 + l * 0.004 };
}

// Live Global & Country Leaderboard (seeded with fun rivals + real players override/climb!)
const leaderboardMap = new Map([
  ['ArcticKing', { name: 'ArcticKing', country: 'SY', level: 18, trophies: 420, charId: 'bambu' }],
  ['DesertFox', { name: 'DesertFox', country: 'SA', level: 22, trophies: 510, charId: 'foxy' }],
  ['NileSled', { name: 'NileSled', country: 'EG', level: 15, trophies: 340, charId: 'beep' }],
  ['AmmanHop', { name: 'AmmanHop', country: 'JO', level: 12, trophies: 260, charId: 'zappy' }],
  ['CedarBump', { name: 'CedarBump', country: 'LB', level: 14, trophies: 310, charId: 'foxy' }],
  ['DubaiFrost', { name: 'DubaiFrost', country: 'AE', level: 25, trophies: 620, charId: 'beep' }],
  ['IstanbulIce', { name: 'IstanbulIce', country: 'TR', level: 19, trophies: 455, charId: 'bambu' }],
  ['PolarPro', { name: 'PolarPro', country: 'US', level: 28, trophies: 710, charId: 'zappy' }],
  ['BerlinBump', { name: 'BerlinBump', country: 'DE', level: 16, trophies: 375, charId: 'foxy' }],
]);

const rooms = new Map();

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(code) ? makeRoomCode() : code;
}

class Room {
  constructor(code, mode, arenaId, biome, difficulty, targetWins, hostLevel) {
    this.code = code;
    this.mode = mode; // 'quick' | 'private'
    this.fairMode = mode === 'private'; // Friends always play Fair Equal Level!
    this.bracketLevel = Number(hostLevel) || 1;
    this.arenaId = ARENAS[arenaId] ? arenaId : 'chaos';
    this.biome = BIOME_LIST.includes(biome) ? biome : BIOME_LIST[Math.floor(Math.random() * BIOME_LIST.length)];
    this.difficulty = BOT_DIFFS[difficulty] ? difficulty : 'medium';
    this.targetWins = Math.max(2, Math.min(7, Number(targetWins) || 3));
    this.clients = new Map();
    this.hostSlot = 0;
    this.started = false;
    this.autoStartTimer = mode === 'quick' ? 6.0 : null;

    this.phase = 'lobby';
    this.arenaRadius = ARENAS[this.arenaId].baseRadius;
    this.tiltX = 0;
    this.tiltZ = 0;
    this.roundNumber = 1;
    this.roundTimer = ROUND_DURATION;
    this.countdownTimer = 0;
    this.roundEndTimer = 0;
    this.lastRoundWinner = null;
    this.matchWinner = null;
    this.players = [];
    this.bombs = [];
    this.pickups = [];
    this.bombSpawnTimer = 2.2;
    this.itemSpawnTimer = 5.0;
    this.nextId = 1;
    this.botTimers = [0, 0, 0, 0];
  }

  addClient(ws, info) {
    let slot = -1;
    for (let i = 0; i < 4; i++) {
      if (!this.clients.has(i)) { slot = i; break; }
    }
    if (slot === -1) return null;
    if (this.clients.size === 0) this.hostSlot = slot;

    const client = {
      ws,
      slot,
      id: `p_${Date.now()}_${slot}`,
      name: (info.name || `Player${slot + 1}`).slice(0, 12),
      charId: CHAR_SPECS[info.charId] ? info.charId : CHAR_LIST[slot],
      level: Math.max(1, Math.min(50, Number(info.level) || 1)),
      bombType: ['classic', 'frost', 'mega', 'homing'].includes(info.bombType) ? info.bombType : 'classic',
      goldenMount: Boolean(info.goldenMount),
      input: { moveX: 0, moveZ: 0, dashPressed: false, bombPressed: false, taunt: null },
    };
    this.clients.set(slot, client);
    ws._room = this;
    ws._slot = slot;

    this.broadcastLobby();
    if (this.clients.size === 4 && !this.started) this.startMatch();
    return client;
  }

  removeClient(slot) {
    this.clients.delete(slot);
    if (this.clients.size === 0) { rooms.delete(this.code); return; }
    if (this.hostSlot === slot) this.hostSlot = [...this.clients.keys()][0];
    if (this.started && this.players[slot]) this.players[slot].isBot = true;
    else this.broadcastLobby();
  }

  broadcastLobby() {
    const players = [...this.clients.values()].map((c) => ({
      slot: c.slot, id: c.id, name: c.name, charId: c.charId, level: c.level, isBot: false, isHost: c.slot === this.hostSlot,
    }));
    for (const c of this.clients.values()) {
      if (c.ws.readyState === 1) {
        c.ws.send(JSON.stringify({
          type: 'lobby',
          lobby: {
            roomCode: this.code, mode: this.mode, arenaId: this.arenaId, biome: this.biome,
            targetWins: this.targetWins, mySlot: c.slot, isHost: c.slot === this.hostSlot,
            fairMode: this.fairMode, players, autoStartIn: this.autoStartTimer,
          },
        }));
      }
    }
  }

  startMatch() {
    this.started = true;
    this.autoStartTimer = null;
    this.roundNumber = 1;
    this.matchWinner = null;
    this.players = [];

    for (let slot = 0; slot < 4; slot++) {
      const c = this.clients.get(slot);
      this.players.push({
        slot,
        id: c ? c.id : `bot_${slot}`,
        name: c ? c.name : BOT_NAMES[slot % BOT_NAMES.length],
        charId: c ? c.charId : CHAR_LIST[slot],
        level: c ? c.level : this.bracketLevel,
        bombType: c ? c.bombType : 'classic',
        isBot: !c,
        isLocal: false,
        goldenMount: c ? c.goldenMount : false,
        x: 0, y: 0, z: 0, vx: 0, vz: 0, vy: 0, angle: 0,
        stamina: 100, idleFullTimer: 0, superCharged: false, dashTimer: 0, dashCooldown: 0, dashDirX: 0, dashDirZ: 1,
        mounted: true, alive: true, falling: false,
        teetering: false, teeterTimer: 0, teeterTaps: 0, teeterEdgeAngle: 0,
        carryingBombId: null, sizeScale: 1, sizeTimer: 0, stunTimer: 0, knockbackTimer: 0, invulnTimer: 0,
        hasLightning: false, lightningTimer: 0, hasWeight: false, weightTimer: 0,
        tauntText: null, tauntTimer: 0, wins: 0, kos: 0,
      });
    }

    this.setupRound();

    for (const c of this.clients.values()) {
      if (c.ws.readyState === 1) {
        c.ws.send(JSON.stringify({
          type: 'match_start',
          lobby: {
            roomCode: this.code, mode: this.mode, arenaId: this.arenaId, biome: this.biome,
            targetWins: this.targetWins, mySlot: c.slot, isHost: c.slot === this.hostSlot, fairMode: this.fairMode,
            players: this.players.map((p) => ({ slot: p.slot, id: p.id, name: p.name, charId: p.charId, level: p.level, isBot: p.isBot, isHost: p.slot === this.hostSlot })),
            autoStartIn: null,
          },
        }));
      }
    }
  }

  setupRound() {
    const arena = ARENAS[this.arenaId];
    this.arenaRadius = arena.baseRadius;
    this.tiltX = 0; this.tiltZ = 0;
    this.roundTimer = ROUND_DURATION;
    this.countdownTimer = 2.2;
    this.phase = 'countdown';
    this.bombs = []; this.pickups = [];
    this.bombSpawnTimer = 2.0; this.itemSpawnTimer = 5.0;
    this.lastRoundWinner = null;

    const spawnDist = this.arenaRadius * 0.5;
    for (const p of this.players) {
      const a = SPAWN_ANGLES[p.slot % 4];
      p.x = Math.cos(a) * spawnDist; p.z = Math.sin(a) * spawnDist;
      p.y = 0; p.vx = 0; p.vz = 0; p.vy = 0;
      p.angle = Math.atan2(-p.x, -p.z);
      p.stamina = 100; p.idleFullTimer = 0; p.superCharged = false; p.dashTimer = 0; p.dashCooldown = 0;
      p.mounted = true; p.alive = true; p.falling = false;
      p.teetering = false; p.teeterTimer = 0; p.teeterTaps = 0;
      p.carryingBombId = null; p.sizeScale = 1; p.sizeTimer = 0;
      p.stunTimer = 0; p.knockbackTimer = 0; p.invulnTimer = 0;
      p.hasLightning = false; p.lightningTimer = 0;
      p.hasWeight = false; p.weightTimer = 0;
      p.tauntText = null; p.tauntTimer = 0;
    }
  }

  tick(dt) {
    if (!this.started) {
      if (this.autoStartTimer !== null) {
        this.autoStartTimer -= dt;
        if (this.autoStartTimer <= 0) this.startMatch();
        else if (Math.floor(this.autoStartTimer + dt) !== Math.floor(this.autoStartTimer)) this.broadcastLobby();
      }
      return;
    }

    if (this.phase === 'countdown') {
      this.countdownTimer -= dt;
      if (this.countdownTimer <= 0) { this.countdownTimer = 0; this.phase = 'playing'; }
      this.broadcastSnapshot();
      return;
    }

    if (this.phase === 'round_end') {
      this.roundEndTimer -= dt;
      for (const p of this.players) {
        if (p.falling) { p.vy -= 26 * dt; p.y += p.vy * dt; p.x += p.vx * dt; p.z += p.vz * dt; }
      }
      if (this.roundEndTimer <= 0) { this.roundNumber++; this.setupRound(); }
      this.broadcastSnapshot();
      return;
    }

    if (this.phase !== 'playing') { this.broadcastSnapshot(); return; }

    const arena = ARENAS[this.arenaId];
    this.roundTimer = Math.max(0, this.roundTimer - dt);
    if (arena.shrinks) {
      const progress = 1 - this.roundTimer / ROUND_DURATION;
      this.arenaRadius = Math.max(3.6, arena.baseRadius - progress * (arena.baseRadius - 3.6) * 1.15);
    } else if (this.onlyBotsAlive()) {
      this.arenaRadius = Math.max(2.6, this.arenaRadius - 0.85 * dt);
    }
    if (arena.tilts) {
      let comX = 0, comZ = 0, totalW = 0;
      for (const p of this.players) {
        if (!p.alive) continue;
        const w = CHAR_SPECS[p.charId].mass * p.sizeScale;
        comX += p.x * w; comZ += p.z * w; totalW += w;
      }
      const el = ROUND_DURATION - this.roundTimer;
      const wx = Math.sin(el * 0.55) * 0.075, wz = Math.cos(el * 0.42) * 0.075;
      const tz = totalW > 0 ? Math.max(-0.22, Math.min(0.22, -(comX / totalW) * 0.032 + wx)) : wx;
      const tx = totalW > 0 ? Math.max(-0.22, Math.min(0.22, (comZ / totalW) * 0.032 + wz)) : wz;
      this.tiltX += (tx - this.tiltX) * Math.min(1, dt * 2.5);
      this.tiltZ += (tz - this.tiltZ) * Math.min(1, dt * 2.5);
    }

    if (arena.hasBombs) {
      this.bombSpawnTimer -= dt;
      if (this.bombSpawnTimer <= 0 && this.bombs.length < 3) {
        this.spawnBomb();
        this.bombSpawnTimer = 5.2 + Math.random() * 2.2;
      }
    }

    this.itemSpawnTimer -= dt;
    if (this.itemSpawnTimer <= 0 && this.pickups.length < 2) {
      this.spawnPickup();
      this.itemSpawnTimer = 7.8 + Math.random() * 2.8;
    }

    for (const p of this.players) {
      if (p.tauntTimer > 0) { p.tauntTimer -= dt; if (p.tauntTimer <= 0) p.tauntText = null; }
      if (!p.alive) {
        if (p.falling) { p.vy -= 26 * dt; p.y += p.vy * dt; p.x += p.vx * dt; p.z += p.vz * dt; }
        continue;
      }
      const client = this.clients.get(p.slot);
      let inp;
      if (p.isBot || !client) {
        inp = this.botInput(p, dt);
      } else {
        inp = { ...client.input };
        client.input.dashPressed = false;
        client.input.bombPressed = false;
        client.input.taunt = null;
      }
      if (inp.taunt) { p.tauntText = inp.taunt; p.tauntTimer = 2.0; }
      this.stepPlayer(p, inp, dt);
    }

    this.resolveCollisions();
    this.stepBombs(dt);
    this.stepPickups(dt);

    const alive = this.players.filter((p) => p.alive);
    if (alive.length <= 1 || this.roundTimer <= 0) {
      if (alive.length >= 1) {
        alive.sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z));
        const w = alive[0];
        w.wins++;
        this.lastRoundWinner = w.slot;
        if (w.wins >= this.targetWins) { this.matchWinner = w.slot; this.phase = 'match_end'; }
        else { this.phase = 'round_end'; this.roundEndTimer = 2.8; }
      } else {
        this.lastRoundWinner = -1; this.phase = 'round_end'; this.roundEndTimer = 2.8;
      }
    }

    this.broadcastSnapshot();
  }

  onlyBotsAlive() {
    const alive = this.players.filter((p) => p.alive);
    return alive.length > 1 && alive.every((p) => p.isBot);
  }

  stepPlayer(p, input, dt) {
    const spec = CHAR_SPECS[p.charId];
    const diff = BOT_DIFFS[this.difficulty] || BOT_DIFFS.medium;
    const frenzy = p.isBot && this.onlyBotsAlive();
    const bonus = levelBonus(p.level, this.fairMode);

    if (p.invulnTimer > 0) p.invulnTimer = Math.max(0, p.invulnTimer - dt);
    if (p.dashCooldown > 0) p.dashCooldown = Math.max(0, p.dashCooldown - dt);
    if (p.knockbackTimer > 0) p.knockbackTimer = Math.max(0, p.knockbackTimer - dt);
    if (p.sizeTimer > 0) { p.sizeTimer -= dt; if (p.sizeTimer <= 0) p.sizeScale = 1.0; }

    if (p.hasLightning) {
      p.lightningTimer -= dt;
      if (p.lightningTimer <= 0) {
        p.hasLightning = false;
        for (const o of this.players) { if (o.alive && o.slot !== p.slot) { o.stunTimer = 5.0; o.dashTimer = 0; } }
      }
    }
    if (p.hasWeight) {
      p.weightTimer -= dt;
      if (p.weightTimer <= 0) { p.hasWeight = false; this.eliminate(p, 0, 0); return; }
    }
    if (p.dashTimer <= 0) {
      p.stamina = Math.min(100, p.stamina + STAMINA_REGEN * (p.isBot ? (frenzy ? 1.8 : diff.regenMult) : 1.05 * bonus.regenMult) * dt);
      if (p.stamina >= 99 && !p.teetering && p.stunTimer <= 0) {
        p.idleFullTimer = (p.idleFullTimer || 0) + dt;
        if (p.idleFullTimer >= 3.5) p.superCharged = true;
      } else {
        p.idleFullTimer = 0;
      }
    }

    if (this.tiltX !== 0 || this.tiltZ !== 0) {
      p.vx += -this.tiltZ * 26 * dt;
      p.vz += this.tiltX * 26 * dt;
    }

    if (p.stunTimer > 0) {
      p.stunTimer = Math.max(0, p.stunTimer - dt);
      const drag = Math.exp(-ICE_FRICTION * 0.7 * dt);
      p.vx *= drag; p.vz *= drag; p.x += p.vx * dt; p.z += p.vz * dt;
      this.checkBounds(p);
      return;
    }

    if (p.teetering) {
      p.teeterTimer -= dt;
      if (input.dashPressed) {
        p.teeterTaps++;
        if (p.teeterTaps >= TEETER_TAPS_REQUIRED) {
          p.teetering = false;
          const ix = -Math.cos(p.teeterEdgeAngle), iz = -Math.sin(p.teeterEdgeAngle);
          p.x = Math.cos(p.teeterEdgeAngle) * (this.arenaRadius - 1.2);
          p.z = Math.sin(p.teeterEdgeAngle) * (this.arenaRadius - 1.2);
          p.vx = ix * 6.5; p.vz = iz * 6.5; p.invulnTimer = 0.5;
          return;
        }
      }
      if (p.teeterTimer <= 0) {
        p.teetering = false;
        this.eliminate(p, Math.cos(p.teeterEdgeAngle) * 3.5, Math.sin(p.teeterEdgeAngle) * 3.5);
      }
      return;
    }

    if (input.bombPressed) {
      if (p.carryingBombId) this.throwBomb(p);
      else this.tryPickupBomb(p, 2.6);
    } else if (!p.carryingBombId) {
      this.tryPickupBomb(p, 1.25);
    }

    const mag = Math.min(1, Math.hypot(input.moveX, input.moveZ));
    const dirX = mag > 0.08 ? input.moveX / mag : 0;
    const dirZ = mag > 0.08 ? input.moveZ / mag : 0;
    if (mag > 0.12) p.angle = Math.atan2(dirX, dirZ);

    const cost = p.mounted ? spec.dashCost : 45;
    if (input.dashPressed && p.dashTimer <= 0 && p.dashCooldown <= 0 && p.stamina >= cost - 2) {
      p.stamina = Math.max(0, p.stamina - cost);
      p.idleFullTimer = 0;
      p.dashTimer = p.isBot ? spec.dashDuration : spec.dashDuration + 0.14;
      p.dashCooldown = 0.14;
      p.dashDirX = mag > 0.12 ? dirX : Math.sin(p.angle);
      p.dashDirZ = mag > 0.12 ? dirZ : Math.cos(p.angle);
      const sm = (p.mounted ? 1 : 0.6) * (p.superCharged ? 1.22 : 1);
      p.vx = p.dashDirX * spec.dashSpeed * sm;
      p.vz = p.dashDirZ * spec.dashSpeed * sm;
    }

    if (p.knockbackTimer > 0) {
      const kbDrag = Math.exp(-0.55 * dt);
      p.vx *= kbDrag; p.vz *= kbDrag;
    } else if (p.dashTimer > 0) {
      p.dashTimer -= dt;
      if (p.dashTimer <= 0) p.superCharged = false;
    } else {
      const maxSpeed = spec.moveSpeed * (p.mounted ? 1 : 0.8) * (p.hasWeight ? 0.88 : 1) * (p.isBot ? diff.speedMult : 1.04 * bonus.speedMult);
      p.vx += dirX * mag * ICE_ACCEL * dt; p.vz += dirZ * mag * ICE_ACCEL * dt;
      const drag = Math.exp(-ICE_FRICTION * dt);
      p.vx *= drag; p.vz *= drag;
      const spd = Math.hypot(p.vx, p.vz);
      if (spd > maxSpeed && spd < maxSpeed + 2.5 && mag > 0.1) { p.vx *= maxSpeed / spd; p.vz *= maxSpeed / spd; }
    }
    p.x += p.vx * dt; p.z += p.vz * dt;
    this.checkBounds(p);
  }

  checkBounds(p) {
    const dist = Math.hypot(p.x, p.z);
    if (dist <= this.arenaRadius - 0.35) return;
    const a = Math.atan2(p.z, p.x);
    const nx = Math.cos(a), nz = Math.sin(a);
    const outSpd = p.vx * nx + p.vz * nz;
    if (ARENAS[this.arenaId].hasEdgeLip && outSpd < 6.4 && dist < this.arenaRadius + 0.25) {
      p.x = nx * (this.arenaRadius - 0.35); p.z = nz * (this.arenaRadius - 0.35);
      p.vx -= nx * outSpd * 1.45; p.vz -= nz * outSpd * 1.45;
      return;
    }
    const isSelfDash = p.dashTimer > 0;
    if (!p.mounted || p.stunTimer > 0 || (!isSelfDash && outSpd >= INSTANT_KO_SPEED)) {
      this.eliminate(p, p.vx * 0.7 + nx * 3.2, p.vz * 0.7 + nz * 3.2);
      return;
    }
    p.teetering = true; p.teeterTimer = TEETER_DURATION; p.teeterTaps = 0; p.teeterEdgeAngle = a;
    p.x = nx * (this.arenaRadius - 0.08); p.z = nz * (this.arenaRadius - 0.08);
    p.vx = 0; p.vz = 0;
  }

  resolveCollisions() {
    const diff = BOT_DIFFS[this.difficulty];
    const frenzy = this.onlyBotsAlive();
    for (let i = 0; i < this.players.length; i++) {
      const a = this.players[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < this.players.length; j++) {
        const b = this.players[j];
        if (!b.alive) continue;
        const aD = a.dashTimer > 0, bD = b.dashTimer > 0;
        const humanReach = (!a.isBot && aD) || (!b.isBot && bD) ? 1.95 : 0;
        const minDist = Math.max(0.62 * (a.sizeScale + b.sizeScale), humanReach);
        const dx = b.x - a.x, dz = b.z - a.z;
        const dist = Math.hypot(dx, dz);
        if (dist >= minDist || dist < 0.0001) continue;
        const nx = dx / dist, nz = dz / dist;
        const overlap = 0.62 * (a.sizeScale + b.sizeScale) - dist;
        if (overlap > 0) {
          a.x -= nx * overlap * 0.5; a.z -= nz * overlap * 0.5;
          b.x += nx * overlap * 0.5; b.z += nz * overlap * 0.5;
        }

        const sA = CHAR_SPECS[a.charId], sB = CHAR_SPECS[b.charId];
        const bA = levelBonus(a.level, this.fairMode).pushMult;
        const bB = levelBonus(b.level, this.fairMode).pushMult;
        const mA = sA.mass * (a.sizeScale > 1.2 ? 1.6 : 1);
        const mB = sB.mass * (b.sizeScale > 1.2 ? 1.6 : 1);

        const botVuln = this.difficulty === 'easy' ? 1.65 : this.difficulty === 'medium' ? 1.3 : 1.1;
        const aWins = aD && (!bD || (!a.isBot && b.isBot));
        const bWins = bD && (!aD || (!b.isBot && a.isBot));
        if (aWins && b.invulnTimer <= 0) {
          const sm = a.superCharged ? 2.0 : 1.0;
          const f = ((a.isBot ? (frenzy ? 24.0 : diff.pushBase) : 16.5 * bA * (b.isBot ? botVuln : 1)) * sm * sA.pushForce) / mB;
          b.vx = nx * f; b.vz = nz * f;
          b.knockbackTimer = b.isBot ? (this.difficulty === 'easy' ? 0.85 : 0.65) : 0.16;
          b.invulnTimer = frenzy ? 0.2 : 0.4;
          if (!a.isBot || frenzy) b.teetering = false;
          a.vx *= 0.25; a.vz *= 0.25; a.dashTimer = 0; a.superCharged = false;
        } else if (bWins && a.invulnTimer <= 0) {
          const sm = b.superCharged ? 2.0 : 1.0;
          const f = ((b.isBot ? (frenzy ? 24.0 : diff.pushBase) : 16.5 * bB * (a.isBot ? botVuln : 1)) * sm * sB.pushForce) / mA;
          a.vx = -nx * f; a.vz = -nz * f;
          a.knockbackTimer = a.isBot ? (this.difficulty === 'easy' ? 0.85 : 0.65) : 0.16;
          a.invulnTimer = frenzy ? 0.2 : 0.4;
          if (!b.isBot || frenzy) a.teetering = false;
          b.vx *= 0.25; b.vz *= 0.25; b.dashTimer = 0; b.superCharged = false;
        } else {
          const sep = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
          if (sep < 0) {
            const imp = (-1.9 * sep) / (1 / mA + 1 / mB);
            a.vx -= (imp / mA) * nx; a.vz -= (imp / mA) * nz;
            b.vx += (imp / mB) * nx; b.vz += (imp / mB) * nz;
          }
        }

        if (a.invulnTimer <= 0 && b.invulnTimer <= 0) {
          if (a.hasLightning && !b.hasLightning) { a.hasLightning = false; b.hasLightning = true; b.lightningTimer = a.lightningTimer; a.invulnTimer = b.invulnTimer = 0.45; }
          else if (b.hasLightning && !a.hasLightning) { b.hasLightning = false; a.hasLightning = true; a.lightningTimer = b.lightningTimer; a.invulnTimer = b.invulnTimer = 0.45; }
          if (a.hasWeight && !b.hasWeight) { a.hasWeight = false; b.hasWeight = true; b.weightTimer = a.weightTimer; a.invulnTimer = b.invulnTimer = 0.45; }
          else if (b.hasWeight && !a.hasWeight) { b.hasWeight = false; a.hasWeight = true; a.weightTimer = b.weightTimer; a.invulnTimer = b.invulnTimer = 0.45; }
        }
      }
    }
  }

  spawnBomb() {
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * this.arenaRadius * 0.6;
    this.bombs.push({ id: `b_${this.nextId++}`, bombType: 'classic', x: Math.cos(a) * r, y: 0.35, z: Math.sin(a) * r, vx: 0, vy: 0, vz: 0, state: 'idle', carrierSlot: null, throwerSlot: null, fuseTimer: 12, age: 0 });
  }

  spawnPickup() {
    const kinds = ['lightning', 'weight', 'grow', 'shrink'];
    const kind = kinds[Math.floor(Math.random() * kinds.length)];
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * this.arenaRadius * 0.56;
    this.pickups.push({ id: `pk_${this.nextId++}`, kind, x: Math.cos(a) * r, z: Math.sin(a) * r, age: 0 });
  }

  tryPickupBomb(p, range) {
    for (const b of this.bombs) {
      if (b.state !== 'idle') continue;
      if (Math.hypot(b.x - p.x, b.z - p.z) <= range) {
        b.state = 'carried'; b.carrierSlot = p.slot; b.bombType = p.bombType; b.fuseTimer = 6.5; p.carryingBombId = b.id;
        return;
      }
    }
  }

  throwBomb(p) {
    const b = this.bombs.find((it) => it.id === p.carryingBombId);
    p.carryingBombId = null;
    if (!b) return;
    b.state = 'thrown'; b.carrierSlot = null; b.throwerSlot = p.slot; b.bombType = p.bombType;
    const fx = Math.sin(p.angle), fz = Math.cos(p.angle);
    b.x = p.x + fx * 0.9; b.z = p.z + fz * 0.9; b.y = 1.1;
    b.vx = fx * BOMB_THROW_SPEED + p.vx * 0.35; b.vz = fz * BOMB_THROW_SPEED + p.vz * 0.35; b.vy = 4.6; b.fuseTimer = 1.45;
  }

  stepBombs(dt) {
    const rem = [];
    for (const b of this.bombs) {
      b.age += dt;
      if (b.state === 'carried') {
        const c = this.players[b.carrierSlot];
        if (!c || !c.alive) { b.state = 'idle'; b.carrierSlot = null; b.y = 0.35; rem.push(b); continue; }
        b.x = c.x; b.z = c.z; b.y = 1.85 * c.sizeScale; b.fuseTimer -= dt;
        if (b.fuseTimer <= 0) { c.carryingBombId = null; this.explodeBomb(b); continue; }
        rem.push(b);
      } else if (b.state === 'thrown') {
        if (b.bombType === 'homing') {
          let best = null, bestD = 99;
          for (const p of this.players) {
            if (!p.alive || p.slot === b.throwerSlot) continue;
            const d = Math.hypot(p.x - b.x, p.z - b.z);
            if (d < bestD) { bestD = d; best = p; }
          }
          if (best && bestD > 0.1) { b.vx += ((best.x - b.x) / bestD) * 18 * dt; b.vz += ((best.z - b.z) / bestD) * 18 * dt; }
        }
        b.x += b.vx * dt; b.z += b.vz * dt; b.vy -= 14.5 * dt; b.y += b.vy * dt; b.fuseTimer -= dt;
        const hit = this.players.some((p) => p.alive && p.slot !== b.throwerSlot && Math.hypot(p.x - b.x, p.z - b.z) <= 0.95 * p.sizeScale);
        if (hit || b.y <= 0.35 || b.fuseTimer <= 0) { this.explodeBomb(b); continue; }
        rem.push(b);
      } else {
        b.fuseTimer -= dt;
        if (b.fuseTimer > 0) rem.push(b);
      }
    }
    this.bombs = rem;
  }

  explodeBomb(b) {
    const rad = b.bombType === 'mega' ? BOMB_RADIUS * 1.55 : BOMB_RADIUS;
    const mult = b.bombType === 'mega' ? 1.38 : 1.0;
    for (const p of this.players) {
      if (!p.alive) continue;
      const dx = p.x - b.x, dz = p.z - b.z;
      const d = Math.hypot(dx, dz);
      if (d <= rad) {
        const nx = d > 0.01 ? dx / d : 1, nz = d > 0.01 ? dz / d : 0;
        if (b.bombType === 'frost' && p.slot !== b.throwerSlot) p.stunTimer = Math.max(p.stunTimer, 2.5);
        if (p.mounted) { p.mounted = false; p.vx += nx * 8.2 * mult; p.vz += nz * 8.2 * mult; }
        else this.eliminate(p, nx * 5.5 * mult, nz * 5.5 * mult);
      }
    }
  }

  stepPickups(dt) {
    const rem = [];
    for (const pk of this.pickups) {
      pk.age += dt;
      if (pk.age > 14) continue;
      let taken = false;
      for (const p of this.players) {
        if (!p.alive) continue;
        if (Math.hypot(p.x - pk.x, p.z - pk.z) <= 1.0 * p.sizeScale) {
          taken = true;
          if (pk.kind === 'lightning') { p.hasLightning = true; p.lightningTimer = 10; }
          else if (pk.kind === 'weight') { p.hasWeight = true; p.weightTimer = 10; }
          else if (pk.kind === 'grow') { p.sizeScale = 1.55; p.sizeTimer = 10; }
          else { p.sizeScale = 0.62; p.sizeTimer = 10; }
          break;
        }
      }
      if (!taken) rem.push(pk);
    }
    this.pickups = rem;
  }

  eliminate(p, vx, vz) {
    if (!p.alive) return;
    p.alive = false; p.falling = true; p.teetering = false;
    p.hasLightning = false; p.hasWeight = false; p.carryingBombId = null;
    p.vx = vx; p.vz = vz; p.vy = 2.8;
  }

  botInput(bot, dt) {
    const diff = BOT_DIFFS[this.difficulty] || BOT_DIFFS.medium;
    const frenzy = this.onlyBotsAlive();
    const out = { moveX: 0, moveZ: 0, dashPressed: false, bombPressed: false, taunt: null };
    if (bot.teetering) {
      if (frenzy) return out;
      this.botTimers[bot.slot] -= dt;
      if (this.botTimers[bot.slot] <= 0) { out.dashPressed = true; this.botTimers[bot.slot] = diff.teeterDelay; }
      return out;
    }
    const distC = Math.hypot(bot.x, bot.z);
    if (!frenzy && distC > this.arenaRadius * 0.72) { out.moveX = -bot.x / distC; out.moveZ = -bot.z / distC; return out; }
    const opps = this.players.filter((p) => p.alive && p.slot !== bot.slot);
    if (!opps.length) return out;
    opps.sort((a, b) => Math.hypot(a.x - bot.x, a.z - bot.z) - Math.hypot(b.x - bot.x, b.z - bot.z));
    const t = opps[0];
    const d = Math.max(0.01, Math.hypot(t.x - bot.x, t.z - bot.z));
    out.moveX = (t.x - bot.x) / d; out.moveZ = (t.z - bot.z) / d;
    if (bot.carryingBombId && d < 6 && Math.random() < 0.08) out.bombPressed = true;
    else if ((frenzy || ROUND_DURATION - this.roundTimer > diff.graceSec) && d < (frenzy ? 5.8 : 2.6) && bot.stamina >= CHAR_SPECS[bot.charId].dashCost && Math.random() < (frenzy ? 0.65 : diff.dashChance)) out.dashPressed = true;
    return out;
  }

  broadcastSnapshot() {
    const payload = JSON.stringify({
      type: 'snapshot',
      snapshot: {
        phase: this.phase, arenaId: this.arenaId, biome: this.biome,
        arenaRadius: this.arenaRadius, tiltX: this.tiltX, tiltZ: this.tiltZ,
        roundNumber: this.roundNumber, targetWins: this.targetWins,
        roundTimer: this.roundTimer, countdownTimer: this.countdownTimer, roundEndTimer: this.roundEndTimer,
        lastRoundWinner: this.lastRoundWinner, matchWinner: this.matchWinner,
        players: this.players, bombs: this.bombs, pickups: this.pickups,
      },
    });
    for (const c of this.clients.values()) { if (c.ws.readyState === 1) c.ws.send(payload); }
  }
}

const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  if (url.pathname === '/leaderboard' && req.method === 'GET') {
    const country = url.searchParams.get('country');
    let entries = [...leaderboardMap.values()];
    if (country) entries = entries.filter((e) => e.country === country);
    entries.sort((a, b) => b.trophies - a.trophies || b.level - a.level);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ entries: entries.slice(0, 30) }));
    return;
  }

  if (url.pathname === '/score' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      try {
        const d = JSON.parse(body);
        const name = String(d.name || '').trim().slice(0, 12);
        if (name) {
          const prev = leaderboardMap.get(name);
          leaderboardMap.set(name, {
            name,
            country: String(d.country || 'SY').slice(0, 3).toUpperCase(),
            level: Math.max(prev?.level || 1, Math.min(50, Number(d.level) || 1)),
            trophies: Math.max(prev?.trophies || 0, Number(d.trophies) || 0),
            charId: CHAR_SPECS[d.charId] ? d.charId : 'foxy',
          });
        }
      } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', version: '2.0', game: 'Ice Bump: Push Party Online', activeRooms: rooms.size }));
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'quick') {
        const myLvl = Math.max(1, Math.min(50, Number(msg.level) || 1));
        // Match with an open global room within ±6 levels!
        let target = [...rooms.values()].find(
          (r) => r.mode === 'quick' && !r.started && r.clients.size < 4 && Math.abs(r.bracketLevel - myLvl) <= 6
        );
        if (!target) {
          const code = makeRoomCode();
          target = new Room(code, 'quick', msg.arenaId, msg.biome, msg.difficulty, msg.targetWins, myLvl);
          rooms.set(code, target);
        }
        target.addClient(ws, msg);
      } else if (msg.type === 'create') {
        const code = makeRoomCode();
        const room = new Room(code, 'private', msg.arenaId, msg.biome, msg.difficulty, msg.targetWins, msg.level);
        rooms.set(code, room);
        room.addClient(ws, msg);
      } else if (msg.type === 'join') {
        const code = String(msg.roomCode || '').toUpperCase();
        const room = rooms.get(code);
        if (!room || room.started || room.clients.size >= 4) {
          ws.send(JSON.stringify({ type: 'error', message: `Room ${code} not found or full!` }));
          return;
        }
        room.addClient(ws, msg);
      } else if (msg.type === 'start_now' && ws._room) {
        if (!ws._room.started && ws._slot === ws._room.hostSlot) ws._room.startMatch();
      } else if (msg.type === 'rematch' && ws._room) {
        if (ws._room.phase === 'match_end') ws._room.startMatch();
      } else if (msg.type === 'input' && ws._room && ws._slot !== undefined) {
        const client = ws._room.clients.get(ws._slot);
        if (client && msg.input) {
          client.input.moveX = Number(msg.input.moveX) || 0;
          client.input.moveZ = Number(msg.input.moveZ) || 0;
          if (msg.input.dashPressed) client.input.dashPressed = true;
          if (msg.input.bombPressed) client.input.bombPressed = true;
          if (msg.input.taunt) client.input.taunt = String(msg.input.taunt).slice(0, 4);
        }
      }
    } catch {}
  });

  ws.on('close', () => {
    if (ws._room && ws._slot !== undefined) ws._room.removeClient(ws._slot);
  });
});

setInterval(() => {
  for (const room of rooms.values()) room.tick(TICK_DT);
}, 1000 / TICK_HZ);

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`❄️ Ice Bump v2.0 Server listening on port ${PORT}`);
});
