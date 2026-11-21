import * as THREE from 'three';
import { RoomLayoutId } from '../types/ballistics';

export interface WallSegment2D {
  ax: number;
  az: number;
  bx: number;
  bz: number;
}

export interface BreakableDoor3D {
  side: 'west' | 'east';
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

export interface BuiltRoomEnvironment {
  root: THREE.Group;
  roomId: RoomLayoutId;
  wallSegments: WallSegment2D[];
  environmentHitMeshes: THREE.Mesh[];
  dynamicLights: RoomDynamicLight[];
  westDoor: BreakableDoor3D | null;
  eastDoor: BreakableDoor3D | null;
  playerSpawn: { x: number; z: number; yaw: number };
  dispose: () => void;
}

// Closed polygon perimeter for Room 2 (Double Flank Chambers) matching the top-down schematic
// (+X right, -Z north, +Z south/blue player door)
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

// Playable boundary (stops at doorways so player cannot walk into hidden spawn bays)
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

export function isPointInPolygon2D(
  x: number,
  z: number,
  poly: [number, number][]
): boolean {
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
  }
): { x: number; z: number } {
  if (roomId === 'corridor_01') {
    const minX = -8.0 + radius;
    const maxX = 8.0 - radius;
    const minZ = options.isPlayer ? -136 : -144;
    const maxZ = 2.4 - radius;
    return {
      x: THREE.MathUtils.clamp(nextX, minX, maxX),
      z: THREE.MathUtils.clamp(nextZ, minZ, maxZ),
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

  // Push circle smoothly out of any overlapping wall/door segment (2 iterations for corners)
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
          // Exactly on line: push along segment normal
          const invL = 1 / Math.sqrt(abLenSq);
          x += -abz * invL * radius;
          z += abx * invL * radius;
        }
      }
    }
  }

  // Keep player/actors from clipping into the 2 low central cover pylons
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

export function getDronePatrolNodes(roomId: RoomLayoutId, spawnDistM: number): { x: number; z: number }[] {
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
  const backZ = -Math.max(18, Math.min(34, spawnDistM * 0.65));
  return [
    { x: -6.0, z: backZ },
    { x: 0, z: backZ - 3.5 },
    { x: 6.0, z: backZ },
    { x: -4.8, z: backZ - 5.5 },
    { x: 4.8, z: backZ - 5.5 },
    { x: 0, z: backZ + 2.5 },
  ];
}

function createGridTexture(renderer: THREE.WebGLRenderer, repeatVal: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#0c1018';
    ctx.fillRect(0, 0, 512, 512);

    ctx.strokeStyle = 'rgba(0, 240, 255, 0.14)';
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, 512, 512);

    ctx.strokeStyle = 'rgba(140, 155, 181, 0.08)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const p = (512 / 4) * i;
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, 512);
      ctx.moveTo(0, p);
      ctx.lineTo(512, p);
      ctx.stroke();
    }

    ctx.fillStyle = 'rgba(255, 179, 0, 0.35)';
    ctx.fillRect(0, 0, 6, 6);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatVal, repeatVal);
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
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
 * Smoothly advances each room light through dim -> bright -> off -> dim cycles
 * using cubic smoothstep transitions. Strictly zero flickering.
 */
export function updateRoomLights(lights: RoomDynamicLight[], delta: number): void {
  for (const item of lights) {
    item.phaseElapsed += delta;
    const tRaw = Math.min(1, item.phaseElapsed / Math.max(0.2, item.phaseDuration));
    const smooth = tRaw * tRaw * (3 - 2 * tRaw);
    item.currentFactor = THREE.MathUtils.lerp(item.startFactor, item.targetFactor, smooth);

    item.light.intensity = item.maxIntensity * item.currentFactor;
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
          // Randomly either smoothly shut off or slowly dim back down
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

export function buildRoomEnvironment(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
  roomId: RoomLayoutId,
  isSoftwareGl: boolean
): BuiltRoomEnvironment {
  const root = new THREE.Group();
  const environmentHitMeshes: THREE.Mesh[] = [];
  const dynamicLights: RoomDynamicLight[] = [];

  if (roomId === 'corridor_01') {
    const floorTex = createGridTexture(renderer, 36);
    const floorGeo = new THREE.PlaneGeometry(180, 180);
    const floorMat = new THREE.MeshStandardMaterial({
      map: floorTex,
      roughness: 0.78,
      metalness: 0.25,
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = !isSoftwareGl;
    root.add(floor);

    const pylonGeo = new THREE.BoxGeometry(0.42, 2.8, 0.65);
    const pylonMat = new THREE.MeshStandardMaterial({
      color: 0x1a2230,
      roughness: 0.5,
      metalness: 0.7,
    });
    const beaconGeo = new THREE.BoxGeometry(0.46, 0.18, 0.2);
    const beaconMat = new THREE.MeshStandardMaterial({
      color: 0xffb300,
      emissive: 0xffb300,
      emissiveIntensity: 0.9,
    });

    const pylons = new THREE.InstancedMesh(pylonGeo, pylonMat, 24);
    const beacons = new THREE.InstancedMesh(beaconGeo, beaconMat, 24);
    const dummy = new THREE.Object3D();

    let idx = 0;
    for (let i = 0; i < 12; i++) {
      const z = -6 - i * 10;
      for (const side of [-1, 1]) {
        dummy.position.set(side * 8.5, 1.4, z);
        dummy.updateMatrix();
        pylons.setMatrixAt(idx, dummy.matrix);

        dummy.position.set(side * 8.5, 2.55, z + 0.25);
        dummy.updateMatrix();
        beacons.setMatrixAt(idx, dummy.matrix);
        idx++;
      }
    }
    pylons.computeBoundingSphere();
    beacons.computeBoundingSphere();
    root.add(pylons, beacons);

    // Overhead dynamic corridor lights (smooth dim/bright/off/dim cycles, zero flicker)
    const corridorLightZs = [-4, -18, -32, -48, -66, -86];
    corridorLightZs.forEach((lz, i) => {
      dynamicLights.push(
        createDynamicRoomLight(
          root,
          0,
          4.45,
          lz,
          i % 2 === 0 ? 0xdbeafe : 0xffe4b5,
          24,
          28,
          i
        )
      );
    });

    scene.add(root);

    return {
      root,
      roomId,
      wallSegments: [],
      environmentHitMeshes,
      dynamicLights,
      westDoor: null,
      eastDoor: null,
      playerSpawn: { x: 0, z: 0, yaw: 0 },
      dispose: () => {
        scene.remove(root);
        floorTex.dispose();
        disposeGroupMeshes(root);
      },
    };
  }

  // === Room 2: Double Flank Chambers (matching image_d63ab840.png) ===
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

  // Outer void surround skirt so edges feel architectural
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

  // Build walls around the perimeter, leaving the Blue Door back panel distinct
  for (let i = 0; i < DOUBLE_FLANK_POLYGON.length; i++) {
    const [ax, az] = DOUBLE_FLANK_POLYGON[i];
    const [bx, bz] = DOUBLE_FLANK_POLYGON[(i + 1) % DOUBLE_FLANK_POLYGON.length];

    // Skip placing standard wall across the Blue Door recessed front (handled separately)
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
      // Aesthetic Blue Sealed Door (cannot be opened, player spawns right in front)
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

      const doorPanel = new THREE.Mesh(
        new THREE.BoxGeometry(len - 0.3, 3.6, 0.32),
        bluePanelMat
      );
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

    // Corner support column at vertex A
    const col = new THREE.Mesh(new THREE.BoxGeometry(0.55, wallHeight + 0.1, 0.55), pillarMat);
    col.position.set(ax, wallHeight * 0.5, az);
    root.add(col);
  }

  // Tactical Central Cover Pylons (provide partial silhouette framing without blocking paths)
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

  // Helper to construct Breakable Grey Doors (no red color — industrial steel grey!)
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

    const hitMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.32, 3.5, width - 0.1),
      panelMat
    );
    hitMesh.position.y = 1.75;
    hitMesh.castShadow = !isSoftwareGl;
    hitMesh.receiveShadow = !isSoftwareGl;
    hitMesh.userData.doorSide = side;
    environmentHitMeshes.push(hitMesh);
    doorGroup.add(hitMesh);

    // Structural grey blast ribs
    for (const h of [0.8, 1.75, 2.7]) {
      const rib = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.16, width - 0.05), ribMat);
      rib.position.y = h;
      doorGroup.add(rib);
    }
    const centerSeam = new THREE.Mesh(new THREE.BoxGeometry(0.42, 3.5, 0.14), ribMat);
    centerSeam.position.y = 1.75;
    doorGroup.add(centerSeam);

    // Overhead frame header
    const frameHeader = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.72, width + 0.3), ribMat);
    frameHeader.position.y = 3.86;
    root.add(frameHeader);
    frameHeader.position.x = x;
    frameHeader.position.z = cz;

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

  // Overhead dynamic tactical lights across central chamber and both flank wings
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
    westDoor,
    eastDoor,
    playerSpawn: { x: 0, z: -1.4, yaw: 0 },
    dispose: () => {
      scene.remove(root);
      floorTex.dispose();
      disposeGroupMeshes(root);
    },
  };
}
