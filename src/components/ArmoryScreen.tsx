import React, { useState } from 'react';
import {
  computeFalloffEndDamage,
  computePotentialRawDps,
  computeRangeFalloff,
} from '../engine/ballistics';
import { SimulationConfig, WeaponProfile } from '../types/ballistics';
import { WeaponViewmodelSvg } from './WeaponViewmodelSvg';

interface ArmoryScreenProps {
  config: SimulationConfig;
  weapons: WeaponProfile[];
  onChangeConfig: (patch: Partial<SimulationConfig>) => void;
  onUpdateWeapon: (weaponId: string, patch: Partial<WeaponProfile>) => void;
  onResetWeapons: () => void;
  onDeployToRange: () => void;
}

interface WeaponStatFieldProps {
  label: string;
  value: number;
  unit?: string;
  min: number;
  max: number;
  step: number;
  accent?: string;
  onChange: (val: number) => void;
}

const WeaponStatField: React.FC<WeaponStatFieldProps> = ({
  label,
  value,
  unit = '',
  min,
  max,
  step,
  accent = 'text-[#e1e2ea]',
  onChange,
}) => (
  <label className="block bg-[#0f141d] border border-[#232d42] focus-within:border-[#00f0ff] p-2.5 space-y-1 transition-colors">
    <div className="flex items-center justify-between gap-1 font-mono text-[10px] uppercase tracking-[0.06em] text-[#8c9bb5]">
      <span className="truncate">{label}</span>
      {unit && <span className="text-[#8c9bb5]/75 shrink-0">{unit}</span>}
    </div>
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      value={Number.isFinite(value) ? value : min}
      onChange={(e) => {
        const parsed = Number(e.target.value);
        if (!Number.isNaN(parsed)) {
          onChange(Math.max(min, Math.min(max, parsed)));
        }
      }}
      className={`w-full bg-transparent font-mono text-sm font-bold tabular-nums focus:outline-none ${accent}`}
    />
  </label>
);

export const ArmoryScreen: React.FC<ArmoryScreenProps> = ({
  config,
  weapons,
  onChangeConfig,
  onUpdateWeapon,
  onResetWeapons,
  onDeployToRange,
}) => {
  const [inspectedId, setInspectedId] = useState<string>(config.weaponId);
  const inspectedWeapon: WeaponProfile =
    weapons.find((w) => w.id === inspectedId) ?? weapons[0];
  const isMelee = inspectedWeapon.weaponClass === 'MELEE' && !!inspectedWeapon.melee;

  // Sample falloff curve densely from 0m to 150m
  const distances = Array.from({ length: 31 }, (_, i) => i * 5);
  const chartW = 560;
  const chartH = 210;
  const padL = 42;
  const padR = 16;
  const padT = 16;
  const padB = 28;
  const innerW = chartW - padL - padR;
  const innerH = chartH - padT - padB;
  const maxDmg = 280;

  const buildCurvePath = (w: WeaponProfile) => {
    return distances
      .map((d, idx) => {
        const falloff = computeRangeFalloff(w, d);
        const dmg = w.baseDamage * w.pellets * falloff;
        const x = padL + (d / 150) * innerW;
        const y = padT + innerH - Math.min(1, dmg / maxDmg) * innerH;
        return `${idx === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(' ');
  };

  // Build cumulative recoil pattern trace coordinates
  const recoilNodes = (() => {
    let cx = 60;
    let cy = 96;
    const pts: { x: number; y: number; step: number }[] = [{ x: cx, y: cy, step: 0 }];
    inspectedWeapon.recoilPattern.forEach((r, idx) => {
      cx += r.yawDeg * 8.4;
      cy -= r.pitchDeg * 1.44;
      pts.push({ x: cx, y: cy, step: idx + 1 });
    });
    return pts;
  })();

  const inspectedEndDmg = computeFalloffEndDamage(inspectedWeapon);
  const inspectedBaseDamageDisplay = isMelee
    ? inspectedWeapon.melee!.comboSteps.map((s) => s.damage).join(' / ')
    : inspectedWeapon.pellets > 1
      ? `${inspectedWeapon.baseDamage}x${inspectedWeapon.pellets} - ${inspectedEndDmg}x${inspectedWeapon.pellets}`
      : `${inspectedWeapon.baseDamage} - ${inspectedEndDmg}`;
  const inspectedRawDps = computePotentialRawDps(inspectedWeapon);

  return (
    <div className="max-w-[1440px] mx-auto p-4 lg:p-6 space-y-6">
      <div className="bg-[#121721] border border-[#1e2638] p-4 sm:p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="font-mono text-[11px] uppercase tracking-[0.1em] text-[#ffb300]">
            Arsenal Workbench · Live Ballistic & Melee Tuning
          </div>
          <h1 className="mt-1 font-display text-2xl font-bold tracking-[0.04em] uppercase text-[#e1e2ea]">
            Armory & Weapon Profiles
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={onResetWeapons}
            className="px-3.5 py-2.5 border border-[#2a364f] text-[#8c9bb5] font-mono text-xs uppercase tracking-[0.08em] hover:border-[#ffb300] hover:text-[#ffb300] transition-colors cursor-pointer"
          >
            Reset Weapon Defaults
          </button>
          <button
            type="button"
            onClick={() => {
              onChangeConfig({ weaponId: inspectedWeapon.id });
              onDeployToRange();
            }}
            className="chamfer-sm px-4 py-2.5 bg-[#ffb300] text-[#0a0d12] font-mono text-xs font-bold tracking-[0.08em] uppercase hover:bg-[#00f0ff] hover:shadow-[0_0_12px_rgba(0,240,255,0.4)] transition-all cursor-pointer"
          >
            Load {inspectedWeapon.code} Into 3D Range
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        <div className="lg:col-span-4 space-y-2">
          {weapons.map((w) => {
            const isSelected = w.id === inspectedWeapon.id;
            const isEquipped = w.id === config.weaponId;
            const meleeMode = w.weaponClass === 'MELEE' && !!w.melee;
            return (
              <button
                key={w.id}
                type="button"
                onClick={() => setInspectedId(w.id)}
                className={`chamfer-md w-full text-left p-4 border transition-colors cursor-pointer ${
                  isSelected
                    ? 'bg-[#1b2332] border-[#ffb300]'
                    : 'bg-[#121721] border-[#1e2638] hover:border-[#364463]'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[11px] tracking-[0.08em] text-[#ffb300]">
                    {w.code} · {w.damageType}
                  </span>
                  {isEquipped && (
                    <span className="font-mono text-[10px] tracking-[0.08em] text-[#20df78] uppercase">
                      ACTIVE IN RANGE
                    </span>
                  )}
                </div>
                <div className="mt-1 font-display text-base font-semibold text-[#e1e2ea]">
                  {w.name}
                </div>
                <div className="mt-1 font-mono text-[11px] text-[#8c9bb5] tabular-nums">
                  {meleeMode
                    ? `${w.melee!.comboSteps.map((s) => s.damage).join('/')} DMG · SPEC ${w.melee!.specialDamage} · SHOVE ${w.melee!.shoveDamage}`
                    : `${
                        w.pellets > 1
                          ? `${w.baseDamage}x${w.pellets} - ${computeFalloffEndDamage(w)}x${w.pellets}`
                          : `${w.baseDamage} - ${computeFalloffEndDamage(w)}`
                      } DMG · ${w.falloffStartM}m-${w.falloffEndM}m · ${computePotentialRawDps(w)} DPS`}
                </div>
              </button>
            );
          })}
        </div>

        <div className="lg:col-span-8 space-y-5">
          <div className="bg-[#121721] border border-[#1e2638] p-5 space-y-5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-[#1e2638]">
              <div className="space-y-1 max-w-xl">
                <div className="font-mono text-xs text-[#00f0ff] uppercase tracking-[0.08em]">
                  {inspectedWeapon.role} · {inspectedWeapon.caliber}
                </div>
                <h2 className="font-display text-xl font-bold text-[#e1e2ea] uppercase tracking-[0.03em]">
                  {inspectedWeapon.name}
                </h2>
                <p className="text-sm text-[#8c9bb5] leading-relaxed">
                  {inspectedWeapon.description}
                </p>
              </div>
              <div className="bg-[#0a0d12] bg-tactical-grid border border-[#1e2638] px-5 py-3 flex items-center justify-center shrink-0">
                <WeaponViewmodelSvg weaponId={inspectedWeapon.id} isFiring={false} />
              </div>
            </div>

            {/* Summary Metrics Strip */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
              {isMelee && inspectedWeapon.melee ? (
                [
                  { label: 'Combo Damage', val: inspectedBaseDamageDisplay, tone: 'text-[#ffb300]' },
                  {
                    label: 'Special Damage',
                    val: `${inspectedWeapon.melee.specialDamage}${inspectedWeapon.melee.specialIsAoe ? ' AoE' : ''}`,
                    tone: 'text-[#ff2a4b]',
                  },
                  {
                    label: 'Charge Time',
                    val: `${inspectedWeapon.melee.specialChargeSec}s`,
                    tone: 'text-[#00f0ff]',
                  },
                  {
                    label: 'Weakspot Mult',
                    val: `${inspectedWeapon.critMultiplier}x`,
                    tone: 'text-[#20df78]',
                  },
                  {
                    label: 'Shove DMG / STAG',
                    val: `${inspectedWeapon.melee.shoveDamage} / ${inspectedWeapon.melee.shoveStaggerDamage}`,
                    tone: 'text-[#ffb300]',
                  },
                  {
                    label: 'Potential DPS',
                    val: `${inspectedRawDps} DPS`,
                    tone: 'text-[#00f0ff]',
                  },
                ].map((m) => (
                  <div key={m.label} className="bg-[#0f141d] border border-[#232d42] p-3">
                    <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-[#8c9bb5]">
                      {m.label}
                    </div>
                    <div className={`mt-1 font-mono text-sm font-bold tabular-nums ${m.tone}`}>
                      {m.val}
                    </div>
                  </div>
                ))
              ) : (
                [
                  { label: 'Base Damage', val: inspectedBaseDamageDisplay, tone: 'text-[#ffb300]' },
                  { label: 'Fire Rate', val: `${inspectedWeapon.rpm} RPM`, tone: 'text-[#e1e2ea]' },
                  {
                    label: 'Falloff Range',
                    val: `${inspectedWeapon.falloffStartM}m - ${inspectedWeapon.falloffEndM}m`,
                    tone: 'text-[#20df78]',
                  },
                  {
                    label: 'Potential Raw DPS',
                    val: `${inspectedRawDps} DPS`,
                    tone: 'text-[#00f0ff]',
                  },
                  {
                    label: 'Magazine Size',
                    val: `${inspectedWeapon.magSize} RDS`,
                    tone: 'text-[#ff2a4b]',
                  },
                  {
                    label: 'Penetration',
                    val: `${inspectedWeapon.penetrationDepthM}m (-${inspectedWeapon.penetrationDropPct}%)`,
                    tone: 'text-[#ffb300]',
                  },
                ].map((m) => (
                  <div key={m.label} className="bg-[#0f141d] border border-[#232d42] p-3">
                    <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-[#8c9bb5]">
                      {m.label}
                    </div>
                    <div className={`mt-1 font-mono text-sm font-bold tabular-nums ${m.tone}`}>
                      {m.val}
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Live Editable Weapon Characteristics */}
            <div className="space-y-2.5 pt-2 border-t border-[#1e2638]">
              <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-[#00f0ff]">
                Custom Weapon Characteristic Editor (Changes Apply Live In 3D Range)
              </div>

              {isMelee && inspectedWeapon.melee ? (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {inspectedWeapon.melee.comboSteps.map((step, idx) => (
                    <WeaponStatField
                      key={step.label}
                      label={`Hit ${idx + 1} Damage`}
                      value={step.damage}
                      unit={step.isAoe ? 'AOE' : 'DMG'}
                      min={5}
                      max={1000}
                      step={5}
                      accent="text-[#ffb300]"
                      onChange={(val) => {
                        const nextSteps = inspectedWeapon.melee!.comboSteps.map((s, sIdx) =>
                          sIdx === idx ? { ...s, damage: Math.round(val) } : s
                        );
                        onUpdateWeapon(inspectedWeapon.id, {
                          baseDamage: idx === 0 ? Math.round(val) : inspectedWeapon.baseDamage,
                          melee: { ...inspectedWeapon.melee!, comboSteps: nextSteps },
                        });
                      }}
                    />
                  ))}
                  <WeaponStatField
                    label="Special Damage"
                    value={inspectedWeapon.melee.specialDamage}
                    unit={inspectedWeapon.melee.specialIsAoe ? 'AOE' : 'DMG'}
                    min={10}
                    max={1500}
                    step={5}
                    accent="text-[#ff2a4b]"
                    onChange={(val) =>
                      onUpdateWeapon(inspectedWeapon.id, {
                        melee: { ...inspectedWeapon.melee!, specialDamage: Math.round(val) },
                      })
                    }
                  />
                  <WeaponStatField
                    label="Charge Time"
                    value={inspectedWeapon.melee.specialChargeSec}
                    unit="SEC"
                    min={0.2}
                    max={5.0}
                    step={0.1}
                    accent="text-[#00f0ff]"
                    onChange={(val) =>
                      onUpdateWeapon(inspectedWeapon.id, {
                        melee: { ...inspectedWeapon.melee!, specialChargeSec: val },
                      })
                    }
                  />
                  <WeaponStatField
                    label="Weakspot Mult"
                    value={inspectedWeapon.critMultiplier}
                    unit="x"
                    min={1.0}
                    max={6.0}
                    step={0.1}
                    accent="text-[#20df78]"
                    onChange={(val) =>
                      onUpdateWeapon(inspectedWeapon.id, { critMultiplier: val })
                    }
                  />
                  <WeaponStatField
                    label="Shove Damage"
                    value={inspectedWeapon.melee.shoveDamage}
                    unit="DMG"
                    min={1}
                    max={500}
                    step={2}
                    onChange={(val) =>
                      onUpdateWeapon(inspectedWeapon.id, {
                        melee: { ...inspectedWeapon.melee!, shoveDamage: Math.round(val) },
                      })
                    }
                  />
                  <WeaponStatField
                    label="Shove Stagger"
                    value={inspectedWeapon.melee.shoveStaggerDamage}
                    unit="STAG"
                    min={5}
                    max={500}
                    step={5}
                    accent="text-[#00f0ff]"
                    onChange={(val) =>
                      onUpdateWeapon(inspectedWeapon.id, {
                        melee: {
                          ...inspectedWeapon.melee!,
                          shoveStaggerDamage: Math.round(val),
                        },
                      })
                    }
                  />
                  <WeaponStatField
                    label="Melee Reach"
                    value={inspectedWeapon.melee.reachM}
                    unit="M"
                    min={2.0}
                    max={8.0}
                    step={0.2}
                    onChange={(val) =>
                      onUpdateWeapon(inspectedWeapon.id, {
                        melee: { ...inspectedWeapon.melee!, reachM: val },
                      })
                    }
                  />
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2">
                  <WeaponStatField
                    label="Base Damage"
                    value={inspectedWeapon.baseDamage}
                    unit="DMG"
                    min={1}
                    max={1000}
                    step={1}
                    accent="text-[#ffb300]"
                    onChange={(val) =>
                      onUpdateWeapon(inspectedWeapon.id, { baseDamage: Math.round(val) })
                    }
                  />
                  <WeaponStatField
                    label="Pellets"
                    value={inspectedWeapon.pellets}
                    unit="CNT"
                    min={1}
                    max={24}
                    step={1}
                    onChange={(val) =>
                      onUpdateWeapon(inspectedWeapon.id, { pellets: Math.round(val) })
                    }
                  />
                  <WeaponStatField
                    label="Fire Rate"
                    value={inspectedWeapon.rpm}
                    unit="RPM"
                    min={60}
                    max={1500}
                    step={10}
                    accent="text-[#00f0ff]"
                    onChange={(val) =>
                      onUpdateWeapon(inspectedWeapon.id, { rpm: Math.round(val) })
                    }
                  />
                  <WeaponStatField
                    label="Mag Size"
                    value={inspectedWeapon.magSize}
                    unit="RDS"
                    min={1}
                    max={200}
                    step={1}
                    accent="text-[#ff2a4b]"
                    onChange={(val) =>
                      onUpdateWeapon(inspectedWeapon.id, { magSize: Math.round(val) })
                    }
                  />
                  <WeaponStatField
                    label="Reload Time"
                    value={inspectedWeapon.reloadTimeMs}
                    unit="MS"
                    min={400}
                    max={5000}
                    step={50}
                    onChange={(val) =>
                      onUpdateWeapon(inspectedWeapon.id, { reloadTimeMs: Math.round(val) })
                    }
                  />
                  <WeaponStatField
                    label="Falloff Start"
                    value={inspectedWeapon.falloffStartM}
                    unit="M"
                    min={1}
                    max={140}
                    step={1}
                    accent="text-[#20df78]"
                    onChange={(val) =>
                      onUpdateWeapon(inspectedWeapon.id, { falloffStartM: Math.round(val) })
                    }
                  />
                  <WeaponStatField
                    label="Falloff End"
                    value={inspectedWeapon.falloffEndM}
                    unit="M"
                    min={5}
                    max={200}
                    step={5}
                    accent="text-[#20df78]"
                    onChange={(val) =>
                      onUpdateWeapon(inspectedWeapon.id, { falloffEndM: Math.round(val) })
                    }
                  />
                  <WeaponStatField
                    label="Drop / Meter"
                    value={inspectedWeapon.falloffPerMeter}
                    unit="-DMG"
                    min={0}
                    max={10}
                    step={0.05}
                    onChange={(val) =>
                      onUpdateWeapon(inspectedWeapon.id, { falloffPerMeter: val })
                    }
                  />
                  <WeaponStatField
                    label="Floor Ratio"
                    value={Math.round(inspectedWeapon.minFalloffFactor * 100)}
                    unit="%"
                    min={5}
                    max={100}
                    step={1}
                    onChange={(val) =>
                      onUpdateWeapon(inspectedWeapon.id, { minFalloffFactor: val / 100 })
                    }
                  />
                  <WeaponStatField
                    label="Pierce Depth"
                    value={inspectedWeapon.penetrationDepthM}
                    unit="M"
                    min={0}
                    max={5}
                    step={0.05}
                    accent="text-[#00f0ff]"
                    onChange={(val) =>
                      onUpdateWeapon(inspectedWeapon.id, { penetrationDepthM: val })
                    }
                  />
                  <WeaponStatField
                    label="Pierce Drop"
                    value={inspectedWeapon.penetrationDropPct}
                    unit="%"
                    min={0}
                    max={90}
                    step={5}
                    accent="text-[#ffb300]"
                    onChange={(val) =>
                      onUpdateWeapon(inspectedWeapon.id, { penetrationDropPct: val })
                    }
                  />
                  <WeaponStatField
                    label="Recoil Max"
                    value={inspectedWeapon.recoilCoeff.maxScale}
                    unit="x"
                    min={0.1}
                    max={5}
                    step={0.05}
                    onChange={(val) =>
                      onUpdateWeapon(inspectedWeapon.id, {
                        recoilCoeff: { ...inspectedWeapon.recoilCoeff, maxScale: val },
                      })
                    }
                  />
                </div>
              )}
            </div>
          </div>

          {isMelee && inspectedWeapon.melee ? (
            <div className="bg-[#121721] border border-[#1e2638] p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1e2638] pb-3">
                <h3 className="font-display text-sm font-semibold uppercase tracking-[0.06em] text-[#e1e2ea]">
                  Melee Combo Sequence & Special / Shove Matrix
                </h3>
                <span className="font-mono text-[11px] text-[#00f0ff]">
                  WEAKSPOT MULTIPLIER {inspectedWeapon.critMultiplier}x
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {inspectedWeapon.melee.comboSteps.map((step, i) => (
                  <div key={step.label} className="bg-[#0f141d] border border-[#232d42] p-3.5 space-y-1.5">
                    <div className="flex items-center justify-between font-mono text-[10px] uppercase text-[#ffb300]">
                      <span>STEP 0{i + 1}</span>
                      <span>{step.isAoe ? `${step.aoeArcDeg}° AOE` : 'SINGLE TARGET'}</span>
                    </div>
                    <div className="font-display text-sm font-semibold text-[#e1e2ea]">
                      {step.label}
                    </div>
                    <div className="font-mono text-xs text-[#20df78] font-bold tabular-nums">
                      {step.damage} DMG · {(step.damage * inspectedWeapon.critMultiplier).toFixed(0)} CRIT
                    </div>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="bg-[#0f141d] border border-[#ff2a4b]/50 p-3.5 space-y-1">
                  <div className="font-mono text-[10px] uppercase text-[#ff2a4b]">
                    LMB HOLD SPECIAL ({inspectedWeapon.melee.specialChargeSec}s CHARGE)
                  </div>
                  <div className="font-mono text-sm font-bold text-[#e1e2ea] tabular-nums">
                    {inspectedWeapon.melee.specialDamage} DMG{' '}
                    {inspectedWeapon.melee.specialIsAoe ? '(Sweep AoE)' : '(Heavy Overhead Slam)'}
                  </div>
                  <div className="text-xs text-[#8c9bb5]">
                    {inspectedWeapon.melee.specialChainAltSweep
                      ? 'Sweeps Left → Right, then chains Right → Left if second hit is special.'
                      : 'Slowly tightens grip upward and slams straight down with crushing force.'}
                  </div>
                </div>
                <div className="bg-[#0f141d] border border-[#00f0ff]/50 p-3.5 space-y-1">
                  <div className="font-mono text-[10px] uppercase text-[#00f0ff]">
                    RMB DEFENSIVE SHOVE
                  </div>
                  <div className="font-mono text-sm font-bold text-[#e1e2ea] tabular-nums">
                    {inspectedWeapon.melee.shoveDamage} DMG ·{' '}
                    {inspectedWeapon.melee.shoveStaggerDamage} STAGGER DMG
                  </div>
                  <div className="text-xs text-[#8c9bb5]">
                    Knocks advancing hostiles backward and rapidly breaks posture into stagger.
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-12 gap-5">
              <div className="xl:col-span-8 bg-[#121721] border border-[#1e2638] p-5 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-display text-sm font-semibold uppercase tracking-[0.06em] text-[#e1e2ea]">
                    Damage Falloff Envelope (0m – 150m)
                  </h3>
                  <span className="font-mono text-[11px] text-[#ffb300]">
                    Floor {Math.round(inspectedWeapon.minFalloffFactor * 100)}% (Non-Zero)
                  </span>
                </div>

                <div className="bg-[#0a0d12] border border-[#1e2638] p-3">
                  <svg viewBox={`0 0 ${chartW} ${chartH}`} className="w-full h-52 overflow-visible">
                    {[0, 70, 140, 210, 280].map((val) => {
                      const y = padT + innerH - (val / maxDmg) * innerH;
                      return (
                        <g key={val}>
                          <line x1={padL} y1={y} x2={chartW - padR} y2={y} stroke="#1e2638" />
                          <text
                            x={padL - 8}
                            y={y + 3}
                            textAnchor="end"
                            fill="#8c9bb5"
                            fontSize="10"
                            fontFamily="JetBrains Mono, monospace"
                          >
                            {val}
                          </text>
                        </g>
                      );
                    })}

                    {[0, 30, 60, 90, 120, 150].map((d) => {
                      const x = padL + (d / 150) * innerW;
                      return (
                        <g key={d}>
                          <line
                            x1={x}
                            y1={padT}
                            x2={x}
                            y2={padT + innerH}
                            stroke="#1e2638"
                            strokeDasharray="3 3"
                          />
                          <text
                            x={x}
                            y={chartH - 6}
                            textAnchor="middle"
                            fill="#8c9bb5"
                            fontSize="10"
                            fontFamily="JetBrains Mono, monospace"
                          >
                            {d}m
                          </text>
                        </g>
                      );
                    })}

                    {weapons
                      .filter((w) => w.id !== inspectedWeapon.id && w.weaponClass === 'RANGED')
                      .map((w) => (
                        <path
                          key={w.id}
                          d={buildCurvePath(w)}
                          fill="none"
                          stroke="#364463"
                          strokeWidth="1.3"
                          strokeDasharray="4 4"
                        />
                      ))}

                    <path
                      d={buildCurvePath(inspectedWeapon)}
                      fill="none"
                      stroke="#ffb300"
                      strokeWidth="2.5"
                    />

                    {[
                      { m: inspectedWeapon.falloffStartM, label: 'START', color: '#20df78' },
                      { m: inspectedWeapon.falloffEndM, label: 'END', color: '#ff2a4b' },
                    ].map((mark) => {
                      const mx = padL + (Math.min(150, mark.m) / 150) * innerW;
                      return (
                        <g key={mark.label}>
                          <line
                            x1={mx}
                            y1={padT}
                            x2={mx}
                            y2={padT + innerH}
                            stroke={mark.color}
                            strokeDasharray="4 2"
                          />
                          <text
                            x={mx + 4}
                            y={padT + 12}
                            fill={mark.color}
                            fontSize="9"
                            fontFamily="JetBrains Mono, monospace"
                          >
                            {mark.label} {mark.m}m
                          </text>
                        </g>
                      );
                    })}
                  </svg>
                </div>
              </div>

              <div className="xl:col-span-4 bg-[#121721] border border-[#1e2638] p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="font-display text-sm font-semibold uppercase tracking-[0.06em] text-[#e1e2ea]">
                    Recoil Pattern
                  </h3>
                  <span className="font-mono text-[10px] text-[#00f0ff]">
                    {inspectedWeapon.recoilPattern.length}-STEP LOOP
                  </span>
                </div>
                <div className="bg-[#0a0d12] border border-[#1e2638] p-2">
                  <svg viewBox="0 0 120 110" className="w-full h-52">
                    <line x1="60" y1="6" x2="60" y2="104" stroke="#1e2638" strokeDasharray="2 2" />
                    <line x1="12" y1="96" x2="108" y2="96" stroke="#1e2638" strokeDasharray="2 2" />
                    <polyline
                      points={recoilNodes.map((n) => `${n.x.toFixed(1)},${n.y.toFixed(1)}`).join(' ')}
                      fill="none"
                      stroke="#00f0ff"
                      strokeWidth="1.2"
                    />
                    {recoilNodes.map((n) => (
                      <circle
                        key={n.step}
                        cx={n.x}
                        cy={n.y}
                        r={n.step === 0 ? 3.2 : 2.3}
                        fill={n.step === 0 ? '#20df78' : '#ffb300'}
                      />
                    ))}
                  </svg>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
