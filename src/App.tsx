/**
 * @file App.tsx
 * Root application orchestrator managing `SimulationConfig`, mutable weapon/consumable/target catalogs,
 * synchronous magazine/reload/cooldown state (`stateRef`), wave progression, and screen routing.
 *
 * Key architectural patterns & why alternatives would be worse:
 * 1. Dual `stateRef` + React `useState` mirrors:
 *    The 3D WebGL simulation loop fires automatic weapons up to 1,200 RPM (~50ms cadence) and runs inside
 *    long-lived `requestAnimationFrame` closures. Relying solely on React `useState` closures for magazine
 *    counts, reload flags, or player HP would cause stale reads and double-fired "ghost bullets" before React
 *    commits a re-render. Mutating `stateRef.current` synchronously inside `handleTriggerShot` / `startReloadSequence`
 *    and mirroring values to `useState` guarantees atomic bullet/ammo accounting at any framerate.
 * 2. CSS `hidden` persistence for the `range` workspace:
 *    Switching between `Range Sim`, `Rooms`, `Armory`, `Targets`, and `Telemetry` toggles a CSS `hidden` class
 *    instead of conditionally unmounting `<SimulationCanvas3D />`. Unmounting would tear down WebGL shaders,
 *    deployed trip mines/C4/turrets, live enemy HP, and wave state.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { soundEngine } from './audio/soundEngine';
import { ArmoryScreen } from './components/ArmoryScreen';
import { LeftTelemetryPanel } from './components/LeftTelemetryPanel';
import { PrimaryChassisPanel } from './components/PrimaryChassisPanel';
import { RightCombatLogPanel } from './components/RightCombatLogPanel';
import { RoomsScreen } from './components/RoomsScreen';
import { SimulationCanvas3D, SquadShotSummary } from './components/SimulationCanvas3D';
import { StartScreen } from './components/StartScreen';
import { TargetsScreen } from './components/TargetsScreen';
import { TelemetryArchiveScreen } from './components/TelemetryArchiveScreen';
import { TopBar } from './components/TopBar';
import { GRENADES, TARGET_PROFILES, WEAPONS } from './data/arsenal';
import {
  computeTheoreticalTelemetry,
  getEffectiveReloadDurationMs,
  getTargetById,
  getWeaponById,
  summarizeEngagement,
} from './engine/ballistics';
import {
  AppScreen,
  CombatLogEntry,
  EnemyEncounterRecord,
  GrenadeId,
  GrenadeProfile,
  RoomLayoutId,
  SavedTelemetryRun,
  SimulationConfig,
  TargetProfile,
  WeaponPerformanceRecord,
  WeaponProfile,
  WeaponSlot,
} from './types/ballistics';

type MobileTab = 'SIM' | 'INPUTS' | 'TELEMETRY';

const MAX_PLAYER_HP = 100;
const REGEN_HP_CAP = Math.round(MAX_PLAYER_HP * 0.4);
const OUT_OF_COMBAT_WINDOW_SEC = 5.0;
const REGEN_HP_PER_SEC = 4.0;
const MEDKIT_COOLDOWN_SEC = 12.0;
const MAX_SPAWN_LIMIT = 120;

/**
 * Builds the 5-wave squad schedule scaling +50% per wave up to `MAX_SPAWN_LIMIT` (120).
 * Keeping explicit per-wave numbers lets users customize individual waves in `LeftTelemetryPanel`
 * rather than locking wave scaling to a rigid formula.
 */
function buildWaveSizesFromBase(baseW1: number): number[] {
  const clamped = Math.max(1, Math.min(MAX_SPAWN_LIMIT, Math.round(baseW1)));
  return [0, 1, 2, 3, 4].map((i) =>
    Math.min(MAX_SPAWN_LIMIT, Math.round(clamped * Math.pow(1.5, i)))
  );
}

/**
 * Proportionally rescales per-chassis spawn counts using largest-remainder rounding when the
 * user adjusts total Wave 1 `groupSize`, ensuring the sum matches `targetTotal` cleanly without
 * fractional truncation drift (a naive `Math.round` per chassis often sums to `targetTotal ± 2`).
 */
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
  primaryWeaponId: 'm47_rail',
  secondaryWeaponId: 'ironclad_br',
  grenadeId: 'explosive',
  activeSlot: 'PRIMARY',
  firingMode: 'FULL_AUTO',
  targetId: 'aegis_exo',
  targetHp: 440,
  distanceM: 45,
  aimZone: 'weakspot',
  approachPattern: 'ADAPTIVE',
  groupSize: 24,
  waveGroupSizes: [24, 36, 54, 81, 120],
  chassisSpawnCounts: {
    skitter_swarmer: 6,
    stalker_mech: 4,
    vanguard_drone: 4,
    aegis_exo: 4,
    ravager_brute: 3,
    bastion_tank: 2,
    chitin_titan: 1,
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

const initialPrimaryW = getWeaponById(INITIAL_CONFIG.primaryWeaponId, WEAPONS);
const initialSecondaryW = getWeaponById(INITIAL_CONFIG.secondaryWeaponId, WEAPONS);

const computeInitialReserve = (w: WeaponProfile) =>
  w.weaponClass === 'MELEE' ? 0 : Math.max(0, (w.maxMagazines - 1) * w.magSize);

const buildInitialConsumableUsages = (
  grenadesList: GrenadeProfile[] = GRENADES
): Record<GrenadeId, number> => {
  const map = {} as Record<GrenadeId, number>;
  for (const g of grenadesList) {
    map[g.id] = g.maxUsages;
  }
  return map;
};

const buildInitialWeaponAmmoMap = (
  list: WeaponProfile[]
): Record<string, { mag: number; reserve: number }> => {
  const map: Record<string, { mag: number; reserve: number }> = {};
  for (const w of list) {
    map[w.id] = {
      mag: w.weaponClass === 'MELEE' ? 0 : w.magSize,
      reserve: computeInitialReserve(w),
    };
  }
  return map;
};

export default function App() {
  const [activeScreen, setActiveScreen] = useState<AppScreen>('range');
  const [showStartScreen, setShowStartScreen] = useState<boolean>(true);
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
  const [grenades, setGrenades] = useState<GrenadeProfile[]>(() =>
    GRENADES.map((g) => ({ ...g }))
  );
  const [targets, setTargets] = useState<TargetProfile[]>(() =>
    TARGET_PROFILES.map((t) => ({ ...t }))
  );
  const [config, setConfig] = useState<SimulationConfig>(INITIAL_CONFIG);

  const [playerHp, setPlayerHp] = useState<number>(MAX_PLAYER_HP);
  const [magRemaining, setMagRemaining] = useState<number>(() => initialPrimaryW.magSize);
  const [reserveAmmo, setReserveAmmo] = useState<number>(() =>
    computeInitialReserve(initialPrimaryW)
  );
  const [consumableUsages, setConsumableUsages] = useState<Record<GrenadeId, number>>(
    () => buildInitialConsumableUsages(GRENADES)
  );
  const [weaponAmmoMap, setWeaponAmmoMap] = useState<
    Record<string, { mag: number; reserve: number }>
  >(() => buildInitialWeaponAmmoMap(WEAPONS));
  const [isReloading, setIsReloading] = useState<boolean>(false);
  const [isSimRunning, setIsSimRunning] = useState<boolean>(false);
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const [waveNumber, setWaveNumber] = useState<number>(1);
  const [waveTriggerToken, setWaveTriggerToken] = useState<number>(0);
  const [outOfCombatSec, setOutOfCombatSec] = useState<number>(OUT_OF_COMBAT_WINDOW_SEC);
  const [medkitCooldownSec, setMedkitCooldownSec] = useState<number>(0);
  const [grenadeCooldownSec, setGrenadeCooldownSec] = useState<number>(0);
  const [logs, setLogs] = useState<CombatLogEntry[]>([]);
  const [elapsedMs, setElapsedMs] = useState<number>(0);
  const [savedRuns, setSavedRuns] = useState<SavedTelemetryRun[]>(SEED_RUNS);
  const [archiveNotice, setArchiveNotice] = useState<string | null>(null);
  const [resetToken, setResetToken] = useState<number>(0);
  const [doorResetToken, setDoorResetToken] = useState<number>(0);

  const buildInitialWeaponPerfMap = (list: WeaponProfile[]): Record<string, WeaponPerformanceRecord> => {
    const map: Record<string, WeaponPerformanceRecord> = {};
    for (const w of list) {
      map[w.id] = {
        weaponId: w.id,
        weaponCode: w.code,
        weaponName: w.name,
        category: w.category,
        shotsFired: 0,
        shotsLanded: 0,
        totalHits: 0,
        weakspotHits: 0,
        armorHits: 0,
        extremityHits: 0,
        nearMisses: 0,
        totalDamage: 0,
        activeTimeMs: 0,
        lastActionMs: 0,
        perTarget: {},
      };
    }
    return map;
  };

  // Synchronous weapon/telemetry refs prevent stale closure reads inside high-RPM 60Hz callbacks.
  const encounterMapRef = useRef<Map<number, EnemyEncounterRecord>>(new Map());
  const weaponPerfMapRef = useRef<Record<string, WeaponPerformanceRecord>>(
    buildInitialWeaponPerfMap(WEAPONS)
  );
  const [enemyEncounters, setEnemyEncounters] = useState<EnemyEncounterRecord[]>([]);
  const [weaponPerformances, setWeaponPerformances] = useState<
    Record<string, WeaponPerformanceRecord>
  >(() => buildInitialWeaponPerfMap(WEAPONS));

  // Per-slot & per-weapon ammo caches allow switching guns mid-wave without losing partial magazines.
  const slotMagRef = useRef<Record<'PRIMARY' | 'SECONDARY', number>>({
    PRIMARY: initialPrimaryW.magSize,
    SECONDARY: initialSecondaryW.magSize,
  });
  const slotReserveRef = useRef<Record<'PRIMARY' | 'SECONDARY', number>>({
    PRIMARY: computeInitialReserve(initialPrimaryW),
    SECONDARY: computeInitialReserve(initialSecondaryW),
  });
  const weaponAmmoMapRef = useRef<Record<string, { mag: number; reserve: number }>>(
    buildInitialWeaponAmmoMap(WEAPONS)
  );
  const lastCombatSlotRef = useRef<'PRIMARY' | 'SECONDARY'>('PRIMARY');

  const stateRef = useRef({
    playerHp: MAX_PLAYER_HP,
    playerHpExact: MAX_PLAYER_HP,
    outOfCombatSec: OUT_OF_COMBAT_WINDOW_SEC,
    medkitCooldownSec: 0,
    grenadeCooldownSec: 0,
    consumableUsages: buildInitialConsumableUsages(),
    mag: initialPrimaryW.magSize,
    reserve: computeInitialReserve(initialPrimaryW),
    reloading: false,
    roundCount: 0,
    elapsedMs: 0,
    startTimeMs: 0,
    waveNumber: 1,
    isPaused: false,
    showStartScreen: true,
    activeScreen: 'range' as AppScreen,
    config: INITIAL_CONFIG,
    weapons,
    grenades,
    targets,
  });

  stateRef.current.config = config;
  stateRef.current.weapons = weapons;
  stateRef.current.grenades = grenades;
  stateRef.current.targets = targets;
  stateRef.current.isPaused = isPaused;
  stateRef.current.showStartScreen = showStartScreen;
  stateRef.current.activeScreen = activeScreen;
  stateRef.current.waveNumber = waveNumber;
  stateRef.current.consumableUsages = consumableUsages;

  const reloadTimerRef = useRef<number | null>(null);

  /** Cancels any pending single-mag or shell-by-shell reload `setTimeout` cleanly on weapon switch/interrupt. */
  const clearReloadTimer = useCallback(() => {
    if (reloadTimerRef.current !== null) {
      window.clearTimeout(reloadTimerRef.current);
      reloadTimerRef.current = null;
    }
  }, []);

  /**
   * 10Hz background ticker managing medkit/ordnance cooldowns and out-of-combat passive regeneration.
   * Throttled at 100ms instead of 60Hz to keep React sidebar re-renders lightweight; freezes cleanly when
   * paused, dead, in pre-wave staging, or viewing non-range tabs.
   */
  useEffect(() => {
    const interval = window.setInterval(() => {
      const s = stateRef.current;
      if (s.isPaused || s.showStartScreen || s.activeScreen !== 'range' || s.playerHp <= 0) return;

      const dt = 0.1;

      if (s.medkitCooldownSec > 0) {
        s.medkitCooldownSec = Math.max(0, s.medkitCooldownSec - dt);
        setMedkitCooldownSec(Math.round(s.medkitCooldownSec * 10) / 10);
      }

      if (s.grenadeCooldownSec > 0) {
        s.grenadeCooldownSec = Math.max(0, s.grenadeCooldownSec - dt);
        setGrenadeCooldownSec(Math.round(s.grenadeCooldownSec * 10) / 10);
      }

      if (s.outOfCombatSec < OUT_OF_COMBAT_WINDOW_SEC) {
        s.outOfCombatSec = Math.min(OUT_OF_COMBAT_WINDOW_SEC, s.outOfCombatSec + dt);
        setOutOfCombatSec(s.outOfCombatSec);
      } else if (s.playerHpExact < REGEN_HP_CAP) {
        // Player only heals passively after 5s out of combat when below 40% HP, capped at 40% HP
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

  /**
   * Full new-game / range reset: restores HP, ammo, consumable charges, Wave 1, clears logs,
   * increments `resetToken` (which wipes deployed mines/C4/turrets/drops in `SimulationCanvas3D`),
   * and optionally increments `doorResetToken` to restore breached entrance doors & cover walls.
   */
  const resetRangeState = useCallback(
    (nextCfg?: SimulationConfig, preserveDoors = false) => {
      clearReloadTimer();
      const cfg = nextCfg ?? stateRef.current.config;
      const freshAmmoMap = buildInitialWeaponAmmoMap(stateRef.current.weapons);
      weaponAmmoMapRef.current = freshAmmoMap;
      setWeaponAmmoMap({ ...freshAmmoMap });

      const primaryW = getWeaponById(cfg.primaryWeaponId, stateRef.current.weapons);
      const secondaryW = getWeaponById(cfg.secondaryWeaponId, stateRef.current.weapons);
      slotMagRef.current.PRIMARY = primaryW.magSize;
      slotMagRef.current.SECONDARY = secondaryW.magSize;
      slotReserveRef.current.PRIMARY = computeInitialReserve(primaryW);
      slotReserveRef.current.SECONDARY = computeInitialReserve(secondaryW);
      const weapon = getWeaponById(cfg.weaponId, stateRef.current.weapons);
      const weaponReserve = computeInitialReserve(weapon);
      const freshConsumables = buildInitialConsumableUsages(stateRef.current.grenades);

      setIsSimRunning(false);
      setIsPaused(false);
      setIsReloading(false);
      setPlayerHp(MAX_PLAYER_HP);
      setOutOfCombatSec(OUT_OF_COMBAT_WINDOW_SEC);
      setMedkitCooldownSec(0);
      setGrenadeCooldownSec(0);
      setConsumableUsages(freshConsumables);
      setWaveNumber(1);
      setMagRemaining(weapon.magSize);
      setReserveAmmo(weaponReserve);
      setLogs([]);
      setElapsedMs(0);
      setResetToken((t) => t + 1);
      if (!preserveDoors) {
        setDoorResetToken((t) => t + 1);
      }

      stateRef.current.playerHp = MAX_PLAYER_HP;
      stateRef.current.playerHpExact = MAX_PLAYER_HP;
      stateRef.current.outOfCombatSec = OUT_OF_COMBAT_WINDOW_SEC;
      stateRef.current.medkitCooldownSec = 0;
      stateRef.current.grenadeCooldownSec = 0;
      stateRef.current.consumableUsages = freshConsumables;
      stateRef.current.waveNumber = 1;
      stateRef.current.mag = weapon.magSize;
      stateRef.current.reserve = weaponReserve;
      stateRef.current.reloading = false;
      stateRef.current.roundCount = 0;
      stateRef.current.elapsedMs = 0;
      stateRef.current.startTimeMs = 0;
    },
    [clearReloadTimer]
  );

  /**
   * Equips a weapon into `PRIMARY` or `SECONDARY`. Saves the outgoing gun's magazine & reserve
   * into `weaponAmmoMapRef`, and either restores the incoming gun's prior ammo (`preserveAmmo = true`,
   * used by the `[E]` inventory) or loads full default magazines (Armory / Pre-Deployment Loadout).
   */
  const handleSelectSlotWeapon = useCallback(
    (slot: WeaponSlot, weaponId: string, preserveAmmo = false) => {
      if (slot === 'CONSUMABLE') return;
      clearReloadTimer();
      const s = stateRef.current;
      const prevCfg = s.config;

      // Persist current weapon ammo before equipping a different weapon in-field
      if (prevCfg.activeSlot === 'PRIMARY' || prevCfg.activeSlot === 'SECONDARY') {
        slotMagRef.current[prevCfg.activeSlot] = s.mag;
        slotReserveRef.current[prevCfg.activeSlot] = s.reserve;
        weaponAmmoMapRef.current[prevCfg.weaponId] = {
          mag: s.mag,
          reserve: s.reserve,
        };
      }

      const newWeapon = getWeaponById(weaponId, s.weapons);
      const existing = weaponAmmoMapRef.current[newWeapon.id];
      const nextMag =
        preserveAmmo && existing
          ? Math.max(0, Math.min(newWeapon.magSize, existing.mag))
          : newWeapon.magSize;
      const nextReserve =
        preserveAmmo && existing
          ? Math.max(0, existing.reserve)
          : computeInitialReserve(newWeapon);

      weaponAmmoMapRef.current[newWeapon.id] = { mag: nextMag, reserve: nextReserve };
      setWeaponAmmoMap({ ...weaponAmmoMapRef.current });

      slotMagRef.current[slot] = nextMag;
      slotReserveRef.current[slot] = nextReserve;
      lastCombatSlotRef.current = slot;
      s.mag = nextMag;
      s.reserve = nextReserve;
      s.reloading = false;
      setMagRemaining(nextMag);
      setReserveAmmo(nextReserve);
      setIsReloading(false);

      setConfig((prev) => ({
        ...prev,
        activeSlot: slot,
        weaponId: newWeapon.id,
        primaryWeaponId: slot === 'PRIMARY' ? newWeapon.id : prev.primaryWeaponId,
        secondaryWeaponId: slot === 'SECONDARY' ? newWeapon.id : prev.secondaryWeaponId,
        firingMode: newWeapon.defaultFiringMode ?? 'FULL_AUTO',
      }));
    },
    [clearReloadTimer]
  );

  /**
   * Switches active operator hand slot (`PRIMARY` <-> `SECONDARY` <-> `CONSUMABLE`) via `[1]`/`[2]`/`Wheel`,
   * preserving magazine/reserve state of the outgoing gun and cancelling any in-progress reload timer.
   */
  const handleSwitchActiveSlot = useCallback(
    (slot: WeaponSlot) => {
      const s = stateRef.current;
      const prevCfg = s.config;
      if (prevCfg.activeSlot === slot) return;
      clearReloadTimer();

      // Persist magazine & reserve for combat slot before switching
      if (prevCfg.activeSlot === 'PRIMARY' || prevCfg.activeSlot === 'SECONDARY') {
        slotMagRef.current[prevCfg.activeSlot] = s.mag;
        slotReserveRef.current[prevCfg.activeSlot] = s.reserve;
        weaponAmmoMapRef.current[prevCfg.weaponId] = {
          mag: s.mag,
          reserve: s.reserve,
        };
        setWeaponAmmoMap({ ...weaponAmmoMapRef.current });
        lastCombatSlotRef.current = prevCfg.activeSlot;
      }

      if (slot === 'CONSUMABLE') {
        s.reloading = false;
        setIsReloading(false);
        setConfig((prev) => ({ ...prev, activeSlot: 'CONSUMABLE' }));
        return;
      }

      lastCombatSlotRef.current = slot;
      const nextWeaponId =
        slot === 'PRIMARY' ? prevCfg.primaryWeaponId : prevCfg.secondaryWeaponId;
      const nextWeapon = getWeaponById(nextWeaponId, s.weapons);
      const savedEntry = weaponAmmoMapRef.current[nextWeapon.id];
      const restoredMag = Math.max(
        0,
        Math.min(
          nextWeapon.magSize,
          savedEntry?.mag ?? slotMagRef.current[slot] ?? nextWeapon.magSize
        )
      );
      const restoredReserve = Math.max(
        0,
        savedEntry?.reserve ?? slotReserveRef.current[slot] ?? computeInitialReserve(nextWeapon)
      );

      s.mag = restoredMag;
      s.reserve = restoredReserve;
      s.reloading = false;
      setMagRemaining(restoredMag);
      setReserveAmmo(restoredReserve);
      setIsReloading(false);

      setConfig((prev) => ({
        ...prev,
        activeSlot: slot,
        weaponId: nextWeapon.id,
        firingMode: nextWeapon.defaultFiringMode ?? 'FULL_AUTO',
      }));
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
          const newSlot: 'PRIMARY' | 'SECONDARY' =
            newWeapon.slot === 'SECONDARY' ? 'SECONDARY' : 'PRIMARY';
          const newReserve = computeInitialReserve(newWeapon);
          slotMagRef.current[newSlot] = newWeapon.magSize;
          slotReserveRef.current[newSlot] = newReserve;
          lastCombatSlotRef.current = newSlot;
          next.activeSlot = newSlot;
          if (newSlot === 'PRIMARY') next.primaryWeaponId = newWeapon.id;
          else next.secondaryWeaponId = newWeapon.id;
          if (patch.firingMode === undefined) {
            next.firingMode = newWeapon.defaultFiringMode ?? 'FULL_AUTO';
          }
          setMagRemaining(newWeapon.magSize);
          setReserveAmmo(newReserve);
          stateRef.current.mag = newWeapon.magSize;
          stateRef.current.reserve = newReserve;
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

  /**
   * Advances to the next combat wave (`waveTriggerToken += 1`) without calling `resetRangeState`.
   * Restocks firearm reserve ammunition while intentionally leaving deployed trip mines, C4, turrets,
   * ammo drops, and remaining consumable charges intact across wave boundaries.
   */
  const handleStartNextWave = useCallback(() => {
    if (stateRef.current.playerHp <= 0) {
      resetRangeState();
      return;
    }
    // Restock ranged weapon reserves at the start of each advancing wave (deployed consumables & charges persist)
    const cfg = stateRef.current.config;
    for (const w of stateRef.current.weapons) {
      if (w.weaponClass === 'MELEE') continue;
      const cur = weaponAmmoMapRef.current[w.id];
      weaponAmmoMapRef.current[w.id] = {
        mag: cur ? cur.mag : w.magSize,
        reserve: computeInitialReserve(w),
      };
    }
    setWeaponAmmoMap({ ...weaponAmmoMapRef.current });
    const pw = getWeaponById(cfg.primaryWeaponId, stateRef.current.weapons);
    const sw = getWeaponById(cfg.secondaryWeaponId, stateRef.current.weapons);
    slotReserveRef.current.PRIMARY = computeInitialReserve(pw);
    slotReserveRef.current.SECONDARY = computeInitialReserve(sw);
    if (cfg.activeSlot === 'PRIMARY' || cfg.activeSlot === 'SECONDARY') {
      const activeReserve = slotReserveRef.current[cfg.activeSlot];
      stateRef.current.reserve = activeReserve;
      setReserveAmmo(activeReserve);
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

  /**
   * Live Armory weapon stat mutator. Syncs `magSize`/`maxMagazines` edits straight into `stateRef` and
   * active slots while leaving existing deployed world objects untouched.
   */
  const handleUpdateWeapon = useCallback(
    (weaponId: string, patch: Partial<WeaponProfile>) => {
      setWeapons((prev) =>
        prev.map((w) => {
          if (w.id !== weaponId) return w;
          const updated = { ...w, ...patch };
          if (patch.magSize !== undefined || patch.maxMagazines !== undefined) {
            const nextRes = computeInitialReserve(updated);
            if (weaponId === stateRef.current.config.primaryWeaponId) {
              slotMagRef.current.PRIMARY = updated.magSize;
              slotReserveRef.current.PRIMARY = nextRes;
            }
            if (weaponId === stateRef.current.config.secondaryWeaponId) {
              slotMagRef.current.SECONDARY = updated.magSize;
              slotReserveRef.current.SECONDARY = nextRes;
            }
            if (weaponId === stateRef.current.config.weaponId) {
              setMagRemaining(updated.magSize);
              setReserveAmmo(nextRes);
              stateRef.current.mag = updated.magSize;
              stateRef.current.reserve = nextRes;
            }
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
    const pw = getWeaponById(stateRef.current.config.primaryWeaponId, fresh);
    const sw = getWeaponById(stateRef.current.config.secondaryWeaponId, fresh);
    slotMagRef.current.PRIMARY = pw.magSize;
    slotMagRef.current.SECONDARY = sw.magSize;
    slotReserveRef.current.PRIMARY = computeInitialReserve(pw);
    slotReserveRef.current.SECONDARY = computeInitialReserve(sw);
    const active = getWeaponById(stateRef.current.config.weaponId, fresh);
    const activeRes = computeInitialReserve(active);
    setMagRemaining(active.magSize);
    setReserveAmmo(activeRes);
    stateRef.current.mag = active.magSize;
    stateRef.current.reserve = activeRes;
  }, []);

  /**
   * Live Armory consumable ordnance stat mutator. Immediately propagates damage, falloff range,
   * turret HP/armor/cap, pierce depth, and `maxUsages` into `stateRef` & `SimulationCanvas3D`.
   */
  const handleUpdateGrenade = useCallback(
    (grenadeId: GrenadeId, patch: Partial<GrenadeProfile>) => {
      setGrenades((prev) =>
        prev.map((g) => {
          if (g.id !== grenadeId) return g;
          const updated = { ...g, ...patch };
          if (patch.maxUsages !== undefined) {
            setConsumableUsages((prevU) => {
              const nextU = {
                ...prevU,
                [grenadeId]: Math.min(updated.maxUsages, Math.max(prevU[grenadeId] ?? 0, updated.maxUsages)),
              };
              stateRef.current.consumableUsages = nextU;
              return nextU;
            });
          }
          return updated;
        })
      );
    },
    []
  );

  const handleResetGrenades = useCallback(() => {
    const fresh = GRENADES.map((g) => ({ ...g }));
    setGrenades(fresh);
    const freshUsages = buildInitialConsumableUsages(fresh);
    stateRef.current.consumableUsages = freshUsages;
    setConsumableUsages(freshUsages);
  }, []);

  /** Live `TargetsScreen` enemy chassis mutator (HP, speed, scale, zone multipliers). */
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
      resetRangeState(nextCfg, true);
    },
    [resetRangeState]
  );

  const handleCycleTarget = useCallback(() => {
    const list = stateRef.current.targets;
    const idx = list.findIndex((t) => t.id === config.targetId);
    const nextTarget = list[(idx + 1) % list.length];
    handleSelectTargetPreset(nextTarget.id);
  }, [config.targetId, handleSelectTargetPreset]);

  /**
   * Starts either a single magazine reload (`window.setTimeout` matching `getEffectiveReloadDurationMs`)
   * or an interruptible shell-by-shell reload (`Tempest Breacher`: chained `stepShell` timeouts inserting
   * 1 shell every cycle until full or interrupted by firing).
   *
   * Why chained `setTimeout` + `stateRef` instead of `setInterval` or RAF frame-counting:
   * - Chained `setTimeout` dynamically re-reads `getEffectiveReloadDurationMs(latestWeapon)` after every
   *   shell in case the player tweaks reload speed in Armory mid-reload, executes zero per-frame work,
   *   and cannot drift out of sync with `clearReloadTimer()` on weapon switch or LMB interruption.
   */
  const startReloadSequence = useCallback(
    (weaponId: string) => {
      const s = stateRef.current;
      if (s.reloading || s.playerHp <= 0 || s.reserve <= 0) return;
      const weapon = getWeaponById(weaponId, s.weapons);
      if (weapon.weaponClass === 'MELEE' || s.mag >= weapon.magSize) return;
      clearReloadTimer();
      s.reloading = true;
      setIsReloading(true);
      soundEngine.playReloadStart();

      const reloadDurationMs = getEffectiveReloadDurationMs(weapon);

      if (weapon.shellByShellReload) {
        const stepShell = () => {
          const cur = stateRef.current;
          const latestWeapon = getWeaponById(weaponId, cur.weapons);
          if (!cur.reloading || cur.playerHp <= 0 || cur.reserve <= 0 || cur.mag >= latestWeapon.magSize) {
            reloadTimerRef.current = null;
            cur.reloading = false;
            setIsReloading(false);
            return;
          }
          cur.mag += 1;
          cur.reserve = Math.max(0, cur.reserve - 1);
          setMagRemaining(cur.mag);
          setReserveAmmo(cur.reserve);

          if (cur.mag < latestWeapon.magSize && cur.reserve > 0) {
            soundEngine.playShellInsert();
            reloadTimerRef.current = window.setTimeout(
              stepShell,
              getEffectiveReloadDurationMs(latestWeapon)
            );
          } else {
            reloadTimerRef.current = null;
            cur.reloading = false;
            setIsReloading(false);
            soundEngine.playReloadComplete();
          }
        };
        reloadTimerRef.current = window.setTimeout(stepShell, reloadDurationMs);
        return;
      }

      reloadTimerRef.current = window.setTimeout(() => {
        reloadTimerRef.current = null;
        const cur = stateRef.current;
        const latestWeapon = getWeaponById(weaponId, cur.weapons);
        const needed = Math.max(0, latestWeapon.magSize - cur.mag);
        const loaded = Math.min(needed, cur.reserve);
        cur.mag += loaded;
        cur.reserve = Math.max(0, cur.reserve - loaded);
        cur.reloading = false;
        setMagRemaining(cur.mag);
        setReserveAmmo(cur.reserve);
        setIsReloading(false);
        soundEngine.playReloadComplete();
      }, reloadDurationMs);
    },
    [clearReloadTimer]
  );

  const handleManualReload = useCallback(() => {
    const s = stateRef.current;
    if (s.config.activeSlot === 'CONSUMABLE') return;
    const weapon = getWeaponById(s.config.weaponId, s.weapons);
    if (weapon.weaponClass === 'MELEE') return;
    if (s.reloading || s.playerHp <= 0 || s.mag >= weapon.magSize || s.reserve <= 0) return;
    startReloadSequence(weapon.id);
  }, [startReloadSequence]);

  /**
   * Synchronous trigger gate called by `SimulationCanvas3D` right before firing a round or swinging melee.
   * Handles shell-by-shell reload interruption (`weapon.shellByShellReload && s.mag > 0`), decrements
   * `stateRef.current.mag`, and automatically starts a reload if the final round leaves the magazine empty.
   */
  const handleTriggerShot = useCallback(() => {
    const s = stateRef.current;
    if (s.config.activeSlot === 'CONSUMABLE') return false;
    const weapon = getWeaponById(s.config.weaponId, s.weapons);
    if (weapon.weaponClass === 'MELEE') return true;
    if (s.playerHp <= 0) return false;

    // Shell-by-shell shotguns can interrupt active reloading by firing immediately
    if (weapon.shellByShellReload && s.reloading && s.mag > 0) {
      clearReloadTimer();
      s.reloading = false;
      setIsReloading(false);
    }

    if (s.reloading || s.mag <= 0) return false;

    if (s.roundCount === 0) {
      s.startTimeMs = performance.now();
    }
    s.roundCount += 1;
    s.mag -= 1;
    setMagRemaining(s.mag);

    if (s.mag === 0 && s.reserve > 0) {
      startReloadSequence(weapon.id);
    }

    return true;
  }, [clearReloadTimer, startReloadSequence]);

  /**
   * Telemetry ingestion pipeline invoked after each player gunshot, shotgun blast, melee swing, or shove.
   * - Prepends an entry to the combat feed (capped at 120 items so DOM height & memory stay bounded).
   * - Groups pellet/pierce events by `enemyUid` (`perEnemyInShot`) so a 12-pellet or 32-pellet shotgun
   *   trigger pull increments `shotsTakenToKill` by `+1` rather than `+32` while still plotting every
   *   individual pellet impact & <=0.1m near-miss coordinate (`samples`, capped at 120) on the heatmap.
   * - Accumulates weapon accuracy, zone hits, effective active time (clamping idle gaps >6.5s), and per-chassis TTK/STK.
   */
  const handleSquadShotResolved = useCallback((summary: SquadShotSummary) => {
    const s = stateRef.current;
    const weapon = getWeaponById(summary.weaponId ?? s.config.weaponId, s.weapons);

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

    // Update cumulative per-weapon performance telemetry
    const perfMap = weaponPerfMapRef.current;
    const prevPerf = perfMap[weapon.id] ?? {
      weaponId: weapon.id,
      weaponCode: weapon.code,
      weaponName: weapon.name,
      category: weapon.category,
      shotsFired: 0,
      shotsLanded: 0,
      totalHits: 0,
      weakspotHits: 0,
      armorHits: 0,
      extremityHits: 0,
      nearMisses: 0,
      totalDamage: 0,
      activeTimeMs: 0,
      lastActionMs: 0,
      perTarget: {},
    };
    const perfNow = performance.now();
    const minCadenceMs =
      weapon.weaponClass === 'MELEE'
        ? 380
        : Math.max(45, Math.round(60000 / Math.max(1, weapon.rpm)));
    const deltaMs =
      prevPerf.lastActionMs > 0 && perfNow - prevPerf.lastActionMs <= 6500
        ? Math.max(minCadenceMs * 0.4, perfNow - prevPerf.lastActionMs)
        : minCadenceMs;

    const events = summary.telemetryEvents ?? [];
    let addedWeak = 0;
    let addedArmor = 0;
    let addedLimb = 0;
    let addedNearMiss = 0;

    // Group events in this trigger-pull by enemyUid to compute per-enemy STK breakdown accurately
    const perEnemyInShot = new Map<
      number,
      {
        hitWeak: boolean;
        hitArmor: boolean;
        hitLimb: boolean;
        hadNearMiss: boolean;
        totalDmg: number;
        killed: boolean;
        ttkMs: number | null;
        firstEv: (typeof events)[number];
      }
    >();

    for (const ev of events) {
      if (ev.zone === 'weakspot') addedWeak += 1;
      else if (ev.zone === 'torso') addedArmor += 1;
      else if (ev.zone === 'limb') addedLimb += 1;
      else addedNearMiss += 1;

      let grp = perEnemyInShot.get(ev.enemyUid);
      if (!grp) {
        grp = {
          hitWeak: false,
          hitArmor: false,
          hitLimb: false,
          hadNearMiss: false,
          totalDmg: 0,
          killed: false,
          ttkMs: null,
          firstEv: ev,
        };
        perEnemyInShot.set(ev.enemyUid, grp);
      }
      if (ev.zone === 'weakspot') grp.hitWeak = true;
      else if (ev.zone === 'torso') grp.hitArmor = true;
      else if (ev.zone === 'limb') grp.hitLimb = true;
      else grp.hadNearMiss = true;

      grp.totalDmg += ev.damage;
      if (ev.isKill) {
        grp.killed = true;
        grp.ttkMs = ev.enemyTtkMs ?? grp.ttkMs;
      }
    }

    const encMap = encounterMapRef.current;
    const nextPerTarget = { ...prevPerf.perTarget };

    for (const [enemyUid, grp] of perEnemyInShot.entries()) {
      const ev0 = grp.firstEv;
      let enc = encMap.get(enemyUid);
      if (!enc) {
        enc = {
          enemyUid,
          targetId: ev0.targetId,
          targetName: ev0.targetName,
          targetCode: ev0.targetCode,
          silhouette: ev0.silhouette,
          waveNumber: ev0.waveNumber,
          lastWeaponId: weapon.id,
          lastWeaponName: weapon.name,
          killed: false,
          shotsTakenToKill: 0,
          hitsWeakspot: 0,
          hitsArmor: 0,
          hitsExtremity: 0,
          nearMisses: 0,
          totalDamage: 0,
          ttkMs: null,
          samples: [],
        };
      }

      const enemyEvents = events.filter((e) => e.enemyUid === enemyUid);
      const anyHitEnemy = grp.hitWeak || grp.hitArmor || grp.hitLimb;
      const updatedEnc: EnemyEncounterRecord = {
        ...enc,
        lastWeaponId: weapon.id,
        lastWeaponName: weapon.name,
        shotsTakenToKill: enc.shotsTakenToKill + 1,
        hitsWeakspot: enc.hitsWeakspot + (grp.hitWeak ? 1 : 0),
        hitsArmor: enc.hitsArmor + (!grp.hitWeak && grp.hitArmor ? 1 : 0),
        hitsExtremity:
          enc.hitsExtremity + (!grp.hitWeak && !grp.hitArmor && grp.hitLimb ? 1 : 0),
        nearMisses: enc.nearMisses + (!anyHitEnemy && grp.hadNearMiss ? 1 : 0),
        totalDamage: enc.totalDamage + grp.totalDmg,
        killed: enc.killed || grp.killed,
        ttkMs: grp.killed ? (grp.ttkMs ?? enc.ttkMs) : enc.ttkMs,
        samples: [
          ...enc.samples,
          ...enemyEvents.map((e) => ({
            nx: e.nx,
            ny: e.ny,
            zone: e.zone,
            weaponId: weapon.id,
          })),
        ].slice(-120),
      };
      encMap.set(enemyUid, updatedEnc);

      if (grp.killed && !enc.killed) {
        const curTargetStats = nextPerTarget[ev0.targetId] ?? {
          targetId: ev0.targetId,
          targetName: ev0.targetName,
          targetCode: ev0.targetCode,
          kills: 0,
          totalTtkMs: 0,
          avgTtkMs: null,
          totalStk: 0,
          avgStk: null,
        };
        const nextKills = curTargetStats.kills + 1;
        const nextTotalTtk = curTargetStats.totalTtkMs + Math.max(1, updatedEnc.ttkMs ?? 1);
        const nextTotalStk = curTargetStats.totalStk + updatedEnc.shotsTakenToKill;
        nextPerTarget[ev0.targetId] = {
          ...curTargetStats,
          kills: nextKills,
          totalTtkMs: nextTotalTtk,
          avgTtkMs: Math.round(nextTotalTtk / nextKills),
          totalStk: nextTotalStk,
          avgStk: Math.round((nextTotalStk / nextKills) * 10) / 10,
        };
      }
    }

    const nextPerf: WeaponPerformanceRecord = {
      ...prevPerf,
      weaponCode: weapon.code,
      weaponName: weapon.name,
      category: weapon.category,
      shotsFired: prevPerf.shotsFired + Math.max(1, summary.roundsFiredDelta),
      shotsLanded: prevPerf.shotsLanded + (summary.isMiss ? 0 : 1),
      totalHits: prevPerf.totalHits + addedWeak + addedArmor + addedLimb,
      weakspotHits: prevPerf.weakspotHits + addedWeak,
      armorHits: prevPerf.armorHits + addedArmor,
      extremityHits: prevPerf.extremityHits + addedLimb,
      nearMisses: prevPerf.nearMisses + addedNearMiss,
      totalDamage: prevPerf.totalDamage + summary.hpDamage,
      activeTimeMs: prevPerf.activeTimeMs + deltaMs,
      lastActionMs: perfNow,
      perTarget: nextPerTarget,
    };

    const nextPerfMap = { ...perfMap, [weapon.id]: nextPerf };
    weaponPerfMapRef.current = nextPerfMap;
    setWeaponPerformances(nextPerfMap);
    if (perEnemyInShot.size > 0) {
      setEnemyEncounters(Array.from(encMap.values()).reverse());
    }
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

  /** Replenishes a smaller portion (10%) of ranged ammunition ONLY for the gun currently equipped. */
  const handleCollectAmmoBox = useCallback((): {
    collected: boolean;
    weaponCode: string;
    added: number;
  } => {
    const s = stateRef.current;
    if (s.isPaused || s.playerHp <= 0) {
      return { collected: false, weaponCode: '', added: 0 };
    }
    const cfg = s.config;
    if (cfg.activeSlot !== 'PRIMARY' && cfg.activeSlot !== 'SECONDARY') {
      return { collected: false, weaponCode: '', added: 0 };
    }

    const activeW = getWeaponById(cfg.weaponId, s.weapons);
    if (activeW.weaponClass !== 'RANGED' || activeW.magSize <= 0) {
      return { collected: false, weaponCode: '', added: 0 };
    }

    const curMag = Math.max(0, Math.min(activeW.magSize, s.mag));
    const curRes = Math.max(0, s.reserve);
    const totalCap = Math.max(activeW.magSize, activeW.magSize * activeW.maxMagazines);
    const maxReserveAllowed = Math.max(0, totalCap - curMag);
    if (curRes >= maxReserveAllowed) {
      return { collected: false, weaponCode: activeW.code, added: 0 };
    }

    // Smaller 10% ammo refill strictly for the currently equipped ranged gun
    const grant = Math.max(1, Math.round(totalCap * 0.1));
    const nextRes = Math.min(maxReserveAllowed, curRes + grant);
    const gained = Math.max(0, nextRes - curRes);
    if (gained <= 0) {
      return { collected: false, weaponCode: activeW.code, added: 0 };
    }

    slotReserveRef.current[cfg.activeSlot] = nextRes;
    weaponAmmoMapRef.current[activeW.id] = { mag: curMag, reserve: nextRes };
    setWeaponAmmoMap({ ...weaponAmmoMapRef.current });
    s.reserve = nextRes;
    setReserveAmmo(nextRes);
    if (s.mag === 0 && nextRes > 0 && !s.reloading) {
      startReloadSequence(activeW.id);
    }

    soundEngine.playAmmoPickup();

    const nowMs = s.startTimeMs > 0 ? Math.round(performance.now() - s.startTimeMs) : s.elapsedMs;
    const entry: CombatLogEntry = {
      id: `ammo-${Date.now()}-${Math.random()}`,
      timestampMs: nowMs,
      roundNumber: s.roundCount,
      source: 'PLAYER_AMMO',
      targetName: `${activeW.code} ${activeW.name} (+${gained} RDS)`,
      zone: 'torso',
      zoneLabel: `Ammo Box (+10% Equipped ${activeW.code})`,
      rawDamage: gained,
      hpDamage: gained,
      remainingHp: s.playerHp,
      isCrit: false,
      isKill: false,
      isMiss: false,
      distanceM: 0,
    };
    setLogs((prev) => [entry, ...prev].slice(0, 120));

    return {
      collected: true,
      weaponCode: activeW.code,
      added: gained,
    };
  }, [startReloadSequence]);

  /**
   * Collects a dropped Consumable Supply Box regardless of active slot, replenishing
   * 2 total usages across any consumable(s) currently below capacity (2 same or 2 different).
   */
  const handleCollectConsumableBox = useCallback((): {
    collected: boolean;
    summaryText: string;
  } => {
    const s = stateRef.current;
    if (s.isPaused || s.playerHp <= 0) {
      return { collected: false, summaryText: '' };
    }

    const nextUsages = { ...s.consumableUsages };
    const grantsById: Partial<Record<GrenadeId, number>> = {};
    let totalGranted = 0;

    for (let roll = 0; roll < 2; roll++) {
      const candidates = s.grenades.filter((g) => (nextUsages[g.id] ?? 0) < g.maxUsages);
      if (candidates.length === 0) break;
      const picked = candidates[Math.floor(Math.random() * candidates.length)];
      nextUsages[picked.id] = Math.min(picked.maxUsages, (nextUsages[picked.id] ?? 0) + 1);
      grantsById[picked.id] = (grantsById[picked.id] ?? 0) + 1;
      totalGranted += 1;
    }

    if (totalGranted === 0) {
      return { collected: false, summaryText: '' };
    }

    s.consumableUsages = nextUsages;
    setConsumableUsages(nextUsages);
    soundEngine.playConsumablePickup();

    const parts = Object.entries(grantsById).map(([id, cnt]) => {
      const grn = s.grenades.find((g) => g.id === id);
      return `${grn?.shortLabel ?? id} +${cnt}`;
    });
    const summaryText = parts.join(' · ');

    const nowMs = s.startTimeMs > 0 ? Math.round(performance.now() - s.startTimeMs) : s.elapsedMs;
    const entry: CombatLogEntry = {
      id: `cbox-${Date.now()}-${Math.random()}`,
      timestampMs: nowMs,
      roundNumber: s.roundCount,
      source: 'PLAYER_CONSUMABLE',
      targetName: `Ordnance Crate (${summaryText})`,
      zone: 'torso',
      zoneLabel: `Consumable Box (+${totalGranted} Usages)`,
      rawDamage: totalGranted,
      hpDamage: totalGranted,
      remainingHp: s.playerHp,
      isCrit: false,
      isKill: false,
      isMiss: false,
      distanceM: 0,
    };
    setLogs((prev) => [entry, ...prev].slice(0, 120));

    return { collected: true, summaryText };
  }, []);

  /** Selects active consumable weapon / grenade ([3]..[9]). */
  const handleSelectGrenade = useCallback((id: GrenadeId) => {
    setConfig((prev) => ({ ...prev, grenadeId: id }));
  }, []);

  /** Toggles between CONSUMABLE slot and the last equipped PRIMARY/SECONDARY combat slot. */
  const handleToggleConsumableSlot = useCallback(() => {
    const curSlot = stateRef.current.config.activeSlot;
    if (curSlot === 'CONSUMABLE') {
      handleSwitchActiveSlot(lastCombatSlotRef.current);
    } else {
      handleSwitchActiveSlot('CONSUMABLE');
    }
  }, [handleSwitchActiveSlot]);

  /** Validates remaining usages + cooldown, consumes 1 charge, and starts ordnance cooldown timer. */
  const handleTryUseConsumable = useCallback((grenade: GrenadeProfile): boolean => {
    const s = stateRef.current;
    if (s.playerHp <= 0 || s.grenadeCooldownSec > 0) return false;
    const remaining = s.consumableUsages[grenade.id] ?? 0;
    if (remaining <= 0) return false;

    const nextUsages = {
      ...s.consumableUsages,
      [grenade.id]: Math.max(0, remaining - 1),
    };
    s.consumableUsages = nextUsages;
    setConsumableUsages(nextUsages);

    if (s.startTimeMs === 0) {
      s.startTimeMs = performance.now();
    }
    s.grenadeCooldownSec = grenade.cooldownSec;
    setGrenadeCooldownSec(grenade.cooldownSec);
    return true;
  }, []);

  /** Refunds +1 usage (capped at maxUsages) when picking up a deployed consumable with [E]. */
  const handleRefundConsumableUsage = useCallback((grenadeId: GrenadeId): boolean => {
    const s = stateRef.current;
    const profile = s.grenades.find((g) => g.id === grenadeId);
    if (!profile) return false;
    const cur = s.consumableUsages[grenadeId] ?? 0;
    const nextCount = Math.min(profile.maxUsages, cur + 1);
    const nextUsages = { ...s.consumableUsages, [grenadeId]: nextCount };
    s.consumableUsages = nextUsages;
    setConsumableUsages(nextUsages);
    soundEngine.playConsumablePickup();
    return true;
  }, []);

  /** Logs grenade, mine, sticky C4, or deployable turret hits into combat telemetry. */
  const handleGrenadeImpactLog = useCallback(
    (info: {
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
        silhouette: EnemyEncounterRecord['silhouette'];
        waveNumber: number;
        hpDamage: number;
        isKill: boolean;
        enemyTtkMs: number | null;
      }[];
    }) => {
      const s = stateRef.current;
      if (s.startTimeMs === 0) {
        s.startTimeMs = performance.now();
      }
      const nowMs = Math.max(1, Math.round(performance.now() - s.startTimeMs));
      s.elapsedMs = nowMs;
      setElapsedMs(nowMs);

      const entry: CombatLogEntry = {
        id: `grn-${Date.now()}-${Math.random()}`,
        timestampMs: nowMs,
        roundNumber: s.roundCount,
        source: info.source ?? 'PLAYER_GRENADE',
        targetName: info.targetName,
        zone: info.isStagger ? 'weakspot' : 'torso',
        zoneLabel: info.zoneLabel,
        rawDamage: info.hpDamage,
        hpDamage: info.hpDamage,
        remainingHp: 0,
        isCrit: info.grenade.id === 'explosive' || info.grenade.id === 'laser_trip_mine',
        isKill: info.isKill,
        isMiss: false,
        isStagger: info.isStagger,
        enemyTtkMs: info.enemyTtkMs,
        distanceM: info.distanceM,
      };
      setLogs((prev) => [entry, ...prev].slice(0, 120));

      if (info.affectedTargets && info.affectedTargets.length > 0) {
        const encMap = encounterMapRef.current;
        for (const t of info.affectedTargets) {
          const existing = encMap.get(t.enemyUid);
          const base: EnemyEncounterRecord = existing ?? {
            enemyUid: t.enemyUid,
            targetId: t.targetId,
            targetName: t.targetName,
            targetCode: t.targetCode,
            silhouette: t.silhouette,
            waveNumber: t.waveNumber,
            lastWeaponId: info.grenade.id,
            lastWeaponName: info.grenade.shortLabel,
            killed: false,
            shotsTakenToKill: 0,
            hitsWeakspot: 0,
            hitsArmor: 0,
            hitsExtremity: 0,
            nearMisses: 0,
            totalDamage: 0,
            ttkMs: null,
            samples: [],
          };
          encMap.set(t.enemyUid, {
            ...base,
            totalDamage: base.totalDamage + t.hpDamage,
            killed: base.killed || t.isKill,
            ttkMs: t.isKill ? (t.enemyTtkMs ?? base.ttkMs) : base.ttkMs,
          });
        }
        setEnemyEncounters(Array.from(encMap.values()).reverse());
      }
    },
    []
  );

  /** Applies friendly grenade/mine/C4/fire self-damage to the player with 90% damage reduction (0.1x). */
  const handlePlayerOrdnanceSelfDamage = useCallback((rawDamage: number, zoneLabel: string) => {
    const s = stateRef.current;
    if (s.playerHp <= 0) return;

    const mitigatedDmg = Math.max(1, Math.round(rawDamage * 0.1));
    s.outOfCombatSec = 0;
    setOutOfCombatSec(0);

    const nextExact = Math.max(0, s.playerHpExact - mitigatedDmg);
    const nextPlayerHp = Math.max(0, Math.round(nextExact));
    s.playerHpExact = nextExact;
    s.playerHp = nextPlayerHp;
    setPlayerHp(nextPlayerHp);

    const nowMs = s.startTimeMs > 0 ? Math.round(performance.now() - s.startTimeMs) : s.elapsedMs;
    const entry: CombatLogEntry = {
      id: `selford-${Date.now()}-${Math.random()}`,
      timestampMs: nowMs,
      roundNumber: s.roundCount,
      source: 'PLAYER_GRENADE',
      targetName: 'Operator Suit (-90% Mitigated)',
      zone: 'torso',
      zoneLabel,
      rawDamage: rawDamage,
      hpDamage: mitigatedDmg,
      remainingHp: nextPlayerHp,
      isCrit: false,
      isKill: false,
      isMiss: false,
      distanceM: 0,
    };
    setLogs((prev) => [entry, ...prev].slice(0, 120));

    if (nextPlayerHp <= 0) {
      soundEngine.playPlayerDown();
      setIsSimRunning(false);
    } else {
      soundEngine.playPlayerHurt(false);
    }
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

  const handleEnemyWeaponAttack = useCallback(
    (
      source: 'ENEMY_RANGED' | 'ENEMY_MELEE' | 'ENEMY_EXPLOSION',
      damage: number,
      attackerName: string,
      zoneLabel: string,
      distanceM: number
    ) => {
      const s = stateRef.current;
      if (s.playerHp <= 0 || damage <= 0) return;

      s.outOfCombatSec = 0;
      setOutOfCombatSec(0);

      const nextExact = Math.max(0, s.playerHpExact - damage);
      const nextPlayerHp = nextExact <= 0 ? 0 : Math.max(1, Math.round(nextExact));
      s.playerHpExact = nextExact;
      s.playerHp = nextPlayerHp;
      setPlayerHp(nextPlayerHp);

      const formattedDmg =
        damage < 1 ? Number(damage.toFixed(2)) : Math.round(damage * 10) / 10;

      const nowMs = s.startTimeMs > 0 ? Math.round(performance.now() - s.startTimeMs) : s.elapsedMs;
      const entry: CombatLogEntry = {
        id: `ewpn-${Date.now()}-${Math.random()}`,
        timestampMs: nowMs,
        roundNumber: s.roundCount,
        source,
        targetName: attackerName,
        zone: 'torso',
        zoneLabel,
        rawDamage: formattedDmg,
        hpDamage: formattedDmg,
        remainingHp: nextPlayerHp,
        isCrit: source === 'ENEMY_EXPLOSION',
        isKill: false,
        isMiss: false,
        distanceM: Math.max(1, Math.round(distanceM)),
      };
      setLogs((prev) => [entry, ...prev].slice(0, 120));

      if (nextPlayerHp <= 0) {
        soundEngine.playPlayerDown();
        setIsSimRunning(false);
      } else {
        soundEngine.playPlayerHurt(source === 'ENEMY_EXPLOSION');
      }
    },
    []
  );

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

  const handleStartWaveFromLoadout = useCallback(() => {
    soundEngine.unlock();
    const s = stateRef.current;
    const isPristineInitial =
      s.roundCount === 0 &&
      logs.length === 0 &&
      s.waveNumber === 1 &&
      s.playerHp === MAX_PLAYER_HP;
    setIsPaused(false);
    setShowStartScreen(false);
    setActiveScreen('range');
    // Avoid tearing down & synchronously rebuilding pre-compiled Wave 1 enemies on initial start
    if (!isPristineInitial) {
      resetRangeState(undefined, false);
    }
    const canvasEl = document.querySelector<HTMLCanvasElement>('canvas[data-sim-canvas="true"]');
    if (canvasEl) {
      canvasEl.focus({ preventScroll: true });
      const vCanvas = canvasEl as HTMLCanvasElement & {
        webkitRequestPointerLock?: () => void;
        mozRequestPointerLock?: () => void;
      };
      const lockFn =
        vCanvas.requestPointerLock ??
        vCanvas.webkitRequestPointerLock ??
        vCanvas.mozRequestPointerLock;
      if (typeof lockFn === 'function') {
        try {
          const res = lockFn.call(vCanvas) as unknown as Promise<void> | undefined;
          if (res && typeof res.catch === 'function') {
            res.catch(() => {});
          }
        } catch {
          // Fallback mouse centering stays active when pointer lock is unavailable
        }
      }
    }
  }, [logs.length, resetRangeState]);

  return (
    <div className="min-h-screen bg-[#0a0d12] text-[#e1e2ea] flex flex-col">
      <TopBar
        activeScreen={activeScreen}
        onSelectScreen={(scr) => {
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
        {/* Keep 3D Range mounted via CSS `hidden` across tab switches so WebGL buffers, waves, and deployables persist */}
        <div
          className={
            activeScreen === 'range'
              ? 'max-w-[1600px] mx-auto p-3 sm:p-4 lg:p-5 space-y-3'
              : 'hidden'
          }
        >
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
              } md:col-span-12 xl:col-span-6 xl:order-2 space-y-4`}
            >
              <SimulationCanvas3D
                config={config}
                weapons={weapons}
                grenades={grenades}
                targets={targets}
                consumableUsages={consumableUsages}
                weaponAmmoMap={weaponAmmoMap}
                playerHp={playerHp}
                maxPlayerHp={MAX_PLAYER_HP}
                outOfCombatSec={outOfCombatSec}
                outOfCombatWindowSec={OUT_OF_COMBAT_WINDOW_SEC}
                medkitCooldownSec={medkitCooldownSec}
                grenadeCooldownSec={grenadeCooldownSec}
                waveNumber={waveNumber}
                waveGroupSize={currentWaveGroupSize}
                waveTriggerToken={waveTriggerToken}
                magRemaining={magRemaining}
                reserveAmmo={reserveAmmo}
                isReloading={isReloading}
                isSimRunning={isSimRunning}
                isPaused={isPaused}
                isScreenActive={activeScreen === 'range' && !showStartScreen}
                metrics={metrics}
                startOverlay={
                  showStartScreen ? (
                    <StartScreen
                      config={config}
                      weapons={weapons}
                      waveGroupSize={currentWaveGroupSize}
                      onSelectSlotWeapon={handleSelectSlotWeapon}
                      onStartWave={handleStartWaveFromLoadout}
                    />
                  ) : undefined
                }
                onTriggerShot={handleTriggerShot}
                onManualReload={handleManualReload}
                onUseMedkit={handleUseMedkit}
                onCollectAmmoBox={handleCollectAmmoBox}
                onCollectConsumableBox={handleCollectConsumableBox}
                onSelectGrenade={handleSelectGrenade}
                onSelectSlotWeapon={handleSelectSlotWeapon}
                onToggleConsumableSlot={handleToggleConsumableSlot}
                onTryUseConsumable={handleTryUseConsumable}
                onRefundConsumableUsage={handleRefundConsumableUsage}
                onGrenadeImpactLog={handleGrenadeImpactLog}
                onPlayerOrdnanceSelfDamage={handlePlayerOrdnanceSelfDamage}
                onSetPaused={setIsPaused}
                onSwitchActiveSlot={handleSwitchActiveSlot}
                onStartNextWave={handleStartNextWave}
                onOpenRooms={() => {
                  setActiveScreen('rooms');
                }}
                onOpenLoadout={() => setShowStartScreen(true)}
                onSquadShotResolved={handleSquadShotResolved}
                onEnemyClawAttack={handleEnemyClawAttack}
                onEnemyDroneShot={handleEnemyDroneShot}
                onEnemyWeaponAttack={handleEnemyWeaponAttack}
                onSquadCleared={handleSquadCleared}
                onResetRange={() => resetRangeState()}
                resetToken={resetToken}
                doorResetToken={doorResetToken}
              />

              <PrimaryChassisPanel
                config={config}
                targets={targets}
                maxSpawnLimit={MAX_SPAWN_LIMIT}
                onChangeConfig={handleChangeConfig}
                onChangeChassisSpawnCount={handleChangeChassisSpawnCount}
                onSelectTargetPreset={handleSelectTargetPreset}
                onCycleTarget={handleCycleTarget}
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
                grenades={grenades}
                consumableUsages={consumableUsages}
                waveNumber={waveNumber}
                isSimRunning={isSimRunning}
                onChangeConfig={handleChangeConfig}
                onSelectSlotWeapon={handleSelectSlotWeapon}
                onSwitchActiveSlot={handleSwitchActiveSlot}
                onChangeWaveSize={handleChangeWaveSize}
                onStartNextWave={handleStartNextWave}
                onOpenRooms={() => setActiveScreen('rooms')}
                onEngageBurst={handleToggleEngage}
                onResetRange={() => resetRangeState()}
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
            grenades={grenades}
            onSelectSlotWeapon={handleSelectSlotWeapon}
            onSelectGrenade={handleSelectGrenade}
            onSwitchActiveSlot={handleSwitchActiveSlot}
            onUpdateWeapon={handleUpdateWeapon}
            onUpdateGrenade={handleUpdateGrenade}
            onResetWeapons={handleResetWeapons}
            onResetGrenades={handleResetGrenades}
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
            weapons={weapons}
            targets={targets}
            enemyEncounters={enemyEncounters}
            weaponPerformances={weaponPerformances}
            onClearLiveTelemetry={() => {
              encounterMapRef.current.clear();
              const freshMap = buildInitialWeaponPerfMap(weapons);
              weaponPerfMapRef.current = freshMap;
              setEnemyEncounters([]);
              setWeaponPerformances(freshMap);
            }}
            onDeleteRun={(id) => setSavedRuns((prev) => prev.filter((r) => r.id !== id))}
            onClearAll={() => setSavedRuns([])}
            onOpenRange={() => setActiveScreen('range')}
          />
        )}
      </main>
    </div>
  );
}
