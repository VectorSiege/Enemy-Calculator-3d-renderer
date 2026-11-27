import * as THREE from 'three';
import { RoomLayoutId } from '../types/ballistics';

/** 2D wall boundary segment on the XZ simulation floor plane. */
export interface WallSegment2D {
  ax: number;
  az: number;
  bx: number;
  bz: number;
}

/** Interactive destructible bulkhead door supporting ballistic, melee, grenade, and enemy breach damage. */
export interface BreakableDoor3D {
  side: 'west' | 'east' | 'north';
  group: THREE.Group;
  hitMesh: THREE.Mesh;
  panelMat: THREE.MeshStandardMaterial;
  hp: number;
  maxHp: number;
  broken: boolean;
  flashTimer: number;
  segment: WallSegment2D;
  breachOrigin: THREE.Vector3;
  breachNormal: THREE.Vector3;
}

export type RoomLightPhase = 'DIM' | 'TO_BRIGHT' | 'BRIGHT' | 'TO_OFF' | 'OFF' | 'TO_DIM';

/** Smooth-cycling overhead lighting node (no harsh flickering). */
export interface RoomDynamicLight {
  light: THREE.PointLight;
  fixtureMat: THREE.MeshStandardMaterial;
  maxIntensity: number;
  dimLevel: number;
  currentFactor: number;
  startFactor: number;
  targetFactor: number;
  phase: RoomLightPhase;
  phaseElapsed: number;
  phaseDuration: number;
}

/** Interactive destructible tactical cover (~80 HP) allowing combatants to fight & expose upper chest/head. */
export interface BreakableCover3D {
  id: string;
  x: number;
  z: number;
  halfW: number;
  halfD: number;
  height: number;
  hp: number;
  maxHp: number;
  broken: boolean;
  flashTimer: number;
  flankRisk: 'LOW' | 'HIGH';
  group: THREE.Group;
  hitMesh: THREE.Mesh;
  panelMat: THREE.MeshStandardMaterial;
}

/** Built 3D arena geometry, dynamic lights, breakable blast doors, covers, and cleanup hook. */
export interface BuiltRoomEnvironment {
  root: THREE.Group;
  roomId: RoomLayoutId;
  wallSegments: WallSegment2D[];
  environmentHitMeshes: THREE.Mesh[];
  dynamicLights: RoomDynamicLight[];
  covers: BreakableCover3D[];
  westDoor: BreakableDoor3D | null;
  eastDoor: BreakableDoor3D | null;
  northDoor: BreakableDoor3D | null;
  playerSpawn: { x: number; z: number; yaw: number };
  dispose: () => void;
}

// Closed polygon perimeter for Room 2 (Double Flank Chambers) matching top-down tactical plan
export const DOUBLE_FLANK_POLYGON: [number, number][] = [
  [-9, 0],
  [-2.5, 0],
  [-2.5, 1.5],
  [2.5, 1.5],
  [2.5, 0],
  [9, 0],
  [9, -12.5],
  [21.5, -6.5],
  [27.5, -6.5],
  [27.5, -14],
  [29, -14],
  [33, -14],
  [33, -20],
  [29, -20],
  [20.5, -20],
  [20.5, -12],
  [9, -17.5],
  [-9, -17.5],
  [-16.5, -23.5],
  [-26, -23.5],
  [-30, -23.5],
  [-30, -18.5],
  [-26, -18.5],
  [-18, -18.5],
  [-9, -12.5],
];

// Playable boundary stopping at doorways so player cannot walk into sealed spawn alcoves
const DOUBLE_FLANK_PLAYER_BOUNDS: [number, number][] = [
  [-9, 0],
  [-2.5, 0],
  [-2.5, 1.5],
  [2.5, 1.5],
  [2.5, 0],
  [9, 0],
  [9, -12.5],
  [21.5, -6.5],
  [27.5, -6.5],
  [27.5, -14],
  [29, -14],
  [29, -20],
  [20.5, -20],
  [20.5, -12],
  [9, -17.5],
  [-9, -17.5],
  [-16.5, -23.5],
  [-26, -23.5],
  [-26, -18.5],
  [-18, -18.5],
  [-9, -12.5],
];

function buildPolygonSegments(pts: [number, number][]): WallSegment2D[] {
  const segs: WallSegment2D[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    segs.push({ ax: a[0], az: a[1], bx: b[0], bz: b[1] });
  }
  return segs;
}

const DOUBLE_FLANK_WALL_SEGMENTS = buildPolygonSegments(DOUBLE_FLANK_POLYGON);
const DOUBLE_FLANK_PLAYER_SEGMENTS = buildPolygonSegments(DOUBLE_FLANK_PLAYER_BOUNDS);

/** Ray-casting 2D point-in-polygon check used for chamber collision and projectile culling. */
export function isPointInPolygon2D(x: number, z: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0];
    const zi = poly[i][1];
    const xj = poly[j][0];
    const zj = poly[j][1];
    const intersect =
      zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi || 1e-9) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function resolveCircleCovers2D(
  x: number,
  z: number,
  radius: number,
  covers?: BreakableCover3D[]
): { x: number; z: number } {
  if (!covers || covers.length === 0) return { x, z };
  let rx = x;
  let rz = z;
  const rSq = radius * radius;
  for (const cov of covers) {
    if (cov.broken) continue;
    const clampedX = THREE.MathUtils.clamp(rx, cov.x - cov.halfW, cov.x + cov.halfW);
    const clampedZ = THREE.MathUtils.clamp(rz, cov.z - cov.halfD, cov.z + cov.halfD);
    const dx = rx - clampedX;
    const dz = rz - clampedZ;
    const dSq = dx * dx + dz * dz;
    if (dSq < rSq) {
      const d = Math.sqrt(dSq);
      if (d > 1e-5) {
        const push = radius - d;
        rx += (dx / d) * push;
        rz += (dz / d) * push;
      } else {
        // Inside AABB: push out along nearest face
        const leftPen = rx - (cov.x - cov.halfW);
        const rightPen = cov.x + cov.halfW - rx;
        const backPen = rz - (cov.z - cov.halfD);
        const frontPen = cov.z + cov.halfD - rz;
        const minPen = Math.min(leftPen, rightPen, backPen, frontPen);
        if (minPen === leftPen) rx = cov.x - cov.halfW - radius;
        else if (minPen === rightPen) rx = cov.x + cov.halfW + radius;
        else if (minPen === backPen) rz = cov.z - cov.halfD - radius;
        else rz = cov.z + cov.halfD + radius;
      }
    }
  }
  return { x: rx, z: rz };
}

/**
 * Resolves 2D circle-vs-room wall, intact-cover, and intact-door collisions for player and hostiles.
 * Supports 24m x 120m corridor behind-north-door staging bay (`z: -136..-118`) and dual-flank chambers.
 */
export function resolveRoomCollision2D(
  nextX: number,
  nextZ: number,
  prevX: number,
  prevZ: number,
  radius: number,
  roomId: RoomLayoutId,
  options: {
    isPlayer: boolean;
    westDoorBroken: boolean;
    eastDoorBroken: boolean;
    northDoorBroken?: boolean;
    covers?: BreakableCover3D[];
  }
): { x: number; z: number } {
  if (roomId === 'corridor_01') {
    const northOpen = options.northDoorBroken ?? true;
    const maxZ = 1.8 - radius;

    if (options.isPlayer) {
      const minX = -12.0 + radius;
      const maxX = 12.0 - radius;
      const minZ = -117.2 + radius;
      const covPos = resolveCircleCovers2D(nextX, nextZ, radius, options.covers);
      return {
        x: THREE.MathUtils.clamp(covPos.x, minX, maxX),
        z: THREE.MathUtils.clamp(covPos.z, minZ, maxZ),
      };
    }

    // Ground/Air enemies in corridor may spawn in the rear recessed bay (-136..-118, x: -8.5..8.5)
    // and are blocked at z = -118 until northDoor breaks (or outside doorway X [-5.2..5.2])
    const inNorthBay = nextZ < -118.0;
    if (inNorthBay) {
      const clampedBayX = THREE.MathUtils.clamp(nextX, -8.4 + radius, 8.4 - radius);
      let clampedBayZ = THREE.MathUtils.clamp(nextZ, -135.5 + radius, -118.0 - radius);
      if (northOpen && Math.abs(clampedBayX) <= 5.4 - radius && nextZ > -118.0 - radius) {
        clampedBayZ = nextZ;
      }
      return { x: clampedBayX, z: clampedBayZ };
    }

    // Inside main 24m x 120m corridor
    const covPos = resolveCircleCovers2D(nextX, nextZ, radius, options.covers);
    const clampedX = THREE.MathUtils.clamp(covPos.x, -12.0 + radius, 12.0 - radius);
    const minCorridorZ =
      northOpen && Math.abs(clampedX) <= 5.4 - radius ? -119.0 : -117.4 + radius;
    return {
      x: clampedX,
      z: THREE.MathUtils.clamp(covPos.z, minCorridorZ, maxZ),
    };
  }

  let x = nextX;
  let z = nextZ;

  const segments = options.isPlayer ? DOUBLE_FLANK_PLAYER_SEGMENTS : DOUBLE_FLANK_WALL_SEGMENTS;
  const checkSegs: WallSegment2D[] = [...segments];

  if (!options.isPlayer) {
    if (!options.westDoorBroken) {
      checkSegs.push({ ax: -26, az: -23.5, bx: -26, bz: -18.5 });
    }
    if (!options.eastDoorBroken) {
      checkSegs.push({ ax: 29, az: -20, bx: 29, bz: -14 });
    }
  }

  const rSq = radius * radius;
  for (let pass = 0; pass < 2; pass++) {
    for (const seg of checkSegs) {
      const abx = seg.bx - seg.ax;
      const abz = seg.bz - seg.az;
      const abLenSq = abx * abx + abz * abz;
      if (abLenSq < 1e-6) continue;
      const t = THREE.MathUtils.clamp(
        ((x - seg.ax) * abx + (z - seg.az) * abz) / abLenSq,
        0,
        1
      );
      const cx = seg.ax + abx * t;
      const cz = seg.az + abz * t;
      const dx = x - cx;
      const dz = z - cz;
      const dSq = dx * dx + dz * dz;
      if (dSq < rSq) {
        const d = Math.sqrt(dSq);
        if (d > 1e-5) {
          const push = radius - d;
          x += (dx / d) * push;
          z += (dz / d) * push;
        } else {
          const invL = 1 / Math.sqrt(abLenSq);
          x += -abz * invL * radius;
          z += abx * invL * radius;
        }
      }
    }
  }

  // Keep actors outside central cover pylons
  for (const [px, pz] of [
    [-4.2, -9.2],
    [4.2, -9.2],
  ]) {
    const hw = 0.72;
    const hd = 0.34;
    const clampedX = THREE.MathUtils.clamp(x, px - hw, px + hw);
    const clampedZ = THREE.MathUtils.clamp(z, pz - hd, pz + hd);
    const dx = x - clampedX;
    const dz = z - clampedZ;
    const dSq = dx * dx + dz * dz;
    if (dSq < rSq) {
      const d = Math.sqrt(dSq);
      if (d > 1e-5) {
        const push = radius - d;
        x += (dx / d) * push;
        z += (dz / d) * push;
      } else {
        z += radius + hd;
      }
    }
  }

  const activePoly = options.isPlayer ? DOUBLE_FLANK_PLAYER_BOUNDS : DOUBLE_FLANK_POLYGON;
  if (!isPointInPolygon2D(x, z, activePoly)) {
    return { x: prevX, z: prevZ };
  }
  return { x, z };
}

/** Computes spawn coordinates and breach waypoints for Double Flank Chamber side doors. */
export function getDoubleFlankEntranceData(side: 'west' | 'east', idx: number): {
  spawnX: number;
  spawnZ: number;
  waypoints: { x: number; z: number }[];
  finalSlotX: number;
  finalSlotZ: number;
} {
  const jitter = ((idx % 3) - 1) * 0.85;
  if (side === 'west') {
    return {
      spawnX: -28.0 - (idx % 2) * 0.7,
      spawnZ: -21.0 + jitter * 0.65,
      waypoints: [
        { x: -24.6, z: -21.0 + jitter * 0.5 },
        { x: -16.8, z: -21.0 + jitter * 0.4 },
        { x: -8.2, z: -14.8 + jitter * 0.4 },
      ],
      finalSlotX: -3.2 + (idx % 4) * 1.1,
      finalSlotZ: -5.5 - (idx % 3) * 1.6,
    };
  }
  return {
    spawnX: 31.0 + (idx % 2) * 0.7,
    spawnZ: -17.0 + jitter * 0.75,
    waypoints: [
      { x: 27.6, z: -17.0 + jitter * 0.5 },
      { x: 23.6, z: -16.6 },
      { x: 23.6, z: -10.2 },
      { x: 19.6, z: -9.6 + jitter * 0.35 },
      { x: 8.2, z: -14.8 + jitter * 0.4 },
    ],
    finalSlotX: 3.2 - (idx % 4) * 1.1,
    finalSlotZ: -5.5 - (idx % 3) * 1.6,
  };
}

/** Returns rear sightline patrol coordinates for Vanguard Shield Drones. */
export function getDronePatrolNodes(
  roomId: RoomLayoutId,
  spawnDistM: number
): { x: number; z: number }[] {
  if (roomId === 'double_flank_02') {
    return [
      { x: -6.8, z: -14.8 },
      { x: 0, z: -15.4 },
      { x: 6.8, z: -14.8 },
      { x: -12.8, z: -17.5 },
      { x: 13.8, z: -12.6 },
      { x: -5.8, z: -11.2 },
      { x: 5.8, z: -11.2 },
    ];
  }
  const backZ = -Math.max(18, Math.min(72, spawnDistM * 0.72));
  return [
    { x: -8.5, z: backZ },
    { x: 0, z: backZ - 4.5 },
    { x: 8.5, z: backZ },
    { x: -6.5, z: backZ - 7.5 },
    { x: 6.5, z: backZ - 7.5 },
    { x: 0, z: backZ + 3.5 },
  ];
}

function createGridTexture(renderer: THREE.WebGLRenderer, repeatVal: number): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#0c1018';
    ctx.fillRect(0, 0, size, size);

    ctx.strokeStyle = 'rgba(0, 240, 255, 0.14)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0, 0, size, size);

    ctx.strokeStyle = 'rgba(140, 155, 181, 0.08)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const p = (size / 4) * i;
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, size);
      ctx.moveTo(0, p);
      ctx.lineTo(size, p);
      ctx.stroke();
    }

    ctx.fillStyle = 'rgba(255, 179, 0, 0.35)';
    ctx.fillRect(0, 0, 3, 3);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatVal, repeatVal);
  tex.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  return tex;
}

function disposeGroupMeshes(root: THREE.Object3D) {
  root.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh || (obj as THREE.InstancedMesh).isInstancedMesh) {
      const m = obj as THREE.Mesh;
      m.geometry.dispose();
      if (Array.isArray(m.material)) {
        m.material.forEach((mat) => mat.dispose());
      } else {
        m.material.dispose();
      }
    }
  });
}

function createDynamicRoomLight(
  root: THREE.Group,
  x: number,
  y: number,
  z: number,
  colorHex: number,
  maxIntensity: number,
  distance: number,
  seedOffset: number
): RoomDynamicLight {
  const light = new THREE.PointLight(colorHex, maxIntensity * 0.22, distance, 1.55);
  light.position.set(x, y - 0.15, z);
  root.add(light);

  const housingMat = new THREE.MeshStandardMaterial({
    color: 0x1e2636,
    roughness: 0.5,
    metalness: 0.75,
  });
  const housing = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.12, 0.55), housingMat);
  housing.position.set(x, y + 0.08, z);
  root.add(housing);

  const fixtureMat = new THREE.MeshStandardMaterial({
    color: colorHex,
    emissive: colorHex,
    emissiveIntensity: 0.25,
    roughness: 0.3,
  });
  const panel = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.08, 0.36), fixtureMat);
  panel.position.set(x, y, z);
  root.add(panel);

  const phases: RoomLightPhase[] = ['DIM', 'TO_BRIGHT', 'BRIGHT', 'TO_OFF', 'OFF', 'TO_DIM'];
  const startPhase = phases[seedOffset % phases.length];
  const dimLevel = 0.2;
  let startFactor = dimLevel;
  let targetFactor = dimLevel;
  if (startPhase === 'TO_BRIGHT') {
    startFactor = dimLevel;
    targetFactor = 1.0;
  } else if (startPhase === 'BRIGHT') {
    startFactor = 1.0;
    targetFactor = 1.0;
  } else if (startPhase === 'TO_OFF') {
    startFactor = 1.0;
    targetFactor = 0.0;
  } else if (startPhase === 'OFF') {
    startFactor = 0.0;
    targetFactor = 0.0;
  } else if (startPhase === 'TO_DIM') {
    startFactor = 0.0;
    targetFactor = dimLevel;
  }

  return {
    light,
    fixtureMat,
    maxIntensity,
    dimLevel,
    currentFactor: startFactor,
    startFactor,
    targetFactor,
    phase: startPhase,
    phaseElapsed: (seedOffset * 0.65) % 1.4,
    phaseDuration: 2.2 + (seedOffset % 3) * 0.65,
  };
}

/**
 * Smoothly advances each room light and scales output by time-of-day:
 * - Night / Dusk (`forceLightsOn = true`): reliably brings all overhead lights ON brightly.
 * - Bright Morning / Afternoon (`lightScale < 0.35`): dims fixtures down since daylight pours through the glass roof.
 */
export function updateRoomLights(
  lights: RoomDynamicLight[],
  delta: number,
  lightScale = 1.0,
  forceLightsOn = false
): void {
  for (const item of lights) {
    if (forceLightsOn) {
      item.currentFactor = THREE.MathUtils.damp(item.currentFactor, 1.0, 2.8, delta);
      item.light.intensity = item.maxIntensity * item.currentFactor * lightScale;
      item.fixtureMat.emissiveIntensity = 0.25 + item.currentFactor * 1.45;
      continue;
    }

    if (lightScale < 0.35) {
      item.currentFactor = THREE.MathUtils.damp(item.currentFactor, 0.12, 2.4, delta);
      item.light.intensity = item.maxIntensity * item.currentFactor * lightScale;
      item.fixtureMat.emissiveIntensity = 0.04 + item.currentFactor * 0.22;
      continue;
    }

    item.phaseElapsed += delta;
    const tRaw = Math.min(1, item.phaseElapsed / Math.max(0.2, item.phaseDuration));
    const smooth = tRaw * tRaw * (3 - 2 * tRaw);
    item.currentFactor = THREE.MathUtils.lerp(item.startFactor, item.targetFactor, smooth);

    item.light.intensity = item.maxIntensity * item.currentFactor * lightScale;
    item.fixtureMat.emissiveIntensity = 0.04 + item.currentFactor * 1.35;

    if (tRaw >= 1) {
      item.phaseElapsed = 0;
      switch (item.phase) {
        case 'DIM':
          item.phase = 'TO_BRIGHT';
          item.startFactor = item.dimLevel;
          item.targetFactor = 1.0;
          item.phaseDuration = 2.0 + Math.random() * 1.8;
          break;
        case 'TO_BRIGHT':
          item.phase = 'BRIGHT';
          item.startFactor = 1.0;
          item.targetFactor = 1.0;
          item.phaseDuration = 2.2 + Math.random() * 2.6;
          break;
        case 'BRIGHT':
          if (Math.random() < 0.72) {
            item.phase = 'TO_OFF';
            item.startFactor = 1.0;
            item.targetFactor = 0.0;
            item.phaseDuration = 1.5 + Math.random() * 1.2;
          } else {
            item.phase = 'TO_DIM';
            item.startFactor = 1.0;
            item.targetFactor = item.dimLevel;
            item.phaseDuration = 1.8 + Math.random() * 1.4;
          }
          break;
        case 'TO_OFF':
          item.phase = 'OFF';
          item.startFactor = 0.0;
          item.targetFactor = 0.0;
          item.phaseDuration = 1.6 + Math.random() * 2.2;
          break;
        case 'OFF':
          item.phase = 'TO_DIM';
          item.startFactor = 0.0;
          item.targetFactor = item.dimLevel;
          item.phaseDuration = 1.6 + Math.random() * 1.4;
          break;
        case 'TO_DIM':
          item.phase = 'DIM';
          item.startFactor = item.dimLevel;
          item.targetFactor = item.dimLevel;
          item.phaseDuration = 1.6 + Math.random() * 2.0;
          break;
      }
    }
  }
}

/**
 * Builds the selected 3D arena geometry, dynamic lights, and destructible bulkhead blast doors.
 */
export function buildRoomEnvironment(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
  roomId: RoomLayoutId,
  isSoftwareGl: boolean
): BuiltRoomEnvironment {
  const root = new THREE.Group();
  const environmentHitMeshes: THREE.Mesh[] = [];
  const dynamicLights: RoomDynamicLight[] = [];
  const covers: BreakableCover3D[] = [];

  if (roomId === 'corridor_01') {
    // 24m wide (x: -12..12) x 120m long (z: -118..+2) enclosed hall + recessed north spawn bay
    const floorTex = createGridTexture(renderer, 32);
    floorTex.repeat.set(6, 36);
    const floorGeo = new THREE.PlaneGeometry(26, 142);
    const floorMat = new THREE.MeshStandardMaterial({
      map: floorTex,
      roughness: 0.78,
      metalness: 0.25,
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0, -66);
    floor.receiveShadow = !isSoftwareGl;
    root.add(floor);

    const sideWallMat = new THREE.MeshStandardMaterial({
      color: 0x18202e,
      roughness: 0.6,
      metalness: 0.5,
    });
    const ribMat = new THREE.MeshStandardMaterial({
      color: 0x253042,
      roughness: 0.45,
      metalness: 0.72,
    });
    const trimMat = new THREE.MeshStandardMaterial({
      color: 0x00f0ff,
      emissive: 0x00f0ff,
      emissiveIntensity: 0.35,
      roughness: 0.3,
    });

    const wallHeight = 5.2;
    const wallLen = 121;
    for (const side of [-1, 1]) {
      const sideWall = new THREE.Mesh(
        new THREE.BoxGeometry(0.6, wallHeight, wallLen),
        sideWallMat
      );
      sideWall.position.set(side * 12.3, wallHeight * 0.5, -58);
      sideWall.receiveShadow = !isSoftwareGl;
      sideWall.userData.isWall = true;
      environmentHitMeshes.push(sideWall);
      root.add(sideWall);

      const trimStrip = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, wallLen), trimMat);
      trimStrip.position.set(side * 11.96, 3.85, -58);
      root.add(trimStrip);
    }

    const buttressGeo = new THREE.BoxGeometry(0.28, wallHeight, 0.8);
    const buttresses = new THREE.InstancedMesh(buttressGeo, ribMat, 18);
    const dummy = new THREE.Object3D();
    let bIdx = 0;
    for (let i = 0; i < 9; i++) {
      const bz = -6 - i * 13;
      for (const side of [-1, 1]) {
        dummy.position.set(side * 11.92, wallHeight * 0.5, bz);
        dummy.updateMatrix();
        buttresses.setMatrixAt(bIdx++, dummy.matrix);
      }
    }
    buttresses.computeBoundingSphere();
    root.add(buttresses);

    // South End Sealed Blue Door behind player
    const southEndWall = new THREE.Mesh(new THREE.BoxGeometry(25.2, wallHeight, 0.6), sideWallMat);
    southEndWall.position.set(0, wallHeight * 0.5, 2.55);
    southEndWall.userData.isWall = true;
    environmentHitMeshes.push(southEndWall);
    root.add(southEndWall);

    const bluePanelMat = new THREE.MeshStandardMaterial({
      color: 0x2338d8,
      roughness: 0.4,
      metalness: 0.72,
      emissive: 0x1e38ff,
      emissiveIntensity: 0.45,
    });
    const southDoor = new THREE.Mesh(new THREE.BoxGeometry(5.6, 4.0, 0.36), bluePanelMat);
    southDoor.position.set(0, 2.0, 2.2);
    southDoor.userData.isWall = true;
    environmentHitMeshes.push(southDoor);
    root.add(southDoor);

    const southHeader = new THREE.Mesh(new THREE.BoxGeometry(6.4, 0.85, 0.56), ribMat);
    southHeader.position.set(0, 4.35, 2.2);
    root.add(southHeader);

    // North End Wall Wings (leaving an 11m central doorway at z = -118 for breakable door)
    for (const side of [-1, 1]) {
      const wing = new THREE.Mesh(new THREE.BoxGeometry(6.8, wallHeight, 0.6), sideWallMat);
      wing.position.set(side * 8.9, wallHeight * 0.5, -118);
      wing.userData.isWall = true;
      environmentHitMeshes.push(wing);
      root.add(wing);
    }

    // Recessed North Spawn Chamber behind z = -118 (-118 to -136.5, x: -8.8..8.8) sized up to 120 units
    for (const side of [-1, 1]) {
      const bayWall = new THREE.Mesh(new THREE.BoxGeometry(0.5, wallHeight, 19), sideWallMat);
      bayWall.position.set(side * 8.8, wallHeight * 0.5, -127);
      root.add(bayWall);
    }
    const bayBackWall = new THREE.Mesh(new THREE.BoxGeometry(18.2, wallHeight, 0.6), sideWallMat);
    bayBackWall.position.set(0, wallHeight * 0.5, -136.5);
    root.add(bayBackWall);

    const northFrameHeader = new THREE.Mesh(new THREE.BoxGeometry(12.2, 1.25, 0.6), ribMat);
    northFrameHeader.position.set(0, 4.58, -118);
    root.add(northFrameHeader);

    // Destructible North Blast Door at z = -118 (enemies spawn behind & break through)
    const northDoorGroup = new THREE.Group();
    northDoorGroup.position.set(0, 0, -118);
    const northPanelMat = new THREE.MeshStandardMaterial({
      color: 0x566070,
      roughness: 0.45,
      metalness: 0.78,
    });
    const northHitMesh = new THREE.Mesh(new THREE.BoxGeometry(11.0, 4.0, 0.42), northPanelMat);
    northHitMesh.position.y = 2.0;
    northHitMesh.castShadow = !isSoftwareGl;
    northHitMesh.receiveShadow = !isSoftwareGl;
    northHitMesh.userData.doorSide = 'north';
    environmentHitMeshes.push(northHitMesh);
    northDoorGroup.add(northHitMesh);

    for (const h of [0.9, 2.0, 3.1]) {
      const rib = new THREE.Mesh(new THREE.BoxGeometry(10.8, 0.18, 0.48), ribMat);
      rib.position.y = h;
      northDoorGroup.add(rib);
    }
    const northSeamMat = new THREE.MeshStandardMaterial({
      color: 0xffb300,
      emissive: 0xffb300,
      emissiveIntensity: 0.85,
    });
    const northSeam = new THREE.Mesh(new THREE.BoxGeometry(0.14, 3.8, 0.5), northSeamMat);
    northSeam.position.y = 2.0;
    northDoorGroup.add(northSeam);
    root.add(northDoorGroup);

    const northDoor: BreakableDoor3D = {
      side: 'north',
      group: northDoorGroup,
      hitMesh: northHitMesh,
      panelMat: northPanelMat,
      hp: 110,
      maxHp: 110,
      broken: false,
      flashTimer: 0,
      segment: { ax: -5.5, az: -118, bx: 5.5, bz: -118 },
      breachOrigin: new THREE.Vector3(0, 2.0, -118),
      breachNormal: new THREE.Vector3(0, 0.25, 1),
    };

    // Breakable Tactical Corridor Barricades (~80 HP) allowing waist-up cover peeking for player & enemies
    const corridorCoverSpecs: {
      id: string;
      x: number;
      z: number;
      w: number;
      h: number;
      d: number;
      flankRisk: 'LOW' | 'HIGH';
    }[] = [
      { id: 'cov_s_l1', x: -5.4, z: -9.5, w: 3.0, h: 1.16, d: 0.56, flankRisk: 'HIGH' },
      { id: 'cov_s_r1', x: 5.4, z: -9.5, w: 3.0, h: 1.16, d: 0.56, flankRisk: 'HIGH' },
      { id: 'cov_w_1', x: -9.6, z: -18.5, w: 3.6, h: 1.22, d: 0.6, flankRisk: 'LOW' },
      { id: 'cov_e_1', x: 9.6, z: -18.5, w: 3.6, h: 1.22, d: 0.6, flankRisk: 'LOW' },
      { id: 'cov_c_2', x: 0.0, z: -26.0, w: 3.2, h: 1.18, d: 0.58, flankRisk: 'HIGH' },
      { id: 'cov_w_2', x: -9.4, z: -34.0, w: 3.6, h: 1.22, d: 0.6, flankRisk: 'LOW' },
      { id: 'cov_e_2', x: 9.4, z: -34.0, w: 3.6, h: 1.22, d: 0.6, flankRisk: 'LOW' },
      { id: 'cov_m_l3', x: -4.4, z: -44.0, w: 2.9, h: 1.18, d: 0.56, flankRisk: 'HIGH' },
      { id: 'cov_m_r3', x: 4.4, z: -44.0, w: 2.9, h: 1.18, d: 0.56, flankRisk: 'HIGH' },
      { id: 'cov_w_3', x: -9.5, z: -56.0, w: 3.6, h: 1.22, d: 0.6, flankRisk: 'LOW' },
      { id: 'cov_e_3', x: 9.5, z: -56.0, w: 3.6, h: 1.22, d: 0.6, flankRisk: 'LOW' },
      { id: 'cov_c_4', x: 0.0, z: -68.0, w: 3.4, h: 1.18, d: 0.58, flankRisk: 'HIGH' },
      { id: 'cov_w_4', x: -9.4, z: -80.0, w: 3.6, h: 1.22, d: 0.6, flankRisk: 'LOW' },
      { id: 'cov_e_4', x: 9.4, z: -80.0, w: 3.6, h: 1.22, d: 0.6, flankRisk: 'LOW' },
      { id: 'cov_m_l5', x: -4.2, z: -94.0, w: 3.0, h: 1.18, d: 0.56, flankRisk: 'HIGH' },
      { id: 'cov_m_r5', x: 4.2, z: -94.0, w: 3.0, h: 1.18, d: 0.56, flankRisk: 'HIGH' },
    ];

    for (const spec of corridorCoverSpecs) {
      const covGroup = new THREE.Group();
      covGroup.position.set(spec.x, 0, spec.z);

      const panelMat = new THREE.MeshStandardMaterial({
        color: spec.flankRisk === 'LOW' ? 0x2d3748 : 0x354052,
        roughness: 0.58,
        metalness: 0.62,
      });
      const hitMesh = new THREE.Mesh(
        new THREE.BoxGeometry(spec.w, spec.h, spec.d),
        panelMat
      );
      hitMesh.position.y = spec.h * 0.5;
      hitMesh.castShadow = false;
      hitMesh.receiveShadow = !isSoftwareGl;
      hitMesh.userData.isCover = true;
      hitMesh.userData.coverId = spec.id;
      environmentHitMeshes.push(hitMesh);
      covGroup.add(hitMesh);

      const topLip = new THREE.Mesh(
        new THREE.BoxGeometry(spec.w + 0.08, 0.07, spec.d + 0.08),
        ribMat
      );
      topLip.position.y = spec.h + 0.01;
      covGroup.add(topLip);

      const stripe = new THREE.Mesh(
        new THREE.BoxGeometry(spec.w * 0.85, 0.055, spec.d + 0.04),
        trimMat
      );
      stripe.position.y = spec.h * 0.72;
      covGroup.add(stripe);

      root.add(covGroup);
      covers.push({
        id: spec.id,
        x: spec.x,
        z: spec.z,
        halfW: spec.w * 0.5,
        halfD: spec.d * 0.5,
        height: spec.h,
        hp: 80,
        maxHp: 80,
        broken: false,
        flashTimer: 0,
        flankRisk: spec.flankRisk,
        group: covGroup,
        hitMesh,
        panelMat,
      });
    }

    // Structural Glass Skylight Roof revealing the live dynamic skybox overhead
    const roofGlassMat = new THREE.MeshPhysicalMaterial({
      color: 0xaadbf2,
      roughness: 0.08,
      metalness: 0.16,
      transparent: true,
      opacity: 0.17,
      depthWrite: false,
      side: THREE.DoubleSide,
      clearcoat: isSoftwareGl ? 0 : 1.0,
      clearcoatRoughness: 0.08,
    });

    // Main 24m x 121m glass skylight canopy (y = 5.24) + rear staging bay glass cap
    const mainSkylight = new THREE.Mesh(new THREE.PlaneGeometry(24.0, wallLen), roofGlassMat);
    mainSkylight.rotation.x = Math.PI / 2;
    mainSkylight.position.set(0, 5.26, -58);
    mainSkylight.renderOrder = 2;
    root.add(mainSkylight);

    const baySkylight = new THREE.Mesh(new THREE.PlaneGeometry(17.6, 18.6), roofGlassMat);
    baySkylight.rotation.x = Math.PI / 2;
    baySkylight.position.set(0, 5.26, -127.3);
    baySkylight.renderOrder = 2;
    root.add(baySkylight);

    // Central steel lighting spine + twin skylight mullions running length of corridor
    const spineBeam = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.24, 139.0), ribMat);
    spineBeam.position.set(0, 5.28, -67.0);
    root.add(spineBeam);

    for (const mx of [-6.0, 6.0]) {
      const mullion = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.18, wallLen), ribMat);
      mullion.position.set(mx, 5.28, -58.0);
      root.add(mullion);
    }

    for (const side of [-1, 1]) {
      const eaveRail = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.28, wallLen + 0.6), ribMat);
      eaveRail.position.set(side * 12.1, 5.3, -58.0);
      root.add(eaveRail);
    }

    // Lateral roof cross-trusses aligned to wall buttresses (InstancedMesh for crisp low draw cost)
    const crossTrussGeo = new THREE.BoxGeometry(24.5, 0.26, 0.36);
    const crossTrusses = new THREE.InstancedMesh(crossTrussGeo, ribMat, 10);
    for (let i = 0; i < 10; i++) {
      const tz = i < 9 ? -6 - i * 13 : -118;
      dummy.position.set(0, 5.29, tz);
      dummy.updateMatrix();
      crossTrusses.setMatrixAt(i, dummy.matrix);
    }
    crossTrusses.computeBoundingSphere();
    root.add(crossTrusses);

    // Overhead dynamic lights mounted along the central glass skylight spine (5 optimized lights)
    const corridorLightZs = [-12, -38, -64, -90, -118];
    corridorLightZs.forEach((lz, i) => {
      dynamicLights.push(
        createDynamicRoomLight(
          root,
          0,
          4.95,
          lz,
          i % 2 === 0 ? 0xdbeafe : 0xffe4b5,
          34,
          54,
          i
        )
      );
    });

    scene.add(root);

    return {
      root,
      roomId,
      wallSegments: [
        { ax: -12, az: 2.2, bx: -12, bz: -118 },
        { ax: 12, az: 2.2, bx: 12, bz: -118 },
      ],
      environmentHitMeshes,
      dynamicLights,
      covers,
      westDoor: null,
      eastDoor: null,
      northDoor,
      playerSpawn: { x: 0, z: 0, yaw: 0 },
      dispose: () => {
        scene.remove(root);
        floorTex.dispose();
        disposeGroupMeshes(root);
      },
    };
  }

  // === Room 2: Double Flank Chambers ===
  const floorTex = createGridTexture(renderer, 0.34);
  const floorShape = new THREE.Shape();
  DOUBLE_FLANK_POLYGON.forEach(([px, pz], i) => {
    if (i === 0) floorShape.moveTo(px, -pz);
    else floorShape.lineTo(px, -pz);
  });
  floorShape.closePath();

  const floorGeo = new THREE.ShapeGeometry(floorShape);
  floorGeo.rotateX(-Math.PI / 2);
  const floorMat = new THREE.MeshStandardMaterial({
    map: floorTex,
    roughness: 0.78,
    metalness: 0.24,
  });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.receiveShadow = !isSoftwareGl;
  root.add(floor);

  const outerPadMat = new THREE.MeshStandardMaterial({
    color: 0x07090e,
    roughness: 0.9,
    metalness: 0.1,
  });
  const outerPad = new THREE.Mesh(new THREE.PlaneGeometry(120, 90), outerPadMat);
  outerPad.rotation.x = -Math.PI / 2;
  outerPad.position.set(2, -0.03, -12);
  root.add(outerPad);

  const wallMat = new THREE.MeshStandardMaterial({
    color: 0x1a2230,
    roughness: 0.58,
    metalness: 0.52,
  });
  const trimMat = new THREE.MeshStandardMaterial({
    color: 0x00f0ff,
    roughness: 0.3,
    metalness: 0.4,
    emissive: 0x00f0ff,
    emissiveIntensity: 0.35,
  });
  const pillarMat = new THREE.MeshStandardMaterial({
    color: 0x263144,
    roughness: 0.42,
    metalness: 0.72,
  });

  const wallHeight = 4.2;
  const wallThick = 0.45;

  for (let i = 0; i < DOUBLE_FLANK_POLYGON.length; i++) {
    const [ax, az] = DOUBLE_FLANK_POLYGON[i];
    const [bx, bz] = DOUBLE_FLANK_POLYGON[(i + 1) % DOUBLE_FLANK_POLYGON.length];

    const isBlueBackWall =
      Math.abs(az - 1.5) < 0.05 &&
      Math.abs(bz - 1.5) < 0.05 &&
      Math.min(ax, bx) <= -2.4 &&
      Math.max(ax, bx) >= 2.4;

    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 0.1) continue;

    const cx = (ax + bx) * 0.5;
    const cz = (az + bz) * 0.5;
    const angle = Math.atan2(-dz, dx);

    if (isBlueBackWall) {
      const blueDoorGroup = new THREE.Group();
      blueDoorGroup.position.set(cx, 0, cz);

      const frameMat = new THREE.MeshStandardMaterial({
        color: 0x1e2736,
        roughness: 0.4,
        metalness: 0.8,
      });
      const bluePanelMat = new THREE.MeshStandardMaterial({
        color: 0x2338d8,
        roughness: 0.35,
        metalness: 0.65,
        emissive: 0x1e38ff,
        emissiveIntensity: 0.45,
      });
      const blueGlowMat = new THREE.MeshStandardMaterial({
        color: 0x4b7bff,
        emissive: 0x3b6dff,
        emissiveIntensity: 1.2,
      });

      const doorPanel = new THREE.Mesh(new THREE.BoxGeometry(len - 0.3, 3.6, 0.32), bluePanelMat);
      doorPanel.position.y = 1.8;
      doorPanel.castShadow = true;
      doorPanel.receiveShadow = true;
      environmentHitMeshes.push(doorPanel);
      blueDoorGroup.add(doorPanel);

      const header = new THREE.Mesh(new THREE.BoxGeometry(len + 0.4, 0.7, 0.52), frameMat);
      header.position.y = 3.85;
      blueDoorGroup.add(header);

      const seam = new THREE.Mesh(new THREE.BoxGeometry(0.1, 3.3, 0.36), blueGlowMat);
      seam.position.y = 1.7;
      blueDoorGroup.add(seam);

      const lockBar = new THREE.Mesh(new THREE.BoxGeometry(len * 0.75, 0.14, 0.38), blueGlowMat);
      lockBar.position.y = 1.65;
      blueDoorGroup.add(lockBar);

      root.add(blueDoorGroup);
      continue;
    }

    const wallMesh = new THREE.Mesh(
      new THREE.BoxGeometry(len + wallThick * 0.5, wallHeight, wallThick),
      wallMat
    );
    wallMesh.position.set(cx, wallHeight * 0.5, cz);
    wallMesh.rotation.y = angle;
    wallMesh.castShadow = !isSoftwareGl;
    wallMesh.receiveShadow = !isSoftwareGl;
    wallMesh.userData.isWall = true;
    environmentHitMeshes.push(wallMesh);
    root.add(wallMesh);

    const upperTrim = new THREE.Mesh(
      new THREE.BoxGeometry(len, 0.08, wallThick + 0.06),
      trimMat
    );
    upperTrim.position.set(cx, 3.55, cz);
    upperTrim.rotation.y = angle;
    root.add(upperTrim);

    const col = new THREE.Mesh(new THREE.BoxGeometry(0.55, wallHeight + 0.1, 0.55), pillarMat);
    col.position.set(ax, wallHeight * 0.5, az);
    root.add(col);
  }

  for (const [px, pz] of [
    [-4.2, -9.2],
    [4.2, -9.2],
  ]) {
    const coverBase = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.25, 0.65), pillarMat);
    coverBase.position.set(px, 0.625, pz);
    coverBase.castShadow = !isSoftwareGl;
    coverBase.receiveShadow = !isSoftwareGl;
    coverBase.userData.isWall = true;
    environmentHitMeshes.push(coverBase);
    root.add(coverBase);

    const cap = new THREE.Mesh(new THREE.BoxGeometry(1.46, 0.08, 0.7), trimMat);
    cap.position.set(px, 1.28, pz);
    root.add(cap);
  }

  const createBreakableDoor = (
    side: 'west' | 'east',
    x: number,
    zStart: number,
    zEnd: number
  ): BreakableDoor3D => {
    const width = Math.abs(zEnd - zStart);
    const cz = (zStart + zEnd) * 0.5;
    const doorGroup = new THREE.Group();
    doorGroup.position.set(x, 0, cz);

    const panelMat = new THREE.MeshStandardMaterial({
      color: 0x566070,
      roughness: 0.45,
      metalness: 0.78,
    });
    const ribMat = new THREE.MeshStandardMaterial({
      color: 0x353d4a,
      roughness: 0.52,
      metalness: 0.82,
    });

    const hitMesh = new THREE.Mesh(new THREE.BoxGeometry(0.32, 3.5, width - 0.1), panelMat);
    hitMesh.position.y = 1.75;
    hitMesh.castShadow = !isSoftwareGl;
    hitMesh.receiveShadow = !isSoftwareGl;
    hitMesh.userData.doorSide = side;
    environmentHitMeshes.push(hitMesh);
    doorGroup.add(hitMesh);

    for (const h of [0.8, 1.75, 2.7]) {
      const rib = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.16, width - 0.05), ribMat);
      rib.position.y = h;
      doorGroup.add(rib);
    }
    const centerSeam = new THREE.Mesh(new THREE.BoxGeometry(0.42, 3.5, 0.14), ribMat);
    centerSeam.position.y = 1.75;
    doorGroup.add(centerSeam);

    const frameHeader = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.72, width + 0.3), ribMat);
    frameHeader.position.set(x, 3.86, cz);
    root.add(frameHeader);

    root.add(doorGroup);

    const inwardX = side === 'west' ? 1 : -1;
    return {
      side,
      group: doorGroup,
      hitMesh,
      panelMat,
      hp: 100,
      maxHp: 100,
      broken: false,
      flashTimer: 0,
      segment: { ax: x, az: zStart, bx: x, bz: zEnd },
      breachOrigin: new THREE.Vector3(x, 1.7, cz),
      breachNormal: new THREE.Vector3(inwardX, 0.25, 0),
    };
  };

  const westDoor = createBreakableDoor('west', -26, -23.5, -18.5);
  const eastDoor = createBreakableDoor('east', 29, -20, -14);

  const doubleFlankLightCoords: [number, number][] = [
    [0, -4.5],
    [0, -13.2],
    [-13.5, -18.2],
    [-22.5, -21.0],
    [15.0, -12.4],
    [24.2, -12.2],
  ];
  doubleFlankLightCoords.forEach(([lx, lz], i) => {
    dynamicLights.push(
      createDynamicRoomLight(
        root,
        lx,
        4.05,
        lz,
        i % 2 === 0 ? 0xdbeafe : 0xffe4b5,
        22,
        26,
        i + 2
      )
    );
  });

  scene.add(root);

  return {
    root,
    roomId,
    wallSegments: DOUBLE_FLANK_WALL_SEGMENTS,
    environmentHitMeshes,
    dynamicLights,
    covers,
    westDoor,
    eastDoor,
    northDoor: null,
    playerSpawn: { x: 0, z: -1.4, yaw: 0 },
    dispose: () => {
      scene.remove(root);
      floorTex.dispose();
      disposeGroupMeshes(root);
    },
  };
}
