/**
 * @file ArmoryScreen.tsx
 * Armory Ballistics Lab screen providing live Firearm, Melee, and Consumable Ordnance stat editing,
 * logarithmic range-falloff SVG plotting, cumulative recoil trace visualization, and direct Range deployment.
 *
 * How stat modifications propagate to the 3D simulation:
 * - Editing any `WeaponStatField` calls `onUpdateWeapon(weapon.id, patch)` or `onUpdateGrenade(grenade.id, patch)`
 *   in `App.tsx`, immutably patching the master `weapons` / `grenades` state arrays.
 * - Because `SimulationCanvas3D` copies `props.weapons` and `props.grenades` into `propsRef.current` every
 *   render, firing projectiles, throwing grenades, deploying turrets, and plotting falloff curves immediately
 *   use the tuned values without requiring a manual "Save" step or resetting wave progress.
 * - For melee weapons, editing Hit 1 damage mirrors into `baseDamage` so theoretical DPS calculations remain synced.
 *
 * Why custom SVG curve plotting with explicit breakpoint insertion (`effectiveRangeM`, `dropRangeM`) beats
 * uniform-step sampling or heavy chart libraries:
 * - Uniform 10m sampling often rounds off sharp knees at `effectiveRangeM` or `dropRangeM` (especially on
 *   short-range consumables like 6m/17m laser trip mines), visibly distorting the flat plateau. Inserting
 *   `effectiveRangeM` and `dropRangeM` directly into the `Set<number>` guarantees pixel-exact corners with
 *   zero external charting bundle dependency.
 */
import React, { useState } from 'react';
import {
  computeConsumableFalloff,
  computeDamageAtEffectiveRange,
  computePotentialRawDps,
  computeRangeFalloff,
  getGrenadeDropRangeM,
  getGrenadeEffectiveRangeM,
  getWeaponTerminalRangeM,
} from '../engine/ballistics';
import {
  GrenadeId,
  GrenadeProfile,
  SimulationConfig,
  WeaponProfile,
  WeaponSlot,
} from '../types/ballistics';
import { WeaponViewmodelSvg } from './WeaponViewmodelSvg';

interface ArmoryScreenProps {
  /** Active simulation config indicating currently equipped weapon/grenade slots. */
  config: SimulationConfig;
  /** Mutable array of all firearms and melee weapons. */
  weapons: WeaponProfile[];
  /** Mutable array of all grenades, mines, C4, and deployable turrets. */
  grenades: GrenadeProfile[];
  /** Equips an inspected firearm/melee weapon into `PRIMARY` or `SECONDARY` and activates that slot. */
  onSelectSlotWeapon: (slot: 'PRIMARY' | 'SECONDARY', weaponId: string) => void;
  /** Selects an inspected consumable as active `config.grenadeId`. */
  onSelectGrenade: (id: GrenadeId) => void;
  /** Switches active operator hand slot (`PRIMARY` | `SECONDARY` | `CONSUMABLE`). */
  onSwitchActiveSlot: (slot: WeaponSlot) => void;
  /** Patches a weapon stat in `App.tsx` (changes reflect live in Range Sim and Targets TTK table). */
  onUpdateWeapon: (weaponId: string, patch: Partial<WeaponProfile>) => void;
  /** Patches a consumable stat in `App.tsx` (changes reflect live on detonations, traps, and turrets). */
  onUpdateGrenade: (grenadeId: GrenadeId, patch: Partial<GrenadeProfile>) => void;
  /** Restores all weapons to default `WEAPONS` values. */
  onResetWeapons: () => void;
  /** Restores all consumables to default `GRENADES` values. */
  onResetGrenades: () => void;
  /** Switches back to the `Range Sim` tab after equipping from Armory. */
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

/**
 * Clamped live numeric characteristic editor; ignores transient `NaN` states during typing.
 */
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

/**
 * Workbench inspector supporting `ALL`, `PRIMARY`, `SECONDARY`, and `ORDNANCE` (`CONSUMABLE`) filters.
 */
export const ArmoryScreen: React.FC<ArmoryScreenProps> = ({
  config,
  weapons,
  grenades,
  onSelectSlotWeapon,
  onSelectGrenade,
  onSwitchActiveSlot,
  onUpdateWeapon,
  onUpdateGrenade,
  onResetWeapons,
  onResetGrenades,
  onDeployToRange,
}) => {
  const [slotFilter, setSlotFilter] = useState<'ALL' | 'PRIMARY' | 'SECONDARY' | 'CONSUMABLE'>('ALL');
  const [inspectedId, setInspectedId] = useState<string>(config.weaponId);

  // Determine whether the inspected ID belongs to a consumable or firearm/melee weapon
  const inspectedConsumable: GrenadeProfile | null =
    grenades.find((g) => g.id === inspectedId) ??
    (slotFilter === 'CONSUMABLE' ? grenades[0] ?? null : null);
  const inspectedWeapon: WeaponProfile =
    weapons.find((w) => w.id === inspectedId) ?? weapons[0];

  const isConsumableMode = inspectedConsumable !== null;
  const isMelee = !isConsumableMode && inspectedWeapon.weaponClass === 'MELEE' && !!inspectedWeapon.melee;

  const filteredWeapons =
    slotFilter === 'CONSUMABLE'
      ? []
      : weapons.filter((w) => slotFilter === 'ALL' || w.slot === slotFilter);
  const filteredConsumables =
    slotFilter === 'ALL' || slotFilter === 'CONSUMABLE' ? grenades : [];

  // Shared SVG chart coordinates for Weapon OR Consumable logarithmic curve
  const chartW = 560;
  const chartH = 210;
  const padL = 42;
  const padR = 16;
  const padT = 16;
  const padB = 28;
  const innerW = chartW - padL - padR;
  const innerH = chartH - padT - padB;

  const activeDropDistM = isConsumableMode
    ? getGrenadeDropRangeM(inspectedConsumable)
    : getWeaponTerminalRangeM(inspectedWeapon);
  const activeRangeDistM = isConsumableMode
    ? getGrenadeEffectiveRangeM(inspectedConsumable)
    : inspectedWeapon.effectiveRangeM;

  const maxDistM = isConsumableMode
    ? Math.max(20, Math.ceil(activeDropDistM / 5) * 5)
    : Math.max(300, Math.ceil(activeDropDistM / 50) * 50);
  const distToXRatio = (d: number) => Math.max(0, Math.min(1, d / maxDistM));

  const maxDmg = isConsumableMode
    ? Math.max(100, Math.ceil(inspectedConsumable.damage / 100) * 100)
    : Math.max(
        400,
        Math.ceil((inspectedWeapon.baseDamage * Math.max(1, inspectedWeapon.pellets)) / 100) * 100
      );

  /** Samples `computeRangeFalloff` across 160 intervals plus exact knee/terminal distances into an SVG `d` path. */
  const buildCurvePath = (w: WeaponProfile) => {
    const wTerm = getWeaponTerminalRangeM(w);
    const steps = 160;
    const pts = new Set<number>([0]);
    for (let i = 0; i <= steps; i++) {
      pts.add((i / steps) * maxDistM);
    }
    if (w.effectiveRangeM <= maxDistM) pts.add(w.effectiveRangeM);
    if (wTerm <= maxDistM) pts.add(wTerm);
    const sorted = Array.from(pts).sort((a, b) => a - b);

    return sorted
      .map((d, idx) => {
        const falloff = computeRangeFalloff(w, d);
        const dmg = w.baseDamage * w.pellets * falloff;
        const x = padL + distToXRatio(d) * innerW;
        const y = padT + innerH - Math.min(1, dmg / maxDmg) * innerH;
        return `${idx === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(' ');
  };

  /** Samples `computeConsumableFalloff` (30% range / full drop) into an SVG curve for grenades & mines. */
  const buildConsumableCurvePath = (g: GrenadeProfile) => {
    const gEff = getGrenadeEffectiveRangeM(g);
    const gDrop = getGrenadeDropRangeM(g);
    const steps = 120;
    const pts = new Set<number>([0]);
    for (let i = 0; i <= steps; i++) {
      pts.add((i / steps) * maxDistM);
    }
    if (gEff <= maxDistM) pts.add(gEff);
    if (gDrop <= maxDistM) pts.add(gDrop);
    const sorted = Array.from(pts).sort((a, b) => a - b);

    return sorted
      .map((d, idx) => {
        const falloff = computeConsumableFalloff(g, d);
        const dmg = g.damage * falloff;
        const x = padL + distToXRatio(d) * innerW;
        const y = padT + innerH - Math.min(1, dmg / maxDmg) * innerH;
        return `${idx === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(' ');
  };

  // Accumulates per-shot yaw/pitch recoil degrees from origin (60, 96) to visualize sustained spray climb
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

  const inspectedRangeDmg = computeDamageAtEffectiveRange(inspectedWeapon);
  const inspectedBaseDamageDisplay = isMelee
    ? inspectedWeapon.melee!.comboSteps.map((s) => s.damage).join(' / ')
    : inspectedWeapon.pellets > 1
      ? `${inspectedWeapon.baseDamage}x${inspectedWeapon.pellets} (${inspectedRangeDmg}x${inspectedWeapon.pellets} @ ${inspectedWeapon.effectiveRangeM}m)`
      : `${inspectedWeapon.baseDamage} (${inspectedRangeDmg} @ ${inspectedWeapon.effectiveRangeM}m)`;
  const inspectedRawDps = computePotentialRawDps(inspectedWeapon);

  const distTicks = isConsumableMode
    ? Array.from({ length: 6 }, (_, i) => Math.round((maxDistM / 5) * i))
    : Array.from({ length: Math.floor(maxDistM / 50) + 1 }, (_, i) => i * 50);

  return (
    <div className="max-w-[1440px] mx-auto p-4 lg:p-6 space-y-6">
      <div className="bg-[#121721] border border-[#1e2638] p-4 sm:p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="font-mono text-[11px] uppercase tracking-[0.1em] text-[#ffb300]">
            Arsenal Workbench · Weapons, Grenades &amp; Consumable Ordnance Tuning
          </div>
          <h1 className="mt-1 font-display text-2xl font-bold tracking-[0.04em] uppercase text-[#e1e2ea]">
            Armory &amp; Ordnance Profiles
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={() => {
              onResetWeapons();
              onResetGrenades();
            }}
            className="px-3.5 py-2.5 border border-[#2a364f] text-[#8c9bb5] font-mono text-xs uppercase tracking-[0.08em] hover:border-[#ffb300] hover:text-[#ffb300] transition-colors cursor-pointer"
          >
            Reset All Defaults
          </button>
          <button
            type="button"
            onClick={() => {
              if (isConsumableMode && inspectedConsumable) {
                onSelectGrenade(inspectedConsumable.id);
                onSwitchActiveSlot('CONSUMABLE');
              } else {
                const equipSlot = inspectedWeapon.slot === 'SECONDARY' ? 'SECONDARY' : 'PRIMARY';
                onSelectSlotWeapon(equipSlot, inspectedWeapon.id);
              }
              onDeployToRange();
            }}
            className="chamfer-sm px-4 py-2.5 bg-[#ffb300] text-[#0a0d12] font-mono text-xs font-bold tracking-[0.08em] uppercase hover:bg-[#00f0ff] hover:shadow-[0_0_12px_rgba(0,240,255,0.4)] transition-all cursor-pointer"
          >
            {isConsumableMode && inspectedConsumable
              ? `Equip ${inspectedConsumable.code} (${inspectedConsumable.shortLabel}) Into Range`
              : `Equip ${inspectedWeapon.code} (${inspectedWeapon.slot}) Into Range`}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        <div className="lg:col-span-4 space-y-2">
          <div className="grid grid-cols-4 gap-1 bg-[#121721] border border-[#1e2638] p-1">
            {(['ALL', 'PRIMARY', 'SECONDARY', 'CONSUMABLE'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => {
                  setSlotFilter(tab);
                  if (tab === 'CONSUMABLE' && !grenades.some((g) => g.id === inspectedId)) {
                    setInspectedId(config.grenadeId);
                  } else if (
                    (tab === 'PRIMARY' || tab === 'SECONDARY') &&
                    !weapons.some((w) => w.slot === tab && w.id === inspectedId)
                  ) {
                    const first = weapons.find((w) => w.slot === tab);
                    if (first) setInspectedId(first.id);
                  }
                }}
                className={`py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.05em] cursor-pointer ${
                  slotFilter === tab
                    ? tab === 'CONSUMABLE'
                      ? 'bg-[#20df78] text-[#0a0d12]'
                      : 'bg-[#ffb300] text-[#0a0d12]'
                    : 'text-[#8c9bb5] hover:text-[#e1e2ea]'
                }`}
              >
                {tab === 'CONSUMABLE' ? 'ORDNANCE' : tab}
              </button>
            ))}
          </div>

          <div className="space-y-2 max-h-[820px] overflow-y-auto pr-1">
            {filteredWeapons.map((w) => {
              const isSelected = !isConsumableMode && w.id === inspectedWeapon.id;
              const isEquipped =
                w.id === config.primaryWeaponId || w.id === config.secondaryWeaponId;
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
                      {w.code} · {w.slot} · {w.category.replace('_', ' ')}
                    </span>
                    {isEquipped && (
                      <span className="font-mono text-[10px] tracking-[0.08em] text-[#20df78] uppercase">
                        EQUIPPED
                      </span>
                    )}
                  </div>
                  <div className="mt-1 font-display text-base font-semibold text-[#e1e2ea]">
                    {w.name}
                  </div>
                  {w.targetSpecialty && (
                    <div className="mt-0.5 font-mono text-[10px] text-[#00f0ff] uppercase">
                      {w.targetSpecialty}
                    </div>
                  )}
                  <div className="mt-1 font-mono text-[11px] text-[#8c9bb5] tabular-nums">
                    {meleeMode
                      ? `${w.melee!.comboSteps.map((s) => s.damage).join('/')} DMG · SPEC ${w.melee!.specialDamage} · SHOVE ${w.melee!.shoveDamage}`
                      : `${
                          w.pellets > 1
                            ? `${w.baseDamage}x${w.pellets}`
                            : `${w.baseDamage}`
                        } DMG · ${w.critMultiplier}x CRIT · ${w.effectiveRangeM}m RNG`}
                  </div>
                </button>
              );
            })}

            {filteredConsumables.map((g) => {
              const isSelected = isConsumableMode && inspectedConsumable?.id === g.id;
              const isEquipped = config.grenadeId === g.id;
              const effR = getGrenadeEffectiveRangeM(g);
              const dropR = getGrenadeDropRangeM(g);
              const isPerLimb = g.id === 'explosive' || g.id === 'sticky_c4';
              return (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => setInspectedId(g.id)}
                  className={`chamfer-md w-full text-left p-4 border transition-colors cursor-pointer ${
                    isSelected
                      ? 'bg-[#1b2332] border-[#20df78]'
                      : 'bg-[#121721] border-[#1e2638] hover:border-[#364463]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className="font-mono text-[11px] tracking-[0.08em]"
                      style={{ color: g.accentHex }}
                    >
                      {g.code} · CONSUMABLE · {g.kind.replace('_', ' ')}
                    </span>
                    {isEquipped && (
                      <span className="font-mono text-[10px] tracking-[0.08em] text-[#20df78] uppercase">
                        SELECTED
                      </span>
                    )}
                  </div>
                  <div className="mt-1 font-display text-base font-semibold text-[#e1e2ea]">
                    {g.name}
                  </div>
                  <div className="mt-1 font-mono text-[11px] text-[#8c9bb5] tabular-nums">
                    {g.damage} {isPerLimb ? 'DMG/LIMB' : 'DMG'} · {effR.toFixed(1)}m / {dropR.toFixed(1)}m DROP · {g.maxUsages} CHARGES
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="lg:col-span-8 space-y-5">
          {isConsumableMode && inspectedConsumable ? (
            <>
              <div className="bg-[#121721] border border-[#1e2638] p-5 space-y-5">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-[#1e2638]">
                  <div className="space-y-1 max-w-xl">
                    <div
                      className="font-mono text-xs uppercase tracking-[0.08em]"
                      style={{ color: inspectedConsumable.accentHex }}
                    >
                      {inspectedConsumable.code} · Tactical Consumable ({inspectedConsumable.kind.replace('_', ' ')})
                    </div>
                    <h2 className="font-display text-xl font-bold text-[#e1e2ea] uppercase tracking-[0.03em]">
                      {inspectedConsumable.name}
                    </h2>
                    <p className="text-sm text-[#8c9bb5] leading-relaxed">
                      {inspectedConsumable.description}
                    </p>
                  </div>
                  <div className="bg-[#0a0d12] bg-tactical-grid border border-[#1e2638] px-5 py-4 flex flex-col items-center justify-center shrink-0 min-w-[140px]">
                    <span
                      className="font-mono text-xs font-bold tracking-[0.1em] uppercase"
                      style={{ color: inspectedConsumable.accentHex }}
                    >
                      {inspectedConsumable.shortLabel}
                    </span>
                    <span className="mt-1 font-mono text-2xl font-bold text-[#e1e2ea] tabular-nums">
                      {inspectedConsumable.maxUsages}x
                    </span>
                    <span className="font-mono text-[9px] text-[#8c9bb5] uppercase">
                      Max Charges
                    </span>
                  </div>
                </div>

                {/* Consumable Summary Metrics */}
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
                  {[
                    {
                      label:
                        inspectedConsumable.id === 'explosive' || inspectedConsumable.id === 'sticky_c4'
                          ? 'Dmg / Limb'
                          : 'Base Damage',
                      val: `${inspectedConsumable.damage} DMG`,
                      tone: 'text-[#ffb300]',
                    },
                    {
                      label: 'Weakspot Mult',
                      val: `${(inspectedConsumable.weakspotMultiplier ?? 1.0).toFixed(2)}x`,
                      tone: 'text-[#ff2a4b]',
                    },
                    {
                      label: 'Range / Drop',
                      val: `${getGrenadeEffectiveRangeM(inspectedConsumable).toFixed(1)}m / ${getGrenadeDropRangeM(inspectedConsumable).toFixed(1)}m`,
                      tone: 'text-[#20df78]',
                    },
                    {
                      label:
                        inspectedConsumable.id === 'laser_trip_mine'
                          ? 'Pierce Depth'
                          : inspectedConsumable.id === 'sticky_c4'
                            ? 'Armor Bypass'
                            : inspectedConsumable.id === 'deployable_turret'
                              ? 'Turret HP / Armor'
                              : 'Cook-Off Fuse',
                      val:
                        inspectedConsumable.id === 'laser_trip_mine'
                          ? `${inspectedConsumable.pierceDepthM ?? 12}m`
                          : inspectedConsumable.id === 'sticky_c4'
                            ? `+${(inspectedConsumable.armorReduction ?? 0.3).toFixed(1)} Mult`
                            : inspectedConsumable.id === 'deployable_turret'
                              ? `${inspectedConsumable.turretHp ?? 150} / ${(inspectedConsumable.turretArmorMult ?? 0.7).toFixed(1)}x`
                              : inspectedConsumable.kind === 'GRENADE'
                                ? '3.0s Cook-Off'
                                : 'Armed Trap',
                      tone: 'text-[#00f0ff]',
                    },
                    {
                      label:
                        inspectedConsumable.id === 'incendiary'
                          ? 'Fire DoT / Move'
                          : 'Stagger Force',
                      val:
                        inspectedConsumable.id === 'incendiary'
                          ? `${inspectedConsumable.dotDamagePerTick ?? 64} / +20% Spd`
                          : `${inspectedConsumable.staggerDamage} STAG`,
                      tone: 'text-[#ffb300]',
                    },
                    {
                      label: 'Max Usages',
                      val: `${inspectedConsumable.maxUsages} Uses`,
                      tone: 'text-[#e1e2ea]',
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
                  ))}
                </div>

                {/* Live Editable Consumable Fields */}
                <div className="space-y-2.5 pt-2 border-t border-[#1e2638]">
                  <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-[#20df78]">
                    Custom Ordnance Characteristic Editor (Changes Apply Live In 3D Range)
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2">
                    <WeaponStatField
                      label={
                        inspectedConsumable.id === 'explosive' || inspectedConsumable.id === 'sticky_c4'
                          ? 'Dmg Per Limb'
                          : 'Base Damage'
                      }
                      value={inspectedConsumable.damage}
                      unit="DMG"
                      min={1}
                      max={3000}
                      step={2}
                      accent="text-[#ffb300]"
                      onChange={(val) =>
                        onUpdateGrenade(inspectedConsumable.id, { damage: Math.round(val) })
                      }
                    />
                    <WeaponStatField
                      label="Range (30%)"
                      value={getGrenadeEffectiveRangeM(inspectedConsumable)}
                      unit="M"
                      min={0.5}
                      max={60}
                      step={0.2}
                      accent="text-[#20df78]"
                      onChange={(val) => {
                        const curDrop = getGrenadeDropRangeM(inspectedConsumable);
                        onUpdateGrenade(inspectedConsumable.id, {
                          effectiveRangeM: Number(val.toFixed(2)),
                          dropRangeM: Math.max(curDrop, val + 0.5),
                          radiusM: Math.max(curDrop, val + 0.5),
                        });
                      }}
                    />
                    <WeaponStatField
                      label="Drop At"
                      value={getGrenadeDropRangeM(inspectedConsumable)}
                      unit="M"
                      min={1.5}
                      max={100}
                      step={0.5}
                      accent="text-[#ff2a4b]"
                      onChange={(val) => {
                        const nextDrop = Number(val.toFixed(2));
                        onUpdateGrenade(inspectedConsumable.id, {
                          dropRangeM: nextDrop,
                          radiusM: nextDrop,
                          effectiveRangeM:
                            inspectedConsumable.id === 'laser_trip_mine'
                              ? Math.min(nextDrop - 0.5, inspectedConsumable.effectiveRangeM ?? 6)
                              : Number((nextDrop * 0.3).toFixed(2)),
                        });
                      }}
                    />
                    <WeaponStatField
                      label="Weakspot Mult"
                      value={inspectedConsumable.weakspotMultiplier ?? 1.0}
                      unit="x"
                      min={0.5}
                      max={6.0}
                      step={0.1}
                      accent="text-[#ff2a4b]"
                      onChange={(val) =>
                        onUpdateGrenade(inspectedConsumable.id, { weakspotMultiplier: val })
                      }
                    />
                    <WeaponStatField
                      label="Max Charges"
                      value={inspectedConsumable.maxUsages}
                      unit="USE"
                      min={1}
                      max={12}
                      step={1}
                      accent="text-[#00f0ff]"
                      onChange={(val) =>
                        onUpdateGrenade(inspectedConsumable.id, { maxUsages: Math.round(val) })
                      }
                    />
                    <WeaponStatField
                      label="Cooldown"
                      value={inspectedConsumable.cooldownSec}
                      unit="SEC"
                      min={0.2}
                      max={10}
                      step={0.1}
                      onChange={(val) =>
                        onUpdateGrenade(inspectedConsumable.id, { cooldownSec: val })
                      }
                    />

                    {inspectedConsumable.id === 'incendiary' && (
                      <>
                        <WeaponStatField
                          label="Impact DMG"
                          value={inspectedConsumable.impactDamage ?? 18}
                          unit="DMG"
                          min={0}
                          max={300}
                          step={1}
                          accent="text-[#ffb300]"
                          onChange={(val) =>
                            onUpdateGrenade(inspectedConsumable.id, {
                              impactDamage: Math.round(val),
                            })
                          }
                        />
                        <WeaponStatField
                          label="Fire DoT / Tick"
                          value={inspectedConsumable.dotDamagePerTick ?? 64}
                          unit="DMG"
                          min={5}
                          max={400}
                          step={2}
                          accent="text-[#ff6a00]"
                          onChange={(val) =>
                            onUpdateGrenade(inspectedConsumable.id, {
                              dotDamagePerTick: Math.round(val),
                            })
                          }
                        />
                      </>
                    )}

                    {inspectedConsumable.id === 'laser_trip_mine' && (
                      <WeaponStatField
                        label="Pierce Depth"
                        value={inspectedConsumable.pierceDepthM ?? 12}
                        unit="M"
                        min={1}
                        max={40}
                        step={0.5}
                        accent="text-[#00f0ff]"
                        onChange={(val) =>
                          onUpdateGrenade(inspectedConsumable.id, { pierceDepthM: val })
                        }
                      />
                    )}

                    {inspectedConsumable.id === 'sticky_c4' && (
                      <WeaponStatField
                        label="Armor Bypass"
                        value={inspectedConsumable.armorReduction ?? 0.3}
                        unit="+MULT"
                        min={0}
                        max={1.0}
                        step={0.05}
                        accent="text-[#a855f7]"
                        onChange={(val) =>
                          onUpdateGrenade(inspectedConsumable.id, { armorReduction: val })
                        }
                      />
                    )}

                    {inspectedConsumable.id === 'deployable_turret' && (
                      <>
                        <WeaponStatField
                          label="Turret HP"
                          value={inspectedConsumable.turretHp ?? 150}
                          unit="HP"
                          min={50}
                          max={2500}
                          step={25}
                          accent="text-[#20df78]"
                          onChange={(val) =>
                            onUpdateGrenade(inspectedConsumable.id, { turretHp: Math.round(val) })
                          }
                        />
                        <WeaponStatField
                          label="Turret Armor"
                          value={inspectedConsumable.turretArmorMult ?? 0.7}
                          unit="x"
                          min={0.1}
                          max={1.5}
                          step={0.05}
                          accent="text-[#00f0ff]"
                          onChange={(val) =>
                            onUpdateGrenade(inspectedConsumable.id, { turretArmorMult: val })
                          }
                        />
                        <WeaponStatField
                          label="Max Active"
                          value={inspectedConsumable.turretMaxDeployed ?? 3}
                          unit="CNT"
                          min={1}
                          max={8}
                          step={1}
                          accent="text-[#ffb300]"
                          onChange={(val) =>
                            onUpdateGrenade(inspectedConsumable.id, {
                              turretMaxDeployed: Math.round(val),
                            })
                          }
                        />
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* Logarithmic Falloff Curve for Consumables */}
              <div className="bg-[#121721] border border-[#1e2638] p-5 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-display text-sm font-semibold uppercase tracking-[0.06em] text-[#e1e2ea]">
                    Consumable Logarithmic Falloff Curve ({activeRangeDistM.toFixed(1)}m Range ·{' '}
                    {activeDropDistM.toFixed(1)}m Drop)
                  </h3>
                  <span className="font-mono text-[11px] text-[#20df78]">
                    Armor &amp; Weakspot ({(inspectedConsumable.weakspotMultiplier ?? 1).toFixed(1)}x) Applied
                  </span>
                </div>
                <div className="bg-[#0a0d12] border border-[#1e2638] p-3">
                  <svg viewBox={`0 0 ${chartW} ${chartH}`} className="w-full h-52 overflow-visible">
                    {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
                      const val = Math.round(maxDmg * ratio);
                      const y = padT + innerH - ratio * innerH;
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

                    {distTicks.map((d) => {
                      const x = padL + distToXRatio(d) * innerW;
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

                    <path
                      d={buildConsumableCurvePath(inspectedConsumable)}
                      fill="none"
                      stroke={inspectedConsumable.accentHex}
                      strokeWidth="2.5"
                    />

                    {[
                      { m: activeRangeDistM, label: 'RANGE', color: '#20df78', yOff: 12 },
                      { m: activeDropDistM, label: 'DROP', color: '#ff2a4b', yOff: 24 },
                    ].map((mark) => {
                      const clampedM = Math.min(maxDistM, mark.m);
                      const mx = padL + distToXRatio(clampedM) * innerW;
                      const alignRight = clampedM / maxDistM > 0.72;
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
                            x={alignRight ? mx - 4 : mx + 4}
                            y={padT + mark.yOff}
                            textAnchor={alignRight ? 'end' : 'start'}
                            fill={mark.color}
                            fontSize="9"
                            fontFamily="JetBrains Mono, monospace"
                          >
                            {mark.label} {mark.m.toFixed(1)}m
                          </text>
                        </g>
                      );
                    })}
                  </svg>
                </div>
              </div>
            </>
          ) : (
            <>
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
                        label: 'Range / Drop',
                        val: `${inspectedWeapon.effectiveRangeM}m / ${Math.round(activeDropDistM)}m`,
                        tone: 'text-[#20df78]',
                      },
                      {
                        label: 'Potential Raw DPS',
                        val: `${inspectedRawDps} DPS`,
                        tone: 'text-[#00f0ff]',
                      },
                      {
                        label: 'Mag / Mags',
                        val: `${inspectedWeapon.magSize} × ${inspectedWeapon.maxMagazines}`,
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
                        max={48}
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
                        label="Max Mags"
                        value={inspectedWeapon.maxMagazines}
                        unit="MAGS"
                        min={1}
                        max={24}
                        step={1}
                        accent="text-[#ffb300]"
                        onChange={(val) =>
                          onUpdateWeapon(inspectedWeapon.id, { maxMagazines: Math.round(val) })
                        }
                      />
                      <WeaponStatField
                        label="Reload Time"
                        value={inspectedWeapon.reloadTimeMs}
                        unit="MS"
                        min={400}
                        max={8000}
                        step={50}
                        onChange={(val) =>
                          onUpdateWeapon(inspectedWeapon.id, { reloadTimeMs: Math.round(val) })
                        }
                      />
                      <WeaponStatField
                        label="Weakspot Mult"
                        value={inspectedWeapon.critMultiplier}
                        unit="x"
                        min={1.0}
                        max={6.0}
                        step={0.05}
                        accent="text-[#ff2a4b]"
                        onChange={(val) =>
                          onUpdateWeapon(inspectedWeapon.id, { critMultiplier: val })
                        }
                      />
                      <WeaponStatField
                        label="Range"
                        value={inspectedWeapon.effectiveRangeM}
                        unit="M"
                        min={1}
                        max={400}
                        step={1}
                        accent="text-[#20df78]"
                        onChange={(val) => {
                          const nextRange = Math.round(val);
                          onUpdateWeapon(inspectedWeapon.id, {
                            effectiveRangeM: nextRange,
                            dropRangeM: Math.max(nextRange + 5, inspectedWeapon.dropRangeM),
                          });
                        }}
                      />
                      <WeaponStatField
                        label="Drop At"
                        value={inspectedWeapon.dropRangeM}
                        unit="M"
                        min={5}
                        max={500}
                        step={5}
                        accent="text-[#ff2a4b]"
                        onChange={(val) =>
                          onUpdateWeapon(inspectedWeapon.id, {
                            dropRangeM: Math.max(inspectedWeapon.effectiveRangeM + 1, Math.round(val)),
                          })
                        }
                      />
                      <WeaponStatField
                        label="Pierce Depth"
                        value={inspectedWeapon.penetrationDepthM}
                        unit="M"
                        min={0}
                        max={50}
                        step={0.1}
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
                      Melee Combo Sequence &amp; Special / Shove Matrix
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
                        Logarithmic Range Curve ({inspectedWeapon.effectiveRangeM}m Range · {Math.round(activeDropDistM)}m Drop)
                      </h3>
                      <span className="font-mono text-[11px] text-[#ffb300]">
                        Weakspot {inspectedWeapon.critMultiplier}x · Stagger {Math.round(inspectedWeapon.baseDamage * 1.2)} (Base +20%)
                      </span>
                    </div>

                    <div className="bg-[#0a0d12] border border-[#1e2638] p-3">
                      <svg viewBox={`0 0 ${chartW} ${chartH}`} className="w-full h-52 overflow-visible">
                        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
                          const val = Math.round(maxDmg * ratio);
                          const y = padT + innerH - ratio * innerH;
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

                        {distTicks.map((d) => {
                          const x = padL + distToXRatio(d) * innerW;
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
                          { m: inspectedWeapon.effectiveRangeM, label: 'RANGE', color: '#20df78', yOff: 12 },
                          { m: Math.round(activeDropDistM), label: 'DROP', color: '#ff2a4b', yOff: 24 },
                        ].map((mark) => {
                          const clampedM = Math.min(maxDistM, mark.m);
                          const mx = padL + distToXRatio(clampedM) * innerW;
                          const alignRight = clampedM / maxDistM > 0.72;
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
                                x={alignRight ? mx - 4 : mx + 4}
                                y={padT + mark.yOff}
                                textAnchor={alignRight ? 'end' : 'start'}
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
            </>
          )}
        </div>
      </div>
    </div>
  );
};

