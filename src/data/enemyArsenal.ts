import {
  EnemyInternalComponents,
  EnemyLoadoutSpec,
  EnemyMeleeWeaponId,
  EnemyRangedWeaponId,
  EnemyWeaponSpec,
  TargetProfile,
  TargetSilhouette,
} from '../types/ballistics';

/**
 * Authoritative weapon telemetry for hostile units (ranged firearms, ATGM, rocket pods,
 * and dedicated Long Sword / Great Sword / Halberd melee rigs).
 */
export const ENEMY_WEAPONS: Record<
  EnemyRangedWeaponId | EnemyMeleeWeaponId,
  EnemyWeaponSpec
> = {
  enemy_ar: {
    id: 'enemy_ar',
    kind: 'RANGED',
    name: 'Assault Rifle',
    damage: 0.02,
    pellets: 1,
    rpm: 150,
    reloadSec: 4.5,
    magSize: 30,
    recoilPerShotDeg: 1.85,
    baseSpreadDeg: 2.8,
    recoilRecoverPerSec: 3.4,
    projectileSpeed: 68,
    colorHex: 0xffb300,
  },
  enemy_shotgun: {
    id: 'enemy_shotgun',
    kind: 'RANGED',
    name: 'Shotgun',
    damage: 0.6,
    pellets: 15,
    rpm: 100,
    reloadSec: 6.0,
    magSize: 6,
    recoilPerShotDeg: 7.2,
    baseSpreadDeg: 6.4,
    recoilRecoverPerSec: 4.2,
    projectileSpeed: 58,
    colorHex: 0xff6a00,
  },
  enemy_plasma: {
    id: 'enemy_plasma',
    kind: 'RANGED',
    name: 'Plasma Rifle',
    damage: 4,
    pellets: 1,
    rpm: 60,
    reloadSec: 9.0,
    magSize: 2,
    recoilPerShotDeg: 6.8,
    baseSpreadDeg: 2.2,
    recoilRecoverPerSec: 3.0,
    projectileSpeed: 40,
    colorHex: 0x00f0ff,
  },
  enemy_20mm: {
    id: 'enemy_20mm',
    kind: 'RANGED',
    name: '20mm Cannon',
    damage: 1.4,
    pellets: 1,
    rpm: 140,
    reloadSec: 6.0,
    magSize: 12,
    recoilPerShotDeg: 3.4,
    baseSpreadDeg: 2.6,
    recoilRecoverPerSec: 4.0,
    projectileSpeed: 54,
    colorHex: 0xff4422,
  },
  enemy_atgm: {
    id: 'enemy_atgm',
    kind: 'RANGED',
    name: 'ATGM Launcher',
    damage: 6,
    pellets: 1,
    rpm: 300,
    reloadSec: 12.0,
    magSize: 2,
    recoilPerShotDeg: 3.2,
    baseSpreadDeg: 1.4,
    recoilRecoverPerSec: 3.6,
    projectileSpeed: 21,
    homingTurnRateRad: 0.88,
    colorHex: 0xff2a4b,
  },
  enemy_rocket_pods: {
    id: 'enemy_rocket_pods',
    kind: 'RANGED',
    name: 'Rocket Pods',
    damage: 3,
    pellets: 1,
    rpm: 500,
    reloadSec: 18.0,
    magSize: 24,
    recoilPerShotDeg: 0.55,
    baseSpreadDeg: 2.4,
    recoilRecoverPerSec: 5.5,
    projectileSpeed: 24,
    colorHex: 0xff7b29,
  },
  enemy_long_sword: {
    id: 'enemy_long_sword',
    kind: 'MELEE',
    name: 'Long Sword',
    damage: 19,
    pellets: 1,
    rpm: 165,
    reloadSec: 0,
    magSize: 1,
    recoilPerShotDeg: 0,
    baseSpreadDeg: 0,
    recoilRecoverPerSec: 0,
    projectileSpeed: 0,
    swingDurationSec: 0.36,
    swingStyle: 'LONG_SWORD',
    colorHex: 0xd8dee9,
  },
  enemy_great_sword: {
    id: 'enemy_great_sword',
    kind: 'MELEE',
    name: 'Great Sword',
    damage: 32,
    pellets: 1,
    rpm: 72,
    reloadSec: 0,
    magSize: 1,
    recoilPerShotDeg: 0,
    baseSpreadDeg: 0,
    recoilRecoverPerSec: 0,
    projectileSpeed: 0,
    swingDurationSec: 0.84,
    swingStyle: 'GREAT_SWORD',
    colorHex: 0xffb300,
  },
  enemy_halberd: {
    id: 'enemy_halberd',
    kind: 'MELEE',
    name: 'Halberd',
    damage: 18,
    comboDamages: [18, 26, 42],
    pellets: 1,
    rpm: 112,
    reloadSec: 0,
    magSize: 1,
    recoilPerShotDeg: 0,
    baseSpreadDeg: 0,
    recoilRecoverPerSec: 0,
    projectileSpeed: 0,
    swingDurationSec: 0.52,
    swingStyle: 'HALBERD',
    colorHex: 0x00f0ff,
  },
};

const RANGED_POOL: EnemyRangedWeaponId[] = [
  'enemy_ar',
  'enemy_shotgun',
  'enemy_plasma',
  'enemy_20mm',
];

const MELEE_POOL: EnemyMeleeWeaponId[] = [
  'enemy_long_sword',
  'enemy_great_sword',
  'enemy_halberd',
];

/**
 * Deterministically assigns shields, melee blades, ranged rifles/cannons, ATGM, and Brute rocket pods
 * based on enemy silhouette and spawn index.
 */
export function getEnemyLoadoutForSpawn(
  silhouette: TargetSilhouette,
  uid: number
): EnemyLoadoutSpec {
  if (silhouette === 'drone') {
    return {
      hasShield: false,
      shieldMaxHp: 0,
      rangedWeaponId: 'enemy_atgm',
      meleeWeaponId: null,
      rocketPodWeaponId: null,
    };
  }

  if (silhouette === 'mech' || silhouette === 'swarmer') {
    const rangedPick =
      silhouette === 'swarmer'
        ? (uid % 2 === 0 ? 'enemy_ar' : 'enemy_shotgun')
        : RANGED_POOL[uid % RANGED_POOL.length];
    return {
      hasShield: false,
      shieldMaxHp: 0,
      rangedWeaponId: rangedPick,
      meleeWeaponId: null,
      rocketPodWeaponId: null,
    };
  }

  if (silhouette === 'brute') {
    // Brute gets large shields, melee weapons, or ranged weapons PLUS larger shoulder rocket pods
    const variant = uid % 3;
    return {
      hasShield: variant !== 1,
      shieldMaxHp: variant !== 1 ? 185 : 0,
      rangedWeaponId: variant === 1 ? RANGED_POOL[uid % RANGED_POOL.length] : null,
      meleeWeaponId: variant !== 1 ? MELEE_POOL[uid % MELEE_POOL.length] : null,
      rocketPodWeaponId: 'enemy_rocket_pods',
    };
  }

  // exo (Aegis), titan (Chitin Titan), tank (Bastion Juggernaut):
  // get large shields, melee weapons (Long Sword / Great Sword / Halberd), or ranged weapons
  const roleMod = uid % 3;
  if (roleMod === 0) {
    // Shield + Melee vanguard
    return {
      hasShield: true,
      shieldMaxHp: silhouette === 'tank' ? 320 : silhouette === 'titan' ? 240 : 170,
      rangedWeaponId: null,
      meleeWeaponId: MELEE_POOL[uid % MELEE_POOL.length],
      rocketPodWeaponId: null,
    };
  }
  if (roleMod === 1) {
    // Shield + Ranged heavy trooper
    return {
      hasShield: true,
      shieldMaxHp: silhouette === 'tank' ? 300 : silhouette === 'titan' ? 220 : 160,
      rangedWeaponId: RANGED_POOL[(uid + 1) % RANGED_POOL.length],
      meleeWeaponId: null,
      rocketPodWeaponId: null,
    };
  }
  // Unshielded heavy weapon / two-handed melee bruiser
  const useRanged = uid % 2 === 0;
  return {
    hasShield: false,
    shieldMaxHp: 0,
    rangedWeaponId: useRanged ? RANGED_POOL[(uid + 2) % RANGED_POOL.length] : null,
    meleeWeaponId: useRanged ? null : MELEE_POOL[(uid + 1) % MELEE_POOL.length],
    rocketPodWeaponId: null,
  };
}

/** Initializes internal sub-components scaled to the enemy profile's default HP. */
export function buildInitialEnemyComponents(profile: TargetProfile): EnemyInternalComponents {
  const hp = Math.max(60, profile.defaultHp);
  const psMax = Math.max(40, Math.round(hp * 0.24));
  const batMax = Math.max(36, Math.round(hp * 0.22));
  const lensMax = Math.max(24, Math.round(hp * 0.14));
  const mechMax = Math.max(38, Math.round(hp * 0.22));

  const capHead = Math.max(26, Math.round(hp * 0.16));
  const capTorso = Math.max(42, Math.round(hp * 0.26));
  const capArm = Math.max(28, Math.round(hp * 0.17));
  const capLeg = Math.max(30, Math.round(hp * 0.18));

  const siphonPool: EnemyInternalComponents['batterySiphonTarget'][] = [
    'leftArm',
    'rightArm',
    'leftLeg',
    'rightLeg',
    'torso',
    'head',
  ];

  return {
    powerSupplyHp: psMax,
    powerSupplyMaxHp: psMax,
    powerSupplyExploded: false,
    batteryHp: batMax,
    batteryMaxHp: batMax,
    batteryExploded: false,
    batterySiphonTarget:
      siphonPool[Math.floor(Math.random() * siphonPool.length)] ?? 'torso',
    viewingLensHp: lensMax,
    viewingLensMaxHp: lensMax,
    mechanismsHp: mechMax,
    mechanismsMaxHp: mechMax,
    capacitors: {
      head: capHead,
      torso: capTorso,
      leftArm: capArm,
      rightArm: capArm,
      leftLeg: capLeg,
      rightLeg: capLeg,
    },
    capacitorsMax: {
      head: capHead,
      torso: capTorso,
      leftArm: capArm,
      rightArm: capArm,
      leftLeg: capLeg,
      rightLeg: capLeg,
    },
    regionHits: {
      head: 0,
      torso: 0,
      leftArm: 0,
      rightArm: 0,
      leftLeg: 0,
      rightLeg: 0,
      shield: 0,
    },
  };
}
