import React, { useEffect, useRef, useState } from 'react';
import { Flashlight, Heart, MousePointer, Pause, Play, Volume2, VolumeX } from 'lucide-react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { soundEngine } from '../audio/soundEngine';
import {
  buildSquadRoster,
  computeRangeFalloff,
  getRecoilForShot,
  getTargetById,
  getWeaponById,
  resolveMeleeHit,
  resolveShot,
} from '../engine/ballistics';
import {
  buildEnemyModel3D,
  buildWeaponViewmodel3D,
  BuiltEnemy3D,
  BuiltWeapon3D,
} from '../three/proceduralModels';
import {
  BreakableDoor3D,
  buildRoomEnvironment,
  BuiltRoomEnvironment,
  DOUBLE_FLANK_POLYGON,
  getDoubleFlankEntranceData,
  getDronePatrolNodes,
  isPointInPolygon2D,
  resolveRoomCollision2D,
  updateRoomLights,
} from '../three/roomLayouts';
import {
  EngagementMetrics,
  HitZoneId,
  MeleeComboStep,
  RoomLayoutId,
  SimulationConfig,
  TargetProfile,
  WeaponProfile,
} from '../types/ballistics';

interface FloatingHitLabel {
  id: number;
  offsetX: number;
  offsetY: number;
  text: string;
  color: string;
  isWeakspot: boolean;
  isKill: boolean;
  createdAt: number;
}

interface HitMarkerPulse {
  id: number;
  isWeakspot: boolean;
  isKill: boolean;
  createdAt: number;
}

export type FlashlightMode = 'OFF' | 'SPOT' | 'FLOOD';

export interface SquadShotSummary {
  roundsFiredDelta: number;
  source?: 'PLAYER' | 'PLAYER_MELEE' | 'PLAYER_SHOVE';
  zone: HitZoneId;
  zoneLabel: string;
  targetName: string;
  rawDamage: number;
  hpDamage: number;
  remainingHp: number;
  isCrit: boolean;
  isKill: boolean;
  isMiss: boolean;
  isStagger?: boolean;
  distanceM: number;
  enemyTtkMs?: number | null;
}

interface EnemyActor {
  uid: number;
  profile: TargetProfile;
  hp: number;
  maxHp: number;
  firstDamagedAtMs: number | null;
  staggerHp: number;
  maxStaggerHp: number;
  staggerTimer: number;
  alive: boolean;
  model: BuiltEnemy3D;
  x: number;
  z: number;
  vx: number;
  meleeSlotX: number;
  meleeDist: number;
  weaveDirection: number;
  weavePhaseBreakTimer: number;
  isChargingStraight: boolean;
  stridePhase: number;
  attackCooldown: number;
  attackCount: number;
  clawAnimType: 'NONE' | 'LEFT' | 'RIGHT' | 'DUAL_WINDUP' | 'DUAL_STRIKE';
  clawAnimPhase: number;
  dualStrikeExecuted: boolean;
  singleStrikeExecuted: boolean;
  // Room 2 & Drone patrolling state
  doorSide: 'west' | 'east' | null;
  waypoints: { x: number; z: number }[];
  waypointIdx: number;
  doorBashCooldown: number;
  dronePatrolTarget: { x: number; z: number } | null;
  dronePatrolTimer: number;
  droneFireCooldown: number;
  droneChargeTimer: number;
  // Swarm & lunge behavior
  lungeState: 'NONE' | 'WINDUP' | 'LUNGE';
  lungeTimer: number;
  lungeCooldown: number;
  lungeDirX: number;
  lungeDirZ: number;
  swarmAngle: number;
}

interface PendingSpawn {
  uid: number;
  profile: TargetProfile;
  delayRemainingSec: number;
  hp: number;
  spawnX: number;
  spawnZ: number;
  doorSide: 'west' | 'east' | null;
  waypoints: { x: number; z: number }[];
}

interface DroneProjectile {
  mesh: THREE.Mesh;
  vx: number;
  vy: number;
  vz: number;
  gravity: number;
  damage: number;
  attackerName: string;
  life: number;
}

interface DoorDebrisShard {
  mesh: THREE.Mesh;
  vx: number;
  vy: number;
  vz: number;
  rx: number;
  ry: number;
  life: number;
}

interface SimulationCanvas3DProps {
  config: SimulationConfig;
  weapons: WeaponProfile[];
  targets: TargetProfile[];
  playerHp: number;
  maxPlayerHp: number;
  outOfCombatSec: number;
  outOfCombatWindowSec: number;
  medkitCooldownSec: number;
  waveNumber: number;
  waveGroupSize: number;
  waveTriggerToken: number;
  magRemaining: number;
  isReloading: boolean;
  isSimRunning: boolean;
  isPaused: boolean;
  metrics: EngagementMetrics;
  onTriggerShot: () => boolean;
  onManualReload?: () => void;
  onUseMedkit: () => void;
  onSetPaused: (paused: boolean) => void;
  onStartNextWave: () => void;
  onOpenRooms: () => void;
  onSquadShotResolved: (summary: SquadShotSummary) => void;
  onEnemyClawAttack: (isDualSpecial: boolean, damage: number, attackerName: string) => void;
  onEnemyDroneShot: (damage: number, attackerName: string) => void;
  onSquadCleared: () => void;
  onResetRange: () => void;
  resetToken: number;
}

const _vec3A = new THREE.Vector3();
const _vec3B = new THREE.Vector3();
const _vec3C = new THREE.Vector3();
const _rayCenter = new THREE.Vector2(0, 0);
const _rayPellet = new THREE.Vector2(0, 0);

function disposeObject3D(root: THREE.Object3D) {
  root.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) {
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

type MeleeAnimStyle =
  | MeleeComboStep['animStyle']
  | 'HAMMER_SPECIAL'
  | 'HALBERD_SPEC_L_TO_R'
  | 'HALBERD_SPEC_R_TO_L'
  | 'SHOVE';

export const SimulationCanvas3D: React.FC<SimulationCanvas3DProps> = ({
  config,
  weapons,
  targets,
  playerHp,
  maxPlayerHp,
  outOfCombatSec,
  outOfCombatWindowSec,
  medkitCooldownSec,
  waveNumber,
  waveGroupSize,
  waveTriggerToken,
  magRemaining,
  isReloading,
  isSimRunning,
  isPaused,
  metrics,
  onTriggerShot,
  onManualReload,
  onUseMedkit,
  onSetPaused,
  onStartNextWave,
  onOpenRooms,
  onSquadShotResolved,
  onEnemyClawAttack,
  onEnemyDroneShot,
  onSquadCleared,
  onResetRange,
  resetToken,
}) => {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);

  const [isAds, setIsAds] = useState(false);
  const [flashlightMode, setFlashlightMode] = useState<FlashlightMode>('OFF');
  const [nextWaveCountdownSec, setNextWaveCountdownSec] = useState<number | null>(null);
  const [cursorShown, setCursorShown] = useState(false);
  const [isPointerLocked, setIsPointerLocked] = useState(false);
  const [isMouseInViewport, setIsMouseInViewport] = useState(false);
  const [liveDistanceM, setLiveDistanceM] = useState(config.distanceM);
  const [focusedHud, setFocusedHud] = useState<{
    name: string;
    code: string;
    hp: number;
    maxHp: number;
    staggerHp: number;
    maxStaggerHp: number;
    staggerRemainingSec: number;
    aliveCount: number;
    pendingCount: number;
    totalCount: number;
    stateLabel: string;
  }>(() => {
    const t = getTargetById(config.targetId, targets);
    return {
      name: t.name,
      code: t.code,
      hp: config.targetHp,
      maxHp: config.targetHp,
      staggerHp: t.staggerThreshold,
      maxStaggerHp: t.staggerThreshold,
      staggerRemainingSec: 0,
      aliveCount: config.groupSize,
      pendingCount: 0,
      totalCount: config.groupSize,
      stateLabel: 'ADVANCING',
    };
  });
  const [hoveredZone, setHoveredZone] = useState<HitZoneId | null>(null);
  const [damageFlashAlpha, setDamageFlashAlpha] = useState(0);
  const [hitMarker, setHitMarker] = useState<HitMarkerPulse | null>(null);
  const [floatingHits, setFloatingHits] = useState<FloatingHitLabel[]>([]);
  const [meleeChargeUi, setMeleeChargeUi] = useState<{
    progress: number;
    ready: boolean;
    chainReady: boolean;
    comboStep: number;
  }>({ progress: 0, ready: false, chainReady: false, comboStep: 0 });
  const [isMuted, setIsMuted] = useState<boolean>(() => soundEngine.isMuted());
  const [webglError, setWebglError] = useState<string | null>(null);

  const propsRef = useRef({
    config,
    weapons,
    targets,
    playerHp,
    magRemaining,
    isReloading,
    isSimRunning,
    isPaused,
    waveNumber,
    waveGroupSize,
    waveTriggerToken,
    onTriggerShot,
    onManualReload,
    onUseMedkit,
    onSetPaused,
    onSquadShotResolved,
    onEnemyClawAttack,
    onEnemyDroneShot,
    onSquadCleared,
    onStartNextWave,
  });
  propsRef.current = {
    config,
    weapons,
    targets,
    playerHp,
    magRemaining,
    isReloading,
    isSimRunning,
    isPaused,
    waveNumber,
    waveGroupSize,
    waveTriggerToken,
    onTriggerShot,
    onManualReload,
    onUseMedkit,
    onSetPaused,
    onSquadShotResolved,
    onEnemyClawAttack,
    onEnemyDroneShot,
    onSquadCleared,
    onStartNextWave,
  };

  const simRef = useRef({
    playerX: 0,
    playerZ: 0,
    walkBobPhase: 0,
    aimYaw: 0,
    aimPitch: -0.02,
    targetAimYaw: 0,
    targetAimPitch: -0.02,
    recoilYaw: 0,
    recoilPitch: 0,
    recoilHeat: 0,
    firingSwayBlend: 0,
    swayPhase: 0,
    weaponKickZ: 0,
    weaponKickPitch: 0,
    cameraShake: 0,
    isAds: false,
    flashlightMode: 'OFF' as FlashlightMode,
    rmbDownAt: 0,
    lmbDown: false,
    shotIndexInBurst: 0,
    lastFireTimeMs: 0,
    muzzleFlashTimer: 0,
    // Mouse & Cursor controls
    cursorShown: false,
    unlockedByCtrl: false,
    lastEscLockDropMs: 0,
    hasPrevClientMouse: false,
    prevClientX: 0,
    prevClientY: 0,
    edgePanDir: 0,
    isMouseInside: false,
    // Melee state machine
    meleeAction: 'IDLE' as 'IDLE' | 'CHARGING' | 'SWING' | 'SHOVE',
    meleeAnimStyle: 'HAMMER_TR_TO_B' as MeleeAnimStyle,
    meleeAnimPhase: 0,
    meleeAnimDuration: 0.45,
    meleeComboIdx: 0,
    meleeComboResetTimer: 0,
    meleeChargeSec: 0,
    meleeChargeReadyPlayed: false,
    meleeHitExecuted: false,
    meleeCooldownTimer: 0,
    halberdSpecialChainTimer: 0,
    meleeStrikeDamage: 40,
    meleeStrikeIsAoe: false,
    meleeStrikeArcDeg: 45,
    meleeStrikeStaggerOverride: null as number | null,
    meleeStrikeIsSpecial: false,
    meleeStrikeIsShove: false,
    meleeStrikeChargePct: 1,
    meleeStrikeLabel: '',
    meleeImpactBounce: 0,
    cameraMeleePitch: 0,
    cameraMeleeYaw: 0,
    cameraMeleeRoll: 0,
    cameraMeleeFovOffset: 0,
    // Squad, doors, waves, & projectiles
    enemies: [] as EnemyActor[],
    pendingSpawns: [] as PendingSpawn[],
    droneProjectiles: [] as DroneProjectile[],
    doorDebris: [] as DoorDebrisShard[],
    squadNeedsRebuild: true,
    roomNeedsRebuild: false,
    resetPlayerPosPending: true,
    squadClearedNotified: false,
    nextWaveTimerSec: null as number | null,
    playerHitSlowTimer: 0,
    totalSpawnedThisWave: 0,
    tracers: [] as { line: THREE.Line; life: number }[],
    hitLabelCounter: 1,
    weaponIdBuilt: '',
    roomIdBuilt: '' as RoomLayoutId | '',
  });

  const triggerMetaRef = useRef({
    resetToken,
    waveTriggerToken,
    roomId: config.roomId,
  });

  // Trigger squad/room rebuild ONLY on Respawn Squad, Next Wave, Target Preset Reset, or Room Switch.
  // Adjusting config.groupSize or waveGroupSizes will NEVER restart a live engagement.
  useEffect(() => {
    const prev = triggerMetaRef.current;
    const roomChanged = prev.roomId !== config.roomId;
    const resetTriggered = prev.resetToken !== resetToken;
    const waveTriggered = prev.waveTriggerToken !== waveTriggerToken;

    triggerMetaRef.current = {
      resetToken,
      waveTriggerToken,
      roomId: config.roomId,
    };

    const s = simRef.current;
    if (roomChanged) {
      s.roomNeedsRebuild = true;
      s.resetPlayerPosPending = true;
    } else if (resetTriggered) {
      s.resetPlayerPosPending = true;
    } else if (waveTriggered) {
      s.resetPlayerPosPending = false;
    }

    s.squadNeedsRebuild = true;
    s.squadClearedNotified = false;
    s.nextWaveTimerSec = null;
    s.playerHitSlowTimer = 0;
    s.recoilYaw = 0;
    s.recoilPitch = 0;
    s.recoilHeat = 0;
    s.firingSwayBlend = 0;
    s.shotIndexInBurst = 0;
    s.meleeAction = 'IDLE';
    s.meleeChargeSec = 0;
    s.meleeComboIdx = 0;
    s.halberdSpecialChainTimer = 0;
    setNextWaveCountdownSec(null);
    setHitMarker(null);
    setFloatingHits([]);
  }, [resetToken, waveTriggerToken, config.roomId]);

  // Exit pointer lock cleanly whenever game pauses
  useEffect(() => {
    if (isPaused) {
      simRef.current.lmbDown = false;
      if (document.pointerLockElement === mountRef.current?.querySelector('canvas')) {
        simRef.current.unlockedByCtrl = true;
        document.exitPointerLock?.();
      }
    }
  }, [isPaused]);

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const isSoftwareGl = (() => {
      const probe = document.createElement('canvas').getContext('webgl2');
      if (!probe) return true;
      const ext = probe.getExtension('WEBGL_debug_renderer_info');
      const param = ext ? ext.UNMASKED_RENDERER_WEBGL : probe.RENDERER;
      const gpu = String(probe.getParameter(param));
      probe.getExtension('WEBGL_lose_context')?.loseContext();
      return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
    })();

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: !isSoftwareGl,
        powerPreference: 'high-performance',
      });
    } catch {
      setWebglError('WebGL2 viewport unavailable in this browser context.');
      return;
    }

    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = !isSoftwareGl;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.display = 'block';
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x06090e);
    scene.fog = new THREE.FogExp2(0x06090e, 0.042);

    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    const width = Math.max(320, container.clientWidth);
    const height = Math.max(240, container.clientHeight);
    renderer.setSize(width, height, false);

    const camera = new THREE.PerspectiveCamera(62, width / height, 0.05, 220);
    camera.position.set(0, 1.65, 0);
    camera.rotation.order = 'YXZ';
    scene.add(camera);

    // Rail-mounted tactical flashlight slightly offset from center
    const flashlight = new THREE.SpotLight(0xfff4de, 0, 64, 0.22, 0.42, 1.25);
    flashlight.position.set(0.24, -0.18, -0.22);
    const flashlightTarget = new THREE.Object3D();
    flashlightTarget.position.set(0, -0.02, -24);
    camera.add(flashlight);
    camera.add(flashlightTarget);
    flashlight.target = flashlightTarget;

    const hemi = new THREE.HemisphereLight(0x6c8db8, 0x0d1118, 0.28);
    scene.add(hemi);

    const keyLight = new THREE.DirectionalLight(0xffebd0, 0.42);
    keyLight.position.set(10, 18, 12);
    keyLight.castShadow = !isSoftwareGl;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.camera.left = -36;
    keyLight.shadow.camera.right = 36;
    keyLight.shadow.camera.top = 36;
    keyLight.shadow.camera.bottom = -36;
    keyLight.shadow.bias = -0.0005;
    keyLight.shadow.normalBias = 0.02;
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x00d8f0, 0.34);
    rimLight.position.set(-12, 8, -25);
    scene.add(rimLight);

    let currentRoom: BuiltRoomEnvironment = buildRoomEnvironment(
      scene,
      renderer,
      propsRef.current.config.roomId,
      isSoftwareGl
    );
    simRef.current.roomIdBuilt = propsRef.current.config.roomId;
    simRef.current.playerX = currentRoom.playerSpawn.x;
    simRef.current.playerZ = currentRoom.playerSpawn.z;
    camera.position.set(currentRoom.playerSpawn.x, 1.65, currentRoom.playerSpawn.z);

    const weaponAnchor = new THREE.Group();
    camera.add(weaponAnchor);
    let currentWeapon3D: BuiltWeapon3D = buildWeaponViewmodel3D(propsRef.current.config.weaponId);
    weaponAnchor.add(currentWeapon3D.root);
    weaponAnchor.position.copy(currentWeapon3D.hipOffset);
    simRef.current.weaponIdBuilt = propsRef.current.config.weaponId;

    // Shared projectile & debris geometries
    const droneBoltGeo = new THREE.SphereGeometry(0.11, 10, 10);
    const debrisGeo = new THREE.BoxGeometry(0.28, 0.24, 0.16);
    const debrisMat = new THREE.MeshStandardMaterial({
      color: 0x566070,
      roughness: 0.45,
      metalness: 0.8,
    });

    const clearDynamicProjectiles = () => {
      const s = simRef.current;
      for (const proj of s.droneProjectiles) {
        scene.remove(proj.mesh);
        (proj.mesh.material as THREE.Material).dispose();
      }
      s.droneProjectiles = [];
    };

    const spawnEnemyActor = (
      profile: TargetProfile,
      uid: number,
      hp: number,
      spawnX: number,
      spawnZ: number,
      doorSide: 'west' | 'east' | null,
      waypoints: { x: number; z: number }[]
    ) => {
      const s = simRef.current;
      const cfg = propsRef.current.config;
      const model = buildEnemyModel3D(profile, uid);
      model.root.position.set(spawnX, 0, spawnZ);
      scene.add(model.root);

      const patrolNodes = getDronePatrolNodes(cfg.roomId, cfg.distanceM);
      const startPatrol =
        profile.silhouette === 'drone'
          ? patrolNodes[uid % patrolNodes.length]
          : null;

      s.enemies.push({
        uid,
        profile,
        hp,
        maxHp: hp,
        firstDamagedAtMs: null,
        staggerHp: profile.staggerThreshold,
        maxStaggerHp: profile.staggerThreshold,
        staggerTimer: 0,
        alive: true,
        model,
        x: spawnX,
        z: spawnZ,
        vx: 0,
        meleeSlotX: ((uid % 5) - 2) * 0.85,
        meleeDist: (2.75 + (uid % 3) * 0.35) * Math.max(1, profile.scaleXZ),
        weaveDirection: uid % 2 === 0 ? 1 : -1,
        weavePhaseBreakTimer: 0.45 + (uid % 4) * 0.25,
        isChargingStraight: cfg.approachPattern === 'STRAIGHT_CHARGE',
        stridePhase: uid * 0.8,
        attackCooldown: 0.4 + (uid % 4) * 0.25,
        attackCount: 0,
        clawAnimType: 'NONE',
        clawAnimPhase: 0,
        dualStrikeExecuted: false,
        singleStrikeExecuted: false,
        doorSide,
        waypoints,
        waypointIdx: 0,
        doorBashCooldown: 0.18 + (uid % 3) * 0.12,
        dronePatrolTarget: startPatrol,
        dronePatrolTimer: 1.6 + (uid % 3) * 0.65,
        droneFireCooldown: 1.2 + (uid % 4) * 0.45,
        droneChargeTimer: 0,
        lungeState: 'NONE',
        lungeTimer: 0,
        lungeCooldown: 1.8 + (uid % 5) * 0.65,
        lungeDirX: 0,
        lungeDirZ: 0,
        swarmAngle: (uid * 2.399963) % (Math.PI * 2),
      });
    };

    const resetBreakableDoor = (door: BreakableDoor3D | null) => {
      if (!door) return;
      door.hp = door.maxHp;
      door.broken = false;
      door.flashTimer = 0;
      door.group.visible = true;
      door.hitMesh.visible = true;
      door.panelMat.emissive.setHex(0x000000);
      door.panelMat.emissiveIntensity = 0;
    };

    const breakDoor = (door: BreakableDoor3D) => {
      if (door.broken) return;
      door.broken = true;
      door.hp = 0;
      door.group.visible = false;
      door.hitMesh.visible = false;
      soundEngine.playDoorBreak();

      const s = simRef.current;
      for (let i = 0; i < 10; i++) {
        const mesh = new THREE.Mesh(debrisGeo, debrisMat);
        mesh.position.set(
          door.breachOrigin.x + (Math.random() - 0.5) * 0.4,
          0.5 + Math.random() * 2.4,
          door.breachOrigin.z + (Math.random() - 0.5) * 3.8
        );
        scene.add(mesh);
        s.doorDebris.push({
          mesh,
          vx: door.breachNormal.x * (3.5 + Math.random() * 4.5),
          vy: 1.5 + Math.random() * 4.0,
          vz: (Math.random() - 0.5) * 4.2,
          rx: (Math.random() - 0.5) * 10,
          ry: (Math.random() - 0.5) * 10,
          life: 1.5,
        });
      }
    };

    const damageDoor = (door: BreakableDoor3D, dmg: number) => {
      if (door.broken) return;
      door.hp = Math.max(0, door.hp - dmg);
      door.flashTimer = 0.14;
      door.panelMat.emissive.setHex(0xffb300);
      door.panelMat.emissiveIntensity = 0.85;
      if (door.hp <= 0) {
        breakDoor(door);
      }
    };

    const rebuildSquad = () => {
      const s = simRef.current;
      const p = propsRef.current;
      const cfg = p.config;

      if (s.roomNeedsRebuild && s.roomIdBuilt !== cfg.roomId) {
        currentRoom.dispose();
        currentRoom = buildRoomEnvironment(scene, renderer, cfg.roomId, isSoftwareGl);
        s.roomIdBuilt = cfg.roomId;
        s.roomNeedsRebuild = false;
      }

      if (s.resetPlayerPosPending) {
        s.playerX = currentRoom.playerSpawn.x;
        s.playerZ = currentRoom.playerSpawn.z;
        s.aimYaw = currentRoom.playerSpawn.yaw;
        s.targetAimYaw = currentRoom.playerSpawn.yaw;
        s.aimPitch = -0.02;
        s.targetAimPitch = -0.02;
        camera.position.set(s.playerX, 1.65, s.playerZ);
        s.resetPlayerPosPending = false;
      }

      for (const actor of s.enemies) {
        scene.remove(actor.model.root);
        disposeObject3D(actor.model.root);
      }
      s.enemies = [];
      s.pendingSpawns = [];
      clearDynamicProjectiles();

      resetBreakableDoor(currentRoom.westDoor);
      resetBreakableDoor(currentRoom.eastDoor);

      const spawnCount = p.waveGroupSize;
      const roster = buildSquadRoster(
        cfg.targetId,
        spawnCount,
        cfg.mixedGroup,
        p.targets,
        cfg.chassisSpawnCounts
      );
      s.totalSpawnedThisWave = roster.length;
      s.nextWaveTimerSec = null;
      setNextWaveCountdownSec(null);

      if (cfg.roomId === 'double_flank_02') {
        roster.forEach((profile, idx) => {
          const side: 'west' | 'east' = idx % 2 === 0 ? 'west' : 'east';
          const entrance = getDoubleFlankEntranceData(side, idx);
          const hp = idx === 0 ? cfg.targetHp : profile.defaultHp;
          const delaySec = idx * 0.8;

          if (delaySec <= 0.01) {
            spawnEnemyActor(
              profile,
              idx,
              hp,
              entrance.spawnX,
              entrance.spawnZ,
              side,
              entrance.waypoints
            );
          } else {
            s.pendingSpawns.push({
              uid: idx,
              profile,
              delayRemainingSec: delaySec,
              hp,
              spawnX: entrance.spawnX,
              spawnZ: entrance.spawnZ,
              doorSide: side,
              waypoints: entrance.waypoints,
            });
          }
        });
      } else {
        const count = roster.length;
        const cols = Math.min(5, count);
        roster.forEach((profile, idx) => {
          const col = idx % cols;
          const row = Math.floor(idx / cols);
          const laneOffset = (col - (cols - 1) * 0.5) * 3.1 + (row % 2 === 1 ? 1.1 : 0);
          const depthOffset = row * 4.5 + (idx % 2) * 1.4;
          const startZ = -Math.max(5, cfg.distanceM) - depthOffset;
          const hp = idx === 0 ? cfg.targetHp : profile.defaultHp;

          spawnEnemyActor(profile, idx, hp, laneOffset, startZ, null, []);
        });
      }

      s.squadNeedsRebuild = false;
      s.squadClearedNotified = false;
    };

    rebuildSquad();

    const raycaster = new THREE.Raycaster();
    const clock = new THREE.Clock();
    const keysDown = new Set<string>();

    const spawnTracer = (startWorld: THREE.Vector3, endWorld: THREE.Vector3, colorHex: number) => {
      const geo = new THREE.BufferGeometry().setFromPoints([startWorld.clone(), endWorld.clone()]);
      const mat = new THREE.LineBasicMaterial({
        color: colorHex,
        transparent: true,
        opacity: 0.9,
      });
      const line = new THREE.Line(geo, mat);
      scene.add(line);
      simRef.current.tracers.push({ line, life: 1.0 });
    };

    const pushHitVisuals = (
      totalHpDamage: number,
      anyCrit: boolean,
      anyKill: boolean,
      anyStagger: boolean,
      pierceCount: number
    ) => {
      const s = simRef.current;
      const pulseId = s.hitLabelCounter++;
      const nowHit = performance.now();

      setHitMarker({
        id: pulseId,
        isWeakspot: anyCrit,
        isKill: anyKill,
        createdAt: nowHit,
      });

      const labelText = anyKill
        ? anyCrit
          ? `CRIT KILL · ${totalHpDamage}`
          : `KILL · ${totalHpDamage}`
        : anyStagger
          ? `STAGGER · ${totalHpDamage}`
          : pierceCount > 0
            ? `PIERCE · ${totalHpDamage}`
            : anyCrit
              ? `CRIT ${totalHpDamage}`
              : `${totalHpDamage}`;

      const labelColor = anyCrit ? '#ffd000' : anyStagger ? '#00f0ff' : '#ff2a4b';

      const slot = pulseId % 3;
      const offsetX = slot === 1 ? 6 : 0;
      const offsetY = slot === 0 ? -10 : slot === 1 ? -24 : 4;

      setFloatingHits((prev) => [
        ...prev.slice(-10),
        {
          id: pulseId,
          offsetX,
          offsetY,
          text: labelText,
          color: labelColor,
          isWeakspot: anyCrit,
          isKill: anyKill,
          createdAt: nowHit,
        },
      ]);
    };

    const applyDamageAndStagger = (
      actor: EnemyActor,
      nextHp: number,
      staggerDamage: number
    ): { killed: boolean; triggeredStagger: boolean; enemyTtkMs: number | null } => {
      const nowMs = performance.now();
      if (actor.hp > nextHp && actor.firstDamagedAtMs === null) {
        actor.firstDamagedAtMs = nowMs;
      }
      actor.hp = nextHp;
      if (actor.hp <= 0) {
        actor.alive = false;
        actor.staggerTimer = 0;
        actor.clawAnimType = 'NONE';
        const enemyTtkMs = Math.max(
          1,
          Math.round(nowMs - (actor.firstDamagedAtMs ?? nowMs))
        );
        return { killed: true, triggeredStagger: false, enemyTtkMs };
      }

      if (actor.staggerTimer <= 0 && staggerDamage > 0) {
        actor.staggerHp = Math.max(0, actor.staggerHp - staggerDamage);
        if (actor.staggerHp <= 0) {
          actor.staggerTimer = actor.profile.staggerDurationSec;
          actor.clawAnimType = 'NONE';
          actor.attackCooldown = Math.max(actor.attackCooldown, 0.5);
          soundEngine.playEnemyStagger();
          return { killed: false, triggeredStagger: true, enemyTtkMs: null };
        }
      }
      return { killed: false, triggeredStagger: false, enemyTtkMs: null };
    };

    const checkSquadCleared = () => {
      const s = simRef.current;
      const p = propsRef.current;
      if (s.pendingSpawns.length > 0) return;
      const anyLeft = s.enemies.some((e) => e.alive);
      if (!anyLeft && !s.squadClearedNotified) {
        s.squadClearedNotified = true;
        if (p.playerHp > 0) {
          s.nextWaveTimerSec = 4.0;
          setNextWaveCountdownSec(4.0);
        }
        p.onSquadCleared();
      }
    };

    const startMeleeAttack = (
      style: MeleeAnimStyle,
      damage: number,
      durationSec: number,
      isAoe: boolean,
      aoeArcDeg: number,
      staggerOverride: number | null,
      isSpecial: boolean,
      isShove: boolean,
      label: string,
      chargePct = 1
    ) => {
      const s = simRef.current;
      const weapon = getWeaponById(propsRef.current.config.weaponId, propsRef.current.weapons);
      s.meleeAction = isShove ? 'SHOVE' : 'SWING';
      s.meleeAnimStyle = style;
      s.meleeAnimPhase = 0;
      s.meleeAnimDuration = Math.max(0.18, durationSec);
      s.meleeHitExecuted = false;
      s.meleeStrikeDamage = damage;
      s.meleeStrikeIsAoe = isAoe;
      s.meleeStrikeArcDeg = aoeArcDeg;
      s.meleeStrikeStaggerOverride = staggerOverride;
      s.meleeStrikeIsSpecial = isSpecial;
      s.meleeStrikeIsShove = isShove;
      s.meleeStrikeChargePct = chargePct;
      s.meleeStrikeLabel = label;
      s.meleeChargeSec = 0;
      s.meleeChargeReadyPlayed = false;

      if (!isShove) {
        soundEngine.playMeleeSwing(weapon.id, isSpecial);
      }
    };

    const executeMeleeStrike = () => {
      const p = propsRef.current;
      const s = simRef.current;
      const weapon = getWeaponById(p.config.weaponId, p.weapons);
      const melee = weapon.melee;
      if (!melee) return;

      const reach = melee.reachM + 0.55;
      const aliveHitMeshes: THREE.Mesh[] = [];
      for (const actor of s.enemies) {
        if (actor.alive) aliveHitMeshes.push(...actor.model.hitMeshes);
      }
      const envHitMeshes = currentRoom.environmentHitMeshes.filter((m) => m.visible);

      raycaster.setFromCamera(_rayCenter, camera);
      const rayHits = raycaster.intersectObjects([...aliveHitMeshes, ...envHitMeshes], false);

      // Check if melee swing hits an intact grey door in range
      if (rayHits.length > 0 && rayHits[0].distance <= reach + 0.65) {
        const doorSide = rayHits[0].object.userData.doorSide as 'west' | 'east' | undefined;
        if (doorSide) {
          const door = doorSide === 'west' ? currentRoom.westDoor : currentRoom.eastDoor;
          if (door && !door.broken) {
            soundEngine.playMeleeImpact(false, s.meleeStrikeIsShove);
            damageDoor(door, s.meleeStrikeDamage);
          }
        }
      }

      let directActor: EnemyActor | null = null;
      let directZone: HitZoneId = p.config.aimZone;

      for (const h of rayHits) {
        if (h.distance > reach + 0.6) break;
        if (h.object.userData.isWall || h.object.userData.doorSide) break;
        if (h.object.userData.enemyIdx !== undefined) {
          const enemyIdx = h.object.userData.enemyIdx as number;
          directActor = s.enemies.find((e) => e.uid === enemyIdx && e.alive) ?? null;
          directZone = (h.object.userData.hitZone as HitZoneId) ?? 'torso';
          break;
        }
      }

      const fwdX = -Math.sin(s.aimYaw);
      const fwdZ = -Math.cos(s.aimYaw);
      const halfArcRad = THREE.MathUtils.degToRad(s.meleeStrikeArcDeg * 0.58);

      const struckActors: { actor: EnemyActor; zone: HitZoneId }[] = [];

      if (s.meleeStrikeIsAoe) {
        for (const actor of s.enemies) {
          if (!actor.alive) continue;
          const dx = actor.x - camera.position.x;
          const dz = actor.z - camera.position.z;
          const dist = Math.hypot(dx, dz);
          if (dist <= reach + 0.35 * actor.profile.scaleXZ) {
            const dot = (dx * fwdX + dz * fwdZ) / Math.max(0.01, dist);
            const ang = Math.acos(THREE.MathUtils.clamp(dot, -1, 1));
            if (ang <= halfArcRad || actor === directActor) {
              const zone =
                actor === directActor
                  ? directZone
                  : p.config.aimZone === 'weakspot'
                    ? 'torso'
                    : p.config.aimZone;
              struckActors.push({ actor, zone });
            }
          }
        }
      } else if (directActor) {
        struckActors.push({ actor: directActor, zone: directZone });
      } else {
        let bestActor: EnemyActor | null = null;
        let bestDist = Infinity;
        for (const actor of s.enemies) {
          if (!actor.alive) continue;
          const dx = actor.x - camera.position.x;
          const dz = actor.z - camera.position.z;
          const dist = Math.hypot(dx, dz);
          if (dist <= reach + 0.35 * actor.profile.scaleXZ) {
            const dot = (dx * fwdX + dz * fwdZ) / Math.max(0.01, dist);
            const ang = Math.acos(THREE.MathUtils.clamp(dot, -1, 1));
            if (ang <= halfArcRad && dist < bestDist) {
              bestDist = dist;
              bestActor = actor;
            }
          }
        }
        if (bestActor) {
          struckActors.push({ actor: bestActor, zone: 'torso' });
        }
      }

      let totalRaw = 0;
      let totalHp = 0;
      let anyCrit = false;
      let anyKill = false;
      let anyStagger = false;
      const killedTtks: number[] = [];
      let primaryName = 'Air';
      let primaryDist = Math.round(reach);
      let primaryRemHp = 0;
      let primaryZone: HitZoneId = 'torso';
      let primaryZoneLabel = s.meleeStrikeLabel;

      for (const item of struckActors) {
        const { actor, zone } = item;
        const wasStaggered = actor.staggerTimer > 0;
        const res = resolveMeleeHit(
          weapon,
          actor.profile,
          actor.hp,
          zone,
          s.meleeStrikeDamage,
          s.meleeStrikeStaggerOverride,
          wasStaggered
        );

        const outcome = applyDamageAndStagger(actor, res.nextHp, res.staggerDamage);
        if (outcome.killed) {
          anyKill = true;
          if (outcome.enemyTtkMs !== null) killedTtks.push(outcome.enemyTtkMs);
        }
        if (outcome.triggeredStagger) anyStagger = true;
        if (res.isCrit) anyCrit = true;

        if (s.meleeStrikeIsShove && actor.alive) {
          const knockX = actor.x - camera.position.x;
          const knockZ = actor.z - camera.position.z;
          const knockLen = Math.max(0.01, Math.hypot(knockX, knockZ));
          const pushed = resolveRoomCollision2D(
            actor.x + (knockX / knockLen) * 0.85,
            actor.z + (knockZ / knockLen) * 0.85,
            actor.x,
            actor.z,
            0.55 * actor.profile.scaleXZ,
            p.config.roomId,
            {
              isPlayer: false,
              westDoorBroken: currentRoom.westDoor?.broken ?? true,
              eastDoorBroken: currentRoom.eastDoor?.broken ?? true,
            }
          );
          actor.x = pushed.x;
          actor.z = pushed.z;
        }

        totalRaw += res.rawDamage;
        totalHp += res.hpDamage;
        primaryName = actor.profile.name;
        primaryDist = Math.max(
          1,
          Math.round(Math.hypot(actor.x - camera.position.x, actor.z - camera.position.z))
        );
        primaryRemHp = actor.hp;
        primaryZone = zone;
        primaryZoneLabel =
          struckActors.length > 1
            ? `${s.meleeStrikeLabel} (${struckActors.length}x AoE)`
            : `${s.meleeStrikeLabel} · ${res.zoneLabel}${wasStaggered ? ' [STAG]' : ''}`;
      }

      if (struckActors.length > 0) {
        soundEngine.playMeleeImpact(anyCrit, s.meleeStrikeIsShove);
        s.meleeImpactBounce = s.meleeStrikeIsSpecial ? 1.0 : s.meleeStrikeIsShove ? 0.8 : 0.65;
        s.cameraShake = Math.max(
          s.cameraShake,
          s.meleeStrikeIsShove ? 0.28 : s.meleeStrikeIsSpecial ? 0.5 * s.meleeStrikeChargePct : 0.22
        );
        pushHitVisuals(totalHp, anyCrit, anyKill, anyStagger, 0);
      }

      const avgMeleeEnemyTtkMs =
        killedTtks.length > 0
          ? Math.round(killedTtks.reduce((a, b) => a + b, 0) / killedTtks.length)
          : null;

      p.onSquadShotResolved({
        roundsFiredDelta: 1,
        source: s.meleeStrikeIsShove ? 'PLAYER_SHOVE' : 'PLAYER_MELEE',
        zone: primaryZone,
        zoneLabel: struckActors.length > 0 ? primaryZoneLabel : `${s.meleeStrikeLabel} (Whiff)`,
        targetName: primaryName,
        rawDamage: totalRaw,
        hpDamage: totalHp,
        remainingHp: primaryRemHp,
        isCrit: anyCrit,
        isKill: anyKill,
        isMiss: struckActors.length === 0,
        isStagger: anyStagger,
        distanceM: primaryDist,
        enemyTtkMs: avgMeleeEnemyTtkMs,
      });

      checkSquadCleared();
    };

    const fireWeaponOnce = (isUserTrigger = false) => {
      const p = propsRef.current;
      const s = simRef.current;
      if (p.isPaused) return;
      const now = performance.now();
      const weapon = getWeaponById(p.config.weaponId, p.weapons);

      if (weapon.weaponClass === 'MELEE' && weapon.melee) {
        if (!isUserTrigger && s.meleeAction === 'IDLE' && s.meleeCooldownTimer <= 0) {
          const nearest = s.enemies
            .filter((e) => e.alive)
            .sort(
              (a, b) =>
                Math.hypot(a.x - camera.position.x, a.z - camera.position.z) -
                Math.hypot(b.x - camera.position.x, b.z - camera.position.z)
            )[0];
          if (
            nearest &&
            Math.hypot(nearest.x - camera.position.x, nearest.z - camera.position.z) <=
              weapon.melee.reachM + 0.5
          ) {
            const step = weapon.melee.comboSteps[s.meleeComboIdx % weapon.melee.comboSteps.length];
            s.meleeComboIdx = (s.meleeComboIdx + 1) % weapon.melee.comboSteps.length;
            s.meleeComboResetTimer = 1.8;
            startMeleeAttack(
              step.animStyle,
              step.damage,
              step.durationSec,
              step.isAoe,
              step.aoeArcDeg,
              null,
              false,
              false,
              step.label
            );
          }
        }
        return;
      }

      const modeRpmFactor =
        p.config.firingMode === 'SEMI_PRECISION'
          ? 0.65
          : p.config.firingMode === 'AUTO_BURST'
            ? 0.9
            : 1.0;
      const minIntervalMs = 60000 / Math.max(1, weapon.rpm * modeRpmFactor);
      if (now - s.lastFireTimeMs < minIntervalMs) return;
      if (p.playerHp <= 0) return;

      if (p.isReloading || p.magRemaining <= 0) {
        if (isUserTrigger) {
          soundEngine.playGunEmpty();
        }
        return;
      }

      const canFire = p.onTriggerShot();
      if (!canFire) {
        if (isUserTrigger) {
          soundEngine.playGunEmpty();
        }
        return;
      }

      s.lastFireTimeMs = now;
      soundEngine.playWeaponFire(weapon.id);
      const muzzleWorld = currentWeapon3D.muzzlePoint.getWorldPosition(_vec3A);

      const aliveHitMeshes: THREE.Mesh[] = [];
      for (const actor of s.enemies) {
        if (actor.alive) {
          aliveHitMeshes.push(...actor.model.hitMeshes);
        }
      }
      const envHitMeshes = currentRoom.environmentHitMeshes.filter((m) => m.visible);
      const allShootMeshes = [...aliveHitMeshes, ...envHitMeshes];

      const pellets = Math.max(1, weapon.pellets);
      const spreadDeg = weapon.spreadConeDeg * (s.isAds ? 0.65 : 1.0);
      const ndcRadius = (spreadDeg / Math.max(20, camera.fov)) * 2.0;

      let totalRawDamage = 0;
      let totalHpDamage = 0;
      let anyCrit = false;
      let anyKill = false;
      let anyStagger = false;
      const killedTtks: number[] = [];
      let anyGroundHit = false;
      let anyDoorHit = false;
      let hitCount = 0;
      let pierceCount = 0;
      let primaryZone: HitZoneId = 'torso';
      let primaryZoneLabel = s.isAds ? 'ADS Miss' : 'Hipfire Miss';
      let primaryTargetName = 'Range Void';
      let primaryDistM = Math.max(1, Math.round(p.config.distanceM));
      let primaryRemHp = 0;

      const dropRatio = Math.max(0.1, 1 - weapon.penetrationDropPct / 100);

      for (let k = 0; k < pellets; k++) {
        if (pellets === 1) {
          _rayPellet.copy(_rayCenter);
        } else {
          const ringFrac = k === 0 ? 0.08 : 0.35 + ((k % 3) * 0.25);
          const angle = (k / pellets) * Math.PI * 2 + now * 0.01;
          _rayPellet.set(
            Math.cos(angle) * ndcRadius * ringFrac,
            Math.sin(angle) * ndcRadius * ringFrac
          );
        }

        raycaster.setFromCamera(_rayPellet, camera);
        const intersects = raycaster.intersectObjects(allShootMeshes, false);

        if (intersects.length > 0) {
          const hitEnemyIds = new Set<number>();
          let remainingPenM = Math.max(0, weapon.penetrationDepthM);
          let pelletPierceIdx = 0;
          let terminalHitPoint = intersects[0].point;
          let terminalIsCrit = false;
          let pelletHitSomething = false;

          for (const hit of intersects) {
            // Check environment walls / doors first in distance order
            if (hit.object.userData.isWall) {
              terminalHitPoint = hit.point;
              break;
            }
            const doorSide = hit.object.userData.doorSide as 'west' | 'east' | undefined;
            if (doorSide) {
              const door = doorSide === 'west' ? currentRoom.westDoor : currentRoom.eastDoor;
              if (door && !door.broken) {
                anyDoorHit = true;
                damageDoor(door, weapon.baseDamage * (pellets > 1 ? 0.6 : 1));
                terminalHitPoint = hit.point;
                break;
              }
              continue;
            }

            const enemyIdx = hit.object.userData.enemyIdx as number | undefined;
            if (enemyIdx === undefined || hitEnemyIds.has(enemyIdx)) continue;
            const actor = s.enemies.find((e) => e.uid === enemyIdx && e.alive);
            if (!actor) continue;

            pelletHitSomething = true;
            hitEnemyIds.add(enemyIdx);
            const hitZone = (hit.object.userData.hitZone as HitZoneId) ?? 'torso';
            const distMeters = Math.max(
              1,
              Math.round(Math.hypot(actor.x - camera.position.x, actor.z - camera.position.z))
            );
            const penFactor = Math.pow(dropRatio, pelletPierceIdx);
            const wasStaggered = actor.staggerTimer > 0;

            const res = resolveShot(
              p.config,
              actor.hp,
              hitZone,
              true,
              s.shotIndexInBurst * pellets + k,
              distMeters,
              actor.profile.id,
              p.weapons,
              p.targets,
              penFactor,
              wasStaggered
            );

            const outcome = applyDamageAndStagger(actor, res.nextHp, res.staggerDamage);
            if (outcome.killed) {
              anyKill = true;
              if (outcome.enemyTtkMs !== null) killedTtks.push(outcome.enemyTtkMs);
            }
            if (outcome.triggeredStagger) anyStagger = true;

            hitCount += 1;
            if (pelletPierceIdx > 0) pierceCount += 1;
            totalRawDamage += res.rawDamage;
            totalHpDamage += res.hpDamage;
            if (res.isCrit) {
              anyCrit = true;
              terminalIsCrit = true;
            }
            terminalHitPoint = hit.point;

            if (pelletPierceIdx === 0) {
              primaryZone = hitZone;
              primaryZoneLabel =
                pellets > 1
                  ? `${hitCount}/${pellets} Pellets · ${res.zoneLabel}`
                  : `${res.zoneLabel}${wasStaggered ? ' [STAG]' : ''}`;
              primaryTargetName = actor.profile.name;
              primaryDistM = distMeters;
              primaryRemHp = actor.hp;
            }

            const bodyThicknessM =
              (hitZone === 'weakspot' || hitZone === 'limb' ? 0.34 : 0.55) * actor.profile.scaleXZ;
            remainingPenM -= bodyThicknessM;
            if (remainingPenM <= 0.01) {
              break;
            }
            pelletPierceIdx += 1;
          }

          const tracerColor = !pelletHitSomething
            ? 0x8c9bb5
            : pierceCount > 0
              ? 0x00f0ff
              : weapon.damageType === 'PLASMA'
                ? 0x00f0ff
                : terminalIsCrit
                  ? 0xff2a4b
                  : 0xffb300;
          spawnTracer(muzzleWorld, terminalHitPoint, tracerColor);
        } else {
          let missPoint: THREE.Vector3;
          let hitGroundThisPellet = false;
          if (raycaster.ray.direction.y < -0.001) {
            const groundT = -raycaster.ray.origin.y / raycaster.ray.direction.y;
            if (groundT > 0 && groundT < 160) {
              missPoint = _vec3B
                .copy(raycaster.ray.origin)
                .addScaledVector(raycaster.ray.direction, groundT)
                .clone();
              hitGroundThisPellet = true;
              anyGroundHit = true;
            } else {
              missPoint = _vec3B
                .copy(raycaster.ray.origin)
                .addScaledVector(raycaster.ray.direction, 55)
                .clone();
            }
          } else {
            missPoint = _vec3B
              .copy(raycaster.ray.origin)
              .addScaledVector(raycaster.ray.direction, 55)
              .clone();
          }
          spawnTracer(muzzleWorld, missPoint, hitGroundThisPellet ? 0x8c9bb5 : 0x4b5870);
        }
      }

      if (hitCount > 0) {
        if (anyCrit) {
          soundEngine.playHitWeakspot();
        } else {
          soundEngine.playHitArmor();
        }
      } else if (anyDoorHit) {
        soundEngine.playHitArmor();
      }
      if (anyGroundHit) {
        soundEngine.playHitGround();
      }

      const recoilStep = getRecoilForShot(weapon, s.shotIndexInBurst, s.isAds, s.recoilHeat);
      s.shotIndexInBurst += 1;
      s.recoilHeat = Math.min(1, s.recoilHeat + weapon.recoilCoeff.perShotIncrement);
      s.recoilYaw += THREE.MathUtils.degToRad(recoilStep.yawDeg);
      s.recoilPitch += THREE.MathUtils.degToRad(recoilStep.pitchDeg);
      s.weaponKickZ = s.isAds ? 0.045 : 0.075;
      s.weaponKickPitch = s.isAds ? 0.038 : 0.07;
      s.muzzleFlashTimer = 0.055;
      currentWeapon3D.muzzleFlash.visible = true;

      const avgShotEnemyTtkMs =
        killedTtks.length > 0
          ? Math.round(killedTtks.reduce((a, b) => a + b, 0) / killedTtks.length)
          : null;

      p.onSquadShotResolved({
        roundsFiredDelta: 1,
        source: 'PLAYER',
        zone: primaryZone,
        zoneLabel:
          pierceCount > 0 ? `${primaryZoneLabel} +${pierceCount} PIERCE` : primaryZoneLabel,
        targetName: primaryTargetName,
        rawDamage: totalRawDamage,
        hpDamage: totalHpDamage,
        remainingHp: primaryRemHp,
        isCrit: anyCrit,
        isKill: anyKill,
        isMiss: hitCount === 0,
        isStagger: anyStagger,
        distanceM: primaryDistM,
        enemyTtkMs: avgShotEnemyTtkMs,
      });

      if (hitCount > 0) {
        pushHitVisuals(totalHpDamage, anyCrit, anyKill, anyStagger, pierceCount);
      }

      checkSquadCleared();
    };

    const dom = renderer.domElement;
    let wasPointerLocked = false;
    let isDisposed = false;

    const handlePointerLockChange = () => {
      const locked = document.pointerLockElement === dom;
      setIsPointerLocked(locked);
      if (locked) {
        wasPointerLocked = true;
        simRef.current.unlockedByCtrl = false;
        return;
      }

      if (wasPointerLocked) {
        wasPointerLocked = false;
        if (simRef.current.unlockedByCtrl) {
          simRef.current.unlockedByCtrl = false;
        } else if (!isDisposed && !propsRef.current.isPaused) {
          // Esc pressed while pointer-locked drops lock cleanly -> trigger Pause
          simRef.current.lastEscLockDropMs = performance.now();
          propsRef.current.onSetPaused(true);
        }
      }
    };

    const handleMouseEnter = () => {
      simRef.current.isMouseInside = true;
      simRef.current.hasPrevClientMouse = false;
      setIsMouseInViewport(true);
    };

    const handleMouseLeave = () => {
      simRef.current.isMouseInside = false;
      simRef.current.hasPrevClientMouse = false;
      simRef.current.edgePanDir = 0;
      simRef.current.lmbDown = false;
      simRef.current.shotIndexInBurst = 0;
      setIsMouseInViewport(false);
    };

    const handleMouseMove = (e: MouseEvent) => {
      const s = simRef.current;
      const p = propsRef.current;
      if (p.isPaused || s.cursorShown) return;

      if (document.pointerLockElement === dom) {
        s.targetAimYaw -= e.movementX * 0.0022;
        s.targetAimPitch = THREE.MathUtils.clamp(
          s.targetAimPitch - e.movementY * 0.002,
          -1.28,
          1.28
        );
        s.edgePanDir = 0;
      } else {
        const rect = dom.getBoundingClientRect();
        const nx = ((e.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
        const dx =
          Math.abs(e.movementX) > 0
            ? e.movementX
            : s.hasPrevClientMouse
              ? e.clientX - s.prevClientX
              : 0;
        const dy =
          Math.abs(e.movementY) > 0
            ? e.movementY
            : s.hasPrevClientMouse
              ? e.clientY - s.prevClientY
              : 0;

        s.prevClientX = e.clientX;
        s.prevClientY = e.clientY;
        s.hasPrevClientMouse = true;

        s.targetAimYaw -= dx * 0.0032;
        s.targetAimPitch = THREE.MathUtils.clamp(s.targetAimPitch - dy * 0.0028, -1.28, 1.28);

        // Edge-turn fallback when pointer lock is unavailable
        if (nx > 0.84) {
          s.edgePanDir = -((nx - 0.84) / 0.16);
        } else if (nx < -0.84) {
          s.edgePanDir = (-0.84 - nx) / 0.16;
        } else {
          s.edgePanDir = 0;
        }
      }
    };

    const handleMouseDown = (e: MouseEvent) => {
      e.preventDefault();
      soundEngine.unlock();
      const s = simRef.current;
      const p = propsRef.current;

      if (p.isPaused) return;

      // Request pointer lock on viewport click if cursor isn't deliberately shown via Ctrl
      if (!s.cursorShown && document.pointerLockElement !== dom) {
        try {
          dom.requestPointerLock?.();
        } catch {
          // Ignore sandbox pointer lock rejection; relative fallback stays active
        }
      }

      const weapon = getWeaponById(p.config.weaponId, p.weapons);

      if (weapon.weaponClass === 'MELEE' && weapon.melee) {
        if (p.playerHp <= 0) return;
        if (e.button === 0) {
          s.lmbDown = true;
          if (s.meleeAction === 'IDLE' && s.meleeCooldownTimer <= 0) {
            s.meleeAction = 'CHARGING';
            s.meleeChargeSec = 0;
            s.meleeChargeReadyPlayed = false;
          }
        } else if (e.button === 2) {
          if (
            (s.meleeAction === 'IDLE' || s.meleeAction === 'CHARGING') &&
            s.meleeCooldownTimer <= 0
          ) {
            const melee = weapon.melee;
            startMeleeAttack(
              'SHOVE',
              melee.shoveDamage,
              0.34,
              false,
              65,
              melee.shoveStaggerDamage,
              false,
              true,
              'Tactical Shove'
            );
          }
        }
        return;
      }

      if (e.button === 0) {
        s.lmbDown = true;
        fireWeaponOnce(true);
        if (p.config.firingMode === 'SEMI_PRECISION') {
          s.lmbDown = false;
        }
      } else if (e.button === 2) {
        s.rmbDownAt = performance.now();
        if (!s.isAds) {
          s.isAds = true;
          setIsAds(true);
        } else {
          s.rmbDownAt = -performance.now();
        }
      }
    };

    const handleMouseUp = (e: MouseEvent) => {
      const s = simRef.current;
      const p = propsRef.current;
      const weapon = getWeaponById(p.config.weaponId, p.weapons);

      if (weapon.weaponClass === 'MELEE' && weapon.melee) {
        if (e.button === 0) {
          s.lmbDown = false;
          if (s.meleeAction === 'CHARGING') {
            const melee = weapon.melee;
            const tapThresholdSec = 0.14;
            if (s.meleeChargeSec >= tapThresholdSec) {
              const chargePct = Math.min(
                1,
                Math.max(0.08, s.meleeChargeSec / Math.max(0.1, melee.specialChargeSec))
              );
              const scaledDamage =
                melee.specialDamage > weapon.baseDamage
                  ? Math.min(
                      melee.specialDamage,
                      Math.max(
                        weapon.baseDamage + 1,
                        Math.round(
                          THREE.MathUtils.lerp(weapon.baseDamage, melee.specialDamage, chargePct)
                        )
                      )
                    )
                  : Math.round(melee.specialDamage * (0.55 + 0.45 * chargePct));

              const speedMult = THREE.MathUtils.lerp(0.55, 1.0, chargePct);
              const baseSpecialDur = weapon.id === 'maelstrom_hammer' ? 0.56 : 0.46;
              const scaledDuration = baseSpecialDur / speedMult;

              const isHalberdChain =
                melee.specialChainAltSweep && s.halberdSpecialChainTimer > 0;
              const style: MeleeAnimStyle =
                weapon.id === 'maelstrom_hammer'
                  ? 'HAMMER_SPECIAL'
                  : isHalberdChain
                    ? 'HALBERD_SPEC_R_TO_L'
                    : 'HALBERD_SPEC_L_TO_R';

              if (melee.specialChainAltSweep) {
                s.halberdSpecialChainTimer = isHalberdChain ? 0 : 1.75;
              }
              const pctLabel =
                chargePct < 0.99 ? ` (${Math.round(chargePct * 100)}%)` : '';
              const baseLabel = isHalberdChain
                ? 'Special Sweep R→L'
                : melee.specialChainAltSweep
                  ? 'Special Sweep L→R'
                  : 'Crushing Overhead Smash';

              startMeleeAttack(
                style,
                scaledDamage,
                scaledDuration,
                melee.specialIsAoe,
                melee.specialIsAoe ? 135 : 55,
                null,
                true,
                false,
                `${baseLabel}${pctLabel}`,
                chargePct
              );
            } else {
              const step = melee.comboSteps[s.meleeComboIdx % melee.comboSteps.length];
              s.meleeComboIdx = (s.meleeComboIdx + 1) % melee.comboSteps.length;
              s.meleeComboResetTimer = 1.85;
              startMeleeAttack(
                step.animStyle,
                step.damage,
                step.durationSec,
                step.isAoe,
                step.aoeArcDeg,
                null,
                false,
                false,
                step.label,
                1
              );
            }
          }
        }
        return;
      }

      if (e.button === 0) {
        s.lmbDown = false;
        s.shotIndexInBurst = 0;
      } else if (e.button === 2) {
        const marker = s.rmbDownAt;
        if (marker < 0) {
          s.isAds = false;
          setIsAds(false);
        } else {
          const heldMs = performance.now() - marker;
          if (heldMs > 190) {
            s.isAds = false;
            setIsAds(false);
          }
        }
      }
    };

    const handleContextMenu = (e: MouseEvent) => e.preventDefault();

    const handleKeyDown = (e: KeyboardEvent) => {
      const targetEl = e.target as HTMLElement | null;
      const isTypingInput =
        targetEl &&
        (targetEl.tagName === 'INPUT' ||
          targetEl.tagName === 'TEXTAREA' ||
          targetEl.tagName === 'SELECT');

      if (e.key === 'Escape') {
        if (performance.now() - simRef.current.lastEscLockDropMs > 180) {
          propsRef.current.onSetPaused(!propsRef.current.isPaused);
        }
        return;
      }

      if (e.key === 'Control' && !e.repeat) {
        const s = simRef.current;
        const nextShown = !s.cursorShown;
        s.cursorShown = nextShown;
        setCursorShown(nextShown);
        if (nextShown) {
          s.unlockedByCtrl = true;
          if (document.pointerLockElement === dom) {
            document.exitPointerLock?.();
          }
        } else {
          s.unlockedByCtrl = false;
          if (s.isMouseInside && !propsRef.current.isPaused) {
            try {
              dom.requestPointerLock?.();
            } catch {
              // ignore
            }
          }
        }
        return;
      }

      if (isTypingInput) return;

      soundEngine.unlock();

      if (
        e.code === 'ArrowUp' ||
        e.code === 'ArrowDown' ||
        e.code === 'ArrowLeft' ||
        e.code === 'ArrowRight'
      ) {
        e.preventDefault();
      }
      keysDown.add(e.code);

      if (propsRef.current.isPaused) return;

      if ((e.key === 'q' || e.key === 'Q') && !e.repeat) {
        propsRef.current.onUseMedkit();
        return;
      }

      if ((e.key === 'f' || e.key === 'F') && !e.repeat) {
        const cur = simRef.current.flashlightMode;
        const nextMode: FlashlightMode = cur === 'OFF' ? 'SPOT' : cur === 'SPOT' ? 'FLOOD' : 'OFF';
        simRef.current.flashlightMode = nextMode;
        setFlashlightMode(nextMode);
        soundEngine.playFlashlightToggle(nextMode);
        return;
      }

      const weapon = getWeaponById(propsRef.current.config.weaponId, propsRef.current.weapons);
      if ((e.key === 'v' || e.key === 'V') && weapon.weaponClass !== 'MELEE') {
        simRef.current.isAds = !simRef.current.isAds;
        setIsAds(simRef.current.isAds);
      } else if ((e.key === 'r' || e.key === 'R') && weapon.weaponClass !== 'MELEE') {
        propsRef.current.onManualReload?.();
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      keysDown.delete(e.code);
    };

    const handleWindowBlur = () => {
      keysDown.clear();
      simRef.current.lmbDown = false;
    };

    dom.addEventListener('mouseenter', handleMouseEnter);
    dom.addEventListener('mouseleave', handleMouseLeave);
    dom.addEventListener('mousemove', handleMouseMove);
    dom.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mouseup', handleMouseUp);
    dom.addEventListener('contextmenu', handleContextMenu);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleWindowBlur);
    document.addEventListener('pointerlockchange', handlePointerLockChange);

    const handleResize = () => {
      if (!container) return;
      const w = Math.max(320, container.clientWidth);
      const h = Math.max(240, container.clientHeight);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    };
    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(container);

    if (!isSoftwareGl) {
      renderer.compile(scene, camera);
    }

    let frameId = 0;
    let hudSyncAcc = 0;

    function afterDraw(cb: () => void) {
      const gl = renderer.getContext() as WebGL2RenderingContext;
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      const poll = () => {
        if (isDisposed) return;
        const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
        if (state === gl.UNSIGNALED) {
          frameId = window.setTimeout(poll, 5);
        } else {
          if (sync) gl.deleteSync(sync);
          frameId = window.setTimeout(cb, 80);
        }
      };
      frameId = window.setTimeout(poll, 5);
    }

    const tick = () => {
      if (isDisposed) return;
      const rawDelta = clock.getDelta();
      const delta = Math.min(0.05, rawDelta);
      const elapsed = clock.getElapsedTime();
      const p = propsRef.current;
      const s = simRef.current;

      if (s.squadNeedsRebuild) {
        rebuildSquad();
      }

      if (s.weaponIdBuilt !== p.config.weaponId) {
        weaponAnchor.remove(currentWeapon3D.root);
        disposeObject3D(currentWeapon3D.root);
        currentWeapon3D = buildWeaponViewmodel3D(p.config.weaponId);
        weaponAnchor.add(currentWeapon3D.root);
        s.weaponIdBuilt = p.config.weaponId;
        s.recoilHeat = 0;
        s.firingSwayBlend = 0;
        s.recoilYaw = 0;
        s.recoilPitch = 0;
        s.isAds = false;
        s.meleeAction = 'IDLE';
        s.meleeChargeSec = 0;
        s.meleeComboIdx = 0;
        s.halberdSpecialChainTimer = 0;
        setIsAds(false);
      }

      const activeWeapon = getWeaponById(p.config.weaponId, p.weapons);
      const isMeleeWeapon = activeWeapon.weaponClass === 'MELEE' && !!activeWeapon.melee;

      if (!p.isPaused) {
        // Update overhead room lights smoothly (dim -> bright -> off -> dim, zero flickering)
        updateRoomLights(currentRoom.dynamicLights, delta);

        // Update player offset flashlight beam (SPOT 6x brighter, FLOOD 4x brighter)
        const targetFlIntensity =
          s.flashlightMode === 'SPOT' ? 288 : s.flashlightMode === 'FLOOD' ? 60 : 0;
        const targetFlAngle =
          s.flashlightMode === 'SPOT' ? 0.2 : s.flashlightMode === 'FLOOD' ? 0.74 : 0.24;
        const targetFlPenumbra =
          s.flashlightMode === 'SPOT' ? 0.38 : s.flashlightMode === 'FLOOD' ? 0.8 : 0.42;
        const targetFlDistance =
          s.flashlightMode === 'SPOT' ? 68 : s.flashlightMode === 'FLOOD' ? 38 : 64;
        flashlight.intensity = THREE.MathUtils.damp(flashlight.intensity, targetFlIntensity, 16, delta);
        flashlight.angle = THREE.MathUtils.damp(flashlight.angle, targetFlAngle, 14, delta);
        flashlight.penumbra = THREE.MathUtils.damp(flashlight.penumbra, targetFlPenumbra, 14, delta);
        flashlight.distance = THREE.MathUtils.damp(flashlight.distance, targetFlDistance, 14, delta);

        // 0.8s Staggered Queue Spawner (behind Grey Doors in double_flank_02)
        for (let i = s.pendingSpawns.length - 1; i >= 0; i--) {
          const item = s.pendingSpawns[i];
          item.delayRemainingSec -= delta;
          if (item.delayRemainingSec <= 0) {
            spawnEnemyActor(
              item.profile,
              item.uid,
              item.hp,
              item.spawnX,
              item.spawnZ,
              item.doorSide,
              item.waypoints
            );
            s.pendingSpawns.splice(i, 1);
          }
        }

        // Automatic 4s inter-wave countdown -> starts next wave immediately
        if (s.nextWaveTimerSec !== null) {
          if (p.playerHp <= 0 || s.pendingSpawns.length > 0 || s.enemies.some((e) => e.alive)) {
            s.nextWaveTimerSec = null;
          } else {
            s.nextWaveTimerSec -= delta;
            if (s.nextWaveTimerSec <= 0) {
              s.nextWaveTimerSec = null;
              setNextWaveCountdownSec(null);
              p.onStartNextWave();
            }
          }
        }

        if (s.playerHitSlowTimer > 0) {
          s.playerHitSlowTimer = Math.max(0, s.playerHitSlowTimer - delta);
        }

        // Compute enemy swarm proximity to limit player movement & block sprint when surrounded
        let closeSwarmCount = 0;
        let pinContactCount = 0;
        for (const actor of s.enemies) {
          if (!actor.alive || actor.profile.silhouette === 'drone') continue;
          const dist = Math.hypot(actor.x - s.playerX, actor.z - s.playerZ);
          const pinDist = 0.95 + 0.55 * actor.profile.scaleXZ;
          if (dist < pinDist) {
            pinContactCount += 1;
          }
          if (dist < 3.6) {
            closeSwarmCount += 1;
          }
        }

        const crowdSpeedMult = Math.max(
          0.32,
          1 -
            pinContactCount * 0.24 -
            Math.min(4, closeSwarmCount) * 0.08 -
            (s.playerHitSlowTimer > 0 ? 0.22 : 0)
        );

        // Player WASD / Arrow movement + Shift Sprint with enemy body-blocking & room collision
        const fwdInput =
          (keysDown.has('KeyW') || keysDown.has('ArrowUp') ? 1 : 0) -
          (keysDown.has('KeyS') || keysDown.has('ArrowDown') ? 1 : 0);
        const strafeInput =
          (keysDown.has('KeyD') || keysDown.has('ArrowRight') ? 1 : 0) -
          (keysDown.has('KeyA') || keysDown.has('ArrowLeft') ? 1 : 0);
        const isMoving = fwdInput !== 0 || strafeInput !== 0;
        const isSprinting =
          p.playerHp > 0 &&
          isMoving &&
          pinContactCount === 0 &&
          s.playerHitSlowTimer <= 0 &&
          (keysDown.has('ShiftLeft') || keysDown.has('ShiftRight'));

        if (p.playerHp > 0) {
          if (isSprinting && s.isAds) {
            s.isAds = false;
            setIsAds(false);
          }

          if (isMoving) {
            const len = Math.hypot(fwdInput, strafeInput);
            const nf = fwdInput / len;
            const ns = strafeInput / len;
            const fwdX = -Math.sin(s.aimYaw);
            const fwdZ = -Math.cos(s.aimYaw);
            const rightX = Math.cos(s.aimYaw);
            const rightZ = -Math.sin(s.aimYaw);
            const baseSpeed = isSprinting ? 10.2 : 6.4 * (s.isAds ? 0.72 : 1.0);
            const speed = baseSpeed * crowdSpeedMult;

            const nextX = s.playerX + (fwdX * nf + rightX * ns) * speed * delta;
            const nextZ = s.playerZ + (fwdZ * nf + rightZ * ns) * speed * delta;
            const resolved = resolveRoomCollision2D(
              nextX,
              nextZ,
              s.playerX,
              s.playerZ,
              0.55,
              p.config.roomId,
              {
                isPlayer: true,
                westDoorBroken: currentRoom.westDoor?.broken ?? true,
                eastDoorBroken: currentRoom.eastDoor?.broken ?? true,
              }
            );
            s.playerX = resolved.x;
            s.playerZ = resolved.z;
            s.walkBobPhase += delta * (isSprinting ? 15.2 : 10.5 * Math.max(0.6, crowdSpeedMult));
          } else {
            s.walkBobPhase = THREE.MathUtils.damp(s.walkBobPhase, 0, 8, delta);
          }

          // Physical body collision against alive ground enemies (enemies physically block/pin player)
          for (let pass = 0; pass < 2; pass++) {
            for (const actor of s.enemies) {
              if (!actor.alive || actor.profile.silhouette === 'drone') continue;
              const dx = s.playerX - actor.x;
              const dz = s.playerZ - actor.z;
              const dist = Math.hypot(dx, dz);
              const minSep = 0.52 + 0.44 * actor.profile.scaleXZ;
              if (dist < minSep) {
                const nx = dist > 0.001 ? dx / dist : Math.cos(actor.swarmAngle);
                const nz = dist > 0.001 ? dz / dist : Math.sin(actor.swarmAngle);
                const pushed = resolveRoomCollision2D(
                  actor.x + nx * minSep,
                  actor.z + nz * minSep,
                  s.playerX,
                  s.playerZ,
                  0.55,
                  p.config.roomId,
                  {
                    isPlayer: true,
                    westDoorBroken: currentRoom.westDoor?.broken ?? true,
                    eastDoorBroken: currentRoom.eastDoor?.broken ?? true,
                  }
                );
                s.playerX = pushed.x;
                s.playerZ = pushed.z;
              }
            }
          }

          if (!s.cursorShown && s.edgePanDir !== 0 && document.pointerLockElement !== dom) {
            s.targetAimYaw += s.edgePanDir * 1.45 * delta;
          }
        }

        const bobYCam = isMoving
          ? Math.sin(s.walkBobPhase) * (isSprinting ? 0.048 : 0.032)
          : 0;
        camera.position.set(s.playerX, 1.65 + bobYCam, s.playerZ);

        // Find nearest alive enemy to player
        let nearestAlive: EnemyActor | null = null;
        let nearestDistSq = Infinity;
        for (const actor of s.enemies) {
          if (actor.alive) {
            const dx = actor.x - s.playerX;
            const dz = actor.z - s.playerZ;
            const dSq = dx * dx + dz * dz;
            if (dSq < nearestDistSq) {
              nearestDistSq = dSq;
              nearestAlive = actor;
            }
          }
        }

        if (!isMeleeWeapon) {
          if (s.lmbDown && p.config.firingMode !== 'SEMI_PRECISION') {
            fireWeaponOnce(true);
          } else if (p.isSimRunning && nearestAlive && p.playerHp > 0) {
            const targetAimY =
              p.config.aimZone === 'weakspot' ? nearestAlive.model.weakspotHeight : 1.35;
            const dx = nearestAlive.x - camera.position.x;
            const dy = targetAimY - camera.position.y;
            const dz = nearestAlive.z - camera.position.z;
            s.targetAimYaw = Math.atan2(-dx, -dz);
            s.targetAimPitch = Math.atan2(dy, Math.hypot(dx, dz));
            fireWeaponOnce(false);
          }
        } else if (p.isSimRunning && nearestAlive && p.playerHp > 0) {
          const targetAimY =
            p.config.aimZone === 'weakspot' ? nearestAlive.model.weakspotHeight : 1.35;
          const dx = nearestAlive.x - camera.position.x;
          const dy = targetAimY - camera.position.y;
          const dz = nearestAlive.z - camera.position.z;
          s.targetAimYaw = Math.atan2(-dx, -dz);
          s.targetAimPitch = Math.atan2(dy, Math.hypot(dx, dz));
          fireWeaponOnce(false);
        }

        // Decay progressive recoil & sway heat for firearms
        const modeRpmFactor =
          p.config.firingMode === 'SEMI_PRECISION'
            ? 0.65
            : p.config.firingMode === 'AUTO_BURST'
              ? 0.9
              : 1.0;
        const minShotIntervalMs = 60000 / Math.max(1, activeWeapon.rpm * modeRpmFactor);
        const isTriggerActive =
          !isMeleeWeapon &&
          ((s.lmbDown && p.config.firingMode !== 'SEMI_PRECISION') ||
            (p.isSimRunning && !!nearestAlive && p.playerHp > 0));
        const sinceShotMs = performance.now() - s.lastFireTimeMs;
        if (!isTriggerActive && sinceShotMs > Math.max(85, minShotIntervalMs * 0.95)) {
          s.recoilHeat = Math.max(0, s.recoilHeat - activeWeapon.recoilCoeff.decayPerSec * delta);
        }

        const targetSwayBlend = isTriggerActive ? s.recoilHeat : 0;
        s.firingSwayBlend = THREE.MathUtils.damp(s.firingSwayBlend, targetSwayBlend, 14, delta);
        s.swayPhase += delta * 2.0;

        s.aimYaw = THREE.MathUtils.damp(s.aimYaw, s.targetAimYaw, 24, delta);
        s.aimPitch = THREE.MathUtils.damp(s.aimPitch, s.targetAimPitch, 24, delta);

        const recoilRecoveryLambda = s.lmbDown ? 0.95 : p.isSimRunning ? 5.5 : 9.5;
        s.recoilYaw = THREE.MathUtils.damp(s.recoilYaw, 0, recoilRecoveryLambda, delta);
        s.recoilPitch = THREE.MathUtils.damp(s.recoilPitch, 0, recoilRecoveryLambda, delta);

        const activeHeatSway = 1 + s.firingSwayBlend * activeWeapon.recoilCoeff.swayGain;
        const aimSwayBase = isMeleeWeapon ? 0.0018 : s.isAds ? 0.0012 : 0.0042 * 1.2;
        const aimSwayAmp =
          aimSwayBase * (1 + s.firingSwayBlend * activeWeapon.recoilCoeff.swayGain * 1.45);
        const swayYaw = Math.sin(s.swayPhase * 1.15) * aimSwayAmp;
        const swayPitch = Math.cos(s.swayPhase * 1.45) * aimSwayAmp * 0.75;

        s.cameraShake = THREE.MathUtils.damp(s.cameraShake, 0, 10, delta);
        s.meleeImpactBounce = THREE.MathUtils.damp(s.meleeImpactBounce, 0, 18, delta);
        s.cameraMeleePitch = THREE.MathUtils.damp(s.cameraMeleePitch, 0, 14, delta);
        s.cameraMeleeYaw = THREE.MathUtils.damp(s.cameraMeleeYaw, 0, 14, delta);
        s.cameraMeleeRoll = THREE.MathUtils.damp(s.cameraMeleeRoll, 0, 14, delta);
        s.cameraMeleeFovOffset = THREE.MathUtils.damp(s.cameraMeleeFovOffset, 0, 12, delta);

        const shakeX = Math.sin(elapsed * 55) * 0.028 * s.cameraShake;
        const shakeY = Math.cos(elapsed * 47) * 0.028 * s.cameraShake;

        camera.rotation.order = 'YXZ';
        camera.rotation.y = s.aimYaw + s.recoilYaw + swayYaw + shakeX + s.cameraMeleeYaw;
        camera.rotation.x = THREE.MathUtils.clamp(
          s.aimPitch + s.recoilPitch + swayPitch + shakeY + s.cameraMeleePitch,
          -1.28,
          1.28
        );
        camera.rotation.z = s.cameraMeleeRoll;

        const baseTargetFov = !isMeleeWeapon && s.isAds ? activeWeapon.adsFov : 62;
        const targetFov =
          baseTargetFov + (isSprinting ? 4 : 0) + (isMeleeWeapon ? s.cameraMeleeFovOffset : 0);
        if (Math.abs(camera.fov - targetFov) > 0.05) {
          camera.fov = THREE.MathUtils.damp(camera.fov, targetFov, 14, delta);
          camera.updateProjectionMatrix();
        }

        // Viewmodel Animation (Melee vs Firearm)
        const baseRig =
          s.isAds && !isMeleeWeapon ? currentWeapon3D.opticOffset : currentWeapon3D.hipOffset;
        s.weaponKickZ = THREE.MathUtils.damp(s.weaponKickZ, 0, 16, delta);
        s.weaponKickPitch = THREE.MathUtils.damp(s.weaponKickPitch, 0, 16, delta);

        if (isMeleeWeapon && activeWeapon.melee) {
          if (s.meleeCooldownTimer > 0)
            s.meleeCooldownTimer = Math.max(0, s.meleeCooldownTimer - delta);
          if (s.halberdSpecialChainTimer > 0) {
            s.halberdSpecialChainTimer = Math.max(0, s.halberdSpecialChainTimer - delta);
          }
          if (s.meleeAction === 'IDLE' && s.meleeComboResetTimer > 0) {
            s.meleeComboResetTimer -= delta;
            if (s.meleeComboResetTimer <= 0) s.meleeComboIdx = 0;
          }

          const easeOutCubic = (x: number) => 1 - Math.pow(1 - x, 3);
          const easeInCubic = (x: number) => x * x * x;
          const easeInOutQuad = (x: number) =>
            x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;

          let offX = Math.sin(s.swayPhase * 1.15) * 0.008;
          let offY = Math.cos(s.swayPhase * 2.3) * 0.005;
          let offZ = Math.sin(s.swayPhase * 1.15) * 0.004;
          let rotX = Math.sin(s.swayPhase * 1.15) * 0.015;
          let rotY = Math.cos(s.swayPhase * 1.15) * 0.012;
          let rotZ = Math.sin(s.swayPhase * 1.15) * 0.018;
          let bladeRoll = 0;

          if (s.meleeAction === 'CHARGING') {
            s.meleeChargeSec += delta;
            const rawPct = Math.min(
              1,
              s.meleeChargeSec / Math.max(0.1, activeWeapon.melee.specialChargeSec)
            );
            const pct = s.meleeChargeSec < 0.14 ? rawPct * 0.25 : rawPct;
            if (rawPct >= 1 && !s.meleeChargeReadyPlayed) {
              s.meleeChargeReadyPlayed = true;
              soundEngine.playMeleeChargeReady();
            }

            s.cameraMeleeFovOffset = -3.4 * pct;
            const strainJitter =
              s.meleeChargeSec >= 0.14 ? Math.sin(elapsed * 32) * 0.006 * pct : 0;

            if (activeWeapon.id === 'maelstrom_hammer') {
              const ePct = easeOutCubic(pct);
              offX = -0.09 * ePct + strainJitter;
              offY = 0.34 * ePct + strainJitter * 0.5;
              offZ = 0.12 * ePct;
              rotX = 0.58 * ePct;
              rotZ = 0.18 * ePct;
              s.cameraMeleePitch = 0.028 * ePct;
            } else {
              const chainDir = s.halberdSpecialChainTimer > 0 ? 1 : -1;
              const ePct = easeOutCubic(pct);
              offX = chainDir * 0.44 * ePct + strainJitter;
              offY = 0.08 * ePct;
              offZ = 0.18 * ePct;
              rotX = -0.62 * ePct;
              rotY = -chainDir * 0.85 * ePct;
              rotZ = -chainDir * 1.05 * ePct;
              bladeRoll = chainDir * Math.PI * 0.48 * ePct;
              s.cameraMeleeRoll = chainDir * 0.026 * ePct;
            }
          } else if (s.meleeAction === 'SWING' || s.meleeAction === 'SHOVE') {
            s.meleeAnimPhase += delta / s.meleeAnimDuration;
            const t = Math.min(1, s.meleeAnimPhase);

            if (t >= 0.42 && !s.meleeHitExecuted) {
              s.meleeHitExecuted = true;
              executeMeleeStrike();
            }

            const recoil = s.meleeImpactBounce * 0.065;

            switch (s.meleeAnimStyle) {
              case 'HAMMER_TR_TO_B': {
                if (t < 0.22) {
                  const k = easeOutCubic(t / 0.22);
                  offX = THREE.MathUtils.lerp(0, 0.32, k);
                  offY = THREE.MathUtils.lerp(0, 0.34, k);
                  offZ = THREE.MathUtils.lerp(0, 0.1, k);
                  rotX = THREE.MathUtils.lerp(0, 0.42, k);
                  rotY = THREE.MathUtils.lerp(0, -0.22, k);
                  rotZ = THREE.MathUtils.lerp(0, -0.65, k);
                  bladeRoll = THREE.MathUtils.lerp(0, 0.34, k);
                  s.cameraMeleePitch = 0.025 * k;
                  s.cameraMeleeRoll = -0.02 * k;
                } else if (t < 0.56) {
                  const k = easeInCubic((t - 0.22) / 0.34);
                  offX = THREE.MathUtils.lerp(0.32, -0.18, k);
                  offY = THREE.MathUtils.lerp(0.34, -0.34, k);
                  offZ = THREE.MathUtils.lerp(0.1, -0.3 + recoil, k);
                  rotX = THREE.MathUtils.lerp(0.42, -1.62 + recoil * 3, k);
                  rotY = THREE.MathUtils.lerp(-0.22, 0.26, k);
                  rotZ = THREE.MathUtils.lerp(-0.65, 0.34, k);
                  bladeRoll = 0.34;
                  s.cameraMeleePitch = THREE.MathUtils.lerp(0.025, -0.036, k);
                  s.cameraMeleeRoll = THREE.MathUtils.lerp(-0.02, 0.024, k);
                } else {
                  const k = easeInOutQuad((t - 0.56) / 0.44);
                  offX = THREE.MathUtils.lerp(-0.18, 0, k);
                  offY = THREE.MathUtils.lerp(-0.34, 0, k);
                  offZ = THREE.MathUtils.lerp(-0.3 + recoil, 0, k);
                  rotX = THREE.MathUtils.lerp(-1.62 + recoil * 3, 0, k);
                  rotY = THREE.MathUtils.lerp(0.26, 0, k);
                  rotZ = THREE.MathUtils.lerp(0.34, 0, k);
                  bladeRoll = THREE.MathUtils.lerp(0.34, 0, k);
                }
                break;
              }
              case 'HAMMER_TL_TO_B': {
                if (t < 0.22) {
                  const k = easeOutCubic(t / 0.22);
                  offX = THREE.MathUtils.lerp(0, -0.44, k);
                  offY = THREE.MathUtils.lerp(0, 0.34, k);
                  offZ = THREE.MathUtils.lerp(0, 0.1, k);
                  rotX = THREE.MathUtils.lerp(0, 0.42, k);
                  rotY = THREE.MathUtils.lerp(0, 0.26, k);
                  rotZ = THREE.MathUtils.lerp(0, 0.74, k);
                  bladeRoll = THREE.MathUtils.lerp(0, -0.34, k);
                  s.cameraMeleePitch = 0.025 * k;
                  s.cameraMeleeRoll = 0.022 * k;
                } else if (t < 0.56) {
                  const k = easeInCubic((t - 0.22) / 0.34);
                  offX = THREE.MathUtils.lerp(-0.44, 0.08, k);
                  offY = THREE.MathUtils.lerp(0.34, -0.34, k);
                  offZ = THREE.MathUtils.lerp(0.1, -0.3 + recoil, k);
                  rotX = THREE.MathUtils.lerp(0.42, -1.62 + recoil * 3, k);
                  rotY = THREE.MathUtils.lerp(0.26, -0.24, k);
                  rotZ = THREE.MathUtils.lerp(0.74, -0.28, k);
                  bladeRoll = -0.34;
                  s.cameraMeleePitch = THREE.MathUtils.lerp(0.025, -0.036, k);
                  s.cameraMeleeRoll = THREE.MathUtils.lerp(0.022, -0.024, k);
                } else {
                  const k = easeInOutQuad((t - 0.56) / 0.44);
                  offX = THREE.MathUtils.lerp(0.08, 0, k);
                  offY = THREE.MathUtils.lerp(-0.34, 0, k);
                  offZ = THREE.MathUtils.lerp(-0.3 + recoil, 0, k);
                  rotX = THREE.MathUtils.lerp(-1.62 + recoil * 3, 0, k);
                  rotY = THREE.MathUtils.lerp(-0.24, 0, k);
                  rotZ = THREE.MathUtils.lerp(-0.28, 0, k);
                  bladeRoll = THREE.MathUtils.lerp(-0.34, 0, k);
                }
                break;
              }
              case 'HAMMER_R_TO_L': {
                if (t < 0.22) {
                  const k = easeOutCubic(t / 0.22);
                  offX = THREE.MathUtils.lerp(0, 0.46, k);
                  offY = THREE.MathUtils.lerp(0, 0.16, k);
                  offZ = THREE.MathUtils.lerp(0, 0.12, k);
                  rotX = THREE.MathUtils.lerp(0, -0.45, k);
                  rotY = THREE.MathUtils.lerp(0, -0.78, k);
                  rotZ = THREE.MathUtils.lerp(0, -1.15, k);
                  bladeRoll = THREE.MathUtils.lerp(0, Math.PI * 0.48, k);
                  s.cameraMeleeYaw = -0.025 * k;
                  s.cameraMeleeRoll = -0.024 * k;
                } else if (t < 0.6) {
                  const k = easeInOutQuad((t - 0.22) / 0.38);
                  offX = THREE.MathUtils.lerp(0.46, -0.62, k);
                  offY = THREE.MathUtils.lerp(0.16, -0.06, k);
                  offZ = -0.28 * Math.sin(k * Math.PI) + recoil;
                  rotX = THREE.MathUtils.lerp(-0.45, -1.24, Math.min(1, k * 1.4));
                  rotY = THREE.MathUtils.lerp(-0.78, 1.15, k);
                  rotZ = THREE.MathUtils.lerp(-1.15, 0.92, k);
                  bladeRoll = Math.PI * 0.48;
                  s.cameraMeleeYaw = THREE.MathUtils.lerp(-0.025, 0.038, k);
                  s.cameraMeleeRoll = THREE.MathUtils.lerp(-0.024, 0.032, k);
                } else {
                  const k = easeInOutQuad((t - 0.6) / 0.4);
                  offX = THREE.MathUtils.lerp(-0.62, 0, k);
                  offY = THREE.MathUtils.lerp(-0.06, 0, k);
                  offZ = THREE.MathUtils.lerp(recoil, 0, k);
                  rotX = THREE.MathUtils.lerp(-1.24, 0, k);
                  rotY = THREE.MathUtils.lerp(1.15, 0, k);
                  rotZ = THREE.MathUtils.lerp(0.92, 0, k);
                  bladeRoll = THREE.MathUtils.lerp(Math.PI * 0.48, 0, k);
                }
                break;
              }
              case 'HAMMER_SPECIAL': {
                const chargeAmp = 0.72 + 0.28 * s.meleeStrikeChargePct;
                if (t < 0.42) {
                  const k = easeInCubic(t / 0.42);
                  offX = -0.08 * chargeAmp;
                  offY = THREE.MathUtils.lerp(0.34 * chargeAmp, -0.44 * chargeAmp, k);
                  offZ = THREE.MathUtils.lerp(0.12 * chargeAmp, -0.36 * chargeAmp + recoil, k);
                  rotX = THREE.MathUtils.lerp(0.58 * chargeAmp, -1.78, k);
                  rotZ = THREE.MathUtils.lerp(0.18 * chargeAmp, 0, k);
                  s.cameraMeleePitch = THREE.MathUtils.lerp(0.03, -0.055 * chargeAmp, k);
                  s.cameraMeleeFovOffset = THREE.MathUtils.lerp(-3.2, 2.4 * chargeAmp, k);
                } else {
                  const k = easeInOutQuad((t - 0.42) / 0.58);
                  offX = THREE.MathUtils.lerp(-0.08 * chargeAmp, 0, k);
                  offY = THREE.MathUtils.lerp(-0.44 * chargeAmp, 0, k);
                  offZ = THREE.MathUtils.lerp(-0.36 * chargeAmp + recoil, 0, k);
                  rotX = THREE.MathUtils.lerp(-1.78, 0, k);
                  rotZ = 0;
                }
                break;
              }
              case 'HALBERD_LUNGE': {
                if (t < 0.18) {
                  const k = easeOutCubic(t / 0.18);
                  offX = THREE.MathUtils.lerp(0, -0.04, k);
                  offY = THREE.MathUtils.lerp(0, 0.04, k);
                  offZ = THREE.MathUtils.lerp(0, 0.22, k);
                  rotX = THREE.MathUtils.lerp(0, -1.08, k);
                  s.cameraMeleePitch = 0.015 * k;
                } else if (t < 0.5) {
                  const k = easeOutCubic((t - 0.18) / 0.32);
                  offX = THREE.MathUtils.lerp(-0.04, -0.14, k);
                  offY = THREE.MathUtils.lerp(0.04, 0.06, k);
                  offZ = THREE.MathUtils.lerp(0.22, -0.66 + recoil, k);
                  rotX = THREE.MathUtils.lerp(-1.08, -1.26, k);
                  s.cameraMeleeFovOffset = -2.4 * k;
                  s.cameraMeleePitch = THREE.MathUtils.lerp(0.015, -0.018, k);
                } else {
                  const k = easeInOutQuad((t - 0.5) / 0.5);
                  offX = THREE.MathUtils.lerp(-0.14, 0, k);
                  offY = THREE.MathUtils.lerp(0.06, 0, k);
                  offZ = THREE.MathUtils.lerp(-0.66 + recoil, 0, k);
                  rotX = THREE.MathUtils.lerp(-1.26, 0, k);
                }
                break;
              }
              case 'HALBERD_BACK_CHOP': {
                if (t < 0.28) {
                  const k = easeOutCubic(t / 0.28);
                  offX = THREE.MathUtils.lerp(0, 0.16, k);
                  offY = THREE.MathUtils.lerp(0, 0.28, k);
                  offZ = THREE.MathUtils.lerp(0, 0.28, k);
                  rotX = THREE.MathUtils.lerp(0, 0.72, k);
                  rotZ = THREE.MathUtils.lerp(0, -0.18, k);
                  s.cameraMeleePitch = 0.028 * k;
                } else if (t < 0.62) {
                  const k = easeInCubic((t - 0.28) / 0.34);
                  offX = THREE.MathUtils.lerp(0.16, -0.1, k);
                  offY = THREE.MathUtils.lerp(0.28, -0.28, k);
                  offZ = THREE.MathUtils.lerp(0.28, -0.42 + recoil, k);
                  rotX = THREE.MathUtils.lerp(0.72, -1.68, k);
                  rotZ = THREE.MathUtils.lerp(-0.18, 0.12, k);
                  s.cameraMeleePitch = THREE.MathUtils.lerp(0.028, -0.042, k);
                  s.cameraMeleeFovOffset = 1.6 * k;
                } else {
                  const k = easeInOutQuad((t - 0.62) / 0.38);
                  offX = THREE.MathUtils.lerp(-0.1, 0, k);
                  offY = THREE.MathUtils.lerp(-0.28, 0, k);
                  offZ = THREE.MathUtils.lerp(-0.42 + recoil, 0, k);
                  rotX = THREE.MathUtils.lerp(-1.68, 0, k);
                  rotZ = THREE.MathUtils.lerp(0.12, 0, k);
                }
                break;
              }
              case 'HALBERD_DIAG_SWEEP': {
                if (t < 0.24) {
                  const k = easeOutCubic(t / 0.24);
                  offX = THREE.MathUtils.lerp(0, -0.52, k);
                  offY = THREE.MathUtils.lerp(0, 0.26, k);
                  offZ = THREE.MathUtils.lerp(0, 0.24, k);
                  rotX = THREE.MathUtils.lerp(0, 0.38, k);
                  rotY = THREE.MathUtils.lerp(0, 0.72, k);
                  rotZ = THREE.MathUtils.lerp(0, 1.04, k);
                  bladeRoll = THREE.MathUtils.lerp(0, -0.92, k);
                  s.cameraMeleeYaw = 0.03 * k;
                  s.cameraMeleeRoll = 0.03 * k;
                } else if (t < 0.62) {
                  const k = easeInOutQuad((t - 0.24) / 0.38);
                  offX = THREE.MathUtils.lerp(-0.52, 0.54, k);
                  offY = THREE.MathUtils.lerp(0.26, -0.24, k);
                  offZ = -0.32 * Math.sin(k * Math.PI) + recoil;
                  rotX = THREE.MathUtils.lerp(0.38, -1.32, Math.min(1, k * 1.2));
                  rotY = THREE.MathUtils.lerp(0.72, -1.04, k);
                  rotZ = THREE.MathUtils.lerp(1.04, -1.04, k);
                  bladeRoll = -0.92;
                  s.cameraMeleeYaw = THREE.MathUtils.lerp(0.03, -0.048, k);
                  s.cameraMeleeRoll = THREE.MathUtils.lerp(0.03, -0.038, k);
                  s.cameraMeleePitch = -0.025 * Math.sin(k * Math.PI);
                } else {
                  const k = easeInOutQuad((t - 0.62) / 0.38);
                  offX = THREE.MathUtils.lerp(0.54, 0, k);
                  offY = THREE.MathUtils.lerp(-0.24, 0, k);
                  offZ = THREE.MathUtils.lerp(recoil, 0, k);
                  rotX = THREE.MathUtils.lerp(-1.32, 0, k);
                  rotY = THREE.MathUtils.lerp(-1.04, 0, k);
                  rotZ = THREE.MathUtils.lerp(-1.04, 0, k);
                  bladeRoll = THREE.MathUtils.lerp(-0.92, 0, k);
                }
                break;
              }
              case 'HALBERD_SPEC_L_TO_R':
              case 'HALBERD_SPEC_R_TO_L': {
                const dir = s.meleeAnimStyle === 'HALBERD_SPEC_L_TO_R' ? 1 : -1;
                const chargeAmp = 0.78 + 0.22 * s.meleeStrikeChargePct;
                const targetRoll = -dir * Math.PI * 0.48;
                if (t < 0.2) {
                  const k = easeOutCubic(t / 0.2);
                  offX = THREE.MathUtils.lerp(-0.24 * dir, -0.54 * dir * chargeAmp, k);
                  offY = THREE.MathUtils.lerp(0.06, 0.08, k);
                  offZ = THREE.MathUtils.lerp(0.12, 0.18, k);
                  rotX = THREE.MathUtils.lerp(-0.62, -1.16, k);
                  rotY = THREE.MathUtils.lerp(0.65 * dir, 1.08 * dir, k);
                  rotZ = THREE.MathUtils.lerp(0.85 * dir, 1.15 * dir, k);
                  bladeRoll = THREE.MathUtils.lerp(targetRoll * 0.7, targetRoll, k);
                  s.cameraMeleeYaw = 0.032 * dir * k;
                  s.cameraMeleeRoll = 0.028 * dir * k;
                } else if (t < 0.6) {
                  const k = easeInOutQuad((t - 0.2) / 0.4);
                  offX = THREE.MathUtils.lerp(-0.54 * dir * chargeAmp, 0.58 * dir * chargeAmp, k);
                  offY = 0.02 - 0.05 * Math.sin(k * Math.PI);
                  offZ = -0.34 * Math.sin(k * Math.PI) + recoil;
                  rotX = -1.24;
                  rotY = THREE.MathUtils.lerp(1.08 * dir, -1.16 * dir, k);
                  rotZ = THREE.MathUtils.lerp(1.15 * dir, -1.08 * dir, k);
                  bladeRoll = targetRoll;
                  s.cameraMeleeYaw = THREE.MathUtils.lerp(0.032 * dir, -0.048 * dir, k);
                  s.cameraMeleeRoll = THREE.MathUtils.lerp(0.028 * dir, -0.034 * dir, k);
                  s.cameraMeleeFovOffset = 2.2 * Math.sin(k * Math.PI) * chargeAmp;
                } else {
                  const k = easeInOutQuad((t - 0.6) / 0.4);
                  offX = THREE.MathUtils.lerp(0.58 * dir * chargeAmp, 0, k);
                  offY = THREE.MathUtils.lerp(0.02, 0, k);
                  offZ = THREE.MathUtils.lerp(recoil, 0, k);
                  rotX = THREE.MathUtils.lerp(-1.24, 0, k);
                  rotY = THREE.MathUtils.lerp(-1.16 * dir, 0, k);
                  rotZ = THREE.MathUtils.lerp(-1.08 * dir, 0, k);
                  bladeRoll = THREE.MathUtils.lerp(targetRoll, 0, k);
                }
                break;
              }
              case 'SHOVE': {
                const bash = Math.sin(easeOutCubic(t) * Math.PI);
                offX = -0.22 * bash;
                offY = 0.09 * bash;
                offZ = -0.4 * bash + recoil;
                rotX = 0.2 * bash;
                rotY = 0.34 * bash;
                rotZ = 1.44 * bash;
                s.cameraMeleePitch = 0.022 * bash;
                s.cameraMeleeRoll = 0.024 * bash;
                break;
              }
            }

            if (t >= 1) {
              s.meleeAction = 'IDLE';
              s.meleeAnimPhase = 0;
              if (s.meleeStrikeIsShove) {
                s.meleeCooldownTimer = activeWeapon.melee.shoveCooldownSec;
              }
            }
          }

          weaponAnchor.rotation.order = 'YXZ';
          weaponAnchor.position.set(
            THREE.MathUtils.damp(weaponAnchor.position.x, baseRig.x + offX, 26, delta),
            THREE.MathUtils.damp(weaponAnchor.position.y, baseRig.y + offY, 26, delta),
            THREE.MathUtils.damp(weaponAnchor.position.z, baseRig.z + offZ, 26, delta)
          );
          weaponAnchor.rotation.set(rotX, rotY, rotZ);
          if (currentWeapon3D.bladeRollGroup) {
            currentWeapon3D.bladeRollGroup.rotation.y = bladeRoll;
          }
        } else {
          weaponAnchor.rotation.order = 'XYZ';
          const bobAmp = (s.isAds ? 0.0015 : 0.0072) * activeHeatSway;
          const bobX = Math.sin(s.swayPhase) * bobAmp;
          const bobY = Math.cos(s.swayPhase * 2.0) * bobAmp * 0.6;

          weaponAnchor.position.x = THREE.MathUtils.damp(
            weaponAnchor.position.x,
            baseRig.x + bobX,
            15,
            delta
          );
          weaponAnchor.position.y = THREE.MathUtils.damp(
            weaponAnchor.position.y,
            baseRig.y + bobY,
            15,
            delta
          );
          weaponAnchor.position.z = THREE.MathUtils.damp(
            weaponAnchor.position.z,
            baseRig.z + s.weaponKickZ,
            16,
            delta
          );
          weaponAnchor.rotation.x = s.weaponKickPitch;
          weaponAnchor.rotation.z =
            Math.sin(s.swayPhase) * (s.isAds ? 0.004 : 0.014 * 1.2) * activeHeatSway;
          weaponAnchor.rotation.y =
            Math.cos(s.swayPhase * 0.85) * (s.isAds ? 0.003 : 0.011 * 1.2) * activeHeatSway;
        }

        if (s.muzzleFlashTimer > 0) {
          s.muzzleFlashTimer -= delta;
          if (s.muzzleFlashTimer <= 0) {
            currentWeapon3D.muzzleFlash.visible = false;
          }
        }

        // Decay breakable door hit flash
        for (const d of [currentRoom.westDoor, currentRoom.eastDoor]) {
          if (d && !d.broken && d.flashTimer > 0) {
            d.flashTimer = Math.max(0, d.flashTimer - delta);
            if (d.flashTimer === 0) {
              d.panelMat.emissive.setHex(0x000000);
              d.panelMat.emissiveIntensity = 0;
            }
          }
        }

        const patrolNodes = getDronePatrolNodes(p.config.roomId, p.config.distanceM);
        const envBlockers = currentRoom.environmentHitMeshes.filter((m) => m.visible);

        // Advance & animate every enemy actor in the squad
        for (const actor of s.enemies) {
          const weakMat = actor.model.weakspotMesh.material as THREE.MeshStandardMaterial;
          weakMat.emissiveIntensity = actor.alive
            ? actor.staggerTimer > 0
              ? 2.2
              : actor.droneChargeTimer > 0
                ? 3.2
                : 1.1 + Math.sin(elapsed * 7 + actor.uid) * 0.5
            : 0.12;

          if (!actor.alive) {
            actor.model.root.rotation.x = THREE.MathUtils.damp(
              actor.model.root.rotation.x,
              -Math.PI * 0.48,
              7,
              delta
            );
            continue;
          }

          if (p.playerHp <= 0) continue;

          // Staggered State: stunned recoil stance (no face clutching)
          if (actor.staggerTimer > 0) {
            actor.staggerTimer = Math.max(0, actor.staggerTimer - delta);
            if (actor.staggerTimer === 0) {
              actor.staggerHp = actor.maxStaggerHp;
            }

            actor.vx = THREE.MathUtils.damp(actor.vx, 0, 12, delta);
            actor.model.leftLeg.rotation.x = THREE.MathUtils.damp(
              actor.model.leftLeg.rotation.x,
              0.14,
              10,
              delta
            );
            actor.model.rightLeg.rotation.x = THREE.MathUtils.damp(
              actor.model.rightLeg.rotation.x,
              -0.14,
              10,
              delta
            );
            actor.model.bodyGroup.position.y = THREE.MathUtils.damp(
              actor.model.bodyGroup.position.y,
              -0.05,
              10,
              delta
            );
            actor.model.bodyGroup.rotation.x = -0.14 + Math.sin(elapsed * 14 + actor.uid) * 0.03;
            actor.model.bodyGroup.rotation.y = Math.sin(elapsed * 9 + actor.uid) * 0.08;
            actor.model.bodyGroup.rotation.z = Math.sin(elapsed * 7 + actor.uid) * 0.045;

            actor.model.leftClawArm.rotation.x = THREE.MathUtils.damp(
              actor.model.leftClawArm.rotation.x,
              0.16,
              12,
              delta
            );
            actor.model.rightClawArm.rotation.x = THREE.MathUtils.damp(
              actor.model.rightClawArm.rotation.x,
              0.16,
              12,
              delta
            );
            actor.model.leftClawArm.rotation.z = THREE.MathUtils.damp(
              actor.model.leftClawArm.rotation.z,
              -0.22,
              12,
              delta
            );
            actor.model.rightClawArm.rotation.z = THREE.MathUtils.damp(
              actor.model.rightClawArm.rotation.z,
              0.22,
              12,
              delta
            );

            actor.model.root.position.set(actor.x, 0, actor.z);
            actor.model.root.rotation.x = 0;
            actor.model.root.lookAt(s.playerX, 0, s.playerZ);
            continue;
          }

          actor.model.bodyGroup.rotation.x = THREE.MathUtils.damp(
            actor.model.bodyGroup.rotation.x,
            0,
            10,
            delta
          );
          actor.model.bodyGroup.rotation.y = THREE.MathUtils.damp(
            actor.model.bodyGroup.rotation.y,
            0,
            10,
            delta
          );
          actor.model.bodyGroup.rotation.z = THREE.MathUtils.damp(
            actor.model.bodyGroup.rotation.z,
            0,
            10,
            delta
          );

          const collisionOpts = {
            isPlayer: false,
            westDoorBroken: currentRoom.westDoor?.broken ?? true,
            eastDoorBroken: currentRoom.eastDoor?.broken ?? true,
          };

          // Breakable Grey Door check for enemies spawning behind doors in Room 2
          const assignedDoor =
            actor.doorSide === 'west'
              ? currentRoom.westDoor
              : actor.doorSide === 'east'
                ? currentRoom.eastDoor
                : null;

          if (assignedDoor && !assignedDoor.broken) {
            const distToDoor = Math.hypot(
              actor.x - assignedDoor.breachOrigin.x,
              actor.z - assignedDoor.breachOrigin.z
            );
            if (distToDoor > 1.35) {
              const dirX = (assignedDoor.breachOrigin.x - actor.x) / distToDoor;
              const dirZ = (assignedDoor.breachOrigin.z - actor.z) / distToDoor;
              const spd = actor.profile.moveSpeedMps * 0.9;
              const resPos = resolveRoomCollision2D(
                actor.x + dirX * spd * delta,
                actor.z + dirZ * spd * delta,
                actor.x,
                actor.z,
                0.45 * actor.profile.scaleXZ,
                p.config.roomId,
                collisionOpts
              );
              actor.x = resPos.x;
              actor.z = resPos.z;
              actor.stridePhase += delta * spd * 1.8;
              actor.model.leftLeg.rotation.x = Math.sin(actor.stridePhase) * 0.45;
              actor.model.rightLeg.rotation.x = -Math.sin(actor.stridePhase) * 0.45;
            } else {
              // Bash the grey door down
              actor.doorBashCooldown -= delta;
              actor.model.leftClawArm.rotation.x = -Math.abs(Math.sin(elapsed * 9)) * 1.1;
              actor.model.rightClawArm.rotation.x = -Math.abs(Math.cos(elapsed * 9)) * 1.1;
              if (actor.doorBashCooldown <= 0) {
                actor.doorBashCooldown = 0.44;
                soundEngine.playHitArmor();
                damageDoor(assignedDoor, 45);
              }
            }
            actor.model.root.position.set(actor.x, 0, actor.z);
            actor.model.root.rotation.x = 0;
            actor.model.root.lookAt(
              assignedDoor.breachOrigin.x,
              0,
              assignedDoor.breachOrigin.z
            );
            continue;
          }

          // VANGUARD SHIELD DRONE: Rear ranged patrol & parabolic weakspot plasma bolts
          if (actor.profile.silhouette === 'drone') {
            let targetNode: { x: number; z: number } | null = null;
            if (actor.waypointIdx < actor.waypoints.length) {
              targetNode = actor.waypoints[actor.waypointIdx];
              const wd = Math.hypot(targetNode.x - actor.x, targetNode.z - actor.z);
              if (wd < 1.25) {
                actor.waypointIdx += 1;
              }
            } else {
              actor.dronePatrolTimer -= delta;
              if (!actor.dronePatrolTarget || actor.dronePatrolTimer <= 0) {
                const nextIdx = Math.floor(Math.random() * patrolNodes.length);
                actor.dronePatrolTarget = patrolNodes[nextIdx];
                actor.dronePatrolTimer = 2.4 + Math.random() * 1.6;
              }
              targetNode = actor.dronePatrolTarget;
            }

            if (targetNode) {
              const dx = targetNode.x - actor.x;
              const dz = targetNode.z - actor.z;
              const dist = Math.hypot(dx, dz);
              if (dist > 0.35) {
                const moveSpd = actor.profile.moveSpeedMps;
                const step = Math.min(dist, moveSpd * delta);
                const nextPos = resolveRoomCollision2D(
                  actor.x + (dx / dist) * step,
                  actor.z + (dz / dist) * step,
                  actor.x,
                  actor.z,
                  0.45 * actor.profile.scaleXZ,
                  p.config.roomId,
                  collisionOpts
                );
                actor.x = nextPos.x;
                actor.z = nextPos.z;
              }
            }

            // Hover bob
            actor.model.bodyGroup.position.y = Math.sin(elapsed * 3.8 + actor.uid) * 0.14;
            actor.model.leftLeg.rotation.x = 0;
            actor.model.rightLeg.rotation.x = 0;

            // Arcing shot from weakspot stabilizer lens (does NOT interrupt player rounds)
            if (actor.waypointIdx >= actor.waypoints.length) {
              if (actor.droneChargeTimer > 0) {
                actor.droneChargeTimer -= delta;
                if (actor.droneChargeTimer <= 0) {
                  const startPos = actor.model.weakspotMesh.getWorldPosition(_vec3A);
                  const targetPos = _vec3B.set(s.playerX, 1.5, s.playerZ);
                  const dirToPlayer = _vec3C.subVectors(targetPos, startPos);
                  const distToPlayer = dirToPlayer.length();
                  dirToPlayer.normalize();

                  // Verify clear line of sight (no wall/door blocking)
                  raycaster.set(startPos, dirToPlayer);
                  const losHits = raycaster.intersectObjects(envBlockers, false);
                  const blocked = losHits.length > 0 && losHits[0].distance < distToPlayer - 0.3;

                  if (!blocked) {
                    const flightT = THREE.MathUtils.clamp(distToPlayer / 24, 0.28, 1.35);
                    const gravity = 5.4;
                    const vx = (targetPos.x - startPos.x) / flightT;
                    const vz = (targetPos.z - startPos.z) / flightT;
                    const vy = (targetPos.y - startPos.y) / flightT + 0.5 * gravity * flightT;

                    const boltMat = new THREE.MeshStandardMaterial({
                      color: 0xff2a4b,
                      emissive: 0xff2a4b,
                      emissiveIntensity: 2.2,
                      roughness: 0.2,
                    });
                    const boltMesh = new THREE.Mesh(droneBoltGeo, boltMat);
                    boltMesh.position.copy(startPos);
                    scene.add(boltMesh);

                    s.droneProjectiles.push({
                      mesh: boltMesh,
                      vx,
                      vy,
                      vz,
                      gravity,
                      damage: actor.profile.clawDamage,
                      attackerName: actor.profile.name,
                      life: 3.0,
                    });
                    soundEngine.playDroneShoot();
                  }
                  actor.droneFireCooldown = 1.9 + Math.random() * 0.9;
                }
              } else {
                actor.droneFireCooldown -= delta;
                if (actor.droneFireCooldown <= 0) {
                  actor.droneChargeTimer = 0.28;
                }
              }
            }

            actor.model.root.position.set(actor.x, 0, actor.z);
            actor.model.root.rotation.x = 0;
            actor.model.root.lookAt(s.playerX, 0, s.playerZ);
            continue;
          }

          // GROUND / MELEE CHASSIS AI: Follow corridor waypoints if in Room 2, then close in on player
          if (actor.waypointIdx < actor.waypoints.length) {
            const wp = actor.waypoints[actor.waypointIdx];
            const dx = wp.x - actor.x;
            const dz = wp.z - actor.z;
            const distWp = Math.hypot(dx, dz);
            if (distWp < 1.25) {
              actor.waypointIdx += 1;
            } else {
              const spd = actor.profile.moveSpeedMps * 0.96;
              const resPos = resolveRoomCollision2D(
                actor.x + (dx / distWp) * spd * delta,
                actor.z + (dz / distWp) * spd * delta,
                actor.x,
                actor.z,
                0.48 * actor.profile.scaleXZ,
                p.config.roomId,
                collisionOpts
              );
              actor.x = resPos.x;
              actor.z = resPos.z;
            }

            actor.stridePhase += delta * actor.profile.moveSpeedMps * 1.85;
            actor.model.leftLeg.rotation.x = Math.sin(actor.stridePhase) * 0.52;
            actor.model.rightLeg.rotation.x = -Math.sin(actor.stridePhase) * 0.52;
            actor.model.bodyGroup.position.y = Math.abs(Math.sin(actor.stridePhase)) * 0.08;
            actor.model.leftClawArm.rotation.x = -Math.sin(actor.stridePhase) * 0.35;
            actor.model.rightClawArm.rotation.x = Math.sin(actor.stridePhase) * 0.35;

            actor.model.root.position.set(actor.x, 0, actor.z);
            actor.model.root.rotation.x = 0;
            actor.model.root.lookAt(wp.x, 0, wp.z);
            continue;
          }

          const toPlayerX = s.playerX - actor.x;
          const toPlayerZ = s.playerZ - actor.z;
          const distFromPlayer = Math.hypot(toPlayerX, toPlayerZ);

          // Swarm separation vector from neighboring alive ground enemies
          let sepX = 0;
          let sepZ = 0;
          for (const other of s.enemies) {
            if (other === actor || !other.alive || other.profile.silhouette === 'drone') continue;
            const sdx = actor.x - other.x;
            const sdz = actor.z - other.z;
            const sDist = Math.hypot(sdx, sdz);
            const minNeighborDist = 0.72 * (actor.profile.scaleXZ + other.profile.scaleXZ);
            if (sDist < minNeighborDist) {
              const push = (minNeighborDist - sDist) / minNeighborDist;
              if (sDist > 0.001) {
                sepX += (sdx / sDist) * push * 3.8;
                sepZ += (sdz / sDist) * push * 3.8;
              } else {
                sepX += Math.cos(actor.swarmAngle) * 2.2;
                sepZ += Math.sin(actor.swarmAngle) * 2.2;
              }
            }
          }

          // Enemy Lunge Windup & Burst Pounce
          if (actor.clawAnimType === 'NONE') {
            if (actor.lungeState === 'WINDUP') {
              actor.lungeTimer -= delta;
              actor.model.bodyGroup.position.y = THREE.MathUtils.damp(
                actor.model.bodyGroup.position.y,
                -0.16,
                18,
                delta
              );
              actor.model.bodyGroup.rotation.x = THREE.MathUtils.damp(
                actor.model.bodyGroup.rotation.x,
                0.24,
                16,
                delta
              );
              actor.model.leftClawArm.rotation.x = THREE.MathUtils.damp(
                actor.model.leftClawArm.rotation.x,
                0.65,
                16,
                delta
              );
              actor.model.rightClawArm.rotation.x = THREE.MathUtils.damp(
                actor.model.rightClawArm.rotation.x,
                0.65,
                16,
                delta
              );

              if (actor.lungeTimer <= 0) {
                actor.lungeState = 'LUNGE';
                actor.lungeTimer = 0.42;
                const lLen = Math.max(0.01, distFromPlayer);
                actor.lungeDirX = toPlayerX / lLen;
                actor.lungeDirZ = toPlayerZ / lLen;
              }
              actor.model.root.position.set(actor.x, 0, actor.z);
              actor.model.root.rotation.x = 0;
              actor.model.root.lookAt(s.playerX, 0, s.playerZ);
              continue;
            } else if (actor.lungeState === 'LUNGE') {
              actor.lungeTimer -= delta;
              const baseSpd = actor.profile.moveSpeedMps;
              const lungeSpeed = actor.profile.maxSpeedMps
                ? actor.profile.maxSpeedMps
                : Math.min(13.0, baseSpd * 1.95);

              // Blend locked lunge vector lightly toward live player position
              const liveLen = Math.max(0.01, distFromPlayer);
              const steerX = actor.lungeDirX * 0.72 + (toPlayerX / liveLen) * 0.28;
              const steerZ = actor.lungeDirZ * 0.72 + (toPlayerZ / liveLen) * 0.28;
              const steerLen = Math.max(0.01, Math.hypot(steerX, steerZ));

              const rawNextX = actor.x + (steerX / steerLen) * lungeSpeed * delta + sepX * 0.4 * delta;
              const rawNextZ = actor.z + (steerZ / steerLen) * lungeSpeed * delta + sepZ * 0.4 * delta;
              const resolved = resolveRoomCollision2D(
                rawNextX,
                rawNextZ,
                actor.x,
                actor.z,
                0.48 * actor.profile.scaleXZ,
                p.config.roomId,
                collisionOpts
              );
              actor.x = resolved.x;
              actor.z = resolved.z;

              actor.model.bodyGroup.position.y = Math.sin((actor.lungeTimer / 0.42) * Math.PI) * 0.24;
              actor.model.bodyGroup.rotation.x = 0.34;
              actor.model.leftClawArm.rotation.x = -1.25;
              actor.model.rightClawArm.rotation.x = -1.25;
              actor.stridePhase += delta * lungeSpeed * 2.1;
              actor.model.leftLeg.rotation.x = Math.sin(actor.stridePhase) * 0.65;
              actor.model.rightLeg.rotation.x = -Math.sin(actor.stridePhase) * 0.65;

              const postDist = Math.hypot(s.playerX - actor.x, s.playerZ - actor.z);
              if (actor.lungeTimer <= 0 || postDist <= actor.meleeDist + 0.25) {
                actor.lungeState = 'NONE';
                actor.lungeCooldown = 3.0 + Math.random() * 2.4;
                if (postDist <= actor.meleeDist + 0.35) {
                  actor.attackCooldown = 0;
                }
              }

              actor.model.root.position.set(actor.x, 0, actor.z);
              actor.model.root.rotation.x = 0;
              actor.model.root.lookAt(s.playerX, 0, s.playerZ);
              continue;
            }
          }

          if (distFromPlayer > actor.meleeDist) {
            if (actor.clawAnimType === 'NONE') {
              actor.lungeCooldown -= delta;
              if (
                actor.lungeCooldown <= 0 &&
                distFromPlayer > actor.meleeDist + 0.85 &&
                distFromPlayer < 11.5
              ) {
                actor.lungeState = 'WINDUP';
                actor.lungeTimer = 0.26;
                actor.model.root.position.set(actor.x, 0, actor.z);
                actor.model.root.lookAt(s.playerX, 0, s.playerZ);
                continue;
              }
            }

            // Swarm encircle target within 9.5m so horde fans out and surrounds player
            let aimTargetX = s.playerX;
            let aimTargetZ = s.playerZ;
            if (distFromPlayer < 9.5) {
              const surroundR = Math.max(1.5, actor.meleeDist * 0.82);
              const surroundBlend = THREE.MathUtils.clamp((9.5 - distFromPlayer) / 5.5, 0, 1);
              aimTargetX += Math.cos(actor.swarmAngle) * surroundR * surroundBlend;
              aimTargetZ += Math.sin(actor.swarmAngle) * surroundR * surroundBlend;
            }

            const moveVecX = aimTargetX - actor.x;
            const moveVecZ = aimTargetZ - actor.z;
            const moveVecLen = Math.max(0.01, Math.hypot(moveVecX, moveVecZ));
            const dirX = moveVecX / moveVecLen;
            const dirZ = moveVecZ / moveVecLen;
            const perpX = -dirZ;
            const perpZ = dirX;

            const topMobility = actor.profile.maxSpeedMps ?? actor.profile.moveSpeedMps * 1.15;
            const approachSpeed = actor.isChargingStraight
              ? topMobility
              : actor.profile.moveSpeedMps * (distFromPlayer < 7 ? 1.04 : 0.96);
            const forwardStep = Math.min(distFromPlayer - actor.meleeDist * 0.72, approachSpeed * delta);

            let latVel = 0;
            const pattern = p.config.approachPattern;
            if (pattern === 'STRAIGHT_CHARGE') {
              actor.isChargingStraight = true;
            } else {
              actor.weavePhaseBreakTimer -= delta;
              if (actor.weavePhaseBreakTimer <= 0) {
                if (pattern === 'ADAPTIVE' && Math.random() < 0.42) {
                  actor.isChargingStraight = true;
                  actor.weavePhaseBreakTimer = 0.75 + Math.random() * 0.65;
                } else {
                  actor.isChargingStraight = false;
                  actor.weaveDirection = -actor.weaveDirection;
                  actor.weavePhaseBreakTimer = 0.42 + Math.random() * 0.85;
                }
              }

              if (!actor.isChargingStraight) {
                const targetLat = actor.weaveDirection * actor.profile.moveSpeedMps * 0.65;
                actor.vx = THREE.MathUtils.damp(actor.vx, targetLat, 9, delta);
                latVel = actor.vx;
              } else {
                actor.vx = THREE.MathUtils.damp(actor.vx, 0, 9, delta);
              }
            }

            const rawNextX =
              actor.x + dirX * Math.max(0, forwardStep) + (perpX * latVel + sepX) * delta;
            const rawNextZ =
              actor.z + dirZ * Math.max(0, forwardStep) + (perpZ * latVel + sepZ) * delta;
            const resolved = resolveRoomCollision2D(
              rawNextX,
              rawNextZ,
              actor.x,
              actor.z,
              0.48 * actor.profile.scaleXZ,
              p.config.roomId,
              collisionOpts
            );
            actor.x = resolved.x;
            actor.z = resolved.z;

            actor.stridePhase += delta * approachSpeed * 1.9;
            actor.model.leftLeg.rotation.x = Math.sin(actor.stridePhase) * 0.52;
            actor.model.rightLeg.rotation.x = -Math.sin(actor.stridePhase) * 0.52;
            actor.model.bodyGroup.position.y = Math.abs(Math.sin(actor.stridePhase)) * 0.08;
            actor.model.leftClawArm.rotation.x = THREE.MathUtils.damp(
              actor.model.leftClawArm.rotation.x,
              -Math.sin(actor.stridePhase) * 0.35,
              14,
              delta
            );
            actor.model.rightClawArm.rotation.x = THREE.MathUtils.damp(
              actor.model.rightClawArm.rotation.x,
              Math.sin(actor.stridePhase) * 0.35,
              14,
              delta
            );
            actor.model.leftClawArm.rotation.z = THREE.MathUtils.damp(
              actor.model.leftClawArm.rotation.z,
              0,
              14,
              delta
            );
            actor.model.rightClawArm.rotation.z = THREE.MathUtils.damp(
              actor.model.rightClawArm.rotation.z,
              0,
              14,
              delta
            );
            actor.model.root.rotation.z = THREE.MathUtils.damp(
              actor.model.root.rotation.z,
              -actor.vx * 0.025,
              8,
              delta
            );
          } else {
            // In Melee Claw Range (swarm separation gently keeps flanks spread)
            if (sepX !== 0 || sepZ !== 0) {
              const sepPos = resolveRoomCollision2D(
                actor.x + sepX * 0.35 * delta,
                actor.z + sepZ * 0.35 * delta,
                actor.x,
                actor.z,
                0.48 * actor.profile.scaleXZ,
                p.config.roomId,
                collisionOpts
              );
              actor.x = sepPos.x;
              actor.z = sepPos.z;
            }

            actor.model.leftLeg.rotation.x = THREE.MathUtils.damp(
              actor.model.leftLeg.rotation.x,
              0,
              10,
              delta
            );
            actor.model.rightLeg.rotation.x = THREE.MathUtils.damp(
              actor.model.rightLeg.rotation.x,
              0,
              10,
              delta
            );
            actor.model.bodyGroup.position.y = THREE.MathUtils.damp(
              actor.model.bodyGroup.position.y,
              0,
              10,
              delta
            );

            const atkMult = actor.profile.attackSpeedMult;
            const specMult = actor.profile.specialAttackSpeedMult;

            if (actor.clawAnimType === 'NONE') {
              actor.model.leftClawArm.rotation.x = THREE.MathUtils.damp(
                actor.model.leftClawArm.rotation.x,
                0,
                12,
                delta
              );
              actor.model.rightClawArm.rotation.x = THREE.MathUtils.damp(
                actor.model.rightClawArm.rotation.x,
                0,
                12,
                delta
              );
              actor.model.leftClawArm.rotation.z = THREE.MathUtils.damp(
                actor.model.leftClawArm.rotation.z,
                0,
                12,
                delta
              );
              actor.model.rightClawArm.rotation.z = THREE.MathUtils.damp(
                actor.model.rightClawArm.rotation.z,
                0,
                12,
                delta
              );

              actor.attackCooldown -= delta;
              if (actor.attackCooldown <= 0) {
                actor.attackCount += 1;
                if (actor.attackCount % 3 === 0) {
                  actor.clawAnimType = 'DUAL_WINDUP';
                  actor.clawAnimPhase = 0;
                  actor.dualStrikeExecuted = false;
                } else {
                  actor.clawAnimType = actor.attackCount % 2 === 0 ? 'LEFT' : 'RIGHT';
                  actor.clawAnimPhase = 0;
                  actor.singleStrikeExecuted = false;
                  soundEngine.playEnemyAttack(false);
                }
              }
            } else if (actor.clawAnimType === 'LEFT' || actor.clawAnimType === 'RIGHT') {
              actor.clawAnimPhase += delta * 2.6 * atkMult;
              const swing = Math.sin(Math.min(1, actor.clawAnimPhase) * Math.PI);
              const arm =
                actor.clawAnimType === 'LEFT' ? actor.model.leftClawArm : actor.model.rightClawArm;
              arm.rotation.x = -swing * 1.45;
              arm.rotation.z = (actor.clawAnimType === 'LEFT' ? -1 : 1) * swing * 0.35;

              if (actor.clawAnimPhase >= 0.45 && !actor.singleStrikeExecuted) {
                actor.singleStrikeExecuted = true;
                s.cameraShake = Math.max(s.cameraShake, 0.55);
                s.playerHitSlowTimer = Math.max(s.playerHitSlowTimer, 0.55);
                setDamageFlashAlpha(0.45);
                p.onEnemyClawAttack(false, actor.profile.clawDamage, actor.profile.name);
              }
              if (actor.clawAnimPhase >= 1.0) {
                arm.rotation.set(0, 0, 0);
                actor.clawAnimType = 'NONE';
                actor.attackCooldown = 1.25 / atkMult;
              }
            } else if (actor.clawAnimType === 'DUAL_WINDUP') {
              actor.clawAnimPhase += delta * 1.65 * specMult;
              const raise = Math.min(1, actor.clawAnimPhase);
              actor.model.leftClawArm.rotation.x = -raise * 1.35;
              actor.model.rightClawArm.rotation.x = -raise * 1.35;
              actor.model.leftClawArm.rotation.z = raise * 0.42;
              actor.model.rightClawArm.rotation.z = -raise * 0.42;
              if (actor.clawAnimPhase >= 1.0) {
                actor.clawAnimType = 'DUAL_STRIKE';
                actor.clawAnimPhase = 0;
                soundEngine.playEnemyAttack(true);
              }
            } else if (actor.clawAnimType === 'DUAL_STRIKE') {
              actor.clawAnimPhase += delta * 3.8 * specMult;
              const slam = Math.min(1, actor.clawAnimPhase);
              actor.model.leftClawArm.rotation.x = -1.35 + slam * 2.1;
              actor.model.rightClawArm.rotation.x = -1.35 + slam * 2.1;
              actor.model.leftClawArm.rotation.z = (1 - slam) * 0.42;
              actor.model.rightClawArm.rotation.z = -(1 - slam) * 0.42;

              if (actor.clawAnimPhase >= 0.35 && !actor.dualStrikeExecuted) {
                actor.dualStrikeExecuted = true;
                s.cameraShake = Math.max(s.cameraShake, 1.25);
                s.playerHitSlowTimer = Math.max(s.playerHitSlowTimer, 0.85);
                setDamageFlashAlpha(0.75);
                p.onEnemyClawAttack(true, actor.profile.dualClawDamage, actor.profile.name);
              }
              if (actor.clawAnimPhase >= 1.0) {
                actor.model.leftClawArm.rotation.set(0, 0, 0);
                actor.model.rightClawArm.rotation.set(0, 0, 0);
                actor.clawAnimType = 'NONE';
                actor.attackCooldown = 1.55 / specMult;
              }
            }
          }

          actor.model.root.position.set(actor.x, 0, actor.z);
          actor.model.root.rotation.x = 0;
          actor.model.root.lookAt(s.playerX, 0, s.playerZ);
        }

        // Advance Drone Arcing Projectiles (non-interrupting to player rounds)
        for (let i = s.droneProjectiles.length - 1; i >= 0; i--) {
          const proj = s.droneProjectiles[i];
          proj.life -= delta;
          proj.vy -= proj.gravity * delta;
          proj.mesh.position.x += proj.vx * delta;
          proj.mesh.position.y += proj.vy * delta;
          proj.mesh.position.z += proj.vz * delta;

          let remove = proj.life <= 0 || proj.mesh.position.y <= 0.05;

          if (
            !remove &&
            p.config.roomId === 'double_flank_02' &&
            !isPointInPolygon2D(proj.mesh.position.x, proj.mesh.position.z, DOUBLE_FLANK_POLYGON)
          ) {
            remove = true;
          }

          if (!remove && p.playerHp > 0) {
            const dx = proj.mesh.position.x - s.playerX;
            const dy = proj.mesh.position.y - 1.35;
            const dz = proj.mesh.position.z - s.playerZ;
            if (dx * dx + dy * dy + dz * dz <= 0.42) {
              remove = true;
              setDamageFlashAlpha((prev) => Math.max(prev, 0.24));
              p.onEnemyDroneShot(proj.damage, proj.attackerName);
            }
          }

          if (remove) {
            scene.remove(proj.mesh);
            (proj.mesh.material as THREE.Material).dispose();
            s.droneProjectiles.splice(i, 1);
          }
        }

        // Advance Door Debris Shards
        for (let i = s.doorDebris.length - 1; i >= 0; i--) {
          const d = s.doorDebris[i];
          d.life -= delta;
          d.vy -= 14 * delta;
          d.mesh.position.x += d.vx * delta;
          d.mesh.position.y += d.vy * delta;
          d.mesh.position.z += d.vz * delta;
          d.mesh.rotation.x += d.rx * delta;
          d.mesh.rotation.y += d.ry * delta;
          if (d.mesh.position.y < 0.12) {
            d.mesh.position.y = 0.12;
            d.vy = Math.abs(d.vy) * 0.25;
            d.vx *= 0.6;
            d.vz *= 0.6;
          }
          if (d.life <= 0) {
            scene.remove(d.mesh);
            s.doorDebris.splice(i, 1);
          }
        }

        // Update tracers
        for (let i = s.tracers.length - 1; i >= 0; i--) {
          const t = s.tracers[i];
          t.life -= delta * 9.5;
          (t.line.material as THREE.LineBasicMaterial).opacity = Math.max(0, t.life);
          if (t.life <= 0) {
            scene.remove(t.line);
            t.line.geometry.dispose();
            (t.line.material as THREE.Material).dispose();
            s.tracers.splice(i, 1);
          }
        }
      }

      // Throttled HUD sync (~15Hz)
      hudSyncAcc += rawDelta;
      if (hudSyncAcc >= 0.065) {
        hudSyncAcc = 0;

        let aliveCount = 0;
        let nearestAlive: EnemyActor | null = null;
        let nearestDistSq = Infinity;
        const aliveHitMeshes: THREE.Mesh[] = [];
        for (const actor of s.enemies) {
          if (actor.alive) {
            aliveCount += 1;
            aliveHitMeshes.push(...actor.model.hitMeshes);
            const dSq =
              (actor.x - s.playerX) * (actor.x - s.playerX) +
              (actor.z - s.playerZ) * (actor.z - s.playerZ);
            if (dSq < nearestDistSq) {
              nearestDistSq = dSq;
              nearestAlive = actor;
            }
          }
        }

        raycaster.setFromCamera(_rayCenter, camera);
        const hoverHits = raycaster.intersectObjects(aliveHitMeshes, false);

        let focusActor = nearestAlive;
        if (hoverHits.length > 0) {
          setHoveredZone((hoverHits[0].object.userData.hitZone as HitZoneId) ?? null);
          const idx = hoverHits[0].object.userData.enemyIdx as number;
          const found = s.enemies.find((e) => e.uid === idx && e.alive);
          if (found) focusActor = found;
        } else {
          setHoveredZone(null);
        }

        const displayActor = focusActor ?? s.enemies[0];
        const pendingCount = s.pendingSpawns.length;
        const totalWaveCount = Math.max(1, s.totalSpawnedThisWave);

        if (displayActor) {
          const dist = Math.max(
            1,
            Math.round(Math.hypot(displayActor.x - s.playerX, displayActor.z - s.playerZ))
          );
          setLiveDistanceM(dist);
          setFocusedHud({
            name: displayActor.profile.name,
            code: displayActor.profile.code,
            hp: displayActor.hp,
            maxHp: displayActor.maxHp,
            staggerHp: displayActor.staggerHp,
            maxStaggerHp: displayActor.maxStaggerHp,
            staggerRemainingSec: displayActor.staggerTimer,
            aliveCount: aliveCount + pendingCount,
            pendingCount,
            totalCount: totalWaveCount,
            stateLabel:
              aliveCount + pendingCount === 0
                ? 'SQUAD ELIMINATED'
                : displayActor.staggerTimer > 0
                  ? `STAGGERED (${displayActor.staggerTimer.toFixed(1)}s · ${displayActor.profile.staggerDamageMultiplier.toFixed(1)}x DMG)`
                  : displayActor.profile.silhouette === 'drone'
                    ? 'REAR OVERWATCH FIRE'
                    : dist <= displayActor.meleeDist + 0.3
                      ? 'CLOSE QUARTERS'
                      : displayActor.isChargingStraight
                        ? 'STRAIGHT CHARGE'
                        : 'FLANK ADVANCE',
          });
        }

        if (isMeleeWeapon && activeWeapon.melee) {
          const prog =
            s.meleeAction === 'CHARGING' && s.meleeChargeSec >= 0.14
              ? Math.min(1, s.meleeChargeSec / Math.max(0.1, activeWeapon.melee.specialChargeSec))
              : 0;
          setMeleeChargeUi({
            progress: prog,
            ready: prog >= 1,
            chainReady:
              activeWeapon.melee.specialChainAltSweep && s.halberdSpecialChainTimer > 0,
            comboStep: s.meleeComboIdx + 1,
          });
        } else {
          setMeleeChargeUi({ progress: 0, ready: false, chainReady: false, comboStep: 0 });
        }

        setNextWaveCountdownSec(
          s.nextWaveTimerSec !== null ? Math.max(0, Math.round(s.nextWaveTimerSec * 10) / 10) : null
        );
        setDamageFlashAlpha((prev) => Math.max(0, prev - 0.12));
        setHitMarker((prev) => (prev && performance.now() - prev.createdAt > 220 ? null : prev));
        setFloatingHits((prev) => prev.filter((h) => performance.now() - h.createdAt < 680));
      }

      renderer.render(scene, camera);

      if (isSoftwareGl) {
        afterDraw(tick);
      } else {
        frameId = requestAnimationFrame(tick);
      }
    };

    if (isSoftwareGl) {
      afterDraw(tick);
    } else {
      frameId = requestAnimationFrame(tick);
    }

    return () => {
      isDisposed = true;
      cancelAnimationFrame(frameId);
      clearTimeout(frameId);
      resizeObserver.disconnect();
      dom.removeEventListener('mouseenter', handleMouseEnter);
      dom.removeEventListener('mouseleave', handleMouseLeave);
      dom.removeEventListener('mousemove', handleMouseMove);
      dom.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('mouseup', handleMouseUp);
      dom.removeEventListener('contextmenu', handleContextMenu);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleWindowBlur);
      document.removeEventListener('pointerlockchange', handlePointerLockChange);

      for (const actor of simRef.current.enemies) {
        disposeObject3D(actor.model.root);
      }
      clearDynamicProjectiles();
      for (const d of simRef.current.doorDebris) {
        scene.remove(d.mesh);
      }
      droneBoltGeo.dispose();
      debrisGeo.dispose();
      debrisMat.dispose();
      disposeObject3D(currentWeapon3D.root);
      currentRoom.dispose();
      renderer.dispose();
      if (container.contains(dom)) {
        container.removeChild(dom);
      }
    };
  }, []);

  const weapon = getWeaponById(config.weaponId, weapons);
  const isMelee = weapon.weaponClass === 'MELEE' && !!weapon.melee;

  const liveFalloffFactor = computeRangeFalloff(weapon, liveDistanceM);
  const liveFalloffPct = Math.round(liveFalloffFactor * 100);

  const hpPct = Math.max(0, Math.min(100, (focusedHud.hp / Math.max(1, focusedHud.maxHp)) * 100));
  const staggerPct = Math.max(
    0,
    Math.min(100, (focusedHud.staggerHp / Math.max(1, focusedHud.maxStaggerHp)) * 100)
  );
  const playerHpPct = Math.max(0, Math.min(100, (playerHp / maxPlayerHp) * 100));

  const regenCapHp = Math.round(maxPlayerHp * 0.4);
  const isOutOfCombat = outOfCombatSec >= outOfCombatWindowSec;
  const isRegenerating = isOutOfCombat && playerHp > 0 && playerHp < regenCapHp;
  const oocCountdown = Math.max(0, outOfCombatWindowSec - outOfCombatSec);
  const hideViewportCursor = !cursorShown && !isPaused && isMouseInViewport;

  return (
    <section className="flex flex-col gap-3">
      {/* 3D WebGL Simulation Viewport */}
      <div
        ref={viewportRef}
        className={`relative bg-[#0a0d12] border border-[#1e2638] overflow-hidden aspect-[16/10] lg:min-h-[470px] select-none ${
          hideViewportCursor ? 'cursor-none' : 'cursor-default'
        }`}
      >
        <div
          ref={mountRef}
          className={`absolute inset-0 w-full h-full ${
            hideViewportCursor ? 'cursor-none' : 'cursor-crosshair'
          }`}
        />

        {webglError && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0a0d12] p-6 text-center font-mono text-xs text-[#ff2a4b]">
            {webglError}
          </div>
        )}

        {damageFlashAlpha > 0.01 && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 border-4 border-[#ff2a4b] transition-opacity duration-75"
            style={{
              background: `radial-gradient(circle, transparent 45%, rgba(255, 42, 75, ${damageFlashAlpha * 0.45}) 100%)`,
            }}
          />
        )}

        <span aria-hidden="true" className="pointer-events-none absolute top-2 left-2 w-4 h-4 border-t-2 border-l-2 border-[#ffb300]" />
        <span aria-hidden="true" className="pointer-events-none absolute top-2 right-2 w-4 h-4 border-t-2 border-r-2 border-[#ffb300]" />
        <span aria-hidden="true" className="pointer-events-none absolute bottom-2 left-2 w-4 h-4 border-b-2 border-l-2 border-[#ffb300]" />
        <span aria-hidden="true" className="pointer-events-none absolute bottom-2 right-2 w-4 h-4 border-b-2 border-r-2 border-[#ffb300]" />

        {/* Center Reticle */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
        >
          <div
            className={`relative transition-all duration-100 ${
              isMelee
                ? 'w-12 h-12'
                : isAds
                  ? 'w-7 h-7'
                  : weapon.pellets > 1
                    ? 'w-16 h-16'
                    : 'w-11 h-11'
            }`}
          >
            <span
              className={`absolute top-1/2 left-0 w-2.5 h-[1.5px] -translate-y-1/2 ${
                hoveredZone === 'weakspot' ? 'bg-[#ff2a4b]' : 'bg-[#00f0ff]'
              }`}
            />
            <span
              className={`absolute top-1/2 right-0 w-2.5 h-[1.5px] -translate-y-1/2 ${
                hoveredZone === 'weakspot' ? 'bg-[#ff2a4b]' : 'bg-[#00f0ff]'
              }`}
            />
            <span
              className={`absolute left-1/2 top-0 h-2.5 w-[1.5px] -translate-x-1/2 ${
                hoveredZone === 'weakspot' ? 'bg-[#ff2a4b]' : 'bg-[#00f0ff]'
              }`}
            />
            <span
              className={`absolute left-1/2 bottom-0 h-2.5 w-[1.5px] -translate-x-1/2 ${
                hoveredZone === 'weakspot' ? 'bg-[#ff2a4b]' : 'bg-[#00f0ff]'
              }`}
            />
            <span
              className={`absolute left-1/2 top-1/2 w-1 h-1 -translate-x-1/2 -translate-y-1/2 ${
                hoveredZone === 'weakspot'
                  ? 'bg-[#ff2a4b]'
                  : hoveredZone
                    ? 'bg-[#ffb300]'
                    : 'bg-[#00f0ff]'
              }`}
            />
          </div>
        </div>

        {/* Melee Special Charge Bar below reticle */}
        {isMelee && (meleeChargeUi.progress > 0 || meleeChargeUi.chainReady) && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute left-1/2 top-[calc(50%+36px)] -translate-x-1/2 z-20 flex flex-col items-center gap-1"
          >
            {meleeChargeUi.progress > 0 && (
              <div className="w-28 bg-[#0a0d12]/90 border border-[#232d42] p-0.5">
                <div
                  className={`h-1.5 transition-all duration-75 ${
                    meleeChargeUi.ready ? 'bg-[#ffd000]' : 'bg-[#00f0ff]'
                  }`}
                  style={{ width: `${Math.round(meleeChargeUi.progress * 100)}%` }}
                />
              </div>
            )}
            <span
              className={`font-mono text-[10px] font-bold tracking-[0.08em] uppercase ${
                meleeChargeUi.ready
                  ? 'text-[#ffd000]'
                  : meleeChargeUi.chainReady
                    ? 'text-[#00f0ff]'
                    : 'text-[#e1e2ea]'
              }`}
            >
              {meleeChargeUi.ready
                ? 'SPECIAL READY 100% — RELEASE LMB'
                : meleeChargeUi.progress > 0
                  ? `SPECIAL CHARGE ${Math.round(meleeChargeUi.progress * 100)}% — RELEASE TO STRIKE`
                  : 'CHAIN READY: SWEEP R→L'}
            </span>
          </div>
        )}

        {/* Hit Marker Overlay */}
        {hitMarker && (
          <div
            key={hitMarker.id}
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 flex items-center justify-center z-20"
          >
            <svg
              viewBox="0 0 44 44"
              className="w-11 h-11 animate-hitmarker"
              style={{
                filter: hitMarker.isWeakspot
                  ? 'drop-shadow(0 0 7px rgba(255, 208, 0, 0.9))'
                  : 'drop-shadow(0 0 6px rgba(255, 42, 75, 0.85))',
              }}
            >
              <g
                stroke={hitMarker.isWeakspot ? '#ffd000' : '#ff2a4b'}
                strokeWidth={hitMarker.isWeakspot ? 2.6 : 2.2}
                strokeLinecap="square"
              >
                <line x1="7" y1="7" x2="16" y2="16" />
                <line x1="37" y1="7" x2="28" y2="16" />
                <line x1="7" y1="37" x2="16" y2="28" />
                <line x1="37" y1="37" x2="28" y2="28" />
              </g>
              {hitMarker.isWeakspot && (
                <g stroke="#fff4b8" strokeWidth="1.4" strokeLinecap="square">
                  <line x1="3" y1="3" x2="7.5" y2="7.5" />
                  <line x1="41" y1="3" x2="36.5" y2="7.5" />
                  <line x1="3" y1="41" x2="7.5" y2="36.5" />
                  <line x1="41" y1="41" x2="36.5" y2="36.5" />
                </g>
              )}
            </svg>
          </div>
        )}

        {/* Damage Pop-up Anchored Directly Beside the Hit Marker */}
        <div className="pointer-events-none absolute inset-0 overflow-hidden z-20">
          {floatingHits.map((hit) => (
            <div
              key={hit.id}
              className="absolute animate-hit-popup font-mono text-xs font-bold tabular-nums tracking-[0.04em] whitespace-nowrap flex items-center gap-1.5"
              style={{
                left: `calc(50% + ${26 + hit.offsetX}px)`,
                top: `calc(50% + ${hit.offsetY}px)`,
                color: hit.color,
                textShadow: hit.isWeakspot
                  ? '0 0 8px rgba(255, 208, 0, 0.65), 0 1px 2px rgba(0, 0, 0, 0.95)'
                  : '0 0 6px rgba(255, 42, 75, 0.55), 0 1px 2px rgba(0, 0, 0, 0.95)',
              }}
            >
              <span>{hit.text}</span>
              {hit.isKill && (
                <span className="px-1 py-[1px] bg-[#20df78]/20 border border-[#20df78] text-[9px] text-[#20df78]">
                  ELIMINATED
                </span>
              )}
            </div>
          ))}
        </div>

        {/* Top HUD Strip */}
        <div className="relative z-10 px-4 pt-3 flex flex-wrap items-start justify-between gap-2 pointer-events-none">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] tracking-[0.08em] uppercase bg-[#0a0d12]/88 px-2.5 py-1 border border-[#1e2638]">
              <span className="text-[#00f0ff] font-bold">WAVE {waveNumber}</span>
              <span className="text-[#8c9bb5]">·</span>
              <span className="text-[#ffb300] font-semibold">
                SQUAD {focusedHud.aliveCount}/{focusedHud.totalCount}
              </span>
              {focusedHud.pendingCount > 0 && (
                <span className="text-[#ff2a4b] text-[10px]">
                  (+{focusedHud.pendingCount} STAGING)
                </span>
              )}
              <span className="text-[#8c9bb5]">·</span>
              <span className="text-[#e1e2ea]">{focusedHud.name}</span>
              <span className="text-[#8c9bb5]">·</span>
              <span className="text-[#00f0ff] tabular-nums">{liveDistanceM}M</span>
            </div>

            <div className="w-56 sm:w-64 space-y-1.5 bg-[#0a0d12]/88 p-2 border border-[#1e2638]">
              <div className="space-y-0.5">
                <div className="flex justify-between font-mono text-[10px] tabular-nums">
                  <span className={focusedHud.aliveCount > 0 ? 'text-[#ff2a4b]' : 'text-[#20df78]'}>
                    {focusedHud.aliveCount > 0 ? 'TARGET HULL' : 'WAVE CLEARED'}
                  </span>
                  <span className="text-[#e1e2ea]">
                    {focusedHud.hp} / {focusedHud.maxHp}
                  </span>
                </div>
                <div className="h-2 w-full bg-[#121721]">
                  <div
                    className={`h-full transition-all duration-100 ${
                      focusedHud.aliveCount > 0 ? 'bg-[#ff2a4b]' : 'bg-[#20df78]'
                    }`}
                    style={{ width: `${hpPct}%` }}
                  />
                </div>
              </div>

              <div className="space-y-0.5">
                <div className="flex justify-between font-mono text-[9px] tabular-nums">
                  <span
                    className={
                      focusedHud.staggerRemainingSec > 0
                        ? 'text-[#ffd000] font-bold'
                        : 'text-[#00f0ff]'
                    }
                  >
                    {focusedHud.staggerRemainingSec > 0
                      ? `STAGGERED (${focusedHud.staggerRemainingSec.toFixed(1)}s)`
                      : 'STAGGER HEALTH'}
                  </span>
                  <span className="text-[#8c9bb5]">
                    {focusedHud.staggerRemainingSec > 0
                      ? 'VULNERABLE'
                      : `${focusedHud.staggerHp} / ${focusedHud.maxStaggerHp}`}
                  </span>
                </div>
                <div className="h-1 w-full bg-[#121721]">
                  <div
                    className={`h-full transition-all duration-100 ${
                      focusedHud.staggerRemainingSec > 0 ? 'bg-[#ffd000]' : 'bg-[#00f0ff]'
                    }`}
                    style={{
                      width:
                        focusedHud.staggerRemainingSec > 0 ? '100%' : `${staggerPct}%`,
                    }}
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-start gap-2 pointer-events-auto">
            <div className="text-right font-mono text-[10px] tracking-[0.08em] uppercase space-y-0.5 bg-[#0a0d12]/88 px-2.5 py-1.5 border border-[#1e2638] pointer-events-none">
              <div className="text-[#00f0ff] tabular-nums">
                {isMelee
                  ? `MELEE REACH ${weapon.melee!.reachM.toFixed(1)}m · COMBO ${meleeChargeUi.comboStep}/3`
                  : `${isAds ? 'OPTIC ADS ALIGNED' : 'HIPFIRE STANCE'} · DMG ${liveFalloffPct}%`}
              </div>
              <div className="text-[#8c9bb5] tabular-nums">
                {isMelee
                  ? `WEAKSPOT ${weapon.critMultiplier}x · SHOVE ${weapon.melee!.shoveDamage}/${weapon.melee!.shoveStaggerDamage} STAG`
                  : `PIERCE ${weapon.penetrationDepthM}m (-${weapon.penetrationDropPct}%) · FALLOFF ${weapon.falloffStartM}–${weapon.falloffEndM}m`}
              </div>
              <div
                className={
                  focusedHud.stateLabel.includes('STAGGERED')
                    ? 'text-[#ffd000] font-semibold'
                    : 'text-[#ffb300]'
                }
              >
                STATE: {focusedHud.stateLabel}
              </div>
            </div>

            {/* Corner Pause Button */}
            <button
              type="button"
              onClick={() => onSetPaused(!isPaused)}
              aria-label={isPaused ? 'Resume engagement' : 'Pause engagement'}
              className={`px-2.5 py-1.5 border font-mono text-[10px] font-bold uppercase tracking-[0.08em] flex items-center gap-1.5 transition-colors cursor-pointer ${
                isPaused
                  ? 'bg-[#ffb300] border-[#ffb300] text-[#0a0d12]'
                  : 'bg-[#0a0d12]/90 border-[#232d42] text-[#e1e2ea] hover:border-[#ffb300] hover:text-[#ffb300]'
              }`}
            >
              {isPaused ? <Play size={12} /> : <Pause size={12} />}
              <span>{isPaused ? 'RESUME' : 'PAUSE'}</span>
            </button>
          </div>
        </div>

        {/* 4s Inter-Wave Auto-Launch Countdown Banner */}
        {nextWaveCountdownSec !== null && focusedHud.aliveCount === 0 && playerHp > 0 && !isPaused && (
          <div className="absolute top-16 left-1/2 -translate-x-1/2 z-20 bg-[#0a0d12]/92 border border-[#00f0ff] px-4 py-2 flex items-center gap-3 font-mono text-xs uppercase tracking-[0.08em]">
            <span className="text-[#20df78] font-bold">WAVE {waveNumber} CLEARED</span>
            <span className="text-[#8c9bb5]">·</span>
            <span className="text-[#00f0ff] font-bold tabular-nums">
              NEXT WAVE IN {nextWaveCountdownSec.toFixed(1)}S
            </span>
            <button
              type="button"
              onClick={onStartNextWave}
              className="px-2 py-0.5 bg-[#00f0ff] text-[#0a0d12] font-bold text-[10px] hover:bg-[#ffb300] cursor-pointer"
            >
              START NOW
            </button>
          </div>
        )}

        {/* Cursor Mode Status */}
        {cursorShown && !isPaused && (
          <div className="pointer-events-none absolute top-14 right-4 z-20 bg-[#0a0d12]/90 border border-[#00f0ff] px-2.5 py-1 font-mono text-[10px] text-[#00f0ff] flex items-center gap-1.5">
            <MousePointer size={11} />
            <span>CURSOR UNLOCKED</span>
          </div>
        )}

        {/* Pause Overlay */}
        {isPaused && (
          <div className="absolute inset-0 z-30 bg-[#0a0d12]/88 flex items-center justify-center p-6">
            <div className="w-full max-w-sm bg-[#121721] border border-[#ffb300] p-5 space-y-4 text-center">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#ffb300]">
                  Simulation Suspended // Esc
                </div>
                <h3 className="mt-1 font-display text-xl font-bold uppercase tracking-[0.06em] text-[#e1e2ea]">
                  Engagement Paused
                </h3>
                <p className="mt-1 font-mono text-[11px] text-[#8c9bb5]">
                  Wave {waveNumber} · {focusedHud.aliveCount}/{focusedHud.totalCount} Hostiles Remaining
                </p>
              </div>

              <div className="bg-[#0f141d] border border-[#1e2638] p-2.5 text-left font-mono text-[10px] text-[#8c9bb5] space-y-1">
                <div>WASD / Arrows: Move · Shift: Sprint · Mouse: Aim</div>
                <div>LMB: Fire / Melee Combo (Hold: Charge Special)</div>
                <div>RMB / V: ADS (Ranged) / Shove (Melee) · R: Reload</div>
                <div>F: Flashlight (Spot / Flood) · Q: Medic Kit (+40% HP)</div>
                <div>Ctrl: Toggle Cursor · Esc: Pause / Resume</div>
              </div>

              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => onSetPaused(false)}
                  className="chamfer-sm w-full py-2.5 px-4 bg-[#ffb300] hover:bg-[#00f0ff] text-[#0a0d12] font-mono text-xs font-bold uppercase tracking-[0.1em] transition-colors cursor-pointer"
                >
                  Resume Engagement [ESC]
                </button>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={onResetRange}
                    className="py-2 px-3 border border-[#232d42] bg-[#0f141d] text-[#e1e2ea] hover:border-[#ffb300] hover:text-[#ffb300] font-mono text-[11px] uppercase cursor-pointer"
                  >
                    Respawn Squad
                  </button>
                  <button
                    type="button"
                    onClick={onOpenRooms}
                    className="py-2 px-3 border border-[#232d42] bg-[#0f141d] text-[#00f0ff] hover:border-[#00f0ff] font-mono text-[11px] uppercase cursor-pointer"
                  >
                    Switch Room
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Bottom HUD Strip */}
        <div className="absolute bottom-3 left-4 right-4 z-10 flex flex-wrap items-end justify-between gap-3 pointer-events-none">
          <div className="bg-[#0a0d12]/88 border border-[#1e2638] px-3 py-2 space-y-1.5 pointer-events-auto">
            <div className="flex items-center justify-between gap-3 font-mono text-[10px] tabular-nums">
              <span className={playerHp > 30 ? 'text-[#20df78]' : 'text-[#ff2a4b]'}>
                PLAYER HEALTH
              </span>
              <span className="text-[#8c9bb5] text-[9px]">
                {playerHp <= 0
                  ? 'DOWNED'
                  : isRegenerating
                    ? 'REGEN +4 HP/S'
                    : isOutOfCombat
                      ? 'OUT OF COMBAT'
                      : `OOC ${oocCountdown.toFixed(1)}S`}
              </span>
              <span className="text-[#e1e2ea] font-semibold">
                {playerHp} / {maxPlayerHp} HP
              </span>
            </div>
            <div className="h-1.5 w-52 bg-[#121721]">
              <div
                className={`h-full transition-all duration-100 ${
                  playerHp > 30 ? 'bg-[#20df78]' : 'bg-[#ff2a4b]'
                }`}
                style={{ width: `${playerHpPct}%` }}
              />
            </div>

            <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] text-[#8c9bb5]">
              <button
                type="button"
                onClick={onUseMedkit}
                disabled={playerHp <= 0 || playerHp >= maxPlayerHp || medkitCooldownSec > 0}
                className={`px-1.5 py-0.5 border flex items-center gap-1 uppercase transition-colors ${
                  playerHp > 0 && playerHp < maxPlayerHp && medkitCooldownSec <= 0
                    ? 'border-[#20df78] bg-[#20df78]/15 text-[#20df78] hover:bg-[#20df78] hover:text-[#0a0d12] cursor-pointer'
                    : 'border-[#232d42] bg-[#0f141d] text-[#606f89] cursor-not-allowed'
                }`}
              >
                <Heart size={10} />
                <span>
                  MEDKIT{' '}
                  {medkitCooldownSec > 0 ? `${medkitCooldownSec.toFixed(0)}S` : '+40%'}
                </span>
              </button>

              <button
                type="button"
                onClick={() => {
                  const next: FlashlightMode =
                    flashlightMode === 'OFF' ? 'SPOT' : flashlightMode === 'SPOT' ? 'FLOOD' : 'OFF';
                  simRef.current.flashlightMode = next;
                  setFlashlightMode(next);
                  soundEngine.playFlashlightToggle(next);
                }}
                className={`px-1.5 py-0.5 border flex items-center gap-1 uppercase transition-colors cursor-pointer ${
                  flashlightMode === 'SPOT'
                    ? 'border-[#ffb300] bg-[#ffb300]/18 text-[#ffb300]'
                    : flashlightMode === 'FLOOD'
                      ? 'border-[#00f0ff] bg-[#00f0ff]/15 text-[#00f0ff]'
                      : 'border-[#232d42] bg-[#0f141d] text-[#8c9bb5] hover:border-[#ffb300]'
                }`}
              >
                <Flashlight size={10} />
                <span>LIGHT: {flashlightMode}</span>
              </button>

              {focusedHud.aliveCount === 0 && playerHp > 0 && (
                <button
                  type="button"
                  onClick={onStartNextWave}
                  className="px-2 py-0.5 bg-[#00f0ff] text-[#0a0d12] font-bold uppercase hover:bg-[#ffb300] cursor-pointer"
                >
                  NEXT WAVE (W{waveNumber + 1})
                </button>
              )}

              {(focusedHud.aliveCount === 0 || playerHp <= 0) && (
                <button
                  type="button"
                  onClick={onResetRange}
                  className="text-[#ffb300] hover:text-[#00f0ff] underline cursor-pointer"
                >
                  RESPAWN
                </button>
              )}
            </div>
          </div>

          <div className="bg-[#0f141d]/92 border border-[#232d42] px-3 py-2 flex items-center gap-3 font-mono text-xs tabular-nums pointer-events-auto">
            <span className="text-[#8c9bb5] text-[10px] uppercase">{weapon.code}</span>
            {isMelee ? (
              <>
                <span className="text-[#ffb300] font-bold">MELEE READY</span>
                <span className="text-[#232d42]">|</span>
                <span className="text-[#00f0ff] text-[11px]">
                  SHOVE {weapon.melee!.shoveStaggerDamage} STAG
                </span>
              </>
            ) : (
              <>
                <span className={isReloading ? 'text-[#ff2a4b]' : 'text-[#ffb300] font-bold'}>
                  {isReloading
                    ? 'RELOADING'
                    : `${magRemaining.toString().padStart(2, '0')} / ${weapon.magSize
                        .toString()
                        .padStart(2, '0')}`}
                </span>
                <span className="text-[#232d42]">|</span>
                <span className="text-[#00f0ff] text-[11px]">{weapon.rpm} RPM</span>
              </>
            )}
            <span className="text-[#232d42]">|</span>
            <button
              type="button"
              onClick={() => {
                const next = !isMuted;
                soundEngine.setMuted(next);
                setIsMuted(next);
                if (!next) soundEngine.unlock();
              }}
              aria-label={isMuted ? 'Unmute audio' : 'Mute audio'}
              className={`flex items-center gap-1 text-[10px] uppercase cursor-pointer transition-colors ${
                isMuted ? 'text-[#ff2a4b]' : 'text-[#20df78] hover:text-[#00f0ff]'
              }`}
            >
              {isMuted ? <VolumeX size={13} /> : <Volume2 size={13} />}
              <span>{isMuted ? 'MUTED' : 'SFX'}</span>
            </button>
          </div>
        </div>
      </div>

      {/* Post-Engagement Breakdown Card */}
      <div className="bg-[#121721] border border-[#1e2638] p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-[#1e2638]">
          <h3 className="font-display text-xs font-semibold tracking-[0.08em] uppercase text-[#e1e2ea]">
            02. Post-Engagement Breakdown
          </h3>
          <span className="font-mono text-[11px] text-[#8c9bb5] tabular-nums">
            {metrics.totalRoundsFired} STRIKES · WAVE {waveNumber} · SQUAD{' '}
            {focusedHud.aliveCount}/{focusedHud.totalCount} ACTIVE
          </span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3">
          <div className="bg-[#161c28] border border-[#1e2638] p-3 space-y-2">
            <div className="font-mono text-[10px] tracking-[0.08em] uppercase text-[#8c9bb5]">
              Total Damage
            </div>
            <div className="font-mono text-xl font-bold text-[#ffb300] tabular-nums">
              {metrics.totalHpDamage.toLocaleString()}
            </div>
            <div className="h-1.5 w-full bg-[#0a0d12]">
              <div
                className="h-full bg-[#ffb300]"
                style={{
                  width: `${Math.min(
                    100,
                    (metrics.totalHpDamage / Math.max(1, config.targetHp)) * 100
                  )}%`,
                }}
              />
            </div>
          </div>

          <div className="bg-[#161c28] border border-[#1e2638] p-3 space-y-2">
            <div className="font-mono text-[10px] tracking-[0.08em] uppercase text-[#8c9bb5]">
              Observed TTK / Enemy
            </div>
            <div className="font-mono text-xl font-bold text-[#00f0ff] tabular-nums">
              {metrics.ttkMs !== null ? `${metrics.ttkMs} ms` : `${metrics.theoreticalTtkMs} ms*`}
            </div>
            <div className="h-1.5 w-full bg-[#0a0d12]">
              <div
                className="h-full bg-[#00f0ff]"
                style={{ width: metrics.ttkMs !== null ? '100%' : '45%' }}
              />
            </div>
          </div>

          <div className="bg-[#161c28] border border-[#1e2638] p-3 space-y-2">
            <div className="font-mono text-[10px] tracking-[0.08em] uppercase text-[#8c9bb5]">
              Accuracy Ratio
            </div>
            <div className="font-mono text-xl font-bold text-[#20df78] tabular-nums">
              {metrics.accuracyPct.toFixed(1)}%
            </div>
            <div className="h-1.5 w-full bg-[#0a0d12]">
              <div
                className="h-full bg-[#20df78]"
                style={{ width: `${metrics.accuracyPct}%` }}
              />
            </div>
          </div>

          <div className="bg-[#161c28] border border-[#1e2638] p-3 space-y-2">
            <div className="font-mono text-[10px] tracking-[0.08em] uppercase text-[#8c9bb5]">
              Weakspot Eff.
            </div>
            <div className="font-mono text-xl font-bold text-[#ff2a4b] tabular-nums">
              {metrics.weakspotEfficiencyPct.toFixed(1)}%
            </div>
            <div className="h-1.5 w-full bg-[#0a0d12]">
              <div
                className="h-full bg-[#ff2a4b]"
                style={{ width: `${metrics.weakspotEfficiencyPct}%` }}
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
