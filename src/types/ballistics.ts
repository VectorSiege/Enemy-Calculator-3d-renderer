/**
 * Core domain types for ballistics simulation, weapon/enemy configuration,
 * room geometry selection, grenade ordinance, and live combat telemetry.
 */

export type AppScreen = 'range' | 'rooms' | 'armory' | 'targets' | 'telemetry';

export type RoomLayoutId = 'corridor_01' | 'double_flank_02';

export type WeaponDamageType = 'KINETIC' | 'RAIL' | 'PLASMA' | 'BUCKSHOT' | 'MELEE';

export type WeaponClass = 'RANGED' | 'MELEE';

export type WeaponSlot = 'PRIMARY' | 'SECONDARY' | 'CONSUMABLE';

export type WeaponCategory =
  | 'CARBINE'
  | 'DMR'
  | 'LMG'
  | 'SMG'
  | 'SHOTGUN'
  | 'BATTLE_RIFLE'
  | 'GPMG'
  | 'SNIPER'
  | 'PISTOL'
  | 'MELEE';

export type FiringMode = 'AUTO_BURST' | 'SEMI_PRECISION' | 'FULL_AUTO';

export type HitZoneId = 'weakspot' | 'torso' | 'limb';

/** 3D procedural mesh & AI archetype identifier */
export type TargetSilhouette =
  | 'exo'
  | 'mech'
  | 'titan'
  | 'drone'
  | 'tank'
  | 'swarmer'
  | 'brute';

export type EnemyApproachPattern = 'ADAPTIVE' | 'STRAIGHT_CHARGE' | 'WEAVE_BREAK';

/** Tactical grenade & deployable consumable ordinance identifiers */
export type GrenadeId =
  | 'stun'
  | 'incendiary'
  | 'explosive'
  | 'trip_mine'
  | 'laser_trip_mine'
  | 'sticky_c4'
  | 'deployable_turret';

export type ConsumableKind =
  | 'GRENADE'
  | 'TRIP_MINE'
  | 'LASER_TRIP_MINE'
  | 'STICKY_C4'
  | 'TURRET';

export interface GrenadeProfile {
  id: GrenadeId;
  kind: ConsumableKind;
  code: string;
  name: string;
  shortLabel: string;
  radiusM: number;
  effectiveRangeM?: number;
  dropRangeM?: number;
  damage: number;
  impactDamage?: number;
  weakspotMultiplier?: number;
  armorReduction?: number;
  pierceDepthM?: number;
  staggerDamage: number;
  /** Multiplier applied to enemy base staggerDurationSec on stun impact (e.g. 2.0 = +100%) */
  staggerDurationMult: number;
  dotDamagePerTick?: number;
  dotIntervalSec?: number;
  dotDurationSec?: number;
  slowPct?: number;
  turretHp?: number;
  turretArmorMult?: number;
  turretMaxDeployed?: number;
  cooldownSec: number;
  maxUsages: number;
  accentHex: string;
  description: string;
}

export interface RecoilStep {
  yawDeg: number; // + right, - left
  pitchDeg: number; // + up
}

export interface RecoilCoefficientProfile {
  initialScale: number; // gentler initial shots so aim isn't thrown off immediately
  perShotIncrement: number; // progressive buildup per round fired
  maxScale: number; // ceiling recoil multiplier under sustained fire
  decayPerSec: number; // cooldown rate once trigger is released
  swayGain: number; // additional sway multiplier as heat climbs
}

export interface MeleeComboStep {
  label: string;
  damage: number;
  isAoe: boolean;
  aoeArcDeg: number;
  durationSec: number;
  staggerMultiplier?: number;
  animStyle:
    | 'HAMMER_TR_TO_B'
    | 'HAMMER_TL_TO_B'
    | 'HAMMER_R_TO_L'
    | 'HALBERD_LUNGE'
    | 'HALBERD_BACK_CHOP'
    | 'HALBERD_DIAG_SWEEP';
}

export interface MeleeSpec {
  reachM: number;
  comboSteps: MeleeComboStep[];
  specialDamage: number;
  specialIsAoe: boolean;
  specialChargeSec: number; // 1.2s for hammer, 0.7s for halberd
  specialChainAltSweep: boolean; // halberd: L->R then R->L if 2nd hit is special
  shoveDamage: number;
  shoveStaggerDamage: number;
  shoveCooldownSec: number;
}

export interface WeaponProfile {
  id: string;
  code: string;
  name: string;
  slot: WeaponSlot;
  category: WeaponCategory;
  defaultFiringMode?: FiringMode;
  targetSpecialty?: string;
  role: string;
  caliber: string;
  weaponClass: WeaponClass;
  damageType: WeaponDamageType;
  baseDamage: number;
  pellets: number; // 1 for standard rifles, 10-12 for shotguns
  spreadConeDeg: number; // pellet/shot dispersion cone
  rpm: number;
  muzzleVelocity: number; // m/s
  magSize: number;
  maxMagazines: number; // total magazines carried (1 loaded + spare reserve mags)
  reloadTimeMs: number;
  shellByShellReload?: boolean; // true for shotguns loading 1 round per cycle
  shellReloadMs?: number; // per-shell reload duration in ms (e.g. 1800ms)
  effectiveRangeM: number; // rated effective range (m) where gradual pre-range decline transitions into steep dropoff
  dropRangeM: number; // terminal drop distance (m) where damage finishes falling to 0
  penetrationDepthM: number; // max armor/body thickness in meters bullet can pierce through
  penetrationDropPct: number; // % damage lost per pierced enemy (e.g. 30 => 30% lesser damage)
  adsFov: number;
  baseSpreadDeg: number;
  recoilPattern: RecoilStep[];
  recoilCoeff: RecoilCoefficientProfile;
  armorPenetration: number; // 0 to 1
  critMultiplier: number; // weakspot multiplier for both ranged & melee weapons
  melee?: MeleeSpec;
  description: string;
}

export interface TargetProfile {
  id: string;
  code: string;
  name: string;
  classification: string;
  silhouette: TargetSilhouette;
  defaultHp: number;
  staggerThreshold: number; // damage/stagger required to break enemy posture into stagger
  staggerDurationSec: number; // how long this enemy remains staggered
  staggerDamageMultiplier: number; // stacks multiplicatively on top of active hit-zone multiplier
  weakspotLabel: string;
  weakspotMultiplier: number;
  torsoMultiplier: number; // armor plate damage multiplier
  limbMultiplier: number; // extremities multiplier
  moveSpeedMps: number;
  maxSpeedMps?: number; // surge/lunge speed ceiling (e.g. Bio-Titan up to 5.8 m/s)
  scaleXZ: number;
  scaleY: number;
  attackSpeedMult: number;
  specialAttackSpeedMult: number;
  clawDamage: number;
  dualClawDamage: number;
  threatRating: string;
  description: string;
}

export interface RoomLayoutProfile {
  id: RoomLayoutId;
  code: string;
  name: string;
  subtitle: string;
  spawnStaggerSec: number;
  entrances: number;
  dimensionsLabel: string;
  description: string;
}

export interface SimulationConfig {
  weaponId: string;
  primaryWeaponId: string;
  secondaryWeaponId: string;
  activeSlot: WeaponSlot;
  firingMode: FiringMode;
  grenadeId: GrenadeId;
  targetId: string;
  targetHp: number;
  distanceM: number;
  aimZone: HitZoneId;
  approachPattern: EnemyApproachPattern;
  groupSize: number; // 1 to 120 enemies
  waveGroupSizes: number[]; // configurable squad size per wave (up to 120)
  chassisSpawnCounts: Record<string, number>; // per-chassis wave-1 spawn counts linked to wave progression
  mixedGroup: boolean;
  burstRounds: number;
  roomId: RoomLayoutId;
}

export type BodyRegionKey =
  | 'head'
  | 'torso'
  | 'leftArm'
  | 'rightArm'
  | 'leftLeg'
  | 'rightLeg'
  | 'shield';

export type EnemyRangedWeaponId =
  | 'enemy_ar'
  | 'enemy_shotgun'
  | 'enemy_plasma'
  | 'enemy_20mm'
  | 'enemy_atgm'
  | 'enemy_rocket_pods';

export type EnemyMeleeWeaponId =
  | 'enemy_long_sword'
  | 'enemy_great_sword'
  | 'enemy_halberd';

export interface EnemyWeaponSpec {
  id: EnemyRangedWeaponId | EnemyMeleeWeaponId;
  kind: 'RANGED' | 'MELEE';
  name: string;
  damage: number;
  comboDamages?: number[];
  pellets: number;
  rpm: number;
  reloadSec: number;
  magSize: number;
  recoilPerShotDeg: number;
  baseSpreadDeg: number;
  recoilRecoverPerSec: number;
  projectileSpeed: number;
  homingTurnRateRad?: number;
  splashRadiusM?: number;
  swingDurationSec?: number;
  swingStyle?: 'LONG_SWORD' | 'GREAT_SWORD' | 'HALBERD';
  colorHex: number;
}

export interface EnemyLoadoutSpec {
  hasShield: boolean;
  shieldMaxHp: number;
  rangedWeaponId: EnemyRangedWeaponId | null;
  meleeWeaponId: EnemyMeleeWeaponId | null;
  rocketPodWeaponId: EnemyRangedWeaponId | null;
}

export interface EnemyInternalComponents {
  powerSupplyHp: number;
  powerSupplyMaxHp: number;
  powerSupplyExploded: boolean;
  batteryHp: number;
  batteryMaxHp: number;
  batteryExploded: boolean;
  batterySiphonTarget: 'leftArm' | 'rightArm' | 'leftLeg' | 'rightLeg' | 'torso' | 'head';
  viewingLensHp: number;
  viewingLensMaxHp: number;
  mechanismsHp: number;
  mechanismsMaxHp: number;
  capacitors: {
    head: number;
    torso: number;
    leftArm: number;
    rightArm: number;
    leftLeg: number;
    rightLeg: number;
  };
  capacitorsMax: {
    head: number;
    torso: number;
    leftArm: number;
    rightArm: number;
    leftLeg: number;
    rightLeg: number;
  };
  headHp: number;
  headMaxHp: number;
  headExploded: boolean;
  limbHp: {
    leftArm: number;
    rightArm: number;
    leftLeg: number;
    rightLeg: number;
  };
  limbMaxHp: {
    leftArm: number;
    rightArm: number;
    leftLeg: number;
    rightLeg: number;
  };
  armsDestroyed: {
    leftArm: boolean;
    rightArm: boolean;
  };
  atgmHp: number;
  atgmMaxHp: number;
  atgmDestroyed: boolean;
  rocketPodHp: number;
  rocketPodMaxHp: number;
  rocketPodDestroyed: boolean;
  regionHits: Record<BodyRegionKey, number>;
}

export interface CombatLogEntry {
  id: string;
  timestampMs: number;
  roundNumber: number;
  source?:
    | 'PLAYER'
    | 'PLAYER_MELEE'
    | 'PLAYER_SHOVE'
    | 'PLAYER_GRENADE'
    | 'PLAYER_TURRET'
    | 'PLAYER_MEDKIT'
    | 'PLAYER_AMMO'
    | 'PLAYER_CONSUMABLE'
    | 'ENEMY_CLAW'
    | 'ENEMY_DUAL_CLAW'
    | 'ENEMY_DRONE_BOLT'
    | 'ENEMY_RANGED'
    | 'ENEMY_MELEE'
    | 'ENEMY_EXPLOSION';
  targetName?: string;
  zone: HitZoneId;
  zoneLabel: string;
  rawDamage: number;
  hpDamage: number;
  remainingHp: number;
  isCrit: boolean;
  isKill: boolean;
  isMiss: boolean;
  isStagger?: boolean;
  enemyTtkMs?: number | null;
  distanceM: number;
}

export interface EngagementMetrics {
  totalRoundsFired: number;
  roundsHit: number;
  weakspotHits: number;
  totalRawDamage: number;
  totalHpDamage: number;
  accuracyPct: number;
  weakspotEfficiencyPct: number;
  elapsedTimeMs: number;
  ttkMs: number | null;
  effectiveDps: number;
  theoreticalStk: number;
  theoreticalTtkMs: number;
}

export interface SavedTelemetryRun {
  id: string;
  recordedAt: string;
  weaponName: string;
  weaponCode: string;
  targetName: string;
  distanceM: number;
  firingMode: FiringMode;
  metrics: EngagementMetrics;
}

/** Normalized body-space coordinate of a shot impact or <=0.1m near-miss on an enemy silhouette. */
export interface EnemyHeatmapSample {
  nx: number; // -1 (left) to +1 (right)
  ny: number; // 0 (feet) to 1 (head/crown)
  zone: HitZoneId | 'miss';
  weaponId: string;
}

/** Per-pellet/impact telemetry event emitted by the 3D arena for live enemy heatmaps & weapon breakdowns. */
export interface ShotTelemetryEvent {
  enemyUid: number;
  targetId: string;
  targetName: string;
  targetCode: string;
  silhouette: TargetSilhouette;
  waveNumber: number;
  zone: HitZoneId | 'miss';
  nx: number;
  ny: number;
  damage: number;
  isKill: boolean;
  enemyTtkMs: number | null;
}

/** Live encounter summary for a single enemy fought in the 3D arena. */
export interface EnemyEncounterRecord {
  enemyUid: number;
  targetId: string;
  targetName: string;
  targetCode: string;
  silhouette: TargetSilhouette;
  waveNumber: number;
  lastWeaponId: string;
  lastWeaponName: string;
  killed: boolean;
  shotsTakenToKill: number;
  hitsWeakspot: number;
  hitsArmor: number;
  hitsExtremity: number;
  nearMisses: number;
  totalDamage: number;
  ttkMs: number | null;
  samples: EnemyHeatmapSample[];
}

/** Per-target TTK & STK aggregate under a specific weapon. */
export interface WeaponTargetTtkStats {
  targetId: string;
  targetName: string;
  targetCode: string;
  kills: number;
  totalTtkMs: number;
  avgTtkMs: number | null;
  totalStk: number;
  avgStk: number | null;
}

/** Cumulative user performance telemetry for a specific weapon platform. */
export interface WeaponPerformanceRecord {
  weaponId: string;
  weaponCode: string;
  weaponName: string;
  category: WeaponCategory;
  shotsFired: number;
  shotsLanded: number;
  totalHits: number;
  weakspotHits: number;
  armorHits: number;
  extremityHits: number;
  nearMisses: number;
  totalDamage: number;
  activeTimeMs: number;
  lastActionMs: number;
  perTarget: Record<string, WeaponTargetTtkStats>;
}

