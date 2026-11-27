/**
 * @file TargetsScreen.tsx
 * Threat Profiles & Stagger Calibration screen permitting live tuning of every
 * hostile chassis (HP, stagger threshold/duration/multiplier, hit-zone multipliers, speed,
 * physical XZ/Y scale, and melee/claw damage & cadence).
 *
 * How live target stat mutation and TTK calculation work:
 * - Every `StatNumberField` invokes `onUpdateTarget(target.id, patch)`, which updates the `targets`
 *   state array in `App.tsx`. `SimulationCanvas3D` reads `propsRef.current.targets` on subsequent spawns,
 *   hits, and movement ticks—meaning HP, speed, scale, and zone multipliers update cleanly without
 *   restarting the app.
 * - The right-hand Time-To-Kill Matrix runs `computeTheoreticalTelemetry` across all weapons for both
 *   `weakspot` and `torso` aim zones at `config.distanceM`, updating reactively on every keystroke.
 *
 * Why clamped inline `StatNumberField` + wireframe SVGs over deferred "Apply" forms or 3D previews:
 * - Deferred forms hide immediate TTK matrix feedback while iterating balance numbers; immediate
 *   clamped updates (`Math.max(min, Math.min(max, parsed))`) prevent NaN/zero division while giving
 *   instant table recalculation.
 * - Inline SVG wireframes highlight weakspot vs armor geometry with zero extra WebGL context overhead.
 */
import React, { useState } from 'react';
import { computeTheoreticalTelemetry } from '../engine/ballistics';
import { SimulationConfig, TargetProfile, WeaponProfile } from '../types/ballistics';

interface TargetsScreenProps {
  /** Active simulation config (provides current `targetId` and `distanceM` for TTK matrix evaluation). */
  config: SimulationConfig;
  /** Mutable array of all 7 hostile chassis profiles. */
  targets: TargetProfile[];
  /** Mutable array of all weapons evaluated in the per-chassis TTK comparison table. */
  weapons: WeaponProfile[];
  /** Merges a partial stat patch into the specified chassis inside `App.tsx`. */
  onUpdateTarget: (targetId: string, patch: Partial<TargetProfile>) => void;
  /** Restores all chassis stats to factory defaults from `TARGETS`. */
  onResetTargets: () => void;
  /** Sets the edited chassis as the active range target and switches back to the 3D Range tab. */
  onSelectTargetAndOpenRange: (targetId: string) => void;
}

interface StatInputProps {
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
 * Clamped numeric stat cell ignoring transient `NaN` intermediate typing states (e.g. empty input).
 */
const StatNumberField: React.FC<StatInputProps> = ({
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
 * Chassis intelligence editor and live Weakspot vs Armor TTK calculator across the entire arsenal.
 */
export const TargetsScreen: React.FC<TargetsScreenProps> = ({
  config,
  targets,
  weapons,
  onUpdateTarget,
  onResetTargets,
  onSelectTargetAndOpenRange,
}) => {
  const [selectedId, setSelectedId] = useState<string>(config.targetId);
  const target: TargetProfile =
    targets.find((t) => t.id === selectedId) ?? targets[0];

  /** Renders the silhouette schematic with weakspot, armor plating, and internal component location pins. */
  const renderSchematicSvg = (t: TargetProfile) => {
    const isDrone = t.silhouette === 'drone';
    const isBrute = t.silhouette === 'brute';
    const torsoCy = isDrone ? 105 : t.silhouette === 'swarmer' ? 114 : t.silhouette === 'mech' ? 98 : 98;
    const headCy = isDrone ? 98 : t.silhouette === 'mech' ? 84 : t.silhouette === 'titan' ? 44 : t.silhouette === 'swarmer' ? 82 : 46;

    return (
      <div className="space-y-2">
        <svg viewBox="0 0 220 220" className="w-48 h-48 mx-auto" aria-hidden="true">
          <line x1="110" y1="12" x2="110" y2="208" stroke="#1e2638" strokeDasharray="3 3" />
          <line x1="20" y1="110" x2="200" y2="110" stroke="#1e2638" strokeDasharray="3 3" />

          {t.silhouette === 'exo' && (
            <g>
              <rect x="64" y="68" width="16" height="58" fill="none" stroke="#8c9bb5" strokeWidth="1.5" />
              <rect x="140" y="68" width="16" height="58" fill="none" stroke="#8c9bb5" strokeWidth="1.5" />
              <rect x="84" y="130" width="20" height="68" fill="none" stroke="#8c9bb5" strokeWidth="1.5" />
              <rect x="116" y="130" width="20" height="68" fill="none" stroke="#8c9bb5" strokeWidth="1.5" />
              <polygon
                points="82,66 138,66 132,126 88,126"
                fill="rgba(0,240,255,0.08)"
                stroke="#00f0ff"
                strokeWidth="1.8"
              />
              <rect
                x="94"
                y="32"
                width="32"
                height="28"
                fill="rgba(255,42,75,0.2)"
                stroke="#ff2a4b"
                strokeWidth="2"
              />
            </g>
          )}

          {t.silhouette === 'mech' && (
            <g>
              <polyline points="86,120 62,158 76,198" fill="none" stroke="#8c9bb5" strokeWidth="1.8" />
              <polyline points="134,120 158,158 144,198" fill="none" stroke="#8c9bb5" strokeWidth="1.8" />
              <rect x="44" y="64" width="14" height="44" fill="none" stroke="#8c9bb5" strokeWidth="1.4" />
              <rect x="162" y="64" width="14" height="44" fill="none" stroke="#8c9bb5" strokeWidth="1.4" />
              <polygon
                points="66,46 154,46 164,96 140,118 80,118 56,96"
                fill="rgba(0,240,255,0.08)"
                stroke="#00f0ff"
                strokeWidth="1.8"
              />
              <circle
                cx="110"
                cy="84"
                r="18"
                fill="rgba(255,42,75,0.22)"
                stroke="#ff2a4b"
                strokeWidth="2"
              />
            </g>
          )}

          {t.silhouette === 'titan' && (
            <g>
              <rect x="44" y="76" width="22" height="96" fill="none" stroke="#8c9bb5" strokeWidth="1.6" />
              <rect x="154" y="76" width="22" height="96" fill="none" stroke="#8c9bb5" strokeWidth="1.6" />
              <rect x="74" y="140" width="26" height="54" fill="none" stroke="#8c9bb5" strokeWidth="1.6" />
              <rect x="120" y="140" width="26" height="54" fill="none" stroke="#8c9bb5" strokeWidth="1.6" />
              <polygon
                points="68,64 152,64 142,138 78,138"
                fill="rgba(0,240,255,0.08)"
                stroke="#00f0ff"
                strokeWidth="1.8"
              />
              <ellipse
                cx="110"
                cy="44"
                rx="26"
                ry="16"
                fill="rgba(255,42,75,0.22)"
                stroke="#ff2a4b"
                strokeWidth="2"
              />
            </g>
          )}

          {t.silhouette === 'drone' && (
            <g>
              <polygon
                points="70,84 110,64 150,84 142,126 78,126"
                fill="rgba(0,240,255,0.08)"
                stroke="#00f0ff"
                strokeWidth="1.8"
              />
              {/* Dorsal Shoulder ATGM Pod */}
              <rect
                x="132"
                y="46"
                width="30"
                height="20"
                fill="rgba(168,85,247,0.22)"
                stroke="#a855f7"
                strokeWidth="1.8"
              />
              <circle cx="141" cy="56" r="3" fill="#ff3b5c" />
              <circle cx="153" cy="56" r="3" fill="#ff3b5c" />
              <line x1="148" y1="66" x2="178" y2="38" stroke="#a855f7" strokeWidth="1" strokeDasharray="2 2" />
              <text x="179" y="36" fill="#c084fc" fontSize="8" fontFamily="monospace">ATGM</text>
              <circle
                cx="110"
                cy="98"
                r="16"
                fill="rgba(255,42,75,0.25)"
                stroke="#ff2a4b"
                strokeWidth="2"
              />
            </g>
          )}

          {t.silhouette === 'tank' && (
            <g>
              <rect x="38" y="72" width="26" height="92" fill="none" stroke="#8c9bb5" strokeWidth="2" />
              <rect x="156" y="72" width="26" height="92" fill="none" stroke="#8c9bb5" strokeWidth="2" />
              <rect x="72" y="138" width="28" height="58" fill="none" stroke="#8c9bb5" strokeWidth="2" />
              <rect x="120" y="138" width="28" height="58" fill="none" stroke="#8c9bb5" strokeWidth="2" />
              <polygon
                points="58,58 162,58 152,136 68,136"
                fill="rgba(0,240,255,0.12)"
                stroke="#00f0ff"
                strokeWidth="2.2"
              />
              <rect
                x="92"
                y="32"
                width="36"
                height="24"
                fill="rgba(255,42,75,0.24)"
                stroke="#ff2a4b"
                strokeWidth="2"
              />
            </g>
          )}

          {t.silhouette === 'swarmer' && (
            <g>
              <polyline points="86,126 56,158 68,186" fill="none" stroke="#20df78" strokeWidth="1.6" />
              <polyline points="134,126 164,158 152,186" fill="none" stroke="#20df78" strokeWidth="1.6" />
              <polyline points="78,108 42,118 32,146" fill="none" stroke="#20df78" strokeWidth="1.4" />
              <polyline points="142,108 178,118 188,146" fill="none" stroke="#20df78" strokeWidth="1.4" />
              <polygon
                points="84,96 136,96 124,132 96,132"
                fill="rgba(32,223,120,0.12)"
                stroke="#00f0ff"
                strokeWidth="1.8"
              />
              <circle
                cx="110"
                cy="82"
                r="14"
                fill="rgba(255,42,75,0.25)"
                stroke="#ff2a4b"
                strokeWidth="2"
              />
            </g>
          )}

          {t.silhouette === 'brute' && (
            <g>
              {/* Twin Shoulder Rocket Pods */}
              <rect
                x="44"
                y="46"
                width="24"
                height="20"
                fill="rgba(168,85,247,0.22)"
                stroke="#a855f7"
                strokeWidth="1.8"
              />
              <rect
                x="152"
                y="46"
                width="24"
                height="20"
                fill="rgba(168,85,247,0.22)"
                stroke="#a855f7"
                strokeWidth="1.8"
              />
              <line x1="44" y1="52" x2="18" y2="38" stroke="#a855f7" strokeWidth="1" strokeDasharray="2 2" />
              <text x="6" y="34" fill="#c084fc" fontSize="8" fontFamily="monospace">PODS</text>

              <polyline points="68,78 44,124 58,166" fill="none" stroke="#ffb300" strokeWidth="2" />
              <polyline points="152,78 176,124 162,166" fill="none" stroke="#ffb300" strokeWidth="2" />
              <rect x="78" y="138" width="22" height="58" fill="none" stroke="#8c9bb5" strokeWidth="1.8" />
              <rect x="120" y="138" width="22" height="58" fill="none" stroke="#8c9bb5" strokeWidth="1.8" />
              <polygon
                points="70,66 150,66 138,136 82,136"
                fill="rgba(255,179,0,0.12)"
                stroke="#ffb300"
                strokeWidth="2"
              />
              <polygon
                points="90,34 130,34 122,62 98,62"
                fill="rgba(255,42,75,0.25)"
                stroke="#ff2a4b"
                strokeWidth="2"
              />
            </g>
          )}

          {/* Internal Component Location Pins Overlay */}
          {/* 1. Cranial / Viewing Lens & Head Core */}
          <circle cx="110" cy={headCy} r="4.2" fill="#ff2a4b" stroke="#0a0d12" strokeWidth="1.2" />
          <line x1="114" y1={headCy} x2="178" y2="20" stroke="#ff2a4b" strokeWidth="0.9" strokeDasharray="2 2" />
          <text x="150" y="17" fill="#ff6b81" fontSize="7.5" fontFamily="monospace">LENS/HEAD</text>

          {/* 2. Torso Center Power Supply & Battery */}
          <circle
            cx="110"
            cy={torsoCy}
            r="7.5"
            fill="rgba(255,179,0,0.28)"
            stroke="#ffb300"
            strokeWidth="1.4"
          />
          <circle cx="104" cy={torsoCy + 9} r="3.6" fill="#00f0ff" stroke="#0a0d12" strokeWidth="1" />
          <line x1="103" y1={torsoCy} x2="36" y2="92" stroke="#ffb300" strokeWidth="0.9" strokeDasharray="2 2" />
          <text x="4" y="88" fill="#ffb300" fontSize="7.5" fontFamily="monospace">PWR</text>
          <line x1="101" y1={torsoCy + 10} x2="34" y2="115" stroke="#00f0ff" strokeWidth="0.9" strokeDasharray="2 2" />
          <text x="4" y="118" fill="#00f0ff" fontSize="7.5" fontFamily="monospace">BAT/MECH</text>

          {/* 3. Limb Capacitors & Destructible Arms / Legs (ground chassis only) */}
          {!isDrone && (
            <g>
              <circle cx="56" cy="96" r="3.2" fill="#20df78" stroke="#0a0d12" strokeWidth="1" />
              <circle cx="164" cy="96" r="3.2" fill="#20df78" stroke="#0a0d12" strokeWidth="1" />
              <line x1="167" y1="96" x2="188" y2="96" stroke="#20df78" strokeWidth="0.9" strokeDasharray="2 2" />
              <text x="172" y="90" fill="#20df78" fontSize="7.5" fontFamily="monospace">ARM CAP</text>

              <circle cx="92" cy="164" r="3.2" fill="#20df78" stroke="#0a0d12" strokeWidth="1" />
              <circle cx="128" cy="164" r="3.2" fill="#20df78" stroke="#0a0d12" strokeWidth="1" />
              <line x1="131" y1="166" x2="184" y2="176" stroke="#20df78" strokeWidth="0.9" strokeDasharray="2 2" />
              <text x="166" y="186" fill="#20df78" fontSize="7.5" fontFamily="monospace">LEG CAP</text>
            </g>
          )}
        </svg>

        {/* Schematic Legend Strip */}
        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-2 font-mono text-[10px] text-[#8c9bb5]">
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 bg-[#ffb300] rounded-full" /> Power Supply (Center Torso)
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 bg-[#00f0ff] rounded-full" /> Battery / Mech
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 bg-[#ff2a4b] rounded-full" /> Head / Viewing Lens
          </span>
          {!isDrone && (
            <span className="flex items-center gap-1">
              <span className="inline-block w-2 h-2 bg-[#20df78] rounded-full" /> Limb Capacitors
            </span>
          )}
          {(isDrone || isBrute) && (
            <span className="flex items-center gap-1">
              <span className="inline-block w-2 h-2 bg-[#a855f7] rounded-full" />{' '}
              {isDrone ? 'ATGM Pod' : 'Rocket Pods'}
            </span>
          )}
        </div>
      </div>
    );
  };

  const powerSupplyHpCalc = Math.max(
    1,
    Math.round((target.defaultHp * 0.125) / Math.max(0.05, target.torsoMultiplier))
  );
  const limbHpCalc = Math.max(1, Math.round(target.defaultHp * 0.2));
  const headHpCalc = Math.max(
    1,
    Math.min(
      Math.round(target.defaultHp * 0.75),
      Math.round((target.defaultHp * 0.25) / Math.max(0.05, target.torsoMultiplier))
    )
  );

  return (
    <div className="max-w-[1440px] mx-auto p-4 lg:p-6 space-y-6">
      <div className="bg-[#121721] border border-[#1e2638] p-4 sm:p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="font-mono text-[11px] uppercase tracking-[0.1em] text-[#ff2a4b]">
            Hostile Chassis Intelligence · Live Parameter Editor
          </div>
          <h1 className="mt-1 font-display text-2xl font-bold tracking-[0.04em] uppercase text-[#e1e2ea]">
            Threat Profiles & Stagger Calibration
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={onResetTargets}
            className="px-3.5 py-2.5 border border-[#2a364f] text-[#8c9bb5] font-mono text-xs uppercase tracking-[0.08em] hover:border-[#ffb300] hover:text-[#ffb300] transition-colors cursor-pointer"
          >
            Reset Target Defaults
          </button>
          <button
            type="button"
            onClick={() => onSelectTargetAndOpenRange(target.id)}
            className="chamfer-sm px-4 py-2.5 bg-[#ffb300] text-[#0a0d12] font-mono text-xs font-bold tracking-[0.08em] uppercase hover:bg-[#00f0ff] transition-all cursor-pointer"
          >
            Deploy {target.code} To Range
          </button>
        </div>
      </div>

      {/* Hostile Target Selector Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {targets.map((t) => {
          const active = t.id === target.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setSelectedId(t.id)}
              className={`chamfer-md text-left p-4 border transition-colors cursor-pointer ${
                active
                  ? 'bg-[#1b2332] border-[#ffb300]'
                  : 'bg-[#121721] border-[#1e2638] hover:border-[#364463]'
              }`}
            >
              <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.08em]">
                <span className="text-[#ffb300]">{t.code}</span>
                <span className="text-[#ff2a4b]">{t.threatRating}</span>
              </div>
              <div className="mt-1 font-display text-base font-semibold text-[#e1e2ea]">
                {t.name}
              </div>
              <div className="mt-0.5 text-xs text-[#8c9bb5]">{t.classification}</div>
              <div className="mt-3 pt-2.5 border-t border-[#1e2638] flex items-center justify-between font-mono text-[11px] tabular-nums text-[#8c9bb5]">
                <span>HP {t.defaultHp}</span>
                <span>STAG {t.staggerThreshold}</span>
                <span>SPD {t.moveSpeedMps.toFixed(1)}m/s</span>
              </div>
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Left: Wireframe + Internal Component Locations + Editable Characteristic Matrix */}
        <div className="lg:col-span-5 bg-[#121721] border border-[#1e2638] p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-[#1e2638] pb-3">
            <h2 className="font-display text-sm font-semibold uppercase tracking-[0.06em] text-[#e1e2ea]">
              Chassis & Internal Component Map
            </h2>
            <span className="font-mono text-[11px] text-[#00f0ff]">{target.code}</span>
          </div>

          <div className="bg-[#0a0d12] bg-tactical-grid border border-[#1e2638] py-3">
            {renderSchematicSvg(target)}
          </div>

          {/* Internal Component Locations Breakdown */}
          <div className="bg-[#0f141d] border border-[#232d42] p-3.5 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[#00f0ff]">
                Internal Component Locations & Sub-System Specs
              </span>
              <span className="font-mono text-[10px] text-[#8c9bb5]">
                Armor {target.torsoMultiplier.toFixed(2)}x
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 font-mono text-[11px]">
              <div className="bg-[#121721] border border-[#1e2638] p-2">
                <div className="flex items-center justify-between text-[#ffb300] font-bold">
                  <span>Power Supply</span>
                  <span>{powerSupplyHpCalc} HP</span>
                </div>
                <div className="text-[10px] text-[#8c9bb5] mt-0.5">
                  Loc: Center Torso (12.5% HP / Armor). Rupture explodes mech &amp; splashes nearby units.
                </div>
              </div>
              <div className="bg-[#121721] border border-[#1e2638] p-2">
                <div className="flex items-center justify-between text-[#00f0ff] font-bold">
                  <span>Reserve Battery</span>
                  <span>{Math.max(24, Math.round(target.defaultHp * 0.22))} HP</span>
                </div>
                <div className="text-[10px] text-[#8c9bb5] mt-0.5">
                  Loc: Center Torso Core. Drains limb/head capacitors when damaged; explodes at 0 HP.
                </div>
              </div>
              <div className="bg-[#121721] border border-[#1e2638] p-2">
                <div className="flex items-center justify-between text-[#ff2a4b] font-bold">
                  <span>Head / Viewing Lens</span>
                  <span>{headHpCalc} HP</span>
                </div>
                <div className="text-[10px] text-[#8c9bb5] mt-0.5">
                  Loc: {target.silhouette === 'drone' ? 'Forward Faceplate' : target.silhouette === 'mech' ? 'Torso Eye / Cowl' : 'Cranial Turret'} (25% HP / Armor, max 75% HP). Explodes only when Head HP hits 0.
                </div>
              </div>
              <div className="bg-[#121721] border border-[#1e2638] p-2">
                <div className="flex items-center justify-between text-[#20df78] font-bold">
                  <span>Limb Caps &amp; Arms</span>
                  <span>{limbHpCalc} HP ea</span>
                </div>
                <div className="text-[10px] text-[#8c9bb5] mt-0.5">
                  {target.silhouette === 'drone'
                    ? 'Loc: Chassis Mounts (no arms/legs). Torso capacitor failure cascades to all systems.'
                    : 'Loc: L/R Arms & L/R Legs (20% HP each). Arms detach when destroyed; leg break slows/halts.'}
                </div>
              </div>
              {(target.silhouette === 'drone' || target.silhouette === 'brute') && (
                <div className="sm:col-span-2 bg-[#161224] border border-[#a855f7]/60 p-2">
                  <div className="flex items-center justify-between text-[#c084fc] font-bold">
                    <span>
                      {target.silhouette === 'drone'
                        ? 'Dorsal Shoulder ATGM Launcher'
                        : 'Twin Shoulder Rocket Pods'}
                    </span>
                    <span>
                      {target.silhouette === 'drone' ? '90 HP · 0.6x Armor' : '120 HP · 0.8x Armor'}
                    </span>
                  </div>
                  <div className="text-[10px] text-[#c7bdd9] mt-0.5">
                    Loc: {target.silhouette === 'drone' ? 'Right Dorsal Mount' : 'Left & Right Shoulder Hardpoints'}. Destroying pod triggers blast &amp; fires remaining loaded ordnance wildly.
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <StatNumberField
              label="Primary HP"
              value={target.defaultHp}
              unit="HP"
              min={20}
              max={5000}
              step={10}
              accent="text-[#ff2a4b]"
              onChange={(val) => onUpdateTarget(target.id, { defaultHp: Math.round(val) })}
            />
            <StatNumberField
              label="Stagger Health"
              value={target.staggerThreshold}
              unit="STAG"
              min={10}
              max={2000}
              step={5}
              accent="text-[#00f0ff]"
              onChange={(val) => onUpdateTarget(target.id, { staggerThreshold: Math.round(val) })}
            />
            <StatNumberField
              label="Stagger Time"
              value={target.staggerDurationSec}
              unit="SEC"
              min={0.3}
              max={10}
              step={0.1}
              accent="text-[#00f0ff]"
              onChange={(val) => onUpdateTarget(target.id, { staggerDurationSec: val })}
            />
            <StatNumberField
              label="Stagger Mult"
              value={target.staggerDamageMultiplier}
              unit="x"
              min={1.0}
              max={5.0}
              step={0.05}
              accent="text-[#ffb300]"
              onChange={(val) => onUpdateTarget(target.id, { staggerDamageMultiplier: val })}
            />
            <StatNumberField
              label="Weakspot Mult"
              value={target.weakspotMultiplier}
              unit="x"
              min={0.1}
              max={10}
              step={0.05}
              accent="text-[#ff2a4b]"
              onChange={(val) => onUpdateTarget(target.id, { weakspotMultiplier: val })}
            />
            <StatNumberField
              label="Armor Mult"
              value={target.torsoMultiplier}
              unit="x"
              min={0.05}
              max={5}
              step={0.05}
              accent="text-[#00f0ff]"
              onChange={(val) => onUpdateTarget(target.id, { torsoMultiplier: val })}
            />
            <StatNumberField
              label="Extremity Mult"
              value={target.limbMultiplier}
              unit="x"
              min={0.05}
              max={5}
              step={0.02}
              accent="text-[#e1e2ea]"
              onChange={(val) => onUpdateTarget(target.id, { limbMultiplier: val })}
            />
            <StatNumberField
              label="Mobility"
              value={target.moveSpeedMps}
              unit="M/S"
              min={0.5}
              max={25}
              step={0.1}
              accent="text-[#20df78]"
              onChange={(val) => onUpdateTarget(target.id, { moveSpeedMps: val })}
            />
            <StatNumberField
              label="Claw Damage"
              value={target.clawDamage}
              unit="DMG"
              min={1}
              max={200}
              step={1}
              accent="text-[#ffb300]"
              onChange={(val) => onUpdateTarget(target.id, { clawDamage: Math.round(val) })}
            />
            <StatNumberField
              label="Special Claw"
              value={target.dualClawDamage}
              unit="DMG"
              min={1}
              max={400}
              step={1}
              accent="text-[#ff2a4b]"
              onChange={(val) => onUpdateTarget(target.id, { dualClawDamage: Math.round(val) })}
            />
            <StatNumberField
              label="Attack Rate"
              value={target.attackSpeedMult}
              unit="x"
              min={0.1}
              max={3.0}
              step={0.05}
              onChange={(val) => onUpdateTarget(target.id, { attackSpeedMult: val })}
            />
            <StatNumberField
              label="Special Rate"
              value={target.specialAttackSpeedMult}
              unit="x"
              min={0.1}
              max={3.0}
              step={0.05}
              onChange={(val) => onUpdateTarget(target.id, { specialAttackSpeedMult: val })}
            />
            <StatNumberField
              label="Width Scale"
              value={target.scaleXZ}
              unit="x"
              min={0.5}
              max={2.5}
              step={0.05}
              onChange={(val) => onUpdateTarget(target.id, { scaleXZ: val })}
            />
            <StatNumberField
              label="Height Scale"
              value={target.scaleY}
              unit="x"
              min={0.5}
              max={2.5}
              step={0.05}
              onChange={(val) => onUpdateTarget(target.id, { scaleY: val })}
            />
          </div>
        </div>

        {/* Right: TTK Matrix */}
        <div className="lg:col-span-7 bg-[#121721] border border-[#1e2638] p-5 space-y-4">
          <div className="border-b border-[#1e2638] pb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-display text-sm font-semibold uppercase tracking-[0.06em] text-[#e1e2ea]">
                Time-To-Kill Matrix vs {target.name}
              </h2>
              <p className="mt-0.5 text-xs text-[#8c9bb5]">
                Simulated at {config.distanceM}m · Stagger at {target.staggerThreshold} DMG for{' '}
                {target.staggerDurationSec.toFixed(1)}s ({target.staggerDamageMultiplier.toFixed(2)}x stacked DMG)
              </p>
            </div>
          </div>

          <p className="text-sm text-[#8c9bb5] leading-relaxed">{target.description}</p>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse font-mono text-xs tabular-nums">
              <thead>
                <tr className="border-b border-[#1e2638] text-[10px] uppercase tracking-[0.08em] text-[#8c9bb5]">
                  <th className="py-2.5 pr-3">Weapon</th>
                  <th className="py-2.5 px-3 text-right">Weakspot STK</th>
                  <th className="py-2.5 px-3 text-right">Weakspot TTK</th>
                  <th className="py-2.5 px-3 text-right">Body/Armor STK</th>
                  <th className="py-2.5 pl-3 text-right">Body/Armor TTK</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1e2638]">
                {weapons.map((w) => {
                  const weakStats = computeTheoreticalTelemetry(
                    {
                      ...config,
                      weaponId: w.id,
                      targetId: target.id,
                      targetHp: target.defaultHp,
                      aimZone: 'weakspot',
                    },
                    weapons,
                    targets
                  );
                  const torsoStats = computeTheoreticalTelemetry(
                    {
                      ...config,
                      weaponId: w.id,
                      targetId: target.id,
                      targetHp: target.defaultHp,
                      aimZone: 'torso',
                    },
                    weapons,
                    targets
                  );
                  return (
                    <tr key={w.id} className="hover:bg-[#161c28] transition-colors">
                      <td className="py-3 pr-3">
                        <div className="font-display font-semibold text-[#e1e2ea]">{w.name}</div>
                        <div className="text-[10px] text-[#8c9bb5]">
                          {w.code} · {w.damageType}
                        </div>
                      </td>
                      <td className="py-3 px-3 text-right text-[#ff2a4b] font-semibold">
                        {weakStats.theoreticalStk}
                      </td>
                      <td className="py-3 px-3 text-right text-[#20df78] font-bold">
                        {weakStats.theoreticalTtkMs} ms
                      </td>
                      <td className="py-3 px-3 text-right text-[#00f0ff]">
                        {torsoStats.theoreticalStk}
                      </td>
                      <td className="py-3 pl-3 text-right text-[#ffb300]">
                        {torsoStats.theoreticalTtkMs} ms
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};
