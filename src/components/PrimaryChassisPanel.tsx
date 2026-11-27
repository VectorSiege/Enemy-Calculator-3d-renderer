/**
 * @file PrimaryChassisPanel.tsx
 * Middle-bottom Primary Hostile Chassis & Custom Squad Allocation Panel rendered directly below
 * the 3D simulation viewport so players can inspect enemy HP/codes and tune squad mix up to `maxSpawnLimit` (120).
 *
 * How squad allocation and target switching work:
 * - Clicking a card triggers `onSelectTargetPreset(t.id)`, setting the active chassis used when
 *   `mixedGroup` is disabled (`Single Chassis`) and resetting/aligning squad composition.
 * - Adjusting the `-`, `+`, or numeric `<input>` calls `onChangeChassisSpawnCount(t.id, val)` which
 *   clamps counts, updates `config.chassisSpawnCounts`, recomputes Wave 1-5 sizes (`buildWaveSizesFromBase`),
 *   and live-rebuilds enemies in `SimulationCanvas3D`.
 *
 * Why nested `stopPropagation()` + `role="button"` is used instead of a split `<button>` layout:
 * - HTML forbids interactive `<button>`/`<input>` elements nested inside another `<button>`. Using a
 *   keyboard-accessible `role="button"` card container with `onClick={(e) => e.stopPropagation()}` on
 *   the spawn counter toolbar keeps the entire card clickable to select the chassis without incrementing/decrementing
 *   accidentally switching presets, and avoids cramped separate hitboxes.
 */
import React from 'react';
import { SimulationConfig, TargetProfile } from '../types/ballistics';

interface PrimaryChassisPanelProps {
  /** Live simulation configuration containing `targetId`, `mixedGroup`, `groupSize`, and `chassisSpawnCounts`. */
  config: SimulationConfig;
  /** Mutable array of enemy chassis profiles (including live edits made in `TargetsScreen`). */
  targets: TargetProfile[];
  /** Hard cap (`MAX_SPAWN_LIMIT = 120`) preventing unbounded Three.js actor allocations. */
  maxSpawnLimit: number;
  /** Merges config patches such as toggling `mixedGroup` between custom mixed squad vs uniform chassis. */
  onChangeConfig: (patch: Partial<SimulationConfig>) => void;
  /** Updates a single chassis spawn allocation and recalculates total squad size / wave scaling. */
  onChangeChassisSpawnCount: (targetId: string, count: number) => void;
  /** Selects a chassis as the primary preset target (or focuses it inside mixed mode). */
  onSelectTargetPreset: (targetId: string) => void;
  /** Cycles sequentially through `targets` for rapid A/B testing without moving the pointer. */
  onCycleTarget: () => void;
}

/**
 * Renders the 2-to-4 column enemy chassis selector and per-chassis spawn counter grid.
 */
export const PrimaryChassisPanel: React.FC<PrimaryChassisPanelProps> = ({
  config,
  targets,
  maxSpawnLimit,
  onChangeConfig,
  onChangeChassisSpawnCount,
  onSelectTargetPreset,
  onCycleTarget,
}) => {
  return (
    <section className="bg-[#121721] border border-[#1e2638] p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5 border-b border-[#1e2638]">
        <div className="flex items-center gap-2.5">
          <h3 className="font-display text-xs font-semibold tracking-[0.08em] uppercase text-[#e1e2ea]">
            03. Primary Hostile Chassis
          </h3>
          <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-[#8c9bb5] tabular-nums">
            Squad Roster ({config.groupSize}/{maxSpawnLimit} Max)
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* Toggle between spawning the exact per-card counts (`mixedGroup=true`) vs uniform waves (`mixedGroup=false`). */}
          <button
            type="button"
            onClick={() => onChangeConfig({ mixedGroup: !config.mixedGroup })}
            className={`px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.06em] border cursor-pointer transition-colors ${
              config.mixedGroup
                ? 'bg-[#1b2332] border-[#00f0ff] text-[#00f0ff]'
                : 'bg-[#0f141d] border-[#232d42] text-[#8c9bb5]'
            }`}
          >
            {config.mixedGroup ? 'Custom Mix Linked' : 'Single Chassis'}
          </button>
          <button
            type="button"
            onClick={onCycleTarget}
            className="px-2.5 py-1 border border-[#232d42] bg-[#0f141d] font-mono text-[10px] tracking-[0.08em] uppercase text-[#ffb300] hover:border-[#ffb300] hover:text-[#00f0ff] transition-colors cursor-pointer"
          >
            Cycle Target
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
        {targets.map((t) => {
          const active = t.id === config.targetId;
          const spawnCount = config.chassisSpawnCounts[t.id] ?? 0;
          return (
            <div
              key={t.id}
              onClick={() => onSelectTargetPreset(t.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelectTargetPreset(t.id);
                }
              }}
              className={`p-2.5 border text-left transition-colors cursor-pointer space-y-2 ${
                active
                  ? 'bg-[#1b2332] border-[#ffb300] text-[#e1e2ea]'
                  : 'bg-[#0f141d] border-[#232d42] text-[#8c9bb5] hover:text-[#e1e2ea] hover:border-[#2c3a54]'
              }`}
            >
              <div>
                <div className="flex items-center justify-between gap-1 font-mono text-[10px] text-[#ffb300]">
                  <span>{t.code}</span>
                  {/* Reads `t.defaultHp` directly from props so live edits in TargetsScreen reflect immediately. */}
                  <span className="tabular-nums">{t.defaultHp} HP</span>
                </div>
                <div className="mt-0.5 text-[11px] font-medium text-[#e1e2ea] truncate">
                  {t.name}
                </div>
              </div>

              {/* Stop propagation so clicking +/- or typing into the numeric box does not re-trigger card selection. */}
              <div
                className="flex items-center justify-between gap-1 pt-1.5 border-t border-[#1e2638]"
                onClick={(e) => e.stopPropagation()}
              >
                <span className="font-mono text-[9px] uppercase text-[#8c9bb5]">SPAWN</span>
                <div className="flex items-center bg-[#0a0d12] border border-[#232d42]">
                  <button
                    type="button"
                    onClick={() => onChangeChassisSpawnCount(t.id, spawnCount - 1)}
                    aria-label={`Decrease ${t.name} spawn count`}
                    className="px-1.5 py-0.5 font-mono text-[10px] text-[#8c9bb5] hover:text-[#ffb300] cursor-pointer"
                  >
                    -
                  </button>
                  <input
                    type="number"
                    min={0}
                    max={maxSpawnLimit}
                    value={spawnCount}
                    aria-label={`${t.name} spawn count`}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      if (!Number.isNaN(val)) {
                        onChangeChassisSpawnCount(t.id, val);
                      }
                    }}
                    className="w-8 bg-transparent text-center font-mono text-[11px] font-bold text-[#00f0ff] tabular-nums focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => onChangeChassisSpawnCount(t.id, spawnCount + 1)}
                    aria-label={`Increase ${t.name} spawn count`}
                    className="px-1.5 py-0.5 font-mono text-[10px] text-[#8c9bb5] hover:text-[#ffb300] cursor-pointer"
                  >
                    +
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
};
