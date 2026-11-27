/**
 * @file RightCombatLogPanel.tsx
 * Right Combat Telemetry Panel showing theoretical STK/DPS baselines alongside live accumulated
 * engagement metrics and a filterable chronological stream of shots, melee cleaves, shoves,
 * ordnance detonations, pickups, turret kills, and incoming hostile attacks.
 *
 * How telemetry metrics and log filtering work:
 * - Theoretical DPS / STK (`computeTheoreticalTelemetry`) computes baseline math directly from the
 *   live `weapons` and `targets` arrays, so edits in Armory/Targets update predictions immediately.
 * - Live DPS/damage read `metrics` pushed down from `App.tsx`, swapping the hero DPS readout from
 *   theoretical to live measured output as soon as `metrics.totalRoundsFired > 0`.
 * - Filtering (`ALL` | `CRIT` | `CLAW`) computes `filteredLogs` purely at render time without mutating
 *   or discarding entries in `logs`. A destructive filter that dropped non-matching events in `App.tsx`
 *   would corrupt saved Blackbox runs and lose incoming damage history if the user toggled tabs mid-wave.
 */
import React, { useState } from 'react';
import { computeTheoreticalTelemetry, formatTimestampMs } from '../engine/ballistics';
import {
  CombatLogEntry,
  EngagementMetrics,
  SimulationConfig,
  TargetProfile,
  WeaponProfile,
} from '../types/ballistics';

interface RightCombatLogPanelProps {
  /** Active simulation settings used to compute theoretical weapon-vs-target baselines. */
  config: SimulationConfig;
  /** Live weapon array (reflecting custom Armory stat edits). */
  weapons: WeaponProfile[];
  /** Live enemy chassis array (reflecting custom TargetsScreen edits). */
  targets: TargetProfile[];
  /** Capped chronological combat feed (most recent first, max 120 items managed by `App.tsx`). */
  logs: CombatLogEntry[];
  /** Aggregated accuracy, DPS, TTK, and damage totals from the current engagement session. */
  metrics: EngagementMetrics;
  /** Snapshots the current `metrics` and session config into the persistent Blackbox archive. */
  onSaveRun: () => void;
  /** Clears only the live feed and live session counters without resetting deployed 3D actors. */
  onClearLogs: () => void;
}

type LogFilter = 'ALL' | 'CRIT' | 'CLAW';

/**
 * Right-hand telemetry sidebar combining theoretical vs live KPIs with a color-coded combat feed.
 */
export const RightCombatLogPanel: React.FC<RightCombatLogPanelProps> = ({
  config,
  weapons,
  targets,
  logs,
  metrics,
  onSaveRun,
  onClearLogs,
}) => {
  const [filter, setFilter] = useState<LogFilter>('ALL');
  const theory = computeTheoreticalTelemetry(config, weapons, targets);

  // Non-destructive render-time view filter preserving the underlying chronological `logs` array.
  const filteredLogs = logs.filter((entry) => {
    if (filter === 'CRIT') return entry.isCrit || entry.isStagger;
    if (filter === 'CLAW')
      return (
        entry.source === 'ENEMY_CLAW' ||
        entry.source === 'ENEMY_DUAL_CLAW' ||
        entry.source === 'ENEMY_DRONE_BOLT' ||
        entry.source === 'ENEMY_RANGED' ||
        entry.source === 'ENEMY_MELEE' ||
        entry.source === 'ENEMY_EXPLOSION'
      );
    return true;
  });

  return (
    <aside className="bg-[#121721] border border-[#1e2638] flex flex-col">
      <div className="px-4 py-3 border-b border-[#1e2638] bg-[#161c28] flex items-center justify-between gap-2">
        <h2 className="font-display text-xs font-semibold tracking-[0.08em] uppercase text-[#e1e2ea]">
          03. Combat Telemetry
        </h2>
        <span className="font-mono text-[10px] tracking-[0.08em] text-[#00f0ff] tabular-nums">
          {logs.length} EVENTS
        </span>
      </div>

      {/* Live TTK & DPS Breakdown Matrix */}
      <div className="p-4 border-b border-[#1e2638] space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <div className="bg-[#0f141d] border border-[#232d42] p-2.5">
            <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-[#8c9bb5]">
              Effective DPS
            </div>
            <div className="mt-1 font-mono text-lg font-bold text-[#ffb300] tabular-nums">
              {metrics.totalRoundsFired > 0 ? metrics.effectiveDps : theory.theoreticalDps}
            </div>
          </div>
          <div className="bg-[#0f141d] border border-[#232d42] p-2.5">
            <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-[#8c9bb5]">
              Strikes To Kill
            </div>
            <div className="mt-1 font-mono text-lg font-bold text-[#00f0ff] tabular-nums">
              {theory.theoreticalStk} HIT
            </div>
          </div>
        </div>

        <div className="space-y-1.5 font-mono text-[11px] tabular-nums">
          <div className="flex items-center justify-between text-[#8c9bb5]">
            <span>AVG HP / STRIKE</span>
            <span className="text-[#e1e2ea]">{theory.perShotHpEstimate} DMG</span>
          </div>
          <div className="flex items-center justify-between text-[#8c9bb5]">
            <span>TOTAL HP DAMAGE</span>
            <span className="text-[#00f0ff]">{metrics.totalHpDamage.toLocaleString()}</span>
          </div>
          <div className="flex items-center justify-between text-[#8c9bb5]">
            <span>ATTACK CADENCE</span>
            <span className="text-[#e1e2ea]">{theory.shotIntervalMs} ms / act</span>
          </div>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="px-4 pt-3 pb-2 border-b border-[#1e2638] flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          {(['ALL', 'CRIT', 'CLAW'] as LogFilter[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`px-2 py-1 font-mono text-[10px] tracking-[0.06em] uppercase border transition-colors cursor-pointer ${
                filter === f
                  ? 'bg-[#1b2332] border-[#ffb300] text-[#ffb300]'
                  : 'bg-[#0f141d] border-[#232d42] text-[#8c9bb5] hover:text-[#e1e2ea]'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onClearLogs}
          className="font-mono text-[10px] uppercase text-[#8c9bb5] hover:text-[#ff2a4b] cursor-pointer"
        >
          Clear
        </button>
      </div>

      {/* Real-time Scrolling Combat Log Stream */}
      <div className="flex-1 min-h-[260px] max-h-[420px] overflow-y-auto p-3 space-y-1.5 bg-[#0a0d12]/60">
        {filteredLogs.length === 0 ? (
          <div className="h-full min-h-[200px] flex flex-col items-center justify-center text-center px-4 space-y-2">
            <div className="font-mono text-xs text-[#8c9bb5] uppercase tracking-[0.08em]">
              Awaiting Combat Input
            </div>
            <p className="text-xs text-[#8c9bb5]/80 max-w-[220px]">
              Left-click in the 3D arena to fire or swing melee, Right-click to ADS or Shove, and eliminate the advancing squad.
            </p>
          </div>
        ) : (
          filteredLogs.map((entry) => {
            const isEnemyAttack =
              entry.source === 'ENEMY_CLAW' ||
              entry.source === 'ENEMY_DUAL_CLAW' ||
              entry.source === 'ENEMY_DRONE_BOLT' ||
              entry.source === 'ENEMY_RANGED' ||
              entry.source === 'ENEMY_MELEE' ||
              entry.source === 'ENEMY_EXPLOSION';
            const isMedkit = entry.source === 'PLAYER_MEDKIT';
            const isAmmo = entry.source === 'PLAYER_AMMO';
            const isConsumableBox = entry.source === 'PLAYER_CONSUMABLE';
            const isTurret = entry.source === 'PLAYER_TURRET';
            const isGrenade = entry.source === 'PLAYER_GRENADE';
            const isBurnTick =
              isGrenade &&
              (entry.zoneLabel.includes('Incendiary') || entry.zoneLabel.includes('Thermite'));

            const eventBadge = isMedkit
              ? { label: `MEDKIT +${entry.hpDamage} HP`, color: 'text-[#20df78]' }
              : isAmmo
                ? { label: `AMMO +${entry.hpDamage} RDS`, color: 'text-[#20df78]' }
                : isConsumableBox
                  ? { label: `ORDNANCE +${entry.hpDamage}`, color: 'text-[#00f0ff]' }
                  : isEnemyAttack
                    ? entry.source === 'ENEMY_DUAL_CLAW'
                      ? { label: `DUAL CLAW -${entry.hpDamage}`, color: 'text-[#ff2a4b]' }
                      : entry.source === 'ENEMY_EXPLOSION'
                        ? { label: `REACTOR BLAST -${entry.hpDamage}`, color: 'text-[#ff6a00]' }
                        : entry.source === 'ENEMY_RANGED'
                          ? { label: `HOSTILE FIRE -${entry.hpDamage}`, color: 'text-[#ffb300]' }
                          : entry.source === 'ENEMY_MELEE'
                            ? { label: `BLADE HIT -${entry.hpDamage}`, color: 'text-[#ff2a4b]' }
                            : entry.source === 'ENEMY_DRONE_BOLT'
                              ? { label: `ATGM HIT -${entry.hpDamage}`, color: 'text-[#00f0ff]' }
                              : { label: `CLAW SLASH -${entry.hpDamage}`, color: 'text-[#ffb300]' }
                    : entry.isKill
                      ? { label: `ELIMINATED (${entry.hpDamage})`, color: 'text-[#20df78]' }
                      : isTurret
                        ? { label: `TURRET ${entry.hpDamage} DMG`, color: 'text-[#20df78]' }
                        : isGrenade
                          ? entry.isStagger
                            ? { label: `STUNNED (${entry.hpDamage} DMG)`, color: 'text-[#00f0ff]' }
                            : isBurnTick
                              ? { label: `THERMITE ${entry.hpDamage} DoT`, color: 'text-[#ff6a00]' }
                              : { label: `BLAST ${entry.hpDamage} DMG`, color: 'text-[#ff2a4b]' }
                          : entry.isMiss
                            ? { label: 'ATTACK MISSED', color: 'text-[#8c9bb5]' }
                            : entry.source === 'PLAYER_SHOVE'
                              ? { label: `SHOVE ${entry.hpDamage} DMG`, color: 'text-[#00f0ff]' }
                              : entry.isStagger
                                ? { label: `STAGGER ${entry.hpDamage} DMG`, color: 'text-[#00f0ff]' }
                                : entry.isCrit
                                  ? { label: `CRIT ${entry.hpDamage} DMG`, color: 'text-[#ff2a4b]' }
                                  : { label: `HIT ${entry.hpDamage} DMG`, color: 'text-[#ffb300]' };

            return (
              <div
                key={entry.id}
                className={`px-2.5 py-2 border font-mono text-[11px] space-y-1 ${
                  isMedkit || isAmmo || isTurret
                    ? 'bg-[#20df78]/10 border-[#20df78]/40'
                    : isConsumableBox
                      ? 'bg-[#00f0ff]/10 border-[#00f0ff]/40'
                      : isEnemyAttack
                        ? 'bg-[#ff2a4b]/10 border-[#ff2a4b]/40'
                        : isBurnTick
                          ? 'bg-[#ff6a00]/10 border-[#ff6a00]/40'
                          : entry.isStagger
                            ? 'bg-[#00f0ff]/10 border-[#00f0ff]/40'
                            : isGrenade
                              ? 'bg-[#ffb300]/10 border-[#ffb300]/40'
                              : 'bg-[#121721] border-[#1e2638]'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[#8c9bb5] tabular-nums">
                    [{formatTimestampMs(entry.timestampMs)}]
                  </span>
                  <span className={`font-semibold tabular-nums ${eventBadge.color}`}>
                    {eventBadge.label}
                  </span>
                </div>
                <div className="flex items-center justify-between text-[10px] text-[#8c9bb5] tabular-nums">
                  <span className="truncate">
                    {isEnemyAttack
                      ? `${entry.targetName ?? 'Hostile'} · ${entry.zoneLabel}`
                      : isTurret
                        ? `SEN · ${entry.targetName ?? 'Hostile'} · ${entry.zoneLabel}`
                        : isGrenade
                          ? `ORD · ${entry.targetName ?? 'Hostile'} · ${entry.zoneLabel}`
                          : `ACT #${entry.roundNumber.toString().padStart(2, '0')} · ${entry.zoneLabel}`}
                  </span>
                  <span className="shrink-0">{entry.distanceM}m</span>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="p-3 border-t border-[#1e2638] bg-[#161c28]">
        <button
          type="button"
          onClick={onSaveRun}
          disabled={logs.length === 0}
          className="w-full py-2 px-3 font-mono text-[11px] font-semibold tracking-[0.08em] uppercase border border-[#00f0ff]/60 text-[#00f0ff] hover:bg-[#00f0ff]/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
        >
          Archive Run To Telemetry Log
        </button>
      </div>
    </aside>
  );
};
