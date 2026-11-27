/**
 * @file Primary 3D WebGL2 tactical combat viewport, physics loop, ballistics raycaster, enemy AI,
 * deployable ordnance manager, procedural skybox/weather renderer, and HUD overlay coordinator.
 *
 * Architectural design (`useRef` 60Hz mutable engine + throttled React UI mirrors):
 * - All high-frequency simulation state (player position, camera Euler angles, recoil heat, enemy
 *   kinematics, projectiles, pooled particles, weather damping) lives inside mutable `simRef.current`,
 *   read and written synchronously by the WebGL `tick()` loop.
 * - Live React prop values (`weapons`, `grenades`, `targets`, `playerHp`, callbacks) are mirrored
 *   into `propsRef.current` every render so the single long-lived WebGL effect (`useEffect(..., [])`)
 *   always sees live Armory/Targets stat edits without tearing down GPU buffers or recreating listeners.
 * - UI state setters (`setFocusedHud`, `setFloatingHits`, `setReloadProgress`, `setCursorShown`, etc.)
 *   are updated either on discrete user events or at a ~15Hz HUD sync cadence (`hudSyncAcc >= 0.065`).
 *
 * Why alternative approaches would be worse:
 * - Storing positions/rotations/projectiles in React `useState` at 60–120 FPS would schedule dozens
 *   of Virtual DOM reconciliations per second, causing severe GC pressure, frame pacing stutter, and
 *   aiming input lag.
 * - Re-running the WebGL setup `useEffect` whenever weapon/target stats or `waveNumber` changed would
 *   reallocate shaders, PMREM textures, shadow maps, and room geometry on every wave or Armory edit,
 *   wiping active mines/C4/turrets and freezing the browser for hundreds of milliseconds.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  Cloud,
  CloudDrizzle,
  CloudLightning,
  CloudRain,
  Eye,
  EyeOff,
  Flame,
  Flashlight,
  Globe,
  Heart,
  Maximize2,
  Minimize2,
  Moon,
  MousePointer,
  Pause,
  Play,
  RefreshCw,
  Sun,
  Sunset,
  Volume2,
  VolumeX,
} from 'lucide-react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { soundEngine } from '../audio/soundEngine';
import { GRENADES } from '../data/arsenal';
import {
  buildInitialEnemyComponents,
  ENEMY_WEAPONS,
} from '../data/enemyArsenal';
import {
  buildSquadRoster,
  computeConsumableFalloff,
  getEffectiveReloadDurationMs,
  getGrenadeById,
  getGrenadeDropRangeM,
  getRecoilForShot,
  getTargetById,
  getWeaponById,
  partitionRosterIntoDifficultyGroups,
  resolveMeleeHit,
  resolveShot,
} from '../engine/ballistics';
import {
  buildAmmoBox3D,
  buildConsumableBox3D,
  buildConsumableViewmodel3D,
  buildDeployableTurretMesh3D,
  buildEnemyModel3D,
  buildLaserTripMineMesh3D,
  buildStickyC4Mesh3D,
  buildTripMineMesh3D,
  buildWeaponViewmodel3D,
  BuiltEnemy3D,
  BuiltWeapon3D,
} from '../three/proceduralModels';
import {
  BreakableCover3D,
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
  BodyRegionKey,
  EnemyInternalComponents,
  EnemyLoadoutSpec,
  EnemyWeaponSpec,
  EngagementMetrics,
  GrenadeId,
  GrenadeProfile,
  HitZoneId,
  MeleeComboStep,
  RoomLayoutId,
  ShotTelemetryEvent,
  SimulationConfig,
  TargetProfile,
  TargetSilhouette,
  WeaponProfile,
  WeaponSlot,
} from '../types/ballistics';
import {
  advanceWorldTime,
  buildLocalTimezoneSnapshot,
  buildWeatherStateFromCondition,
  computeEnvironmentTimeProfile,
  COUNTRY_TIME_OPTIONS,
  fetchWorldTime,
  fetchWorldWeather,
  HOURLY_SYNC_INTERVAL_MS,
  WeatherOverrideMode,
  WorldTimeState,
  WorldWeatherState,
} from '../services/worldTimeApi';
import { MinimapSnapshot, TacticalMinimap } from './TacticalMinimap';
import { InventoryHoverItem, ViewportInventoryModal } from './ViewportInventoryModal';

/** Floating damage popup anchored to an enemy's 3D world impact coordinate and projected into viewport %. */
interface FloatingHitLabel {
  id: number;
  worldX: number;
  worldY: number;
  worldZ: number;
  jitterX: number;
  jitterY: number;
  screenX: number;
  screenY: number;
  visible: boolean;
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
  weaponId?: string;
  source?: 'PLAYER' | 'PLAYER_MELEE' | 'PLAYER_SHOVE' | 'PLAYER_GRENADE' | 'PLAYER_TURRET';
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
  telemetryEvents?: ShotTelemetryEvent[];
}

interface EnemyActor {
  uid: number;
  encounterId: number;
  profile: TargetProfile;
  groupLabel: string;
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
  // Breakable door assignment & waypoints
  doorSide: 'west' | 'east' | 'north' | null;
  waypoints: { x: number; z: number }[];
  waypointIdx: number;
  doorBashCooldown: number;
  dronePatrolTarget: { x: number; z: number } | null;
  dronePatrolTimer: number;
  droneFireCooldown: number;
  droneChargeTimer: number;
  // Swarm, lunge, swarmer break-contact, & incendiary burn/slow timers
  lungeState: 'NONE' | 'WINDUP' | 'LUNGE';
  lungeTimer: number;
  lungeCooldown: number;
  lungeDirX: number;
  lungeDirZ: number;
  retreatTimer: number;
  swarmAngle: number;
  burnCooldown: number;
  burnSlowTimer: number;
  // Shields, weapons, internal components, & tactical cover AI
  loadout: EnemyLoadoutSpec;
  shieldHp: number;
  shieldMaxHp: number;
  components: EnemyInternalComponents;
  regionFlashTimers: Record<BodyRegionKey, number>;
  rangedMag: number;
  rangedReloadTimer: number;
  rangedFireCooldown: number;
  rangedRecoilDeg: number;
  podMag: number;
  podReloadTimer: number;
  podCooldown: number;
  meleeComboIdx: number;
  coverTarget: BreakableCover3D | null;
  coverRepickTimer: number;
  lastEffectiveAccuracy: number;
}

interface PendingSpawn {
  uid: number;
  encounterId: number;
  profile: TargetProfile;
  groupLabel: string;
  delayRemainingSec: number;
  hp: number;
  spawnX: number;
  spawnZ: number;
  doorSide: 'west' | 'east' | 'north' | null;
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
  isHoming?: boolean;
  turnRateRad?: number;
  speedMps?: number;
  sourceWeaponId?: EnemyWeaponSpec['id'];
  splashRadiusM?: number;
  canHitEnemies?: boolean;
  sourceActorUid?: number;
  ignoreSelfSec?: number;
}

interface ImpactSpark3D {
  mesh: THREE.Mesh;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  active: boolean;
}

interface ImpactDecal3D {
  mesh: THREE.Mesh;
  life: number;
  active: boolean;
}

interface ThrownGrenade3D {
  mesh: THREE.Group;
  profile: GrenadeProfile;
  vx: number;
  vy: number;
  vz: number;
  fuseTimer: number;
  bounced: boolean;
  impactedActorUids: Set<number>;
}

interface TripMine3D {
  uid: number;
  mesh: THREE.Group;
  ledMesh: THREE.Mesh;
  hitMesh: THREE.Mesh;
  x: number;
  y: number;
  z: number;
  armTimer: number;
  deployGraceTimer: number;
  triggerRadius: number;
  radiusM: number;
  damage: number;
  staggerDamage: number;
}

interface LaserTripMine3D {
  uid: number;
  mesh: THREE.Group;
  beamMesh: THREE.Mesh;
  hitMesh: THREE.Mesh;
  pos: THREE.Vector3;
  beamDir: THREE.Vector3;
  coneDir: THREE.Vector3;
  beamLength: number;
  armTimer: number;
  deployGraceTimer: number;
  rangeM: number;
  maxDamage: number;
  pierceDepthM: number;
  staggerDamage: number;
}

interface StickyC43D {
  uid: number;
  mesh: THREE.Group;
  ledMesh: THREE.Mesh;
  hitMesh: THREE.Mesh;
  pos: THREE.Vector3;
  vx: number;
  vy: number;
  vz: number;
  stuck: boolean;
  deployGraceTimer: number;
  attachedActorUid: number | null;
  localOffset: THREE.Vector3;
  radiusM: number;
  damage: number;
  staggerDamage: number;
}

interface PendingChainDetonation {
  kind: 'trip_mine' | 'laser_trip_mine' | 'sticky_c4';
  pos: THREE.Vector3;
  laserClone?: LaserTripMine3D;
  delaySec: number;
}

interface DeployableTurret3D {
  uid: number;
  mesh: THREE.Group;
  yawGroup: THREE.Group;
  pitchGroup: THREE.Group;
  muzzlePoint: THREE.Object3D;
  muzzleFlash: THREE.Mesh;
  hitMesh: THREE.Mesh;
  pos: THREE.Vector3;
  baseYaw: number;
  currentRelYaw: number;
  currentPitch: number;
  fireCooldown: number;
  muzzleFlashTimer: number;
  deployGraceTimer: number;
  damage: number;
  hp: number;
  maxHp: number;
  armorMult: number;
}

interface IncendiaryZone3D {
  group: THREE.Group;
  light: THREE.PointLight;
  x: number;
  z: number;
  radius: number;
  remainingSec: number;
  tickTimer: number;
  dotDamage: number;
}

interface ExplosionRing3D {
  mesh: THREE.Mesh;
  life: number;
  maxLife: number;
  maxScale: number;
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

interface AmmoBox3D {
  mesh: THREE.Group;
  beacon: THREE.Object3D | null;
  x: number;
  y: number;
  z: number;
  vy: number;
  spinPhase: number;
  remainingSec: number;
}

interface ConsumableBox3D {
  mesh: THREE.Group;
  beacon: THREE.Object3D | null;
  x: number;
  y: number;
  z: number;
  vy: number;
  spinPhase: number;
  remainingSec: number;
}

interface SimulationCanvas3DProps {
  config: SimulationConfig;
  weapons: WeaponProfile[];
  grenades?: GrenadeProfile[];
  targets: TargetProfile[];
  consumableUsages: Record<GrenadeId, number>;
  weaponAmmoMap: Record<string, { mag: number; reserve: number }>;
  playerHp: number;
  maxPlayerHp: number;
  outOfCombatSec: number;
  outOfCombatWindowSec: number;
  medkitCooldownSec: number;
  grenadeCooldownSec: number;
  waveNumber: number;
  waveGroupSize: number;
  waveTriggerToken: number;
  magRemaining: number;
  reserveAmmo: number;
  isReloading: boolean;
  isSimRunning: boolean;
  isPaused: boolean;
  isScreenActive: boolean;
  metrics: EngagementMetrics;
  startOverlay?: React.ReactNode;
  onTriggerShot: () => boolean;
  onManualReload?: () => void;
  onUseMedkit: () => void;
  onCollectAmmoBox: () => { collected: boolean; weaponCode: string; added: number };
  onCollectConsumableBox: () => { collected: boolean; summaryText: string };
  onSelectGrenade: (id: GrenadeId) => void;
  onSelectSlotWeapon: (slot: WeaponSlot, weaponId: string, preserveAmmo?: boolean) => void;
  onToggleConsumableSlot: () => void;
  onTryUseConsumable: (grenade: GrenadeProfile) => boolean;
  onRefundConsumableUsage: (grenadeId: GrenadeId) => boolean;
  onGrenadeImpactLog: (info: {
    grenade: GrenadeProfile;
    targetName: string;
    zoneLabel: string;
    hpDamage: number;
    isKill: boolean;
    isStagger: boolean;
    distanceM: number;
    enemyTtkMs: number | null;
    source?: 'PLAYER_GRENADE' | 'PLAYER_TURRET';
    affectedTargets?: {
      enemyUid: number;
      targetId: string;
      targetName: string;
      targetCode: string;
      silhouette: TargetSilhouette;
      waveNumber: number;
      hpDamage: number;
      isKill: boolean;
      enemyTtkMs: number | null;
    }[];
  }) => void;
  onPlayerOrdnanceSelfDamage: (rawDamage: number, zoneLabel: string) => void;
  onSetPaused: (paused: boolean) => void;
  onSwitchActiveSlot: (slot: WeaponSlot) => void;
  onStartNextWave: () => void;
  onOpenRooms: () => void;
  onOpenLoadout?: () => void;
  onSquadShotResolved: (summary: SquadShotSummary) => void;
  onEnemyClawAttack: (isDualSpecial: boolean, damage: number, attackerName: string) => void;
  onEnemyDroneShot: (damage: number, attackerName: string) => void;
  onEnemyWeaponAttack: (
    source: 'ENEMY_RANGED' | 'ENEMY_MELEE' | 'ENEMY_EXPLOSION',
    damage: number,
    attackerName: string,
    zoneLabel: string,
    distanceM: number
  ) => void;
  onSquadCleared: () => void;
  onResetRange: () => void;
  resetToken: number;
  doorResetToken: number;
}

const _vec3A = new THREE.Vector3();
const _vec3B = new THREE.Vector3();
const _vec3C = new THREE.Vector3();
const _rayCenter = new THREE.Vector2(0, 0);
const _rayPellet = new THREE.Vector2(0, 0);

/** Vendor-prefixed Fullscreen event names supported across Chrome, Firefox, Safari/WebKit, and Edge. */
const FULLSCREEN_CHANGE_EVENTS = [
  'fullscreenchange',
  'webkitfullscreenchange',
  'mozfullscreenchange',
  'MSFullscreenChange',
] as const;

/** Vendor-prefixed Pointer Lock change event names across Chromium, Gecko, and WebKit. */
const POINTER_LOCK_CHANGE_EVENTS = [
  'pointerlockchange',
  'webkitpointerlockchange',
  'mozpointerlockchange',
] as const;

/** Vendor-prefixed Pointer Lock error event names so browsers that deny lock recover gracefully. */
const POINTER_LOCK_ERROR_EVENTS = [
  'pointerlockerror',
  'webkitpointerlockerror',
  'mozpointerlockerror',
] as const;

interface VendorDocument extends Document {
  webkitFullscreenElement?: Element | null;
  mozFullScreenElement?: Element | null;
  msFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
  mozCancelFullScreen?: () => Promise<void> | void;
  msExitFullscreen?: () => Promise<void> | void;
  webkitPointerLockElement?: Element | null;
  mozPointerLockElement?: Element | null;
  webkitExitPointerLock?: () => void;
  mozExitPointerLock?: () => void;
}

interface VendorElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
  mozRequestFullScreen?: () => Promise<void> | void;
  msRequestFullscreen?: () => Promise<void> | void;
  webkitRequestPointerLock?: () => Promise<void> | void;
  mozRequestPointerLock?: () => Promise<void> | void;
}

/**
 * Returns the active fullscreen element across standard and vendor-prefixed browser APIs.
 */
function getFullscreenElement(): Element | null {
  const doc = document as VendorDocument;
  return (
    doc.fullscreenElement ??
    doc.webkitFullscreenElement ??
    doc.mozFullScreenElement ??
    doc.msFullscreenElement ??
    null
  );
}

/**
 * Requests fullscreen for a viewport element using standard or vendor-prefixed browser methods.
 */
async function requestElementFullscreen(el: HTMLElement | null | undefined): Promise<void> {
  if (!el) return;
  const vEl = el as VendorElement;
  const fn =
    vEl.requestFullscreen ??
    vEl.webkitRequestFullscreen ??
    vEl.mozRequestFullScreen ??
    vEl.msRequestFullscreen;
  if (typeof fn !== 'function') return;
  await Promise.resolve(fn.call(vEl)).catch(() => {});
}

/**
 * Exits fullscreen mode across standard, Safari/WebKit, Firefox/Gecko, and legacy Edge APIs.
 */
async function exitDocumentFullscreen(): Promise<void> {
  const doc = document as VendorDocument;
  const fn =
    doc.exitFullscreen ??
    doc.webkitExitFullscreen ??
    doc.mozCancelFullScreen ??
    doc.msExitFullscreen;
  if (typeof fn !== 'function') return;
  await Promise.resolve(fn.call(doc)).catch(() => {});
}

/**
 * Engages or releases Chromium Keyboard Lock for `Escape` while the simulation viewport owns fullscreen.
 * By reserving `Escape`, pressing `Esc` in fullscreen pauses/resumes combat cleanly inside the browser
 * instead of letting the OS/browser immediately drop fullscreen mode.
 * Gracefully no-ops in Firefox and Safari where `navigator.keyboard.lock` is not implemented.
 *
 * Why an alternative would be worse: relying only on `window.addEventListener('keydown', preventDefault)`
 * cannot intercept browser-level Escape fullscreen exit in Chrome/Edge without Keyboard Lock.
 */
function syncEscapeKeyboardLock(lock: boolean): void {
  const kb = (navigator as unknown as {
    keyboard?: { lock?: (keys: string[]) => Promise<void>; unlock?: () => void };
  }).keyboard;
  if (!kb) return;
  if (lock) {
    kb.lock?.(['Escape']).catch(() => {});
  } else {
    try {
      kb.unlock?.();
    } catch {
      // Ignore unlock errors when Keyboard Lock is inactive or unsupported
    }
  }
}

/**
 * Returns the currently pointer-locked element across standard, Safari/WebKit, and Firefox/Gecko.
 */
function getPointerLockElement(): Element | null {
  const doc = document as VendorDocument;
  return (
    doc.pointerLockElement ??
    doc.webkitPointerLockElement ??
    doc.mozPointerLockElement ??
    null
  );
}

/**
 * Safely requests pointer lock on the WebGL canvas using standard or vendor-prefixed methods while
 * catching promise rejections in Firefox, Safari, or sandboxed preview iframes.
 *
 * Why an alternative would be worse: calling `canvas.requestPointerLock()` unguarded throws unhandled
 * Promise rejections or SecurityErrors in embedded iframes and blocks subsequent input handlers.
 */
function safeRequestPointerLock(el: Element | null | undefined): void {
  if (!el) return;
  const vEl = el as VendorElement;
  const fn =
    vEl.requestPointerLock ??
    vEl.webkitRequestPointerLock ??
    vEl.mozRequestPointerLock;
  if (typeof fn !== 'function') return;
  try {
    const maybePromise = fn.call(vEl) as unknown as Promise<void> | undefined;
    if (maybePromise && typeof maybePromise.catch === 'function') {
      maybePromise.catch(() => {});
    }
  } catch {
    // Fallback relative mouse panning stays active
  }
}

/**
 * Safely releases any active pointer lock across Chrome, Firefox, Safari, and Edge.
 */
function safeExitPointerLock(): void {
  const doc = document as VendorDocument;
  const fn =
    doc.exitPointerLock ??
    doc.webkitExitPointerLock ??
    doc.mozExitPointerLock;
  if (typeof fn !== 'function') return;
  try {
    fn.call(doc);
  } catch {
    // Ignore pointer lock exit errors
  }
}

/**
 * Normalizes vertical wheel delta to pixel-equivalent units so Firefox `DOM_DELTA_LINE`
 * (`deltaMode === 1`) and `DOM_DELTA_PAGE` (`deltaMode === 2`) match Chromium/Safari pixel deltas.
 *
 * Why an alternative would be worse: reading raw `e.deltaY` directly makes Firefox return tiny values
 * (`±3` lines) that fail threshold checks or behave asymmetrically compared to Chrome (`±100` px).
 */
function normalizeWheelDeltaY(e: WheelEvent): number {
  if (e.deltaMode === 1) return e.deltaY * 16;
  if (e.deltaMode === 2) return e.deltaY * 400;
  return e.deltaY;
}

/**
 * Recursively disposes mesh geometries and single/array materials under an abandoned `THREE.Object3D`
 * hierarchy when enemies expire or deployables/tracers leave the scene, preventing WebGL VRAM leaks
 * across extended multi-wave sessions.
 */
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
  grenades = GRENADES,
  targets,
  consumableUsages,
  weaponAmmoMap,
  playerHp,
  maxPlayerHp,
  outOfCombatSec,
  outOfCombatWindowSec,
  medkitCooldownSec,
  grenadeCooldownSec,
  waveNumber,
  waveGroupSize,
  waveTriggerToken,
  magRemaining,
  reserveAmmo,
  isReloading,
  isSimRunning,
  isPaused,
  isScreenActive,
  metrics,
  startOverlay,
  onTriggerShot,
  onManualReload,
  onUseMedkit,
  onCollectAmmoBox,
  onCollectConsumableBox,
  onSelectGrenade,
  onSelectSlotWeapon,
  onToggleConsumableSlot,
  onTryUseConsumable,
  onRefundConsumableUsage,
  onGrenadeImpactLog,
  onPlayerOrdnanceSelfDamage,
  onSetPaused,
  onSwitchActiveSlot,
  onStartNextWave,
  onOpenRooms,
  onOpenLoadout,
  onSquadShotResolved,
  onEnemyClawAttack,
  onEnemyDroneShot,
  onEnemyWeaponAttack,
  onSquadCleared,
  onResetRange,
  resetToken,
  doorResetToken,
}) => {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const hoveredInventoryItemRef = useRef<InventoryHoverItem | null>(null);
  const centerViewportCursorRef = useRef<((graceMs?: number, requestLock?: boolean) => void) | null>(
    null
  );

  const [isAds, setIsAds] = useState(false);
  const [reloadProgress, setReloadProgress] = useState(0);
  const [flashlightMode, setFlashlightMode] = useState<FlashlightMode>('OFF');
  const [nextWaveCountdownSec, setNextWaveCountdownSec] = useState<number | null>(null);
  const [plantedC4Count, setPlantedC4Count] = useState<number>(0);
  const [activeTurretCount, setActiveTurretCount] = useState<number>(0);
  const [cursorShown, setCursorShown] = useState(false);
  const [inventoryOpen, setInventoryOpen] = useState(false);
  const [wave5Won, setWave5Won] = useState(false);
  const [pickupPrompt, setPickupPrompt] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showTargetHealthHud, setShowTargetHealthHud] = useState(true);
  const [showDamagePopups, setShowDamagePopups] = useState(true);
  const [isWindowFocused, setIsWindowFocused] = useState<boolean>(() =>
    typeof document !== 'undefined' ? document.hasFocus() : true
  );
  const [liveDistanceM, setLiveDistanceM] = useState(config.distanceM);
  const [focusedHud, setFocusedHud] = useState<{
    name: string;
    code: string;
    groupLabel: string;
    hp: number;
    maxHp: number;
    shieldHp: number;
    shieldMaxHp: number;
    compFlags: string[];
    weaponLabel: string;
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
      groupLabel: 'GRP-1 VANGUARD',
      hp: t.defaultHp,
      maxHp: t.defaultHp,
      shieldHp: 0,
      shieldMaxHp: 0,
      compFlags: [],
      weaponLabel: '',
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
  const [ammoToast, setAmmoToast] = useState<string | null>(null);
  const [stunEffectRemainingSec, setStunEffectRemainingSec] = useState<number>(0);
  const [fpsCount, setFpsCount] = useState<number>(60);
  const [selectedCountryId, setSelectedCountryId] = useState<string>('SG');
  const [worldTime, setWorldTime] = useState<WorldTimeState>(() =>
    buildLocalTimezoneSnapshot('SG')
  );
  const [liveWeather, setLiveWeather] = useState<WorldWeatherState>(() =>
    buildWeatherStateFromCondition('CLEAR', 'Syncing…', 0, 'fallback')
  );
  const [weatherOverride, setWeatherOverride] = useState<WeatherOverrideMode>('LIVE');
  const [showWeatherDebug, setShowWeatherDebug] = useState<boolean>(false);
  const [debugRainPct, setDebugRainPct] = useState<number | null>(null);
  const [debugDarkCloudsPct, setDebugDarkCloudsPct] = useState<number | null>(null);
  const [debugLightningMode, setDebugLightningMode] = useState<'AUTO' | 'ON' | 'OFF'>('AUTO');
  const [isSyncingWorldTime, setIsSyncingWorldTime] = useState<boolean>(false);
  const [webglError, setWebglError] = useState<string | null>(null);

  const baseWeather: WorldWeatherState =
    weatherOverride === 'LIVE'
      ? liveWeather
      : buildWeatherStateFromCondition(weatherOverride);

  const activeWeather: WorldWeatherState = {
    ...baseWeather,
    rainIntensity: debugRainPct !== null ? debugRainPct / 100 : baseWeather.rainIntensity,
    cloudCover:
      debugDarkCloudsPct !== null
        ? Math.max(baseWeather.cloudCover, 0.35 + (debugDarkCloudsPct / 100) * 0.65)
        : baseWeather.cloudCover,
    cloudDarkness:
      debugDarkCloudsPct !== null ? debugDarkCloudsPct / 100 : baseWeather.cloudDarkness,
    hasLightning:
      debugLightningMode === 'ON'
        ? true
        : debugLightningMode === 'OFF'
          ? false
          : baseWeather.hasLightning,
  };

  const minimapSnapshotRef = useRef<MinimapSnapshot>({
    roomId: config.roomId,
    playerX: 0,
    playerZ: 0,
    aimYaw: 0,
    wallSegments: [],
    doors: [],
    enemies: [],
    ammoBoxes: [],
    consumableBoxes: [],
  });

  const effectivePaused = isPaused || !isScreenActive || inventoryOpen;

  const propsRef = useRef({
    config,
    weapons,
    grenades,
    targets,
    consumableUsages,
    playerHp,
    magRemaining,
    reserveAmmo,
    isReloading,
    isSimRunning,
    isPaused,
    isScreenActive,
    inventoryOpen,
    effectivePaused,
    grenadeCooldownSec,
    waveNumber,
    waveGroupSize,
    waveTriggerToken,
    onTriggerShot,
    onManualReload,
    onUseMedkit,
    onCollectAmmoBox,
    onCollectConsumableBox,
    onSelectGrenade,
    onSelectSlotWeapon,
    onToggleConsumableSlot,
    onTryUseConsumable,
    onRefundConsumableUsage,
    onGrenadeImpactLog,
    onPlayerOrdnanceSelfDamage,
    onSetPaused,
    onSwitchActiveSlot,
    onSquadShotResolved,
    onEnemyClawAttack,
    onEnemyDroneShot,
    onEnemyWeaponAttack,
    onSquadCleared,
    onStartNextWave,
  });
  propsRef.current = {
    config,
    weapons,
    grenades,
    targets,
    consumableUsages,
    playerHp,
    magRemaining,
    reserveAmmo,
    isReloading,
    isSimRunning,
    isPaused,
    isScreenActive,
    inventoryOpen,
    effectivePaused,
    grenadeCooldownSec,
    waveNumber,
    waveGroupSize,
    waveTriggerToken,
    onTriggerShot,
    onManualReload,
    onUseMedkit,
    onCollectAmmoBox,
    onCollectConsumableBox,
    onSelectGrenade,
    onSelectSlotWeapon,
    onToggleConsumableSlot,
    onTryUseConsumable,
    onRefundConsumableUsage,
    onGrenadeImpactLog,
    onPlayerOrdnanceSelfDamage,
    onSetPaused,
    onSwitchActiveSlot,
    onSquadShotResolved,
    onEnemyClawAttack,
    onEnemyDroneShot,
    onEnemyWeaponAttack,
    onSquadCleared,
    onStartNextWave,
  };

  const simRef = useRef({
    playerX: 0,
    playerZ: 0,
    playerVelX: 0,
    playerVelZ: 0,
    playerSpeed: 0,
    playerRunAnticipationTimer: 0,
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
    mmbDown: false,
    mmbDownAtMs: 0,
    rmbConsumableDown: false,
    rmbConsumableDownAtMs: 0,
    lmbDown: false,
    burstShotsRemaining: 0,
    burstPauseUntilMs: 0,
    shotIndexInBurst: 0,
    lastFireTimeMs: -10000,
    muzzleFlashTimer: 0,
    // Mouse & Cursor controls
    cursorShown: false,
    unlockedByCtrl: false,
    lastEscLockDropMs: 0,
    lastEscKeyMs: 0,
    ignoreLockDropUntilMs: 0,
    ignoreMouseDeltaUntilMs: 0,
    hasPrevClientMouse: false,
    prevClientX: 0,
    prevClientY: 0,
    edgePanDir: 0,
    edgePanArmed: false,
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
    meleeStrikeStaggerMultiplier: 1.0,
    meleeStrikeIsSpecial: false,
    meleeStrikeIsShove: false,
    meleeStrikeChargePct: 1,
    meleeStrikeLabel: '',
    meleeImpactBounce: 0,
    cameraMeleePitch: 0,
    cameraMeleeYaw: 0,
    cameraMeleeRoll: 0,
    cameraMeleeFovOffset: 0,
    // Squad, persistent doors, grenades, consumables, waves, & projectiles
    enemies: [] as EnemyActor[],
    pendingSpawns: [] as PendingSpawn[],
    droneProjectiles: [] as DroneProjectile[],
    thrownGrenades: [] as ThrownGrenade3D[],
    incendiaryZones: [] as IncendiaryZone3D[],
    explosionRings: [] as ExplosionRing3D[],
    tripMines: [] as TripMine3D[],
    laserMines: [] as LaserTripMine3D[],
    stickyC4s: [] as StickyC43D[],
    turrets: [] as DeployableTurret3D[],
    pendingChainDetonations: [] as PendingChainDetonation[],
    nextDeployableUid: 1,
    ammoBoxes: [] as AmmoBox3D[],
    consumableBoxes: [] as ConsumableBox3D[],
    killsSinceAmmoDrop: 0,
    ammoToastTimer: 0,
    pendingGrenadeThrow: null as GrenadeId | null,
    doorDebris: [] as DoorDebrisShard[],
    floatingHitsRef: [] as FloatingHitLabel[],
    squadNeedsRebuild: true,
    clearDeployablesPending: true,
    roomNeedsRebuild: false,
    resetPlayerPosPending: true,
    resetDoorsPending: false,
    inventoryOpen: false,
    eKeyOpenedAt: 0,
    reloadAnimActive: false,
    reloadAnimElapsed: 0,
    reloadAnimDuration: 1.0,
    wasReloading: false,
    shotBoltKick: 0,
    squadClearedNotified: false,
    nextWaveTimerSec: null as number | null,
    playerHitSlowTimer: 0,
    playerBurnTickCooldown: 0,
    playerBurnSlowTimer: 0,
    stunFlashTimer: 0,
    // Player collapse animation & Wave 5 victory state
    deathFallProgress: 0,
    deathRollSign: 1,
    wasDead: false,
    wave5VictoryShown: false,
    totalSpawnedThisWave: 0,
    tracers: [] as { line: THREE.Line; life: number }[],
    impactSparks: [] as ImpactSpark3D[],
    impactDecals: [] as ImpactDecal3D[],
    nextDecalIdx: 0,
    hitLabelCounter: 1,
    nextEncounterId: 1,
    weaponIdBuilt: '',
    roomIdBuilt: '' as RoomLayoutId | '',
    skyHourTarget: buildLocalTimezoneSnapshot('SG').hourFloat,
    skyHourCurrent: buildLocalTimezoneSnapshot('SG').hourFloat,
    weatherRainTarget: 0,
    weatherRainCurrent: 0,
    weatherCloudCoverTarget: 0.16,
    weatherCloudCoverCurrent: 0.16,
    weatherCloudDarknessTarget: 0,
    weatherCloudDarknessCurrent: 0,
    weatherHasLightning: false,
    lightningForcedOn: false,
    lightningStrikeNowPending: false,
    lightningFlash: 0,
    lightningSubPulseTimer: 0,
    lightningNextTimer: 6.5,
    lightningBoltTimer: 0,
    pendingThunderTimer: null as number | null,
    pendingThunderStrength: 0.85,
  });

  useEffect(() => {
    simRef.current.weatherRainTarget = activeWeather.rainIntensity;
    simRef.current.weatherCloudCoverTarget = activeWeather.cloudCover;
    simRef.current.weatherCloudDarknessTarget = activeWeather.cloudDarkness;
    simRef.current.weatherHasLightning = activeWeather.hasLightning;
    simRef.current.lightningForcedOn = debugLightningMode === 'ON';
    if (activeWeather.hasLightning && simRef.current.lightningNextTimer > 4.5) {
      simRef.current.lightningNextTimer = 2.2 + Math.random() * 3.0;
    }
  }, [activeWeather, debugLightningMode]);

  useEffect(() => {
    if (isScreenActive && !isPaused) {
      const s = simRef.current;
      s.lastFireTimeMs = -10000;
      s.cursorShown = false;
      s.unlockedByCtrl = false;
      s.edgePanDir = 0;
      s.edgePanArmed = false;
      s.hasPrevClientMouse = false;
      s.ignoreMouseDeltaUntilMs = performance.now() + 140;
      setCursorShown(false);
      centerViewportCursorRef.current?.(140, false);
      const canvasEl = mountRef.current?.querySelector('canvas');
      if (canvasEl) {
        const rect = (viewportRef.current ?? canvasEl).getBoundingClientRect();
        s.prevClientX = rect.left + rect.width * 0.5;
        s.prevClientY = rect.top + rect.height * 0.5;
        canvasEl.focus({ preventScroll: true });
      }
    }
  }, [isScreenActive, isPaused]);

  const handleManualWorldTimeSync = async (countryId = selectedCountryId) => {
    setIsSyncingWorldTime(true);
    try {
      const [nextTime, nextWeather] = await Promise.all([
        fetchWorldTime(countryId),
        fetchWorldWeather(countryId),
      ]);
      setWorldTime(nextTime);
      setLiveWeather(nextWeather);
      simRef.current.skyHourTarget = nextTime.hourFloat;
    } finally {
      setIsSyncingWorldTime(false);
    }
  };

  /**
   * Third-party hourly Time & Weather synchronization effect:
   * 1. Immediately seeds a zero-latency local `Intl` timezone snapshot so the skybox starts at
   *    the selected region's real solar phase before network requests resolve.
   * 2. Fetches live time (`worldTimeApi.ts` / data.gov.sg / world-time & Open-Meteo APIs) and
   *    live weather using a cancellable `AbortController`.
   * 3. Schedules a background `HOURLY_SYNC_INTERVAL_MS` timer (3,600,000 ms = 1 hour) to re-pull
   *    regional time & rain conditions automatically, plus a 10s local clock ticker that smoothly
   *    advances `skyHourTarget` between hourly polls.
   *
   * Why an alternative would be worse: polling every second would exceed third-party API rate limits,
   * while omitting `AbortController` cleanup would apply stale responses from a previously selected
   * country onto a newly chosen timezone.
   */
  useEffect(() => {
    const controller = new AbortController();
    let mounted = true;
    const immediate = buildLocalTimezoneSnapshot(selectedCountryId);
    setWorldTime(immediate);
    simRef.current.skyHourTarget = immediate.hourFloat;

    const runSync = async () => {
      if (!mounted) return;
      setIsSyncingWorldTime(true);
      try {
        const [syncedTime, syncedWeather] = await Promise.all([
          fetchWorldTime(selectedCountryId, controller.signal),
          fetchWorldWeather(selectedCountryId, controller.signal),
        ]);
        if (!mounted || controller.signal.aborted) return;
        setWorldTime(syncedTime);
        setLiveWeather(syncedWeather);
        simRef.current.skyHourTarget = syncedTime.hourFloat;
      } finally {
        if (mounted) setIsSyncingWorldTime(false);
      }
    };

    void runSync();
    const hourlyTimer = window.setInterval(() => {
      void runSync();
    }, HOURLY_SYNC_INTERVAL_MS);

    const minuteTicker = window.setInterval(() => {
      setWorldTime((prev) => {
        const advanced = advanceWorldTime(prev);
        simRef.current.skyHourTarget = advanced.hourFloat;
        return advanced;
      });
    }, 10_000);

    return () => {
      mounted = false;
      controller.abort();
      window.clearInterval(hourlyTimer);
      window.clearInterval(minuteTicker);
    };
  }, [selectedCountryId]);

  const triggerMetaRef = useRef({
    resetToken,
    doorResetToken,
    waveTriggerToken,
    roomId: config.roomId,
  });

  /**
   * Selective Scene Rebuild Dispatcher:
   * Distinguishes four lifecycle triggers by comparing current props against `triggerMetaRef`:
   * - `roomChanged`: Rebuilds room geometry, resets player spawn, clears all deployables/drops.
   * - `doorResetTriggered` (Full New Game / Respawn Squad): Resets player spawn, repairs doors/covers,
   *   and sets `clearDeployablesPending = true` to remove all placed mines, C4, turrets, and boxes.
   * - `resetTriggered` (Target preset change): Respawns enemies & clears deployables while leaving doors.
   * - `waveTriggered` (Wave N -> Wave N+1 progression): Preserves player position, intact/broken doors
   *   and covers, active 40s ammo/consumable boxes, AND all placed trip mines, laser mines, C4, and turrets.
   *
   * Why an alternative would be worse: unconditionally clearing `simRef` on every wave transition would
   * delete tactical traps/turrets and teleport the player back to spawn mid-battle.
   */
  useEffect(() => {
    const prev = triggerMetaRef.current;
    const roomChanged = prev.roomId !== config.roomId;
    const doorResetTriggered = prev.doorResetToken !== doorResetToken;
    const resetTriggered = prev.resetToken !== resetToken;
    const waveTriggered = prev.waveTriggerToken !== waveTriggerToken;

    triggerMetaRef.current = {
      resetToken,
      doorResetToken,
      waveTriggerToken,
      roomId: config.roomId,
    };

    const s = simRef.current;
    if (roomChanged) {
      s.roomNeedsRebuild = true;
      s.resetPlayerPosPending = true;
      s.resetDoorsPending = false;
      s.clearDeployablesPending = true;
    } else if (doorResetTriggered) {
      s.resetPlayerPosPending = true;
      s.resetDoorsPending = true;
      s.clearDeployablesPending = true;
    } else if (resetTriggered) {
      s.resetPlayerPosPending = true;
      s.resetDoorsPending = false;
      s.clearDeployablesPending = true;
    } else if (waveTriggered) {
      s.resetPlayerPosPending = false;
      s.resetDoorsPending = false;
      s.clearDeployablesPending = false;
    }

    s.squadNeedsRebuild = true;
    s.squadClearedNotified = false;
    s.nextWaveTimerSec = null;
    s.wave5VictoryShown = false;
    s.deathFallProgress = 0;
    s.wasDead = false;
    s.playerHitSlowTimer = 0;
    s.recoilYaw = 0;
    s.recoilPitch = 0;
    s.recoilHeat = 0;
    s.firingSwayBlend = 0;
    s.shotIndexInBurst = 0;
    s.cameraMeleeYaw = 0;
    s.cameraMeleePitch = 0;
    s.cameraMeleeRoll = 0;
    s.edgePanDir = 0;
    s.edgePanArmed = false;
    s.hasPrevClientMouse = false;
    s.ignoreMouseDeltaUntilMs = Math.max(s.ignoreMouseDeltaUntilMs, performance.now() + 140);
    s.meleeAction = 'IDLE';
    s.meleeChargeSec = 0;
    s.meleeComboIdx = 0;
    s.halberdSpecialChainTimer = 0;
    s.floatingHitsRef = [];
    if (roomChanged || resetTriggered) {
      s.inventoryOpen = false;
      setInventoryOpen(false);
      s.stunFlashTimer = 0;
      setStunEffectRemainingSec(0);
    }
    setWave5Won(false);
    setNextWaveCountdownSec(null);
    setHitMarker(null);
    setFloatingHits([]);
  }, [resetToken, doorResetToken, waveTriggerToken, config.roomId]);

  /**
   * Tracks cross-browser Fullscreen and Window Focus state.
   * Uses Keyboard Lock (`Escape`) on Chromium browsers so Esc pauses combat cleanly in fullscreen.
   */
  useEffect(() => {
    const handleFs = () => {
      const fsEl = getFullscreenElement();
      const fsActive = Boolean(fsEl);
      setIsFullscreen(fsActive);
      syncEscapeKeyboardLock(fsActive && fsEl === viewportRef.current);
      simRef.current.ignoreLockDropUntilMs = Math.max(
        simRef.current.ignoreLockDropUntilMs,
        performance.now() + 350
      );
      centerViewportCursorRef.current?.(120, false);
      window.requestAnimationFrame(() => {
        centerViewportCursorRef.current?.(
          120,
          propsRef.current.isScreenActive &&
            !propsRef.current.effectivePaused &&
            !simRef.current.cursorShown &&
            propsRef.current.playerHp > 0
        );
      });
    };
    const syncFocus = () => {
      const focused = !document.hidden && document.hasFocus();
      setIsWindowFocused(focused);
      if (focused) {
        centerViewportCursorRef.current?.(95, false);
      }
    };
    const handleBlur = () => {
      setIsWindowFocused(false);
    };
    for (const evt of FULLSCREEN_CHANGE_EVENTS) {
      document.addEventListener(evt, handleFs);
    }
    window.addEventListener('focus', syncFocus);
    window.addEventListener('blur', handleBlur);
    document.addEventListener('visibilitychange', syncFocus);
    return () => {
      for (const evt of FULLSCREEN_CHANGE_EVENTS) {
        document.removeEventListener(evt, handleFs);
      }
      window.removeEventListener('focus', syncFocus);
      window.removeEventListener('blur', handleBlur);
      document.removeEventListener('visibilitychange', syncFocus);
    };
  }, []);

  /**
   * Toggles fullscreen for the simulation viewport across standard and vendor-prefixed browsers.
   */
  const toggleViewportFullscreen = () => {
    const vp = viewportRef.current;
    if (!vp) return;
    simRef.current.ignoreLockDropUntilMs = Math.max(
      simRef.current.ignoreLockDropUntilMs,
      performance.now() + 650
    );
    if (!getFullscreenElement()) {
      void requestElementFullscreen(vp).then(() => {
        if (getFullscreenElement() === vp) {
          syncEscapeKeyboardLock(true);
        }
        window.requestAnimationFrame(() => {
          centerViewportCursorRef.current?.(
            120,
            propsRef.current.isScreenActive &&
              !propsRef.current.effectivePaused &&
              !simRef.current.cursorShown &&
              propsRef.current.playerHp > 0
          );
        });
      });
    } else {
      syncEscapeKeyboardLock(false);
      void exitDocumentFullscreen().then(() => {
        window.requestAnimationFrame(() => {
          centerViewportCursorRef.current?.(
            120,
            propsRef.current.isScreenActive &&
              !propsRef.current.effectivePaused &&
              !simRef.current.cursorShown &&
              propsRef.current.playerHp > 0
          );
        });
      });
    }
  };

  // Keep pointer lock, cursor visibility, and mouse capture cleanly synced with Pause / Screen active state
  useEffect(() => {
    const s = simRef.current;
    if (effectivePaused) {
      s.lmbDown = false;
      s.mmbDown = false;
      s.rmbConsumableDown = false;
      s.shotIndexInBurst = 0;
      s.edgePanDir = 0;
      s.edgePanArmed = false;
      if (getPointerLockElement() === mountRef.current?.querySelector('canvas')) {
        s.unlockedByCtrl = true;
        safeExitPointerLock();
      }
    } else {
      s.cursorShown = false;
      s.unlockedByCtrl = false;
      s.hasPrevClientMouse = false;
      s.edgePanDir = 0;
      s.edgePanArmed = false;
      s.ignoreMouseDeltaUntilMs = performance.now() + 100;
      const canvasEl = mountRef.current?.querySelector('canvas');
      if (canvasEl) {
        const rect = (viewportRef.current ?? canvasEl).getBoundingClientRect();
        s.prevClientX = rect.left + rect.width * 0.5;
        s.prevClientY = rect.top + rect.height * 0.5;
      }
      setCursorShown(false);
    }
  }, [effectivePaused]);

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
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 1.5));
    renderer.shadowMap.enabled = !isSoftwareGl;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.tabIndex = 0;
    renderer.domElement.dataset.simCanvas = 'true';
    renderer.domElement.style.outline = 'none';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.display = 'block';
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const initEnvProfile = computeEnvironmentTimeProfile(simRef.current.skyHourCurrent);
    scene.background = initEnvProfile.fogColor.clone();
    const sceneFog = new THREE.FogExp2(initEnvProfile.fogColor.getHex(), initEnvProfile.fogDensity);
    scene.fog = sceneFog;

    /**
     * WebGL2 Skybox Dome Shader (`skyDomeMat`):
     * Renders an un-culled, depth-write-disabled sphere (`r=280m`) centered on the camera every frame
     * so it is clearly visible overhead through the corridor's tinted glass skylight roof without ever
     * needing world-space skybox scrolling or static cubemap textures.
     *
     * Uniforms are driven continuously by `computeEnvironmentTimeProfile(skyHourCurrent, weather)`:
     * - Zenith/horizon/glow gradient blends smooth day -> sunset -> night transitions.
     * - Sun & Moon discs track solar elevation angles opposite one another.
     * - Procedural hash starfield (`hash31`) twinkles at night when clouds clear.
     * - Three-octave animated storm canopy thickens (`uCloudCover`), darkens (`uCloudDarkness`), and
     *   illuminates from within during lightning strikes (`uLightningFlash`).
     *
     * Why an alternative would be worse: loading multiple high-resolution equirectangular PNG skyboxes
     * consumes tens of megabytes of VRAM, pops visibly at hour boundaries, and cannot dynamically
     * darken individual cloud layers or flash sheet lightning inside storm billows.
     */
    const skyDomeGeo = new THREE.SphereGeometry(280, 32, 20);
    const skyDomeMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uZenithColor: { value: initEnvProfile.skyZenith.clone() },
        uHorizonColor: { value: initEnvProfile.skyHorizon.clone() },
        uGlowColor: { value: initEnvProfile.skyGlow.clone() },
        uSunDir: { value: initEnvProfile.sunDirection.clone() },
        uSunStrength: { value: initEnvProfile.sunStrength },
        uMoonStrength: { value: initEnvProfile.moonStrength },
        uStarVisibility: { value: initEnvProfile.starVisibility },
        uSunsetStrength: { value: initEnvProfile.sunsetStrength },
        uCloudCover: { value: initEnvProfile.cloudCover },
        uCloudDarkness: { value: initEnvProfile.cloudDarkness },
        uLightningFlash: { value: 0 },
        uTime: { value: 0 },
      },
      vertexShader: `
        varying vec3 vSkyDir;
        void main() {
          vSkyDir = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uZenithColor;
        uniform vec3 uHorizonColor;
        uniform vec3 uGlowColor;
        uniform vec3 uSunDir;
        uniform float uSunStrength;
        uniform float uMoonStrength;
        uniform float uStarVisibility;
        uniform float uSunsetStrength;
        uniform float uCloudCover;
        uniform float uCloudDarkness;
        uniform float uLightningFlash;
        uniform float uTime;
        varying vec3 vSkyDir;

        float hash31(vec3 p) {
          p = fract(p * vec3(443.897, 441.423, 437.195));
          p += dot(p, p.yzx + 19.19);
          return fract((p.x + p.y) * p.z);
        }

        void main() {
          vec3 dir = normalize(vSkyDir);
          float h = clamp(dir.y, 0.0, 1.0);
          vec3 sky = mix(uHorizonColor, uZenithColor, pow(h, 0.52));

          // Directional sunset / dawn horizon band
          vec3 sunDir = normalize(uSunDir);
          vec2 dirXZ = normalize(vec2(dir.x, dir.z) + vec2(0.0001));
          vec2 sunXZ = normalize(vec2(sunDir.x, sunDir.z) + vec2(0.0001));
          float sunAzimuth = max(dot(dirXZ, sunXZ), 0.0);
          float horizonBand = exp(-abs(dir.y) * 7.5);
          sky += uGlowColor * horizonBand * (0.28 + 0.72 * pow(sunAzimuth, 2.0)) * uSunsetStrength * 0.85;

          // Solar disc + corona (underneath cloud canopy)
          float sunCos = dot(dir, sunDir);
          float sunAbove = smoothstep(-0.08, 0.14, sunDir.y);
          float corona = pow(max(sunCos, 0.0), 22.0) * 0.55;
          float sunDisc = smoothstep(0.9972, 0.9992, sunCos) * 2.2;
          sky += uGlowColor * (corona + sunDisc) * uSunStrength * sunAbove;

          // Lunar disc + cool aura opposite solar arc
          vec3 moonDir = normalize(vec3(-sunDir.x, max(0.30, -sunDir.y * 0.75 + 0.36), -sunDir.z));
          float moonCos = dot(dir, moonDir);
          float moonHalo = pow(max(moonCos, 0.0), 38.0) * 0.28;
          float moonDisc = smoothstep(0.9985, 0.9995, moonCos) * 1.15;
          sky += vec3(0.76, 0.86, 1.0) * (moonHalo + moonDisc) * uMoonStrength;

          // Procedural night starfield
          if (uStarVisibility > 0.01 && dir.y > 0.03) {
            vec3 cell = floor(dir * 165.0);
            float rnd = hash31(cell);
            if (rnd > 0.9915) {
              vec3 cellCenter = normalize(cell + 0.5);
              float dist = length(dir - cellCenter) * 165.0;
              float star = smoothstep(0.38, 0.04, dist);
              float twinkle = 0.68 + 0.32 * sin(uTime * 1.6 + rnd * 120.0);
              sky += vec3(0.84, 0.92, 1.0) * star * twinkle * uStarVisibility * smoothstep(0.03, 0.24, dir.y);
            }
          }

          // Multi-octave rolling cloud & storm canopy (darkens cleanly for rain / thunderclouds)
          float cloudDensity = 0.0;
          if (dir.y > 0.01) {
            vec2 uv = dir.xz / (dir.y + 0.24) * 1.35;
            float n1 = sin(uv.x * 1.9 + uTime * 0.045) * cos(uv.y * 1.7 - uTime * 0.032);
            float n2 = 0.55 * sin(uv.x * 4.1 - uv.y * 2.9 + uTime * 0.068);
            float n3 = 0.28 * cos(uv.x * 7.8 + uv.y * 6.4 - uTime * 0.095);
            float rawNoise = (n1 + n2 + n3) * 0.5 + 0.5;
            float thresh = mix(0.72, 0.08, clamp(uCloudCover, 0.0, 1.0));
            cloudDensity = smoothstep(thresh, thresh + 0.42, rawNoise) * smoothstep(0.01, 0.22, dir.y);

            vec3 fairCloud = mix(uHorizonColor * 1.18, uGlowColor, 0.35 + 0.45 * uSunsetStrength);
            vec3 darkStormCloud = vec3(0.045, 0.058, 0.085);
            vec3 cloudCol = mix(fairCloud, darkStormCloud, clamp(uCloudDarkness, 0.0, 1.0));
            // Lightning sheet illumination pulsing inside storm cloud billows
            cloudCol += vec3(0.55, 0.72, 1.0) * uLightningFlash * (0.35 + 0.65 * rawNoise);

            float cloudAlpha = cloudDensity * mix(0.32, 0.94, clamp(uCloudCover, 0.0, 1.0));
            sky = mix(sky, cloudCol, cloudAlpha);
          }

          // Sky-wide ambient lightning pulse
          sky += vec3(0.42, 0.58, 0.92) * uLightningFlash * (0.18 + 0.36 * cloudDensity);

          gl_FragColor = vec4(sky, 1.0);
        }
      `,
    });
    const skyDome = new THREE.Mesh(skyDomeGeo, skyDomeMat);
    skyDome.frustumCulled = false;
    skyDome.renderOrder = -10;
    scene.add(skyDome);

    // Pooled 3D Rain Streaks (single LineSegments draw call + drawRange scaling vs 1,400 Mesh objects)
    const MAX_RAIN_DROPS = 1400;
    const rainPos = new Float32Array(MAX_RAIN_DROPS * 6);
    const rainX = new Float32Array(MAX_RAIN_DROPS);
    const rainY = new Float32Array(MAX_RAIN_DROPS);
    const rainZ = new Float32Array(MAX_RAIN_DROPS);
    const rainSpeed = new Float32Array(MAX_RAIN_DROPS);
    for (let i = 0; i < MAX_RAIN_DROPS; i++) {
      rainX[i] = (Math.random() - 0.5) * 58;
      rainY[i] = 5.4 + Math.random() * 20;
      rainZ[i] = (Math.random() - 0.5) * 86;
      rainSpeed[i] = 0.85 + Math.random() * 0.4;
    }
    const rainGeo = new THREE.BufferGeometry();
    rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
    rainGeo.setDrawRange(0, 0);
    const rainMat = new THREE.LineBasicMaterial({
      color: 0xb6dcf8,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
    });
    const rainLines = new THREE.LineSegments(rainGeo, rainMat);
    rainLines.frustumCulled = false;
    rainLines.visible = false;
    scene.add(rainLines);

    // Pooled Glass Skylight Roof Raindrop Splash Ripples (single InstancedMesh draw call)
    const SPLASH_COUNT = 44;
    const splashGeo = new THREE.RingGeometry(0.08, 0.14, 12);
    splashGeo.rotateX(-Math.PI / 2);
    const splashMat = new THREE.MeshBasicMaterial({
      color: 0xcbe8ff,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const splashMesh = new THREE.InstancedMesh(splashGeo, splashMat, SPLASH_COUNT);
    splashMesh.frustumCulled = false;
    splashMesh.visible = false;
    const splashData = Array.from({ length: SPLASH_COUNT }, (_, idx) => ({
      x: (Math.random() - 0.5) * 22,
      z: -Math.random() * 80,
      phase: (idx / SPLASH_COUNT) * 1.0,
    }));
    const splashDummy = new THREE.Object3D();
    scene.add(splashMesh);

    // 3D Jagged Sky Lightning Bolt (visible overhead through the corridor glass roof)
    const BOLT_POINTS = 10;
    const boltPos = new Float32Array(BOLT_POINTS * 3);
    const boltGeo = new THREE.BufferGeometry();
    boltGeo.setAttribute('position', new THREE.BufferAttribute(boltPos, 3));
    const boltMat = new THREE.LineBasicMaterial({
      color: 0xdff2ff,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    });
    const boltLine = new THREE.Line(boltGeo, boltMat);
    boltLine.frustumCulled = false;
    boltLine.visible = false;
    scene.add(boltLine);

    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    const width = Math.max(320, container.clientWidth);
    const height = Math.max(240, container.clientHeight);
    renderer.setSize(width, height, false);

    const camera = new THREE.PerspectiveCamera(62, width / height, 0.05, 380);
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

    const lightningLight = new THREE.DirectionalLight(0xc8e4ff, 0);
    lightningLight.position.set(6, 26, -32);
    scene.add(lightningLight);

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
    const initialViewKey =
      propsRef.current.config.activeSlot === 'CONSUMABLE'
        ? `CONSUMABLE:${propsRef.current.config.grenadeId}`
        : `WEAPON:${propsRef.current.config.weaponId}`;
    let currentWeapon3D: BuiltWeapon3D =
      propsRef.current.config.activeSlot === 'CONSUMABLE'
        ? buildConsumableViewmodel3D(propsRef.current.config.grenadeId)
        : buildWeaponViewmodel3D(propsRef.current.config.weaponId);
    weaponAnchor.add(currentWeapon3D.root);
    weaponAnchor.position.copy(currentWeapon3D.hipOffset);
    simRef.current.weaponIdBuilt = initialViewKey;

    // Shared projectile, grenade, debris, & pooled impact geometries
    const droneBoltGeo = new THREE.SphereGeometry(0.11, 8, 8);
    const grenadeBodyGeo = new THREE.CylinderGeometry(0.08, 0.08, 0.22, 10);
    const explosionSphereGeo = new THREE.SphereGeometry(1, 14, 10);
    const debrisGeo = new THREE.BoxGeometry(0.28, 0.24, 0.16);
    const debrisMat = new THREE.MeshStandardMaterial({
      color: 0x566070,
      roughness: 0.45,
      metalness: 0.8,
    });

    /**
     * Fixed-size Object Pools for Bullet Impact Sparks (42) and Scorch Decals (48):
     * Allocating all meshes and shared materials once at initialization guarantees zero per-shot
     * heap allocations and zero GPU buffer creation spikes during high-RPM shotgun/LMG bursts.
     *
     * Why an alternative would be worse: calling `new THREE.Mesh(...)` and `scene.add(...)` on every
     * shotgun pellet hit creates 32+ meshes per trigger pull and triggers frequent GC stalls.
     */
    const impactSparkGeo = new THREE.BoxGeometry(0.045, 0.045, 0.09);
    const impactSparkMat = new THREE.MeshBasicMaterial({ color: 0xffc857 });
    const impactDecalGeo = new THREE.CircleGeometry(0.085, 8);
    const impactDecalMat = new THREE.MeshBasicMaterial({
      color: 0x1a1512,
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });
    const sparkPool: ImpactSpark3D[] = [];
    for (let i = 0; i < 42; i++) {
      const m = new THREE.Mesh(impactSparkGeo, impactSparkMat);
      m.visible = false;
      scene.add(m);
      sparkPool.push({ mesh: m, vx: 0, vy: 0, vz: 0, life: 0, active: false });
    }
    const decalPool: ImpactDecal3D[] = [];
    for (let i = 0; i < 48; i++) {
      const m = new THREE.Mesh(impactDecalGeo, impactDecalMat);
      m.visible = false;
      scene.add(m);
      decalPool.push({ mesh: m, life: 0, active: false });
    }
    simRef.current.impactSparks = sparkPool;
    simRef.current.impactDecals = decalPool;

    // Pre-allocated cover damage tint shades
    const _wearDarkRust = new THREE.Color(0x3a1c13);
    const _wearWorkColor = new THREE.Color();

    /**
     * Clears transient projectiles/explosion rings between waves.
     * Only disposes placed mines, laser mines, C4, sentry turrets, and 40s loot drops when
     * `clearDeployables === true` (room switch or explicit new run), preserving persistent traps across waves.
     */
    const clearDynamicProjectiles = (clearDeployables = false) => {
      const s = simRef.current;
      for (const proj of s.droneProjectiles) {
        scene.remove(proj.mesh);
        (proj.mesh.material as THREE.Material).dispose();
      }
      s.droneProjectiles = [];
      for (const r of s.explosionRings) {
        scene.remove(r.mesh);
        (r.mesh.material as THREE.Material).dispose();
      }
      s.explosionRings = [];

      if (clearDeployables) {
        for (const sp of s.impactSparks) {
          sp.active = false;
          sp.mesh.visible = false;
        }
        for (const dc of s.impactDecals) {
          dc.active = false;
          dc.mesh.visible = false;
        }
        for (const g of s.thrownGrenades) {
          scene.remove(g.mesh);
          disposeObject3D(g.mesh);
        }
        s.thrownGrenades = [];
        for (const z of s.incendiaryZones) {
          scene.remove(z.group);
          disposeObject3D(z.group);
        }
        s.incendiaryZones = [];
        for (const m of s.tripMines) {
          scene.remove(m.mesh);
          disposeObject3D(m.mesh);
        }
        s.tripMines = [];
        for (const lm of s.laserMines) {
          scene.remove(lm.mesh);
          disposeObject3D(lm.mesh);
        }
        s.laserMines = [];
        for (const c4 of s.stickyC4s) {
          scene.remove(c4.mesh);
          disposeObject3D(c4.mesh);
        }
        s.stickyC4s = [];
        for (const tur of s.turrets) {
          scene.remove(tur.mesh);
          disposeObject3D(tur.mesh);
        }
        s.turrets = [];
        s.pendingChainDetonations = [];
        for (const ab of s.ammoBoxes) {
          scene.remove(ab.mesh);
          disposeObject3D(ab.mesh);
        }
        s.ammoBoxes = [];
        for (const cb of s.consumableBoxes) {
          scene.remove(cb.mesh);
          disposeObject3D(cb.mesh);
        }
        s.consumableBoxes = [];
        s.killsSinceAmmoDrop = 0;
        s.ammoToastTimer = 0;
        setAmmoToast(null);
        setPlantedC4Count(0);
        setActiveTurretCount(0);
      }
    };

    const spawnEnemyActor = (
      profile: TargetProfile,
      groupLabel: string,
      uid: number,
      encounterId: number,
      hp: number,
      spawnX: number,
      spawnZ: number,
      doorSide: 'west' | 'east' | 'north' | null,
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

      const rangedSpec = model.loadout.rangedWeaponId
        ? ENEMY_WEAPONS[model.loadout.rangedWeaponId]
        : null;
      const podSpec = model.loadout.rocketPodWeaponId
        ? ENEMY_WEAPONS[model.loadout.rocketPodWeaponId]
        : null;

      s.enemies.push({
        uid,
        encounterId,
        profile,
        groupLabel,
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
        meleeDist:
          (1.75 + (uid % 3) * 0.16) *
          Math.min(1.18, Math.max(0.95, profile.scaleXZ * 0.88)),
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
        lungeCooldown:
          profile.silhouette === 'brute'
            ? 0.9 + (uid % 3) * 0.35
            : 1.8 + (uid % 5) * 0.65,
        lungeDirX: 0,
        lungeDirZ: 0,
        retreatTimer: 0,
        swarmAngle: (uid * 2.399963) % (Math.PI * 2),
        burnCooldown: 0,
        burnSlowTimer: 0,
        loadout: model.loadout,
        shieldHp: model.loadout.shieldMaxHp,
        shieldMaxHp: model.loadout.shieldMaxHp,
        components: buildInitialEnemyComponents(profile, hp),
        regionFlashTimers: {
          head: 0,
          torso: 0,
          leftArm: 0,
          rightArm: 0,
          leftLeg: 0,
          rightLeg: 0,
          shield: 0,
        },
        rangedMag: rangedSpec ? rangedSpec.magSize : 0,
        rangedReloadTimer: 0,
        rangedFireCooldown: 0.65 + (uid % 5) * 0.28,
        rangedRecoilDeg: 0,
        podMag: podSpec ? podSpec.magSize : 0,
        podReloadTimer: 0,
        podCooldown: 1.4 + (uid % 4) * 0.4,
        meleeComboIdx: 0,
        coverTarget: null,
        coverRepickTimer: (uid % 3) * 0.3,
        lastEffectiveAccuracy: 1,
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
      const spreadAlongX = door.side === 'north';
      for (let i = 0; i < 12; i++) {
        const mesh = new THREE.Mesh(debrisGeo, debrisMat);
        mesh.position.set(
          door.breachOrigin.x + (spreadAlongX ? (Math.random() - 0.5) * 6.5 : (Math.random() - 0.5) * 0.4),
          0.5 + Math.random() * 2.4,
          door.breachOrigin.z + (spreadAlongX ? (Math.random() - 0.5) * 0.4 : (Math.random() - 0.5) * 3.8)
        );
        scene.add(mesh);
        s.doorDebris.push({
          mesh,
          vx: spreadAlongX
            ? (Math.random() - 0.5) * 4.5
            : door.breachNormal.x * (3.5 + Math.random() * 4.5),
          vy: 1.5 + Math.random() * 4.0,
          vz: spreadAlongX
            ? door.breachNormal.z * (4.2 + Math.random() * 4.8)
            : (Math.random() - 0.5) * 4.2,
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

    const resetBreakableCover = (cov: BreakableCover3D) => {
      cov.hp = cov.maxHp;
      cov.broken = false;
      cov.flashTimer = 0;
      cov.group.visible = true;
      cov.hitMesh.visible = true;
      cov.panelMat.color.setHex(0x3a4354);
      cov.panelMat.emissive.setHex(0x000000);
      cov.panelMat.emissiveIntensity = 0;
    };

    const damageCover = (cov: BreakableCover3D, dmg: number) => {
      if (cov.broken) return;
      cov.hp = Math.max(0, cov.hp - dmg);
      cov.flashTimer = 0.12;
      cov.panelMat.emissive.setHex(0xffb300);
      cov.panelMat.emissiveIntensity = 0.65;
      const ratio = cov.hp / Math.max(1, cov.maxHp);
      _wearWorkColor.setHex(0x3a4354).lerp(_wearDarkRust, (1 - ratio) * 0.85);
      cov.panelMat.color.copy(_wearWorkColor);

      if (cov.hp <= 0) {
        cov.broken = true;
        cov.group.visible = false;
        cov.hitMesh.visible = false;
        soundEngine.playDoorBreak();
        const s = simRef.current;
        for (let i = 0; i < 6; i++) {
          const mesh = new THREE.Mesh(debrisGeo, debrisMat);
          mesh.position.set(
            cov.x + (Math.random() - 0.5) * cov.halfW * 1.6,
            0.3 + Math.random() * cov.height * 0.8,
            cov.z + (Math.random() - 0.5) * cov.halfD * 1.6
          );
          scene.add(mesh);
          s.doorDebris.push({
            mesh,
            vx: (Math.random() - 0.5) * 4.2,
            vy: 1.4 + Math.random() * 3.2,
            vz: (Math.random() - 0.5) * 4.2,
            rx: (Math.random() - 0.5) * 10,
            ry: (Math.random() - 0.5) * 10,
            life: 1.1,
          });
        }
      }
    };

    /**
     * Preserves factory enemy chassis material colors on hit (localized part color shifting removed).
     * Bullet impact feedback relies on kinetic spark bursts (`spawnBulletImpact`), floating damage
     * numbers, destructible arm/head/pod detachments, and HUD component flags instead of full-part
     * hull color tinting.
     */
    const updateRegionWeathering = (actor: EnemyActor, region: BodyRegionKey) => {
      actor.regionFlashTimers[region] = 0.06;
    };

    /**
     * Activates pooled spark streaks (`sparkPool`) and, on static geometry (`ENV`/`COVER`), places a
     * round scorch decal from the ring buffer (`decalPool`) aligned to the surface world normal.
     */
    const spawnBulletImpact = (
      point: THREE.Vector3,
      normal: THREE.Vector3 | null,
      surfaceKind: 'ENV' | 'COVER' | 'ENEMY' | 'SHIELD'
    ) => {
      const s = simRef.current;
      const nx = normal ? normal.x : 0;
      const ny = normal ? normal.y : 1;
      const nz = normal ? normal.z : 0;

      const sparkCount = surfaceKind === 'SHIELD' ? 4 : surfaceKind === 'ENEMY' ? 3 : 2;
      let spawned = 0;
      for (let i = 0; i < s.impactSparks.length && spawned < sparkCount; i++) {
        const sp = s.impactSparks[i];
        if (sp.active) continue;
        sp.active = true;
        sp.life = 0.22 + Math.random() * 0.14;
        sp.mesh.position.set(point.x + nx * 0.03, point.y + ny * 0.03, point.z + nz * 0.03);
        const speed = surfaceKind === 'SHIELD' ? 6.5 : 4.4;
        sp.vx = (nx + (Math.random() - 0.5) * 1.4) * speed;
        sp.vy = (ny + Math.random() * 0.9) * speed * 0.85;
        sp.vz = (nz + (Math.random() - 0.5) * 1.4) * speed;
        sp.mesh.lookAt(point.x + sp.vx, point.y + sp.vy, point.z + sp.vz);
        sp.mesh.scale.setScalar(surfaceKind === 'SHIELD' ? 1.3 : 0.95);
        sp.mesh.visible = true;
        spawned += 1;
      }

      // Leave scorch/bullet mark decals on static walls, covers, doors, and floor
      if (surfaceKind === 'ENV' || surfaceKind === 'COVER') {
        const idx = s.nextDecalIdx % s.impactDecals.length;
        s.nextDecalIdx += 1;
        const dc = s.impactDecals[idx];
        dc.active = true;
        dc.life = 14.0;
        dc.mesh.position.set(
          point.x + nx * 0.018,
          Math.max(0.018, point.y + ny * 0.018),
          point.z + nz * 0.018
        );
        _vec3C.set(point.x + nx * 2, point.y + ny * 2, point.z + nz * 2);
        dc.mesh.lookAt(_vec3C);
        dc.mesh.scale.setScalar(0.85 + Math.random() * 0.45);
        dc.mesh.visible = true;
      }
    };

    /**
     * Rebuilds the active enemy wave while respecting selective scene persistence:
     * - Reuses the existing Three.js room/covers/doors and player coordinates across normal waves.
     * - Clears old defeated enemy skeletons cleanly via `disposeObject3D`, while keeping active
     *   deployables (`tripMines`, `laserMines`, `stickyC4s`, `turrets`) and 40s loot drops alive unless
     *   `clearDeployablesPending` was set by a full New Game reset or room change.
     * - Partitions the roster into staggered `PendingSpawn` cohorts (6s group delays behind doors) so
     *   20-hostile waves escalate dynamically without starving single-frame CPU budgets.
     */
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
        s.playerVelX = 0;
        s.playerVelZ = 0;
        s.playerSpeed = 0;
        s.playerRunAnticipationTimer = 0;
        s.aimYaw = currentRoom.playerSpawn.yaw;
        s.targetAimYaw = currentRoom.playerSpawn.yaw;
        s.aimPitch = -0.02;
        s.targetAimPitch = -0.02;
        s.recoilYaw = 0;
        s.recoilPitch = 0;
        s.recoilHeat = 0;
        s.cameraMeleeYaw = 0;
        s.cameraMeleePitch = 0;
        s.cameraMeleeRoll = 0;
        s.edgePanDir = 0;
        s.edgePanArmed = false;
        s.hasPrevClientMouse = false;
        s.ignoreMouseDeltaUntilMs = Math.max(s.ignoreMouseDeltaUntilMs, performance.now() + 120);
        camera.position.set(s.playerX, 1.65, s.playerZ);
        camera.rotation.order = 'YXZ';
        camera.rotation.set(s.aimPitch, s.aimYaw, 0);
        s.resetPlayerPosPending = false;
      }

      for (const actor of s.enemies) {
        scene.remove(actor.model.root);
        disposeObject3D(actor.model.root);
      }
      s.enemies = [];
      s.pendingSpawns = [];
      clearDynamicProjectiles(s.clearDeployablesPending);
      s.clearDeployablesPending = false;

      // Broken doors & covers persist across waves; only reset on room switch or explicit squad reset
      if (s.resetDoorsPending) {
        resetBreakableDoor(currentRoom.westDoor);
        resetBreakableDoor(currentRoom.eastDoor);
        resetBreakableDoor(currentRoom.northDoor);
        for (const cov of currentRoom.covers) {
          resetBreakableCover(cov);
        }
        s.resetDoorsPending = false;
      }

      const spawnCount = p.waveGroupSize;
      const roster = buildSquadRoster(
        cfg.targetId,
        spawnCount,
        cfg.mixedGroup,
        p.targets,
        cfg.chassisSpawnCounts
      );
      // Corridor splits into 4 escalating difficulty groups staggered by 6s each; Room 2 uses 3 groups
      const tieredRoster =
        cfg.roomId === 'corridor_01'
          ? partitionRosterIntoDifficultyGroups(roster, 4, 6.0)
          : partitionRosterIntoDifficultyGroups(roster);
      s.totalSpawnedThisWave = tieredRoster.length;
      s.nextWaveTimerSec = null;
      setNextWaveCountdownSec(null);

      if (cfg.roomId === 'double_flank_02') {
        tieredRoster.forEach((assign, idx) => {
          const { profile, groupLabel, extraGroupDelaySec } = assign;
          const encounterId = s.nextEncounterId++;
          const side: 'west' | 'east' = idx % 2 === 0 ? 'west' : 'east';
          const entrance = getDoubleFlankEntranceData(side, idx);
          const hp = profile.defaultHp;
          const delaySec = idx === 0 ? 0 : idx * 6.0 + extraGroupDelaySec;

          if (delaySec <= 0.01) {
            spawnEnemyActor(
              profile,
              groupLabel,
              idx,
              encounterId,
              hp,
              entrance.spawnX,
              entrance.spawnZ,
              side,
              entrance.waypoints
            );
          } else {
            s.pendingSpawns.push({
              uid: idx,
              encounterId,
              profile,
              groupLabel,
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
        // Single Corridor (24m x 120m): 4 difficulty groups spawning behind the north blast door at 6s stagger per group
        tieredRoster.forEach((assign, idx) => {
          const { profile, groupLabel, extraGroupDelaySec } = assign;
          const encounterId = s.nextEncounterId++;
          const col = idx % 6;
          const row = Math.floor(idx / 6);
          const spawnX = (col - 2.5) * 2.5 + ((idx % 2) - 0.5) * 0.35;
          const spawnZ = -119.5 - row * 0.72;
          const hp = profile.defaultHp;
          const delaySec = extraGroupDelaySec;

          if (delaySec <= 0.01) {
            spawnEnemyActor(
              profile,
              groupLabel,
              idx,
              encounterId,
              hp,
              spawnX,
              spawnZ,
              'north',
              []
            );
          } else {
            s.pendingSpawns.push({
              uid: idx,
              encounterId,
              profile,
              groupLabel,
              delayRemainingSec: delaySec,
              hp,
              spawnX,
              spawnZ,
              doorSide: 'north',
              waypoints: [],
            });
          }
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

    const projectWorldToScreenPct = (
      wx: number,
      wy: number,
      wz: number
    ): { screenX: number; screenY: number; visible: boolean } => {
      _vec3C.set(wx, wy, wz).project(camera);
      const sx = (_vec3C.x * 0.5 + 0.5) * 100;
      const sy = (-_vec3C.y * 0.5 + 0.5) * 100;
      const visible = _vec3C.z > -1 && _vec3C.z < 1 && sx >= 2 && sx <= 98 && sy >= 4 && sy <= 94;
      return { screenX: sx, screenY: sy, visible };
    };

    const pushHitVisuals = (
      totalHpDamage: number,
      anyCrit: boolean,
      anyKill: boolean,
      anyStagger: boolean,
      pierceCount: number,
      worldPos?: { x: number; y: number; z: number }
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
      const wx = worldPos?.x ?? s.playerX;
      const wy = worldPos?.y ?? 1.8;
      const wz = worldPos?.z ?? s.playerZ - 4;
      const proj = projectWorldToScreenPct(wx, wy, wz);
      const jitterX = ((pulseId % 5) - 2) * 8;
      const jitterY = ((pulseId % 3) - 1) * 7;

      const labelEntry: FloatingHitLabel = {
        id: pulseId,
        worldX: wx,
        worldY: wy,
        worldZ: wz,
        jitterX,
        jitterY,
        screenX: proj.screenX,
        screenY: proj.screenY,
        visible: proj.visible,
        text: labelText,
        color: labelColor,
        isWeakspot: anyCrit,
        isKill: anyKill,
        createdAt: nowHit,
      };

      s.floatingHitsRef = [...s.floatingHitsRef.slice(-11), labelEntry];
      setFloatingHits(s.floatingHitsRef);
    };

    /** Drops ammo (-15% rate) and/or a smaller-chance consumable ordnance box on enemy kill. */
    const maybeDropLootOnKill = (actor: EnemyActor) => {
      const s = simRef.current;
      s.killsSinceAmmoDrop += 1;
      const sil = actor.profile.silhouette;
      // Ammo drop chance lowered by 15% across all archetypes
      const baseAmmoChance =
        (sil === 'titan' || sil === 'tank'
          ? 0.65
          : sil === 'brute' || sil === 'exo'
            ? 0.42
            : 0.28) * 0.85;

      let droppedAmmo = false;
      if (s.killsSinceAmmoDrop >= 6 || Math.random() <= baseAmmoChance) {
        droppedAmmo = true;
        s.killsSinceAmmoDrop = 0;

        if (s.ammoBoxes.length >= 18) {
          const oldest = s.ammoBoxes.shift();
          if (oldest) {
            scene.remove(oldest.mesh);
            disposeObject3D(oldest.mesh);
          }
        }

        const boxMesh = buildAmmoBox3D();
        const startY = actor.profile.silhouette === 'drone' ? 1.55 : 0.35;
        boxMesh.position.set(actor.x, startY, actor.z);
        boxMesh.rotation.y = Math.random() * Math.PI * 2;
        scene.add(boxMesh);

        s.ammoBoxes.push({
          mesh: boxMesh,
          beacon: boxMesh.getObjectByName('ammoBeacon') ?? null,
          x: actor.x,
          y: startY,
          z: actor.z,
          vy: 2.2,
          spinPhase: Math.random() * Math.PI * 2,
          remainingSec: 40,
        });
      }

      // Smaller drop rate for Consumable Supply Boxes (+2 usages of consumable weapons)
      const consumableChance =
        sil === 'titan' || sil === 'tank'
          ? 0.24
          : sil === 'brute' || sil === 'exo'
            ? 0.15
            : 0.09;
      if (Math.random() <= consumableChance) {
        if (s.consumableBoxes.length >= 12) {
          const oldest = s.consumableBoxes.shift();
          if (oldest) {
            scene.remove(oldest.mesh);
            disposeObject3D(oldest.mesh);
          }
        }
        const cMesh = buildConsumableBox3D();
        const startY = actor.profile.silhouette === 'drone' ? 1.55 : 0.35;
        const offsetX = droppedAmmo ? 0.58 : 0;
        cMesh.position.set(actor.x + offsetX, startY, actor.z);
        cMesh.rotation.y = Math.random() * Math.PI * 2;
        scene.add(cMesh);

        s.consumableBoxes.push({
          mesh: cMesh,
          beacon: cMesh.getObjectByName('consumableBeacon') ?? null,
          x: actor.x + offsetX,
          y: startY,
          z: actor.z,
          vy: 2.4,
          spinPhase: Math.random() * Math.PI * 2,
          remainingSec: 40,
        });
      }
    };

    const applyDamageAndStagger = (
      actor: EnemyActor,
      nextHp: number,
      staggerDamage: number,
      staggerDurationOverrideMult = 1.0
    ): { killed: boolean; triggeredStagger: boolean; enemyTtkMs: number | null } => {
      const nowMs = performance.now();
      if (actor.hp > nextHp && actor.firstDamagedAtMs === null) {
        actor.firstDamagedAtMs = nowMs;
      }
      actor.hp = nextHp;
      if (actor.hp <= 0) {
        const wasAlive = actor.alive;
        actor.alive = false;
        actor.staggerTimer = 0;
        actor.clawAnimType = 'NONE';
        if (wasAlive) {
          maybeDropLootOnKill(actor);
        }
        const enemyTtkMs = Math.max(
          1,
          Math.round(nowMs - (actor.firstDamagedAtMs ?? nowMs))
        );
        return { killed: true, triggeredStagger: false, enemyTtkMs };
      }

      if (staggerDamage > 0 && (actor.staggerTimer <= 0 || staggerDurationOverrideMult > 1.0)) {
        actor.staggerHp = Math.max(0, actor.staggerHp - staggerDamage);
        if (actor.staggerHp <= 0) {
          actor.staggerTimer = Math.max(
            actor.staggerTimer,
            actor.profile.staggerDurationSec * staggerDurationOverrideMult
          );
          actor.clawAnimType = 'NONE';
          actor.lungeState = 'NONE';
          actor.attackCooldown = Math.max(actor.attackCooldown, 0.5);
          soundEngine.playEnemyStagger();
          return { killed: false, triggeredStagger: true, enemyTtkMs: null };
        }
      }
      return { killed: false, triggeredStagger: false, enemyTtkMs: null };
    };

    /**
     * Evaluates whether the active wave and pending spawn queue are completely cleared.
     * Triggers the "You won!" screen upon clearing Wave 5, or starts the 12s inter-wave countdown otherwise.
     */
    const checkSquadCleared = () => {
      const s = simRef.current;
      const p = propsRef.current;
      if (s.pendingSpawns.length > 0) return;
      const anyLeft = s.enemies.some((e) => e.alive);
      if (!anyLeft && !s.squadClearedNotified) {
        s.squadClearedNotified = true;
        if (p.playerHp > 0) {
          if (p.waveNumber === 5 && !s.wave5VictoryShown) {
            s.wave5VictoryShown = true;
            s.nextWaveTimerSec = null;
            setNextWaveCountdownSec(null);
            setWave5Won(true);
            if (getPointerLockElement() === dom) {
              safeExitPointerLock();
            }
          } else {
            // 12s inter-wave cooldown before next wave begins
            s.nextWaveTimerSec = 12.0;
            setNextWaveCountdownSec(12.0);
          }
        }
        p.onSquadCleared();
      }
    };

    const getDoorBySide = (side?: 'west' | 'east' | 'north' | null): BreakableDoor3D | null => {
      if (side === 'west') return currentRoom.westDoor;
      if (side === 'east') return currentRoom.eastDoor;
      if (side === 'north') return currentRoom.northDoor;
      return null;
    };

    const spawnExplosionRing = (x: number, y: number, z: number, colorHex: number, maxScale: number) => {
      const mat = new THREE.MeshBasicMaterial({
        color: colorHex,
        transparent: true,
        opacity: 0.72,
        wireframe: true,
      });
      const mesh = new THREE.Mesh(explosionSphereGeo, mat);
      mesh.position.set(x, y, z);
      mesh.scale.setScalar(0.35);
      scene.add(mesh);
      simRef.current.explosionRings.push({
        mesh,
        life: 0.36,
        maxLife: 0.36,
        maxScale,
      });
    };

    /** Triggers a volatile torso Power Supply or Battery detonation damaging hostiles, player, and covers. */
    const triggerComponentExplosion = (
      actor: EnemyActor,
      reason: 'POWER_SUPPLY' | 'BATTERY'
    ) => {
      const s = simRef.current;
      const p = propsRef.current;
      const comp = actor.components;
      if (reason === 'POWER_SUPPLY') {
        if (comp.powerSupplyExploded) return;
        comp.powerSupplyExploded = true;
      } else {
        if (comp.batteryExploded) return;
        comp.batteryExploded = true;
      }

      const blastY = Math.max(0.7, actor.profile.scaleY * 1.15);
      const radiusM = reason === 'POWER_SUPPLY' ? 4.8 : 4.2;
      const maxSplash = reason === 'POWER_SUPPLY' ? 145 : 110;

      soundEngine.playReactorExplosion();
      spawnExplosionRing(
        actor.x,
        blastY,
        actor.z,
        reason === 'POWER_SUPPLY' ? 0xff4500 : 0x00f0ff,
        radiusM
      );
      s.cameraShake = Math.max(s.cameraShake, reason === 'POWER_SUPPLY' ? 0.92 : 0.72);

      // Kill source mech immediately on Power Supply rupture, or inflict heavy core shock on Battery failure
      if (actor.alive) {
        if (reason === 'POWER_SUPPLY') {
          applyDamageAndStagger(actor, 0, 0);
          pushHitVisuals(Math.max(1, actor.hp), true, true, false, 0, {
            x: actor.x,
            y: blastY + 0.45,
            z: actor.z,
          });
        } else {
          const selfDmg = Math.max(20, Math.round(actor.maxHp * 0.48));
          const selfOut = applyDamageAndStagger(actor, Math.max(0, actor.hp - selfDmg), 45);
          pushHitVisuals(selfDmg, true, selfOut.killed, selfOut.triggeredStagger, 0, {
            x: actor.x,
            y: blastY + 0.4,
            z: actor.z,
          });
        }
      }

      // Splash nearby enemies
      for (const other of s.enemies) {
        if (!other.alive || other === actor) continue;
        const d = Math.hypot(other.x - actor.x, other.z - actor.z);
        if (d <= radiusM + 0.55 * other.profile.scaleXZ) {
          const falloff = THREE.MathUtils.clamp(1 - d / Math.max(1, radiusM + 0.6), 0.35, 1.0);
          const splashDmg = Math.max(8, Math.round(maxSplash * falloff));
          const out = applyDamageAndStagger(other, Math.max(0, other.hp - splashDmg), Math.round(splashDmg * 0.5));
          pushHitVisuals(splashDmg, false, out.killed, out.triggeredStagger, 0, {
            x: other.x,
            y: other.profile.scaleY * 1.4,
            z: other.z,
          });
        }
      }

      // Damage nearby breakable covers & chain planted ordnance & turrets
      for (const cov of currentRoom.covers) {
        if (!cov.broken && Math.hypot(cov.x - actor.x, cov.z - actor.z) <= radiusM + 1.0) {
          damageCover(cov, Math.round(maxSplash * 0.6));
        }
      }
      for (let ti = s.turrets.length - 1; ti >= 0; ti--) {
        const tur = s.turrets[ti];
        const td = Math.hypot(tur.pos.x - actor.x, tur.pos.z - actor.z);
        if (td <= radiusM + 0.8) {
          const tf = THREE.MathUtils.clamp(1 - td / (radiusM + 0.8), 0.35, 1.0);
          damageDeployableTurret(tur, Math.round(maxSplash * tf));
        }
      }
      queueChainExplosions(actor.x, blastY, actor.z, radiusM);

      // Splash player if caught near the rupturing power supply / battery
      if (p.playerHp > 0) {
        const distPlayer = Math.hypot(s.playerX - actor.x, s.playerZ - actor.z);
        if (distPlayer <= radiusM + 0.5) {
          const pFalloff = THREE.MathUtils.clamp(1 - distPlayer / (radiusM + 0.5), 0.3, 1.0);
          const pDmg = Math.max(4, Math.round((reason === 'POWER_SUPPLY' ? 26 : 21) * pFalloff));
          setDamageFlashAlpha((prev) => Math.max(prev, 0.42));
          s.playerHitSlowTimer = Math.max(s.playerHitSlowTimer, 0.35);
          p.onEnemyWeaponAttack(
            'ENEMY_EXPLOSION',
            pDmg,
            actor.profile.name,
            reason === 'POWER_SUPPLY' ? 'Power Supply Rupture' : 'Battery Overload',
            Math.max(1, Math.round(distPlayer))
          );
        }
      }
      checkSquadCleared();
    };

    /** Detonates an enemy head assembly, hiding head meshes and eliminating the mech if still alive. */
    const triggerHeadExplosion = (actor: EnemyActor) => {
      const comp = actor.components;
      if (comp.headExploded) return;
      comp.headExploded = true;
      comp.headHp = 0;
      comp.capacitors.head = 0;
      comp.viewingLensHp = 0;

      if (actor.model.headGroup) {
        actor.model.headGroup.visible = false;
        actor.model.headGroup.traverse((obj) => {
          obj.visible = false;
        });
      }
      for (const hm of actor.model.hitMeshes) {
        if (hm.userData.bodyRegion === 'head') {
          hm.visible = false;
        }
      }

      const headY = actor.model.weakspotHeight;
      spawnExplosionRing(actor.x, headY, actor.z, 0xff2a4b, 1.85);
      spawnBulletImpact(_vec3B.set(actor.x, headY, actor.z), null, 'ENEMY');
      soundEngine.playGrenadeExplode();
      simRef.current.cameraShake = Math.max(simRef.current.cameraShake, 0.42);

      if (actor.alive) {
        const rem = Math.max(1, actor.hp);
        applyDamageAndStagger(actor, 0, 0);
        pushHitVisuals(rem, true, true, false, 0, {
          x: actor.x,
          y: headY + 0.35,
          z: actor.z,
        });
        checkSquadCleared();
      }
    };

    /** Severs a destroyed arm (20% total HP), hiding its meshes and dropping shield / arm weaponry. */
    const destroyEnemyArm = (actor: EnemyActor, side: 'leftArm' | 'rightArm') => {
      const comp = actor.components;
      if (comp.armsDestroyed[side]) return;
      comp.armsDestroyed[side] = true;
      comp.limbHp[side] = 0;
      comp.capacitors[side] = 0;

      const armGroup = side === 'leftArm' ? actor.model.leftClawArm : actor.model.rightClawArm;
      armGroup.visible = false;
      armGroup.traverse((obj) => {
        obj.visible = false;
      });
      for (const hm of actor.model.hitMeshes) {
        if (hm.userData.bodyRegion === side) {
          hm.visible = false;
        }
      }

      if (side === 'leftArm') {
        if (actor.shieldHp > 0) {
          actor.shieldHp = 0;
        }
        if (actor.model.shieldGroup) {
          actor.model.shieldGroup.visible = false;
          actor.model.shieldGroup.traverse((obj) => {
            obj.visible = false;
          });
        }
        for (const hm of actor.model.hitMeshes) {
          if (hm.userData.isShield) hm.visible = false;
        }
        if (actor.clawAnimType === 'LEFT' || actor.clawAnimType === 'DUAL_WINDUP' || actor.clawAnimType === 'DUAL_STRIKE') {
          actor.clawAnimType = 'NONE';
        }
      } else {
        if (actor.clawAnimType === 'RIGHT' || actor.clawAnimType === 'DUAL_WINDUP' || actor.clawAnimType === 'DUAL_STRIKE') {
          actor.clawAnimType = 'NONE';
        }
      }

      const yaw = actor.model.root.rotation.y;
      const sideSign = side === 'leftArm' ? -1 : 1;
      const sx = actor.x + Math.cos(yaw) * sideSign * 0.45 * actor.profile.scaleXZ;
      const sz = actor.z - Math.sin(yaw) * sideSign * 0.45 * actor.profile.scaleXZ;
      const sy = 1.35 * actor.profile.scaleY;
      spawnExplosionRing(sx, sy, sz, 0xff8a30, 1.15);
      spawnBulletImpact(_vec3B.set(sx, sy, sz), null, 'ENEMY');
      soundEngine.playDoorBreak();
    };

    /**
     * Destroys an enemy ATGM Launcher (90 HP @ 0.6x) or Shoulder Rocket Pods (120 HP @ 0.8x),
     * triggering a localized explosion AND firing any remaining loaded ordnance in wild random arcs.
     */
    const triggerWeaponPodDestruction = (actor: EnemyActor, kind: 'atgm' | 'rocket_pods') => {
      const s = simRef.current;
      const p = propsRef.current;
      const comp = actor.components;

      if (kind === 'atgm') {
        if (comp.atgmDestroyed) return;
        comp.atgmDestroyed = true;
        comp.atgmHp = 0;
      } else {
        if (comp.rocketPodDestroyed) return;
        comp.rocketPodDestroyed = true;
        comp.rocketPodHp = 0;
      }

      const podPos = new THREE.Vector3(actor.x, Math.max(1.2, actor.profile.scaleY * 1.55), actor.z);
      if (kind === 'atgm' && actor.model.atgmGroup) {
        actor.model.atgmGroup.getWorldPosition(podPos);
        actor.model.atgmGroup.visible = false;
        actor.model.atgmGroup.traverse((obj) => {
          obj.visible = false;
        });
      } else if (kind === 'rocket_pods' && actor.model.rocketPodGroups.length > 0) {
        actor.model.rocketPodGroups[0].getWorldPosition(podPos);
        for (const pg of actor.model.rocketPodGroups) {
          pg.visible = false;
          pg.traverse((obj) => {
            obj.visible = false;
          });
        }
      }
      for (const hm of actor.model.hitMeshes) {
        if (hm.userData.subPart === kind) {
          hm.visible = false;
        }
      }

      const radiusM = kind === 'atgm' ? 3.8 : 4.2;
      const maxSplash = kind === 'atgm' ? 58 : 72;
      soundEngine.playReactorExplosion();
      spawnExplosionRing(podPos.x, podPos.y, podPos.z, 0xa855f7, radiusM);
      s.cameraShake = Math.max(s.cameraShake, 0.58);

      // Blast damage to host mech
      if (actor.alive) {
        const selfDmg = Math.max(20, Math.round(kind === 'atgm' ? 42 : 58));
        const selfOut = applyDamageAndStagger(actor, Math.max(0, actor.hp - selfDmg), 35);
        pushHitVisuals(selfDmg, true, selfOut.killed, selfOut.triggeredStagger, 0, {
          x: podPos.x,
          y: podPos.y + 0.35,
          z: podPos.z,
        });
      }

      // Splash nearby enemies, covers, turrets, and player
      for (const other of s.enemies) {
        if (!other.alive || other === actor) continue;
        const d = Math.hypot(other.x - podPos.x, other.z - podPos.z);
        if (d <= radiusM + 0.5 * other.profile.scaleXZ) {
          const falloff = THREE.MathUtils.clamp(1 - d / Math.max(1, radiusM + 0.5), 0.3, 1.0);
          const splashDmg = Math.max(6, Math.round(maxSplash * falloff));
          const out = applyDamageAndStagger(other, Math.max(0, other.hp - splashDmg), Math.round(splashDmg * 0.45));
          pushHitVisuals(splashDmg, false, out.killed, out.triggeredStagger, 0, {
            x: other.x,
            y: other.profile.scaleY * 1.4,
            z: other.z,
          });
        }
      }
      for (const cov of currentRoom.covers) {
        if (!cov.broken && Math.hypot(cov.x - podPos.x, cov.z - podPos.z) <= radiusM + 0.8) {
          damageCover(cov, Math.round(maxSplash * 0.5));
        }
      }
      for (let ti = s.turrets.length - 1; ti >= 0; ti--) {
        const tur = s.turrets[ti];
        const td = Math.hypot(tur.pos.x - podPos.x, tur.pos.z - podPos.z);
        if (td <= radiusM + 0.6) {
          const tf = THREE.MathUtils.clamp(1 - td / (radiusM + 0.6), 0.3, 1.0);
          damageDeployableTurret(tur, Math.round(maxSplash * tf));
        }
      }
      if (p.playerHp > 0) {
        const dp = Math.hypot(s.playerX - podPos.x, s.playerZ - podPos.z);
        if (dp <= radiusM + 0.4) {
          const pf = THREE.MathUtils.clamp(1 - dp / (radiusM + 0.4), 0.3, 1.0);
          const pDmg = Math.max(3, Math.round(16 * pf));
          setDamageFlashAlpha((prev) => Math.max(prev, 0.34));
          p.onEnemyWeaponAttack(
            'ENEMY_EXPLOSION',
            pDmg,
            actor.profile.name,
            kind === 'atgm' ? 'ATGM Pod Cook-Off' : 'Rocket Pod Cook-Off',
            Math.max(1, Math.round(dp))
          );
        }
      }

      // Misfire any remaining loaded rounds randomly outward
      const spec =
        kind === 'atgm'
          ? ENEMY_WEAPONS.enemy_atgm
          : ENEMY_WEAPONS.enemy_rocket_pods;
      const loadedRounds = kind === 'atgm' ? actor.rangedMag : actor.podMag;
      if (kind === 'atgm') {
        actor.rangedMag = 0;
        actor.rangedReloadTimer = 0;
      } else {
        actor.podMag = 0;
        actor.podReloadTimer = 0;
      }

      if (loadedRounds > 0) {
        soundEngine.playEnemyWeaponFire(spec.id);
        for (let m = 0; m < loadedRounds; m++) {
          const randYaw = Math.random() * Math.PI * 2;
          const randPitch = -0.18 + Math.random() * 0.68;
          const cosP = Math.cos(randPitch);
          const wildDir = new THREE.Vector3(
            Math.cos(randYaw) * cosP,
            Math.sin(randPitch),
            Math.sin(randYaw) * cosP
          ).normalize();

          const boltMat = new THREE.MeshStandardMaterial({
            color: spec.colorHex,
            emissive: spec.colorHex,
            emissiveIntensity: 2.3,
            roughness: 0.2,
          });
          const boltMesh = new THREE.Mesh(droneBoltGeo, boltMat);
          boltMesh.scale.setScalar(kind === 'atgm' ? 1.35 : 1.25);
          boltMesh.position.set(
            podPos.x + (Math.random() - 0.5) * 0.35,
            Math.max(0.45, podPos.y + (Math.random() - 0.5) * 0.25),
            podPos.z + (Math.random() - 0.5) * 0.35
          );
          scene.add(boltMesh);

          s.droneProjectiles.push({
            mesh: boltMesh,
            vx: wildDir.x * spec.projectileSpeed,
            vy: wildDir.y * spec.projectileSpeed,
            vz: wildDir.z * spec.projectileSpeed,
            gravity: 1.6,
            damage: spec.damage,
            attackerName: `${actor.profile.name} (Misfire)`,
            life: 4.0,
            isHoming: false,
            turnRateRad: 0,
            speedMps: spec.projectileSpeed,
            sourceWeaponId: spec.id,
            splashRadiusM: spec.splashRadiusM ?? (kind === 'atgm' ? 1.4 : 1.0),
            canHitEnemies: true,
            sourceActorUid: actor.uid,
            ignoreSelfSec: 0.28,
          });
        }
      }

      checkSquadCleared();
    };

    /**
     * Routes localized hit energy into the mech's internal components (Power Supply, Battery,
     * Capacitors, Viewing Lens, Mechanisms, Limbs, and Head). Handles destructible arms (20% HP)
     * and explosive head destruction when head HP reaches 0 or on lethal headshots.
     */
    const applyComponentHit = (
      actor: EnemyActor,
      region: BodyRegionKey,
      localY: number,
      hpDamage: number,
      isWeakspot: boolean,
      wasKilledByHit = false
    ): { executedByHeadCap: boolean } => {
      const comp = actor.components;
      comp.regionHits[region] = (comp.regionHits[region] ?? 0) + 1;
      const dmg = Math.max(1, hpDamage);
      const compDmg = Math.max(1, Math.round(dmg * 0.6));

      if (region !== 'shield') {
        comp.capacitors[region] = Math.max(0, comp.capacitors[region] - dmg * 0.85);
      }

      if (region === 'leftArm' || region === 'rightArm' || region === 'leftLeg' || region === 'rightLeg') {
        comp.limbHp[region] = Math.max(0, comp.limbHp[region] - dmg);
        comp.mechanismsHp = Math.max(0, comp.mechanismsHp - compDmg * 0.7);
        if ((region === 'leftArm' || region === 'rightArm') && comp.limbHp[region] <= 0 && !comp.armsDestroyed[region]) {
          destroyEnemyArm(actor, region);
        }
      } else if (region === 'torso') {
        // Center torso houses Power Supply (12.5% HP / Armor) and Reserve Battery
        const centerBand = actor.profile.silhouette === 'drone' || (localY >= 0.72 && localY <= 1.72);
        comp.powerSupplyHp = Math.max(
          0,
          comp.powerSupplyHp - dmg * (centerBand ? 1.0 : 0.45)
        );
        comp.batteryHp = Math.max(0, comp.batteryHp - compDmg * (centerBand ? 0.8 : 0.42));
        comp.mechanismsHp = Math.max(0, comp.mechanismsHp - compDmg * 0.55);
      } else if (region === 'head' || (isWeakspot && actor.profile.silhouette !== 'mech')) {
        comp.headHp = Math.max(0, comp.headHp - dmg);
        comp.viewingLensHp = Math.max(0, comp.viewingLensHp - dmg * 0.9);
        comp.capacitors.head = Math.max(0, comp.capacitors.head - dmg * 0.65);
      }

      updateRegionWeathering(actor, region);

      if (comp.powerSupplyHp <= 0 && !comp.powerSupplyExploded) {
        triggerComponentExplosion(actor, 'POWER_SUPPLY');
      } else if (comp.batteryHp <= 0 && !comp.batteryExploded) {
        triggerComponentExplosion(actor, 'BATTERY');
      }

      // Heads only explode when head HP (25% total HP / armor, capped at 75% total HP) is depleted
      if (comp.headHp <= 0 && !comp.headExploded) {
        triggerHeadExplosion(actor);
        return { executedByHeadCap: !actor.alive };
      }

      // Destroyed head capacitor can execute weakened or critically pierced mechs without exploding head
      if (
        actor.alive &&
        (region === 'head' || isWeakspot) &&
        comp.capacitors.head <= 0 &&
        (actor.hp <= actor.maxHp * 0.28 || isWeakspot)
      ) {
        applyDamageAndStagger(actor, 0, 0);
        return { executedByHeadCap: true };
      }

      return { executedByHeadCap: false };
    };

    /** Helper to create a single fire pool circle inside an Incendiary 4-circle cluster. */
    const spawnFireCircle = (
      cx: number,
      cz: number,
      radius: number,
      durationSec: number,
      dotDamage: number,
      includeLight: boolean
    ) => {
      const zoneGroup = new THREE.Group();
      zoneGroup.position.set(cx, 0.04, cz);
      const poolMat = new THREE.MeshBasicMaterial({
        color: 0xff5a00,
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
      });
      const poolDisc = new THREE.Mesh(new THREE.CircleGeometry(radius, 28), poolMat);
      poolDisc.rotation.x = -Math.PI / 2;
      zoneGroup.add(poolDisc);

      const ringMat = new THREE.MeshBasicMaterial({
        color: 0xffb300,
        transparent: true,
        opacity: 0.78,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const ringMesh = new THREE.Mesh(new THREE.RingGeometry(radius - 0.16, radius, 32), ringMat);
      ringMesh.rotation.x = -Math.PI / 2;
      ringMesh.position.y = 0.02;
      zoneGroup.add(ringMesh);

      const fireLight = new THREE.PointLight(0xff6a00, includeLight ? 14 : 0, includeLight ? 20 : 1, 1.4);
      fireLight.position.set(0, 1.2, 0);
      if (includeLight) zoneGroup.add(fireLight);
      scene.add(zoneGroup);

      simRef.current.incendiaryZones.push({
        group: zoneGroup,
        light: fireLight,
        x: cx,
        z: cz,
        radius,
        remainingSec: durationSec,
        tickTimer: 0.35,
        dotDamage,
      });
    };

    /** Queues any planted mines or Sticky C4 caught inside an explosion radius/cone for chained detonation. */
    const queueChainExplosions = (
      ox: number,
      oy: number,
      oz: number,
      radiusM: number,
      coneDir?: THREE.Vector3
    ) => {
      const s = simRef.current;
      const cosHalfCone = Math.cos(THREE.MathUtils.degToRad(52));
      const inBlast = (px: number, py: number, pz: number): boolean => {
        const dx = px - ox;
        const dy = py - oy;
        const dz = pz - oz;
        const dist = Math.hypot(dx, dy, dz);
        if (dist > radiusM + 0.65) return false;
        if (!coneDir || dist < 1.8) return true;
        const dot = (dx * coneDir.x + dy * coneDir.y + dz * coneDir.z) / Math.max(0.01, dist);
        return dot >= cosHalfCone;
      };

      let chainIdx = 0;
      for (let i = s.tripMines.length - 1; i >= 0; i--) {
        const m = s.tripMines[i];
        if (inBlast(m.x, m.y, m.z)) {
          scene.remove(m.mesh);
          disposeObject3D(m.mesh);
          s.tripMines.splice(i, 1);
          s.pendingChainDetonations.push({
            kind: 'trip_mine',
            pos: new THREE.Vector3(m.x, 0.25, m.z),
            delaySec: 0.08 + chainIdx * 0.04,
          });
          chainIdx += 1;
        }
      }

      for (let i = s.laserMines.length - 1; i >= 0; i--) {
        const lm = s.laserMines[i];
        if (inBlast(lm.pos.x, lm.pos.y, lm.pos.z)) {
          scene.remove(lm.mesh);
          disposeObject3D(lm.mesh);
          s.laserMines.splice(i, 1);
          s.pendingChainDetonations.push({
            kind: 'laser_trip_mine',
            pos: lm.pos.clone(),
            laserClone: { ...lm, pos: lm.pos.clone(), beamDir: lm.beamDir.clone(), coneDir: lm.coneDir.clone() },
            delaySec: 0.08 + chainIdx * 0.04,
          });
          chainIdx += 1;
        }
      }

      let removedC4 = false;
      for (let i = s.stickyC4s.length - 1; i >= 0; i--) {
        const c4 = s.stickyC4s[i];
        if (inBlast(c4.pos.x, c4.pos.y, c4.pos.z)) {
          scene.remove(c4.mesh);
          disposeObject3D(c4.mesh);
          s.stickyC4s.splice(i, 1);
          removedC4 = true;
          s.pendingChainDetonations.push({
            kind: 'sticky_c4',
            pos: c4.pos.clone(),
            delaySec: 0.08 + chainIdx * 0.04,
          });
          chainIdx += 1;
        }
      }
      if (removedC4) {
        setPlantedC4Count(s.stickyC4s.length);
      }
    };

    const damageDeployableTurret = (tur: DeployableTurret3D, rawDmg: number) => {
      const s = simRef.current;
      const mitigated = Math.max(1, Math.round(rawDmg * tur.armorMult));
      tur.hp = Math.max(0, tur.hp - mitigated);
      if (tur.hp <= 0) {
        const idx = s.turrets.findIndex((t) => t.uid === tur.uid);
        if (idx !== -1) {
          s.turrets.splice(idx, 1);
          setActiveTurretCount(s.turrets.length);
        }
        spawnExplosionRing(tur.pos.x, 0.55, tur.pos.z, 0xff8a30, 2.4);
        soundEngine.playDoorBreak();
        scene.remove(tur.mesh);
        disposeObject3D(tur.mesh);
      }
    };

    const computeConsumableZoneMult = (
      grenade: GrenadeProfile,
      actor: EnemyActor,
      zone: HitZoneId
    ): number => {
      const armorRed = grenade.armorReduction ?? 0;
      const stagMult = actor.staggerTimer > 0 ? actor.profile.staggerDamageMultiplier : 1.0;
      let baseMult: number;
      if (zone === 'weakspot') {
        const gWeak = grenade.weakspotMultiplier;
        baseMult =
          gWeak !== undefined && gWeak !== 1.0
            ? Math.max(0.15, gWeak * (actor.profile.weakspotMultiplier / 2.0))
            : actor.profile.weakspotMultiplier;
      } else if (zone === 'limb') {
        baseMult = Math.max(0.08, actor.profile.limbMultiplier + armorRed);
      } else {
        baseMult = Math.max(0.08, actor.profile.torsoMultiplier + armorRed);
      }
      return baseMult * stagMult;
    };

    const getActorLimbPoints = (
      actor: EnemyActor
    ): { region: BodyRegionKey; zone: HitZoneId; x: number; y: number; z: number }[] => {
      const sx = actor.profile.scaleXZ;
      const sy = actor.profile.scaleY;
      const yaw = actor.model.root.rotation.y;
      const rightX = Math.cos(yaw);
      const rightZ = -Math.sin(yaw);
      const pts: { region: BodyRegionKey; zone: HitZoneId; x: number; y: number; z: number }[] = [
        { region: 'head', zone: 'weakspot', x: actor.x, y: actor.model.weakspotHeight, z: actor.z },
        { region: 'torso', zone: 'torso', x: actor.x, y: 1.25 * sy, z: actor.z },
        {
          region: 'leftArm',
          zone: 'limb',
          x: actor.x - rightX * 0.42 * sx,
          y: 1.28 * sy,
          z: actor.z - rightZ * 0.42 * sx,
        },
        {
          region: 'rightArm',
          zone: 'limb',
          x: actor.x + rightX * 0.42 * sx,
          y: 1.28 * sy,
          z: actor.z + rightZ * 0.42 * sx,
        },
      ];
      if (actor.profile.silhouette !== 'drone') {
        pts.push(
          {
            region: 'leftLeg',
            zone: 'limb',
            x: actor.x - rightX * 0.22 * sx,
            y: 0.48 * sy,
            z: actor.z - rightZ * 0.22 * sx,
          },
          {
            region: 'rightLeg',
            zone: 'limb',
            x: actor.x + rightX * 0.22 * sx,
            y: 0.48 * sy,
            z: actor.z + rightZ * 0.22 * sx,
          }
        );
      }
      return pts;
    };

    const detonateGrenadeAt = (grenade: GrenadeProfile, gx: number, gy: number, gz: number) => {
      const s = simRef.current;
      const p = propsRef.current;
      const dropRangeM = getGrenadeDropRangeM(grenade);

      // Breach any intact blast doors or breakable covers caught inside explosive/mine/C4 blast radius
      if (grenade.id !== 'stun') {
        for (const door of [currentRoom.westDoor, currentRoom.eastDoor, currentRoom.northDoor]) {
          if (door && !door.broken) {
            const distDoor = Math.hypot(gx - door.breachOrigin.x, gz - door.breachOrigin.z);
            if (distDoor <= dropRangeM + 1.8) {
              const doorDmg = grenade.id === 'explosive' || grenade.id === 'sticky_c4' ? grenade.damage * 4 : grenade.damage;
              damageDoor(door, doorDmg);
            }
          }
        }
        for (const cov of currentRoom.covers) {
          if (!cov.broken) {
            const distCov = Math.hypot(gx - cov.x, gz - cov.z);
            if (distCov <= dropRangeM + 1.2) {
              const covDmg = grenade.id === 'explosive' || grenade.id === 'sticky_c4' ? grenade.damage * 4 : grenade.damage;
              damageCover(cov, covDmg);
            }
          }
        }
      }

      if (grenade.id === 'stun') {
        soundEngine.playGrenadeStun();
        spawnExplosionRing(gx, gy, gz, 0x00f0ff, dropRangeM);
        s.cameraShake = Math.max(s.cameraShake, 0.36);
      } else if (grenade.id === 'incendiary') {
        soundEngine.playGrenadeIncendiary();
        spawnExplosionRing(gx, gy, gz, 0xff6a00, dropRangeM);
        s.cameraShake = Math.max(s.cameraShake, 0.45);

        // Burst into 4 randomized, evenly distributed angular sector fire circles
        const baseAngle = Math.random() * Math.PI * 2;
        for (let idx = 0; idx < 4; idx++) {
          const sectorAngle = baseAngle + idx * (Math.PI * 0.5) + (Math.random() - 0.5) * 0.45;
          const radialDist = 1.7 + Math.random() * 1.9;
          const offX = Math.cos(sectorAngle) * radialDist;
          const offZ = Math.sin(sectorAngle) * radialDist;
          const resolvedPool = resolveRoomCollision2D(
            gx + offX,
            gz + offZ,
            gx,
            gz,
            0.35,
            p.config.roomId,
            {
              isPlayer: false,
              westDoorBroken: currentRoom.westDoor?.broken ?? true,
              eastDoorBroken: currentRoom.eastDoor?.broken ?? true,
              northDoorBroken: currentRoom.northDoor?.broken ?? true,
              covers: currentRoom.covers,
            }
          );
          const circleRadius = 3.8 + Math.random() * 1.2;
          spawnFireCircle(
            resolvedPool.x,
            resolvedPool.z,
            circleRadius,
            grenade.dotDurationSec ?? 6.5,
            grenade.dotDamagePerTick ?? 64,
            idx === 0
          );
        }
      } else if (grenade.id === 'trip_mine' || grenade.id === 'sticky_c4') {
        soundEngine.playTripMineExplosion();
        spawnExplosionRing(
          gx,
          gy,
          gz,
          grenade.id === 'trip_mine' ? 0xffb300 : 0xa855f7,
          dropRangeM
        );
        s.cameraShake = Math.max(s.cameraShake, 1.05);
      } else {
        soundEngine.playGrenadeExplode();
        spawnExplosionRing(gx, gy, gz, 0xff3b1f, dropRangeM);
        s.cameraShake = Math.max(s.cameraShake, 0.85);
      }

      if (grenade.id !== 'stun') {
        queueChainExplosions(gx, gy, gz, dropRangeM);
      }

      let hitEnemies = 0;
      let totalDmg = 0;
      let anyKill = false;
      let anyStagger = false;
      const killedTtks: number[] = [];
      let primaryName = 'Open Floor';
      const affectedTargets: NonNullable<
        Parameters<typeof p.onGrenadeImpactLog>[0]['affectedTargets']
      > = [];

      const isPerLimbBlast = grenade.id === 'explosive' || grenade.id === 'sticky_c4';

      for (const actor of s.enemies) {
        if (!actor.alive) continue;

        if (isPerLimbBlast) {
          const limbPts = getActorLimbPoints(actor);
          let actorDmg = 0;
          let hitHeadLimb = false;
          for (const pt of limbPts) {
            const dLimb = Math.hypot(pt.x - gx, pt.y - gy, pt.z - gz);
            if (dLimb <= dropRangeM + 0.45) {
              const falloff = computeConsumableFalloff(grenade, dLimb);
              const zoneMult = computeConsumableZoneMult(grenade, actor, pt.zone);
              const limbDmg = Math.max(1, Math.round(grenade.damage * falloff * zoneMult));
              actorDmg += limbDmg;
              if (pt.zone === 'weakspot') hitHeadLimb = true;
              applyComponentHit(actor, pt.region, pt.y, limbDmg, pt.zone === 'weakspot');
            }
          }
          if (actorDmg > 0 && actor.alive) {
            hitEnemies += 1;
            primaryName = actor.profile.name;
            const nextHp = Math.max(0, actor.hp - actorDmg);
            const outcome = applyDamageAndStagger(
              actor,
              nextHp,
              grenade.staggerDamage,
              grenade.staggerDurationMult
            );
            totalDmg += actorDmg;
            if (outcome.killed) {
              anyKill = true;
              if (outcome.enemyTtkMs !== null) killedTtks.push(outcome.enemyTtkMs);
            }
            if (outcome.triggeredStagger) anyStagger = true;
            affectedTargets.push({
              enemyUid: actor.encounterId,
              targetId: actor.profile.id,
              targetName: actor.profile.name,
              targetCode: actor.profile.code,
              silhouette: actor.profile.silhouette,
              waveNumber: p.waveNumber,
              hpDamage: actorDmg,
              isKill: outcome.killed,
              enemyTtkMs: outcome.enemyTtkMs,
            });
            pushHitVisuals(actorDmg, hitHeadLimb, outcome.killed, outcome.triggeredStagger, 0, {
              x: actor.x,
              y: actor.profile.scaleY * 1.75,
              z: actor.z,
            });
          } else if (actorDmg > 0) {
            // Actor was already killed via component explosion during limb hits
            hitEnemies += 1;
            primaryName = actor.profile.name;
            anyKill = true;
            totalDmg += actorDmg;
          }
        } else {
          const distXZ = Math.hypot(actor.x - gx, actor.z - gz);
          if (distXZ <= dropRangeM + 0.55 * actor.profile.scaleXZ) {
            hitEnemies += 1;
            primaryName = actor.profile.name;
            const hitHead = Math.abs(gy - actor.model.weakspotHeight) <= 0.65 && distXZ <= 0.9 * actor.profile.scaleXZ;
            const zone: HitZoneId = hitHead ? 'weakspot' : 'torso';
            const dist3D = Math.hypot(actor.x - gx, (hitHead ? actor.model.weakspotHeight : 1.15 * actor.profile.scaleY) - gy, actor.z - gz);
            const falloffRatio = computeConsumableFalloff(grenade, dist3D);
            const zoneMult = computeConsumableZoneMult(grenade, actor, zone);
            const dmg = Math.max(1, Math.round(grenade.damage * falloffRatio * zoneMult));
            const nextHp = Math.max(0, actor.hp - dmg);
            const outcome = applyDamageAndStagger(
              actor,
              nextHp,
              grenade.staggerDamage,
              grenade.staggerDurationMult
            );
            applyComponentHit(actor, hitHead ? 'head' : 'torso', hitHead ? 1.9 : 1.2, dmg, hitHead, outcome.killed);
            if (grenade.id === 'incendiary' && actor.alive) {
              actor.burnSlowTimer = Math.max(actor.burnSlowTimer, 0.75);
            }
            totalDmg += dmg;
            if (outcome.killed) {
              anyKill = true;
              if (outcome.enemyTtkMs !== null) killedTtks.push(outcome.enemyTtkMs);
            }
            if (outcome.triggeredStagger) anyStagger = true;

            affectedTargets.push({
              enemyUid: actor.encounterId,
              targetId: actor.profile.id,
              targetName: actor.profile.name,
              targetCode: actor.profile.code,
              silhouette: actor.profile.silhouette,
              waveNumber: p.waveNumber,
              hpDamage: dmg,
              isKill: outcome.killed,
              enemyTtkMs: outcome.enemyTtkMs,
            });

            pushHitVisuals(dmg, hitHead, outcome.killed, outcome.triggeredStagger, 0, {
              x: actor.x,
              y: actor.profile.scaleY * 1.75,
              z: actor.z,
            });
          }
        }
      }

      // Player self-blast mitigation (0.1x damage) & Stun flash/ghosting effect (3s whiteout -> 3s ghosting)
      if (p.playerHp > 0) {
        const distPlayerSelf = Math.hypot(s.playerX - gx, s.playerZ - gz);
        if (grenade.id === 'stun' && distPlayerSelf <= Math.max(dropRangeM + 3.5, 13.0)) {
          s.stunFlashTimer = 6.0;
          setStunEffectRemainingSec(6.0);
        }
        if (distPlayerSelf <= dropRangeM + 0.45) {
          const selfFalloff = computeConsumableFalloff(grenade, distPlayerSelf);
          const rawSelfDmg = Math.max(1, Math.round(grenade.damage * selfFalloff));
          setDamageFlashAlpha((prev) => Math.max(prev, 0.32));
          s.playerHitSlowTimer = Math.max(s.playerHitSlowTimer, 0.35);
          p.onPlayerOrdnanceSelfDamage(rawSelfDmg, `${grenade.shortLabel} Splash (-90%)`);
        }
      }

      const avgTtk =
        killedTtks.length > 0
          ? Math.round(killedTtks.reduce((a, b) => a + b, 0) / killedTtks.length)
          : null;
      const distPlayer = Math.max(1, Math.round(Math.hypot(gx - s.playerX, gz - s.playerZ)));

      p.onGrenadeImpactLog({
        grenade,
        targetName: hitEnemies > 1 ? `${hitEnemies} Hostiles` : primaryName,
        zoneLabel:
          grenade.id === 'stun'
            ? `${grenade.shortLabel} (3s Flash / 3s Ghost)`
            : grenade.id === 'incendiary'
              ? '4-Sector Thermite Burst'
              : grenade.id === 'trip_mine'
                ? 'Proximity Trip Mine Blast'
                : grenade.id === 'sticky_c4'
                  ? 'Remote C4 Limb Blast'
                  : 'High-Explosive Limb Blast',
        hpDamage: totalDmg,
        isKill: anyKill,
        isStagger: anyStagger,
        distanceM: distPlayer,
        enemyTtkMs: avgTtk,
        affectedTargets,
      });

      checkSquadCleared();
    };

    /** Detonates a wall/floor-mounted Laser Trip Mine (1000 DMG, 6m/17m log falloff, 12m pierce absorption). */
    const detonateLaserTripMine = (mine: LaserTripMine3D) => {
      const s = simRef.current;
      const p = propsRef.current;
      const profile = getGrenadeById('laser_trip_mine', p.grenades);
      const dropRangeM = getGrenadeDropRangeM(profile);
      const pierceBudgetMax = profile.pierceDepthM ?? mine.pierceDepthM ?? 12;

      soundEngine.playTripMineExplosion();
      spawnExplosionRing(mine.pos.x, mine.pos.y, mine.pos.z, 0xff2a9d, 5.5);
      spawnExplosionRing(
        mine.pos.x + mine.coneDir.x * 5.2,
        mine.pos.y + mine.coneDir.y * 5.2,
        mine.pos.z + mine.coneDir.z * 5.2,
        0xffb300,
        dropRangeM * 0.52
      );
      s.cameraShake = Math.max(s.cameraShake, 0.95);
      queueChainExplosions(mine.pos.x, mine.pos.y, mine.pos.z, dropRangeM, mine.coneDir);

      for (const door of [currentRoom.westDoor, currentRoom.eastDoor, currentRoom.northDoor]) {
        if (door && !door.broken) {
          const distDoor = Math.hypot(
            door.breachOrigin.x - mine.pos.x,
            door.breachOrigin.z - mine.pos.z
          );
          if (distDoor <= dropRangeM) {
            damageDoor(door, profile.damage);
          }
        }
      }
      for (const cov of currentRoom.covers) {
        if (!cov.broken) {
          const distCov = Math.hypot(cov.x - mine.pos.x, cov.z - mine.pos.z);
          if (distCov <= dropRangeM) {
            damageCover(cov, profile.damage);
          }
        }
      }

      const cosHalfCone = Math.cos(THREE.MathUtils.degToRad(50));
      let hitEnemies = 0;
      let totalDmg = 0;
      let anyKill = false;
      let anyStagger = false;
      const killedTtks: number[] = [];
      let primaryName = 'Empty Sector';
      const affectedTargets: NonNullable<
        Parameters<typeof p.onGrenadeImpactLog>[0]['affectedTargets']
      > = [];

      // Gather cone candidates and sort near-to-far so forward bodies absorb up to 12m pierce depth
      const coneCandidates: { actor: EnemyActor; dist: number; hitHead: boolean }[] = [];
      for (const actor of s.enemies) {
        if (!actor.alive) continue;
        const toActor = _vec3A.set(
          actor.x - mine.pos.x,
          actor.profile.scaleY * 1.1 - mine.pos.y,
          actor.z - mine.pos.z
        );
        const dist = toActor.length();
        if (dist <= dropRangeM + 0.6) {
          const dir = toActor.normalize();
          const coneDot = dir.dot(mine.coneDir);
          if (dist < 1.8 || coneDot >= cosHalfCone) {
            const beamElev = mine.pos.y + mine.coneDir.y * dist;
            const hitHead = Math.abs(beamElev - actor.model.weakspotHeight) <= 0.55;
            coneCandidates.push({ actor, dist, hitHead });
          }
        }
      }
      coneCandidates.sort((a, b) => a.dist - b.dist);

      let remainingPierceM = pierceBudgetMax;
      for (const cand of coneCandidates) {
        if (remainingPierceM <= 0.05) break;
        const { actor, dist, hitHead } = cand;
        const sil = actor.profile.silhouette;
        const bodyThicknessM =
          Math.max(1.2, 1.85 * actor.profile.scaleXZ) *
          (sil === 'tank' || sil === 'titan' ? 1.85 : sil === 'brute' ? 1.45 : 1.0);
        const pierceShare = Math.min(1, remainingPierceM / bodyThicknessM);
        remainingPierceM = Math.max(0, remainingPierceM - bodyThicknessM);

        hitEnemies += 1;
        primaryName = actor.profile.name;
        const falloff = computeConsumableFalloff(profile, dist);
        const zone: HitZoneId = hitHead ? 'weakspot' : 'torso';
        const zoneMult = computeConsumableZoneMult(profile, actor, zone);
        const dmg = Math.max(1, Math.round(profile.damage * falloff * zoneMult * pierceShare));
        const nextHp = Math.max(0, actor.hp - dmg);
        const outcome = applyDamageAndStagger(actor, nextHp, profile.staggerDamage, 1.0);
        applyComponentHit(actor, hitHead ? 'head' : 'torso', hitHead ? 1.9 : 1.2, dmg, hitHead, outcome.killed);
        totalDmg += dmg;
        if (outcome.killed) {
          anyKill = true;
          if (outcome.enemyTtkMs !== null) killedTtks.push(outcome.enemyTtkMs);
        }
        if (outcome.triggeredStagger) anyStagger = true;
        affectedTargets.push({
          enemyUid: actor.encounterId,
          targetId: actor.profile.id,
          targetName: actor.profile.name,
          targetCode: actor.profile.code,
          silhouette: actor.profile.silhouette,
          waveNumber: p.waveNumber,
          hpDamage: dmg,
          isKill: outcome.killed,
          enemyTtkMs: outcome.enemyTtkMs,
        });
        pushHitVisuals(dmg, hitHead, outcome.killed, outcome.triggeredStagger, 0, {
          x: actor.x,
          y: actor.profile.scaleY * 1.8,
          z: actor.z,
        });
      }

      // Apply 90% mitigated damage if player is standing inside the upward cone
      if (p.playerHp > 0) {
        const toPlayer = _vec3A.set(
          s.playerX - mine.pos.x,
          1.35 - mine.pos.y,
          s.playerZ - mine.pos.z
        );
        const pDist = toPlayer.length();
        if (pDist <= dropRangeM) {
          const pDot = toPlayer.normalize().dot(mine.coneDir);
          if (pDist < 1.6 || pDot >= cosHalfCone) {
            const rawSelf = Math.max(
              1,
              Math.round(profile.damage * computeConsumableFalloff(profile, pDist))
            );
            setDamageFlashAlpha((prev) => Math.max(prev, 0.35));
            p.onPlayerOrdnanceSelfDamage(rawSelf, 'Laser Cone Blast (-90%)');
          }
        }
      }

      const avgTtk =
        killedTtks.length > 0
          ? Math.round(killedTtks.reduce((a, b) => a + b, 0) / killedTtks.length)
          : null;
      const distPlayer = Math.max(
        1,
        Math.round(Math.hypot(mine.pos.x - s.playerX, mine.pos.z - s.playerZ))
      );

      p.onGrenadeImpactLog({
        grenade: profile,
        targetName: hitEnemies > 1 ? `${hitEnemies} Hostiles` : primaryName,
        zoneLabel: `Laser Cone (${pierceBudgetMax}m Pierce)`,
        hpDamage: totalDmg,
        isKill: anyKill,
        isStagger: anyStagger,
        distanceM: distPlayer,
        enemyTtkMs: avgTtk,
        affectedTargets,
      });
      checkSquadCleared();
    };

    /** Detonates a specific planted mine or C4 when shot at or struck by melee. */
    const detonateDeployableByUid = (
      kind: 'trip_mine' | 'laser_trip_mine' | 'sticky_c4',
      uid: number
    ): boolean => {
      const s = simRef.current;
      const p = propsRef.current;
      if (kind === 'trip_mine') {
        const idx = s.tripMines.findIndex((m) => m.uid === uid);
        if (idx === -1) return false;
        const m = s.tripMines[idx];
        s.tripMines.splice(idx, 1);
        scene.remove(m.mesh);
        disposeObject3D(m.mesh);
        detonateGrenadeAt(getGrenadeById('trip_mine', p.grenades), m.x, 0.25, m.z);
        return true;
      }
      if (kind === 'laser_trip_mine') {
        const idx = s.laserMines.findIndex((m) => m.uid === uid);
        if (idx === -1) return false;
        const lm = s.laserMines[idx];
        s.laserMines.splice(idx, 1);
        scene.remove(lm.mesh);
        disposeObject3D(lm.mesh);
        detonateLaserTripMine(lm);
        return true;
      }
      if (kind === 'sticky_c4') {
        const idx = s.stickyC4s.findIndex((c) => c.uid === uid);
        if (idx === -1) return false;
        const c4 = s.stickyC4s[idx];
        s.stickyC4s.splice(idx, 1);
        setPlantedC4Count(s.stickyC4s.length);
        scene.remove(c4.mesh);
        disposeObject3D(c4.mesh);
        detonateGrenadeAt(
          getGrenadeById('sticky_c4', p.grenades),
          c4.pos.x,
          Math.max(0.25, c4.pos.y),
          c4.pos.z
        );
        return true;
      }
      return false;
    };

    /** Collects a placed/deployed consumable (Trip Mine, Laser Mine, Sticky C4, or Turret) via [E] and refunds +1 usage. */
    const collectDeployableByUid = (
      kind: 'trip_mine' | 'laser_trip_mine' | 'sticky_c4' | 'deployable_turret',
      uid: number
    ): boolean => {
      const s = simRef.current;
      const p = propsRef.current;
      if (kind === 'trip_mine') {
        const idx = s.tripMines.findIndex((m) => m.uid === uid);
        if (idx === -1) return false;
        const m = s.tripMines[idx];
        s.tripMines.splice(idx, 1);
        scene.remove(m.mesh);
        disposeObject3D(m.mesh);
        p.onRefundConsumableUsage('trip_mine');
        s.ammoToastTimer = 1.6;
        setAmmoToast('PICKED UP TRIP MINE (+1)');
        return true;
      }
      if (kind === 'laser_trip_mine') {
        const idx = s.laserMines.findIndex((m) => m.uid === uid);
        if (idx === -1) return false;
        const lm = s.laserMines[idx];
        s.laserMines.splice(idx, 1);
        scene.remove(lm.mesh);
        disposeObject3D(lm.mesh);
        p.onRefundConsumableUsage('laser_trip_mine');
        s.ammoToastTimer = 1.6;
        setAmmoToast('PICKED UP LASER MINE (+1)');
        return true;
      }
      if (kind === 'sticky_c4') {
        const idx = s.stickyC4s.findIndex((c) => c.uid === uid);
        if (idx === -1) return false;
        const c4 = s.stickyC4s[idx];
        s.stickyC4s.splice(idx, 1);
        setPlantedC4Count(s.stickyC4s.length);
        scene.remove(c4.mesh);
        disposeObject3D(c4.mesh);
        p.onRefundConsumableUsage('sticky_c4');
        s.ammoToastTimer = 1.6;
        setAmmoToast('PICKED UP STICKY C4 (+1)');
        return true;
      }
      if (kind === 'deployable_turret') {
        const idx = s.turrets.findIndex((t) => t.uid === uid);
        if (idx === -1) return false;
        const tur = s.turrets[idx];
        s.turrets.splice(idx, 1);
        setActiveTurretCount(s.turrets.length);
        scene.remove(tur.mesh);
        disposeObject3D(tur.mesh);
        p.onRefundConsumableUsage('deployable_turret');
        s.ammoToastTimer = 1.6;
        setAmmoToast('PICKED UP TURRET (+1)');
        return true;
      }
      return false;
    };

    const getDeployableHitMeshes = (): THREE.Mesh[] => {
      const s = simRef.current;
      const list: THREE.Mesh[] = [];
      for (const m of s.tripMines) list.push(m.hitMesh);
      for (const lm of s.laserMines) list.push(lm.hitMesh);
      for (const c4 of s.stickyC4s) list.push(c4.hitMesh);
      return list;
    };

    /**
     * Checks whether the crosshair center ray faces an unoccluded placed/deployed consumable
     * within 2.0m horizontal / 2.65m camera-ray distance so the player can pick it up with [E].
     *
     * Why an alternative would be worse: using a blind proximity radius would accidentally pick up a
     * mine behind a wall or a C4 charge behind the player instead of the trap under the reticle.
     */
    const findLookedAtDeployableForPickup = (): {
      kind: 'trip_mine' | 'laser_trip_mine' | 'sticky_c4' | 'deployable_turret';
      uid: number;
      label: string;
    } | null => {
      const s = simRef.current;
      const p = propsRef.current;
      if (p.effectivePaused || p.playerHp <= 0) return null;

      const eligible: THREE.Mesh[] = [];
      for (const m of s.tripMines) {
        if (m.deployGraceTimer <= 0) eligible.push(m.hitMesh);
      }
      for (const lm of s.laserMines) {
        if (lm.deployGraceTimer <= 0) eligible.push(lm.hitMesh);
      }
      for (const c4 of s.stickyC4s) {
        if (c4.deployGraceTimer <= 0) eligible.push(c4.hitMesh);
      }
      for (const tur of s.turrets) {
        if (tur.deployGraceTimer <= 0) eligible.push(tur.hitMesh);
      }
      if (eligible.length === 0) return null;

      raycaster.setFromCamera(_rayCenter, camera);
      const hits = raycaster.intersectObjects(eligible, false);
      if (hits.length === 0) return null;

      const envMeshes = currentRoom.environmentHitMeshes.filter((m) => m.visible);
      if (envMeshes.length > 0) {
        const envHits = raycaster.intersectObjects(envMeshes, false);
        if (envHits.length > 0 && envHits[0].distance < hits[0].distance - 0.1) {
          return null;
        }
      }

      const worldPos = hits[0].object.getWorldPosition(_vec3A);
      const camDist = hits[0].distance;
      const horizDist = Math.hypot(worldPos.x - s.playerX, worldPos.z - s.playerZ);
      if (camDist > 2.65 || (camDist > 2.05 && horizDist > 2.0)) {
        return null;
      }

      const dKind = hits[0].object.userData.deployableKind as
        | 'trip_mine'
        | 'laser_trip_mine'
        | 'sticky_c4'
        | 'deployable_turret'
        | undefined;
      const dUid = hits[0].object.userData.deployableUid as number | undefined;
      if (!dKind || dUid === undefined) return null;

      const label =
        dKind === 'trip_mine'
          ? '[E] PICK UP TRIP MINE (+1)'
          : dKind === 'laser_trip_mine'
            ? '[E] PICK UP LASER MINE (+1)'
            : dKind === 'sticky_c4'
              ? '[E] PICK UP STICKY C4 (+1)'
              : '[E] PICK UP TURRET (+1)';

      return { kind: dKind, uid: dUid, label };
    };

    /** Detonates all planted Sticky Remote C4 charges on a quick Middle Mouse Button click (<180ms). */
    const detonateAllStickyC4 = () => {
      const s = simRef.current;
      if (s.stickyC4s.length === 0) return;
      soundEngine.playC4DetonatorClick();
      const profile = getGrenadeById('sticky_c4', propsRef.current.grenades);
      const snapshot = [...s.stickyC4s];
      s.stickyC4s = [];
      setPlantedC4Count(0);
      for (const c4 of snapshot) {
        detonateGrenadeAt(profile, c4.pos.x, Math.max(0.25, c4.pos.y), c4.pos.z);
        scene.remove(c4.mesh);
        disposeObject3D(c4.mesh);
      }
    };

    /**
     * Throws or deploys the selected consumable (`grenadeId`) after MMB hold-and-release:
     * - Enforces max deployed Sentry Turret limit (default 3) BEFORE deducting inventory usage.
     * - Deploys floor Trip Mines, wall/floor raycasted Laser Trip Mines, ballistic Sticky C4,
     *   forward-facing Sentry Turrets, or 3.0s cook-off thrown canisters (Stun, Incendiary, Frag).
     *
     * Why an alternative would be worse: deducting inventory charges before checking turret cap
     * would burn charges cleanly into thin air; deferring cooldown/deduction ensures failed deploy
     * attempts stay free and reversible.
     */
    const launchPlayerGrenade = (grenadeId: GrenadeId) => {
      const s = simRef.current;
      const p = propsRef.current;
      if (p.effectivePaused || p.playerHp <= 0 || p.grenadeCooldownSec > 0) return;

      const grenade = getGrenadeById(grenadeId, p.grenades);
      if ((p.consumableUsages[grenadeId] ?? 0) <= 0) {
        soundEngine.playGunEmpty();
        s.ammoToastTimer = 1.6;
        setAmmoToast(`NO ${grenade.shortLabel} CHARGES LEFT`);
        return;
      }
      if (grenade.kind === 'TURRET') {
        const turretMax = Math.max(1, grenade.turretMaxDeployed ?? 3);
        if (s.turrets.length >= turretMax) {
          soundEngine.playGunEmpty();
          s.ammoToastTimer = 1.9;
          setAmmoToast(
            `TURRET CAP (${s.turrets.length}/${turretMax}) — DESTROY OR RETRIEVE ONE FIRST`
          );
          return;
        }
      }
      if (!p.onTryUseConsumable(grenade)) {
        soundEngine.playGunEmpty();
        return;
      }

      if (grenade.kind === 'TRIP_MINE') {
        soundEngine.playConsumableDeploy();
        const fwdX = -Math.sin(s.aimYaw);
        const fwdZ = -Math.cos(s.aimYaw);
        const targetPos = resolveRoomCollision2D(
          s.playerX + fwdX * 2.1,
          s.playerZ + fwdZ * 2.1,
          s.playerX,
          s.playerZ,
          0.35,
          p.config.roomId,
          {
            isPlayer: false,
            westDoorBroken: currentRoom.westDoor?.broken ?? true,
            eastDoorBroken: currentRoom.eastDoor?.broken ?? true,
            northDoorBroken: currentRoom.northDoor?.broken ?? true,
            covers: currentRoom.covers,
          }
        );
        const built = buildTripMineMesh3D();
        const uid = s.nextDeployableUid++;
        built.hitMesh.userData = {
          isDeployable: true,
          deployableKind: 'trip_mine',
          deployableUid: uid,
        };
        built.root.position.set(targetPos.x, 0.01, targetPos.z);
        scene.add(built.root);
        s.tripMines.push({
          uid,
          mesh: built.root,
          ledMesh: built.ledMesh,
          hitMesh: built.hitMesh,
          x: targetPos.x,
          y: 0.05,
          z: targetPos.z,
          armTimer: 0.35,
          deployGraceTimer: 0.35,
          triggerRadius: 2.25,
          radiusM: grenade.radiusM,
          damage: grenade.damage,
          staggerDamage: grenade.staggerDamage,
        });
        return;
      }

      if (grenade.kind === 'LASER_TRIP_MINE') {
        soundEngine.playConsumableDeploy();
        const envHitMeshes = currentRoom.environmentHitMeshes.filter((m) => m.visible);
        raycaster.setFromCamera(_rayCenter, camera);
        const hits = raycaster.intersectObjects(envHitMeshes, false);

        const pos = new THREE.Vector3();
        const beamDir = new THREE.Vector3();
        const coneDir = new THREE.Vector3();

        const firstHit = hits[0];
        if (firstHit && firstHit.distance <= 9.5 && firstHit.face) {
          const worldNormal = firstHit.face.normal
            .clone()
            .transformDirection(firstHit.object.matrixWorld)
            .normalize();
          pos.copy(firstHit.point).addScaledVector(worldNormal, 0.09);

          if (Math.abs(worldNormal.y) < 0.65) {
            // Wall-mounted laser mine: laser projects perpendicular to wall, blast projects upward in cone
            beamDir.copy(worldNormal).normalize();
            coneDir.copy(worldNormal).add(new THREE.Vector3(0, 0.42, 0)).normalize();
          } else {
            // Floor hit: project forward along player aim & tilted upward
            const camDir = new THREE.Vector3();
            camera.getWorldDirection(camDir);
            beamDir.set(camDir.x, 0.18, camDir.z).normalize();
            coneDir.set(camDir.x, 0.68, camDir.z).normalize();
          }
        } else {
          // Place on floor 2.1m in front aiming outward & upward
          const fwdX = -Math.sin(s.aimYaw);
          const fwdZ = -Math.cos(s.aimYaw);
          const floorPos = resolveRoomCollision2D(
            s.playerX + fwdX * 2.1,
            s.playerZ + fwdZ * 2.1,
            s.playerX,
            s.playerZ,
            0.35,
            p.config.roomId,
            {
              isPlayer: false,
              westDoorBroken: currentRoom.westDoor?.broken ?? true,
              eastDoorBroken: currentRoom.eastDoor?.broken ?? true,
              northDoorBroken: currentRoom.northDoor?.broken ?? true,
              covers: currentRoom.covers,
            }
          );
          pos.set(floorPos.x, 0.14, floorPos.z);
          beamDir.set(fwdX, 0.18, fwdZ).normalize();
          coneDir.set(fwdX, 0.68, fwdZ).normalize();
        }

        const dropRange = getGrenadeDropRangeM(grenade);
        const rayTest = new THREE.Raycaster(pos, beamDir, 0.15, dropRange);
        const wallBlock = rayTest.intersectObjects(envHitMeshes, false);
        const actualBeamLen =
          wallBlock.length > 0 ? Math.max(1.2, Math.min(dropRange, wallBlock[0].distance)) : dropRange;

        const built = buildLaserTripMineMesh3D(actualBeamLen);
        const uid = s.nextDeployableUid++;
        built.hitMesh.userData = {
          isDeployable: true,
          deployableKind: 'laser_trip_mine',
          deployableUid: uid,
        };
        built.root.position.copy(pos);
        built.root.lookAt(pos.clone().add(beamDir));
        scene.add(built.root);

        s.laserMines.push({
          uid,
          mesh: built.root,
          beamMesh: built.beamMesh,
          hitMesh: built.hitMesh,
          pos,
          beamDir,
          coneDir,
          beamLength: actualBeamLen,
          armTimer: 0.35,
          deployGraceTimer: 0.35,
          rangeM: dropRange,
          maxDamage: grenade.damage,
          pierceDepthM: grenade.pierceDepthM ?? 12,
          staggerDamage: grenade.staggerDamage,
        });
        return;
      }

      if (grenade.kind === 'STICKY_C4') {
        soundEngine.playGrenadeThrow();
        const built = buildStickyC4Mesh3D();
        const uid = s.nextDeployableUid++;
        built.hitMesh.userData = {
          isDeployable: true,
          deployableKind: 'sticky_c4',
          deployableUid: uid,
        };
        const dir = new THREE.Vector3();
        camera.getWorldDirection(dir);
        built.root.position.copy(camera.position).addScaledVector(dir, 0.72);
        built.root.position.y -= 0.12;
        scene.add(built.root);

        const throwSpeed = 23.0;
        s.stickyC4s.push({
          uid,
          mesh: built.root,
          ledMesh: built.ledMesh,
          hitMesh: built.hitMesh,
          pos: built.root.position.clone(),
          vx: dir.x * throwSpeed,
          vy: dir.y * throwSpeed + 2.8,
          vz: dir.z * throwSpeed,
          stuck: false,
          deployGraceTimer: 0.35,
          attachedActorUid: null,
          localOffset: new THREE.Vector3(),
          radiusM: getGrenadeDropRangeM(grenade),
          damage: grenade.damage,
          staggerDamage: grenade.staggerDamage,
        });
        setPlantedC4Count(s.stickyC4s.length);
        return;
      }

      if (grenade.kind === 'TURRET') {
        soundEngine.playConsumableDeploy();
        const fwdX = -Math.sin(s.aimYaw);
        const fwdZ = -Math.cos(s.aimYaw);
        const targetPos = resolveRoomCollision2D(
          s.playerX + fwdX * 2.1,
          s.playerZ + fwdZ * 2.1,
          s.playerX,
          s.playerZ,
          0.55,
          p.config.roomId,
          {
            isPlayer: false,
            westDoorBroken: currentRoom.westDoor?.broken ?? true,
            eastDoorBroken: currentRoom.eastDoor?.broken ?? true,
            northDoorBroken: currentRoom.northDoor?.broken ?? true,
            covers: currentRoom.covers,
          }
        );

        const uid = s.nextDeployableUid++;
        const built = buildDeployableTurretMesh3D();
        built.hitMesh.userData = {
          isDeployable: true,
          deployableKind: 'deployable_turret',
          deployableUid: uid,
        };
        built.root.position.set(targetPos.x, 0, targetPos.z);
        // Local +Z faces along forward vector (fwdX, fwdZ) => atan2(fwdX, fwdZ)
        const baseYaw = Math.atan2(fwdX, fwdZ);
        built.root.rotation.y = baseYaw;
        scene.add(built.root);

        const maxTurretHp = grenade.turretHp ?? 150;
        s.turrets.push({
          uid,
          mesh: built.root,
          yawGroup: built.yawGroup,
          pitchGroup: built.pitchGroup,
          muzzlePoint: built.muzzlePoint,
          muzzleFlash: built.muzzleFlash,
          hitMesh: built.hitMesh,
          pos: new THREE.Vector3(targetPos.x, 0.858, targetPos.z),
          baseYaw,
          currentRelYaw: 0,
          currentPitch: 0,
          fireCooldown: 0.25,
          muzzleFlashTimer: 0,
          deployGraceTimer: 0.35,
          damage: grenade.damage,
          hp: maxTurretHp,
          maxHp: maxTurretHp,
          armorMult: grenade.turretArmorMult ?? 0.7,
        });
        setActiveTurretCount(s.turrets.length);
        return;
      }

      // Standard thrown canisters (Stun, Incendiary, Explosive) with 3.0s cook-off fuse & bounce
      soundEngine.playGrenadeThrow();

      const grp = new THREE.Group();
      const canMat = new THREE.MeshStandardMaterial({
        color: 0x2a3342,
        roughness: 0.35,
        metalness: 0.78,
      });
      const bandMat = new THREE.MeshStandardMaterial({
        color: grenade.accentHex,
        emissive: grenade.accentHex,
        emissiveIntensity: 1.6,
        roughness: 0.25,
      });
      const body = new THREE.Mesh(grenadeBodyGeo, canMat);
      const band = new THREE.Mesh(
        new THREE.CylinderGeometry(0.086, 0.086, 0.06, 10),
        bandMat
      );
      grp.add(body);
      grp.add(band);

      const dir = new THREE.Vector3();
      camera.getWorldDirection(dir);
      grp.position.copy(camera.position).addScaledVector(dir, 0.75);
      grp.position.y -= 0.14;
      scene.add(grp);

      const throwSpeed = 20.5;
      s.thrownGrenades.push({
        mesh: grp,
        profile: grenade,
        vx: dir.x * throwSpeed,
        vy: dir.y * throwSpeed + 3.6,
        vz: dir.z * throwSpeed,
        fuseTimer: 3.0,
        bounced: false,
        impactedActorUids: new Set<number>(),
      });
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
      chargePct = 1,
      staggerMult = 1.0
    ) => {
      const s = simRef.current;
      const weapon = getWeaponById(propsRef.current.config.weaponId, propsRef.current.weapons);
      s.meleeAction = isShove ? 'SHOVE' : 'SWING';
      s.meleeAnimStyle = style;
      s.meleeAnimPhase = 0;
      s.meleeAnimDuration = Math.max(0.16, durationSec);
      s.meleeHitExecuted = false;
      s.meleeStrikeDamage = damage;
      s.meleeStrikeIsAoe = isAoe;
      s.meleeStrikeArcDeg = aoeArcDeg;
      s.meleeStrikeStaggerOverride = staggerOverride;
      s.meleeStrikeStaggerMultiplier = staggerMult;
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
        if (actor.alive) {
          for (const hm of actor.model.hitMeshes) {
            if (hm.visible) aliveHitMeshes.push(hm);
          }
        }
      }
      const envHitMeshes = currentRoom.environmentHitMeshes.filter((m) => m.visible);
      const deployableHitMeshes = getDeployableHitMeshes();

      raycaster.setFromCamera(_rayCenter, camera);
      const rayHits = raycaster.intersectObjects(
        [...aliveHitMeshes, ...deployableHitMeshes, ...envHitMeshes],
        false
      );

      // Check if melee swing hits an intact grey door, breakable cover, shield, or planted mine/C4 in range
      if (rayHits.length > 0 && rayHits[0].distance <= reach + 0.65) {
        const hitData = rayHits[0].object.userData;
        if (hitData.isDeployable) {
          detonateDeployableByUid(hitData.deployableKind, hitData.deployableUid);
          return;
        }
        if (hitData.isCover) {
          const cov = currentRoom.covers.find((c) => c.id === hitData.coverId);
          if (cov && !cov.broken) {
            soundEngine.playMeleeImpact(false, s.meleeStrikeIsShove);
            damageCover(cov, s.meleeStrikeDamage * 0.3);
            const wn = rayHits[0].face
              ? rayHits[0].face.normal.clone().transformDirection(rayHits[0].object.matrixWorld).normalize()
              : null;
            spawnBulletImpact(rayHits[0].point, wn, 'COVER');
          }
        }
        const doorSide = hitData.doorSide as 'west' | 'east' | 'north' | undefined;
        if (doorSide) {
          const door = getDoorBySide(doorSide);
          if (door && !door.broken) {
            soundEngine.playMeleeImpact(false, s.meleeStrikeIsShove);
            damageDoor(door, s.meleeStrikeDamage);
          }
        }
      }

      let directActor: EnemyActor | null = null;
      let directZone: HitZoneId = p.config.aimZone;
      let directRegion: BodyRegionKey = 'torso';
      let directHitShield = false;
      let directSubPart: 'atgm' | 'rocket_pods' | undefined;
      let directHitPoint: THREE.Vector3 | null = null;

      for (const h of rayHits) {
        if (h.distance > reach + 0.6) break;
        if (h.object.userData.isWall || h.object.userData.doorSide || h.object.userData.isCover) break;
        if (h.object.userData.enemyIdx !== undefined) {
          const enemyIdx = h.object.userData.enemyIdx as number;
          const candidate = s.enemies.find((e) => e.uid === enemyIdx && e.alive) ?? null;
          if (!candidate) continue;
          if (h.object.userData.isShield && candidate.shieldHp <= 0) continue;
          const sp = h.object.userData.subPart as 'atgm' | 'rocket_pods' | undefined;
          if (sp === 'atgm' && candidate.components.atgmDestroyed) continue;
          if (sp === 'rocket_pods' && candidate.components.rocketPodDestroyed) continue;
          directActor = candidate;
          directZone = (h.object.userData.hitZone as HitZoneId) ?? 'torso';
          directRegion = (h.object.userData.bodyRegion as BodyRegionKey) ?? 'torso';
          directHitShield = Boolean(h.object.userData.isShield && candidate.shieldHp > 0);
          directSubPart = sp;
          directHitPoint = h.point.clone();
          break;
        }
      }

      const fwdX = -Math.sin(s.aimYaw);
      const fwdZ = -Math.cos(s.aimYaw);
      const halfArcRad = THREE.MathUtils.degToRad(s.meleeStrikeArcDeg * 0.58);

      const struckActors: { actor: EnemyActor; zone: HitZoneId; region: BodyRegionKey; hitShield: boolean }[] = [];

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
              struckActors.push({
                actor,
                zone,
                region: actor === directActor ? directRegion : 'torso',
                hitShield: actor === directActor ? directHitShield : false,
              });
            }
          }
        }
      } else if (directActor) {
        struckActors.push({
          actor: directActor,
          zone: directZone,
          region: directRegion,
          hitShield: directHitShield,
        });
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
          struckActors.push({ actor: bestActor, zone: 'torso', region: 'torso', hitShield: false });
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

      /** Converts a 3D world-space hit coordinate into normalized anatomical heatmap coordinates. */
      const toBodyNormalized = (actor: EnemyActor, worldPt: THREE.Vector3): { nx: number; ny: number } => {
        actor.model.root.updateMatrixWorld();
        _vec3C.copy(worldPt);
        actor.model.root.worldToLocal(_vec3C);
        return {
          nx: THREE.MathUtils.clamp(_vec3C.x / 0.85, -1.2, 1.2),
          ny: THREE.MathUtils.clamp(_vec3C.y / 2.25, -0.05, 1.15),
        };
      };

      const meleeTelemetryEvents: ShotTelemetryEvent[] = [];

      for (const item of struckActors) {
        const { actor, zone, region, hitShield } = item;

        // Riot Shield interception absorbs melee strike (except tactical shove stagger)
        if (hitShield && actor.shieldHp > 0 && !s.meleeStrikeIsShove) {
          const sDmg = Math.max(1, Math.round(s.meleeStrikeDamage));
          actor.shieldHp = Math.max(0, actor.shieldHp - sDmg);
          actor.components.regionHits.shield = (actor.components.regionHits.shield ?? 0) + 1;
          updateRegionWeathering(actor, 'shield');
          soundEngine.playShieldHit();
          spawnBulletImpact(directHitPoint ?? _vec3B.set(actor.x, 1.2, actor.z), null, 'SHIELD');
          if (actor.shieldHp <= 0 && actor.model.shieldGroup) {
            actor.model.shieldGroup.visible = false;
            for (const hm of actor.model.hitMeshes) {
              if (hm.userData.isShield) hm.visible = false;
            }
          }
          totalRaw += sDmg;
          primaryName = actor.profile.name;
          primaryDist = Math.max(
            1,
            Math.round(Math.hypot(actor.x - camera.position.x, actor.z - camera.position.z))
          );
          primaryRemHp = actor.hp;
          primaryZone = 'torso';
          primaryZoneLabel = actor.shieldHp <= 0 ? `${s.meleeStrikeLabel} · SHIELD BROKEN` : `${s.meleeStrikeLabel} · SHIELD`;
          continue;
        }

        const wasStaggered = actor.staggerTimer > 0;
        const targetProfileForHit =
          actor === directActor && directSubPart
            ? {
                ...actor.profile,
                torsoMultiplier: directSubPart === 'atgm' ? 0.6 : 0.8,
              }
            : actor.profile;
        const res = resolveMeleeHit(
          weapon,
          targetProfileForHit,
          actor.hp,
          actor === directActor && directSubPart ? 'torso' : zone,
          s.meleeStrikeDamage,
          s.meleeStrikeStaggerOverride,
          wasStaggered,
          s.meleeStrikeStaggerMultiplier
        );

        const outcome = applyDamageAndStagger(actor, res.nextHp, res.staggerDamage);
        if (actor === directActor && directSubPart === 'atgm' && !actor.components.atgmDestroyed) {
          actor.components.atgmHp = Math.max(0, actor.components.atgmHp - res.hpDamage);
          if (actor.components.atgmHp <= 0) {
            triggerWeaponPodDestruction(actor, 'atgm');
          }
        } else if (actor === directActor && directSubPart === 'rocket_pods' && !actor.components.rocketPodDestroyed) {
          actor.components.rocketPodHp = Math.max(0, actor.components.rocketPodHp - res.hpDamage);
          if (actor.components.rocketPodHp <= 0) {
            triggerWeaponPodDestruction(actor, 'rocket_pods');
          }
        }
        const compOutcome = applyComponentHit(
          actor,
          region,
          zone === 'weakspot' ? 1.8 : zone === 'limb' ? 0.65 : 1.25,
          res.hpDamage,
          res.isCrit,
          outcome.killed
        );
        const finalKilled = outcome.killed || compOutcome.executedByHeadCap || !actor.alive;
        if (finalKilled) {
          anyKill = true;
          if (outcome.enemyTtkMs !== null) killedTtks.push(outcome.enemyTtkMs);
        }
        if (outcome.triggeredStagger) anyStagger = true;
        if (res.isCrit) anyCrit = true;

        const impactWorld = _vec3B.set(
          actor.x,
          zone === 'weakspot'
            ? actor.profile.scaleY * 1.88
            : zone === 'limb'
              ? actor.profile.scaleY * 0.65
              : actor.profile.scaleY * 1.28,
          actor.z
        );
        spawnBulletImpact(impactWorld, null, 'ENEMY');
        const norm = toBodyNormalized(actor, impactWorld);
        meleeTelemetryEvents.push({
          enemyUid: actor.encounterId,
          targetId: actor.profile.id,
          targetName: actor.profile.name,
          targetCode: actor.profile.code,
          silhouette: actor.profile.silhouette,
          waveNumber: p.waveNumber,
          zone,
          nx: norm.nx,
          ny: norm.ny,
          damage: res.hpDamage,
          isKill: finalKilled,
          enemyTtkMs: outcome.enemyTtkMs,
        });

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
              northDoorBroken: currentRoom.northDoor?.broken ?? true,
              covers: currentRoom.covers,
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
        const primaryHitActor = struckActors[0].actor;
        soundEngine.playMeleeImpact(anyCrit, s.meleeStrikeIsShove);
        s.meleeImpactBounce = s.meleeStrikeIsSpecial ? 1.0 : s.meleeStrikeIsShove ? 0.8 : 0.65;
        s.cameraShake = Math.max(
          s.cameraShake,
          s.meleeStrikeIsShove ? 0.28 : s.meleeStrikeIsSpecial ? 0.5 * s.meleeStrikeChargePct : 0.22
        );
        pushHitVisuals(totalHp, anyCrit, anyKill, anyStagger, 0, {
          x: primaryHitActor.x,
          y: primaryHitActor.profile.scaleY * 1.65,
          z: primaryHitActor.z,
        });
      }

      const avgMeleeEnemyTtkMs =
        killedTtks.length > 0
          ? Math.round(killedTtks.reduce((a, b) => a + b, 0) / killedTtks.length)
          : null;

      p.onSquadShotResolved({
        roundsFiredDelta: 1,
        weaponId: weapon.id,
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
        telemetryEvents: meleeTelemetryEvents,
      });

      checkSquadCleared();
    };

    /**
     * Fires one round (or multi-pellet buckshot fan) from the active firearm:
     * 1. Enforces RPM gating (`60000 / (rpm * modeRpmFactor)`), unless `bypassCooldown` is passed on
     *    a direct semi-auto LMB click, and allows `shellByShellReload` shotguns (`Tempest Breacher`)
     *    to interrupt reload immediately whenever `magRemaining > 0`.
     * 2. Deducts ammunition atomically through `propsRef.current.onTriggerShot()`.
     * 3. Iterates `k = 0..pellets-1`: casts a `THREE.Raycaster` across alive enemy hit meshes,
     *    deployed traps/C4, and visible walls/covers/doors, walking intersections near-to-far:
     *    - Stops on covers (`damageCover`), walls, doors (`damageDoor`), or deployables (chain detonate).
     *    - Blocks on intact ballistic Riot Shields (bleeding 25% if `armorPenetration >= 0.85`).
     *    - On body/weakspot hits: evaluates `resolveShot`, applies stagger/damage + localized
     *      `applyComponentHit` + progressive rust weathering + `spawnBulletImpact` sparks, emits
     *      normalized `(nx, ny)` telemetry coordinates, and decrements `remainingPenM` by torso/limb
     *      thickness until the round exits or runs out of pierce depth.
     *    - On misses/blocked shots: runs `collectNearMissEvents` (within `0.10m` of trunk/head) so
     *      close grazing shots appear on anatomical heatmaps.
     * 4. Applies progressive recoil kick, bolt blowback, muzzle flash, and reports one aggregated
     *    `SquadShotSummary` back to `App.tsx` (which keeps per-enemy STK counters accurate).
     *
     * Why an alternative would be worse: simulating physical 3D projectile meshes for 3,600-RPM
     * hitscan/hyper-velocity bullets would suffer frame-rate tunneling through thin weakspots at
     * close range; sorted `Raycaster` multi-hit traversal guarantees exact hit/pierce resolution at any FPS.
     */
    const fireWeaponOnce = (isUserTrigger = false, bypassCooldown = false) => {
      const p = propsRef.current;
      const s = simRef.current;
      if (p.effectivePaused || p.config.activeSlot === 'CONSUMABLE') return;
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
              step.label,
              1,
              step.staggerMultiplier ?? 1.0
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
      // Semi precision fires as fast as LMB is tapped when triggered directly by user click
      if (!bypassCooldown && now - s.lastFireTimeMs < minIntervalMs) return;
      if (p.playerHp <= 0) {
        s.burstShotsRemaining = 0;
        return;
      }

      const canInterruptReload = p.isReloading && !!weapon.shellByShellReload && p.magRemaining > 0;
      if ((p.isReloading && !canInterruptReload) || p.magRemaining <= 0) {
        s.burstShotsRemaining = 0;
        if (isUserTrigger) {
          soundEngine.playGunEmpty();
        }
        return;
      }

      const canFire = p.onTriggerShot();
      if (!canFire) {
        s.burstShotsRemaining = 0;
        if (isUserTrigger) {
          soundEngine.playGunEmpty();
        }
        return;
      }

      if (canInterruptReload || s.reloadAnimActive) {
        s.reloadAnimActive = false;
        s.reloadAnimElapsed = 0;
        s.wasReloading = false;
        if (currentWeapon3D.shellMesh) {
          currentWeapon3D.shellMesh.visible = false;
        }
      }

      s.lastFireTimeMs = now;
      soundEngine.playWeaponFire(weapon.id);
      const muzzleWorld = currentWeapon3D.muzzlePoint.getWorldPosition(_vec3A);

      const aliveHitMeshes: THREE.Mesh[] = [];
      for (const actor of s.enemies) {
        if (actor.alive) {
          for (const hm of actor.model.hitMeshes) {
            if (hm.visible) aliveHitMeshes.push(hm);
          }
        }
      }
      const envHitMeshes = currentRoom.environmentHitMeshes.filter((m) => m.visible);
      const deployableHitMeshes = getDeployableHitMeshes();
      const allShootMeshes = [...aliveHitMeshes, ...deployableHitMeshes, ...envHitMeshes];

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
      const shotTelemetryEvents: ShotTelemetryEvent[] = [];

      /**
       * Tests a missed ray segment against alive enemy silhouettes to capture misses within 0.10m
       * of head, torso/shoulders/arms, or legs in world space for telemetry heatmap generation.
       */
      const collectNearMissEvents = (rayOrigin: THREE.Vector3, rayDir: THREE.Vector3, maxRayDist: number) => {
        const nearMissPt = new THREE.Vector3();
        const dirXZSq = rayDir.x * rayDir.x + rayDir.z * rayDir.z;

        for (const actor of s.enemies) {
          if (!actor.alive) continue;
          const sx = actor.profile.scaleXZ;
          const sy = actor.profile.scaleY;
          const isDrone = actor.profile.silhouette === 'drone';
          const candidateTs: number[] = [];

          // 1) Closest point along ray to enemy vertical trunk axis in XZ
          if (dirXZSq > 1e-6) {
            const tTrunk = THREE.MathUtils.clamp(
              -((rayOrigin.x - actor.x) * rayDir.x + (rayOrigin.z - actor.z) * rayDir.z) / dirXZSq,
              0,
              maxRayDist
            );
            candidateTs.push(tTrunk);
          }
          // 2) Closest point along ray to enemy head/weakspot center
          const headY = isDrone ? 1.72 : 1.92 * sy;
          const tHead = THREE.MathUtils.clamp(
            (actor.x - rayOrigin.x) * rayDir.x +
              (headY - rayOrigin.y) * rayDir.y +
              (actor.z - rayOrigin.z) * rayDir.z,
            0,
            maxRayDist
          );
          candidateTs.push(tHead);

          let bestDistM = Infinity;
          let bestLocalX = 0;
          let bestLocalY = 0;

          actor.model.root.updateMatrixWorld();
          for (const tCand of candidateTs) {
            nearMissPt.copy(rayOrigin).addScaledVector(rayDir, tCand);
            _vec3C.copy(nearMissPt);
            actor.model.root.worldToLocal(_vec3C);

            const lx = _vec3C.x;
            const ly = _vec3C.y;
            const lz = _vec3C.z;

            // Surface distance (meters) to Head, Torso+Arms, and Legs bounding boxes
            const dHead = Math.hypot(
              Math.max(0, Math.abs(lx) - 0.19) * sx,
              Math.max(0, ly < 1.72 ? 1.72 - ly : ly > 2.18 ? ly - 2.18 : 0) * sy,
              Math.max(0, Math.abs(lz) - 0.19) * sx
            );
            const dTorso = Math.hypot(
              Math.max(0, Math.abs(lx) - 0.56) * sx,
              Math.max(0, ly < 0.88 ? 0.88 - ly : ly > 1.72 ? ly - 1.72 : 0) * sy,
              Math.max(0, Math.abs(lz) - 0.24) * sx
            );
            const dLegs = isDrone
              ? Infinity
              : Math.hypot(
                  Math.max(0, Math.abs(lx) - 0.34) * sx,
                  Math.max(0, ly < 0 ? -ly : ly > 0.88 ? ly - 0.88 : 0) * sy,
                  Math.max(0, Math.abs(lz) - 0.22) * sx
                );

            const dMin = Math.min(dHead, dTorso, dLegs);
            if (dMin < bestDistM) {
              bestDistM = dMin;
              bestLocalX = lx;
              bestLocalY = ly;
            }
          }

          if (bestDistM > 0 && bestDistM <= 0.1) {
            shotTelemetryEvents.push({
              enemyUid: actor.encounterId,
              targetId: actor.profile.id,
              targetName: actor.profile.name,
              targetCode: actor.profile.code,
              silhouette: actor.profile.silhouette,
              waveNumber: p.waveNumber,
              zone: 'miss',
              nx: THREE.MathUtils.clamp(bestLocalX / 0.85, -1.2, 1.2),
              ny: THREE.MathUtils.clamp(bestLocalY / 2.25, -0.05, 1.15),
              damage: 0,
              isKill: false,
              enemyTtkMs: null,
            });
          }
        }
      };

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
          let blockerDist = 140;

          for (const hit of intersects) {
            const worldNormal = hit.face
              ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize()
              : null;

            // Check environment walls / breakable covers / doors / planted deployables in distance order
            if (hit.object.userData.isCover) {
              const cov = currentRoom.covers.find((c) => c.id === hit.object.userData.coverId);
              if (cov && !cov.broken) {
                anyDoorHit = true;
                damageCover(cov, weapon.baseDamage * (pellets > 1 ? 0.65 : 1) * 0.3);
                spawnBulletImpact(hit.point, worldNormal, 'COVER');
                terminalHitPoint = hit.point;
                blockerDist = hit.distance;
                break;
              }
              continue;
            }
            if (hit.object.userData.isWall) {
              spawnBulletImpact(hit.point, worldNormal, 'ENV');
              terminalHitPoint = hit.point;
              blockerDist = hit.distance;
              break;
            }
            if (hit.object.userData.isDeployable) {
              const kind = hit.object.userData.deployableKind as
                | 'trip_mine'
                | 'laser_trip_mine'
                | 'sticky_c4';
              const dUid = hit.object.userData.deployableUid as number;
              detonateDeployableByUid(kind, dUid);
              terminalHitPoint = hit.point;
              blockerDist = hit.distance;
              pelletHitSomething = true;
              break;
            }
            const doorSide = hit.object.userData.doorSide as 'west' | 'east' | 'north' | undefined;
            if (doorSide) {
              const door = getDoorBySide(doorSide);
              if (door && !door.broken) {
                anyDoorHit = true;
                damageDoor(door, weapon.baseDamage * (pellets > 1 ? 0.6 : 1));
                spawnBulletImpact(hit.point, worldNormal, 'ENV');
                terminalHitPoint = hit.point;
                blockerDist = hit.distance;
                break;
              }
              continue;
            }

            const enemyIdx = hit.object.userData.enemyIdx as number | undefined;
            if (enemyIdx === undefined || hitEnemyIds.has(enemyIdx)) continue;
            const actor = s.enemies.find((e) => e.uid === enemyIdx && e.alive);
            if (!actor) continue;

            // Ballistic Riot Shield check: absorbs gunfire until shattered (85%+ AP guns bleed 25% through)
            if (hit.object.userData.isShield) {
              if (actor.shieldHp <= 0) continue;
              pelletHitSomething = true;
              hitEnemyIds.add(enemyIdx);
              const shieldDmg = Math.max(
                1,
                Math.round(weapon.baseDamage * (pellets > 1 ? 0.85 : 1))
              );
              actor.shieldHp = Math.max(0, actor.shieldHp - shieldDmg);
              actor.components.regionHits.shield = (actor.components.regionHits.shield ?? 0) + 1;
              updateRegionWeathering(actor, 'shield');
              soundEngine.playShieldHit();
              spawnBulletImpact(hit.point, worldNormal, 'SHIELD');
              if (actor.shieldHp <= 0 && actor.model.shieldGroup) {
                actor.model.shieldGroup.visible = false;
                for (const hm of actor.model.hitMeshes) {
                  if (hm.userData.isShield) hm.visible = false;
                }
              }
              const distM = Math.max(
                1,
                Math.round(Math.hypot(actor.x - camera.position.x, actor.z - camera.position.z))
              );
              terminalHitPoint = hit.point;
              hitCount += 1;
              totalRawDamage += shieldDmg;
              if (pelletPierceIdx === 0) {
                primaryZone = 'torso';
                primaryZoneLabel =
                  actor.shieldHp <= 0 ? 'RIOT SHIELD SHATTERED' : 'SHIELD BLOCKED';
                primaryTargetName = actor.profile.name;
                primaryDistM = distM;
                primaryRemHp = actor.hp;
              }
              if (weapon.armorPenetration >= 0.85) {
                const bleedDmg = Math.max(1, Math.round(shieldDmg * 0.25));
                const out = applyDamageAndStagger(
                  actor,
                  Math.max(0, actor.hp - bleedDmg),
                  Math.round(shieldDmg * 0.25)
                );
                totalHpDamage += bleedDmg;
                if (out.killed) {
                  anyKill = true;
                  if (out.enemyTtkMs !== null) killedTtks.push(out.enemyTtkMs);
                }
              }
              break;
            }

            const subPart = hit.object.userData.subPart as 'atgm' | 'rocket_pods' | undefined;
            if (subPart === 'atgm' && actor.components.atgmDestroyed) continue;
            if (subPart === 'rocket_pods' && actor.components.rocketPodDestroyed) continue;

            pelletHitSomething = true;
            hitEnemyIds.add(enemyIdx);
            const rawHitZone = (hit.object.userData.hitZone as HitZoneId) ?? 'torso';
            const hitZone: HitZoneId = subPart ? 'torso' : rawHitZone;
            const bodyRegion: BodyRegionKey =
              (hit.object.userData.bodyRegion as BodyRegionKey) ??
              (hitZone === 'weakspot' ? 'head' : 'torso');
            const distMeters = Math.max(
              1,
              Math.round(Math.hypot(actor.x - camera.position.x, actor.z - camera.position.z))
            );
            const penFactor = Math.pow(dropRatio, pelletPierceIdx);
            const wasStaggered = actor.staggerTimer > 0;

            const targetsForHit = subPart
              ? p.targets.map((tp) =>
                  tp.id === actor.profile.id
                    ? { ...tp, torsoMultiplier: subPart === 'atgm' ? 0.6 : 0.8 }
                    : tp
                )
              : p.targets;

            const res = resolveShot(
              p.config,
              actor.hp,
              hitZone,
              true,
              s.shotIndexInBurst * pellets + k,
              distMeters,
              actor.profile.id,
              p.weapons,
              targetsForHit,
              penFactor,
              wasStaggered
            );

            actor.model.root.updateMatrixWorld();
            _vec3C.copy(hit.point);
            actor.model.root.worldToLocal(_vec3C);

            const outcome = applyDamageAndStagger(actor, res.nextHp, res.staggerDamage);
            let podDestroyedNow = false;
            if (subPart === 'atgm' && !actor.components.atgmDestroyed) {
              actor.components.atgmHp = Math.max(0, actor.components.atgmHp - res.hpDamage);
              if (actor.components.atgmHp <= 0) {
                podDestroyedNow = true;
                triggerWeaponPodDestruction(actor, 'atgm');
              }
            } else if (subPart === 'rocket_pods' && !actor.components.rocketPodDestroyed) {
              actor.components.rocketPodHp = Math.max(0, actor.components.rocketPodHp - res.hpDamage);
              if (actor.components.rocketPodHp <= 0) {
                podDestroyedNow = true;
                triggerWeaponPodDestruction(actor, 'rocket_pods');
              }
            }
            const compOutcome = applyComponentHit(
              actor,
              bodyRegion,
              _vec3C.y,
              res.hpDamage,
              res.isCrit,
              outcome.killed
            );
            const finalKilled = outcome.killed || compOutcome.executedByHeadCap || !actor.alive;
            if (finalKilled) {
              anyKill = true;
              if (outcome.enemyTtkMs !== null) killedTtks.push(outcome.enemyTtkMs);
            }
            if (outcome.triggeredStagger) anyStagger = true;

            spawnBulletImpact(hit.point, worldNormal, 'ENEMY');
            shotTelemetryEvents.push({
              enemyUid: actor.encounterId,
              targetId: actor.profile.id,
              targetName: actor.profile.name,
              targetCode: actor.profile.code,
              silhouette: actor.profile.silhouette,
              waveNumber: p.waveNumber,
              zone: hitZone,
              nx: THREE.MathUtils.clamp(_vec3C.x / 0.85, -1.2, 1.2),
              ny: THREE.MathUtils.clamp(_vec3C.y / 2.25, -0.05, 1.15),
              damage: res.hpDamage,
              isKill: finalKilled,
              enemyTtkMs: outcome.enemyTtkMs,
            });

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
              const resolvedZoneLabel = subPart === 'atgm'
                ? podDestroyedNow
                  ? 'ATGM POD DESTROYED'
                  : 'ATGM Launcher (0.6x)'
                : subPart === 'rocket_pods'
                  ? podDestroyedNow
                    ? 'ROCKET PODS DESTROYED'
                    : 'Rocket Pods (0.8x)'
                  : res.zoneLabel;
              primaryZoneLabel =
                pellets > 1
                  ? `${hitCount}/${pellets} Pellets · ${resolvedZoneLabel}`
                  : `${resolvedZoneLabel}${wasStaggered ? ' [STAG]' : ''}`;
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

          if (!pelletHitSomething) {
            collectNearMissEvents(raycaster.ray.origin, raycaster.ray.direction, blockerDist);
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
          let missDistMax = 120;
          if (raycaster.ray.direction.y < -0.001) {
            const groundT = -raycaster.ray.origin.y / raycaster.ray.direction.y;
            if (groundT > 0 && groundT < 320) {
              missPoint = _vec3B
                .copy(raycaster.ray.origin)
                .addScaledVector(raycaster.ray.direction, groundT)
                .clone();
              missDistMax = groundT;
              hitGroundThisPellet = true;
              anyGroundHit = true;
              spawnBulletImpact(missPoint, new THREE.Vector3(0, 1, 0), 'ENV');
            } else {
              missPoint = _vec3B
                .copy(raycaster.ray.origin)
                .addScaledVector(raycaster.ray.direction, 120)
                .clone();
            }
          } else {
            missPoint = _vec3B
              .copy(raycaster.ray.origin)
              .addScaledVector(raycaster.ray.direction, 120)
              .clone();
          }
          collectNearMissEvents(raycaster.ray.origin, raycaster.ray.direction, missDistMax);
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
      s.shotBoltKick = 0.034;
      s.muzzleFlashTimer = 0.055;
      currentWeapon3D.muzzleFlash.visible = true;

      const avgShotEnemyTtkMs =
        killedTtks.length > 0
          ? Math.round(killedTtks.reduce((a, b) => a + b, 0) / killedTtks.length)
          : null;

      p.onSquadShotResolved({
        roundsFiredDelta: 1,
        weaponId: weapon.id,
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
        telemetryEvents: shotTelemetryEvents,
      });

      let firstImpactWorld: { x: number; y: number; z: number } | undefined;
      for (const actor of s.enemies) {
        if (actor.profile.name === primaryTargetName) {
          firstImpactWorld = {
            x: actor.x,
            y: actor.profile.scaleY * 1.65,
            z: actor.z,
          };
          break;
        }
      }

      if (hitCount > 0) {
        pushHitVisuals(totalHpDamage, anyCrit, anyKill, anyStagger, pierceCount, firstImpactWorld);
      }

      checkSquadCleared();
    };

    const dom = renderer.domElement;
    let wasPointerLocked = false;
    let isDisposed = false;

    /**
     * Recenters the virtual cursor tracking coordinates (`prevClientX/Y`) to the viewport midpoint
     * and applies a short delta-ignore window (`graceMs`) to absorb browser cursor-warp spikes.
     *
     * Why an alternative would be worse: without clearing `hasPrevClientMouse` and setting a delta
     * gate, transitioning in/out of Pointer Lock or releasing `Ctrl` causes a massive synthetic jump
     * (`e.movementY` or `e.clientY - prevClientY`), snapping the player's aim straight to the floor.
     */
    const centerVirtualMouseInViewport = (graceMs = 85) => {
      const s = simRef.current;
      const targetEl = viewportRef.current ?? dom;
      const rect = targetEl.getBoundingClientRect();
      s.prevClientX = rect.left + rect.width * 0.5;
      s.prevClientY = rect.top + rect.height * 0.5;
      s.hasPrevClientMouse = false;
      s.edgePanDir = 0;
      s.edgePanArmed = false;
      s.ignoreMouseDeltaUntilMs = Math.max(s.ignoreMouseDeltaUntilMs, performance.now() + graceMs);
    };

    centerViewportCursorRef.current = (graceMs = 85, requestLock = false) => {
      centerVirtualMouseInViewport(graceMs);
      if (
        requestLock &&
        propsRef.current.isScreenActive &&
        !propsRef.current.effectivePaused &&
        !simRef.current.cursorShown &&
        propsRef.current.playerHp > 0
      ) {
        dom.focus({ preventScroll: true });
        if (getPointerLockElement() !== dom) {
          safeRequestPointerLock(dom);
        }
      }
    };

    const handleDomFocus = () => {
      setIsWindowFocused(true);
      centerVirtualMouseInViewport(90);
    };

    /**
     * Handles cross-browser pointer lock transitions: recenters the virtual mouse cursor on lock/unlock
     * and treats user Esc pointer-lock exits while actively engaged as a single Pause toggle.
     * Coordinates with `handleKeyDown`'s `260ms` timestamp (`lastEscLockDropMs` / `lastEscKeyMs`)
     * so browsers that fire BOTH `pointerlockchange` and `Escape` `keydown` never double-toggle.
     */
    const handlePointerLockChange = () => {
      const locked = getPointerLockElement() === dom;
      if (locked) {
        wasPointerLocked = true;
        simRef.current.unlockedByCtrl = false;
        centerVirtualMouseInViewport(110);
        return;
      }

      if (wasPointerLocked) {
        wasPointerLocked = false;
        if (propsRef.current.playerHp > 0) {
          centerVirtualMouseInViewport(90);
        }
        const nowMs = performance.now();
        if (nowMs < simRef.current.ignoreLockDropUntilMs) {
          simRef.current.unlockedByCtrl = false;
        } else if (simRef.current.unlockedByCtrl) {
          simRef.current.unlockedByCtrl = false;
        } else if (
          !isDisposed &&
          propsRef.current.playerHp > 0 &&
          !propsRef.current.effectivePaused &&
          nowMs - simRef.current.lastEscKeyMs > 220
        ) {
          // Esc pressed while pointer-locked drops lock cleanly -> trigger Pause once
          simRef.current.lastEscLockDropMs = nowMs;
          propsRef.current.onSetPaused(true);
        }
      }
    };

    /** Ensures fallback relative aiming keeps working cleanly if pointer lock is denied by Safari/Firefox. */
    const handlePointerLockError = () => {
      wasPointerLocked = false;
      simRef.current.unlockedByCtrl = false;
    };

    const handleMouseEnter = () => {
      simRef.current.isMouseInside = true;
      centerVirtualMouseInViewport(80);
    };

    const handleMouseLeave = () => {
      simRef.current.isMouseInside = false;
      simRef.current.hasPrevClientMouse = false;
      simRef.current.edgePanDir = 0;
      simRef.current.edgePanArmed = false;
    };

    /**
     * Mouse Move Handler:
     * - Continuously reconciles `e.ctrlKey` against `cursorShown` (fixing stuck `Ctrl` cursor if
     *   Alt-Tab or window blur swallowed `keyup`, preventing the 3-second delay before guns fire).
     * - Filters `>150px` Chromium pointer-lock/MMB warp spikes and honors `ignoreMouseDeltaUntilMs`.
     * - Uses native `movementX/Y` when pointer-locked, or `prevClientX/Y` delta + viewport-edge
     *   turn fallback when running in environments that deny pointer lock.
     */
    const handleMouseMove = (e: MouseEvent) => {
      const s = simRef.current;
      const p = propsRef.current;

      // Keep Ctrl cursor toggle strictly synced with actual modifier key state
      if (!e.ctrlKey && s.cursorShown) {
        s.cursorShown = false;
        s.unlockedByCtrl = false;
        setCursorShown(false);
        if (p.playerHp > 0) {
          centerVirtualMouseInViewport(90);
          if (p.isScreenActive && !p.effectivePaused) {
            dom.focus({ preventScroll: true });
          }
        }
      } else if (e.ctrlKey && !p.effectivePaused && !s.cursorShown) {
        s.cursorShown = true;
        s.unlockedByCtrl = true;
        s.lmbDown = false;
        s.burstShotsRemaining = 0;
        s.edgePanDir = 0;
        s.edgePanArmed = false;
        setCursorShown(true);
        if (getPointerLockElement() === dom) {
          safeExitPointerLock();
        }
      }

      if (p.effectivePaused || s.cursorShown || p.playerHp <= 0) {
        s.edgePanDir = 0;
        return;
      }

      if (performance.now() < s.ignoreMouseDeltaUntilMs) {
        s.prevClientX = e.clientX;
        s.prevClientY = e.clientY;
        s.hasPrevClientMouse = true;
        s.edgePanDir = 0;
        return;
      }

      if (getPointerLockElement() === dom) {
        // Reject Chromium pointer-lock transition / MMB spikes before clamping
        if (Math.abs(e.movementX) > 150 || Math.abs(e.movementY) > 150) {
          return;
        }
        const dx = THREE.MathUtils.clamp(e.movementX, -100, 100);
        const dy = THREE.MathUtils.clamp(e.movementY, -100, 100);
        s.targetAimYaw -= dx * 0.0022;
        s.targetAimPitch = THREE.MathUtils.clamp(s.targetAimPitch - dy * 0.002, -1.28, 1.28);
        s.edgePanDir = 0;
        s.edgePanArmed = false;
      } else {
        if (!s.hasPrevClientMouse) {
          s.prevClientX = e.clientX;
          s.prevClientY = e.clientY;
          s.hasPrevClientMouse = true;
          s.edgePanDir = 0;
          return;
        }

        const rawDx = e.clientX - s.prevClientX;
        const rawDy = e.clientY - s.prevClientY;
        s.prevClientX = e.clientX;
        s.prevClientY = e.clientY;

        if (Math.abs(rawDx) > 150 || Math.abs(rawDy) > 150) {
          return;
        }
        const dx = THREE.MathUtils.clamp(rawDx, -100, 100);
        const dy = THREE.MathUtils.clamp(rawDy, -100, 100);

        s.targetAimYaw -= dx * 0.0032;
        s.targetAimPitch = THREE.MathUtils.clamp(s.targetAimPitch - dy * 0.0028, -1.28, 1.28);

        // Edge-turn fallback when pointer lock is unavailable: only arm once pointer moves inside
        // the safe interior (|nx| <= 0.72) so starting a wave or releasing Ctrl near an edge never drifts
        const rect = (viewportRef.current ?? dom).getBoundingClientRect();
        const insideVert = e.clientY >= rect.top && e.clientY <= rect.bottom;
        const nx = THREE.MathUtils.clamp(
          ((e.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
          -1.5,
          1.5
        );
        if (s.isMouseInside && insideVert && Math.abs(nx) <= 0.72) {
          s.edgePanArmed = true;
        }
        if (s.edgePanArmed && s.isMouseInside && insideVert && !s.mmbDown) {
          if (nx > 0.94) {
            s.edgePanDir = -Math.min(1.5, (nx - 0.94) / 0.06);
          } else if (nx < -0.94) {
            s.edgePanDir = Math.min(1.5, (-0.94 - nx) / 0.06);
          } else {
            s.edgePanDir = 0;
          }
        } else {
          s.edgePanDir = 0;
        }
      }
    };

    /**
     * Mouse Down Handler:
     * - Reconciles `e.ctrlKey` immediately before shooting so releasing Ctrl never leaves combat muted.
     * - Acquires canvas keyboard focus & Pointer Lock on click.
     * - MMB (`button === 1`): Starts the hold timer (`mmbDownAtMs`) and sets a 45ms mouse-delta
     *   blanking window so browsers entering middle-click autoscroll don't snap the camera downward.
     * - LMB (`button === 0`): Starts firearm semi/burst/full-auto trigger or melee charge windup.
     * - RMB (`button === 2`): Starts consumable hold (when ORD in hand), tactical melee Shove, or ADS toggle.
     */
    const handleMouseDown = (e: MouseEvent) => {
      e.preventDefault();
      const s = simRef.current;
      const p = propsRef.current;

      if (!e.ctrlKey && s.cursorShown) {
        s.cursorShown = false;
        s.unlockedByCtrl = false;
        setCursorShown(false);
        centerVirtualMouseInViewport(85);
      } else if (e.ctrlKey && !p.effectivePaused) {
        if (!s.cursorShown) {
          s.cursorShown = true;
          s.unlockedByCtrl = true;
          s.edgePanDir = 0;
          s.edgePanArmed = false;
          setCursorShown(true);
        }
        return;
      }

      dom.focus({ preventScroll: true });
      setIsWindowFocused(true);
      soundEngine.unlock();

      if (p.effectivePaused || s.cursorShown) return;

      // Center virtual mouse coordinates before requesting pointer lock so focus clicks never drift
      if (p.playerHp > 0 && getPointerLockElement() !== dom) {
        centerVirtualMouseInViewport(85);
        safeRequestPointerLock(dom);
      }

      // Middle Mouse Button (MMB): Hold & release throws/deploys consumable; quick click (<180ms) detonates planted C4
      if (e.button === 1) {
        if (p.playerHp > 0) {
          s.mmbDown = true;
          s.mmbDownAtMs = performance.now();
          s.ignoreMouseDeltaUntilMs = Math.max(s.ignoreMouseDeltaUntilMs, performance.now() + 45);
        }
        return;
      }

      // While Consumable slot is equipped in hand, Right Mouse Button holds then releases to deploy/throw
      if (p.config.activeSlot === 'CONSUMABLE') {
        if (e.button === 2 && p.playerHp > 0) {
          s.rmbConsumableDown = true;
          s.rmbConsumableDownAtMs = performance.now();
        }
        return;
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
        if (p.config.firingMode === 'AUTO_BURST') {
          if (performance.now() >= s.burstPauseUntilMs && s.burstShotsRemaining <= 0) {
            const firedBefore = s.lastFireTimeMs;
            fireWeaponOnce(true, false);
            s.burstShotsRemaining = s.lastFireTimeMs !== firedBefore ? 2 : 0;
          }
        } else {
          fireWeaponOnce(true, p.config.firingMode === 'SEMI_PRECISION');
          if (p.config.firingMode === 'SEMI_PRECISION') {
            s.lmbDown = false;
          }
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

    /**
     * Mouse Up Handler:
     * - MMB release timer: measures `heldMs = performance.now() - s.mmbDownAtMs` while applying a
     *   45ms mouse-delta guard to prevent camera floor snaps. If Sticky C4 is planted and `heldMs < 180ms`,
     *   a quick tap detonates all C4 (`detonateAllStickyC4()`); otherwise a hold (`>= 180ms` with C4
     *   planted or `>= 110ms` otherwise) throws/deploys the selected consumable (`launchPlayerGrenade`).
     * - LMB melee release: computes `chargePct` from `meleeChargeSec` (tap `<0.14s` executes combo step;
     *   hold `>=0.14s` scales damage/speed and triggers Halberd/Hammer Special Sweep).
     *
     * Why an alternative would be worse: polling `mmbDownAtMs` with `setTimeout` would either miss
     * fast C4 clicks or throw unwanted grenades while the player is still deciding/aiming.
     */
    const handleMouseUp = (e: MouseEvent) => {
      const s = simRef.current;
      const p = propsRef.current;

      if (e.button === 1) {
        if (s.mmbDown) {
          const heldMs = performance.now() - s.mmbDownAtMs;
          s.mmbDown = false;
          s.ignoreMouseDeltaUntilMs = Math.max(s.ignoreMouseDeltaUntilMs, performance.now() + 45);
          if (!p.effectivePaused && p.playerHp > 0) {
            if (s.stickyC4s.length > 0 && heldMs < 180) {
              detonateAllStickyC4();
            } else if (heldMs >= (s.stickyC4s.length > 0 ? 180 : 110)) {
              launchPlayerGrenade(p.config.grenadeId);
            } else {
              s.ammoToastTimer = 1.3;
              setAmmoToast('HOLD MMB & RELEASE TO USE');
            }
          }
        }
        return;
      }

      if (e.button === 2 && s.rmbConsumableDown) {
        const heldMs = performance.now() - s.rmbConsumableDownAtMs;
        s.rmbConsumableDown = false;
        if (
          !p.effectivePaused &&
          p.playerHp > 0 &&
          p.config.activeSlot === 'CONSUMABLE' &&
          heldMs >= 110
        ) {
          launchPlayerGrenade(p.config.grenadeId);
        }
        return;
      }

      if (p.config.activeSlot === 'CONSUMABLE') {
        if (e.button === 0) {
          s.lmbDown = false;
          s.shotIndexInBurst = 0;
        }
        return;
      }
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
              const baseSpecialDur = weapon.id === 'maelstrom_hammer' ? 0.42 : 0.46;
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
                chargePct,
                1.0
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
                1,
                step.staggerMultiplier ?? 1.0
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
    const handleAuxClick = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault();
    };
    const handleWindowMmbMouseDown = (e: MouseEvent) => {
      if (e.button === 1 && propsRef.current.isScreenActive && !propsRef.current.effectivePaused) {
        e.preventDefault();
      }
    };

    /**
     * Global Keyboard Dispatcher (attached in `capture: true` phase):
     * - `F11`: Overrides browser default page fullscreen to toggle `viewportRef` fullscreen cleanly.
     * - `Escape`: Debounced against `lastEscLockDropMs` (`260ms`) so closing inventory, pausing,
     *   or resuming never double-flips on the same keystroke as Pointer Lock release.
     * - `Control`: Reveals cursor (`cursorShown = true`) and yields Pointer Lock for UI clicking.
     * - `E`: Priority-checks `findLookedAtDeployableForPickup()` (`<2m`) to reclaim traps/turrets
     *   first; otherwise toggles the draggable quick-swap `ViewportInventoryModal`.
     * - `1`/`2`/`3-9`: Slot & ordnance selection; `Q`: Medkit; `F`: Flashlight; `V`/`R`: ADS/Reload.
     *
     * Why an alternative would be worse: listening in bubble phase misses `F11`/`Escape` consumed by
     * focused child inputs or buttons before reaching `window`.
     */
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F11' || e.code === 'F11') {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) {
          toggleViewportFullscreen();
        }
        return;
      }

      if (!propsRef.current.isScreenActive) return;

      const targetEl = e.target as HTMLElement | null;
      const isTypingInput =
        targetEl &&
        (targetEl.tagName === 'INPUT' ||
          targetEl.tagName === 'TEXTAREA' ||
          targetEl.tagName === 'SELECT');

      if (e.key === 'Escape') {
        if (e.repeat) return;
        e.preventDefault();
        e.stopPropagation();
        const nowMs = performance.now();
        simRef.current.lastEscKeyMs = nowMs;

        if (simRef.current.inventoryOpen) {
          simRef.current.inventoryOpen = false;
          simRef.current.unlockedByCtrl = false;
          simRef.current.lastEscLockDropMs = nowMs;
          setInventoryOpen(false);
          soundEngine.playInventoryToggle(false);
          centerVirtualMouseInViewport(80);
          dom.focus({ preventScroll: true });
          safeRequestPointerLock(dom);
          return;
        }

        // Prevent double-toggle if browser pointerlockchange just flipped pause from this same Esc keystroke
        if (nowMs - simRef.current.lastEscLockDropMs > 260) {
          simRef.current.lastEscLockDropMs = nowMs;
          const nextPaused = !propsRef.current.isPaused;
          propsRef.current.onSetPaused(nextPaused);
          if (!nextPaused) {
            simRef.current.cursorShown = false;
            simRef.current.unlockedByCtrl = false;
            setCursorShown(false);
            centerVirtualMouseInViewport(80);
            dom.focus({ preventScroll: true });
            safeRequestPointerLock(dom);
          }
        }
        return;
      }

      if (e.key === 'Control' || e.code === 'ControlLeft' || e.code === 'ControlRight') {
        if (!e.repeat && !propsRef.current.effectivePaused) {
          const s = simRef.current;
          s.cursorShown = true;
          s.unlockedByCtrl = true;
          s.lmbDown = false;
          s.burstShotsRemaining = 0;
          s.edgePanDir = 0;
          s.edgePanArmed = false;
          setCursorShown(true);
          if (getPointerLockElement() === dom) {
            safeExitPointerLock();
          }
        }
        return;
      }

      if (isTypingInput) return;

      if ((e.key === 'e' || e.key === 'E') && !e.repeat) {
        if (propsRef.current.isPaused) return;
        e.preventDefault();
        const s = simRef.current;
        if (!s.inventoryOpen && !propsRef.current.effectivePaused && propsRef.current.playerHp > 0) {
          const pickup = findLookedAtDeployableForPickup();
          if (pickup && collectDeployableByUid(pickup.kind, pickup.uid)) {
            setPickupPrompt(null);
            return;
          }
        }
        const nextOpen = !s.inventoryOpen;
        s.inventoryOpen = nextOpen;
        setInventoryOpen(nextOpen);
        soundEngine.playInventoryToggle(nextOpen);
        if (nextOpen) {
          s.lmbDown = false;
          s.mmbDown = false;
          s.rmbConsumableDown = false;
          s.shotIndexInBurst = 0;
          s.eKeyOpenedAt = performance.now();
          s.unlockedByCtrl = true;
          if (getPointerLockElement() === dom) {
            safeExitPointerLock();
          }
        } else {
          s.unlockedByCtrl = false;
          centerVirtualMouseInViewport(85);
        }
        return;
      }

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

      if (propsRef.current.effectivePaused) return;

      // If Ctrl keyup could not immediately re-lock pointer due to browser activation rules,
      // re-center and re-lock on the very next active combat keystroke while canvas owns focus
      if (
        !e.repeat &&
        !simRef.current.cursorShown &&
        propsRef.current.playerHp > 0 &&
        document.activeElement === dom &&
        getPointerLockElement() !== dom &&
        /^(Key[WASDQFVR]|Digit[1-9]|Space)$/.test(e.code)
      ) {
        centerVirtualMouseInViewport(85);
        safeRequestPointerLock(dom);
      }

      if (e.key === '1' && !e.repeat) {
        propsRef.current.onSwitchActiveSlot('PRIMARY');
        return;
      }
      if (e.key === '2' && !e.repeat) {
        propsRef.current.onSwitchActiveSlot('SECONDARY');
        return;
      }
      if (/^[3-9]$/.test(e.key) && !e.repeat) {
        const gIdx = Number(e.key) - 3;
        if (GRENADES[gIdx]) {
          propsRef.current.onSelectGrenade(GRENADES[gIdx].id);
        }
        return;
      }

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
      if (propsRef.current.config.activeSlot !== 'CONSUMABLE') {
        if ((e.key === 'v' || e.key === 'V') && weapon.weaponClass !== 'MELEE') {
          simRef.current.isAds = !simRef.current.isAds;
          setIsAds(simRef.current.isAds);
        } else if ((e.key === 'r' || e.key === 'R') && weapon.weaponClass !== 'MELEE') {
          propsRef.current.onManualReload?.();
        }
      }
    };

    /**
     * Cycles Primary -> Secondary -> Consumable slots using normalized wheel deltas
     * so Firefox line-mode (`deltaMode === 1`) matches Chromium/Safari pixel scrolling.
     */
    const handleWheel = (e: WheelEvent) => {
      const p = propsRef.current;
      const deltaY = normalizeWheelDeltaY(e);
      if (p.effectivePaused || Math.abs(deltaY) < 4) return;
      e.preventDefault();
      // Mouse scroll wheel cycles cleanly through Primary -> Secondary -> Consumable
      const order: WeaponSlot[] = ['PRIMARY', 'SECONDARY', 'CONSUMABLE'];
      const curIdx = order.indexOf(p.config.activeSlot);
      const step = deltaY > 0 ? 1 : -1;
      const nextSlot = order[(curIdx + step + order.length) % order.length];
      p.onSwitchActiveSlot(nextSlot);
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      keysDown.delete(e.code);
      const s = simRef.current;
      /**
       * On Ctrl release, hide the revealed cursor. If the player is still alive (`playerHp > 0`),
       * reset the mouse position to the center of the viewport/screen and restore combat focus.
       */
      if (e.key === 'Control' || e.code === 'ControlLeft' || e.code === 'ControlRight') {
        s.cursorShown = false;
        s.unlockedByCtrl = false;
        setCursorShown(false);
        if (propsRef.current.playerHp > 0) {
          centerVirtualMouseInViewport(95);
          if (propsRef.current.isScreenActive && !propsRef.current.effectivePaused) {
            dom.focus({ preventScroll: true });
            safeRequestPointerLock(dom);
          }
        }
        return;
      }
      if ((e.key === 'e' || e.key === 'E') && s.inventoryOpen) {
        if (performance.now() - s.eKeyOpenedAt > 220 && hoveredInventoryItemRef.current) {
          const item = hoveredInventoryItemRef.current;
          if (item.slot === 'CONSUMABLE') {
            propsRef.current.onSelectGrenade(item.id as GrenadeId);
            propsRef.current.onSwitchActiveSlot('CONSUMABLE');
          } else {
            propsRef.current.onSelectSlotWeapon(item.slot, item.id, true);
          }
          s.inventoryOpen = false;
          s.unlockedByCtrl = false;
          setInventoryOpen(false);
          soundEngine.playInventoryToggle(false);
          centerVirtualMouseInViewport(75);
          dom.focus({ preventScroll: true });
        }
      }
    };

    const handleWindowBlur = () => {
      keysDown.clear();
      const s = simRef.current;
      s.lmbDown = false;
      s.mmbDown = false;
      s.rmbConsumableDown = false;
      s.cursorShown = false;
      s.unlockedByCtrl = false;
      centerVirtualMouseInViewport(75);
      setCursorShown(false);
    };

    dom.addEventListener('focus', handleDomFocus);
    dom.addEventListener('mouseenter', handleMouseEnter);
    dom.addEventListener('mouseleave', handleMouseLeave);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mousedown', handleWindowMmbMouseDown, { passive: false });
    dom.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('auxclick', handleAuxClick);
    dom.addEventListener('wheel', handleWheel, { passive: false });
    window.addEventListener('mouseup', handleMouseUp);
    dom.addEventListener('contextmenu', handleContextMenu);
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleWindowBlur);
    for (const evt of POINTER_LOCK_CHANGE_EVENTS) {
      document.addEventListener(evt, handlePointerLockChange);
    }
    for (const evt of POINTER_LOCK_ERROR_EVENTS) {
      document.addEventListener(evt, handlePointerLockError);
    }

    const handleResize = () => {
      if (!container) return;
      const w = Math.max(320, container.clientWidth);
      const h = Math.max(240, container.clientHeight);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
      if (
        propsRef.current.isScreenActive &&
        !propsRef.current.effectivePaused &&
        !simRef.current.cursorShown
      ) {
        centerVirtualMouseInViewport(90);
      }
    };
    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(container);

    // Pre-build initial wave & compile WebGL shaders during mount so Wave 1 fires immediately on Start
    rebuildSquad();
    if (!isSoftwareGl) {
      renderer.compile(scene, camera);
    }

    let frameId = 0;
    let hudSyncAcc = 0;
    let fpsFrames = 0;
    let fpsAcc = 0;

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

      const isConsumableHeld = p.config.activeSlot === 'CONSUMABLE';
      const viewKey = isConsumableHeld
        ? `CONSUMABLE:${p.config.grenadeId}`
        : `WEAPON:${p.config.weaponId}`;

      if (s.weaponIdBuilt !== viewKey) {
        weaponAnchor.remove(currentWeapon3D.root);
        disposeObject3D(currentWeapon3D.root);
        currentWeapon3D = isConsumableHeld
          ? buildConsumableViewmodel3D(p.config.grenadeId)
          : buildWeaponViewmodel3D(p.config.weaponId);
        weaponAnchor.add(currentWeapon3D.root);
        s.weaponIdBuilt = viewKey;
        s.recoilHeat = 0;
        s.firingSwayBlend = 0;
        s.recoilYaw = 0;
        s.recoilPitch = 0;
        s.isAds = false;
        s.meleeAction = 'IDLE';
        s.meleeChargeSec = 0;
        s.meleeComboIdx = 0;
        s.halberdSpecialChainTimer = 0;
        s.reloadAnimActive = false;
        s.reloadAnimElapsed = 0;
        s.wasReloading = false;
        s.shotBoltKick = 0;
        setIsAds(false);
      }

      const activeWeapon = getWeaponById(p.config.weaponId, p.weapons);
      const isMeleeWeapon =
        !isConsumableHeld && activeWeapon.weaponClass === 'MELEE' && !!activeWeapon.melee;

      // Smoothly transition skybox, dark storm clouds, rain, lightning, and indoor corridor lights
      let diffSkyH = s.skyHourTarget - s.skyHourCurrent;
      if (diffSkyH > 12) diffSkyH -= 24;
      if (diffSkyH < -12) diffSkyH += 24;
      s.skyHourCurrent =
        (((s.skyHourCurrent + diffSkyH * Math.min(1, delta * 2.8)) % 24) + 24) % 24;

      s.weatherRainCurrent = THREE.MathUtils.damp(
        s.weatherRainCurrent,
        s.weatherRainTarget,
        1.8,
        delta
      );
      s.weatherCloudCoverCurrent = THREE.MathUtils.damp(
        s.weatherCloudCoverCurrent,
        s.weatherCloudCoverTarget,
        1.5,
        delta
      );
      s.weatherCloudDarknessCurrent = THREE.MathUtils.damp(
        s.weatherCloudDarknessCurrent,
        s.weatherCloudDarknessTarget,
        1.5,
        delta
      );

      // Lightning & Thunder scheduler (also supports manual debug strike / forced storm testing)
      const lightningActive =
        s.lightningStrikeNowPending ||
        (s.weatherHasLightning && (s.weatherRainCurrent > 0.45 || s.lightningForcedOn));
      if (lightningActive) {
        s.lightningNextTimer -= delta;
        if (s.lightningStrikeNowPending || s.lightningNextTimer <= 0) {
          s.lightningStrikeNowPending = false;
          s.lightningFlash = 1.35;
          s.lightningSubPulseTimer = 0.14;
          s.lightningBoltTimer = 0.28;
          s.lightningNextTimer =
            s.weatherRainCurrent >= 0.85 || s.lightningForcedOn
              ? 4.2 + Math.random() * 5.8
              : 9.0 + Math.random() * 9.0;
          s.pendingThunderTimer = 0.3 + (1 - Math.max(0.35, s.weatherRainCurrent)) * 0.5;
          s.pendingThunderStrength = 0.72 + Math.max(0.4, s.weatherRainCurrent) * 0.48;

          // Build overhead jagged 3D lightning bolt visible through skylight roof
          let bx = s.playerX + (Math.random() - 0.5) * 44;
          let by = 52;
          let bz = s.playerZ - 14 - Math.random() * 58;
          for (let bi = 0; bi < BOLT_POINTS; bi++) {
            boltPos[bi * 3] = bx;
            boltPos[bi * 3 + 1] = by;
            boltPos[bi * 3 + 2] = bz;
            bx += (Math.random() - 0.5) * 4.5;
            by -= 4.2;
            bz += (Math.random() - 0.5) * 3.5;
          }
          boltGeo.attributes.position.needsUpdate = true;
          boltLine.visible = true;
          lightningLight.position.set(bx, 28, bz);
        }
      }

      if (s.lightningSubPulseTimer > 0) {
        s.lightningSubPulseTimer -= delta;
        if (s.lightningSubPulseTimer <= 0) {
          s.lightningFlash = Math.max(s.lightningFlash, 0.92);
        }
      }
      if (s.lightningBoltTimer > 0) {
        s.lightningBoltTimer -= delta;
        boltMat.opacity = Math.max(0, (s.lightningBoltTimer / 0.24) * 0.95);
        if (s.lightningBoltTimer <= 0) {
          boltLine.visible = false;
        }
      }
      s.lightningFlash = THREE.MathUtils.damp(s.lightningFlash, 0, 9.5, delta);

      if (s.pendingThunderTimer !== null) {
        s.pendingThunderTimer -= delta;
        if (s.pendingThunderTimer <= 0) {
          s.pendingThunderTimer = null;
          if (!p.effectivePaused) {
            soundEngine.playThunder(s.pendingThunderStrength);
          }
        }
      }

      const envTimeProfile = computeEnvironmentTimeProfile(s.skyHourCurrent, {
        cloudCover: s.weatherCloudCoverCurrent,
        cloudDarkness: s.weatherCloudDarknessCurrent,
        rainIntensity: s.weatherRainCurrent,
      });

      soundEngine.updateAmbientWeather({
        rainIntensity: s.weatherRainCurrent,
        isNight: envTimeProfile.phase === 'NIGHT',
        paused: p.effectivePaused,
      });

      skyDome.position.copy(camera.position);
      skyDomeMat.uniforms.uZenithColor.value.copy(envTimeProfile.skyZenith);
      skyDomeMat.uniforms.uHorizonColor.value.copy(envTimeProfile.skyHorizon);
      skyDomeMat.uniforms.uGlowColor.value.copy(envTimeProfile.skyGlow);
      skyDomeMat.uniforms.uSunDir.value.copy(envTimeProfile.sunDirection);
      skyDomeMat.uniforms.uSunStrength.value = envTimeProfile.sunStrength;
      skyDomeMat.uniforms.uMoonStrength.value = envTimeProfile.moonStrength;
      skyDomeMat.uniforms.uStarVisibility.value = envTimeProfile.starVisibility;
      skyDomeMat.uniforms.uSunsetStrength.value = envTimeProfile.sunsetStrength;
      skyDomeMat.uniforms.uCloudCover.value = envTimeProfile.cloudCover;
      skyDomeMat.uniforms.uCloudDarkness.value = envTimeProfile.cloudDarkness;
      skyDomeMat.uniforms.uLightningFlash.value = s.lightningFlash;
      skyDomeMat.uniforms.uTime.value = elapsed;

      (scene.background as THREE.Color).copy(envTimeProfile.fogColor);
      sceneFog.color.copy(envTimeProfile.fogColor);
      sceneFog.density = envTimeProfile.fogDensity;
      scene.environmentIntensity =
        0.34 + 0.72 * envTimeProfile.sunStrength + 0.18 * envTimeProfile.sunsetStrength;

      hemi.color.copy(envTimeProfile.hemiSky);
      hemi.groundColor.copy(envTimeProfile.hemiGround);
      hemi.intensity = envTimeProfile.hemiIntensity + s.lightningFlash * 0.65;

      keyLight.color.copy(envTimeProfile.keyColor);
      keyLight.intensity = envTimeProfile.keyIntensity;
      keyLight.position.set(
        envTimeProfile.sunDirection.x * 26,
        Math.max(8, envTimeProfile.sunDirection.y * 28),
        envTimeProfile.sunDirection.z * 26 - 12
      );

      rimLight.color.copy(envTimeProfile.rimColor);
      rimLight.intensity = envTimeProfile.rimIntensity;
      lightningLight.intensity = s.lightningFlash * 3.6;
      renderer.toneMappingExposure = envTimeProfile.exposure;

      updateRoomLights(
        currentRoom.dynamicLights,
        delta,
        envTimeProfile.roomLightScale,
        envTimeProfile.lightsOn
      );

      // Animate 3D rain streaks & glass skylight roof splash ripples
      if (s.weatherRainCurrent > 0.02) {
        const activeDrops = Math.max(
          160,
          Math.floor(MAX_RAIN_DROPS * THREE.MathUtils.clamp(s.weatherRainCurrent, 0.15, 1.0))
        );
        const fallSpeedBase = 16 + s.weatherRainCurrent * 16;
        const windX = -1.8 - s.weatherRainCurrent * 2.6;
        const windZ = 1.2 + s.weatherRainCurrent * 2.0;
        const streakScale = 0.032 + s.weatherRainCurrent * 0.026;
        const isCorridor = p.config.roomId === 'corridor_01';

        for (let i = 0; i < activeDrops; i++) {
          const vy = fallSpeedBase * rainSpeed[i];
          rainX[i] += windX * delta;
          rainY[i] -= vy * delta;
          rainZ[i] += windZ * delta;

          const worldX = s.playerX + rainX[i];
          const minRoofY = isCorridor && Math.abs(worldX) < 12.6 ? 5.34 : 0.25;
          if (rainY[i] < minRoofY || Math.abs(rainX[i]) > 30 || Math.abs(rainZ[i]) > 44) {
            rainX[i] = (Math.random() - 0.5) * 58;
            rainY[i] = 20 + Math.random() * 8;
            rainZ[i] = (Math.random() - 0.5) * 86;
          }

          const rx = s.playerX + rainX[i];
          const ry = rainY[i];
          const rz = s.playerZ + rainZ[i];
          const idx6 = i * 6;
          rainPos[idx6] = rx;
          rainPos[idx6 + 1] = ry;
          rainPos[idx6 + 2] = rz;
          rainPos[idx6 + 3] = rx - windX * streakScale;
          rainPos[idx6 + 4] = ry + vy * streakScale;
          rainPos[idx6 + 5] = rz - windZ * streakScale;
        }
        rainGeo.setDrawRange(0, activeDrops * 2);
        rainGeo.attributes.position.needsUpdate = true;
        rainMat.opacity = 0.2 + s.weatherRainCurrent * 0.38 + s.lightningFlash * 0.18;
        rainMat.color.setHex(envTimeProfile.phase === 'NIGHT' ? 0x8db8eb : 0xc6e4fb);
        rainLines.visible = true;

        if (isCorridor) {
          splashMesh.visible = true;
          splashMat.opacity = 0.16 + s.weatherRainCurrent * 0.28;
          for (let i = 0; i < SPLASH_COUNT; i++) {
            const sp = splashData[i];
            sp.phase += delta * (1.8 + s.weatherRainCurrent * 1.9);
            if (sp.phase >= 1) {
              sp.phase = 0;
              sp.x = (Math.random() - 0.5) * 22;
              sp.z = THREE.MathUtils.clamp(
                s.playerZ + (Math.random() - 0.5) * 68,
                -117,
                1.5
              );
            }
            const sc = 0.4 + sp.phase * (1.2 + s.weatherRainCurrent * 0.9);
            splashDummy.position.set(sp.x, 5.29, sp.z);
            splashDummy.scale.set(sc, sc, sc);
            splashDummy.updateMatrix();
            splashMesh.setMatrixAt(i, splashDummy.matrix);
          }
          splashMesh.instanceMatrix.needsUpdate = true;
        } else {
          splashMesh.visible = false;
        }
      } else {
        rainLines.visible = false;
        splashMesh.visible = false;
      }

      if (!p.effectivePaused) {
        // Trigger pending UI-clicked grenade throw inside render context
        if (s.pendingGrenadeThrow) {
          const gId = s.pendingGrenadeThrow;
          s.pendingGrenadeThrow = null;
          launchPlayerGrenade(gId);
        }

        // Advance chained deployable explosions caught inside blasts
        for (let i = s.pendingChainDetonations.length - 1; i >= 0; i--) {
          const cd = s.pendingChainDetonations[i];
          cd.delaySec -= delta;
          if (cd.delaySec <= 0) {
            s.pendingChainDetonations.splice(i, 1);
            if (cd.kind === 'laser_trip_mine' && cd.laserClone) {
              detonateLaserTripMine(cd.laserClone);
            } else {
              detonateGrenadeAt(getGrenadeById(cd.kind, p.grenades), cd.pos.x, cd.pos.y, cd.pos.z);
            }
          }
        }

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

        // Staggered Queue Spawner (4s in Corridor, 6s in Double Flank + difficulty group offsets)
        for (let i = s.pendingSpawns.length - 1; i >= 0; i--) {
          const item = s.pendingSpawns[i];
          item.delayRemainingSec -= delta;
          if (item.delayRemainingSec <= 0) {
            spawnEnemyActor(
              item.profile,
              item.groupLabel,
              item.uid,
              item.encounterId,
              item.hp,
              item.spawnX,
              item.spawnZ,
              item.doorSide,
              item.waypoints
            );
            s.pendingSpawns.splice(i, 1);
          }
        }

        // Automatic 12s inter-wave countdown -> starts next wave immediately
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
        if (s.playerBurnTickCooldown > 0) {
          s.playerBurnTickCooldown = Math.max(0, s.playerBurnTickCooldown - delta);
        }
        if (s.playerBurnSlowTimer > 0) {
          s.playerBurnSlowTimer = Math.max(0, s.playerBurnSlowTimer - delta);
        }
        if (s.stunFlashTimer > 0) {
          s.stunFlashTimer = Math.max(0, s.stunFlashTimer - delta);
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
        const burnMobilityMult = s.playerBurnSlowTimer > 0 ? 1.2 : 1.0;

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
          const prevPx = s.playerX;
          const prevPz = s.playerZ;

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
            // Sprint speed reduced by 14% (12.75 * 0.86 = 10.965 m/s); Incendiary blast zone boosts mobility +20%
            const baseSpeed = isSprinting ? 10.965 : 6.4 * (s.isAds ? 0.72 : 1.0);
            const speed = baseSpeed * crowdSpeedMult * burnMobilityMult;

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
                northDoorBroken: currentRoom.northDoor?.broken ?? true,
                covers: currentRoom.covers,
              }
            );
            s.playerX = resolved.x;
            s.playerZ = resolved.z;
            s.walkBobPhase += delta * (isSprinting ? 13.1 : 10.5 * Math.max(0.6, crowdSpeedMult));
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
                    northDoorBroken: currentRoom.northDoor?.broken ?? true,
                    covers: currentRoom.covers,
                  }
                );
                s.playerX = pushed.x;
                s.playerZ = pushed.z;
              }
            }
          }

          // Track smoothed player movement velocity & run-anticipation window for interceptor AI
          const dtSafe = Math.max(0.001, delta);
          const instVx = (s.playerX - prevPx) / dtSafe;
          const instVz = (s.playerZ - prevPz) / dtSafe;
          s.playerVelX = THREE.MathUtils.damp(s.playerVelX, instVx, 9, delta);
          s.playerVelZ = THREE.MathUtils.damp(s.playerVelZ, instVz, 9, delta);
          s.playerSpeed = Math.hypot(s.playerVelX, s.playerVelZ);
          if (isSprinting || (isMoving && s.playerSpeed > 4.8)) {
            s.playerRunAnticipationTimer = 1.45;
          } else {
            s.playerRunAnticipationTimer = Math.max(0, s.playerRunAnticipationTimer - delta);
          }

          if (!s.cursorShown && s.edgePanDir !== 0 && getPointerLockElement() !== dom) {
            s.targetAimYaw += s.edgePanDir * 1.45 * delta;
          }
        } else {
          s.playerVelX = 0;
          s.playerVelZ = 0;
          s.playerSpeed = 0;
          s.playerRunAnticipationTimer = 0;
        }

        // Track player death collapse animation & release input/pointer lock when downed
        if (p.playerHp <= 0) {
          if (!s.wasDead) {
            s.wasDead = true;
            s.deathRollSign = Math.random() < 0.5 ? 1 : -1;
            s.lmbDown = false;
            s.mmbDown = false;
            s.rmbConsumableDown = false;
            s.burstShotsRemaining = 0;
            s.isAds = false;
            s.cursorShown = false;
            s.unlockedByCtrl = false;
            setIsAds(false);
            setCursorShown(false);
            if (getPointerLockElement() === dom) {
              safeExitPointerLock();
            }
          }
          s.deathFallProgress = Math.min(1, s.deathFallProgress + delta * 2.2);
        } else if (s.wasDead) {
          s.wasDead = false;
          s.deathFallProgress = 0;
          weaponAnchor.visible = true;
        }

        const fallEase = 1 - Math.pow(1 - s.deathFallProgress, 3);
        const bobYCam = isMoving
          ? Math.sin(s.walkBobPhase) * (isSprinting ? 0.048 : 0.032)
          : 0;
        const camHeightY =
          p.playerHp <= 0
            ? THREE.MathUtils.lerp(1.65, 0.28, fallEase) + Math.sin(fallEase * Math.PI) * 0.05
            : 1.65 + bobYCam;
        camera.position.set(s.playerX, camHeightY, s.playerZ);

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

        if (!isConsumableHeld && !isMeleeWeapon) {
          if (p.config.firingMode === 'AUTO_BURST') {
            if (s.burstShotsRemaining > 0) {
              const prevFireMs = s.lastFireTimeMs;
              fireWeaponOnce(true);
              if (s.lastFireTimeMs !== prevFireMs) {
                s.burstShotsRemaining -= 1;
                if (s.burstShotsRemaining <= 0) {
                  s.burstPauseUntilMs = performance.now() + 165;
                }
              }
            } else if (s.lmbDown && performance.now() >= s.burstPauseUntilMs) {
              const prevFireMs = s.lastFireTimeMs;
              fireWeaponOnce(true);
              if (s.lastFireTimeMs !== prevFireMs) {
                s.burstShotsRemaining = 2;
              }
            }
          } else if (s.lmbDown && p.config.firingMode !== 'SEMI_PRECISION') {
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
        } else if (!isConsumableHeld && isMeleeWeapon && p.isSimRunning && nearestAlive && p.playerHp > 0) {
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
          !isConsumableHeld &&
          !isMeleeWeapon &&
          ((p.config.firingMode === 'AUTO_BURST' &&
            (s.burstShotsRemaining > 0 || s.lmbDown)) ||
            (s.lmbDown && p.config.firingMode === 'FULL_AUTO') ||
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

        const deathPitchOffset = p.playerHp <= 0 ? -0.26 * fallEase : 0;
        const deathRollOffset = p.playerHp <= 0 ? s.deathRollSign * 0.44 * fallEase : 0;

        camera.rotation.order = 'YXZ';
        camera.rotation.y = s.aimYaw + s.recoilYaw + swayYaw + shakeX + s.cameraMeleeYaw;
        camera.rotation.x = THREE.MathUtils.clamp(
          s.aimPitch + s.recoilPitch + swayPitch + shakeY + s.cameraMeleePitch + deathPitchOffset,
          -1.35,
          1.28
        );
        camera.rotation.z = s.cameraMeleeRoll + deathRollOffset;

        const baseTargetFov =
          !isConsumableHeld && !isMeleeWeapon && s.isAds && !p.isReloading
            ? activeWeapon.adsFov
            : 62;
        const targetFov =
          baseTargetFov + (isSprinting ? 4 : 0) + (isMeleeWeapon ? s.cameraMeleeFovOffset : 0);
        if (Math.abs(camera.fov - targetFov) > 0.05) {
          camera.fov = THREE.MathUtils.damp(camera.fov, targetFov, 14, delta);
          camera.updateProjectionMatrix();
        }

        // Viewmodel Animation (Consumable Held vs Melee vs Firearm + Ranged Reload Sequence)
        const baseRig =
          !isConsumableHeld && s.isAds && !isMeleeWeapon && !p.isReloading
            ? currentWeapon3D.opticOffset
            : currentWeapon3D.hipOffset;
        s.weaponKickZ = THREE.MathUtils.damp(s.weaponKickZ, 0, 16, delta);
        s.weaponKickPitch = THREE.MathUtils.damp(s.weaponKickPitch, 0, 16, delta);
        s.shotBoltKick = THREE.MathUtils.damp(s.shotBoltKick, 0, 26, delta);

        if (isConsumableHeld) {
          // Gentle breathing & movement sway for held grenade / mine / C4 / turret preview
          s.reloadAnimActive = false;
          s.wasReloading = false;
          const readyBobX = Math.sin(s.swayPhase * 1.1) * 0.008;
          const readyBobY = Math.cos(s.swayPhase * 2.2) * 0.006;
          weaponAnchor.rotation.order = 'XYZ';
          weaponAnchor.position.x = THREE.MathUtils.damp(
            weaponAnchor.position.x,
            baseRig.x + readyBobX,
            18,
            delta
          );
          weaponAnchor.position.y = THREE.MathUtils.damp(
            weaponAnchor.position.y,
            baseRig.y + readyBobY,
            18,
            delta
          );
          weaponAnchor.position.z = THREE.MathUtils.damp(
            weaponAnchor.position.z,
            baseRig.z,
            18,
            delta
          );
          weaponAnchor.rotation.set(
            Math.sin(s.swayPhase * 1.1) * 0.03,
            Math.cos(s.swayPhase * 0.9) * 0.03,
            Math.sin(s.swayPhase * 1.1) * 0.025
          );
        } else if (isMeleeWeapon && activeWeapon.melee) {
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
                if (t < 0.2) {
                  const k = easeOutCubic(t / 0.2);
                  offX = THREE.MathUtils.lerp(0, 0.38, k);
                  offY = THREE.MathUtils.lerp(0, 0.42, k);
                  offZ = THREE.MathUtils.lerp(0, 0.14, k);
                  rotX = THREE.MathUtils.lerp(0, 0.56, k);
                  rotY = THREE.MathUtils.lerp(0, -0.32, k);
                  rotZ = THREE.MathUtils.lerp(0, -0.78, k);
                  bladeRoll = THREE.MathUtils.lerp(0, 0.42, k);
                  s.cameraMeleePitch = 0.036 * k;
                  s.cameraMeleeRoll = -0.028 * k;
                } else if (t < 0.54) {
                  const k = easeInCubic((t - 0.2) / 0.34);
                  offX = THREE.MathUtils.lerp(0.38, -0.24, k);
                  offY = THREE.MathUtils.lerp(0.42, -0.4, k);
                  offZ = THREE.MathUtils.lerp(0.14, -0.38 + recoil, k);
                  rotX = THREE.MathUtils.lerp(0.56, -1.78 + recoil * 3, k);
                  rotY = THREE.MathUtils.lerp(-0.32, 0.34, k);
                  rotZ = THREE.MathUtils.lerp(-0.78, 0.44, k);
                  bladeRoll = 0.42;
                  s.cameraMeleePitch = THREE.MathUtils.lerp(0.036, -0.048, k);
                  s.cameraMeleeRoll = THREE.MathUtils.lerp(-0.028, 0.032, k);
                } else {
                  const k = easeInOutQuad((t - 0.54) / 0.46);
                  offX = THREE.MathUtils.lerp(-0.24, 0, k);
                  offY = THREE.MathUtils.lerp(-0.4, 0, k);
                  offZ = THREE.MathUtils.lerp(-0.38 + recoil, 0, k);
                  rotX = THREE.MathUtils.lerp(-1.78 + recoil * 3, 0, k);
                  rotY = THREE.MathUtils.lerp(0.34, 0, k);
                  rotZ = THREE.MathUtils.lerp(0.44, 0, k);
                  bladeRoll = THREE.MathUtils.lerp(0.42, 0, k);
                }
                break;
              }
              case 'HAMMER_TL_TO_B': {
                if (t < 0.2) {
                  const k = easeOutCubic(t / 0.2);
                  offX = THREE.MathUtils.lerp(0, -0.5, k);
                  offY = THREE.MathUtils.lerp(0, 0.42, k);
                  offZ = THREE.MathUtils.lerp(0, 0.14, k);
                  rotX = THREE.MathUtils.lerp(0, 0.56, k);
                  rotY = THREE.MathUtils.lerp(0, 0.34, k);
                  rotZ = THREE.MathUtils.lerp(0, 0.86, k);
                  bladeRoll = THREE.MathUtils.lerp(0, -0.42, k);
                  s.cameraMeleePitch = 0.036 * k;
                  s.cameraMeleeRoll = 0.03 * k;
                } else if (t < 0.54) {
                  const k = easeInCubic((t - 0.2) / 0.34);
                  offX = THREE.MathUtils.lerp(-0.5, 0.14, k);
                  offY = THREE.MathUtils.lerp(0.42, -0.4, k);
                  offZ = THREE.MathUtils.lerp(0.14, -0.38 + recoil, k);
                  rotX = THREE.MathUtils.lerp(0.56, -1.78 + recoil * 3, k);
                  rotY = THREE.MathUtils.lerp(0.34, -0.32, k);
                  rotZ = THREE.MathUtils.lerp(0.86, -0.36, k);
                  bladeRoll = -0.42;
                  s.cameraMeleePitch = THREE.MathUtils.lerp(0.036, -0.048, k);
                  s.cameraMeleeRoll = THREE.MathUtils.lerp(0.03, -0.032, k);
                } else {
                  const k = easeInOutQuad((t - 0.54) / 0.46);
                  offX = THREE.MathUtils.lerp(0.14, 0, k);
                  offY = THREE.MathUtils.lerp(-0.4, 0, k);
                  offZ = THREE.MathUtils.lerp(-0.38 + recoil, 0, k);
                  rotX = THREE.MathUtils.lerp(-1.78 + recoil * 3, 0, k);
                  rotY = THREE.MathUtils.lerp(-0.32, 0, k);
                  rotZ = THREE.MathUtils.lerp(-0.36, 0, k);
                  bladeRoll = THREE.MathUtils.lerp(-0.42, 0, k);
                }
                break;
              }
              case 'HAMMER_R_TO_L': {
                if (t < 0.2) {
                  const k = easeOutCubic(t / 0.2);
                  offX = THREE.MathUtils.lerp(0, 0.54, k);
                  offY = THREE.MathUtils.lerp(0, 0.2, k);
                  offZ = THREE.MathUtils.lerp(0, 0.16, k);
                  rotX = THREE.MathUtils.lerp(0, -0.52, k);
                  rotY = THREE.MathUtils.lerp(0, -0.92, k);
                  rotZ = THREE.MathUtils.lerp(0, -1.32, k);
                  bladeRoll = THREE.MathUtils.lerp(0, Math.PI * 0.48, k);
                  s.cameraMeleeYaw = -0.034 * k;
                  s.cameraMeleeRoll = -0.032 * k;
                } else if (t < 0.56) {
                  const k = easeInOutQuad((t - 0.2) / 0.36);
                  offX = THREE.MathUtils.lerp(0.54, -0.72, k);
                  offY = THREE.MathUtils.lerp(0.2, -0.08, k);
                  offZ = -0.34 * Math.sin(k * Math.PI) + recoil;
                  rotX = THREE.MathUtils.lerp(-0.52, -1.38, Math.min(1, k * 1.45));
                  rotY = THREE.MathUtils.lerp(-0.92, 1.32, k);
                  rotZ = THREE.MathUtils.lerp(-1.32, 1.08, k);
                  bladeRoll = Math.PI * 0.48;
                  s.cameraMeleeYaw = THREE.MathUtils.lerp(-0.034, 0.052, k);
                  s.cameraMeleeRoll = THREE.MathUtils.lerp(-0.032, 0.042, k);
                } else {
                  const k = easeInOutQuad((t - 0.56) / 0.44);
                  offX = THREE.MathUtils.lerp(-0.72, 0, k);
                  offY = THREE.MathUtils.lerp(-0.08, 0, k);
                  offZ = THREE.MathUtils.lerp(recoil, 0, k);
                  rotX = THREE.MathUtils.lerp(-1.38, 0, k);
                  rotY = THREE.MathUtils.lerp(1.32, 0, k);
                  rotZ = THREE.MathUtils.lerp(1.08, 0, k);
                  bladeRoll = THREE.MathUtils.lerp(Math.PI * 0.48, 0, k);
                }
                break;
              }
              case 'HAMMER_SPECIAL': {
                const chargeAmp = 0.78 + 0.22 * s.meleeStrikeChargePct;
                if (t < 0.38) {
                  const k = easeInCubic(t / 0.38);
                  offX = -0.08 * chargeAmp;
                  offY = THREE.MathUtils.lerp(0.38 * chargeAmp, -0.5 * chargeAmp, k);
                  offZ = THREE.MathUtils.lerp(0.14 * chargeAmp, -0.44 * chargeAmp + recoil, k);
                  rotX = THREE.MathUtils.lerp(0.66 * chargeAmp, -1.92, k);
                  rotZ = THREE.MathUtils.lerp(0.2 * chargeAmp, 0, k);
                  s.cameraMeleePitch = THREE.MathUtils.lerp(0.038, -0.068 * chargeAmp, k);
                  s.cameraMeleeFovOffset = THREE.MathUtils.lerp(-3.6, 2.8 * chargeAmp, k);
                } else {
                  const k = easeInOutQuad((t - 0.38) / 0.62);
                  offX = THREE.MathUtils.lerp(-0.08 * chargeAmp, 0, k);
                  offY = THREE.MathUtils.lerp(-0.5 * chargeAmp, 0, k);
                  offZ = THREE.MathUtils.lerp(-0.44 * chargeAmp + recoil, 0, k);
                  rotX = THREE.MathUtils.lerp(-1.92, 0, k);
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
          /**
           * Firearm Reload Kinematics Sync:
           * Mirrors `App.tsx`'s authoritative `isReloading` timer (`getEffectiveReloadDurationMs`)
           * onto the 3D viewmodel hierarchy (`weaponAnchor`, `magGroup`, `boltGroup`, `topCoverGroup`,
           * `pumpGroup`, `shellMesh`).
           * - Shell-by-shell weapons (`Tempest Breacher`) wrap normalized progress `u` continuously
           *   every shell duration and reset immediately if interrupted by a left-click shot.
           * - Single-magazine weapons advance monotonically `0 -> 1` through tilt, drop, insert, and rack.
           *
           * Why an alternative would be worse: driving weapon reload duration separately inside Three.js
           * from `App.tsx`'s mag refill timer would drift on frame drops, causing ammo to refill before
           * or after the magazine snaps back into the receiver.
           */
          if (p.isReloading && !s.wasReloading) {
            s.reloadAnimDuration = Math.max(0.4, getEffectiveReloadDurationMs(activeWeapon) / 1000);
            s.reloadAnimElapsed = 0;
            s.reloadAnimActive = true;
          } else if (!p.isReloading && s.wasReloading) {
            s.reloadAnimActive = false;
            s.reloadAnimElapsed = 0;
          }
          s.wasReloading = p.isReloading;

          weaponAnchor.rotation.order = 'XYZ';
          const bobAmp = (s.isAds && !s.reloadAnimActive ? 0.0015 : 0.0072) * activeHeatSway;
          const bobX = Math.sin(s.swayPhase) * bobAmp;
          const bobY = Math.cos(s.swayPhase * 2.0) * bobAmp * 0.6;

          const easeOut = (x: number) => 1 - Math.pow(1 - x, 3);
          const easeInOut = (x: number) =>
            x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;

          let relOffX = 0;
          let relOffY = 0;
          let relOffZ = 0;
          let relRotX = 0;
          let relRotY = 0;
          let relRotZ = 0;
          let magOffX = 0;
          let magOffY = 0;
          let magOffZ = 0;
          let boltPullZ = s.shotBoltKick;
          let topCoverRotX = 0;
          let pumpOffZ = 0;
          let showShell = false;
          let shellOffY = -0.14;
          let shellOffZ = -0.02;

          if (s.reloadAnimActive) {
            if (activeWeapon.shellByShellReload) {
              // Loop cleanly once per single-shell 1.8s insert cycle until full or interrupted by firing
              s.reloadAnimElapsed =
                (s.reloadAnimElapsed + delta) % Math.max(0.2, s.reloadAnimDuration);
            } else {
              s.reloadAnimElapsed = Math.min(s.reloadAnimDuration, s.reloadAnimElapsed + delta);
            }
            const u = THREE.MathUtils.clamp(
              s.reloadAnimElapsed / Math.max(0.1, s.reloadAnimDuration),
              0,
              1
            );
            const cls = activeWeapon.category;

            if (cls === 'PISTOL') {
              // Tilt sidearm inboard, drop mag, slap fresh mag home, rack upper slide
              const tiltEnv =
                u < 0.14
                  ? easeOut(u / 0.14)
                  : u > 0.88
                    ? 1 - easeInOut((u - 0.88) / 0.12)
                    : 1;
              relOffX = -0.045 * tiltEnv;
              relOffY = -0.035 * tiltEnv;
              relOffZ = 0.03 * tiltEnv;
              relRotX = 0.34 * tiltEnv;
              relRotY = 0.42 * tiltEnv;
              relRotZ = 0.48 * tiltEnv;

              if (u >= 0.14 && u < 0.42) {
                const k = easeOut((u - 0.14) / 0.28);
                magOffY = -0.22 * k;
                magOffZ = 0.06 * k;
              } else if (u >= 0.42 && u < 0.68) {
                const k = easeInOut((u - 0.42) / 0.26);
                magOffY = THREE.MathUtils.lerp(-0.22, 0, k);
                magOffZ = THREE.MathUtils.lerp(0.06, 0, k);
                if (k > 0.88) relOffY += 0.018 * Math.sin(((k - 0.88) / 0.12) * Math.PI);
              } else if (u >= 0.72 && u < 0.92) {
                const k = (u - 0.72) / 0.2;
                const rack = k < 0.55 ? easeOut(k / 0.55) : 1 - easeOut((k - 0.55) / 0.45);
                boltPullZ = Math.max(boltPullZ, 0.052 * rack);
                relOffZ += 0.024 * rack;
              }
            } else if (cls === 'SHOTGUN') {
              // Cant shotgun sideways & load individual shells sequentially into the underbelly tube
              const tiltEnv =
                u < 0.12
                  ? easeOut(u / 0.12)
                  : u > 0.9
                    ? 1 - easeInOut((u - 0.9) / 0.1)
                    : 1;
              relOffX = -0.065 * tiltEnv;
              relOffY = -0.03 * tiltEnv;
              relOffZ = 0.04 * tiltEnv;
              relRotX = 0.32 * tiltEnv;
              relRotY = 0.34 * tiltEnv;
              relRotZ = 0.62 * tiltEnv;

              if (activeWeapon.shellByShellReload) {
                if (u >= 0.1 && u < 0.78) {
                  showShell = true;
                  const sub = (u - 0.1) / 0.68;
                  const push = sub < 0.65 ? easeOut(sub / 0.65) : 1 - easeOut((sub - 0.65) / 0.35);
                  shellOffY = THREE.MathUtils.lerp(-0.15, -0.025, push);
                  shellOffZ = THREE.MathUtils.lerp(0.04, -0.02, push);
                  relOffY += 0.015 * push;
                } else if (u >= 0.78 && u < 0.95) {
                  const k = (u - 0.78) / 0.17;
                  const pump = k < 0.5 ? easeOut(k / 0.5) : 1 - easeOut((k - 0.5) / 0.5);
                  pumpOffZ = 0.075 * pump;
                  boltPullZ = Math.max(boltPullZ, 0.05 * pump);
                  relOffZ += 0.022 * pump;
                }
              } else {
                if (u >= 0.15 && u < 0.72) {
                  showShell = true;
                  const cycle = ((u - 0.15) / 0.57) * 3;
                  const sub = cycle - Math.floor(cycle);
                  const push = sub < 0.65 ? easeOut(sub / 0.65) : 1 - easeOut((sub - 0.65) / 0.35);
                  shellOffY = THREE.MathUtils.lerp(-0.15, -0.025, push);
                  shellOffZ = THREE.MathUtils.lerp(0.04, -0.02, push);
                  relOffY += 0.012 * push;
                } else if (u >= 0.72 && u < 0.93) {
                  const k = (u - 0.72) / 0.21;
                  const pump = k < 0.5 ? easeOut(k / 0.5) : 1 - easeOut((k - 0.5) / 0.5);
                  pumpOffZ = 0.085 * pump;
                  boltPullZ = Math.max(boltPullZ, 0.062 * pump);
                  relOffZ += 0.03 * pump;
                }
              }
            } else if (cls === 'LMG' || cls === 'GPMG' || activeWeapon.id === 'helios_plasma') {
              // Heavy MG / Plasma LMG: open top cover latch, swap ammo box/cell, close cover, rack bolt
              const tiltEnv =
                u < 0.14
                  ? easeOut(u / 0.14)
                  : u > 0.9
                    ? 1 - easeInOut((u - 0.9) / 0.1)
                    : 1;
              relOffX = -0.055 * tiltEnv;
              relOffY = -0.055 * tiltEnv;
              relOffZ = 0.045 * tiltEnv;
              relRotX = 0.18 * tiltEnv;
              relRotY = 0.24 * tiltEnv;
              relRotZ = 0.3 * tiltEnv;

              if (u >= 0.12 && u < 0.26) {
                topCoverRotX = 1.02 * easeOut((u - 0.12) / 0.14);
              } else if (u >= 0.26 && u < 0.66) {
                topCoverRotX = 1.02;
              } else if (u >= 0.66 && u < 0.78) {
                topCoverRotX = 1.02 * (1 - easeInOut((u - 0.66) / 0.12));
              }

              if (u >= 0.22 && u < 0.44) {
                const k = easeOut((u - 0.22) / 0.22);
                magOffY = -0.26 * k;
                magOffX = 0.08 * k;
              } else if (u >= 0.44 && u < 0.65) {
                const k = easeInOut((u - 0.44) / 0.21);
                magOffY = THREE.MathUtils.lerp(-0.26, 0, k);
                magOffX = THREE.MathUtils.lerp(0.08, 0, k);
                if (k > 0.85) relOffY += 0.02 * Math.sin(((k - 0.85) / 0.15) * Math.PI);
              }

              if (u >= 0.78 && u < 0.94) {
                const k = (u - 0.78) / 0.16;
                const rack = k < 0.5 ? easeOut(k / 0.5) : 1 - easeOut((k - 0.5) / 0.5);
                boltPullZ = Math.max(boltPullZ, 0.068 * rack);
                relOffZ += 0.032 * rack;
              }
            } else {
              // Standard Rifles / Carbines / SMGs / DMRs / Snipers
              const tiltEnv =
                u < 0.14
                  ? easeOut(u / 0.14)
                  : u > 0.88
                    ? 1 - easeInOut((u - 0.88) / 0.12)
                    : 1;
              relOffX = -0.055 * tiltEnv;
              relOffY = -0.045 * tiltEnv;
              relOffZ = 0.035 * tiltEnv;
              relRotX = 0.22 * tiltEnv;
              relRotY = 0.34 * tiltEnv;
              relRotZ = 0.38 * tiltEnv;

              if (u >= 0.14 && u < 0.4) {
                const k = easeOut((u - 0.14) / 0.26);
                magOffY = -0.25 * k;
                magOffZ = 0.03 * k;
              } else if (u >= 0.4 && u < 0.68) {
                const k = easeInOut((u - 0.4) / 0.28);
                magOffY = THREE.MathUtils.lerp(-0.25, 0, k);
                magOffZ = THREE.MathUtils.lerp(0.03, 0, k);
                if (k > 0.86) relOffY += 0.022 * Math.sin(((k - 0.86) / 0.14) * Math.PI);
              } else if (u >= 0.68 && u < 0.89) {
                const k = (u - 0.68) / 0.21;
                const rack = k < 0.5 ? easeOut(k / 0.5) : 1 - easeOut((k - 0.5) / 0.5);
                boltPullZ = Math.max(boltPullZ, 0.06 * rack);
                relOffZ += 0.028 * rack;
              }
            }
          }

          weaponAnchor.position.x = THREE.MathUtils.damp(
            weaponAnchor.position.x,
            baseRig.x + bobX + relOffX,
            18,
            delta
          );
          weaponAnchor.position.y = THREE.MathUtils.damp(
            weaponAnchor.position.y,
            baseRig.y + bobY + relOffY,
            18,
            delta
          );
          weaponAnchor.position.z = THREE.MathUtils.damp(
            weaponAnchor.position.z,
            baseRig.z + s.weaponKickZ + relOffZ,
            18,
            delta
          );
          weaponAnchor.rotation.x = THREE.MathUtils.damp(
            weaponAnchor.rotation.x,
            s.weaponKickPitch + relRotX,
            18,
            delta
          );
          weaponAnchor.rotation.z = THREE.MathUtils.damp(
            weaponAnchor.rotation.z,
            Math.sin(s.swayPhase) * (s.isAds ? 0.004 : 0.014 * 1.2) * activeHeatSway + relRotZ,
            18,
            delta
          );
          weaponAnchor.rotation.y = THREE.MathUtils.damp(
            weaponAnchor.rotation.y,
            Math.cos(s.swayPhase * 0.85) * (s.isAds ? 0.003 : 0.011 * 1.2) * activeHeatSway +
              relRotY,
            18,
            delta
          );

          if (currentWeapon3D.magGroup) {
            const isPistolRig = activeWeapon.category === 'PISTOL';
            const baseMagY = isPistolRig ? -0.095 : -0.1;
            const baseMagZ = isPistolRig ? 0.052 : -0.05;
            currentWeapon3D.magGroup.position.set(
              magOffX,
              baseMagY + magOffY,
              baseMagZ + magOffZ
            );
          }
          if (currentWeapon3D.boltGroup) {
            currentWeapon3D.boltGroup.position.z = boltPullZ;
          }
          if (currentWeapon3D.topCoverGroup) {
            currentWeapon3D.topCoverGroup.rotation.x = THREE.MathUtils.damp(
              currentWeapon3D.topCoverGroup.rotation.x,
              topCoverRotX,
              22,
              delta
            );
          }
          if (currentWeapon3D.pumpGroup) {
            currentWeapon3D.pumpGroup.position.z = pumpOffZ;
          }
          if (currentWeapon3D.shellMesh) {
            currentWeapon3D.shellMesh.visible = showShell;
            currentWeapon3D.shellMesh.position.set(0, shellOffY, shellOffZ);
          }
        }

        // Drop & hide weapon viewmodel as the player collapses when downed
        if (p.playerHp <= 0) {
          weaponAnchor.position.y = THREE.MathUtils.damp(weaponAnchor.position.y, -0.65, 14, delta);
          weaponAnchor.visible = s.deathFallProgress < 0.48;
        } else if (!weaponAnchor.visible) {
          weaponAnchor.visible = true;
        }

        if (s.muzzleFlashTimer > 0) {
          s.muzzleFlashTimer -= delta;
          if (s.muzzleFlashTimer <= 0) {
            currentWeapon3D.muzzleFlash.visible = false;
          }
        }

        // Decay breakable door & breakable cover hit flashes
        for (const d of [currentRoom.westDoor, currentRoom.eastDoor, currentRoom.northDoor]) {
          if (d && !d.broken && d.flashTimer > 0) {
            d.flashTimer = Math.max(0, d.flashTimer - delta);
            if (d.flashTimer === 0) {
              d.panelMat.emissive.setHex(0x000000);
              d.panelMat.emissiveIntensity = 0;
            }
          }
        }
        for (const cov of currentRoom.covers) {
          if (!cov.broken && cov.flashTimer > 0) {
            cov.flashTimer = Math.max(0, cov.flashTimer - delta);
            if (cov.flashTimer === 0) {
              cov.panelMat.emissive.setHex(0x000000);
              cov.panelMat.emissiveIntensity = 0;
            }
          }
        }

        // Advance pooled bullet impact sparks & fade impact decals
        for (const sp of s.impactSparks) {
          if (!sp.active) continue;
          sp.life -= delta;
          if (sp.life <= 0) {
            sp.active = false;
            sp.mesh.visible = false;
            continue;
          }
          sp.vy -= 18 * delta;
          sp.mesh.position.x += sp.vx * delta;
          sp.mesh.position.y += sp.vy * delta;
          sp.mesh.position.z += sp.vz * delta;
        }
        for (const dc of s.impactDecals) {
          if (!dc.active) continue;
          dc.life -= delta;
          if (dc.life <= 0) {
            dc.active = false;
            dc.mesh.visible = false;
          }
        }

        const patrolNodes = getDronePatrolNodes(p.config.roomId, p.config.distanceM);
        const envBlockers = currentRoom.environmentHitMeshes.filter((m) => m.visible);
        const camFwdX = -Math.sin(s.aimYaw);
        const camFwdZ = -Math.cos(s.aimYaw);

        const getEnemyPreferredRangeM = (id: EnemyWeaponSpec['id']): number => {
          switch (id) {
            case 'enemy_shotgun':
              return 10;
            case 'enemy_ar':
              return 24;
            case 'enemy_20mm':
              return 26;
            case 'enemy_plasma':
              return 30;
            case 'enemy_atgm':
              return 34;
            case 'enemy_rocket_pods':
              return 32;
            default:
              return 18;
          }
        };

        const spawnEnemyBullet = (
          startPos: THREE.Vector3,
          dir: THREE.Vector3,
          spec: EnemyWeaponSpec,
          attackerName: string
        ) => {
          const isRocketOrAtgm =
            spec.id === 'enemy_atgm' || spec.id === 'enemy_rocket_pods';
          const boltColor = spec.colorHex;
          const boltMat = new THREE.MeshStandardMaterial({
            color: boltColor,
            emissive: boltColor,
            emissiveIntensity: 2.3,
            roughness: 0.2,
          });
          const boltMesh = new THREE.Mesh(droneBoltGeo, boltMat);
          boltMesh.scale.setScalar(
            spec.id === 'enemy_atgm'
              ? 1.35
              : spec.id === 'enemy_rocket_pods'
                ? 1.25
                : spec.id === 'enemy_20mm'
                  ? 1.1
                  : 0.72
          );
          boltMesh.position.copy(startPos);
          scene.add(boltMesh);

          s.droneProjectiles.push({
            mesh: boltMesh,
            vx: dir.x * spec.projectileSpeed,
            vy: dir.y * spec.projectileSpeed,
            vz: dir.z * spec.projectileSpeed,
            gravity: spec.id === 'enemy_shotgun' || spec.id === 'enemy_ar' ? 1.2 : 0,
            damage: spec.damage,
            attackerName,
            life: isRocketOrAtgm ? 4.5 : 2.6,
            isHoming: spec.id === 'enemy_atgm',
            turnRateRad: spec.homingTurnRateRad ?? 0,
            speedMps: spec.projectileSpeed,
            sourceWeaponId: spec.id,
            splashRadiusM: spec.splashRadiusM,
          });
        };

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

          if (p.playerHp <= 0 && s.turrets.length === 0) continue;

          // Deployed turrets have highest aggro priority over player
          let targetTurret: DeployableTurret3D | null = null;
          let bestTurretDistSq = Infinity;
          for (const tur of s.turrets) {
            if (tur.hp <= 0) continue;
            const tdx = tur.pos.x - actor.x;
            const tdz = tur.pos.z - actor.z;
            const tdSq = tdx * tdx + tdz * tdz;
            if (tdSq < bestTurretDistSq) {
              bestTurretDistSq = tdSq;
              targetTurret = tur;
            }
          }
          const combatTargetX = targetTurret ? targetTurret.pos.x : s.playerX;
          const combatTargetY = targetTurret ? targetTurret.pos.y : 1.38;
          const combatTargetZ = targetTurret ? targetTurret.pos.z : s.playerZ;

          // Decay per-actor burn DoT deduplication cooldown, 60% incendiary slow, & flash timers
          if (actor.burnCooldown > 0) actor.burnCooldown = Math.max(0, actor.burnCooldown - delta);
          if (actor.burnSlowTimer > 0) actor.burnSlowTimer = Math.max(0, actor.burnSlowTimer - delta);
          const flashRegions: BodyRegionKey[] = [
            'head',
            'torso',
            'leftArm',
            'rightArm',
            'leftLeg',
            'rightLeg',
            'shield',
          ];
          for (const reg of flashRegions) {
            if (actor.regionFlashTimers[reg] > 0) {
              actor.regionFlashTimers[reg] = Math.max(0, actor.regionFlashTimers[reg] - delta);
            }
          }

          const rangedSpec = actor.loadout.rangedWeaponId
            ? ENEMY_WEAPONS[actor.loadout.rangedWeaponId]
            : null;
          if (actor.rangedRecoilDeg > 0) {
            const recov = rangedSpec ? rangedSpec.recoilRecoverPerSec : 6;
            actor.rangedRecoilDeg = Math.max(0, actor.rangedRecoilDeg - recov * delta);
          }

          // Internal Components Simulation:
          // - Broken torso capacitor slowly drains every other component
          // - Damaged battery pulls energy from its assigned limb/head/torso capacitor
          const comp = actor.components;
          if (comp.capacitors.torso <= 0) {
            const cascade = 1.65 * delta;
            comp.powerSupplyHp = Math.max(0, comp.powerSupplyHp - cascade);
            comp.batteryHp = Math.max(0, comp.batteryHp - cascade);
            comp.viewingLensHp = Math.max(0, comp.viewingLensHp - cascade);
            comp.mechanismsHp = Math.max(0, comp.mechanismsHp - cascade);
            comp.capacitors.head = Math.max(0, comp.capacitors.head - cascade);
            comp.capacitors.leftArm = Math.max(0, comp.capacitors.leftArm - cascade);
            comp.capacitors.rightArm = Math.max(0, comp.capacitors.rightArm - cascade);
            comp.capacitors.leftLeg = Math.max(0, comp.capacitors.leftLeg - cascade);
            comp.capacitors.rightLeg = Math.max(0, comp.capacitors.rightLeg - cascade);
          }
          if (comp.batteryHp > 0 && comp.batteryHp < comp.batteryMaxHp) {
            const siphon = 2.4 * delta;
            const tgt = comp.batterySiphonTarget;
            comp.capacitors[tgt] = Math.max(0, comp.capacitors[tgt] - siphon);
          }
          if (comp.powerSupplyHp <= 0 && !comp.powerSupplyExploded) {
            triggerComponentExplosion(actor, 'POWER_SUPPLY');
            if (!actor.alive) continue;
          }
          if (comp.batteryHp <= 0 && !comp.batteryExploded) {
            triggerComponentExplosion(actor, 'BATTERY');
            if (!actor.alive) continue;
          }

          const leftLegDead = comp.capacitors.leftLeg <= 0;
          const rightLegDead = comp.capacitors.rightLeg <= 0;
          const legSpeedMult =
            leftLegDead && rightLegDead ? 0 : leftLegDead || rightLegDead ? 0.42 : 1.0;
          const armBroken = actor.loadout.hasShield
            ? comp.capacitors.rightArm <= 0
            : comp.capacitors.leftArm <= 0 && comp.capacitors.rightArm <= 0;
          const armMeleeSpeedMult = armBroken ? 0.48 : 1.0;
          const armMeleeDmgMult = armBroken ? 0.38 : 1.0;
          const headCapBroken = comp.capacitors.head <= 0;
          const lensBroken = comp.viewingLensHp <= 0;
          const mechBroken = comp.mechanismsHp <= 0;
          const compSpreadPenaltyDeg =
            (armBroken ? 6.5 : 0) +
            (headCapBroken ? 5.5 : 0) +
            (lensBroken ? 4.5 : 0) +
            (mechBroken ? 2.5 : 0);

          const burnSpeedMult = actor.burnSlowTimer > 0 ? 1.2 : 1.0;
          const combinedSpeedMult = burnSpeedMult * legSpeedMult * (mechBroken ? 0.85 : 1.0);

          // Staggered State: stunned recoil stance
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
            if (actor.model.leftKnee) {
              actor.model.leftKnee.rotation.x = THREE.MathUtils.damp(
                actor.model.leftKnee.rotation.x,
                0.22,
                10,
                delta
              );
            }
            if (actor.model.rightKnee) {
              actor.model.rightKnee.rotation.x = THREE.MathUtils.damp(
                actor.model.rightKnee.rotation.x,
                0.22,
                10,
                delta
              );
            }
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
            if (actor.model.leftElbow) {
              actor.model.leftElbow.rotation.x = THREE.MathUtils.damp(
                actor.model.leftElbow.rotation.x,
                -0.62,
                12,
                delta
              );
            }
            if (actor.model.rightElbow) {
              actor.model.rightElbow.rotation.x = THREE.MathUtils.damp(
                actor.model.rightElbow.rotation.x,
                -0.62,
                12,
                delta
              );
            }

            actor.model.root.position.set(actor.x, 0, actor.z);
            actor.model.root.rotation.x = 0;
            actor.model.root.lookAt(combatTargetX, 0, combatTargetZ);
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
            northDoorBroken: currentRoom.northDoor?.broken ?? true,
            covers: currentRoom.covers,
          };

          // Breakable Grey Door check for enemies spawning behind doors
          const assignedDoor = getDoorBySide(actor.doorSide);

          if (assignedDoor && !assignedDoor.broken) {
            const distToDoor = Math.hypot(
              actor.x - assignedDoor.breachOrigin.x,
              actor.z - assignedDoor.breachOrigin.z
            );
            if (distToDoor > 1.35) {
              const dirX = (assignedDoor.breachOrigin.x - actor.x) / distToDoor;
              const dirZ = (assignedDoor.breachOrigin.z - actor.z) / distToDoor;
              const spd = actor.profile.moveSpeedMps * 0.95 * combinedSpeedMult;
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
              if (actor.model.leftKnee) {
                actor.model.leftKnee.rotation.x = Math.max(0.06, -Math.sin(actor.stridePhase - 0.5) * 0.55);
              }
              if (actor.model.rightKnee) {
                actor.model.rightKnee.rotation.x = Math.max(0.06, Math.sin(actor.stridePhase - 0.5) * 0.55);
              }
            } else {
              // Bash the grey bulkhead door down
              actor.doorBashCooldown -= delta;
              actor.model.leftClawArm.rotation.x = -Math.abs(Math.sin(elapsed * 9)) * 1.1;
              actor.model.rightClawArm.rotation.x = -Math.abs(Math.cos(elapsed * 9)) * 1.1;
              if (actor.doorBashCooldown <= 0) {
                actor.doorBashCooldown = 0.42;
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

          // VANGUARD SHIELD DRONE: Flying chassis (no legs/arms) firing shoulder ATGM (never from weakspot)
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
                const moveSpd = actor.profile.moveSpeedMps * burnSpeedMult * (mechBroken ? 0.72 : 1.0);
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

            actor.model.bodyGroup.position.y = Math.sin(elapsed * 3.8 + actor.uid) * 0.14;
            actor.model.leftLeg.rotation.x = 0;
            actor.model.rightLeg.rotation.x = 0;

            const atgmSpec = rangedSpec ?? ENEMY_WEAPONS.enemy_atgm;
            actor.lastEffectiveAccuracy = THREE.MathUtils.clamp(
              1 - (atgmSpec.baseSpreadDeg + actor.rangedRecoilDeg + compSpreadPenaltyDeg) / 18,
              0.12,
              1.0
            );

            if (actor.waypointIdx >= actor.waypoints.length && !comp.atgmDestroyed) {
              if (actor.rangedReloadTimer > 0) {
                actor.rangedReloadTimer = Math.max(0, actor.rangedReloadTimer - delta);
                actor.droneChargeTimer = 0;
                if (actor.rangedReloadTimer === 0) {
                  actor.rangedMag = atgmSpec.magSize;
                }
              } else {
                actor.rangedFireCooldown = Math.max(0, actor.rangedFireCooldown - delta);
                if (actor.rangedFireCooldown <= 0 && actor.rangedMag > 0) {
                  const muzzleObj = actor.model.weaponMuzzlePoint ?? actor.model.bodyGroup;
                  const startPos = muzzleObj.getWorldPosition(_vec3A);
                  const targetPos = _vec3B.set(
                    combatTargetX,
                    targetTurret ? targetTurret.pos.y : 1.42,
                    combatTargetZ
                  );
                  const dirToTarget = _vec3C.subVectors(targetPos, startPos);
                  const distToTarget = dirToTarget.length();
                  if (distToTarget > 0.5) {
                    dirToTarget.normalize();
                    raycaster.set(startPos, dirToTarget);
                    const losHits = raycaster.intersectObjects(envBlockers, false);
                    const blocked = losHits.length > 0 && losHits[0].distance < distToTarget - 0.35;

                    if (!blocked) {
                      const spreadRad = THREE.MathUtils.degToRad(
                        atgmSpec.baseSpreadDeg + actor.rangedRecoilDeg + compSpreadPenaltyDeg
                      );
                      dirToTarget.x += (Math.random() - 0.5) * spreadRad;
                      dirToTarget.y += (Math.random() - 0.5) * spreadRad * 0.6;
                      dirToTarget.z += (Math.random() - 0.5) * spreadRad;
                      dirToTarget.normalize();

                      spawnEnemyBullet(startPos, dirToTarget, atgmSpec, actor.profile.name);
                      soundEngine.playEnemyWeaponFire(atgmSpec.id);
                      actor.rangedMag -= 1;
                      actor.rangedRecoilDeg += atgmSpec.recoilPerShotDeg;
                      actor.rangedFireCooldown = 60 / atgmSpec.rpm;
                      if (actor.rangedMag <= 0) {
                        actor.rangedReloadTimer = atgmSpec.reloadSec;
                      }
                    } else {
                      actor.rangedFireCooldown = 0.25;
                    }
                  }
                }
              }
            }

            actor.model.root.position.set(actor.x, 0, actor.z);
            actor.model.root.rotation.x = 0;
            actor.model.root.lookAt(combatTargetX, 0, combatTargetZ);
            continue;
          }

          // GROUND CHASSIS AI: Follow corridor waypoints if in Room 2
          if (actor.waypointIdx < actor.waypoints.length) {
            const wp = actor.waypoints[actor.waypointIdx];
            const dx = wp.x - actor.x;
            const dz = wp.z - actor.z;
            const distWp = Math.hypot(dx, dz);
            if (distWp < 1.25) {
              actor.waypointIdx += 1;
            } else {
              const spd = actor.profile.moveSpeedMps * 0.96 * combinedSpeedMult;
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

            actor.stridePhase += delta * actor.profile.moveSpeedMps * 1.85 * legSpeedMult;
            actor.model.leftLeg.rotation.x = Math.sin(actor.stridePhase) * 0.52;
            actor.model.rightLeg.rotation.x = -Math.sin(actor.stridePhase) * 0.52;
            if (actor.model.leftKnee) {
              actor.model.leftKnee.rotation.x = Math.max(0.06, -Math.sin(actor.stridePhase - 0.5) * 0.62);
            }
            if (actor.model.rightKnee) {
              actor.model.rightKnee.rotation.x = Math.max(0.06, Math.sin(actor.stridePhase - 0.5) * 0.62);
            }
            actor.model.bodyGroup.position.y = Math.abs(Math.sin(actor.stridePhase)) * 0.08;
            actor.model.leftClawArm.rotation.x = actor.loadout.hasShield
              ? -0.62
              : -Math.sin(actor.stridePhase) * 0.35;
            actor.model.rightClawArm.rotation.x = rangedSpec
              ? -1.08 + Math.sin(actor.stridePhase) * 0.03
              : Math.sin(actor.stridePhase) * 0.35;
            if (actor.model.rightElbow) {
              actor.model.rightElbow.rotation.x = rangedSpec ? -0.45 : -0.45;
            }

            actor.model.root.position.set(actor.x, 0, actor.z);
            actor.model.root.rotation.x = 0;
            actor.model.root.lookAt(wp.x, 0, wp.z);
            continue;
          }

          const toTargetX = combatTargetX - actor.x;
          const toTargetZ = combatTargetZ - actor.z;
          const distFromTarget = Math.hypot(toTargetX, toTargetZ);
          const distFromPlayer = Math.hypot(s.playerX - actor.x, s.playerZ - actor.z);
          const effectiveMeleeReach = actor.meleeDist + (targetTurret ? 0.35 : 0);
          const isSwarmer = actor.profile.silhouette === 'swarmer';

          // Brute Shoulder Rocket Pods volley (240 RPM, 24 rounds, 9s reload, 30 m/s, 1m drop-radius splash)
          const podSpec =
            actor.loadout.rocketPodWeaponId && !comp.rocketPodDestroyed
              ? ENEMY_WEAPONS[actor.loadout.rocketPodWeaponId]
              : null;
          if (podSpec) {
            if (actor.podReloadTimer > 0) {
              actor.podReloadTimer = Math.max(0, actor.podReloadTimer - delta);
              if (actor.podReloadTimer === 0) {
                actor.podMag = podSpec.magSize;
              }
            } else {
              actor.podCooldown = Math.max(0, actor.podCooldown - delta);
              if (actor.podCooldown <= 0 && actor.podMag > 0 && distFromTarget <= 42 && distFromTarget > 2.2) {
                const muzzles = actor.model.rocketMuzzlePoints;
                const muzzleObj =
                  muzzles.length > 0
                    ? muzzles[actor.podMag % muzzles.length]
                    : actor.model.bodyGroup;
                const startPos = muzzleObj.getWorldPosition(_vec3A);
                const targetPos = _vec3B.set(
                  combatTargetX,
                  targetTurret ? targetTurret.pos.y : 1.32,
                  combatTargetZ
                );
                const dirToTarget = _vec3C.subVectors(targetPos, startPos);
                const rayLen = dirToTarget.length();
                if (rayLen > 0.5) {
                  dirToTarget.normalize();
                  raycaster.set(startPos, dirToTarget);
                  const losHits = raycaster.intersectObjects(envBlockers, false);
                  const blocked = losHits.length > 0 && losHits[0].distance < rayLen - 0.5;
                  if (!blocked) {
                    const spreadRad = THREE.MathUtils.degToRad(
                      podSpec.baseSpreadDeg + compSpreadPenaltyDeg * 0.45
                    );
                    dirToTarget.x += (Math.random() - 0.5) * spreadRad;
                    dirToTarget.y += (Math.random() - 0.5) * spreadRad * 0.55;
                    dirToTarget.z += (Math.random() - 0.5) * spreadRad;
                    dirToTarget.normalize();
                    spawnEnemyBullet(startPos, dirToTarget, podSpec, actor.profile.name);
                    soundEngine.playEnemyWeaponFire(podSpec.id);
                    actor.podMag -= 1;
                    actor.podCooldown = 60 / podSpec.rpm;
                    if (actor.podMag <= 0) {
                      actor.podReloadTimer = podSpec.reloadSec;
                    }
                  } else {
                    actor.podCooldown = 0.25;
                  }
                }
              }
            }
          }

          /**
           * Accuracy-Driven Tactical Cover Evaluation & Ranged Combat AI:
           * - Computes `lastEffectiveAccuracy` from base spread + dynamic recoil + broken arm/head/lens
           *   capacitor penalties (`compSpreadPenaltyDeg`).
           * - Whenever effective accuracy drops below `0.62` or the mech enters magazine reload, it scans
           *   intact 400-HP covers (`currentRoom.covers`), heavily penalizes `flankRisk === 'HIGH'`
           *   covers (+18 score penalty), avoids covers closer than 4m to the target, and positions
           *   itself strictly on the far side (`cov.z + czSign * (cov.halfD + 0.92)`) so its back is
           *   shielded while peeking over the cover to return fire.
           *
           * Why an alternative would be worse: static cover assignments leave enemies crouching behind
           * destroyed covers or stepping into exposed side lanes; continuous risk-weighted scoring lets
           * ranged mechs break off mid-duel when limbs fail or covers shatter.
           */
          let enemyShouldHoldForRanged = false;
          let coverGoalPos: { x: number; z: number } | null = null;
          const activeRangedSpec = rangedSpec && !comp.armsDestroyed.rightArm ? rangedSpec : null;
          if (activeRangedSpec) {
            const effectiveSpreadDeg =
              activeRangedSpec.baseSpreadDeg + actor.rangedRecoilDeg + compSpreadPenaltyDeg;
            actor.lastEffectiveAccuracy = THREE.MathUtils.clamp(
              1 - effectiveSpreadDeg / 18,
              0.08,
              1.0
            );

            // Seek cover that cannot easily be flanked when accuracy drops or while reloading
            const needsCover =
              (actor.lastEffectiveAccuracy < 0.62 || actor.rangedReloadTimer > 0) &&
              currentRoom.covers.length > 0;

            if (needsCover) {
              actor.coverRepickTimer -= delta;
              if (
                !actor.coverTarget ||
                actor.coverTarget.broken ||
                actor.coverRepickTimer <= 0
              ) {
                actor.coverRepickTimer = 1.6;
                let bestCov: BreakableCover3D | null = null;
                let bestScore = Infinity;
                for (const cov of currentRoom.covers) {
                  if (cov.broken) continue;
                  const dCov = Math.hypot(cov.x - actor.x, cov.z - actor.z);
                  const dTargetToCov = Math.hypot(cov.x - combatTargetX, cov.z - combatTargetZ);
                  if (dTargetToCov < 4.0) continue;
                  // Strongly penalize high-flank-risk covers where the target lane can sweep behind them
                  const flankPenalty = cov.flankRisk === 'HIGH' ? 18 : 0;
                  // Reward covers behind enemy's facing lane so its back faces away from the threat
                  const prefRange = getEnemyPreferredRangeM(activeRangedSpec.id);
                  const standOffDist = Math.abs(dTargetToCov - Math.min(20, prefRange));
                  const score = flankPenalty + dCov * 0.7 + standOffDist * 0.65;
                  if (score < bestScore) {
                    bestScore = score;
                    bestCov = cov;
                  }
                }
                actor.coverTarget = bestCov;
              }
            } else {
              actor.coverTarget = null;
            }

            if (actor.coverTarget && !actor.coverTarget.broken) {
              const cov = actor.coverTarget;
              const czSign = cov.z - combatTargetZ >= 0 ? 1 : -1;
              coverGoalPos = {
                x: cov.x,
                z: cov.z + czSign * (cov.halfD + 0.92),
              };
            }

            const prefFireRange = getEnemyPreferredRangeM(activeRangedSpec.id);

            // Fire ranged weapon when inside preferred range corridor and LoS is clear
            if (actor.rangedReloadTimer > 0) {
              actor.rangedReloadTimer = Math.max(0, actor.rangedReloadTimer - delta);
              if (actor.rangedReloadTimer === 0) {
                actor.rangedMag = activeRangedSpec.magSize;
              }
            } else {
              actor.rangedFireCooldown = Math.max(0, actor.rangedFireCooldown - delta);
              const maxFireDist = Math.max(18, prefFireRange * 1.65);
              if (
                actor.rangedFireCooldown <= 0 &&
                actor.rangedMag > 0 &&
                distFromTarget <= maxFireDist &&
                distFromTarget > 0.8
              ) {
                const muzzleObj = actor.model.weaponMuzzlePoint ?? actor.model.rightClawArm;
                const startPos = muzzleObj.getWorldPosition(_vec3A);
                // Waist-up elevation clears 0.95m barricade cover
                startPos.y = Math.max(startPos.y, 1.18);
                const targetPos = _vec3B.set(combatTargetX, combatTargetY, combatTargetZ);
                const dirToTarget = _vec3C.subVectors(targetPos, startPos);
                const rayLen = dirToTarget.length();
                if (rayLen > 0.35) {
                  dirToTarget.normalize();
                  raycaster.set(startPos, dirToTarget);
                  const losHits = raycaster.intersectObjects(envBlockers, false);
                  // Ignore hits against cover immediately adjacent to the shooter peeking over it
                  const firstSolid = losHits.find(
                    (h) => !(h.object.userData.isCover && h.distance < 2.2)
                  );
                  const blocked = firstSolid !== undefined && firstSolid.distance < rayLen - 0.35;

                  if (!blocked) {
                    const spreadRad = THREE.MathUtils.degToRad(effectiveSpreadDeg);
                    for (let pIdx = 0; pIdx < activeRangedSpec.pellets; pIdx++) {
                      const shotDir = new THREE.Vector3(
                        dirToTarget.x + (Math.random() - 0.5) * spreadRad,
                        dirToTarget.y + (Math.random() - 0.5) * spreadRad * 0.65,
                        dirToTarget.z + (Math.random() - 0.5) * spreadRad
                      ).normalize();
                      spawnEnemyBullet(startPos, shotDir, activeRangedSpec, actor.profile.name);
                    }
                    soundEngine.playEnemyWeaponFire(activeRangedSpec.id);
                    actor.rangedMag -= 1;
                    actor.rangedRecoilDeg += activeRangedSpec.recoilPerShotDeg;
                    actor.rangedFireCooldown = 60 / activeRangedSpec.rpm;
                    if (actor.rangedMag <= 0) {
                      actor.rangedReloadTimer = activeRangedSpec.reloadSec;
                    }
                  } else {
                    actor.rangedFireCooldown = 0.22;
                  }
                }
              }
            }

            if (coverGoalPos) {
              if (Math.hypot(coverGoalPos.x - actor.x, coverGoalPos.z - actor.z) <= 1.05) {
                enemyShouldHoldForRanged = true;
              }
            } else if (
              !actor.loadout.meleeWeaponId &&
              distFromTarget <= prefFireRange &&
              distFromTarget > effectiveMeleeReach + 0.8
            ) {
              enemyShouldHoldForRanged = true;
            }
          }

          // Swarmer break-contact retreat right after landing an attack
          if (isSwarmer && actor.retreatTimer > 0 && actor.clawAnimType === 'NONE' && !rangedSpec) {
            actor.retreatTimer = Math.max(0, actor.retreatTimer - delta);
            const awayLen = Math.max(0.01, distFromTarget);
            const awayX = -toTargetX / awayLen;
            const awayZ = -toTargetZ / awayLen;
            const tangX = -awayZ * actor.weaveDirection;
            const tangZ = awayX * actor.weaveDirection;
            const evadeX = awayX * 0.72 + tangX * 0.68;
            const evadeZ = awayZ * 0.72 + tangZ * 0.68;
            const evadeSpd = (actor.profile.maxSpeedMps ?? actor.profile.moveSpeedMps * 1.2) * combinedSpeedMult;

            const resolved = resolveRoomCollision2D(
              actor.x + evadeX * evadeSpd * delta,
              actor.z + evadeZ * evadeSpd * delta,
              actor.x,
              actor.z,
              0.45 * actor.profile.scaleXZ,
              p.config.roomId,
              collisionOpts
            );
            actor.x = resolved.x;
            actor.z = resolved.z;
            actor.stridePhase += delta * evadeSpd * 2.1;
            actor.model.leftLeg.rotation.x = Math.sin(actor.stridePhase) * 0.62;
            actor.model.rightLeg.rotation.x = -Math.sin(actor.stridePhase) * 0.62;
            if (actor.model.leftKnee) {
              actor.model.leftKnee.rotation.x = Math.max(0.08, -Math.sin(actor.stridePhase - 0.5) * 0.72);
            }
            if (actor.model.rightKnee) {
              actor.model.rightKnee.rotation.x = Math.max(0.08, Math.sin(actor.stridePhase - 0.5) * 0.72);
            }
            actor.model.bodyGroup.position.y = Math.abs(Math.sin(actor.stridePhase)) * 0.1;

            actor.model.root.position.set(actor.x, 0, actor.z);
            actor.model.root.rotation.x = 0;
            actor.model.root.lookAt(actor.x + evadeX * 4, 0, actor.z + evadeZ * 4);
            continue;
          }

          // Swarm separation vector + Enemy Grenade Sightcone Avoidance & Incendiary Dispersal
          let sepX = 0;
          let sepZ = 0;
          for (const other of s.enemies) {
            if (other === actor || !other.alive || other.profile.silhouette === 'drone') continue;
            const sdx = actor.x - other.x;
            const sdz = actor.z - other.z;
            const sDist = Math.hypot(sdx, sdz);
            const sepScale = isSwarmer ? 1.48 : 0.72;
            const minNeighborDist = sepScale * (actor.profile.scaleXZ + other.profile.scaleXZ);
            if (sDist < minNeighborDist) {
              const push = (minNeighborDist - sDist) / minNeighborDist;
              if (sDist > 0.001) {
                sepX += (sdx / sDist) * push * (isSwarmer ? 5.2 : 3.8);
                sepZ += (sdz / sDist) * push * (isSwarmer ? 5.2 : 3.8);
              } else {
                sepX += Math.cos(actor.swarmAngle) * 2.4;
                sepZ += Math.sin(actor.swarmAngle) * 2.4;
              }
            }
          }

          const faceLen = Math.max(0.01, distFromTarget);
          const faceX = toTargetX / faceLen;
          const faceZ = toTargetZ / faceLen;

          let avoidX = 0;
          let avoidZ = 0;
          const canSwerveHazards = actor.uid % 3 !== 0;

          if (canSwerveHazards) {
            for (const g of s.thrownGrenades) {
              const gdx = g.mesh.position.x - actor.x;
              const gdz = g.mesh.position.z - actor.z;
              const gDist = Math.hypot(gdx, gdz);
              if (gDist > 2.6 && gDist < 10.0) {
                const sightDot = (gdx / gDist) * faceX + (gdz / gDist) * faceZ;
                if (sightDot > 0.35) {
                  const urgency = (10.0 - gDist) / 7.4;
                  const cross = gdx * faceZ - gdz * faceX;
                  const swerveSide = cross >= 0 ? -1 : 1;
                  const swerveX = -faceZ * swerveSide;
                  const swerveZ = faceX * swerveSide;
                  avoidX += (swerveX * 0.92 + faceX * 0.35) * 8.2 * urgency;
                  avoidZ += (swerveZ * 0.92 + faceZ * 0.35) * 8.2 * urgency;
                }
              }
            }

            for (const c4 of s.stickyC4s) {
              if (c4.stuck) continue;
              const cdx = c4.pos.x - actor.x;
              const cdz = c4.pos.z - actor.z;
              const cDist = Math.hypot(cdx, cdz);
              if (cDist > 2.6 && cDist < 9.0) {
                const sightDot = (cdx / cDist) * faceX + (cdz / cDist) * faceZ;
                if (sightDot > 0.35) {
                  const urgency = (9.0 - cDist) / 6.4;
                  const cross = cdx * faceZ - cdz * faceX;
                  const swerveSide = cross >= 0 ? -1 : 1;
                  avoidX += (-faceZ * swerveSide * 0.9 + faceX * 0.32) * 7.2 * urgency;
                  avoidZ += (faceX * swerveSide * 0.9 + faceZ * 0.32) * 7.2 * urgency;
                }
              }
            }

            for (const z of s.incendiaryZones) {
              const toFireX = z.x - actor.x;
              const toFireZ = z.z - actor.z;
              const fDist = Math.hypot(toFireX, toFireZ);
              const commitThreshold = z.radius + 2.2;
              const farAwareThreshold = z.radius + 9.5;
              if (fDist > commitThreshold && fDist < farAwareThreshold) {
                const toFireDot = (toFireX / fDist) * faceX + (toFireZ / fDist) * faceZ;
                if (toFireDot > 0.22) {
                  const blend = (farAwareThreshold - fDist) / (farAwareThreshold - commitThreshold);
                  const cross = toFireX * faceZ - toFireZ * faceX;
                  const swerveSide = cross >= 0 ? -1 : 1;
                  const swerveX = -faceZ * swerveSide;
                  const swerveZ = faceX * swerveSide;
                  avoidX += (swerveX * 0.88 + faceX * 0.42) * 7.8 * blend;
                  avoidZ += (swerveZ * 0.88 + faceZ * 0.42) * 7.8 * blend;
                }
              }
            }
          }

          sepX += avoidX;
          sepZ += avoidZ;

          // Enemy Lunge Windup & Burst Pounce (disabled if both leg capacitors failed or holding ranged cover)
          if (actor.clawAnimType === 'NONE' && legSpeedMult > 0 && !enemyShouldHoldForRanged && !coverGoalPos) {
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
                const lLen = Math.max(0.01, distFromTarget);
                actor.lungeDirX = toTargetX / lLen;
                actor.lungeDirZ = toTargetZ / lLen;
              }
              actor.model.root.position.set(actor.x, 0, actor.z);
              actor.model.root.rotation.x = 0;
              actor.model.root.lookAt(combatTargetX, 0, combatTargetZ);
              continue;
            } else if (actor.lungeState === 'LUNGE') {
              actor.lungeTimer -= delta;
              const baseSpd = actor.profile.moveSpeedMps;
              const lungeSpeed =
                (actor.profile.maxSpeedMps
                  ? actor.profile.maxSpeedMps
                  : Math.min(13.0, baseSpd * 1.95)) * combinedSpeedMult;

              const liveLen = Math.max(0.01, distFromTarget);
              const steerX = actor.lungeDirX * 0.72 + (toTargetX / liveLen) * 0.28;
              const steerZ = actor.lungeDirZ * 0.72 + (toTargetZ / liveLen) * 0.28;
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
              if (actor.model.leftElbow) actor.model.leftElbow.rotation.x = -0.25;
              if (actor.model.rightElbow) actor.model.rightElbow.rotation.x = -0.25;
              actor.stridePhase += delta * lungeSpeed * 2.1;
              actor.model.leftLeg.rotation.x = Math.sin(actor.stridePhase) * 0.65;
              actor.model.rightLeg.rotation.x = -Math.sin(actor.stridePhase) * 0.65;
              if (actor.model.leftKnee) {
                actor.model.leftKnee.rotation.x = Math.max(0.1, -Math.sin(actor.stridePhase - 0.5) * 0.72);
              }
              if (actor.model.rightKnee) {
                actor.model.rightKnee.rotation.x = Math.max(0.1, Math.sin(actor.stridePhase - 0.5) * 0.72);
              }

              const postDist = Math.hypot(combatTargetX - actor.x, combatTargetZ - actor.z);
              if (actor.lungeTimer <= 0 || postDist <= effectiveMeleeReach + 0.25) {
                actor.lungeState = 'NONE';
                actor.lungeCooldown =
                  actor.profile.silhouette === 'brute'
                    ? 1.5 + Math.random() * 1.1
                    : 3.0 + Math.random() * 2.4;
                if (postDist <= effectiveMeleeReach + 0.35) {
                  actor.attackCooldown = 0;
                }
              }

              actor.model.root.position.set(actor.x, 0, actor.z);
              actor.model.root.rotation.x = 0;
              actor.model.root.lookAt(combatTargetX, 0, combatTargetZ);
              continue;
            }
          }

          if (enemyShouldHoldForRanged) {
            // Holding tactical cover or optimal ranged firing stance
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
              -0.06,
              10,
              delta
            );
            // Aim weapon arm dead forward toward prioritized target (-1.12 + -0.45 = -PI/2)
            actor.model.rightClawArm.rotation.x = THREE.MathUtils.damp(
              actor.model.rightClawArm.rotation.x,
              -1.12 - Math.min(0.22, actor.rangedRecoilDeg * 0.025),
              16,
              delta
            );
            if (actor.model.rightElbow) {
              actor.model.rightElbow.rotation.x = THREE.MathUtils.damp(
                actor.model.rightElbow.rotation.x,
                -0.45,
                16,
                delta
              );
            }
            if (actor.loadout.hasShield) {
              actor.model.leftClawArm.rotation.x = THREE.MathUtils.damp(
                actor.model.leftClawArm.rotation.x,
                -0.68,
                12,
                delta
              );
            }
          } else if (distFromTarget > effectiveMeleeReach) {
            if (
              actor.clawAnimType === 'NONE' &&
              actor.profile.silhouette !== 'tank' &&
              !rangedSpec &&
              legSpeedMult > 0
            ) {
              actor.lungeCooldown -= delta;
              if (
                actor.lungeCooldown <= 0 &&
                distFromTarget > effectiveMeleeReach + 0.45 &&
                distFromTarget < (actor.profile.silhouette === 'brute' ? 6.0 : 5.0)
              ) {
                actor.lungeState = 'WINDUP';
                actor.lungeTimer = actor.profile.silhouette === 'brute' ? 0.16 : 0.22;
                actor.model.root.position.set(actor.x, 0, actor.z);
                actor.model.root.lookAt(combatTargetX, 0, combatTargetZ);
                continue;
              }
            }

            const viewDot =
              (-toTargetX * camFwdX + -toTargetZ * camFwdZ) / Math.max(0.01, distFromTarget);
            const isOutOfView = viewDot < 0.55;

            const isToughOrFast =
              actor.profile.silhouette === 'exo' ||
              actor.profile.silhouette === 'mech' ||
              actor.profile.silhouette === 'titan' ||
              actor.profile.silhouette === 'brute' ||
              actor.profile.silhouette === 'tank' ||
              isSwarmer;
            const isInterceptor = isToughOrFast && actor.uid % 3 === 1 && !coverGoalPos && !targetTurret;
            const playerTryingToRun =
              s.playerRunAnticipationTimer > 0 && (s.playerSpeed > 1.8 || isSprinting);

            let aimTargetX = coverGoalPos ? coverGoalPos.x : combatTargetX;
            let aimTargetZ = coverGoalPos ? coverGoalPos.z : combatTargetZ;
            let interceptActive = false;

            const encircleRange = isSwarmer ? 14.0 : 9.5;
            if (actor.doorSide === 'north' && actor.z < -117.5 && Math.abs(actor.x) > 4.0) {
              aimTargetX = 0;
              aimTargetZ = -116.5;
            } else if (coverGoalPos) {
              // Navigate directly toward selected safe cover position
              aimTargetX = coverGoalPos.x;
              aimTargetZ = coverGoalPos.z;
            } else if (isInterceptor && playerTryingToRun && distFromPlayer < 36.0) {
              interceptActive = true;
              const runLen = Math.max(0.01, s.playerSpeed);
              const runDirX = s.playerSpeed > 1.8 ? s.playerVelX / runLen : camFwdX;
              const runDirZ = s.playerSpeed > 1.8 ? s.playerVelZ / runLen : camFwdZ;
              const perpRunX = -runDirZ;
              const perpRunZ = runDirX;

              const spreadSlots = [-5.4, -2.8, 2.8, 5.4, -4.1, 4.1];
              const lateralSpread = spreadSlots[actor.uid % spreadSlots.length];
              const aheadDot = (actor.x - s.playerX) * runDirX + (actor.z - s.playerZ) * runDirZ;

              if (aheadDot < 2.2 || distFromPlayer > 11.5) {
                const leadDist = THREE.MathUtils.clamp(s.playerSpeed * 0.9 + 3.2, 6.2, 11.2);
                const rawCut = resolveRoomCollision2D(
                  s.playerX + runDirX * leadDist + perpRunX * lateralSpread,
                  s.playerZ + runDirZ * leadDist + perpRunZ * lateralSpread,
                  s.playerX,
                  s.playerZ,
                  0.65 * actor.profile.scaleXZ,
                  p.config.roomId,
                  collisionOpts
                );
                aimTargetX = rawCut.x;
                aimTargetZ = rawCut.z;
              } else if (distFromPlayer > 6.2) {
                const holdLead = Math.max(3.2, aheadDot * 0.72);
                const rawHold = resolveRoomCollision2D(
                  s.playerX + runDirX * holdLead + perpRunX * (lateralSpread * 0.72),
                  s.playerZ + runDirZ * holdLead + perpRunZ * (lateralSpread * 0.72),
                  s.playerX,
                  s.playerZ,
                  0.65 * actor.profile.scaleXZ,
                  p.config.roomId,
                  collisionOpts
                );
                aimTargetX = rawHold.x;
                aimTargetZ = rawHold.z;
              } else {
                const rawClose = resolveRoomCollision2D(
                  s.playerX + runDirX * 1.5 + perpRunX * (lateralSpread * 0.22),
                  s.playerZ + runDirZ * 1.5 + perpRunZ * (lateralSpread * 0.22),
                  s.playerX,
                  s.playerZ,
                  0.55 * actor.profile.scaleXZ,
                  p.config.roomId,
                  collisionOpts
                );
                aimTargetX = rawClose.x;
                aimTargetZ = rawClose.z;
              }
            } else if (distFromTarget < encircleRange) {
              const surroundR = Math.max(1.5, actor.meleeDist * (isSwarmer ? 1.15 : 0.82));
              const surroundBlend = THREE.MathUtils.clamp((encircleRange - distFromTarget) / 5.5, 0, 1);
              const flankAngle =
                isSwarmer && isOutOfView
                  ? Math.atan2(-camFwdZ, -camFwdX) + (actor.uid % 2 === 0 ? 0.75 : -0.75)
                  : actor.swarmAngle;
              aimTargetX += Math.cos(flankAngle) * surroundR * surroundBlend;
              aimTargetZ += Math.sin(flankAngle) * surroundR * surroundBlend;
            }

            const moveVecX = aimTargetX - actor.x;
            const moveVecZ = aimTargetZ - actor.z;
            const moveVecLen = Math.max(0.01, Math.hypot(moveVecX, moveVecZ));
            const dirX = moveVecX / moveVecLen;
            const dirZ = moveVecZ / moveVecLen;
            const perpX = -dirZ;
            const perpZ = dirX;

            const topMobility = actor.profile.maxSpeedMps ?? actor.profile.moveSpeedMps * 1.18;
            const corridorFarRush =
              p.config.roomId === 'corridor_01' && distFromTarget > 35 ? 2.1 : 1.0;
            const swarmerFlankBoost = isSwarmer && isOutOfView ? 1.28 : 1.0;
            const approachSpeed =
              (interceptActive || actor.isChargingStraight
                ? topMobility
                : actor.profile.moveSpeedMps * (distFromTarget < 7 ? 1.04 : 0.96)) *
              corridorFarRush *
              swarmerFlankBoost *
              combinedSpeedMult;
            const forwardStep = Math.min(
              interceptActive || coverGoalPos ? moveVecLen : distFromTarget - effectiveMeleeReach * 0.72,
              approachSpeed * delta
            );

            let latVel = 0;
            const pattern = p.config.approachPattern;
            if (pattern === 'STRAIGHT_CHARGE' || interceptActive || coverGoalPos) {
              actor.isChargingStraight = true;
              actor.vx = THREE.MathUtils.damp(actor.vx, 0, 9, delta);
            } else {
              actor.weavePhaseBreakTimer -= delta;
              if (actor.weavePhaseBreakTimer <= 0) {
                if (pattern === 'ADAPTIVE' && !isSwarmer && Math.random() < 0.42) {
                  actor.isChargingStraight = true;
                  actor.weavePhaseBreakTimer = 0.75 + Math.random() * 0.65;
                } else {
                  actor.isChargingStraight = false;
                  actor.weaveDirection = -actor.weaveDirection;
                  actor.weavePhaseBreakTimer = 0.42 + Math.random() * 0.85;
                }
              }

              if (!actor.isChargingStraight) {
                const targetLat =
                  actor.weaveDirection *
                  actor.profile.moveSpeedMps *
                  (isSwarmer ? 0.95 : 0.65) *
                  legSpeedMult;
                actor.vx = THREE.MathUtils.damp(actor.vx, targetLat, 9, delta);
                latVel = actor.vx;
              } else {
                actor.vx = THREE.MathUtils.damp(actor.vx, 0, 9, delta);
              }
            }

            if (legSpeedMult > 0) {
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
              if (actor.model.leftKnee) {
                actor.model.leftKnee.rotation.x = Math.max(0.06, -Math.sin(actor.stridePhase - 0.5) * 0.64);
              }
              if (actor.model.rightKnee) {
                actor.model.rightKnee.rotation.x = Math.max(0.06, Math.sin(actor.stridePhase - 0.5) * 0.64);
              }
              actor.model.bodyGroup.position.y = Math.abs(Math.sin(actor.stridePhase)) * 0.08;
            } else {
              actor.model.leftLeg.rotation.x = THREE.MathUtils.damp(actor.model.leftLeg.rotation.x, 0, 10, delta);
              actor.model.rightLeg.rotation.x = THREE.MathUtils.damp(actor.model.rightLeg.rotation.x, 0, 10, delta);
              actor.model.bodyGroup.position.y = THREE.MathUtils.damp(actor.model.bodyGroup.position.y, -0.1, 10, delta);
            }

            actor.model.leftClawArm.rotation.x = THREE.MathUtils.damp(
              actor.model.leftClawArm.rotation.x,
              actor.loadout.hasShield ? -0.62 : -Math.sin(actor.stridePhase) * 0.35,
              14,
              delta
            );
            actor.model.rightClawArm.rotation.x = THREE.MathUtils.damp(
              actor.model.rightClawArm.rotation.x,
              rangedSpec ? -1.08 + Math.sin(actor.stridePhase) * 0.03 : Math.sin(actor.stridePhase) * 0.35,
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
            if (actor.model.leftElbow) {
              actor.model.leftElbow.rotation.x = THREE.MathUtils.damp(
                actor.model.leftElbow.rotation.x,
                actor.loadout.hasShield ? -0.35 : -0.45 - Math.sin(actor.stridePhase) * 0.16,
                14,
                delta
              );
            }
            if (actor.model.rightElbow) {
              actor.model.rightElbow.rotation.x = THREE.MathUtils.damp(
                actor.model.rightElbow.rotation.x,
                rangedSpec ? -0.45 : -0.45 + Math.sin(actor.stridePhase) * 0.16,
                14,
                delta
              );
            }
            actor.model.root.rotation.z = THREE.MathUtils.damp(
              actor.model.root.rotation.z,
              -actor.vx * 0.025,
              8,
              delta
            );
          } else {
            // In Melee Range (with melee weapon profiles: Long Sword, Great Sword, Halberd, or Claws)
            if ((sepX !== 0 || sepZ !== 0) && legSpeedMult > 0) {
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
            if (actor.model.leftKnee) {
              actor.model.leftKnee.rotation.x = THREE.MathUtils.damp(
                actor.model.leftKnee.rotation.x,
                0.08,
                10,
                delta
              );
            }
            if (actor.model.rightKnee) {
              actor.model.rightKnee.rotation.x = THREE.MathUtils.damp(
                actor.model.rightKnee.rotation.x,
                0.08,
                10,
                delta
              );
            }
            actor.model.bodyGroup.position.y = THREE.MathUtils.damp(
              actor.model.bodyGroup.position.y,
              0,
              10,
              delta
            );

            const atkMult = actor.profile.attackSpeedMult * armMeleeSpeedMult;
            const specMult = actor.profile.specialAttackSpeedMult * armMeleeSpeedMult;
            const meleeSpec =
              actor.loadout.meleeWeaponId && !comp.armsDestroyed.rightArm
                ? ENEMY_WEAPONS[actor.loadout.meleeWeaponId]
                : null;
            const canSwingLeft = !comp.armsDestroyed.leftArm && !actor.loadout.hasShield;
            const canSwingRight = !comp.armsDestroyed.rightArm;

            if (actor.clawAnimType === 'NONE') {
              actor.model.leftClawArm.rotation.x = THREE.MathUtils.damp(
                actor.model.leftClawArm.rotation.x,
                actor.loadout.hasShield ? -0.62 : 0,
                12,
                delta
              );
              actor.model.rightClawArm.rotation.x = THREE.MathUtils.damp(
                actor.model.rightClawArm.rotation.x,
                activeRangedSpec ? -1.12 : 0,
                14,
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
              actor.model.rightClawArm.rotation.y = THREE.MathUtils.damp(
                actor.model.rightClawArm.rotation.y,
                0,
                12,
                delta
              );
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
              if (actor.model.leftElbow) {
                actor.model.leftElbow.rotation.x = THREE.MathUtils.damp(
                  actor.model.leftElbow.rotation.x,
                  actor.loadout.hasShield ? -0.35 : -0.45,
                  12,
                  delta
                );
              }
              if (actor.model.rightElbow) {
                actor.model.rightElbow.rotation.x = THREE.MathUtils.damp(
                  actor.model.rightElbow.rotation.x,
                  -0.45,
                  14,
                  delta
                );
              }

              actor.attackCooldown -= delta;
              if (actor.attackCooldown <= 0 && (canSwingLeft || canSwingRight)) {
                actor.attackCount += 1;
                if (meleeSpec && canSwingRight) {
                  actor.clawAnimType = 'RIGHT';
                  actor.clawAnimPhase = 0;
                  actor.singleStrikeExecuted = false;
                  soundEngine.playEnemyAttack(meleeSpec.id === 'enemy_great_sword');
                } else if (actor.attackCount % 3 === 0 && canSwingLeft && canSwingRight) {
                  actor.clawAnimType = 'DUAL_WINDUP';
                  actor.clawAnimPhase = 0;
                  actor.dualStrikeExecuted = false;
                } else {
                  const nextSide: 'LEFT' | 'RIGHT' =
                    canSwingLeft && canSwingRight
                      ? actor.attackCount % 2 === 0
                        ? 'LEFT'
                        : 'RIGHT'
                      : canSwingRight
                        ? 'RIGHT'
                        : 'LEFT';
                  actor.clawAnimType = nextSide;
                  actor.clawAnimPhase = 0;
                  actor.singleStrikeExecuted = false;
                  soundEngine.playEnemyAttack(false);
                }
              }
            } else if (meleeSpec && actor.clawAnimType === 'RIGHT') {
              // Energetic multi-joint Sword / Great Sword / Halberd Animations with hip twist, footwork & counterbalance
              const baseRate =
                meleeSpec.id === 'enemy_long_sword'
                  ? 3.1
                  : meleeSpec.id === 'enemy_great_sword'
                    ? 1.45
                    : 2.25;
              actor.clawAnimPhase += delta * baseRate * atkMult;
              const pNorm = Math.min(1, actor.clawAnimPhase);
              const swing = Math.sin(pNorm * Math.PI);
              const windup = Math.max(0, 1 - pNorm / 0.28);
              const strikeT = THREE.MathUtils.clamp((pNorm - 0.22) / 0.45, 0, 1);
              const snap = Math.sin(strikeT * Math.PI * 0.5);
              const rArm = actor.model.rightClawArm;
              const rElbow = actor.model.rightElbow;
              const lArm = actor.model.leftClawArm;

              if (meleeSpec.id === 'enemy_long_sword') {
                // Quick back-coil -> lunging forward diagonal slash & wrist snap thrust
                rArm.rotation.x = 0.45 * windup - snap * 1.95 + (1 - swing) * 0.15;
                rArm.rotation.z = 0.48 - pNorm * 0.92;
                rArm.rotation.y = 0.35 - pNorm * 0.72;
                if (rElbow) rElbow.rotation.x = -1.05 * windup - 0.18 + snap * 0.22;
                lArm.rotation.x = actor.loadout.hasShield ? -0.68 - swing * 0.22 : 0.45 * swing;
                actor.model.bodyGroup.rotation.x = -0.14 * windup + swing * 0.34;
                actor.model.bodyGroup.rotation.y = 0.38 * windup - strikeT * 0.68;
                actor.model.bodyGroup.position.y = -0.06 * windup + swing * 0.08;
                actor.model.rightLeg.rotation.x = -swing * 0.36;
                actor.model.leftLeg.rotation.x = swing * 0.38;
              } else if (meleeSpec.id === 'enemy_great_sword') {
                // Full-body windup coil -> heavy wide horizontal cleave with hip & knee weight transfer
                const sweepDir = actor.attackCount % 2 === 0 ? 1 : -1;
                const cleave = THREE.MathUtils.smoothstep(pNorm, 0.18, 0.78);
                rArm.rotation.x = -0.78 - Math.sin(cleave * Math.PI) * 0.48;
                rArm.rotation.z = sweepDir * (-1.35 + cleave * 2.7);
                rArm.rotation.y = sweepDir * (-1.05 + cleave * 2.1);
                if (rElbow) rElbow.rotation.x = -0.35 + Math.sin(cleave * Math.PI) * 0.28;
                lArm.rotation.x = actor.loadout.hasShield ? -0.72 + sweepDir * 0.2 : 0.35 * swing;
                actor.model.bodyGroup.rotation.y = sweepDir * (-0.48 + cleave * 0.98);
                actor.model.bodyGroup.rotation.z = -sweepDir * Math.sin(cleave * Math.PI) * 0.14;
                actor.model.bodyGroup.rotation.x = Math.sin(cleave * Math.PI) * 0.24;
                actor.model.bodyGroup.position.y = -Math.sin(cleave * Math.PI) * 0.1;
                actor.model.leftLeg.rotation.x = sweepDir * Math.sin(cleave * Math.PI) * 0.32;
                actor.model.rightLeg.rotation.x = -sweepDir * Math.sin(cleave * Math.PI) * 0.32;
              } else {
                // Halberd 3-hit martial combo (18 / 26 / 42 DMG) with sweeping torso & leaping slam
                const step = actor.meleeComboIdx % 3;
                const cleave = THREE.MathUtils.smoothstep(pNorm, 0.12, 0.8);
                if (step === 0) {
                  rArm.rotation.x = -1.08;
                  rArm.rotation.z = -1.2 + cleave * 2.4;
                  rArm.rotation.y = -0.9 + cleave * 1.8;
                  actor.model.bodyGroup.rotation.y = -0.38 + cleave * 0.78;
                  actor.model.bodyGroup.rotation.x = swing * 0.22;
                } else if (step === 1) {
                  rArm.rotation.x = -1.18;
                  rArm.rotation.z = 1.2 - cleave * 2.4;
                  rArm.rotation.y = 0.9 - cleave * 1.8;
                  actor.model.bodyGroup.rotation.y = 0.38 - cleave * 0.78;
                  actor.model.bodyGroup.rotation.x = swing * 0.24;
                } else {
                  rArm.rotation.x = -2.25 + cleave * 2.85;
                  rArm.rotation.z = 0;
                  rArm.rotation.y = 0;
                  actor.model.bodyGroup.rotation.x = -0.22 * (1 - cleave) + swing * 0.38;
                  actor.model.bodyGroup.position.y = Math.sin(pNorm * Math.PI) * 0.22;
                }
                if (rElbow) rElbow.rotation.x = -0.38 + swing * 0.32;
                lArm.rotation.x = actor.loadout.hasShield ? -0.68 : 0.32 * swing;
                actor.model.leftLeg.rotation.x = swing * 0.28;
                actor.model.rightLeg.rotation.x = -swing * 0.28;
              }

              if (actor.clawAnimPhase >= 0.45 && !actor.singleStrikeExecuted) {
                actor.singleStrikeExecuted = true;
                const missedByHead = headCapBroken && Math.random() < 0.55;
                if (!missedByHead) {
                  const baseDmg = meleeSpec.comboDamages
                    ? meleeSpec.comboDamages[actor.meleeComboIdx % meleeSpec.comboDamages.length]
                    : meleeSpec.damage;
                  const finalDmg = Math.max(1, Math.round(baseDmg * armMeleeDmgMult));
                  for (let ti = s.turrets.length - 1; ti >= 0; ti--) {
                    const tur = s.turrets[ti];
                    if (
                      Math.hypot(tur.pos.x - actor.x, tur.pos.z - actor.z) <=
                      effectiveMeleeReach + 0.95
                    ) {
                      damageDeployableTurret(tur, finalDmg);
                    }
                  }
                  if (
                    p.playerHp > 0 &&
                    (!targetTurret || distFromPlayer <= effectiveMeleeReach + 0.9)
                  ) {
                    s.cameraShake = Math.max(
                      s.cameraShake,
                      meleeSpec.id === 'enemy_great_sword' ? 0.95 : 0.6
                    );
                    s.playerHitSlowTimer = Math.max(s.playerHitSlowTimer, 0.45);
                    setDamageFlashAlpha(0.45);
                    p.onEnemyWeaponAttack(
                      'ENEMY_MELEE',
                      finalDmg,
                      actor.profile.name,
                      meleeSpec.name,
                      Math.max(1, Math.round(distFromPlayer))
                    );
                  }
                }
                if (meleeSpec.comboDamages) {
                  actor.meleeComboIdx = (actor.meleeComboIdx + 1) % meleeSpec.comboDamages.length;
                }
                if (isSwarmer) {
                  actor.retreatTimer = 1.65 + Math.random() * 0.75;
                  actor.weaveDirection = -actor.weaveDirection;
                }
              }

              if (actor.clawAnimPhase >= 1.0) {
                rArm.rotation.set(0, 0, 0);
                if (rElbow) rElbow.rotation.x = -0.45;
                actor.model.bodyGroup.rotation.set(0, 0, 0);
                actor.model.bodyGroup.position.y = 0;
                actor.clawAnimType = 'NONE';
                actor.attackCooldown =
                  (meleeSpec.id === 'enemy_long_sword'
                    ? 0.92
                    : meleeSpec.id === 'enemy_great_sword'
                      ? 1.55
                      : 1.18) / atkMult;
              }
            } else if (actor.clawAnimType === 'LEFT' || actor.clawAnimType === 'RIGHT') {
              actor.clawAnimPhase += delta * 3.0 * atkMult;
              const pNorm = Math.min(1, actor.clawAnimPhase);
              const swing = Math.sin(pNorm * Math.PI);
              const isLeft = actor.clawAnimType === 'LEFT';
              const sign = isLeft ? -1 : 1;
              const arm = isLeft ? actor.model.leftClawArm : actor.model.rightClawArm;
              const offArm = isLeft ? actor.model.rightClawArm : actor.model.leftClawArm;
              const elbow = isLeft ? actor.model.leftElbow : actor.model.rightElbow;
              arm.rotation.x = -swing * 1.68;
              arm.rotation.z = sign * swing * 0.52;
              arm.rotation.y = -sign * swing * 0.42;
              if (!rangedSpec && !(isLeft === false && actor.loadout.hasShield)) {
                offArm.rotation.x = swing * 0.48;
              }
              actor.model.bodyGroup.rotation.y = sign * (0.28 - pNorm * 0.62);
              actor.model.bodyGroup.rotation.x = swing * 0.24;
              actor.model.leftLeg.rotation.x = -sign * swing * 0.3;
              actor.model.rightLeg.rotation.x = sign * swing * 0.3;
              if (elbow) elbow.rotation.x = -0.55 + swing * 0.42;

              if (actor.clawAnimPhase >= 0.45 && !actor.singleStrikeExecuted) {
                actor.singleStrikeExecuted = true;
                const missedByHead = headCapBroken && Math.random() < 0.55;
                if (!missedByHead) {
                  const finalDmg = Math.max(1, Math.round(actor.profile.clawDamage * armMeleeDmgMult));
                  for (let ti = s.turrets.length - 1; ti >= 0; ti--) {
                    const tur = s.turrets[ti];
                    if (
                      Math.hypot(tur.pos.x - actor.x, tur.pos.z - actor.z) <=
                      effectiveMeleeReach + 0.95
                    ) {
                      damageDeployableTurret(tur, finalDmg);
                    }
                  }
                  if (
                    p.playerHp > 0 &&
                    (!targetTurret || distFromPlayer <= effectiveMeleeReach + 0.9)
                  ) {
                    s.cameraShake = Math.max(s.cameraShake, 0.55);
                    s.playerHitSlowTimer = Math.max(s.playerHitSlowTimer, 0.55);
                    setDamageFlashAlpha(0.45);
                    p.onEnemyClawAttack(false, finalDmg, actor.profile.name);
                  }
                }
                if (isSwarmer) {
                  actor.retreatTimer = 1.65 + Math.random() * 0.75;
                  actor.weaveDirection = -actor.weaveDirection;
                }
              }
              if (actor.clawAnimPhase >= 1.0) {
                arm.rotation.set(0, 0, 0);
                if (elbow) elbow.rotation.x = -0.45;
                actor.model.bodyGroup.rotation.set(0, 0, 0);
                actor.clawAnimType = 'NONE';
                actor.attackCooldown = 1.18 / atkMult;
              }
            } else if (actor.clawAnimType === 'DUAL_WINDUP') {
              actor.clawAnimPhase += delta * 1.9 * specMult;
              const raise = Math.min(1, actor.clawAnimPhase);
              actor.model.leftClawArm.rotation.x = -raise * 1.55;
              actor.model.rightClawArm.rotation.x = -raise * 1.55;
              actor.model.leftClawArm.rotation.z = raise * 0.48;
              actor.model.rightClawArm.rotation.z = -raise * 0.48;
              actor.model.bodyGroup.rotation.x = -raise * 0.22;
              actor.model.bodyGroup.position.y = raise * 0.14;
              if (actor.model.leftElbow) actor.model.leftElbow.rotation.x = -0.45 - raise * 0.45;
              if (actor.model.rightElbow) actor.model.rightElbow.rotation.x = -0.45 - raise * 0.45;
              if (actor.clawAnimPhase >= 1.0) {
                actor.clawAnimType = 'DUAL_STRIKE';
                actor.clawAnimPhase = 0;
                soundEngine.playEnemyAttack(true);
              }
            } else if (actor.clawAnimType === 'DUAL_STRIKE') {
              actor.clawAnimPhase += delta * 4.1 * specMult;
              const slam = Math.min(1, actor.clawAnimPhase);
              actor.model.leftClawArm.rotation.x = -1.55 + slam * 2.35;
              actor.model.rightClawArm.rotation.x = -1.55 + slam * 2.35;
              actor.model.leftClawArm.rotation.z = (1 - slam) * 0.48;
              actor.model.rightClawArm.rotation.z = -(1 - slam) * 0.48;
              actor.model.bodyGroup.rotation.x = -0.22 + slam * 0.56;
              actor.model.bodyGroup.position.y = 0.14 - slam * 0.24;
              if (actor.model.leftElbow) actor.model.leftElbow.rotation.x = -0.9 + slam * 0.72;
              if (actor.model.rightElbow) actor.model.rightElbow.rotation.x = -0.9 + slam * 0.72;

              if (actor.clawAnimPhase >= 0.35 && !actor.dualStrikeExecuted) {
                actor.dualStrikeExecuted = true;
                const missedByHead = headCapBroken && Math.random() < 0.55;
                if (!missedByHead) {
                  const finalDmg = Math.max(1, Math.round(actor.profile.dualClawDamage * armMeleeDmgMult));
                  for (let ti = s.turrets.length - 1; ti >= 0; ti--) {
                    const tur = s.turrets[ti];
                    if (
                      Math.hypot(tur.pos.x - actor.x, tur.pos.z - actor.z) <=
                      effectiveMeleeReach + 0.95
                    ) {
                      damageDeployableTurret(tur, finalDmg);
                    }
                  }
                  if (
                    p.playerHp > 0 &&
                    (!targetTurret || distFromPlayer <= effectiveMeleeReach + 0.9)
                  ) {
                    s.cameraShake = Math.max(s.cameraShake, 1.25);
                    s.playerHitSlowTimer = Math.max(s.playerHitSlowTimer, 0.85);
                    setDamageFlashAlpha(0.75);
                    p.onEnemyClawAttack(true, finalDmg, actor.profile.name);
                  }
                }
                if (isSwarmer) {
                  actor.retreatTimer = 1.85 + Math.random() * 0.75;
                  actor.weaveDirection = -actor.weaveDirection;
                }
              }
              if (actor.clawAnimPhase >= 1.0) {
                actor.model.leftClawArm.rotation.set(0, 0, 0);
                actor.model.rightClawArm.rotation.set(0, 0, 0);
                actor.model.bodyGroup.rotation.set(0, 0, 0);
                actor.model.bodyGroup.position.y = 0;
                if (actor.model.leftElbow) actor.model.leftElbow.rotation.x = -0.45;
                if (actor.model.rightElbow) actor.model.rightElbow.rotation.x = -0.45;
                actor.clawAnimType = 'NONE';
                actor.attackCooldown = 1.45 / specMult;
              }
            }
          }

          actor.model.root.position.set(actor.x, 0, actor.z);
          actor.model.root.rotation.x = 0;
          actor.model.root.lookAt(combatTargetX, 0, combatTargetZ);
        }

        // Helper for 1m drop-radius rocket pod / misfire explosions
        const triggerEnemyRocketExplosion = (
          impactPos: THREE.Vector3,
          proj: DroneProjectile,
          directHit?: { kind: 'PLAYER' | 'TURRET' | 'ENEMY' | 'COVER'; actor?: EnemyActor; turret?: DeployableTurret3D; cov?: BreakableCover3D }
        ) => {
          const r = proj.splashRadiusM ?? 0;
          if (r <= 0) return;
          spawnExplosionRing(impactPos.x, Math.max(0.18, impactPos.y), impactPos.z, 0xff6a00, r * 1.4);
          soundEngine.playGrenadeExplode();

          // Splash damage to player with linear distance drop over 1m radius
          if (p.playerHp > 0 && directHit?.kind !== 'PLAYER') {
            const dp = Math.hypot(impactPos.x - s.playerX, impactPos.y - 1.15, impactPos.z - s.playerZ);
            if (dp < r) {
              const factor = THREE.MathUtils.clamp(1 - dp / r, 0, 1);
              const splashDmg = Math.max(1, Math.round(proj.damage * factor));
              setDamageFlashAlpha((prev) => Math.max(prev, 0.22));
              p.onEnemyWeaponAttack(
                'ENEMY_RANGED',
                splashDmg,
                proj.attackerName,
                'Rocket Splash (1m)',
                Math.max(1, Math.round(Math.hypot(impactPos.x - s.playerX, impactPos.z - s.playerZ)))
              );
            }
          }

          // Splash damage to turrets
          for (let ti = s.turrets.length - 1; ti >= 0; ti--) {
            const tur = s.turrets[ti];
            if (directHit?.turret === tur) continue;
            const dt = Math.hypot(impactPos.x - tur.pos.x, impactPos.y - tur.pos.y, impactPos.z - tur.pos.z);
            if (dt < r + 0.35) {
              const factor = THREE.MathUtils.clamp(1 - dt / (r + 0.35), 0, 1);
              damageDeployableTurret(tur, Math.max(1, Math.round(proj.damage * factor)));
            }
          }

          // Splash damage to covers
          for (const cov of currentRoom.covers) {
            if (cov.broken || directHit?.cov === cov) continue;
            const dc = Math.hypot(impactPos.x - cov.x, impactPos.z - cov.z);
            if (dc < r + 0.6) {
              const factor = THREE.MathUtils.clamp(1 - dc / (r + 0.6), 0, 1);
              damageCover(cov, Math.max(1, Math.round(proj.damage * 2.0 * factor)));
            }
          }

          // Splash damage to enemies when projectile came from a misfired pod
          if (proj.canHitEnemies) {
            for (const actor of s.enemies) {
              if (!actor.alive || directHit?.actor === actor) continue;
              const de = Math.hypot(impactPos.x - actor.x, impactPos.z - actor.z);
              if (de < r + 0.4 * actor.profile.scaleXZ) {
                const factor = THREE.MathUtils.clamp(1 - de / (r + 0.4 * actor.profile.scaleXZ), 0, 1);
                const eDmg = Math.max(1, Math.round(proj.damage * factor));
                const out = applyDamageAndStagger(actor, Math.max(0, actor.hp - eDmg), 6);
                applyComponentHit(actor, 'torso', impactPos.y, eDmg, false, out.killed);
                pushHitVisuals(eDmg, false, out.killed, out.triggeredStagger, 0, {
                  x: actor.x,
                  y: actor.profile.scaleY * 1.4,
                  z: actor.z,
                });
              }
            }
            checkSquadCleared();
          }
        };

        // Advance Enemy Projectiles (Ranged Firearms, Homing ATGM Missiles, & Brute Rockets)
        for (let i = s.droneProjectiles.length - 1; i >= 0; i--) {
          const proj = s.droneProjectiles[i];
          proj.life -= delta;
          if (proj.ignoreSelfSec && proj.ignoreSelfSec > 0) {
            proj.ignoreSelfSec = Math.max(0, proj.ignoreSelfSec - delta);
          }

          if (proj.isHoming && (p.playerHp > 0 || s.turrets.length > 0) && (proj.turnRateRad ?? 0) > 0) {
            const spd = proj.speedMps ?? Math.max(1, Math.hypot(proj.vx, proj.vy, proj.vz));
            const curDir = _vec3A.set(proj.vx, proj.vy, proj.vz).normalize();
            let htx = s.playerX;
            let hty = 1.38;
            let htz = s.playerZ;
            if (s.turrets.length > 0) {
              let bestTur: DeployableTurret3D | null = null;
              let bestSq = Infinity;
              for (const tur of s.turrets) {
                if (tur.hp <= 0) continue;
                const dSq =
                  (tur.pos.x - proj.mesh.position.x) ** 2 +
                  (tur.pos.z - proj.mesh.position.z) ** 2;
                if (dSq < bestSq) {
                  bestSq = dSq;
                  bestTur = tur;
                }
              }
              if (bestTur) {
                htx = bestTur.pos.x;
                hty = bestTur.pos.y;
                htz = bestTur.pos.z;
              }
            }
            const wantDir = _vec3B
              .set(htx - proj.mesh.position.x, hty - proj.mesh.position.y, htz - proj.mesh.position.z)
              .normalize();
            const maxTurn = (proj.turnRateRad ?? 1.42) * delta;
            const dot = THREE.MathUtils.clamp(curDir.dot(wantDir), -1, 1);
            const ang = Math.acos(dot);
            if (ang > 0.001) {
              const t = Math.min(1, maxTurn / ang);
              curDir.lerp(wantDir, t).normalize();
              proj.vx = curDir.x * spd;
              proj.vy = curDir.y * spd;
              proj.vz = curDir.z * spd;
            }
          }

          proj.vy -= proj.gravity * delta;
          const prevPos = _vec3A.copy(proj.mesh.position);
          const nextPos = _vec3B.set(
            prevPos.x + proj.vx * delta,
            prevPos.y + proj.vy * delta,
            prevPos.z + proj.vz * delta
          );
          const stepVec = _vec3C.subVectors(nextPos, prevPos);
          const stepLen = stepVec.length();

          let remove = proj.life <= 0 || nextPos.y <= 0.05;
          let hitSplashTarget:
            | { kind: 'PLAYER' | 'TURRET' | 'ENEMY' | 'COVER'; actor?: EnemyActor; turret?: DeployableTurret3D; cov?: BreakableCover3D }
            | undefined;

          if (!remove && stepLen > 0.001) {
            raycaster.set(prevPos, stepVec.divideScalar(stepLen));
            const envHits = raycaster.intersectObjects(envBlockers, false);
            if (envHits.length > 0 && envHits[0].distance <= stepLen + 0.08) {
              const hit = envHits[0];
              const normal = hit.face
                ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize()
                : null;
              if (hit.object.userData.isCover) {
                const cov = currentRoom.covers.find((c) => c.id === hit.object.userData.coverId);
                if (cov && !cov.broken) {
                  damageCover(cov, Math.max(4, Math.round(proj.damage * 2.5)));
                  hitSplashTarget = { kind: 'COVER', cov };
                }
                spawnBulletImpact(hit.point, normal, 'COVER');
              } else {
                spawnBulletImpact(hit.point, normal, 'ENV');
              }
              nextPos.copy(hit.point);
              remove = true;
            }
          }

          proj.mesh.position.copy(nextPos);

          if (
            !remove &&
            p.config.roomId === 'double_flank_02' &&
            !isPointInPolygon2D(proj.mesh.position.x, proj.mesh.position.z, DOUBLE_FLANK_POLYGON)
          ) {
            remove = true;
          }

          // Misfired pod projectiles can directly impact alive enemies
          if (!remove && proj.canHitEnemies) {
            for (const actor of s.enemies) {
              if (!actor.alive) continue;
              if (actor.uid === proj.sourceActorUid && (proj.ignoreSelfSec ?? 0) > 0) continue;
              const edx = proj.mesh.position.x - actor.x;
              const edz = proj.mesh.position.z - actor.z;
              const maxR = 0.58 * actor.profile.scaleXZ;
              if (
                edx * edx + edz * edz <= maxR * maxR &&
                proj.mesh.position.y >= 0.05 &&
                proj.mesh.position.y <= actor.profile.scaleY * 2.15
              ) {
                remove = true;
                hitSplashTarget = { kind: 'ENEMY', actor };
                const eDmg = Math.max(1, Math.round(proj.damage));
                const out = applyDamageAndStagger(actor, Math.max(0, actor.hp - eDmg), 8);
                applyComponentHit(actor, 'torso', proj.mesh.position.y, eDmg, false, out.killed);
                pushHitVisuals(eDmg, false, out.killed, out.triggeredStagger, 0, {
                  x: actor.x,
                  y: Math.max(0.5, proj.mesh.position.y),
                  z: actor.z,
                });
                spawnBulletImpact(proj.mesh.position, null, 'ENEMY');
                checkSquadCleared();
                break;
              }
            }
          }

          if (!remove && s.turrets.length > 0) {
            for (let ti = s.turrets.length - 1; ti >= 0; ti--) {
              const tur = s.turrets[ti];
              const tdx = proj.mesh.position.x - tur.pos.x;
              const tdy = proj.mesh.position.y - tur.pos.y;
              const tdz = proj.mesh.position.z - tur.pos.z;
              if (tdx * tdx + tdy * tdy + tdz * tdz <= 0.64) {
                remove = true;
                hitSplashTarget = { kind: 'TURRET', turret: tur };
                damageDeployableTurret(tur, Math.max(1, Math.round(proj.damage)));
                break;
              }
            }
          }

          if (!remove && p.playerHp > 0) {
            const dx = proj.mesh.position.x - s.playerX;
            const dy = proj.mesh.position.y - 1.35;
            const dz = proj.mesh.position.z - s.playerZ;
            if (dx * dx + dy * dy + dz * dz <= 0.42) {
              remove = true;
              hitSplashTarget = { kind: 'PLAYER' };
              setDamageFlashAlpha((prev) => Math.max(prev, 0.24));
              if (proj.sourceWeaponId && proj.sourceWeaponId !== 'enemy_atgm') {
                p.onEnemyWeaponAttack(
                  'ENEMY_RANGED',
                  proj.damage,
                  proj.attackerName,
                  ENEMY_WEAPONS[proj.sourceWeaponId]?.name ?? 'Ranged Fire',
                  Math.max(1, Math.round(Math.hypot(proj.mesh.position.x - s.playerX, proj.mesh.position.z - s.playerZ)))
                );
              } else {
                p.onEnemyDroneShot(proj.damage, proj.attackerName);
              }
            }
          }

          if (remove) {
            if ((proj.splashRadiusM ?? 0) > 0) {
              triggerEnemyRocketExplosion(proj.mesh.position, proj, hitSplashTarget);
            }
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

        // Advance Thrown Grenades (3.0s cook-off fuse, bounces off walls/floor/enemies, 18 direct impact DMG for incendiary)
        for (let i = s.thrownGrenades.length - 1; i >= 0; i--) {
          const g = s.thrownGrenades[i];
          g.fuseTimer -= delta;

          g.vy -= 16.5 * delta;
          const nextX = g.mesh.position.x + g.vx * delta;
          let nextY = g.mesh.position.y + g.vy * delta;
          const nextZ = g.mesh.position.z + g.vz * delta;

          // Bounce off walls & covers
          const clampedPos = resolveRoomCollision2D(
            nextX,
            nextZ,
            g.mesh.position.x,
            g.mesh.position.z,
            0.18,
            p.config.roomId,
            {
              isPlayer: false,
              westDoorBroken: currentRoom.westDoor?.broken ?? true,
              eastDoorBroken: currentRoom.eastDoor?.broken ?? true,
              northDoorBroken: currentRoom.northDoor?.broken ?? true,
              covers: currentRoom.covers,
            }
          );
          if (Math.hypot(clampedPos.x - nextX, clampedPos.z - nextZ) > 0.04) {
            g.vx *= -0.45;
            g.vz *= -0.45;
          }

          // Floor bounce (never detonate early on impact)
          if (nextY <= 0.14) {
            nextY = 0.14;
            g.vy = Math.abs(g.vy) > 1.2 ? Math.abs(g.vy) * 0.42 : 0;
            g.vx *= 0.72;
            g.vz *= 0.72;
            g.bounced = true;
          }

          g.mesh.position.set(clampedPos.x, nextY, clampedPos.z);
          if (Math.abs(g.vx) + Math.abs(g.vz) + Math.abs(g.vy) > 0.35) {
            g.mesh.rotation.x += delta * 11;
            g.mesh.rotation.z += delta * 7;
          }

          // Enemy impact bounce & single-target 18 DMG for Incendiary (no AoE on impact)
          for (const actor of s.enemies) {
            if (!actor.alive) continue;
            const ed = Math.hypot(actor.x - clampedPos.x, actor.z - clampedPos.z);
            if (ed < 0.78 * actor.profile.scaleXZ && nextY < actor.profile.scaleY * 2.15) {
              if (!g.impactedActorUids.has(actor.uid)) {
                g.impactedActorUids.add(actor.uid);
                if (g.profile.id === 'incendiary') {
                  const hitHead = Math.abs(nextY - actor.model.weakspotHeight) <= 0.48;
                  const zone: HitZoneId = hitHead ? 'weakspot' : 'torso';
                  const zoneMult = computeConsumableZoneMult(g.profile, actor, zone);
                  const impDmg = Math.max(1, Math.round((g.profile.impactDamage ?? 18) * zoneMult));
                  const nextHp = Math.max(0, actor.hp - impDmg);
                  const outcome = applyDamageAndStagger(actor, nextHp, 10, 0.5);
                  applyComponentHit(actor, hitHead ? 'head' : 'torso', nextY, impDmg, hitHead);
                  pushHitVisuals(impDmg, hitHead, outcome.killed, outcome.triggeredStagger, 0, {
                    x: actor.x,
                    y: Math.max(0.5, nextY),
                    z: actor.z,
                  });
                  p.onGrenadeImpactLog({
                    grenade: g.profile,
                    targetName: actor.profile.name,
                    zoneLabel: 'Direct Impact (No AoE)',
                    hpDamage: impDmg,
                    isKill: outcome.killed,
                    isStagger: outcome.triggeredStagger,
                    distanceM: Math.max(1, Math.round(Math.hypot(actor.x - s.playerX, actor.z - s.playerZ))),
                    enemyTtkMs: outcome.enemyTtkMs,
                    affectedTargets: [
                      {
                        enemyUid: actor.encounterId,
                        targetId: actor.profile.id,
                        targetName: actor.profile.name,
                        targetCode: actor.profile.code,
                        silhouette: actor.profile.silhouette,
                        waveNumber: p.waveNumber,
                        hpDamage: impDmg,
                        isKill: outcome.killed,
                        enemyTtkMs: outcome.enemyTtkMs,
                      },
                    ],
                  });
                  checkSquadCleared();
                }
                // Deflect/bounce canister off enemy hull
                const nx = clampedPos.x - actor.x;
                const nz = clampedPos.z - actor.z;
                const nLen = Math.max(0.01, Math.hypot(nx, nz));
                g.vx = (nx / nLen) * Math.max(2.5, Math.hypot(g.vx, g.vz) * 0.35);
                g.vz = (nz / nLen) * Math.max(2.5, Math.hypot(g.vx, g.vz) * 0.35);
                g.vy = Math.max(1.8, Math.abs(g.vy) * 0.45);
                soundEngine.playHitArmor();
              }
              break;
            }
          }

          if (g.fuseTimer <= 0) {
            const detY = Math.max(0.25, g.mesh.position.y);
            detonateGrenadeAt(g.profile, g.mesh.position.x, detY, g.mesh.position.z);
            scene.remove(g.mesh);
            disposeObject3D(g.mesh);
            s.thrownGrenades.splice(i, 1);
          }
        }

        // Advance Active Incendiary Fire Pools (64 DoT scaled by armor + +20% mobility boost)
        if (s.incendiaryZones.length > 0) {
          const incProfile = getGrenadeById('incendiary', p.grenades);
          let anyEnemyBurned = false;
          for (const actor of s.enemies) {
            if (!actor.alive) continue;
            let bestZone: IncendiaryZone3D | null = null;
            for (const z of s.incendiaryZones) {
              const d = Math.hypot(actor.x - z.x, actor.z - z.z);
              if (d <= z.radius + 0.5 * actor.profile.scaleXZ) {
                bestZone = z;
                break;
              }
            }
            if (bestZone) {
              actor.burnSlowTimer = Math.max(actor.burnSlowTimer, 0.65);
              if (actor.burnCooldown <= 0) {
                actor.burnCooldown = 0.45;
                anyEnemyBurned = true;
                const zoneMult = computeConsumableZoneMult(incProfile, actor, 'torso');
                const burnDmg = Math.max(1, Math.round(bestZone.dotDamage * zoneMult));
                const nextHp = Math.max(0, actor.hp - burnDmg);
                const outcome = applyDamageAndStagger(actor, nextHp, 0);
                pushHitVisuals(burnDmg, false, outcome.killed, false, 0, {
                  x: actor.x,
                  y: actor.profile.scaleY * 1.5,
                  z: actor.z,
                });
                p.onGrenadeImpactLog({
                  grenade: incProfile,
                  targetName: actor.profile.name,
                  zoneLabel: 'Thermite DoT (+20% Mobility)',
                  hpDamage: burnDmg,
                  isKill: outcome.killed,
                  isStagger: false,
                  distanceM: Math.max(
                    1,
                    Math.round(Math.hypot(actor.x - s.playerX, actor.z - s.playerZ))
                  ),
                  enemyTtkMs: outcome.enemyTtkMs,
                });
              }
            }
          }
          if (anyEnemyBurned) {
            soundEngine.playIncendiaryTick();
            checkSquadCleared();
          }

          if (p.playerHp > 0 && s.playerBurnTickCooldown <= 0) {
            const playerInZone = s.incendiaryZones.find(
              (z) => Math.hypot(s.playerX - z.x, s.playerZ - z.z) <= z.radius + 0.35
            );
            if (playerInZone) {
              s.playerBurnTickCooldown = 0.65;
              s.playerBurnSlowTimer = 0.55;
              setDamageFlashAlpha((prev) => Math.max(prev, 0.25));
              p.onPlayerOrdnanceSelfDamage(playerInZone.dotDamage, 'Thermite Fire Pool (-90%)');
            }
          }
        }

        for (let i = s.incendiaryZones.length - 1; i >= 0; i--) {
          const z = s.incendiaryZones[i];
          z.remainingSec -= delta;
          if (z.light.intensity > 0) {
            z.light.intensity = 9 + Math.sin(elapsed * 18 + i) * 3.5;
          }
          if (z.remainingSec <= 0) {
            scene.remove(z.group);
            disposeObject3D(z.group);
            s.incendiaryZones.splice(i, 1);
          }
        }

        // Advance & collect dropped Ammo Supply Boxes (+20% Primary & Secondary ammo)
        if (s.ammoToastTimer > 0) {
          s.ammoToastTimer = Math.max(0, s.ammoToastTimer - delta);
          if (s.ammoToastTimer <= 0) {
            setAmmoToast(null);
          }
        }
        for (let i = s.ammoBoxes.length - 1; i >= 0; i--) {
          const ab = s.ammoBoxes[i];
          ab.remainingSec -= delta;
          if (ab.y > 0 || ab.vy !== 0) {
            ab.vy -= 18 * delta;
            ab.y += ab.vy * delta;
            if (ab.y <= 0) {
              ab.y = 0;
              ab.vy = Math.abs(ab.vy) > 1.8 ? -ab.vy * 0.25 : 0;
            }
          }
          ab.spinPhase += delta * 2.4;
          ab.mesh.position.set(ab.x, ab.y, ab.z);
          if (ab.beacon) {
            ab.beacon.rotation.y = ab.spinPhase;
            ab.beacon.position.y = 0.58 + Math.sin(ab.spinPhase * 1.8) * 0.08;
          }

          let pickedUp = false;
          if (p.playerHp > 0 && Math.hypot(ab.x - s.playerX, ab.z - s.playerZ) <= 1.85) {
            const result = p.onCollectAmmoBox();
            if (result.collected) {
              pickedUp = true;
              s.ammoToastTimer = 2.4;
              setAmmoToast(`AMMO +10% (${result.weaponCode} +${result.added})`);
            }
          }

          if (pickedUp || ab.remainingSec <= 0) {
            scene.remove(ab.mesh);
            disposeObject3D(ab.mesh);
            s.ammoBoxes.splice(i, 1);
          }
        }

        // Advance & collect dropped Consumable Supply Boxes (+2 usages of any missing consumable)
        for (let i = s.consumableBoxes.length - 1; i >= 0; i--) {
          const cb = s.consumableBoxes[i];
          cb.remainingSec -= delta;
          if (cb.y > 0 || cb.vy !== 0) {
            cb.vy -= 18 * delta;
            cb.y += cb.vy * delta;
            if (cb.y <= 0) {
              cb.y = 0;
              cb.vy = Math.abs(cb.vy) > 1.8 ? -cb.vy * 0.25 : 0;
            }
          }
          cb.spinPhase += delta * 2.6;
          cb.mesh.position.set(cb.x, cb.y, cb.z);
          if (cb.beacon) {
            cb.beacon.rotation.y = cb.spinPhase;
            cb.beacon.position.y = 0.58 + Math.sin(cb.spinPhase * 1.8) * 0.08;
          }

          let pickedUp = false;
          if (p.playerHp > 0 && Math.hypot(cb.x - s.playerX, cb.z - s.playerZ) <= 1.85) {
            const cResult = p.onCollectConsumableBox();
            if (cResult.collected) {
              pickedUp = true;
              s.ammoToastTimer = 2.6;
              setAmmoToast(`ORDNANCE +2 (${cResult.summaryText})`);
            }
          }

          if (pickedUp || cb.remainingSec <= 0) {
            scene.remove(cb.mesh);
            disposeObject3D(cb.mesh);
            s.consumableBoxes.splice(i, 1);
          }
        }

        // Advance Floor Proximity Trip Mines (1000 DMG at 5m)
        for (let i = s.tripMines.length - 1; i >= 0; i--) {
          const mine = s.tripMines[i];
          mine.deployGraceTimer = Math.max(0, mine.deployGraceTimer - delta);
          if (mine.armTimer > 0) {
            mine.armTimer = Math.max(0, mine.armTimer - delta);
          } else {
            const ledMat = mine.ledMesh.material as THREE.MeshStandardMaterial;
            ledMat.emissiveIntensity = 1.6 + Math.sin(elapsed * 10 + i) * 1.1;
            const triggered = s.enemies.some(
              (a) => a.alive && Math.hypot(a.x - mine.x, a.z - mine.z) <= mine.triggerRadius
            );
            if (triggered) {
              // Remove from list BEFORE detonating so chain-explosion splice won't corrupt indices
              s.tripMines.splice(i, 1);
              scene.remove(mine.mesh);
              disposeObject3D(mine.mesh);
              detonateGrenadeAt(getGrenadeById('trip_mine', p.grenades), mine.x, 0.25, mine.z);
            }
          }
        }

        // Advance Wall-Mounted / Directional Laser Trip Mines (triggers on enemy OR player beam contact)
        for (let i = s.laserMines.length - 1; i >= 0; i--) {
          const lm = s.laserMines[i];
          lm.deployGraceTimer = Math.max(0, lm.deployGraceTimer - delta);
          if (lm.armTimer > 0) {
            lm.armTimer = Math.max(0, lm.armTimer - delta);
          } else {
            let tripped = false;
            for (const actor of s.enemies) {
              if (!actor.alive) continue;
              const toActorX = actor.x - lm.pos.x;
              const toActorY = actor.profile.scaleY * 0.9 - lm.pos.y;
              const toActorZ = actor.z - lm.pos.z;
              const along = THREE.MathUtils.clamp(
                toActorX * lm.beamDir.x + toActorY * lm.beamDir.y + toActorZ * lm.beamDir.z,
                0,
                lm.beamLength
              );
              const closestX = lm.pos.x + lm.beamDir.x * along;
              const closestY = lm.pos.y + lm.beamDir.y * along;
              const closestZ = lm.pos.z + lm.beamDir.z * along;
              const xzDist = Math.hypot(actor.x - closestX, actor.z - closestZ);
              if (
                xzDist <= 0.78 * actor.profile.scaleXZ &&
                closestY >= 0.02 &&
                closestY <= actor.profile.scaleY * 2.15 + 0.15
              ) {
                tripped = true;
                break;
              }
            }
            if (!tripped && p.playerHp > 0 && lm.deployGraceTimer <= 0) {
              const toPlX = s.playerX - lm.pos.x;
              const toPlY = 0.95 - lm.pos.y;
              const toPlZ = s.playerZ - lm.pos.z;
              const alongPl = THREE.MathUtils.clamp(
                toPlX * lm.beamDir.x + toPlY * lm.beamDir.y + toPlZ * lm.beamDir.z,
                0,
                lm.beamLength
              );
              const closestX = lm.pos.x + lm.beamDir.x * alongPl;
              const closestY = lm.pos.y + lm.beamDir.y * alongPl;
              const closestZ = lm.pos.z + lm.beamDir.z * alongPl;
              if (
                Math.hypot(s.playerX - closestX, s.playerZ - closestZ) <= 0.58 &&
                closestY >= 0.02 &&
                closestY <= 1.85
              ) {
                tripped = true;
              }
            }
            if (tripped) {
              // Remove from list BEFORE detonating so chain-explosion splice won't corrupt indices
              s.laserMines.splice(i, 1);
              scene.remove(lm.mesh);
              disposeObject3D(lm.mesh);
              detonateLaserTripMine(lm);
            }
          }
        }

        // Advance Thrown & Planted Sticky Remote C4 (MMB detonates anytime)
        for (const c4 of s.stickyC4s) {
          c4.deployGraceTimer = Math.max(0, c4.deployGraceTimer - delta);
          const ledMat = c4.ledMesh.material as THREE.MeshStandardMaterial;
          ledMat.emissiveIntensity = c4.stuck ? 1.8 + Math.sin(elapsed * 8) * 1.4 : 0.8;
          if (!c4.stuck) {
            c4.vy -= 16.5 * delta;
            const nextX = c4.pos.x + c4.vx * delta;
            const nextY = c4.pos.y + c4.vy * delta;
            const nextZ = c4.pos.z + c4.vz * delta;

            const clamped = resolveRoomCollision2D(
              nextX,
              nextZ,
              c4.pos.x,
              c4.pos.z,
              0.18,
              p.config.roomId,
              {
                isPlayer: false,
                westDoorBroken: currentRoom.westDoor?.broken ?? true,
                eastDoorBroken: currentRoom.eastDoor?.broken ?? true,
                northDoorBroken: currentRoom.northDoor?.broken ?? true,
                covers: currentRoom.covers,
              }
            );

            // Stick to enemy torso if intercepted mid-flight
            let hitActor: EnemyActor | null = null;
            for (const actor of s.enemies) {
              if (!actor.alive) continue;
              const ed = Math.hypot(actor.x - clamped.x, actor.z - clamped.z);
              if (ed < 0.72 * actor.profile.scaleXZ && nextY < actor.profile.scaleY * 2.1) {
                hitActor = actor;
                break;
              }
            }

            if (hitActor) {
              c4.stuck = true;
              c4.attachedActorUid = hitActor.uid;
              c4.localOffset.set(
                clamped.x - hitActor.x,
                Math.max(0.5, nextY),
                clamped.z - hitActor.z
              );
              c4.pos.set(hitActor.x + c4.localOffset.x, c4.localOffset.y, hitActor.z + c4.localOffset.z);
              soundEngine.playConsumableDeploy();
            } else if (Math.hypot(clamped.x - nextX, clamped.z - nextZ) > 0.04) {
              // Stuck flush onto a wall or door
              c4.stuck = true;
              c4.pos.set(clamped.x, Math.max(0.2, nextY), clamped.z);
              soundEngine.playConsumableDeploy();
            } else if (nextY <= 0.12) {
              // Stuck flat on the floor
              c4.stuck = true;
              c4.pos.set(clamped.x, 0.1, clamped.z);
              soundEngine.playConsumableDeploy();
            } else {
              c4.pos.set(clamped.x, nextY, clamped.z);
              c4.mesh.rotation.x += delta * 9;
              c4.mesh.rotation.y += delta * 6;
            }
          } else if (c4.attachedActorUid !== null) {
            const host = s.enemies.find((e) => e.uid === c4.attachedActorUid);
            if (host && host.alive) {
              c4.pos.set(host.x + c4.localOffset.x, c4.localOffset.y, host.z + c4.localOffset.z);
            } else {
              c4.pos.y = 0.1;
              c4.attachedActorUid = null;
            }
          }
          c4.mesh.position.copy(c4.pos);
        }

        // Advance Deployed Sentry Turrets (22 DMG @ 600 RPM, 15m/50m drop, 1.5x weakspot + armor mult, 500 HP @ 0.7x armor)
        const turretProfile = getGrenadeById('deployable_turret', p.grenades);
        const maxTurretScanM = Math.max(15, getGrenadeDropRangeM(turretProfile) + 2);
        const minTurretPitch = THREE.MathUtils.degToRad(-15);
        const maxTurretPitch = THREE.MathUtils.degToRad(36);
        const maxTurretYaw = Math.PI * 0.25; // 45 deg half-cone => 90 deg cone

        for (let i = s.turrets.length - 1; i >= 0; i--) {
          const tur = s.turrets[i];
          tur.deployGraceTimer = Math.max(0, tur.deployGraceTimer - delta);

          if (tur.muzzleFlashTimer > 0) {
            tur.muzzleFlashTimer -= delta;
            if (tur.muzzleFlashTimer <= 0) tur.muzzleFlash.visible = false;
          }
          if (tur.fireCooldown > 0) {
            tur.fireCooldown -= delta;
          }

          let lockedActor: EnemyActor | null = null;
          let lockedRelYaw = 0;
          let lockedPitch = 0;
          let bestDistSq = Infinity;

          for (const actor of s.enemies) {
            if (!actor.alive) continue;
            const dx = actor.x - tur.pos.x;
            const dy = actor.profile.scaleY * 1.25 - tur.pos.y;
            const dz = actor.z - tur.pos.z;
            const hDist = Math.hypot(dx, dz);
            if (hDist > maxTurretScanM || hDist < 0.35) continue;

            const targetWorldYaw = Math.atan2(dx, dz);
            const relYaw = Math.atan2(
              Math.sin(targetWorldYaw - tur.baseYaw),
              Math.cos(targetWorldYaw - tur.baseYaw)
            );
            const pitch = Math.atan2(dy, hDist);

            if (
              Math.abs(relYaw) <= maxTurretYaw &&
              pitch >= minTurretPitch &&
              pitch <= maxTurretPitch
            ) {
              const dSq = dx * dx + dy * dy + dz * dz;
              if (dSq < bestDistSq) {
                const startP = _vec3A.copy(tur.pos);
                const endP = _vec3B.set(actor.x, actor.profile.scaleY * 1.25, actor.z);
                const dirToTarget = _vec3C.subVectors(endP, startP).normalize();
                raycaster.set(startP, dirToTarget);
                const losHits = raycaster.intersectObjects(envBlockers, false);
                if (losHits.length === 0 || losHits[0].distance >= Math.sqrt(dSq) - 0.35) {
                  bestDistSq = dSq;
                  lockedActor = actor;
                  lockedRelYaw = relYaw;
                  lockedPitch = pitch;
                }
              }
            }
          }

          if (lockedActor) {
            tur.currentRelYaw = THREE.MathUtils.damp(tur.currentRelYaw, lockedRelYaw, 18, delta);
            tur.currentPitch = THREE.MathUtils.damp(tur.currentPitch, lockedPitch, 18, delta);
            tur.yawGroup.rotation.y = tur.currentRelYaw;
            tur.pitchGroup.rotation.x = -tur.currentPitch;

            if (tur.fireCooldown <= 0 && Math.abs(tur.currentRelYaw - lockedRelYaw) < 0.24) {
              tur.fireCooldown = 0.1; // 600 RPM
              tur.muzzleFlash.visible = true;
              tur.muzzleFlashTimer = 0.04;
              soundEngine.playTurretFire();

              const muzzleW = tur.muzzlePoint.getWorldPosition(_vec3A);
              // Aim near upper chest / neck with slight natural spread so weakspot 1.5x & armor mults both engage
              const aimY = THREE.MathUtils.lerp(
                lockedActor.profile.scaleY * 1.22,
                lockedActor.model.weakspotHeight,
                0.35
              );
              const impactW = _vec3B.set(
                lockedActor.x + (Math.random() - 0.5) * 0.22 * lockedActor.profile.scaleXZ,
                aimY + (Math.random() - 0.5) * 0.22 * lockedActor.profile.scaleY,
                lockedActor.z + (Math.random() - 0.5) * 0.22 * lockedActor.profile.scaleXZ
              );
              const shotDir = _vec3C.subVectors(impactW, muzzleW).normalize();
              raycaster.set(muzzleW, shotDir);
              const actorHits = raycaster.intersectObjects(
                lockedActor.model.hitMeshes.filter((hm) => hm.visible),
                false
              );

              let hitZone: HitZoneId = 'torso';
              let hitRegion: BodyRegionKey = 'torso';
              let hitSubPart: 'atgm' | 'rocket_pods' | undefined;
              let shieldHit = false;
              let actualImpact = impactW;
              if (actorHits.length > 0) {
                const h = actorHits[0];
                actualImpact = h.point;
                if (h.object.userData.isShield && lockedActor.shieldHp > 0) {
                  shieldHit = true;
                } else {
                  hitSubPart = h.object.userData.subPart as 'atgm' | 'rocket_pods' | undefined;
                  hitZone = hitSubPart ? 'torso' : ((h.object.userData.hitZone as HitZoneId) ?? 'torso');
                  hitRegion = (h.object.userData.bodyRegion as BodyRegionKey) ?? (hitZone === 'weakspot' ? 'head' : 'torso');
                }
              }

              spawnTracer(muzzleW, actualImpact, 0x20df78);

              if (shieldHit) {
                const shieldDmg = Math.max(1, Math.round(turretProfile.damage));
                lockedActor.shieldHp = Math.max(0, lockedActor.shieldHp - shieldDmg);
                lockedActor.components.regionHits.shield = (lockedActor.components.regionHits.shield ?? 0) + 1;
                updateRegionWeathering(lockedActor, 'shield');
                soundEngine.playShieldHit();
                if (lockedActor.shieldHp <= 0 && lockedActor.model.shieldGroup) {
                  lockedActor.model.shieldGroup.visible = false;
                  for (const hm of lockedActor.model.hitMeshes) {
                    if (hm.userData.isShield) hm.visible = false;
                  }
                }
              } else {
                const hDist = muzzleW.distanceTo(actualImpact);
                const falloff = computeConsumableFalloff(turretProfile, hDist);
                const zoneMult = hitSubPart
                  ? (hitSubPart === 'atgm' ? 0.6 : 0.8) * (lockedActor.staggerTimer > 0 ? lockedActor.profile.staggerDamageMultiplier : 1.0)
                  : computeConsumableZoneMult(turretProfile, lockedActor, hitZone);
                const dmg = Math.max(1, Math.round(turretProfile.damage * falloff * zoneMult));
                const nextHp = Math.max(0, lockedActor.hp - dmg);
                const outcome = applyDamageAndStagger(lockedActor, nextHp, Math.round(turretProfile.damage * 0.45));
                if (hitSubPart === 'atgm' && !lockedActor.components.atgmDestroyed) {
                  lockedActor.components.atgmHp = Math.max(0, lockedActor.components.atgmHp - dmg);
                  if (lockedActor.components.atgmHp <= 0) {
                    triggerWeaponPodDestruction(lockedActor, 'atgm');
                  }
                } else if (hitSubPart === 'rocket_pods' && !lockedActor.components.rocketPodDestroyed) {
                  lockedActor.components.rocketPodHp = Math.max(0, lockedActor.components.rocketPodHp - dmg);
                  if (lockedActor.components.rocketPodHp <= 0) {
                    triggerWeaponPodDestruction(lockedActor, 'rocket_pods');
                  }
                }
                applyComponentHit(
                  lockedActor,
                  hitRegion,
                  actualImpact.y,
                  dmg,
                  hitZone === 'weakspot',
                  outcome.killed
                );
                pushHitVisuals(dmg, hitZone === 'weakspot', outcome.killed, outcome.triggeredStagger, 0, {
                  x: actualImpact.x,
                  y: actualImpact.y + 0.25,
                  z: actualImpact.z,
                });
                p.onGrenadeImpactLog({
                  grenade: turretProfile,
                  targetName: lockedActor.profile.name,
                  zoneLabel: hitZone === 'weakspot' ? 'Sentry Weakspot (1.5x)' : 'Sentry 600 RPM Fire',
                  hpDamage: dmg,
                  isKill: outcome.killed,
                  isStagger: outcome.triggeredStagger,
                  distanceM: Math.max(1, Math.round(hDist)),
                  enemyTtkMs: outcome.enemyTtkMs,
                  source: 'PLAYER_TURRET',
                  affectedTargets: [
                    {
                      enemyUid: lockedActor.encounterId,
                      targetId: lockedActor.profile.id,
                      targetName: lockedActor.profile.name,
                      targetCode: lockedActor.profile.code,
                      silhouette: lockedActor.profile.silhouette,
                      waveNumber: p.waveNumber,
                      hpDamage: dmg,
                      isKill: outcome.killed,
                      enemyTtkMs: outcome.enemyTtkMs,
                    },
                  ],
                });
                checkSquadCleared();
              }
            }
          } else {
            // Idle gentle sentry sweep inside +/-38 deg arc when scanning
            const idleYaw = Math.sin(elapsed * 1.2 + i) * 0.65;
            tur.currentRelYaw = THREE.MathUtils.damp(tur.currentRelYaw, idleYaw, 5, delta);
            tur.currentPitch = THREE.MathUtils.damp(tur.currentPitch, 0.04, 6, delta);
            tur.yawGroup.rotation.y = tur.currentRelYaw;
            tur.pitchGroup.rotation.x = -tur.currentPitch;
          }
        }

        // Expand & Fade Grenade Shockwave Rings
        for (let i = s.explosionRings.length - 1; i >= 0; i--) {
          const r = s.explosionRings[i];
          r.life -= delta;
          const prog = 1 - Math.max(0, r.life / r.maxLife);
          r.mesh.scale.setScalar(0.35 + prog * r.maxScale);
          (r.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, (1 - prog) * 0.72);
          if (r.life <= 0) {
            scene.remove(r.mesh);
            (r.mesh.material as THREE.Material).dispose();
            s.explosionRings.splice(i, 1);
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

      /**
       * Throttled HUD Sync (~15Hz):
       * Re-evaluates what the player is looking at via center-screen `THREE.Raycaster`:
       * - Prioritizes the exact enemy & anatomical hit zone (`weakspot`/`torso`/`limb`) under the
       *   crosshair, falling back to the nearest alive enemy when looking into open space.
       * - Extracts broken/degraded internal component badges (`PWR`, `BAT`, `C-HD`, `C-TR`, `C-AR`,
       *   `C-LG`, `OPT`, `MECH`), equipped enemy weapon names, live distance, and AI state badge
       *   whenever the cursor shifts to a new hostile or when target HP/shield changes.
       * - Updates `[E] PICK UP` deployable prompts (`<2m`), melee special charge bar, reload %,
       *   and re-projects floating world-anchored damage popups onto viewport screen percentages.
       *
       * Why an alternative would be worse: raycasting the crosshair and calling `setFocusedHud` on
       * every 60Hz animation frame would waste React diff cycles even when neither the hovered enemy
       * nor any HP value changed appreciably.
       */
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
            for (const hm of actor.model.hitMeshes) {
              if (hm.visible) aliveHitMeshes.push(hm);
            }
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

        setStunEffectRemainingSec(s.stunFlashTimer > 0.01 ? s.stunFlashTimer : 0);

        const pickupHit = findLookedAtDeployableForPickup();
        setPickupPrompt(pickupHit ? pickupHit.label : null);

        const displayActor = focusActor ?? s.enemies[0];
        const pendingCount = s.pendingSpawns.length;
        const totalWaveCount = Math.max(1, s.totalSpawnedThisWave);

        if (displayActor) {
          const dist = Math.max(
            1,
            Math.round(Math.hypot(displayActor.x - s.playerX, displayActor.z - s.playerZ))
          );
          setLiveDistanceM(dist);
          const dc = displayActor.components;
          const compFlags: string[] = [];
          if (dc.powerSupplyHp <= 0 || dc.powerSupplyHp < dc.powerSupplyMaxHp * 0.4) compFlags.push('PWR');
          if (dc.batteryHp < dc.batteryMaxHp * 0.85) compFlags.push('BAT');
          if (dc.headExploded) compFlags.push('NO-HD');
          else if (dc.capacitors.head <= 0) compFlags.push('C-HD');
          if (dc.capacitors.torso <= 0) compFlags.push('C-TR');
          if (dc.armsDestroyed.leftArm) compFlags.push('NO-LA');
          if (dc.armsDestroyed.rightArm) compFlags.push('NO-RA');
          if (!dc.armsDestroyed.leftArm && !dc.armsDestroyed.rightArm && (dc.capacitors.leftArm <= 0 || dc.capacitors.rightArm <= 0)) compFlags.push('C-AR');
          if (dc.capacitors.leftLeg <= 0 || dc.capacitors.rightLeg <= 0) compFlags.push('C-LG');
          if (dc.viewingLensHp <= 0 && !dc.headExploded) compFlags.push('OPT');
          if (dc.mechanismsHp <= 0) compFlags.push('MECH');
          if (dc.atgmDestroyed) compFlags.push('NO-ATGM');
          if (dc.rocketPodDestroyed) compFlags.push('NO-PODS');
          const weaponNames: string[] = [];
          if (displayActor.loadout.rangedWeaponId) {
            weaponNames.push(ENEMY_WEAPONS[displayActor.loadout.rangedWeaponId].name);
          }
          if (displayActor.loadout.meleeWeaponId) {
            weaponNames.push(ENEMY_WEAPONS[displayActor.loadout.meleeWeaponId].name);
          }
          if (displayActor.loadout.rocketPodWeaponId) {
            weaponNames.push(ENEMY_WEAPONS[displayActor.loadout.rocketPodWeaponId].name);
          }

          setFocusedHud({
            name: displayActor.profile.name,
            code: displayActor.profile.code,
            groupLabel: displayActor.groupLabel,
            hp: displayActor.hp,
            maxHp: displayActor.maxHp,
            shieldHp: displayActor.shieldHp,
            shieldMaxHp: displayActor.shieldMaxHp,
            compFlags,
            weaponLabel: weaponNames.join(' + '),
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
                    ? 'ATGM OVERWATCH'
                    : displayActor.coverTarget && !displayActor.coverTarget.broken
                      ? 'TAKING COVER'
                      : dist <= displayActor.meleeDist + 0.3
                        ? 'CLOSE QUARTERS'
                        : displayActor.loadout.rangedWeaponId
                          ? 'SUPPRESSING'
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

        setReloadProgress(
          s.reloadAnimActive
            ? Math.min(
                100,
                Math.round((s.reloadAnimElapsed / Math.max(0.1, s.reloadAnimDuration)) * 100)
              )
            : 0
        );

        // Re-project enemy-anchored damage popups into viewport screen percentages
        const nowPopup = performance.now();
        if (s.floatingHitsRef.length > 0) {
          const nextLabels = s.floatingHitsRef
            .filter((h) => nowPopup - h.createdAt < 680)
            .map((h) => {
              const ageSec = (nowPopup - h.createdAt) / 1000;
              const proj = projectWorldToScreenPct(h.worldX, h.worldY + ageSec * 0.72, h.worldZ);
              return {
                ...h,
                screenX: proj.screenX,
                screenY: proj.screenY,
                visible: proj.visible,
              };
            });
          s.floatingHitsRef = nextLabels;
          setFloatingHits(nextLabels);
        }

        setNextWaveCountdownSec(
          s.nextWaveTimerSec !== null ? Math.max(0, Math.round(s.nextWaveTimerSec * 10) / 10) : null
        );
        setDamageFlashAlpha((prev) => Math.max(0, prev - 0.12));
        setHitMarker((prev) => (prev && nowPopup - prev.createdAt > 220 ? null : prev));
      }

      // Track live FPS counter & refresh tactical minimap snapshot in-place
      fpsFrames += 1;
      fpsAcc += rawDelta;
      if (fpsAcc >= 0.45) {
        setFpsCount(Math.max(1, Math.round(fpsFrames / fpsAcc)));
        fpsFrames = 0;
        fpsAcc = 0;
      }

      const snap = minimapSnapshotRef.current;
      snap.roomId = p.config.roomId;
      snap.playerX = s.playerX;
      snap.playerZ = s.playerZ;
      snap.aimYaw = s.aimYaw;
      snap.wallSegments = currentRoom.wallSegments;
      snap.doors = [currentRoom.westDoor, currentRoom.eastDoor, currentRoom.northDoor]
        .filter((d): d is BreakableDoor3D => Boolean(d))
        .map((d) => ({
          ax: d.segment.ax,
          az: d.segment.az,
          bx: d.segment.bx,
          bz: d.segment.bz,
          broken: d.broken,
        }));
      snap.enemies = s.enemies
        .filter((e) => e.alive)
        .map((e) => ({
          x: e.x,
          z: e.z,
          silhouette: e.profile.silhouette,
          staggered: e.staggerTimer > 0,
        }));
      snap.ammoBoxes = s.ammoBoxes.map((ab) => ({ x: ab.x, z: ab.z }));
      snap.consumableBoxes = s.consumableBoxes.map((cb) => ({ x: cb.x, z: cb.z }));

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
      centerViewportCursorRef.current = null;
      cancelAnimationFrame(frameId);
      clearTimeout(frameId);
      resizeObserver.disconnect();
      dom.removeEventListener('focus', handleDomFocus);
      dom.removeEventListener('mouseenter', handleMouseEnter);
      dom.removeEventListener('mouseleave', handleMouseLeave);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mousedown', handleWindowMmbMouseDown);
      dom.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('auxclick', handleAuxClick);
      dom.removeEventListener('wheel', handleWheel);
      window.removeEventListener('mouseup', handleMouseUp);
      dom.removeEventListener('contextmenu', handleContextMenu);
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleWindowBlur);
      for (const evt of POINTER_LOCK_CHANGE_EVENTS) {
        document.removeEventListener(evt, handlePointerLockChange);
      }
      for (const evt of POINTER_LOCK_ERROR_EVENTS) {
        document.removeEventListener(evt, handlePointerLockError);
      }

      for (const actor of simRef.current.enemies) {
        disposeObject3D(actor.model.root);
      }
      clearDynamicProjectiles();
      for (const d of simRef.current.doorDebris) {
        scene.remove(d.mesh);
      }
      for (const sp of simRef.current.impactSparks) {
        scene.remove(sp.mesh);
      }
      for (const dc of simRef.current.impactDecals) {
        scene.remove(dc.mesh);
      }
      droneBoltGeo.dispose();
      grenadeBodyGeo.dispose();
      explosionSphereGeo.dispose();
      debrisGeo.dispose();
      debrisMat.dispose();
      impactSparkGeo.dispose();
      impactSparkMat.dispose();
      impactDecalGeo.dispose();
      impactDecalMat.dispose();
      disposeObject3D(currentWeapon3D.root);
      skyDomeGeo.dispose();
      skyDomeMat.dispose();
      rainGeo.dispose();
      rainMat.dispose();
      splashGeo.dispose();
      splashMat.dispose();
      boltGeo.dispose();
      boltMat.dispose();
      soundEngine.stopAmbient();
      currentRoom.dispose();
      renderer.dispose();
      if (container.contains(dom)) {
        container.removeChild(dom);
      }
    };
  }, []);

  /**
   * Computes whether the OS mouse cursor must be forcefully hidden across the entire viewport/document:
   * active whenever combat is focused, unpaused, neither Ctrl-cursor nor `[E]` inventory is open,
   * the player is alive (`playerHp > 0`), and the Wave 5 victory screen is not displayed.
   * Applying `.combat-cursor-locked` on both `<html>` and `<body>` keeps the cursor hidden even
   * when pointer lock is unavailable in embedded iframes and the virtual pointer grazes canvas edges.
   *
   * Why an alternative would be worse: setting `cursor: none` solely on `<canvas>` causes the OS
   * cursor to flicker visibly whenever the mouse brushes HUD overlays or iframe edges during fallback aiming.
   */
  const hideViewportCursor =
    !cursorShown &&
    !inventoryOpen &&
    !effectivePaused &&
    isWindowFocused &&
    playerHp > 0 &&
    !wave5Won;

  // Force OS cursor hidden globally during combat even if mouse moves past viewport boundaries
  useEffect(() => {
    document.body.style.cursor = hideViewportCursor ? 'none' : '';
    if (hideViewportCursor) {
      document.documentElement.classList.add('combat-cursor-locked');
      document.body.classList.add('combat-cursor-locked');
    } else {
      document.documentElement.classList.remove('combat-cursor-locked');
      document.body.classList.remove('combat-cursor-locked');
    }
    return () => {
      document.body.style.cursor = '';
      document.documentElement.classList.remove('combat-cursor-locked');
      document.body.classList.remove('combat-cursor-locked');
    };
  }, [hideViewportCursor]);

  const weapon = getWeaponById(config.weaponId, weapons);
  const activeConsumable = getGrenadeById(config.grenadeId, grenades);
  const isConsumableSlot = config.activeSlot === 'CONSUMABLE';
  const isMelee = !isConsumableSlot && weapon.weaponClass === 'MELEE' && !!weapon.melee;

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

  const handleToggleFullscreen = () => {
    toggleViewportFullscreen();
  };

  const handleResumeCombat = () => {
    const s = simRef.current;
    s.cursorShown = false;
    s.unlockedByCtrl = false;
    setCursorShown(false);
    onSetPaused(false);
    centerViewportCursorRef.current?.(120, true);
    const canvasEl = mountRef.current?.querySelector('canvas');
    if (canvasEl) {
      const rect = (viewportRef.current ?? canvasEl).getBoundingClientRect();
      s.prevClientX = rect.left + rect.width * 0.5;
      s.prevClientY = rect.top + rect.height * 0.5;
      canvasEl.focus({ preventScroll: true });
      safeRequestPointerLock(canvasEl);
    }
  };

  const turretCapReached =
    activeConsumable.kind === 'TURRET' &&
    activeTurretCount >= Math.max(1, activeConsumable.turretMaxDeployed ?? 3);

  return (
    <section className="flex flex-col gap-2.5">
      {/* External Viewport Control Strip (Outside Viewport Frame) */}
      <div className="bg-[#121721] border border-[#1e2638] px-3 py-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1">
          {grenades.map((g, idx) => {
            const active = config.grenadeId === g.id;
            const rem = consumableUsages[g.id] ?? 0;
            return (
              <button
                key={g.id}
                type="button"
                onClick={() => onSelectGrenade(g.id)}
                className={`px-2 py-1 border font-mono text-[10px] font-semibold uppercase tracking-[0.06em] transition-colors cursor-pointer ${
                  active
                    ? 'bg-[#1b2332] border-[#ffb300] text-[#ffb300]'
                    : rem === 0
                      ? 'bg-[#0b0e14] border-[#1b2232] text-[#505d73]'
                      : 'bg-[#0f141d] border-[#232d42] text-[#8c9bb5] hover:text-[#e1e2ea]'
                }`}
              >
                [{idx + 3}] {g.shortLabel} ({rem})
              </button>
            );
          })}
          <button
            type="button"
            onClick={onToggleConsumableSlot}
            className={`px-2 py-1 border font-mono text-[10px] font-bold uppercase tracking-[0.06em] flex items-center gap-1 transition-colors cursor-pointer ${
              isConsumableSlot
                ? 'bg-[#20df78] border-[#20df78] text-[#0a0d12]'
                : 'bg-[#0f141d] border-[#20df78]/60 text-[#20df78] hover:bg-[#20df78]/15'
            }`}
          >
            <Flame size={11} />
            <span>{isConsumableSlot ? 'ORD IN HAND' : 'EQUIP ORD'}</span>
          </button>
          <button
            type="button"
            disabled={
              effectivePaused ||
              playerHp <= 0 ||
              grenadeCooldownSec > 0 ||
              (consumableUsages[config.grenadeId] ?? 0) <= 0 ||
              turretCapReached
            }
            onClick={() => {
              simRef.current.pendingGrenadeThrow = config.grenadeId;
            }}
            className={`px-2.5 py-1 border font-mono text-[10px] font-bold uppercase tracking-[0.06em] flex items-center gap-1 transition-colors ${
              effectivePaused ||
              playerHp <= 0 ||
              grenadeCooldownSec > 0 ||
              (consumableUsages[config.grenadeId] ?? 0) <= 0 ||
              turretCapReached
                ? 'bg-[#0f141d] border-[#232d42] text-[#606f89] cursor-not-allowed'
                : 'bg-[#ff2a4b]/15 border-[#ff2a4b] text-[#ff2a4b] hover:bg-[#ff2a4b] hover:text-[#0a0d12] cursor-pointer'
            }`}
          >
            <span>
              {(consumableUsages[config.grenadeId] ?? 0) <= 0
                ? 'DEPLETED'
                : grenadeCooldownSec > 0
                  ? `ORD ${grenadeCooldownSec.toFixed(1)}S`
                  : 'USE [MMB]'}
            </span>
          </button>
          <button
            type="button"
            disabled={isPaused || !isScreenActive}
            onClick={() => {
              const nextOpen = !inventoryOpen;
              simRef.current.inventoryOpen = nextOpen;
              setInventoryOpen(nextOpen);
              soundEngine.playInventoryToggle(nextOpen);
            }}
            className={`px-2 py-1 border font-mono text-[10px] font-bold uppercase tracking-[0.06em] transition-colors cursor-pointer ${
              inventoryOpen
                ? 'bg-[#00f0ff] border-[#00f0ff] text-[#0a0d12]'
                : 'bg-[#0f141d] border-[#00f0ff]/60 text-[#00f0ff] hover:bg-[#00f0ff]/15'
            }`}
          >
            [E] INVENTORY
          </button>
          {plantedC4Count > 0 && (
            <button
              type="button"
              onClick={() => {
                const s = simRef.current;
                if (s.stickyC4s.length > 0) {
                  // Clear any pending C4 clicks cleanly in Pause/UI
                  s.stickyC4s.forEach((c4) => {
                    c4.stuck = true;
                  });
                }
              }}
              title="Press Middle Mouse Button in arena to detonate C4"
              className="px-2 py-1 border border-[#a855f7] bg-[#a855f7]/20 text-[#d8b4fe] font-mono text-[10px] font-bold uppercase tracking-[0.06em]"
            >
              [MMB] C4 x{plantedC4Count}
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setShowTargetHealthHud((v) => !v)}
            aria-label="Toggle Target HP and Stagger HUD"
            className={`px-2 py-1 border font-mono text-[10px] font-semibold uppercase tracking-[0.06em] flex items-center gap-1 transition-colors cursor-pointer ${
              showTargetHealthHud
                ? 'bg-[#0f141d] border-[#00f0ff]/60 text-[#00f0ff]'
                : 'bg-[#0f141d] border-[#232d42] text-[#606f89] hover:text-[#e1e2ea]'
            }`}
          >
            {showTargetHealthHud ? <Eye size={11} /> : <EyeOff size={11} />}
            <span>TARGET HP</span>
          </button>

          <button
            type="button"
            onClick={() => setShowDamagePopups((v) => !v)}
            aria-label="Toggle Damage Pop-ups"
            className={`px-2 py-1 border font-mono text-[10px] font-semibold uppercase tracking-[0.06em] flex items-center gap-1 transition-colors cursor-pointer ${
              showDamagePopups
                ? 'bg-[#0f141d] border-[#ffb300]/60 text-[#ffb300]'
                : 'bg-[#0f141d] border-[#232d42] text-[#606f89] hover:text-[#e1e2ea]'
            }`}
          >
            {showDamagePopups ? <Eye size={11} /> : <EyeOff size={11} />}
            <span>DMG POPUP</span>
          </button>

          <button
            type="button"
            onClick={handleToggleFullscreen}
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            className="px-2 py-1 border bg-[#0f141d] border-[#232d42] text-[#e1e2ea] hover:border-[#00f0ff] hover:text-[#00f0ff] font-mono text-[10px] font-semibold uppercase tracking-[0.06em] flex items-center gap-1 transition-colors cursor-pointer"
          >
            {isFullscreen ? <Minimize2 size={11} /> : <Maximize2 size={11} />}
            <span>{isFullscreen ? 'EXIT FULL' : 'FULLSCREEN'}</span>
          </button>

          <button
            type="button"
            onClick={() => (isPaused ? handleResumeCombat() : onSetPaused(true))}
            aria-label={isPaused ? 'Resume engagement' : 'Pause engagement'}
            className={`px-2.5 py-1 border font-mono text-[10px] font-bold uppercase tracking-[0.08em] flex items-center gap-1 transition-colors cursor-pointer ${
              isPaused
                ? 'bg-[#ffb300] border-[#ffb300] text-[#0a0d12]'
                : 'bg-[#0f141d] border-[#232d42] text-[#e1e2ea] hover:border-[#ffb300] hover:text-[#ffb300]'
            }`}
          >
            {isPaused ? <Play size={11} /> : <Pause size={11} />}
            <span>{isPaused ? 'RESUME' : 'PAUSE'}</span>
          </button>
        </div>
      </div>

      {/* 3D WebGL Simulation Viewport */}
      <div
        ref={viewportRef}
        className={`relative bg-[#0a0d12] border border-[#1e2638] overflow-hidden select-none ${
          isFullscreen ? 'w-full h-full aspect-auto' : 'aspect-[16/10] lg:min-h-[470px]'
        } ${hideViewportCursor ? 'cursor-none' : 'cursor-default'}`}
      >
        <div
          ref={mountRef}
          className={`absolute inset-0 w-full h-full ${
            playerHp <= 0 ? 'viewport-greyscale' : ''
          } ${hideViewportCursor ? 'cursor-none' : 'cursor-crosshair'}`}
          style={
            playerHp > 0 && stunEffectRemainingSec > 0 && stunEffectRemainingSec <= 3.0
              ? {
                  filter: `contrast(${(1 + (stunEffectRemainingSec / 3.0) * 0.25).toFixed(2)}) brightness(${(1 + (stunEffectRemainingSec / 3.0) * 0.35).toFixed(2)})`,
                }
              : undefined
          }
        />

        {webglError && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0a0d12] p-6 text-center font-mono text-xs text-[#ff2a4b]">
            {webglError}
          </div>
        )}

        {/* Stun Flashbang Screen Effect (0–3s White Screen -> 3–6s Ghosting Vision Recovery) */}
        {stunEffectRemainingSec > 0 && (
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-[28] overflow-hidden">
            {stunEffectRemainingSec > 3.0 ? (
              <div
                className="absolute inset-0 bg-white"
                style={{
                  opacity: Math.min(
                    0.98,
                    stunEffectRemainingSec > 3.4 ? 0.96 : 0.55 + ((stunEffectRemainingSec - 3.0) / 0.4) * 0.41
                  ),
                }}
              />
            ) : (
              (() => {
                const ghostT = stunEffectRemainingSec / 3.0;
                const shiftPx = Math.round(ghostT * 28);
                return (
                  <>
                    <div
                      className="absolute inset-0"
                      style={{
                        background: `radial-gradient(circle at 50% 50%, rgba(255,255,255,${(ghostT * 0.42).toFixed(3)}) 0%, rgba(205,235,255,${(ghostT * 0.28).toFixed(3)}) 65%, rgba(255,255,255,${(ghostT * 0.52).toFixed(3)}) 100%)`,
                      }}
                    />
                    <div
                      className="absolute inset-0 border-2 border-[#00f0ff]/35"
                      style={{
                        transform: `translate(${shiftPx}px, ${Math.round(-shiftPx * 0.4)}px) scale(1.03)`,
                        backgroundColor: `rgba(180, 235, 255, ${(ghostT * 0.16).toFixed(3)})`,
                      }}
                    />
                    <div
                      className="absolute inset-0 border-2 border-[#ff2a4b]/25"
                      style={{
                        transform: `translate(${-shiftPx}px, ${Math.round(shiftPx * 0.4)}px) scale(1.03)`,
                        backgroundColor: `rgba(255, 225, 210, ${(ghostT * 0.14).toFixed(3)})`,
                      }}
                    />
                  </>
                );
              })()
            )}
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

        {/* Projected Enemy-Anchored Damage Pop-up Markers */}
        {showDamagePopups && floatingHits.length > 0 && (
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden z-20">
            {floatingHits.map(
              (hit) =>
                hit.visible && (
                  <div
                    key={hit.id}
                    className="absolute font-mono text-xs font-bold tabular-nums tracking-[0.04em] whitespace-nowrap flex items-center gap-1 bg-[#0a0d12]/80 px-1.5 py-0.5 border-l-2 shadow-[0_2px_6px_rgba(0,0,0,0.65)]"
                    style={{
                      left: `calc(${hit.screenX.toFixed(2)}% + ${hit.jitterX}px)`,
                      top: `calc(${hit.screenY.toFixed(2)}% + ${hit.jitterY}px)`,
                      transform: 'translate(-50%, -100%)',
                      color: hit.color,
                      borderColor: hit.color,
                    }}
                  >
                    <span>{hit.text}</span>
                    {hit.isKill && (
                      <span className="px-1 bg-[#20df78]/20 border border-[#20df78] text-[9px] text-[#20df78]">
                        KILL
                      </span>
                    )}
                  </div>
                )
            )}
          </div>
        )}

        {/* Center Reticle (hidden when player is downed or victory screen is shown) */}
        {playerHp > 0 && !wave5Won && (
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
        )}

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

        {/* Deployable Consumable Pick-Up Prompt (<2m) */}
        {pickupPrompt && !effectivePaused && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute left-1/2 top-[calc(50%+68px)] -translate-x-1/2 z-20 bg-[#0a0d12]/92 border border-[#00f0ff] px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-[#00f0ff] shadow-[0_0_10px_rgba(0,240,255,0.28)]"
          >
            {pickupPrompt}
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

        {/* Top HUD Strip (Wave / Group Tier / Optional Target HP & Stagger) */}
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
              <span className="text-[#20df78] text-[10px]">{focusedHud.groupLabel}</span>
              <span className="text-[#8c9bb5]">·</span>
              <span className="text-[#e1e2ea]">{focusedHud.name}</span>
              <span className="text-[#8c9bb5]">·</span>
              <span className="text-[#00f0ff] tabular-nums">{liveDistanceM}M</span>
            </div>

            {showTargetHealthHud && (
              <div className="w-56 sm:w-64 space-y-1.5 bg-[#0a0d12]/88 p-2 border border-[#1e2638]">
                {focusedHud.shieldMaxHp > 0 && (
                  <div className="space-y-0.5">
                    <div className="flex justify-between font-mono text-[9px] tabular-nums">
                      <span className="text-[#8ab4ff]">BALLISTIC SHIELD</span>
                      <span className="text-[#e1e2ea]">
                        {focusedHud.shieldHp} / {focusedHud.shieldMaxHp}
                      </span>
                    </div>
                    <div className="h-1 w-full bg-[#121721]">
                      <div
                        className="h-full bg-[#4d8dff] transition-all duration-100"
                        style={{
                          width: `${Math.max(0, Math.min(100, (focusedHud.shieldHp / Math.max(1, focusedHud.shieldMaxHp)) * 100))}%`,
                        }}
                      />
                    </div>
                  </div>
                )}

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

                {(focusedHud.weaponLabel || focusedHud.compFlags.length > 0) && (
                  <div className="pt-0.5 flex flex-wrap items-center justify-between gap-1 font-mono text-[8.5px] uppercase tracking-[0.06em]">
                    {focusedHud.weaponLabel && (
                      <span className="text-[#8c9bb5] truncate max-w-[140px]">
                        {focusedHud.weaponLabel}
                      </span>
                    )}
                    {focusedHud.compFlags.length > 0 && (
                      <span className="text-[#ffb300] font-bold">
                        DMG: {focusedHud.compFlags.join(' ')}
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* 12s Inter-Wave Auto-Launch Countdown Banner (suppressed when Wave 5 victory UI is shown) */}
        {nextWaveCountdownSec !== null &&
          !wave5Won &&
          focusedHud.aliveCount === 0 &&
          playerHp > 0 &&
          !isPaused && (
          <div
            className={`absolute top-16 left-1/2 -translate-x-1/2 z-20 bg-[#0a0d12]/92 border border-[#00f0ff] px-4 py-2 flex items-center gap-3 font-mono text-xs uppercase tracking-[0.08em] ${
              hideViewportCursor ? 'pointer-events-none' : 'pointer-events-auto'
            }`}
          >
            <span className="text-[#20df78] font-bold">WAVE {waveNumber} CLEARED</span>
            <span className="text-[#8c9bb5]">·</span>
            <span className="text-[#00f0ff] font-bold tabular-nums">
              NEXT WAVE IN {nextWaveCountdownSec.toFixed(1)}S
            </span>
            <button
              type="button"
              onClick={() => {
                centerViewportCursorRef.current?.(140, true);
                onStartNextWave();
              }}
              className="px-2 py-0.5 bg-[#00f0ff] text-[#0a0d12] font-bold text-[10px] hover:bg-[#ffb300] cursor-pointer"
            >
              START NOW
            </button>
          </div>
        )}

        {/* Top-Right Compact World Time / Weather / Skybox Sync, Cursor Badge, FPS & Enemy Heatmap Minimap */}
        <div
          className={`pointer-events-none absolute top-3 right-3 flex flex-col items-end gap-1.5 ${
            isScreenActive ? 'z-[35]' : 'z-20'
          }`}
        >
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <div
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              title={`Time: ${worldTime.sourceLabel} · Weather: ${activeWeather.sourceLabel} (auto-updates hourly)`}
              className={`${
                hideViewportCursor ? 'pointer-events-none' : 'pointer-events-auto'
              } bg-[#070a0f]/92 border border-[#1e2638] px-2 py-0.5 font-mono text-[10px] flex flex-wrap items-center gap-1.5 text-[#e1e2ea]`}
            >
              {worldTime.phase === 'NIGHT' ? (
                <Moon size={10} className="text-[#7ca2ff] shrink-0" />
              ) : worldTime.phase === 'EVENING' ? (
                <Sunset size={10} className="text-[#ff9f45] shrink-0" />
              ) : (
                <Sun size={10} className="text-[#ffb300] shrink-0" />
              )}
              <span className="font-bold tabular-nums text-[#e1e2ea]">
                {worldTime.formattedTime}
              </span>
              <span
                className={`text-[9px] uppercase tracking-[0.06em] ${
                  worldTime.phase === 'NIGHT'
                    ? 'text-[#7ca2ff]'
                    : worldTime.phase === 'EVENING'
                      ? 'text-[#ff9f45]'
                      : 'text-[#00f0ff]'
                }`}
              >
                {worldTime.phase === 'NIGHT' ? 'NIGHT · LIGHTS ON' : worldTime.phase}
              </span>
              {worldTime.temperatureC !== null && (
                <span className="text-[#20df78] text-[9px] tabular-nums">
                  {worldTime.temperatureC.toFixed(1)}°C
                </span>
              )}
              <span className="text-[#232d42]">|</span>
              {activeWeather.condition === 'TORRENTIAL' ? (
                <CloudLightning size={10} className="text-[#00f0ff] shrink-0" />
              ) : activeWeather.condition === 'HEAVY_RAIN' ? (
                <CloudRain size={10} className="text-[#6cb6ff] shrink-0" />
              ) : activeWeather.condition === 'DRIZZLE' ? (
                <CloudDrizzle size={10} className="text-[#8cc8ff] shrink-0" />
              ) : activeWeather.condition === 'CLOUDY' ? (
                <Cloud size={10} className="text-[#8c9bb5] shrink-0" />
              ) : (
                <Sun size={10} className="text-[#ffb300] shrink-0" />
              )}
              <select
                aria-label="Weather condition mode"
                value={weatherOverride}
                onChange={(e) => setWeatherOverride(e.target.value as WeatherOverrideMode)}
                className="bg-[#0a0d12] border border-[#232d42] text-[#8cc8ff] text-[9px] uppercase px-1 py-0.5 focus:outline-none focus:border-[#00f0ff] cursor-pointer max-w-[116px]"
              >
                <option value="LIVE">Live: {liveWeather.label}</option>
                <option value="CLEAR">Clear (Birds)</option>
                <option value="CLOUDY">Overcast</option>
                <option value="DRIZZLE">Drizzle</option>
                <option value="HEAVY_RAIN">Heavy Rain</option>
                <option value="TORRENTIAL">Torrential + Thunder</option>
              </select>
              <span className="text-[#232d42]">|</span>
              <Globe size={10} className="text-[#8c9bb5] shrink-0" />
              <select
                aria-label="Select country time zone for skybox"
                value={selectedCountryId}
                onChange={(e) => setSelectedCountryId(e.target.value)}
                className="bg-[#0a0d12] border border-[#232d42] text-[#e1e2ea] text-[9px] uppercase px-1 py-0.5 focus:outline-none focus:border-[#00f0ff] cursor-pointer max-w-[112px]"
              >
                {COUNTRY_TIME_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void handleManualWorldTimeSync(selectedCountryId)}
                disabled={isSyncingWorldTime}
                aria-label="Refresh world time and weather now"
                title={`Sync ${worldTime.city} time & weather now`}
                className="text-[#8c9bb5] hover:text-[#00f0ff] disabled:opacity-50 cursor-pointer"
              >
                <RefreshCw
                  size={10}
                  className={isSyncingWorldTime ? 'animate-spin text-[#00f0ff]' : ''}
                />
              </button>
              <button
                type="button"
                onClick={() => setShowWeatherDebug((v) => !v)}
                aria-label="Toggle weather debug controls"
                title="Weather Debug Controls (Rain, Dark Clouds, Lightning)"
                className={`px-1 py-0.5 border text-[8.5px] font-bold uppercase cursor-pointer transition-colors ${
                  showWeatherDebug ||
                  debugRainPct !== null ||
                  debugDarkCloudsPct !== null ||
                  debugLightningMode !== 'AUTO'
                    ? 'bg-[#00f0ff]/20 border-[#00f0ff] text-[#00f0ff]'
                    : 'bg-[#0a0d12] border-[#232d42] text-[#8c9bb5] hover:text-[#e1e2ea]'
                }`}
              >
                DBG
              </button>
            </div>
            {cursorShown && !isPaused && (
              <div className="bg-[#0a0d12]/90 border border-[#00f0ff] px-2 py-0.5 font-mono text-[10px] text-[#00f0ff] flex items-center gap-1">
                <MousePointer size={10} />
                <span>CURSOR</span>
              </div>
            )}
            <div className="bg-[#070a0f]/90 border border-[#1e2638] px-2 py-0.5 font-mono text-[10px] font-bold tabular-nums tracking-[0.06em] text-[#20df78]">
              {fpsCount} FPS
            </div>
          </div>

          {showWeatherDebug && (
            <div
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              className={`${
                hideViewportCursor ? 'pointer-events-none' : 'pointer-events-auto'
              } w-60 bg-[#070a0f]/96 border border-[#00f0ff]/60 p-2.5 font-mono text-[10px] text-[#e1e2ea] space-y-2 shadow-[0_6px_18px_rgba(0,0,0,0.75)]`}
            >
              <div className="flex items-center justify-between border-b border-[#1e2638] pb-1">
                <span className="font-bold text-[#00f0ff] uppercase tracking-[0.08em]">
                  Weather Debug
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setDebugRainPct(null);
                    setDebugDarkCloudsPct(null);
                    setDebugLightningMode('AUTO');
                    setWeatherOverride('LIVE');
                  }}
                  className="text-[9px] text-[#ffb300] hover:underline uppercase cursor-pointer"
                >
                  Reset
                </button>
              </div>

              <label className="block space-y-0.5">
                <div className="flex justify-between text-[9px] text-[#8c9bb5]">
                  <span>RAIN INTENSITY</span>
                  <span className="text-[#6cb6ff] tabular-nums">
                    {debugRainPct === null ? 'AUTO' : `${debugRainPct}%`}
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={debugRainPct ?? Math.round(activeWeather.rainIntensity * 100)}
                  onChange={(e) => setDebugRainPct(Number(e.target.value))}
                  className="w-full accent-[#00f0ff] cursor-pointer"
                />
              </label>

              <label className="block space-y-0.5">
                <div className="flex justify-between text-[9px] text-[#8c9bb5]">
                  <span>DARK CLOUDS</span>
                  <span className="text-[#a5b4cf] tabular-nums">
                    {debugDarkCloudsPct === null ? 'AUTO' : `${debugDarkCloudsPct}%`}
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={debugDarkCloudsPct ?? Math.round(activeWeather.cloudDarkness * 100)}
                  onChange={(e) => setDebugDarkCloudsPct(Number(e.target.value))}
                  className="w-full accent-[#ffb300] cursor-pointer"
                />
              </label>

              <div className="flex items-center justify-between gap-1.5 pt-0.5">
                <button
                  type="button"
                  onClick={() =>
                    setDebugLightningMode((m) =>
                      m === 'AUTO' ? 'ON' : m === 'ON' ? 'OFF' : 'AUTO'
                    )
                  }
                  className={`flex-1 px-1.5 py-1 border text-[9px] font-bold uppercase cursor-pointer ${
                    debugLightningMode === 'ON'
                      ? 'bg-[#00f0ff]/20 border-[#00f0ff] text-[#00f0ff]'
                      : debugLightningMode === 'OFF'
                        ? 'bg-[#ff2a4b]/15 border-[#ff2a4b] text-[#ff2a4b]'
                        : 'bg-[#0f141d] border-[#232d42] text-[#8c9bb5]'
                  }`}
                >
                  STORM: {debugLightningMode}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    simRef.current.lightningStrikeNowPending = true;
                  }}
                  className="px-2 py-1 border border-[#ffb300] bg-[#ffb300]/15 text-[#ffb300] hover:bg-[#ffb300] hover:text-[#0a0d12] text-[9px] font-bold uppercase cursor-pointer"
                >
                  STRIKE NOW
                </button>
              </div>
            </div>
          )}

          <TacticalMinimap snapshotRef={minimapSnapshotRef} />
        </div>

        {/* Blended Pre-Deployment Loadout Overlay scoped strictly to Viewport */}
        {startOverlay}

        {/* In-Viewport Tactical Inventory ([E] Key + Drag-to-Equip) */}
        {inventoryOpen && !isPaused && isScreenActive && (
          <ViewportInventoryModal
            config={config}
            weapons={weapons}
            grenades={grenades}
            consumableUsages={consumableUsages}
            weaponAmmoMap={weaponAmmoMap}
            hoveredItemRef={hoveredInventoryItemRef}
            onEquipWeapon={(slot, wId) => onSelectSlotWeapon(slot, wId, true)}
            onEquipConsumable={(gId) => {
              onSelectGrenade(gId);
              onSwitchActiveSlot('CONSUMABLE');
            }}
            onClose={() => {
              const s = simRef.current;
              s.inventoryOpen = false;
              s.unlockedByCtrl = false;
              setInventoryOpen(false);
              soundEngine.playInventoryToggle(false);
              centerViewportCursorRef.current?.(100, true);
              const canvasEl = mountRef.current?.querySelector('canvas');
              if (canvasEl) {
                const rect = (viewportRef.current ?? canvasEl).getBoundingClientRect();
                s.prevClientX = rect.left + rect.width * 0.5;
                s.prevClientY = rect.top + rect.height * 0.5;
                canvasEl.focus({ preventScroll: true });
              }
            }}
          />
        )}

        {/* Player Death Overlay ("You died") with greyscale backdrop state */}
        {!startOverlay && !isPaused && playerHp <= 0 && (
          <div
            onMouseDown={(e) => e.stopPropagation()}
            className="absolute inset-0 z-[29] bg-[#0a0d12]/65 flex items-center justify-center p-6"
          >
            <div className="w-full max-w-sm bg-[#121721]/96 border border-[#ff2a4b] p-5 space-y-4 text-center shadow-[0_0_24px_rgba(255,42,75,0.28)]">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#ff2a4b]">
                  Operator Down // Signal Lost
                </div>
                <h3 className="mt-1 font-display text-2xl font-bold uppercase tracking-[0.06em] text-[#e1e2ea]">
                  You died
                </h3>
                <p className="mt-1 font-mono text-[11px] text-[#8c9bb5]">
                  Fallen on Wave {waveNumber} · {focusedHud.aliveCount}/{focusedHud.totalCount} Hostiles Remaining
                </p>
              </div>

              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => {
                    setWave5Won(false);
                    centerViewportCursorRef.current?.(140, true);
                    onResetRange();
                  }}
                  className="chamfer-sm w-full py-2.5 px-4 bg-[#ff2a4b] hover:bg-[#ffb300] text-[#0a0d12] font-mono text-xs font-bold uppercase tracking-[0.1em] transition-colors cursor-pointer"
                >
                  Respawn &amp; Restart
                </button>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={onOpenRooms}
                    className="py-2 px-3 border border-[#232d42] bg-[#0f141d] text-[#00f0ff] hover:border-[#00f0ff] font-mono text-[11px] uppercase cursor-pointer"
                  >
                    Switch Room
                  </button>
                  {onOpenLoadout ? (
                    <button
                      type="button"
                      onClick={onOpenLoadout}
                      className="py-2 px-3 border border-[#232d42] bg-[#0f141d] text-[#ffb300] hover:border-[#ffb300] font-mono text-[11px] uppercase cursor-pointer"
                    >
                      Loadout
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onSetPaused(true)}
                      className="py-2 px-3 border border-[#232d42] bg-[#0f141d] text-[#8c9bb5] hover:border-[#ffb300] font-mono text-[11px] uppercase cursor-pointer"
                    >
                      Pause Menu
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Wave 5 Victory Overlay ("You won!") */}
        {!startOverlay && !isPaused && playerHp > 0 && wave5Won && (
          <div
            onMouseDown={(e) => e.stopPropagation()}
            className="absolute inset-0 z-[29] bg-[#0a0d12]/72 flex items-center justify-center p-6"
          >
            <div className="w-full max-w-sm bg-[#121721]/96 border border-[#20df78] p-5 space-y-4 text-center shadow-[0_0_24px_rgba(32,223,120,0.28)]">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#20df78]">
                  Sector Secured // Wave 5 Complete
                </div>
                <h3 className="mt-1 font-display text-2xl font-bold uppercase tracking-[0.06em] text-[#e1e2ea]">
                  You won!
                </h3>
                <p className="mt-1 font-mono text-[11px] text-[#8c9bb5]">
                  All 5 hostile waves eliminated · Remaining HP {playerHp}/{maxPlayerHp}
                </p>
              </div>

              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => {
                    setWave5Won(false);
                    centerViewportCursorRef.current?.(140, true);
                    onResetRange();
                  }}
                  className="chamfer-sm w-full py-2.5 px-4 bg-[#20df78] hover:bg-[#00f0ff] text-[#0a0d12] font-mono text-xs font-bold uppercase tracking-[0.1em] transition-colors cursor-pointer"
                >
                  Play Again (Wave 1)
                </button>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setWave5Won(false);
                      centerViewportCursorRef.current?.(140, true);
                      onStartNextWave();
                    }}
                    className="py-2 px-3 border border-[#00f0ff]/60 bg-[#0f141d] text-[#00f0ff] hover:border-[#00f0ff] font-mono text-[11px] uppercase cursor-pointer"
                  >
                    Continue Wave 6
                  </button>
                  <button
                    type="button"
                    onClick={onOpenRooms}
                    className="py-2 px-3 border border-[#232d42] bg-[#0f141d] text-[#ffb300] hover:border-[#ffb300] font-mono text-[11px] uppercase cursor-pointer"
                  >
                    Switch Room
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Pause Overlay (Keybinds shown ONLY on pause menu; hidden whenever Start/Loadout screen is visible) */}
        {!startOverlay && isPaused && (
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
                <div>1 / 2 / Wheel: Primary · Secondary · Consumable · R: Reload</div>
                <div>3–9: Select Grenades, Mines, Sticky C4 &amp; Sentry Turret</div>
                <div>E: Pick Up Placed Trap (&lt;2m) / Inventory (Drag to Equip)</div>
                <div>LMB: Fire / Melee (Hold: Charge) · RMB: ADS · Melee Shove</div>
                <div>MMB (Hold &amp; Release): Throw/Deploy · MMB (Click): Detonate C4</div>
                <div>F: Flashlight (Spot / Flood) · Q: Medic Kit (+40% HP)</div>
                <div>Ctrl (Hold): Show Cursor · F11: Fullscreen · Esc: Pause / Resume</div>
              </div>

              <div className="space-y-2">
                <button
                  type="button"
                  onClick={handleResumeCombat}
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
                {onOpenLoadout && (
                  <button
                    type="button"
                    onClick={onOpenLoadout}
                    className="w-full py-2 px-3 border border-[#232d42] bg-[#0f141d] text-[#ffb300] hover:border-[#ffb300] font-mono text-[11px] uppercase cursor-pointer"
                  >
                    Weapon Loadout Screen
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Dropped Ammo Pickup Confirmation Banner */}
        {ammoToast && (
          <div className="pointer-events-none absolute bottom-24 left-4 z-20 bg-[#0a0d12]/92 border border-[#20df78] px-3 py-1 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-[#20df78] shadow-[0_0_12px_rgba(32,223,120,0.3)]">
            {ammoToast}
          </div>
        )}

        {/* Bottom HUD Strip */}
        <div className="absolute bottom-3 left-4 right-4 z-10 flex flex-wrap items-end justify-between gap-3 pointer-events-none">
          <div
            className={`bg-[#0a0d12]/88 border border-[#1e2638] px-3 py-2 space-y-1.5 ${
              hideViewportCursor ? 'pointer-events-none' : 'pointer-events-auto'
            }`}
          >
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

          <div
            className={`bg-[#0f141d]/92 border border-[#232d42] px-3 py-2 flex flex-col gap-1.5 font-mono text-xs tabular-nums ${
              hideViewportCursor ? 'pointer-events-none' : 'pointer-events-auto'
            }`}
          >
            <div className="flex items-center justify-between gap-2.5">
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => onSwitchActiveSlot('PRIMARY')}
                  className={`px-1.5 py-0.5 text-[10px] font-bold border cursor-pointer ${
                    config.activeSlot === 'PRIMARY'
                      ? 'bg-[#ffb300] border-[#ffb300] text-[#0a0d12]'
                      : 'bg-[#0a0d12] border-[#232d42] text-[#8c9bb5] hover:text-[#e1e2ea]'
                  }`}
                >
                  [1]
                </button>
                <button
                  type="button"
                  onClick={() => onSwitchActiveSlot('SECONDARY')}
                  className={`px-1.5 py-0.5 text-[10px] font-bold border cursor-pointer ${
                    config.activeSlot === 'SECONDARY'
                      ? 'bg-[#00f0ff] border-[#00f0ff] text-[#0a0d12]'
                      : 'bg-[#0a0d12] border-[#232d42] text-[#8c9bb5] hover:text-[#e1e2ea]'
                  }`}
                >
                  [2]
                </button>
                <button
                  type="button"
                  onClick={onToggleConsumableSlot}
                  className={`px-1.5 py-0.5 text-[10px] font-bold border cursor-pointer ${
                    isConsumableSlot
                      ? 'bg-[#20df78] border-[#20df78] text-[#0a0d12]'
                      : 'bg-[#0a0d12] border-[#232d42] text-[#20df78] hover:border-[#20df78]'
                  }`}
                >
                  ORD
                </button>
              </div>

              <div className="flex items-center gap-2 text-[10px]">
                <span style={{ color: activeConsumable.accentHex }} className="uppercase">
                  {activeConsumable.shortLabel}
                </span>
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
                  className={`flex items-center gap-1 uppercase cursor-pointer transition-colors ${
                    isMuted ? 'text-[#ff2a4b]' : 'text-[#20df78] hover:text-[#00f0ff]'
                  }`}
                >
                  {isMuted ? <VolumeX size={12} /> : <Volume2 size={12} />}
                  <span>{isMuted ? 'MUTED' : 'SFX'}</span>
                </button>
              </div>
            </div>

            {isConsumableSlot ? (
              <div className="flex flex-col items-end gap-1">
                <div className="flex items-end justify-between w-full gap-4">
                  <div className="flex flex-col leading-tight text-[10px]">
                    <span style={{ color: activeConsumable.accentHex }} className="font-bold uppercase">
                      {activeConsumable.shortLabel}
                    </span>
                    <span
                      className={
                        (consumableUsages[activeConsumable.id] ?? 0) <= 0
                          ? 'text-[#ff2a4b] font-bold'
                          : grenadeCooldownSec > 0
                            ? 'text-[#ff2a4b]'
                            : 'text-[#20df78] font-bold'
                      }
                    >
                      {(consumableUsages[activeConsumable.id] ?? 0) <= 0
                        ? 'EMPTY'
                        : turretCapReached
                          ? 'MAX ACTIVE'
                          : grenadeCooldownSec > 0
                            ? `CD ${grenadeCooldownSec.toFixed(1)}S`
                            : 'HOLD [MMB]'}
                    </span>
                  </div>
                  <div className="flex items-start leading-none select-none">
                    <span
                      className={`text-[28px] font-bold tracking-tight ${
                        (consumableUsages[activeConsumable.id] ?? 0) === 0
                          ? 'text-[#ff2a4b]'
                          : 'text-[#20df78]'
                      }`}
                    >
                      {consumableUsages[activeConsumable.id] ?? 0}
                    </span>
                    <span className="text-[26px] font-light text-[#606f89] mx-1.5 leading-none">/</span>
                    <span className="text-sm font-semibold text-[#e1e2ea] pt-0.5">
                      {activeConsumable.maxUsages}
                    </span>
                  </div>
                </div>
                {(plantedC4Count > 0 || activeTurretCount > 0) && (
                  <div className="text-[#d8b4fe] text-[10px]">
                    {plantedC4Count > 0 ? `C4:${plantedC4Count} [MMB] ` : ''}
                    {activeTurretCount > 0 ? `TURRET:${activeTurretCount}/${activeConsumable.id === 'deployable_turret' ? (activeConsumable.turretMaxDeployed ?? 3) : 3}` : ''}
                  </div>
                )}
              </div>
            ) : isMelee ? (
              <div className="flex items-center justify-between gap-3 pt-0.5">
                <span className="text-[#8c9bb5] text-[10px] uppercase">{weapon.code}</span>
                <span className="text-[#ffb300] text-sm font-bold">MELEE READY</span>
                <span className="text-[#00f0ff] text-[10px]">
                  SHOVE {weapon.melee!.shoveStaggerDamage} STAG
                </span>
              </div>
            ) : (
              <div className="flex flex-col items-end">
                {/* Compact enlarged Mag / Reserve layout matching reference demo with reload underneath */}
                <div className="flex items-end justify-between w-full gap-4">
                  <div className="flex flex-col leading-tight text-[10px] text-[#8c9bb5]">
                    <span className="uppercase">{weapon.code}</span>
                    <span className="text-[#00f0ff]">{weapon.rpm} RPM</span>
                  </div>
                  <div className="flex items-start leading-none select-none">
                    <span
                      className={`text-[28px] font-bold tracking-tight ${
                        magRemaining === 0 ? 'text-[#ff2a4b]' : 'text-[#ffb300]'
                      }`}
                    >
                      {magRemaining}
                    </span>
                    <span className="text-[26px] font-light text-[#606f89] mx-1.5 leading-none">/</span>
                    <span className="text-sm font-semibold text-[#e1e2ea] pt-0.5">
                      {reserveAmmo}
                    </span>
                  </div>
                </div>

                {/* Reload status bar strictly below the ammo readout so numbers always remain unobstructed */}
                {isReloading && (
                  <div className="w-full mt-1 space-y-0.5">
                    <div className="flex items-center justify-between text-[9px] text-[#ff2a4b] font-bold uppercase tracking-[0.06em]">
                      <span>RELOADING</span>
                      <span>{reloadProgress}%</span>
                    </div>
                    <div className="w-full h-1 bg-[#121721] border border-[#232d42]">
                      <div
                        className="h-full bg-[#ff2a4b] transition-all duration-75"
                        style={{ width: `${reloadProgress}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}
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
