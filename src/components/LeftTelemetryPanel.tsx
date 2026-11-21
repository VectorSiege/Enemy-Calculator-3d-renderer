import React from 'react';
import { ChevronDown } from 'lucide-react';
import {
  EnemyApproachPattern,
  FiringMode,
  HitZoneId,
  SimulationConfig,
  TargetProfile,
  WeaponProfile,
} from '../types/ballistics';

import { ROOM_LAYOUTS } from '../data/arsenal';

interface LeftTelemetryPanelProps {
  config: SimulationConfig;
  weapons: WeaponProfile[];
  targets: TargetProfile[];
  waveNumber: number;
  isSimRunning: boolean;
  onChangeConfig: (patch: Partial<SimulationConfig>) => void;
  onChangeChassisSpawnCount: (targetId: string, count: number) => void;
  onChangeWaveSize: (waveIdx: number, size: number) => void;
  onStartNextWave: () => void;
  onSelectTargetPreset: (targetId: string) => void;
  onOpenRooms: () => void;
  onEngageBurst: () => void;
  onResetRange: () => void;
  onCycleTarget: () => void;
}

interface PrecisionStepperProps {
  label: string;
  value: number;
  unit: string;
  min: number;
  max: number;
  step: number;
  accent?: 'amber' | 'cyan' | 'red';
  onChange: (next: number) => void;
}

const PrecisionStepper: React.FC<PrecisionStepperProps> = ({
  label,
  value,
  unit,
  min,
  max,
  step,
  accent = 'cyan',
  onChange,
}) => {
  const pct = Math.max(0, Math.min(100, ((value - min) / Math.max(1, max - min)) * 100));
  const barColor =
    accent === 'amber'
      ? 'bg-[#ffb300]'
      : accent === 'red'
        ? 'bg-[#ff2a4b]'
        : 'bg-[#00f0ff]';

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] font-medium tracking-[0.08em] uppercase text-[#8c9bb5]">
          {label}
        </span>
        <span className="font-mono text-xs font-semibold text-[#e1e2ea] tabular-nums">
          {value.toLocaleString()}{' '}
          <span className="text-[10px] text-[#8c9bb5]">{unit}</span>
        </span>
      </div>

      <div className="flex items-stretch bg-[#0f141d] border border-[#232d42] focus-within:border-[#00f0ff] transition-colors">
        <button
          type="button"
          onClick={() => onChange(Math.max(min, value - step))}
          aria-label={`Decrease ${label}`}
          className="px-2.5 py-1.5 font-mono text-xs text-[#8c9bb5] hover:text-[#ffb300] hover:bg-[#161c28] border-r border-[#232d42] transition-colors cursor-pointer whitespace-nowrap shrink-0"
        >
          [-]
        </button>
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => {
            const parsed = Number(e.target.value);
            if (!Number.isNaN(parsed)) {
              onChange(Math.max(min, Math.min(max, parsed)));
            }
          }}
          aria-label={label}
          className="w-full bg-transparent px-2.5 py-1.5 text-center font-mono text-xs font-semibold text-[#e1e2ea] tabular-nums focus:outline-none"
        />
        <button
          type="button"
          onClick={() => onChange(Math.min(max, value + step))}
          aria-label={`Increase ${label}`}
          className="px-2.5 py-1.5 font-mono text-xs text-[#8c9bb5] hover:text-[#ffb300] hover:bg-[#161c28] border-l border-[#232d42] transition-colors cursor-pointer whitespace-nowrap shrink-0"
        >
          [+]
        </button>
      </div>

      <div className="relative pt-1">
        <div className="relative h-1.5 w-full bg-[#0f141d] border border-[#1e2638] overflow-hidden">
          <div
            className={`h-full ${barColor} transition-all duration-150`}
            style={{ width: `${pct}%` }}
          />
          <div
            aria-hidden="true"
            className="absolute inset-0 flex justify-between px-[10%] pointer-events-none"
          >
            {Array.from({ length: 9 }).map((_, idx) => (
              <span key={idx} className="w-[1px] h-full bg-[#0a0d12]/80" />
            ))}
          </div>
        </div>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label={`${label} slider`}
          className="tactical-range absolute inset-0 w-full h-4 -top-0.5 opacity-0 cursor-pointer"
        />
      </div>
    </div>
  );
};

export const LeftTelemetryPanel: React.FC<LeftTelemetryPanelProps> = ({
  config,
  weapons,
  targets,
  waveNumber,
  isSimRunning,
  onChangeConfig,
  onChangeChassisSpawnCount,
  onChangeWaveSize,
  onStartNextWave,
  onSelectTargetPreset,
  onOpenRooms,
  onEngageBurst,
  onResetRange,
  onCycleTarget,
}) => {
  const activeWeapon = weapons.find((w) => w.id === config.weaponId) ?? weapons[0];
  const activeRoom = ROOM_LAYOUTS.find((r) => r.id === config.roomId) ?? ROOM_LAYOUTS[0];
  const isMelee = activeWeapon.weaponClass === 'MELEE' && !!activeWeapon.melee;

  const damageLabel = isMelee
    ? activeWeapon.melee!.comboSteps.map((s) => s.damage).join('/')
    : activeWeapon.pellets > 1
      ? `${activeWeapon.baseDamage} x ${activeWeapon.pellets}`
      : `${activeWeapon.baseDamage}`;

  return (
    <aside className="bg-[#121721] border border-[#1e2638] flex flex-col">
      <div className="px-4 py-3 border-b border-[#1e2638] bg-[#161c28] flex items-center justify-between gap-2">
        <h2 className="font-display text-xs font-semibold tracking-[0.08em] uppercase text-[#e1e2ea]">
          01. Ballistic Parameters
        </h2>
        <span className="font-mono text-[10px] tracking-[0.1em] uppercase text-[#ffb300]">
          {activeWeapon.code}
        </span>
      </div>

      <div className="p-4 space-y-5 flex-1 overflow-y-auto">
        {/* Weapon Platform Dropdown */}
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <label
              htmlFor="weapon-platform-select"
              className="font-mono text-[11px] font-medium tracking-[0.08em] uppercase text-[#8c9bb5]"
            >
              Weapon Platform
            </label>
            <span className="font-mono text-[10px] text-[#00f0ff] tabular-nums">
              {isMelee
                ? `${damageLabel} DMG · MELEE`
                : `${damageLabel} DMG · ${activeWeapon.rpm} RPM`}
            </span>
          </div>
          <div className="relative">
            <select
              id="weapon-platform-select"
              value={config.weaponId}
              onChange={(e) => onChangeConfig({ weaponId: e.target.value })}
              className="chamfer-sm w-full appearance-none bg-[#0f141d] border border-[#232d42] focus:border-[#00f0ff] px-3 py-2.5 pr-9 font-display text-xs font-semibold tracking-[0.04em] text-[#e1e2ea] focus:outline-none cursor-pointer"
            >
              {weapons.map((w) => {
                const dmgText =
                  w.weaponClass === 'MELEE' && w.melee
                    ? `MELEE ${w.melee.comboSteps[0].damage}/${w.melee.specialDamage}`
                    : w.pellets > 1
                      ? `${w.baseDamage}x${w.pellets} DMG`
                      : `${w.baseDamage} DMG`;
                return (
                  <option key={w.id} value={w.id} className="bg-[#0f141d] text-[#e1e2ea]">
                    {w.code} — {w.name} ({dmgText})
                  </option>
                );
              })}
            </select>
            <ChevronDown
              size={14}
              aria-hidden="true"
              className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[#ffb300]"
            />
          </div>

          {isMelee && activeWeapon.melee ? (
            <div className="font-mono text-[10px] leading-relaxed text-[#8c9bb5] tabular-nums">
              Weakspot {activeWeapon.critMultiplier}x · Special {activeWeapon.melee.specialDamage}{' '}
              ({activeWeapon.melee.specialChargeSec}s) · Shove {activeWeapon.melee.shoveDamage} DMG /{' '}
              {activeWeapon.melee.shoveStaggerDamage} STAG
            </div>
          ) : (
            <div className="font-mono text-[10px] leading-relaxed text-[#8c9bb5] tabular-nums">
              Falloff {activeWeapon.falloffStartM}m–{activeWeapon.falloffEndM}m (-
              {activeWeapon.falloffPerMeter}/m) · Pierce {activeWeapon.penetrationDepthM}m (-
              {activeWeapon.penetrationDropPct}%)
            </div>
          )}
        </section>

        {/* Fire Selector / Melee Stance, Aim Priority & Enemy Approach Pattern */}
        <section className="space-y-2.5 pt-3 border-t border-[#1e2638]">
          {isMelee ? (
            <div className="bg-[#0f141d] border border-[#232d42] p-2.5 space-y-1 font-mono text-[10px]">
              <div className="text-[#ffb300] uppercase tracking-[0.08em] font-semibold">
                Melee Ballistics Profile
              </div>
              <div className="text-[#8c9bb5]">
                Reach {activeWeapon.melee!.reachM.toFixed(1)}m · 3-Step Sequential Cadence
              </div>
              <div className="text-[#00f0ff]">
                Special Attack: {activeWeapon.melee!.specialDamage} DMG ({activeWeapon.melee!.specialChargeSec}s Max Charge)
              </div>
              <div className="text-[#ff2a4b]">
                Shove: {activeWeapon.melee!.shoveDamage} DMG /{' '}
                {activeWeapon.melee!.shoveStaggerDamage} STAGGER
              </div>
            </div>
          ) : (
            <>
              <span className="block font-mono text-[11px] font-medium tracking-[0.08em] uppercase text-[#8c9bb5]">
                Fire Selector & Auto Aim
              </span>
              <div className="grid grid-cols-3 gap-1">
                {(
                  [
                    { id: 'AUTO_BURST', label: 'Burst' },
                    { id: 'SEMI_PRECISION', label: 'Semi' },
                    { id: 'FULL_AUTO', label: 'Auto' },
                  ] as { id: FiringMode; label: string }[]
                ).map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => onChangeConfig({ firingMode: m.id })}
                    className={`py-1.5 px-2 font-mono text-[11px] uppercase tracking-[0.06em] border transition-colors cursor-pointer whitespace-nowrap ${
                      config.firingMode === m.id
                        ? 'bg-[#ffb300] border-[#ffb300] text-[#0a0d12] font-semibold'
                        : 'bg-[#0f141d] border-[#232d42] text-[#8c9bb5] hover:text-[#e1e2ea]'
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </>
          )}

          <div className="grid grid-cols-3 gap-1">
            {(
              [
                {
                  id: 'weakspot',
                  label: 'Weakspot',
                  color: 'border-[#ff2a4b] text-[#ff2a4b] bg-[#ff2a4b]/10',
                },
                {
                  id: 'torso',
                  label: 'Armor',
                  color: 'border-[#00f0ff] text-[#00f0ff] bg-[#00f0ff]/10',
                },
                {
                  id: 'limb',
                  label: 'Extremity',
                  color: 'border-[#ffb300] text-[#ffb300] bg-[#ffb300]/10',
                },
              ] as { id: HitZoneId; label: string; color: string }[]
            ).map((z) => (
              <button
                key={z.id}
                type="button"
                onClick={() => onChangeConfig({ aimZone: z.id })}
                className={`py-1.5 px-2 font-mono text-[11px] uppercase tracking-[0.05em] border transition-colors cursor-pointer whitespace-nowrap ${
                  config.aimZone === z.id
                    ? z.color
                    : 'bg-[#0f141d] border-[#232d42] text-[#8c9bb5] hover:text-[#e1e2ea]'
                }`}
              >
                {z.label}
              </button>
            ))}
          </div>

          <div className="pt-1 space-y-1.5">
            <span className="block font-mono text-[11px] font-medium tracking-[0.08em] uppercase text-[#8c9bb5]">
              Hostile Approach Pattern
            </span>
            <div className="grid grid-cols-3 gap-1">
              {(
                [
                  { id: 'ADAPTIVE', label: 'Adaptive' },
                  { id: 'STRAIGHT_CHARGE', label: 'Charge' },
                  { id: 'WEAVE_BREAK', label: 'Weave' },
                ] as { id: EnemyApproachPattern; label: string }[]
              ).map((pat) => (
                <button
                  key={pat.id}
                  type="button"
                  onClick={() => onChangeConfig({ approachPattern: pat.id })}
                  className={`py-1.5 px-2 font-mono text-[10px] uppercase tracking-[0.06em] border transition-colors cursor-pointer whitespace-nowrap ${
                    config.approachPattern === pat.id
                      ? 'bg-[#1b2332] border-[#00f0ff] text-[#00f0ff] font-semibold'
                      : 'bg-[#0f141d] border-[#232d42] text-[#8c9bb5] hover:text-[#e1e2ea]'
                  }`}
                >
                  {pat.label}
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* Target Chassis & Multi-Enemy Squad Spawning (up to 60 total) */}
        <section className="space-y-2.5 pt-3 border-t border-[#1e2638]">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[11px] font-medium tracking-[0.08em] uppercase text-[#8c9bb5]">
              Primary Hostile Chassis
            </span>
            <button
              type="button"
              onClick={onCycleTarget}
              className="font-mono text-[10px] tracking-[0.08em] uppercase text-[#ffb300] hover:text-[#00f0ff] cursor-pointer"
            >
              Cycle Target
            </button>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
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
                  className={`p-2 border text-left transition-colors cursor-pointer space-y-1.5 ${
                    active
                      ? 'bg-[#1b2332] border-[#ffb300] text-[#e1e2ea]'
                      : 'bg-[#0f141d] border-[#232d42] text-[#8c9bb5] hover:text-[#e1e2ea]'
                  }`}
                >
                  <div>
                    <div className="font-mono text-[10px] text-[#ffb300]">
                      {t.code} · {t.defaultHp} HP
                    </div>
                    <div className="text-[11px] font-medium text-[#e1e2ea] truncate">
                      {t.name}
                    </div>
                  </div>
                  <div
                    className="flex items-center justify-between gap-1 pt-1 border-t border-[#1e2638]"
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
                        max={60}
                        value={spawnCount}
                        aria-label={`${t.name} spawn count`}
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          if (!Number.isNaN(val)) {
                            onChangeChassisSpawnCount(t.id, val);
                          }
                        }}
                        className="w-7 bg-transparent text-center font-mono text-[11px] font-bold text-[#00f0ff] tabular-nums focus:outline-none"
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

          <div className="pt-1 flex items-center justify-between gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-[#8c9bb5]">
              Squad Roster ({config.groupSize}/60 Max)
            </span>
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
          </div>
        </section>

        {/* Active Room & Wave Schedule */}
        <section className="space-y-3 pt-3 border-t border-[#1e2638]">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-[#8c9bb5]">
                Active Arena Room
              </div>
              <div className="font-mono text-xs font-semibold text-[#00f0ff]">
                {activeRoom.code} — {activeRoom.name}
              </div>
            </div>
            <button
              type="button"
              onClick={onOpenRooms}
              className="px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.06em] border border-[#232d42] bg-[#0f141d] text-[#ffb300] hover:border-[#ffb300] cursor-pointer"
            >
              Switch Room
            </button>
          </div>

          <PrecisionStepper
            label="Hostile Group Size (Wave 1)"
            value={config.groupSize}
            unit="UNITS"
            min={1}
            max={60}
            step={1}
            accent="amber"
            onChange={(val) => onChangeConfig({ groupSize: val })}
          />

          {/* Group Size Per Wave Configuration */}
          <div className="space-y-1.5 bg-[#0f141d] border border-[#232d42] p-2.5">
            <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.06em]">
              <span className="text-[#8c9bb5]">Group Size / Wave (+50%)</span>
              <span className="text-[#ffb300] font-semibold">W{waveNumber}</span>
            </div>
            <div className="grid grid-cols-5 gap-1">
              {config.waveGroupSizes.map((sz, idx) => {
                const isCur = idx + 1 === waveNumber;
                return (
                  <div
                    key={idx}
                    className={`border p-1 text-center ${
                      isCur ? 'border-[#ffb300] bg-[#161c28]' : 'border-[#1e2638] bg-[#0a0d12]'
                    }`}
                  >
                    <div className="font-mono text-[9px] text-[#8c9bb5]">W{idx + 1}</div>
                    <input
                      type="number"
                      min={1}
                      max={60}
                      value={sz}
                      aria-label={`Wave ${idx + 1} group size`}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        if (!Number.isNaN(val)) {
                          onChangeWaveSize(idx, Math.max(1, Math.min(60, Math.round(val))));
                        }
                      }}
                      className="w-full bg-transparent text-center font-mono text-xs font-bold text-[#e1e2ea] tabular-nums focus:outline-none"
                    />
                  </div>
                );
              })}
            </div>
          </div>

          <PrecisionStepper
            label="Primary Target HP"
            value={config.targetHp}
            unit="HP"
            min={50}
            max={2500}
            step={25}
            accent="red"
            onChange={(val) => onChangeConfig({ targetHp: val })}
          />
          <PrecisionStepper
            label="Spawn Range (Corridor)"
            value={config.distanceM}
            unit="M"
            min={5}
            max={140}
            step={5}
            accent="amber"
            onChange={(val) => onChangeConfig({ distanceM: val })}
          />
        </section>
      </div>

      <div className="p-4 border-t border-[#1e2638] bg-[#161c28] space-y-2">
        <button
          type="button"
          onClick={onEngageBurst}
          className={`chamfer-sm w-full py-2.5 px-4 font-mono text-xs font-bold tracking-[0.1em] uppercase transition-all duration-150 cursor-pointer flex items-center justify-between focus-visible:outline-2 focus-visible:outline-[#00f0ff] ${
            isSimRunning
              ? 'bg-[#ff2a4b] text-[#0a0d12] hover:bg-[#ff526d] glow-red'
              : 'bg-[#ffb300] text-[#0a0d12] hover:bg-[#00f0ff] hover:shadow-[0_0_14px_rgba(0,240,255,0.45)]'
          }`}
        >
          <span>{isSimRunning ? 'Halt Auto-Track' : 'Auto-Engage Squad'}</span>
          <span>[EXEC_01]</span>
        </button>

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onStartNextWave}
            className="py-2 px-3 font-mono text-[11px] font-semibold tracking-[0.06em] uppercase border border-[#00f0ff]/60 bg-[#00f0ff]/10 text-[#00f0ff] hover:bg-[#00f0ff] hover:text-[#0a0d12] transition-colors cursor-pointer"
          >
            Next Wave (W{waveNumber + 1})
          </button>
          <button
            type="button"
            onClick={onResetRange}
            className="py-2 px-3 font-mono text-[11px] font-medium tracking-[0.06em] uppercase border border-[#2a364f] text-[#8c9bb5] hover:bg-[#ffb300]/10 hover:border-[#ffb300] hover:text-[#ffb300] transition-colors cursor-pointer"
          >
            Respawn Squad
          </button>
        </div>
      </div>
    </aside>
  );
};
