import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { soundEngine } from './audio/soundEngine';
import { ArmoryScreen } from './components/ArmoryScreen';
import { LeftTelemetryPanel } from './components/LeftTelemetryPanel';
import { RightCombatLogPanel } from './components/RightCombatLogPanel';
import { RoomsScreen } from './components/RoomsScreen';
import { SimulationCanvas3D, SquadShotSummary } from './components/SimulationCanvas3D';
import { TargetsScreen } from './components/TargetsScreen';
import { TelemetryArchiveScreen } from './components/TelemetryArchiveScreen';
import { TopBar } from './components/TopBar';
import { TARGET_PROFILES, WEAPONS } from './data/arsenal';
import {
  computeTheoreticalTelemetry,
  getTargetById,
  getWeaponById,
  summarizeEngagement,
} from './engine/ballistics';
import {
  AppScreen,
  CombatLogEntry,
  RoomLayoutId,
  SavedTelemetryRun,
  SimulationConfig,
  TargetProfile,
  WeaponProfile,
} from './types/ballistics';

type MobileTab = 'SIM' | 'INPUTS' | 'TELEMETRY';

const MAX_PLAYER_HP = 100;
const REGEN_HP_CAP = Math.round(MAX_PLAYER_HP * 0.4);
const OUT_OF_COMBAT_WINDOW_SEC = 5.0;
const REGEN_HP_PER_SEC = 4.0;
const MEDKIT_COOLDOWN_SEC = 12.0;
const MAX_SPAWN_LIMIT = 60;

function buildWaveSizesFromBase(baseW1: number): number[] {
  const clamped = Math.max(1, Math.min(MAX_SPAWN_LIMIT, Math.round(baseW1)));
  return [0, 1, 2, 3, 4].map((i) =>
    Math.min(MAX_SPAWN_LIMIT, Math.round(clamped * Math.pow(1.5, i)))
  );
}

function rescaleChassisCounts(
  prev: Record<string, number>,
  targetTotal: number,
  primaryTargetId: string,
  targetsList: TargetProfile[]
): Record<string, number> {
  const clampedTotal = Math.max(1, Math.min(MAX_SPAWN_LIMIT, Math.round(targetTotal)));
  const ids = targetsList.map((t) => t.id);
  const activeIds = ids.filter((id) => (prev[id] ?? 0) > 0);
  if (activeIds.length === 0) {
    return Object.fromEntries(ids.map((id) => [id, id === primaryTargetId ? clampedTotal : 0]));
  }
  const baseSum = activeIds.reduce((a, id) => a + (prev[id] ?? 0), 0);
  const next: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]));
  const remainders: { id: string; frac: number }[] = [];
  let assigned = 0;
  for (const id of activeIds) {
    const exact = ((prev[id] ?? 0) / Math.max(1, baseSum)) * clampedTotal;
    const floored = Math.floor(exact);
    next[id] = floored;
    assigned += floored;
    remainders.push({ id, frac: exact - floored });
  }
  remainders.sort((a, b) => b.frac - a.frac);
  let rem = clampedTotal - assigned;
  for (let i = 0; i < remainders.length && rem > 0; i++, rem--) {
    next[remainders[i].id] += 1;
  }
  return next;
}

const INITIAL_CONFIG: SimulationConfig = {
  weaponId: 'm47_rail',
  firingMode: 'AUTO_BURST',
  targetId: 'aegis_exo',
  targetHp: 440,
  distanceM: 45,
  aimZone: 'weakspot',
  approachPattern: 'ADAPTIVE',
  groupSize: 12,
  waveGroupSizes: [12, 18, 27, 41, 60],
  chassisSpawnCounts: {
    aegis_exo: 4,
    stalker_mech: 4,
    chitin_titan: 1,
    vanguard_drone: 3,
  },
  mixedGroup: true,
  burstRounds: 10,
  roomId: 'corridor_01',
};

const SEED_RUNS: SavedTelemetryRun[] = [
  {
    id: 'run-seed-01',
    recordedAt: '09:42:18',
    weaponName: 'M-47 Rail Carbine',
    weaponCode: 'WP-01',
    targetName: 'Aegis Heavy Exo-Frame',
    distanceM: 45,
    firingMode: 'AUTO_BURST',
    metrics: {
      totalRoundsFired: 4,
      roundsHit: 4,
      weakspotHits: 3,
      totalRawDamage: 252,
      totalHpDamage: 240,
      accuracyPct: 100.0,
      weakspotEfficiencyPct: 75.0,
      elapsedTimeMs: 280,
      ttkMs: 280,
      effectiveDps: 857.1,
      theoreticalStk: 4,
      theoreticalTtkMs: 280,
    },
  },
  {
    id: 'run-seed-02',
    recordedAt: '09:48:05',
    weaponName: 'Valkyrie K-9 DMR',
    weaponCode: 'WP-02',
    targetName: 'Stalker Recon Mech',
    distanceM: 75,
    firingMode: 'SEMI_PRECISION',
    metrics: {
      totalRoundsFired: 1,
      roundsHit: 1,
      weakspotHits: 1,
      totalRawDamage: 575,
      totalHpDamage: 130,
      accuracyPct: 100.0,
      weakspotEfficiencyPct: 100.0,
      elapsedTimeMs: 39,
      ttkMs: 39,
      effectiveDps: 846.2,
      theoreticalStk: 1,
      theoreticalTtkMs: 39,
    },
  },
  {
    id: 'run-seed-03',
    recordedAt: '09:53:41',
    weaponName: 'Valken Pole-Halberd',
    weaponCode: 'WP-08',
    targetName: 'Aegis Heavy Exo-Frame',
    distanceM: 10,
    firingMode: 'SEMI_PRECISION',
    metrics: {
      totalRoundsFired: 2,
      roundsHit: 2,
      weakspotHits: 1,
      totalRawDamage: 240,
      totalHpDamage: 240,
      accuracyPct: 100.0,
      weakspotEfficiencyPct: 50.0,
      elapsedTimeMs: 920,
      ttkMs: 920,
      effectiveDps: 260.9,
      theoreticalStk: 2,
      theoreticalTtkMs: 920,
    },
  },
];

export default function App() {
  const [activeScreen, setActiveScreen] = useState<AppScreen>('range');
  const [mobileTab, setMobileTab] = useState<MobileTab>('SIM');
  const [weapons, setWeapons] = useState<WeaponProfile[]>(() =>
    WEAPONS.map((w) => ({
      ...w,
      recoilCoeff: { ...w.recoilCoeff },
      recoilPattern: w.recoilPattern.map((p) => ({ ...p })),
      melee: w.melee
        ? { ...w.melee, comboSteps: w.melee.comboSteps.map((s) => ({ ...s })) }
        : undefined,
    }))
  );
  const [targets, setTargets] = useState<TargetProfile[]>(() =>
    TARGET_PROFILES.map((t) => ({ ...t }))
  );
  const [config, setConfig] = useState<SimulationConfig>(INITIAL_CONFIG);

  const [playerHp, setPlayerHp] = useState<number>(MAX_PLAYER_HP);
  const [magRemaining, setMagRemaining] = useState<number>(
    () => getWeaponById(INITIAL_CONFIG.weaponId, WEAPONS).magSize
  );
  const [isReloading, setIsReloading] = useState<boolean>(false);
  const [isSimRunning, setIsSimRunning] = useState<boolean>(false);
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const [waveNumber, setWaveNumber] = useState<number>(1);
  const [waveTriggerToken, setWaveTriggerToken] = useState<number>(0);
  const [outOfCombatSec, setOutOfCombatSec] = useState<number>(OUT_OF_COMBAT_WINDOW_SEC);
  const [medkitCooldownSec, setMedkitCooldownSec] = useState<number>(0);
  const [logs, setLogs] = useState<CombatLogEntry[]>([]);
  const [elapsedMs, setElapsedMs] = useState<number>(0);
  const [savedRuns, setSavedRuns] = useState<SavedTelemetryRun[]>(SEED_RUNS);
  const [archiveNotice, setArchiveNotice] = useState<string | null>(null);
  const [resetToken, setResetToken] = useState<number>(0);

  const stateRef = useRef({
    playerHp: MAX_PLAYER_HP,
    playerHpExact: MAX_PLAYER_HP,
    outOfCombatSec: OUT_OF_COMBAT_WINDOW_SEC,
    medkitCooldownSec: 0,
    mag: getWeaponById(INITIAL_CONFIG.weaponId, WEAPONS).magSize,
    reloading: false,
    roundCount: 0,
    elapsedMs: 0,
    startTimeMs: 0,
    waveNumber: 1,
    isPaused: false,
    activeScreen: 'range' as AppScreen,
    config: INITIAL_CONFIG,
    weapons,
    targets,
  });

  stateRef.current.config = config;
  stateRef.current.weapons = weapons;
  stateRef.current.targets = targets;
  stateRef.current.isPaused = isPaused;
  stateRef.current.activeScreen = activeScreen;
  stateRef.current.waveNumber = waveNumber;

  const reloadTimerRef = useRef<number | null>(null);

  const clearReloadTimer = useCallback(() => {
    if (reloadTimerRef.current !== null) {
      window.clearTimeout(reloadTimerRef.current);
      reloadTimerRef.current = null;
    }
  }, []);

  // Out-of-combat 5s window -> +4 HP/s regeneration & Medkit cooldown ticker
  useEffect(() => {
    const interval = window.setInterval(() => {
      const s = stateRef.current;
      if (s.isPaused || s.activeScreen !== 'range' || s.playerHp <= 0) return;

      const dt = 0.1;

      if (s.medkitCooldownSec > 0) {
        s.medkitCooldownSec = Math.max(0, s.medkitCooldownSec - dt);
        setMedkitCooldownSec(Math.round(s.medkitCooldownSec * 10) / 10);
      }

      if (s.outOfCombatSec < OUT_OF_COMBAT_WINDOW_SEC) {
        s.outOfCombatSec = Math.min(OUT_OF_COMBAT_WINDOW_SEC, s.outOfCombatSec + dt);
        setOutOfCombatSec(s.outOfCombatSec);
      } else if (s.playerHpExact < REGEN_HP_CAP) {
        // Player only heals passively when below 40% HP, and up to 40% HP
        s.playerHpExact = Math.min(REGEN_HP_CAP, s.playerHpExact + REGEN_HP_PER_SEC * dt);
        const rounded = Math.min(REGEN_HP_CAP, Math.round(s.playerHpExact));
        if (rounded !== s.playerHp) {
          s.playerHp = rounded;
          setPlayerHp(rounded);
        }
      }
    }, 100);

    return () => window.clearInterval(interval);
  }, []);

  const resetRangeState = useCallback(
    (nextCfg?: SimulationConfig) => {
      clearReloadTimer();
      const cfg = nextCfg ?? stateRef.current.config;
      const weapon = getWeaponById(cfg.weaponId, stateRef.current.weapons);
      setIsSimRunning(false);
      setIsPaused(false);
      setIsReloading(false);
      setPlayerHp(MAX_PLAYER_HP);
      setOutOfCombatSec(OUT_OF_COMBAT_WINDOW_SEC);
      setMedkitCooldownSec(0);
      setWaveNumber(1);
      setMagRemaining(weapon.magSize);
      setLogs([]);
      setElapsedMs(0);
      setResetToken((t) => t + 1);

      stateRef.current.playerHp = MAX_PLAYER_HP;
      stateRef.current.playerHpExact = MAX_PLAYER_HP;
      stateRef.current.outOfCombatSec = OUT_OF_COMBAT_WINDOW_SEC;
      stateRef.current.medkitCooldownSec = 0;
      stateRef.current.waveNumber = 1;
      stateRef.current.mag = weapon.magSize;
      stateRef.current.reloading = false;
      stateRef.current.roundCount = 0;
      stateRef.current.elapsedMs = 0;
      stateRef.current.startTimeMs = 0;
    },
    [clearReloadTimer]
  );

  const handleChangeConfig = useCallback(
    (patch: Partial<SimulationConfig>) => {
      setConfig((prev) => {
        const next: SimulationConfig = { ...prev, ...patch };
        if (patch.weaponId && patch.weaponId !== prev.weaponId) {
          clearReloadTimer();
          const newWeapon = getWeaponById(patch.weaponId, stateRef.current.weapons);
          setMagRemaining(newWeapon.magSize);
          stateRef.current.mag = newWeapon.magSize;
          setIsReloading(false);
          stateRef.current.reloading = false;
        }
        if (patch.groupSize !== undefined) {
          const clamped = Math.max(1, Math.min(MAX_SPAWN_LIMIT, Math.round(patch.groupSize)));
          next.groupSize = clamped;
          next.waveGroupSizes = buildWaveSizesFromBase(clamped);
          next.chassisSpawnCounts = rescaleChassisCounts(
            prev.chassisSpawnCounts,
            clamped,
            prev.targetId,
            stateRef.current.targets
          );
        }
        if (patch.mixedGroup !== undefined) {
          if (!patch.mixedGroup) {
            next.chassisSpawnCounts = Object.fromEntries(
              stateRef.current.targets.map((t) => [
                t.id,
                t.id === next.targetId ? next.groupSize : 0,
              ])
            );
          } else {
            const activeCount = Object.values(next.chassisSpawnCounts).filter((v) => v > 0).length;
            if (activeCount <= 1) {
              const baseRatio = INITIAL_CONFIG.chassisSpawnCounts;
              next.chassisSpawnCounts = rescaleChassisCounts(
                baseRatio,
                next.groupSize,
                next.targetId,
                stateRef.current.targets
              );
            }
          }
        }
        return next;
      });
    },
    [clearReloadTimer]
  );

  const handleChangeChassisSpawnCount = useCallback((targetId: string, rawCount: number) => {
    setConfig((prev) => {
      const requested = Math.max(0, Math.min(MAX_SPAWN_LIMIT, Math.round(rawCount)));
      const otherSum = Object.entries(prev.chassisSpawnCounts)
        .filter(([id]) => id !== targetId)
        .reduce((acc, [, v]) => acc + Math.max(0, v), 0);

      const maxAllowedForThis = Math.max(0, MAX_SPAWN_LIMIT - otherSum);
      const clampedForThis = Math.min(requested, maxAllowedForThis);
      const nextCounts = {
        ...prev.chassisSpawnCounts,
        [targetId]: clampedForThis,
      };
      const nextTotal = otherSum + clampedForThis;
      if (nextTotal < 1) {
        nextCounts[targetId] = 1;
      }

      const finalTotal = Math.max(
        1,
        Math.min(
          MAX_SPAWN_LIMIT,
          Object.values(nextCounts).reduce((a, b) => a + b, 0)
        )
      );
      const activeTypes = Object.values(nextCounts).filter((v) => v > 0).length;

      return {
        ...prev,
        chassisSpawnCounts: nextCounts,
        groupSize: finalTotal,
        waveGroupSizes: buildWaveSizesFromBase(finalTotal),
        mixedGroup: activeTypes > 1,
      };
    });
  }, []);

  const handleChangeWaveSize = useCallback((waveIdx: number, size: number) => {
    setConfig((prev) => {
      const clamped = Math.max(1, Math.min(MAX_SPAWN_LIMIT, Math.round(size)));
      if (waveIdx === 0) {
        return {
          ...prev,
          groupSize: clamped,
          waveGroupSizes: buildWaveSizesFromBase(clamped),
          chassisSpawnCounts: rescaleChassisCounts(
            prev.chassisSpawnCounts,
            clamped,
            prev.targetId,
            stateRef.current.targets
          ),
        };
      }
      const nextWaves = [...prev.waveGroupSizes];
      nextWaves[waveIdx] = clamped;
      return { ...prev, waveGroupSizes: nextWaves };
    });
  }, []);

  const handleStartNextWave = useCallback(() => {
    if (stateRef.current.playerHp <= 0) {
      resetRangeState();
      return;
    }
    setIsPaused(false);
    setWaveNumber((prev) => {
      const next = prev + 1;
      stateRef.current.waveNumber = next;
      return next;
    });
    setWaveTriggerToken((t) => t + 1);
  }, [resetRangeState]);

  const handleSelectRoom = useCallback(
    (roomId: RoomLayoutId) => {
      if (roomId === stateRef.current.config.roomId) return;
      const nextCfg: SimulationConfig = { ...stateRef.current.config, roomId };
      setConfig(nextCfg);
      resetRangeState(nextCfg);
    },
    [resetRangeState]
  );

  const handleUpdateWeapon = useCallback(
    (weaponId: string, patch: Partial<WeaponProfile>) => {
      setWeapons((prev) =>
        prev.map((w) => {
          if (w.id !== weaponId) return w;
          const updated = { ...w, ...patch };
          if (weaponId === stateRef.current.config.weaponId && patch.magSize !== undefined) {
            setMagRemaining(updated.magSize);
            stateRef.current.mag = updated.magSize;
          }
          return updated;
        })
      );
    },
    []
  );

  const handleResetWeapons = useCallback(() => {
    const fresh = WEAPONS.map((w) => ({
      ...w,
      recoilCoeff: { ...w.recoilCoeff },
      recoilPattern: w.recoilPattern.map((p) => ({ ...p })),
      melee: w.melee
        ? { ...w.melee, comboSteps: w.melee.comboSteps.map((s) => ({ ...s })) }
        : undefined,
    }));
    setWeapons(fresh);
    const active = getWeaponById(stateRef.current.config.weaponId, fresh);
    setMagRemaining(active.magSize);
    stateRef.current.mag = active.magSize;
  }, []);

  const handleUpdateTarget = useCallback((targetId: string, patch: Partial<TargetProfile>) => {
    setTargets((prev) =>
      prev.map((t) => (t.id === targetId ? { ...t, ...patch } : t))
    );
    if (patch.defaultHp !== undefined && targetId === stateRef.current.config.targetId) {
      setConfig((prev) => ({ ...prev, targetHp: patch.defaultHp! }));
    }
  }, []);

  const handleResetTargets = useCallback(() => {
    const fresh = TARGET_PROFILES.map((t) => ({ ...t }));
    setTargets(fresh);
    const active = getTargetById(stateRef.current.config.targetId, fresh);
    setConfig((prev) => ({ ...prev, targetHp: active.defaultHp }));
  }, []);

  const handleSelectTargetPreset = useCallback(
    (targetId: string) => {
      const target = getTargetById(targetId, stateRef.current.targets);
      const prevCfg = stateRef.current.config;
      const nextCounts = prevCfg.mixedGroup
        ? prevCfg.chassisSpawnCounts
        : Object.fromEntries(
            stateRef.current.targets.map((t) => [t.id, t.id === target.id ? prevCfg.groupSize : 0])
          );
      const nextCfg: SimulationConfig = {
        ...prevCfg,
        targetId: target.id,
        targetHp: target.defaultHp,
        chassisSpawnCounts: nextCounts,
      };
      setConfig(nextCfg);
      resetRangeState(nextCfg);
    },
    [resetRangeState]
  );

  const handleCycleTarget = useCallback(() => {
    const list = stateRef.current.targets;
    const idx = list.findIndex((t) => t.id === config.targetId);
    const nextTarget = list[(idx + 1) % list.length];
    handleSelectTargetPreset(nextTarget.id);
  }, [config.targetId, handleSelectTargetPreset]);

  const startReloadSequence = useCallback(
    (weaponId: string) => {
      const s = stateRef.current;
      if (s.reloading || s.playerHp <= 0) return;
      const weapon = getWeaponById(weaponId, s.weapons);
      if (weapon.weaponClass === 'MELEE') return;
      clearReloadTimer();
      s.reloading = true;
      setIsReloading(true);
      soundEngine.playReloadStart();

      reloadTimerRef.current = window.setTimeout(() => {
        reloadTimerRef.current = null;
        const latestWeapon = getWeaponById(weaponId, stateRef.current.weapons);
        stateRef.current.mag = latestWeapon.magSize;
        stateRef.current.reloading = false;
        setMagRemaining(latestWeapon.magSize);
        setIsReloading(false);
        soundEngine.playReloadComplete();
      }, Math.min(1100, weapon.reloadTimeMs * 0.5));
    },
    [clearReloadTimer]
  );

  const handleManualReload = useCallback(() => {
    const s = stateRef.current;
    const weapon = getWeaponById(s.config.weaponId, s.weapons);
    if (weapon.weaponClass === 'MELEE') return;
    if (s.reloading || s.playerHp <= 0 || s.mag >= weapon.magSize) return;
    startReloadSequence(weapon.id);
  }, [startReloadSequence]);

  const handleTriggerShot = useCallback(() => {
    const s = stateRef.current;
    const weapon = getWeaponById(s.config.weaponId, s.weapons);
    if (weapon.weaponClass === 'MELEE') return true;

    if (s.reloading || s.mag <= 0 || s.playerHp <= 0) return false;

    if (s.roundCount === 0) {
      s.startTimeMs = performance.now();
    }
    s.roundCount += 1;
    s.mag -= 1;
    setMagRemaining(s.mag);

    if (s.mag === 0) {
      startReloadSequence(weapon.id);
    }

    return true;
  }, [startReloadSequence]);

  const handleSquadShotResolved = useCallback((summary: SquadShotSummary) => {
    const s = stateRef.current;
    const weapon = getWeaponById(s.config.weaponId, s.weapons);

    if (s.startTimeMs === 0) {
      s.startTimeMs = performance.now();
    }
    if (summary.source === 'PLAYER_MELEE' || summary.source === 'PLAYER_SHOVE') {
      s.roundCount += 1;
    }

    const nowMs =
      s.roundCount === 1 && weapon.weaponClass === 'RANGED'
        ? Math.round((summary.distanceM / Math.max(1, weapon.muzzleVelocity)) * 1000)
        : Math.max(1, Math.round(performance.now() - s.startTimeMs));
    s.elapsedMs = nowMs;
    setElapsedMs(nowMs);

    const entry: CombatLogEntry = {
      id: `shot-${Date.now()}-${s.roundCount}-${Math.random()}`,
      timestampMs: nowMs,
      roundNumber: s.roundCount,
      source: summary.source ?? 'PLAYER',
      targetName: summary.targetName,
      zone: summary.zone,
      zoneLabel: summary.zoneLabel,
      rawDamage: summary.rawDamage,
      hpDamage: summary.hpDamage,
      remainingHp: summary.remainingHp,
      isCrit: summary.isCrit,
      isKill: summary.isKill,
      isMiss: summary.isMiss,
      isStagger: summary.isStagger,
      enemyTtkMs: summary.enemyTtkMs ?? null,
      distanceM: summary.distanceM,
    };
    setLogs((prev) => [entry, ...prev].slice(0, 120));
  }, []);

  const handleUseMedkit = useCallback(() => {
    const s = stateRef.current;
    if (s.isPaused || s.playerHp <= 0 || s.medkitCooldownSec > 0 || s.playerHp >= MAX_PLAYER_HP) {
      return;
    }

    const healAmount = Math.round(MAX_PLAYER_HP * 0.4);
    const nextExact = Math.min(MAX_PLAYER_HP, s.playerHpExact + healAmount);
    const actualGain = Math.max(1, Math.round(nextExact) - s.playerHp);
    const nextHp = Math.min(MAX_PLAYER_HP, Math.round(nextExact));

    s.playerHpExact = nextExact;
    s.playerHp = nextHp;
    s.medkitCooldownSec = MEDKIT_COOLDOWN_SEC;
    setPlayerHp(nextHp);
    setMedkitCooldownSec(MEDKIT_COOLDOWN_SEC);
    soundEngine.playMedkitHeal();

    const nowMs = s.startTimeMs > 0 ? Math.round(performance.now() - s.startTimeMs) : s.elapsedMs;
    const entry: CombatLogEntry = {
      id: `medkit-${Date.now()}-${Math.random()}`,
      timestampMs: nowMs,
      roundNumber: s.roundCount,
      source: 'PLAYER_MEDKIT',
      targetName: 'Operator Suit',
      zone: 'torso',
      zoneLabel: 'Medic Kit (+40% HP)',
      rawDamage: actualGain,
      hpDamage: actualGain,
      remainingHp: nextHp,
      isCrit: false,
      isKill: false,
      isMiss: false,
      distanceM: 0,
    };
    setLogs((prev) => [entry, ...prev].slice(0, 120));
  }, []);

  const handleEnemyClawAttack = useCallback(
    (isDualSpecial: boolean, damage: number, attackerName: string) => {
      const s = stateRef.current;
      if (s.playerHp <= 0) return;

      s.outOfCombatSec = 0;
      setOutOfCombatSec(0);

      const nextExact = Math.max(0, s.playerHpExact - damage);
      const nextPlayerHp = Math.max(0, Math.round(nextExact));
      s.playerHpExact = nextExact;
      s.playerHp = nextPlayerHp;
      setPlayerHp(nextPlayerHp);

      const nowMs = s.startTimeMs > 0 ? Math.round(performance.now() - s.startTimeMs) : s.elapsedMs;
      const entry: CombatLogEntry = {
        id: `claw-${Date.now()}-${Math.random()}`,
        timestampMs: nowMs,
        roundNumber: s.roundCount,
        source: isDualSpecial ? 'ENEMY_DUAL_CLAW' : 'ENEMY_CLAW',
        targetName: attackerName,
        zone: 'torso',
        zoneLabel: isDualSpecial ? 'Dual-Claw Special' : 'Claw Slash',
        rawDamage: damage,
        hpDamage: damage,
        remainingHp: nextPlayerHp,
        isCrit: isDualSpecial,
        isKill: false,
        isMiss: false,
        distanceM: 3,
      };
      setLogs((prev) => [entry, ...prev].slice(0, 120));

      if (nextPlayerHp <= 0) {
        soundEngine.playPlayerDown();
        setIsSimRunning(false);
      } else {
        soundEngine.playPlayerHurt(isDualSpecial);
      }
    },
    []
  );

  const handleEnemyDroneShot = useCallback((damage: number, attackerName: string) => {
    const s = stateRef.current;
    if (s.playerHp <= 0) return;

    s.outOfCombatSec = 0;
    setOutOfCombatSec(0);

    const nextExact = Math.max(0, s.playerHpExact - damage);
    const nextPlayerHp = Math.max(0, Math.round(nextExact));
    s.playerHpExact = nextExact;
    s.playerHp = nextPlayerHp;
    setPlayerHp(nextPlayerHp);

    const nowMs = s.startTimeMs > 0 ? Math.round(performance.now() - s.startTimeMs) : s.elapsedMs;
    const entry: CombatLogEntry = {
      id: `drone-${Date.now()}-${Math.random()}`,
      timestampMs: nowMs,
      roundNumber: s.roundCount,
      source: 'ENEMY_DRONE_BOLT',
      targetName: attackerName,
      zone: 'weakspot',
      zoneLabel: 'Arc Stabilizer Bolt',
      rawDamage: damage,
      hpDamage: damage,
      remainingHp: nextPlayerHp,
      isCrit: false,
      isKill: false,
      isMiss: false,
      distanceM: 18,
    };
    setLogs((prev) => [entry, ...prev].slice(0, 120));

    if (nextPlayerHp <= 0) {
      soundEngine.playPlayerDown();
      setIsSimRunning(false);
    } else {
      soundEngine.playPlayerHurt(false);
    }
  }, []);

  const handleSquadCleared = useCallback(() => {
    setIsSimRunning(false);
  }, []);

  const handleToggleEngage = useCallback(() => {
    if (isSimRunning) {
      setIsSimRunning(false);
      return;
    }
    if (stateRef.current.playerHp <= 0) {
      resetRangeState();
    }
    setIsPaused(false);
    setIsSimRunning(true);
  }, [isSimRunning, resetRangeState]);

  const metrics = useMemo(
    () => summarizeEngagement([...logs].reverse(), config, elapsedMs, weapons, targets),
    [logs, config, elapsedMs, weapons, targets]
  );

  const handleSaveRun = useCallback(() => {
    if (logs.length === 0) return;
    const weapon = getWeaponById(config.weaponId, weapons);
    const target = getTargetById(config.targetId, targets);

    const now = new Date();
    const recordedAt = now.toTimeString().slice(0, 8);

    const newRun: SavedTelemetryRun = {
      id: `run-${Date.now()}`,
      recordedAt,
      weaponName: weapon.name,
      weaponCode: weapon.code,
      targetName: config.groupSize > 1 ? `${target.name} (x${config.groupSize})` : target.name,
      distanceM: config.distanceM,
      firingMode: config.firingMode,
      metrics,
    };

    setSavedRuns((prev) => [newRun, ...prev]);
    setArchiveNotice(`Archived ${weapon.code} vs Squad (${metrics.effectiveDps} DPS)`);
    window.setTimeout(() => setArchiveNotice(null), 3200);
  }, [logs.length, config, metrics, weapons, targets]);

  const handleTopBarPrimaryAction = () => {
    if (activeScreen === 'range') {
      handleToggleEngage();
    } else {
      setActiveScreen('range');
    }
  };

  useMemo(() => computeTheoreticalTelemetry(config, weapons, targets), [config, weapons, targets]);

  const currentWaveGroupSize = Math.min(
    MAX_SPAWN_LIMIT,
    waveNumber === 1 && waveTriggerToken === 0
      ? config.groupSize
      : (config.waveGroupSizes[waveNumber - 1] ??
        Math.round(
          (config.waveGroupSizes[config.waveGroupSizes.length - 1] ?? config.groupSize) *
            Math.pow(1.5, Math.max(0, waveNumber - config.waveGroupSizes.length))
        ))
  );

  return (
    <div className="min-h-screen bg-[#0a0d12] text-[#e1e2ea] flex flex-col">
      <TopBar
        activeScreen={activeScreen}
        onSelectScreen={(scr) => {
          if (scr !== 'range') setIsPaused(false);
          setActiveScreen(scr);
        }}
        isSimRunning={isSimRunning}
        onPrimaryAction={handleTopBarPrimaryAction}
      />

      {archiveNotice && (
        <div className="fixed bottom-4 right-4 z-50 chamfer-sm bg-[#161c28] border border-[#20df78] px-4 py-2.5 font-mono text-xs text-[#20df78] shadow-[0_0_14px_rgba(32,223,120,0.25)]">
          {archiveNotice}
        </div>
      )}

      <main className="flex-1 w-full">
        {activeScreen === 'range' && (
          <div className="max-w-[1600px] mx-auto p-3 sm:p-4 lg:p-5 space-y-3">
            <div className="md:hidden grid grid-cols-3 gap-1 bg-[#121721] border border-[#1e2638] p-1">
              {(['SIM', 'INPUTS', 'TELEMETRY'] as MobileTab[]).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setMobileTab(tab)}
                  className={`py-2 font-mono text-xs font-semibold tracking-[0.08em] uppercase cursor-pointer ${
                    mobileTab === tab
                      ? 'bg-[#ffb300] text-[#0a0d12]'
                      : 'text-[#8c9bb5] hover:text-[#e1e2ea]'
                  }`}
                >
                  [{tab}]
                </button>
              ))}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-start">
              <div
                className={`${
                  mobileTab === 'SIM' ? 'block' : 'hidden md:block'
                } md:col-span-12 xl:col-span-6 xl:order-2`}
              >
                <SimulationCanvas3D
                  config={config}
                  weapons={weapons}
                  targets={targets}
                  playerHp={playerHp}
                  maxPlayerHp={MAX_PLAYER_HP}
                  outOfCombatSec={outOfCombatSec}
                  outOfCombatWindowSec={OUT_OF_COMBAT_WINDOW_SEC}
                  medkitCooldownSec={medkitCooldownSec}
                  waveNumber={waveNumber}
                  waveGroupSize={currentWaveGroupSize}
                  waveTriggerToken={waveTriggerToken}
                  magRemaining={magRemaining}
                  isReloading={isReloading}
                  isSimRunning={isSimRunning}
                  isPaused={isPaused}
                  metrics={metrics}
                  onTriggerShot={handleTriggerShot}
                  onManualReload={handleManualReload}
                  onUseMedkit={handleUseMedkit}
                  onSetPaused={setIsPaused}
                  onStartNextWave={handleStartNextWave}
                  onOpenRooms={() => {
                    setIsPaused(false);
                    setActiveScreen('rooms');
                  }}
                  onSquadShotResolved={handleSquadShotResolved}
                  onEnemyClawAttack={handleEnemyClawAttack}
                  onEnemyDroneShot={handleEnemyDroneShot}
                  onSquadCleared={handleSquadCleared}
                  onResetRange={() => resetRangeState()}
                  resetToken={resetToken}
                />
              </div>

              <div
                className={`${
                  mobileTab === 'INPUTS' ? 'block' : 'hidden md:block'
                } md:col-span-6 xl:col-span-3 xl:order-1`}
              >
                <LeftTelemetryPanel
                  config={config}
                  weapons={weapons}
                  targets={targets}
                  waveNumber={waveNumber}
                  isSimRunning={isSimRunning}
                  onChangeConfig={handleChangeConfig}
                  onChangeChassisSpawnCount={handleChangeChassisSpawnCount}
                  onChangeWaveSize={handleChangeWaveSize}
                  onStartNextWave={handleStartNextWave}
                  onSelectTargetPreset={handleSelectTargetPreset}
                  onOpenRooms={() => setActiveScreen('rooms')}
                  onEngageBurst={handleToggleEngage}
                  onResetRange={() => resetRangeState()}
                  onCycleTarget={handleCycleTarget}
                />
              </div>

              <div
                className={`${
                  mobileTab === 'TELEMETRY' ? 'block' : 'hidden md:block'
                } md:col-span-6 xl:col-span-3 xl:order-3`}
              >
                <RightCombatLogPanel
                  config={config}
                  weapons={weapons}
                  targets={targets}
                  logs={logs}
                  metrics={metrics}
                  onSaveRun={handleSaveRun}
                  onClearLogs={() => setLogs([])}
                />
              </div>
            </div>
          </div>
        )}

        {activeScreen === 'rooms' && (
          <RoomsScreen
            selectedRoomId={config.roomId}
            onSelectRoom={handleSelectRoom}
            onDeployToRange={(roomId) => {
              if (roomId && roomId !== config.roomId) {
                handleSelectRoom(roomId);
              }
              setActiveScreen('range');
            }}
          />
        )}

        {activeScreen === 'armory' && (
          <ArmoryScreen
            config={config}
            weapons={weapons}
            onChangeConfig={handleChangeConfig}
            onUpdateWeapon={handleUpdateWeapon}
            onResetWeapons={handleResetWeapons}
            onDeployToRange={() => setActiveScreen('range')}
          />
        )}

        {activeScreen === 'targets' && (
          <TargetsScreen
            config={config}
            targets={targets}
            weapons={weapons}
            onUpdateTarget={handleUpdateTarget}
            onResetTargets={handleResetTargets}
            onSelectTargetAndOpenRange={(targetId) => {
              handleSelectTargetPreset(targetId);
              setActiveScreen('range');
            }}
          />
        )}

        {activeScreen === 'telemetry' && (
          <TelemetryArchiveScreen
            runs={savedRuns}
            onDeleteRun={(id) => setSavedRuns((prev) => prev.filter((r) => r.id !== id))}
            onClearAll={() => setSavedRuns([])}
            onOpenRange={() => setActiveScreen('range')}
          />
        )}
      </main>
    </div>
  );
}
