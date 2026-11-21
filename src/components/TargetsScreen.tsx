import React, { useState } from 'react';
import { computeTheoreticalTelemetry } from '../engine/ballistics';
import { SimulationConfig, TargetProfile, WeaponProfile } from '../types/ballistics';

interface TargetsScreenProps {
  config: SimulationConfig;
  targets: TargetProfile[];
  weapons: WeaponProfile[];
  onUpdateTarget: (targetId: string, patch: Partial<TargetProfile>) => void;
  onResetTargets: () => void;
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

  const renderSchematicSvg = (t: TargetProfile) => {
    return (
      <svg viewBox="0 0 220 220" className="w-44 h-44 mx-auto" aria-hidden="true">
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
            <rect x="38" y="74" width="26" height="52" fill="none" stroke="#8c9bb5" strokeWidth="1.6" />
            <rect x="156" y="74" width="26" height="52" fill="none" stroke="#8c9bb5" strokeWidth="1.6" />
            <polygon
              points="70,84 110,64 150,84 142,126 78,126"
              fill="rgba(0,240,255,0.08)"
              stroke="#00f0ff"
              strokeWidth="1.8"
            />
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
      </svg>
    );
  };

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

      {/* 4 Target Selector Cards */}
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
        {/* Left: Wireframe + Editable Characteristic Matrix */}
        <div className="lg:col-span-5 bg-[#121721] border border-[#1e2638] p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-[#1e2638] pb-3">
            <h2 className="font-display text-sm font-semibold uppercase tracking-[0.06em] text-[#e1e2ea]">
              Chassis & Stagger Parameters
            </h2>
            <span className="font-mono text-[11px] text-[#00f0ff]">{target.code}</span>
          </div>

          <div className="bg-[#0a0d12] bg-tactical-grid border border-[#1e2638] py-3">
            {renderSchematicSvg(target)}
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
