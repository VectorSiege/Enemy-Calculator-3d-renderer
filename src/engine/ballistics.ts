import { TARGET_PROFILES, WEAPONS } from '../data/arsenal';
import {
  CombatLogEntry,
  EngagementMetrics,
  HitZoneId,
  RecoilStep,
  SimulationConfig,
  TargetProfile,
  WeaponProfile,
} from '../types/ballistics';

export function getWeaponById(id: string, weaponsList: WeaponProfile[] = WEAPONS): WeaponProfile {
  return weaponsList.find((w) => w.id === id) ?? weaponsList[0] ?? WEAPONS[0];
}

export function getTargetById(id: string, targetsList: TargetProfile[] = TARGET_PROFILES): TargetProfile {
  return targetsList.find((t) => t.id === id) ?? targetsList[0] ?? TARGET_PROFILES[0];
}

/**
 * Exact distance falloff curve:
 * - Full 1.0x damage up to weapon.falloffStartM
 * - Decreases by weapon.falloffPerMeter flat damage per meter until weapon.falloffEndM
 * - Clamped to non-zero weapon.minFalloffFactor floor at and beyond falloffEndM
 */
export function computeRangeFalloff(weapon: WeaponProfile, distanceM: number): number {
  if (weapon.weaponClass === 'MELEE') return 1.0;
  if (distanceM <= weapon.falloffStartM) return 1.0;
  const clampedDist = Math.min(distanceM, weapon.falloffEndM);
  const damageDrop = (clampedDist - weapon.falloffStartM) * weapon.falloffPerMeter;
  const effectiveDamage = Math.max(
    weapon.baseDamage * weapon.minFalloffFactor,
    weapon.baseDamage - damageDrop
  );
  return effectiveDamage / Math.max(1, weapon.baseDamage);
}

/**
 * Returns the repeatable recoil step scaled by the weapon's progressive recoil coefficient (recoilHeat 0..1)
 * Initial rounds use initialScale so aim stays steady; sustained fire ramps toward maxScale.
 */
export function getRecoilForShot(
  weapon: WeaponProfile,
  shotIndex: number,
  isAds: boolean,
  recoilHeat = 0
): RecoilStep {
  const pattern = weapon.recoilPattern;
  if (!pattern || pattern.length === 0) return { yawDeg: 0, pitchDeg: 0 };
  const step = pattern[shotIndex % pattern.length];
  const adsDamp = isAds ? 0.68 : 1.0;
  const clampedHeat = Math.max(0, Math.min(1, recoilHeat));
  const { initialScale, maxScale } = weapon.recoilCoeff;
  const coeffScale = initialScale + clampedHeat * (maxScale - initialScale);
  return {
    yawDeg: step.yawDeg * adsDamp * coeffScale,
    pitchDeg: step.pitchDeg * adsDamp * coeffScale,
  };
}

export function computeFalloffEndDamage(weapon: WeaponProfile): number {
  const factor = computeRangeFalloff(weapon, weapon.falloffEndM);
  return Math.round(weapon.baseDamage * factor);
}

export function computePotentialRawDps(weapon: WeaponProfile): number {
  if (weapon.weaponClass === 'MELEE' && weapon.melee) {
    const avgDmg =
      weapon.melee.comboSteps.reduce((acc, s) => acc + s.damage, 0) /
      Math.max(1, weapon.melee.comboSteps.length);
    const avgDur =
      weapon.melee.comboSteps.reduce((acc, s) => acc + s.durationSec, 0) /
      Math.max(1, weapon.melee.comboSteps.length);
    return Math.round(avgDmg / Math.max(0.15, avgDur));
  }
  return Math.round((weapon.baseDamage * weapon.pellets * weapon.rpm) / 60);
}

/**
 * Builds an enemy squad up to 60 units, honoring per-chassis spawn allocations
 * scaled proportionally to the active wave group size.
 */
export function buildSquadRoster(
  primaryTargetId: string,
  groupSize: number,
  mixedGroup: boolean,
  targetsList: TargetProfile[] = TARGET_PROFILES,
  chassisSpawnCounts?: Record<string, number>
): TargetProfile[] {
  const count = Math.max(1, Math.min(60, Math.round(groupSize)));
  const primary = getTargetById(primaryTargetId, targetsList);
  const nonTitans = targetsList.filter((t) => t.id !== 'chitin_titan');

  if (!mixedGroup) {
    const roster: TargetProfile[] = [];
    for (let i = 0; i < count; i++) {
      if (primary.id === 'chitin_titan' && i >= Math.max(1, chassisSpawnCounts?.chitin_titan ?? 1)) {
        roster.push(nonTitans[i % nonTitans.length]);
      } else {
        roster.push(primary);
      }
    }
    return roster;
  }

  // Use custom per-chassis spawn counts when provided
  if (chassisSpawnCounts) {
    const activeIds = targetsList
      .map((t) => t.id)
      .filter((id) => Math.max(0, Math.round(chassisSpawnCounts[id] ?? 0)) > 0);

    if (activeIds.length > 0) {
      const baseSum = activeIds.reduce(
        (acc, id) => acc + Math.max(0, Math.round(chassisSpawnCounts[id] ?? 0)),
        0
      );

      const allocated: Record<string, number> = {};
      if (count === baseSum) {
        for (const id of activeIds) {
          allocated[id] = Math.round(chassisSpawnCounts[id] ?? 0);
        }
      } else {
        // When scaling waves, hold Bio-Titan at 1 unless user explicitly configured >1 Titans
        const rawTitan = Math.round(chassisSpawnCounts.chitin_titan ?? 0);
        let remainingBudget = count;
        const scalableIds: string[] = [];

        for (const id of activeIds) {
          if (id === 'chitin_titan' && rawTitan === 1 && activeIds.length > 1) {
            allocated.chitin_titan = Math.min(1, remainingBudget);
            remainingBudget -= allocated.chitin_titan;
          } else {
            scalableIds.push(id);
          }
        }

        if (scalableIds.length === 0) {
          allocated[activeIds[0]] = count;
        } else {
          const scalableBase = scalableIds.reduce(
            (acc, id) => acc + Math.max(1, Math.round(chassisSpawnCounts[id] ?? 1)),
            0
          );
          const remainders: { id: string; frac: number }[] = [];
          let assigned = 0;
          for (const id of scalableIds) {
            const exact =
              (Math.max(1, Math.round(chassisSpawnCounts[id] ?? 1)) / scalableBase) *
              remainingBudget;
            const floored = Math.floor(exact);
            allocated[id] = floored;
            assigned += floored;
            remainders.push({ id, frac: exact - floored });
          }
          remainders.sort((a, b) => b.frac - a.frac);
          let rem = remainingBudget - assigned;
          for (let i = 0; i < remainders.length && rem > 0; i++, rem--) {
            allocated[remainders[i].id] += 1;
          }
        }
      }

      // Build interleaved roster, placing primary target first (if present in allocation)
      const roster: TargetProfile[] = [];
      const countsLeft = { ...allocated };
      if ((countsLeft[primary.id] ?? 0) > 0) {
        roster.push(primary);
        countsLeft[primary.id] -= 1;
      }

      while (roster.length < count) {
        let added = false;
        for (const id of activeIds) {
          if ((countsLeft[id] ?? 0) > 0 && roster.length < count) {
            roster.push(getTargetById(id, targetsList));
            countsLeft[id] -= 1;
            added = true;
          }
        }
        if (!added) break;
      }

      if (roster.length > 0) {
        return roster;
      }
    }
  }

  const roster: TargetProfile[] = [];
  let titanCount = 0;
  for (let i = 0; i < count; i++) {
    if (i === 0) {
      roster.push(primary);
      if (primary.id === 'chitin_titan') titanCount += 1;
      continue;
    }
    const pool = titanCount >= 1 ? nonTitans : targetsList;
    const pick = pool[(i + (primary.id === 'chitin_titan' ? 0 : 1)) % pool.length];
    if (pick.id === 'chitin_titan') titanCount += 1;
    roster.push(pick);
  }

  return roster;
}

export interface SingleShotCalculation {
  rawDamage: number;
  hpDamage: number;
  staggerDamage: number;
  nextHp: number;
  isCrit: boolean;
  isKill: boolean;
  isMiss: boolean;
  zoneLabel: string;
}

/**
 * Resolves a single projectile/pellet hit against an enemy target using exact zone multipliers
 * plus optional penetration scaling and stacked stagger damage multiplier.
 */
export function resolveShot(
  config: SimulationConfig,
  currentHp: number,
  zone: HitZoneId,
  forceHit = false,
  shotIndex = 0,
  overrideDistanceM?: number,
  overrideTargetId?: string,
  weaponsList: WeaponProfile[] = WEAPONS,
  targetsList: TargetProfile[] = TARGET_PROFILES,
  penetrationFactor = 1.0,
  isTargetStaggered = false
): SingleShotCalculation {
  const weapon = getWeaponById(config.weaponId, weaponsList);
  const target = getTargetById(overrideTargetId ?? config.targetId, targetsList);

  const effectiveDistanceM = overrideDistanceM ?? config.distanceM;
  const falloff = computeRangeFalloff(weapon, effectiveDistanceM);

  const modeSpreadFactor =
    config.firingMode === 'SEMI_PRECISION'
      ? 0.45
      : config.firingMode === 'AUTO_BURST'
        ? 0.85
        : 1.25;
  const effectiveSpread = weapon.baseSpreadDeg * modeSpreadFactor;
  const distancePenalty = Math.max(0, (effectiveDistanceM - 20) / 140) * effectiveSpread;
  const zoneSizeFactor = zone === 'weakspot' ? 0.55 : zone === 'limb' ? 0.8 : 1.0;
  const hitChance = forceHit
    ? 1.0
    : Math.max(0.42, Math.min(0.99, 0.98 - distancePenalty * (1.25 - zoneSizeFactor * 0.45)));

  const pseudoRand = Math.abs(Math.sin((shotIndex + 1) * 12.9898 + effectiveDistanceM * 0.37)) % 1;
  const isMiss = !forceHit && pseudoRand > hitChance;

  const zoneLabel =
    zone === 'weakspot'
      ? target.weakspotLabel
      : zone === 'torso'
        ? 'Armored Thorax'
        : 'Extremities';

  if (isMiss) {
    return {
      rawDamage: 0,
      hpDamage: 0,
      staggerDamage: 0,
      nextHp: currentHp,
      isCrit: false,
      isKill: false,
      isMiss: true,
      zoneLabel,
    };
  }

  const isCrit = zone === 'weakspot';
  const baseZoneMult =
    zone === 'weakspot'
      ? Math.max(0.1, target.weakspotMultiplier)
      : zone === 'limb'
        ? target.limbMultiplier
        : target.torsoMultiplier;

  // Stagger multiplier stacks on top of the current hit-zone multiplier while enemy is staggered
  const totalZoneMult = isTargetStaggered
    ? baseZoneMult * target.staggerDamageMultiplier
    : baseZoneMult;

  const rawDamage = Math.max(
    1,
    Math.round(weapon.baseDamage * falloff * totalZoneMult * Math.max(0.05, penetrationFactor))
  );

  const hpDamage = rawDamage;
  const staggerDamage = Math.max(1, Math.round(hpDamage * (isCrit ? 1.15 : 0.9)));
  const nextHp = Math.max(0, currentHp - hpDamage);
  const isKill = currentHp > 0 && nextHp === 0;

  return {
    rawDamage,
    hpDamage,
    staggerDamage,
    nextHp,
    isCrit,
    isKill,
    isMiss: false,
    zoneLabel,
  };
}

/**
 * Resolves a melee normal, special, or shove impact using explicit melee damage,
 * weapon weakspot multiplier (2.0x / 2.4x), and stacked stagger damage multiplier.
 */
export function resolveMeleeHit(
  weapon: WeaponProfile,
  target: TargetProfile,
  currentHp: number,
  zone: HitZoneId,
  baseSwingDamage: number,
  explicitStaggerDamage: number | null,
  isTargetStaggered: boolean
): SingleShotCalculation {
  const isCrit = zone === 'weakspot';
  const baseMult = isCrit ? weapon.critMultiplier : zone === 'limb' ? 0.85 : 1.0;
  const totalMult = isTargetStaggered ? baseMult * target.staggerDamageMultiplier : baseMult;

  const hpDamage = Math.max(1, Math.round(baseSwingDamage * totalMult));
  const staggerDamage =
    explicitStaggerDamage !== null
      ? explicitStaggerDamage
      : Math.max(1, Math.round(hpDamage * 0.75));
  const nextHp = Math.max(0, currentHp - hpDamage);
  const isKill = currentHp > 0 && nextHp === 0;
  const zoneLabel = isCrit
    ? `${target.weakspotLabel} (${weapon.critMultiplier.toFixed(1)}x)`
    : zone === 'limb'
      ? 'Extremities'
      : 'Body Strike';

  return {
    rawDamage: hpDamage,
    hpDamage,
    staggerDamage,
    nextHp,
    isCrit,
    isKill,
    isMiss: false,
    zoneLabel,
  };
}

export function computeTheoreticalTelemetry(
  config: SimulationConfig,
  weaponsList: WeaponProfile[] = WEAPONS,
  targetsList: TargetProfile[] = TARGET_PROFILES
): {
  shotIntervalMs: number;
  effectiveVelocity: number;
  falloffPct: number;
  effectiveArmorPenPct: number;
  perShotHpEstimate: number;
  theoreticalStk: number;
  theoreticalTtkMs: number;
  theoreticalDps: number;
  effectiveSpreadDeg: number;
} {
  const weapon = getWeaponById(config.weaponId, weaponsList);
  const target = getTargetById(config.targetId, targetsList);

  if (weapon.weaponClass === 'MELEE' && weapon.melee) {
    const steps = weapon.melee.comboSteps;
    let simHp = config.targetHp;
    let strikes = 0;
    let totalMs = 0;
    let dmgSum = 0;

    while (simHp > 0 && strikes < 200) {
      const step = steps[strikes % steps.length];
      const res = resolveMeleeHit(weapon, target, simHp, config.aimZone, step.damage, null, false);
      simHp = res.nextHp;
      dmgSum += res.hpDamage;
      strikes += 1;
      if (simHp > 0) {
        totalMs += Math.round(step.durationSec * 1000);
      }
    }

    const avgStepMs = Math.round(
      (steps.reduce((a, b) => a + b.durationSec, 0) / Math.max(1, steps.length)) * 1000
    );
    const theoreticalTtkMs = Math.max(180, totalMs);
    const theoreticalDps = Math.round((config.targetHp / (theoreticalTtkMs / 1000)) * 10) / 10;

    return {
      shotIntervalMs: avgStepMs,
      effectiveVelocity: weapon.melee.reachM,
      falloffPct: 100,
      effectiveArmorPenPct: Math.round(weapon.armorPenetration * 100),
      perShotHpEstimate: strikes > 0 ? Math.round(dmgSum / strikes) : weapon.baseDamage,
      theoreticalStk: strikes,
      theoreticalTtkMs,
      theoreticalDps,
      effectiveSpreadDeg: 0,
    };
  }

  const modeRpmFactor =
    config.firingMode === 'SEMI_PRECISION'
      ? 0.58
      : config.firingMode === 'AUTO_BURST'
        ? 0.88
        : 1.0;
  const effectiveRpm = weapon.rpm * modeRpmFactor;
  const shotIntervalMs = Math.round(60000 / Math.max(1, effectiveRpm));
  const effectiveVelocity = Math.round(weapon.muzzleVelocity);
  const falloff = computeRangeFalloff(weapon, config.distanceM);
  const effectiveArmorPen = Math.max(0.05, Math.min(0.98, weapon.armorPenetration));

  let simHp = config.targetHp;
  let shots = 0;
  let totalMs = 0;
  let magRemaining = weapon.magSize;
  let hpSum = 0;

  while (simHp > 0 && shots < 400) {
    if (magRemaining === 0) {
      totalMs += weapon.reloadTimeMs;
      magRemaining = weapon.magSize;
    }
    let shotHpTotal = 0;
    for (let p = 0; p < weapon.pellets; p++) {
      if (simHp <= 0) break;
      const res = resolveShot(
        config,
        simHp,
        config.aimZone,
        true,
        shots * 12 + p,
        undefined,
        undefined,
        weaponsList,
        targetsList
      );
      simHp = res.nextHp;
      shotHpTotal += res.hpDamage;
    }
    hpSum += shotHpTotal;
    shots += 1;
    magRemaining -= 1;
    if (simHp > 0) {
      totalMs += shotIntervalMs;
    }
  }

  const flightTimeMs = Math.round((config.distanceM / Math.max(1, effectiveVelocity)) * 1000);
  const theoreticalTtkMs = totalMs + flightTimeMs;
  const totalPool = config.targetHp;
  const theoreticalDps =
    theoreticalTtkMs > 0
      ? Math.round((totalPool / (theoreticalTtkMs / 1000)) * 10) / 10
      : weapon.baseDamage * weapon.pellets;

  return {
    shotIntervalMs,
    effectiveVelocity,
    falloffPct: Math.round(falloff * 100),
    effectiveArmorPenPct: Math.round(effectiveArmorPen * 100),
    perShotHpEstimate: shots > 0 ? Math.round(hpSum / shots) : 0,
    theoreticalStk: shots,
    theoreticalTtkMs,
    theoreticalDps,
    effectiveSpreadDeg:
      Math.round(
        weapon.baseSpreadDeg * (config.firingMode === 'SEMI_PRECISION' ? 0.45 : 1) * 100
      ) / 100,
  };
}

export function summarizeEngagement(
  logs: CombatLogEntry[],
  config: SimulationConfig,
  elapsedTimeMs: number,
  weaponsList: WeaponProfile[] = WEAPONS,
  targetsList: TargetProfile[] = TARGET_PROFILES
): EngagementMetrics {
  const theory = computeTheoreticalTelemetry(config, weaponsList, targetsList);
  const playerLogs = logs.filter(
    (l) =>
      !l.source ||
      l.source === 'PLAYER' ||
      l.source === 'PLAYER_MELEE' ||
      l.source === 'PLAYER_SHOVE'
  );
  const totalRoundsFired = playerLogs.length;
  const hits = playerLogs.filter((l) => !l.isMiss);
  const weakspotHits = hits.filter((l) => l.zone === 'weakspot').length;

  const totalRawDamage = hits.reduce((acc, l) => acc + l.rawDamage, 0);
  const totalHpDamage = hits.reduce((acc, l) => acc + l.hpDamage, 0);

  const killEntries = playerLogs.filter((l) => l.isKill);
  let ttkMs: number | null = null;
  if (killEntries.length > 0) {
    const explicitTtks = killEntries
      .map((l) => l.enemyTtkMs)
      .filter((v): v is number => typeof v === 'number' && v > 0);
    if (explicitTtks.length > 0) {
      ttkMs = Math.round(explicitTtks.reduce((a, b) => a + b, 0) / explicitTtks.length);
    } else {
      let prevTs = 0;
      let sum = 0;
      for (const k of killEntries) {
        sum += Math.max(1, k.timestampMs - prevTs);
        prevTs = k.timestampMs;
      }
      ttkMs = Math.round(sum / killEntries.length);
    }
  }

  const activeSeconds = Math.max(0.15, elapsedTimeMs / 1000);
  const effectiveDps =
    totalRoundsFired > 0
      ? Math.round((totalHpDamage / activeSeconds) * 10) / 10
      : 0;

  return {
    totalRoundsFired,
    roundsHit: hits.length,
    weakspotHits,
    totalRawDamage,
    totalHpDamage,
    accuracyPct: totalRoundsFired > 0 ? Math.round((hits.length / totalRoundsFired) * 1000) / 10 : 0,
    weakspotEfficiencyPct:
      hits.length > 0 ? Math.round((weakspotHits / hits.length) * 1000) / 10 : 0,
    elapsedTimeMs,
    ttkMs,
    effectiveDps,
    theoreticalStk: theory.theoreticalStk,
    theoreticalTtkMs: theory.theoreticalTtkMs,
  };
}

export function formatTimestampMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const mins = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, '0');
  const secs = (totalSeconds % 60).toString().padStart(2, '0');
  const hundredths = Math.floor((ms % 1000) / 10)
    .toString()
    .padStart(2, '0');
  return `${mins}:${secs}.${hundredths}`;
}
