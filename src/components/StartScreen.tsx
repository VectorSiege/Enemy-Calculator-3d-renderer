/**
 * @file StartScreen.tsx
 * Pre-Deployment Loadout Overlay scoped strictly inside the 3D simulation viewport (`absolute inset-0 z-30`)
 * so the navigation bar, left parameter controls, primary chassis panel, and right combat log remain
 * interactive around the viewport prior to Wave 01 deployment.
 *
 * How weapon selection & visibility work:
 * - Filters live `weapons` state into `PRIMARY` (Slot [1]) and `SECONDARY` (Slot [2]) arrays, so any
 *   damage, pellet, RPM, or combo edits made in `ArmoryScreen` are immediately reflected on the cards.
 * - Uses a compact `grid-cols-3` card matrix with dense vertical spacing (`px-1.5 py-1`, scaled preview)
 *   so every weapon in both slots fits cleanly inside the viewport height without overlapping or forcing
 *   the player to scroll down to reach lower weapons (an earlier loose `grid-cols-2` / tall card layout
 *   pushed lower primary weapons below the fold).
 *
 * Why a viewport-scoped overlay instead of a fullscreen blocking modal:
 * - Blocking the entire window would prevent users from adjusting enemy squad composition, wave counts,
 *   or engagement distance in the side panels before pressing `Start Wave 01`.
 */
import React from 'react';
import { Crosshair, Play, Shield, Sword } from 'lucide-react';
import { ROOM_LAYOUTS } from '../data/arsenal';
import { SimulationConfig, WeaponProfile, WeaponSlot } from '../types/ballistics';
import { WeaponViewmodelSvg } from './WeaponViewmodelSvg';

interface StartScreenProps {
  /** Active simulation config holding `primaryWeaponId`, `secondaryWeaponId`, and `roomId`. */
  config: SimulationConfig;
  /** Live weapon array; updated instantaneously when stats are tuned in `ArmoryScreen`. */
  weapons: WeaponProfile[];
  /** Computed Wave 01 enemy headcount shown in the deployment badge. */
  waveGroupSize: number;
  /** Updates the chosen weapon for `PRIMARY` or `SECONDARY` and restores its tracked ammo/magazine state. */
  onSelectSlotWeapon: (slot: WeaponSlot, weaponId: string) => void;
  /** Dismisses the staging overlay, enters Wave 01, and triggers the initial hostile spawn sequence. */
  onStartWave: () => void;
}

/**
 * Compact pre-wave weapon selector displaying all Primary and Secondary options simultaneously.
 */
export const StartScreen: React.FC<StartScreenProps> = ({
  config,
  weapons,
  waveGroupSize,
  onSelectSlotWeapon,
  onStartWave,
}) => {
  const primaryWeapons = weapons.filter((w) => w.slot === 'PRIMARY');
  const secondaryWeapons = weapons.filter((w) => w.slot === 'SECONDARY');

  const selectedPrimary =
    primaryWeapons.find((w) => w.id === config.primaryWeaponId) ?? primaryWeapons[0];
  const selectedSecondary =
    secondaryWeapons.find((w) => w.id === config.secondaryWeaponId) ?? secondaryWeapons[0];
  const activeRoom = ROOM_LAYOUTS.find((r) => r.id === config.roomId) ?? ROOM_LAYOUTS[0];

  return (
    <div className="absolute inset-0 z-30 bg-[#0a0d12]/94 overflow-y-auto flex flex-col justify-between p-3 sm:p-4">
      {/* Compact Viewport-Blended Loadout Header */}
      <div className="bg-[#121721] border border-[#1e2638] px-3 py-2 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="font-mono text-[9px] uppercase tracking-[0.12em] text-[#ffb300]">
            Pre-Deployment Loadout // Wave 01 Staging
          </div>
          <h1 className="font-display text-sm sm:text-base font-bold uppercase tracking-[0.04em] text-[#e1e2ea] truncate">
            Select Primary &amp; Secondary Weapons
          </h1>
        </div>

        <div className="bg-[#0f141d] border border-[#232d42] px-2.5 py-1 text-right font-mono">
          <div className="text-[9px] text-[#8c9bb5] uppercase">Deployment Arena</div>
          <div className="text-[10px] text-[#00f0ff] font-semibold">
            {activeRoom.code} · {waveGroupSize} Hostiles
          </div>
        </div>
      </div>

      {/* Two-Column Slot Selector Fitted Without Inner Scrolling */}
      <div className="my-2 grid grid-cols-1 md:grid-cols-2 gap-2.5 flex-1 min-h-0">
        {/* Primary Slot [1] */}
        <section className="bg-[#121721]/90 border border-[#1e2638] p-2 flex flex-col gap-1.5">
          <div className="flex items-center justify-between border-b border-[#1e2638] pb-1">
            <div className="flex items-center gap-1.5">
              <Sword size={12} className="text-[#ffb300]" />
              <h2 className="font-display text-[11px] font-bold uppercase tracking-[0.06em] text-[#e1e2ea]">
                Slot [1] · Primary ({primaryWeapons.length})
              </h2>
            </div>
            <span className="font-mono text-[9px] text-[#ffb300] truncate max-w-[150px]">
              {selectedPrimary.code} · {selectedPrimary.name}
            </span>
          </div>

          <div className="bg-[#0a0d12] bg-tactical-grid border border-[#1e2638] px-2 py-1 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="font-mono text-[9px] text-[#00f0ff] uppercase truncate">
                {selectedPrimary.role}
              </div>
              <div className="font-mono text-[9px] text-[#8c9bb5] tabular-nums truncate">
                {selectedPrimary.weaponClass === 'MELEE' && selectedPrimary.melee
                  ? `${selectedPrimary.melee.comboSteps.map((s) => s.damage).join('/')} DMG · ${selectedPrimary.critMultiplier}x CRIT`
                  : `${selectedPrimary.pellets > 1 ? `${selectedPrimary.baseDamage}x${selectedPrimary.pellets}` : selectedPrimary.baseDamage} DMG · ${selectedPrimary.critMultiplier}x CRIT · ${selectedPrimary.rpm} RPM`}
              </div>
            </div>
            <div className="shrink-0 w-20 h-9 overflow-hidden flex items-center justify-end">
              <div className="scale-[0.62] origin-right">
                <WeaponViewmodelSvg weaponId={selectedPrimary.id} isFiring={false} />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-1">
            {primaryWeapons.map((w) => {
              const isSelected = w.id === selectedPrimary.id;
              const dmgText =
                w.weaponClass === 'MELEE' && w.melee
                  ? `${w.melee.comboSteps.map((s) => s.damage).join('/')} MEL`
                  : w.pellets > 1
                    ? `${w.baseDamage}x${w.pellets}`
                    : `${w.baseDamage} DMG`;
              return (
                <button
                  key={w.id}
                  type="button"
                  onClick={() => onSelectSlotWeapon('PRIMARY', w.id)}
                  className={`px-1.5 py-1 border text-left transition-colors cursor-pointer space-y-0.5 ${
                    isSelected
                      ? 'bg-[#1b2332] border-[#ffb300]'
                      : 'bg-[#0f141d] border-[#232d42] hover:border-[#3b4b6b]'
                  }`}
                >
                  <div className="flex items-center justify-between font-mono text-[8px] leading-tight">
                    <span className="text-[#ffb300] font-semibold truncate">{w.code}</span>
                    <span className="text-[#00f0ff] tabular-nums">{w.critMultiplier}x</span>
                  </div>
                  <div className="font-display text-[10px] font-bold text-[#e1e2ea] truncate leading-tight">
                    {w.name}
                  </div>
                  <div className="font-mono text-[8px] text-[#8c9bb5] tabular-nums truncate leading-tight">
                    {dmgText}
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        {/* Secondary Slot [2] */}
        <section className="bg-[#121721]/90 border border-[#1e2638] p-2 flex flex-col gap-1.5">
          <div className="flex items-center justify-between border-b border-[#1e2638] pb-1">
            <div className="flex items-center gap-1.5">
              <Crosshair size={12} className="text-[#00f0ff]" />
              <h2 className="font-display text-[11px] font-bold uppercase tracking-[0.06em] text-[#e1e2ea]">
                Slot [2] · Secondary ({secondaryWeapons.length})
              </h2>
            </div>
            <span className="font-mono text-[9px] text-[#00f0ff] truncate max-w-[150px]">
              {selectedSecondary.code} · {selectedSecondary.name}
            </span>
          </div>

          <div className="bg-[#0a0d12] bg-tactical-grid border border-[#1e2638] px-2 py-1 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="font-mono text-[9px] text-[#ffb300] uppercase truncate">
                {selectedSecondary.targetSpecialty ?? selectedSecondary.role}
              </div>
              <div className="font-mono text-[9px] text-[#8c9bb5] tabular-nums truncate">
                {selectedSecondary.pellets > 1
                  ? `${selectedSecondary.baseDamage}x${selectedSecondary.pellets}`
                  : selectedSecondary.baseDamage}{' '}
                DMG · {selectedSecondary.critMultiplier}x CRIT · {selectedSecondary.rpm} RPM
              </div>
            </div>
            <div className="shrink-0 w-20 h-9 overflow-hidden flex items-center justify-end">
              <div className="scale-[0.62] origin-right">
                <WeaponViewmodelSvg weaponId={selectedSecondary.id} isFiring={false} />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-1.5">
            {secondaryWeapons.map((w) => {
              const isSelected = w.id === selectedSecondary.id;
              const dmgText =
                w.pellets > 1 ? `${w.baseDamage}x${w.pellets} DMG` : `${w.baseDamage} DMG`;
              return (
                <button
                  key={w.id}
                  type="button"
                  onClick={() => onSelectSlotWeapon('SECONDARY', w.id)}
                  className={`p-1.5 border text-left transition-colors cursor-pointer space-y-0.5 ${
                    isSelected
                      ? 'bg-[#1b2332] border-[#00f0ff]'
                      : 'bg-[#0f141d] border-[#232d42] hover:border-[#3b4b6b]'
                  }`}
                >
                  <div className="flex items-center justify-between font-mono text-[8px] leading-tight">
                    <span className="text-[#00f0ff] font-semibold truncate">{w.code}</span>
                    <span className="text-[#ffb300] tabular-nums">{w.critMultiplier}x</span>
                  </div>
                  <div className="font-display text-[10px] font-bold text-[#e1e2ea] truncate leading-tight">
                    {w.name}
                  </div>
                  <div className="font-mono text-[8px] text-[#8c9bb5] tabular-nums truncate leading-tight">
                    {dmgText} · {w.rpm} RPM
                  </div>
                </button>
              );
            })}
          </div>

          <div className="mt-auto bg-[#0a0d12]/80 border border-[#1e2638] p-2 font-mono text-[9px] text-[#8c9bb5] space-y-0.5">
            <div className="text-[#20df78] font-semibold uppercase">Field Briefing</div>
            <div>
              Hostiles deploy shields, rifles, cannons, swords, halberds, ATGMs &amp; rocket pods. Target torso reactors, batteries, lenses, or limb capacitors behind breakable corridor cover.
            </div>
          </div>
        </section>
      </div>

      {/* Footer Deployment Action */}
      <div className="bg-[#121721] border border-[#1e2638] px-3 py-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-mono text-[9px] text-[#8c9bb5]">
          <Shield size={11} className="text-[#20df78] shrink-0" />
          <span>[1/2/Wheel] Slots · [3–9] Ordnance · [E] Inv/Pickup · [MMB] Use/Throw · [Ctrl Hold] Cursor · [F11] Full · [Esc] Pause</span>
        </div>

        <button
          type="button"
          onClick={onStartWave}
          className="chamfer-sm px-4 py-1.5 bg-[#ffb300] hover:bg-[#00f0ff] text-[#0a0d12] font-mono text-[11px] font-bold uppercase tracking-[0.1em] flex items-center gap-1.5 transition-colors cursor-pointer shadow-[0_0_16px_rgba(255,179,0,0.3)]"
        >
          <Play size={13} fill="currentColor" />
          <span>Start Wave 01</span>
        </button>
      </div>
    </div>
  );
};
