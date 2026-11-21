export type AppScreen = 'range' | 'rooms' | 'armory' | 'targets' | 'telemetry';

export type RoomLayoutId = 'corridor_01' | 'double_flank_02';

export type WeaponDamageType = 'KINETIC' | 'RAIL' | 'PLASMA' | 'BUCKSHOT' | 'MELEE';

export type WeaponClass = 'RANGED' | 'MELEE';

export type FiringMode = 'AUTO_BURST' | 'SEMI_PRECISION' | 'FULL_AUTO';

export type HitZoneId = 'weakspot' | 'torso' | 'limb';

export type TargetSilhouette = 'exo' | 'mech' | 'titan' | 'drone';

export type EnemyApproachPattern = 'ADAPTIVE' | 'STRAIGHT_CHARGE' | 'WEAVE_BREAK';

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
  specialChargeSec: number; // 2.2s for hammer, 0.7s for halberd
  specialChainAltSweep: boolean; // halberd: L->R then R->L if 2nd hit is special
  shoveDamage: number;
  shoveStaggerDamage: number;
  shoveCooldownSec: number;
}

export interface WeaponProfile {
  id: string;
  code: string;
  name: string;
  role: string;
  caliber: string;
  weaponClass: WeaponClass;
  damageType: WeaponDamageType;
  baseDamage: number;
  pellets: number; // 1 for standard rifles, 12 for shotgun
  spreadConeDeg: number; // pellet/shot dispersion cone
  rpm: number;
  muzzleVelocity: number; // m/s
  magSize: number;
  reloadTimeMs: number;
  falloffStartM: number;
  falloffEndM: number;
  falloffPerMeter: number; // flat damage reduction per meter per projectile
  minFalloffFactor: number; // non-zero floor ratio at end range
  penetrationDepthM: number; // max armor/body thickness in meters bullet can pierce through
  penetrationDropPct: number; // % damage lost per pierced enemy (e.g. 30 => 30% lesser damage)
  adsFov: number;
  baseSpreadDeg: number;
  recoilPattern: RecoilStep[];
  recoilCoeff: RecoilCoefficientProfile;
  armorPenetration: number; // 0 to 1
  critMultiplier: number; // weakspot multiplier (used explicitly by melee weapons: 2.0 / 2.4)
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
  firingMode: FiringMode;
  targetId: string;
  targetHp: number;
  distanceM: number;
  aimZone: HitZoneId;
  approachPattern: EnemyApproachPattern;
  groupSize: number; // 1 to 60 enemies
  waveGroupSizes: number[]; // configurable squad size per wave (up to 60)
  chassisSpawnCounts: Record<string, number>; // per-chassis wave-1 spawn counts linked to wave progression
  mixedGroup: boolean;
  burstRounds: number;
  roomId: RoomLayoutId;
}

export interface CombatLogEntry {
  id: string;
  timestampMs: number;
  roundNumber: number;
  source?:
    | 'PLAYER'
    | 'PLAYER_MELEE'
    | 'PLAYER_SHOVE'
    | 'PLAYER_MEDKIT'
    | 'ENEMY_CLAW'
    | 'ENEMY_DUAL_CLAW'
    | 'ENEMY_DRONE_BOLT';
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
