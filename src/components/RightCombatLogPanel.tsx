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
  config: SimulationConfig;
  weapons: WeaponProfile[];
  targets: TargetProfile[];
  logs: CombatLogEntry[];
  metrics: EngagementMetrics;
  onSaveRun: () => void;
  onClearLogs: () => void;
}

type LogFilter = 'ALL' | 'CRIT' | 'CLAW';

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

  const filteredLogs = logs.filter((entry) => {
    if (filter === 'CRIT') return entry.isCrit || entry.isStagger;
    if (filter === 'CLAW')
      return entry.source === 'ENEMY_CLAW' || entry.source === 'ENEMY_DUAL_CLAW';
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
              entry.source === 'ENEMY_DRONE_BOLT';
            const isMedkit = entry.source === 'PLAYER_MEDKIT';
            const eventBadge = isMedkit
              ? { label: `MEDKIT +${entry.hpDamage} HP`, color: 'text-[#20df78]' }
              : isEnemyAttack
                ? entry.source === 'ENEMY_DUAL_CLAW'
                  ? { label: `DUAL CLAW -${entry.hpDamage}`, color: 'text-[#ff2a4b]' }
                  : entry.source === 'ENEMY_DRONE_BOLT'
                    ? { label: `DRONE BOLT -${entry.hpDamage}`, color: 'text-[#00f0ff]' }
                    : { label: `CLAW SLASH -${entry.hpDamage}`, color: 'text-[#ffb300]' }
                : entry.isKill
                  ? { label: `ELIMINATED (${entry.hpDamage})`, color: 'text-[#20df78]' }
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
                  isMedkit
                    ? 'bg-[#20df78]/10 border-[#20df78]/40'
                    : isEnemyAttack
                      ? 'bg-[#ff2a4b]/10 border-[#ff2a4b]/40'
                      : entry.isStagger
                        ? 'bg-[#00f0ff]/10 border-[#00f0ff]/40'
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
