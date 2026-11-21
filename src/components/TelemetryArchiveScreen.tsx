import React, { useState } from 'react';
import { SavedTelemetryRun } from '../types/ballistics';

interface TelemetryArchiveScreenProps {
  runs: SavedTelemetryRun[];
  onDeleteRun: (id: string) => void;
  onClearAll: () => void;
  onOpenRange: () => void;
}

export const TelemetryArchiveScreen: React.FC<TelemetryArchiveScreenProps> = ({
  runs,
  onDeleteRun,
  onClearAll,
  onOpenRange,
}) => {
  const [search, setSearch] = useState('');

  const filtered = runs.filter((r) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      r.weaponName.toLowerCase().includes(q) ||
      r.targetName.toLowerCase().includes(q) ||
      r.weaponCode.toLowerCase().includes(q)
    );
  });

  const maxDps = Math.max(100, ...filtered.map((r) => r.metrics.effectiveDps));

  const handleExportCsv = () => {
    const headers = [
      'RunID',
      'RecordedAt',
      'Weapon',
      'Code',
      'Target',
      'DistanceM',
      'RoundsFired',
      'AccuracyPct',
      'WeakspotEffPct',
      'EffectiveDPS',
      'TTK_ms',
      'TotalHpDmg',
    ];
    const rows = filtered.map((r) => [
      r.id,
      r.recordedAt,
      `"${r.weaponName}"`,
      r.weaponCode,
      `"${r.targetName}"`,
      r.distanceM,
      r.metrics.totalRoundsFired,
      r.metrics.accuracyPct,
      r.metrics.weakspotEfficiencyPct,
      r.metrics.effectiveDps,
      r.metrics.ttkMs ?? r.metrics.theoreticalTtkMs,
      r.metrics.totalHpDamage,
    ]);
    const csv = [headers.join(','), ...rows.map((row) => row.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `aegis_telemetry_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="max-w-[1440px] mx-auto p-4 lg:p-6 space-y-6">
      <div className="bg-[#121721] border border-[#1e2638] p-4 sm:p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="font-mono text-[11px] uppercase tracking-[0.1em] text-[#00f0ff]">
            Combat Blackbox · Recorded Runs
          </div>
          <h1 className="mt-1 font-display text-2xl font-bold tracking-[0.04em] uppercase text-[#e1e2ea]">
            Engagement Telemetry Archive
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter weapon or target..."
            aria-label="Filter recorded telemetry runs"
            className="bg-[#0f141d] border border-[#232d42] focus:border-[#00f0ff] px-3 py-2 font-mono text-xs text-[#e1e2ea] placeholder:text-[#8c9bb5]/60 focus:outline-none w-56"
          />
          <button
            type="button"
            onClick={handleExportCsv}
            disabled={filtered.length === 0}
            className="px-3.5 py-2 border border-[#00f0ff]/60 text-[#00f0ff] font-mono text-xs uppercase tracking-[0.06em] hover:bg-[#00f0ff]/10 disabled:opacity-40 cursor-pointer"
          >
            Export CSV
          </button>
          <button
            type="button"
            onClick={onClearAll}
            disabled={runs.length === 0}
            className="px-3.5 py-2 border border-[#2a364f] text-[#8c9bb5] font-mono text-xs uppercase tracking-[0.06em] hover:border-[#ff2a4b] hover:text-[#ff2a4b] disabled:opacity-40 cursor-pointer"
          >
            Purge Archive
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="bg-[#121721] border border-[#1e2638] p-12 text-center space-y-3">
          <div className="font-mono text-sm uppercase tracking-[0.08em] text-[#8c9bb5]">
            No Telemetry Runs Logged
          </div>
          <p className="text-sm text-[#8c9bb5]/80 max-w-md mx-auto">
            Execute a combat simulation in the Range Console and select Archive Run to inspect comparative DPS and TTK records here.
          </p>
          <button
            type="button"
            onClick={onOpenRange}
            className="chamfer-sm mt-2 px-5 py-2.5 bg-[#ffb300] text-[#0a0d12] font-mono text-xs font-bold uppercase tracking-[0.08em] hover:bg-[#00f0ff] cursor-pointer"
          >
            Return To Range Sim
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          {/* Left: Comparative Effective DPS Bars */}
          <div className="lg:col-span-5 bg-[#121721] border border-[#1e2638] p-5 space-y-4">
            <h2 className="font-display text-sm font-semibold uppercase tracking-[0.06em] text-[#e1e2ea] border-b border-[#1e2638] pb-3">
              Comparative Effective DPS
            </h2>
            <div className="space-y-3.5">
              {filtered.map((run) => {
                const widthPct = Math.min(100, (run.metrics.effectiveDps / maxDps) * 100);
                return (
                  <div key={run.id} className="space-y-1">
                    <div className="flex items-center justify-between font-mono text-[11px] tabular-nums">
                      <span className="text-[#e1e2ea] truncate pr-2">
                        {run.weaponCode} → {run.targetName}
                      </span>
                      <span className="text-[#ffb300] font-bold shrink-0">
                        {run.metrics.effectiveDps} DPS
                      </span>
                    </div>
                    <div className="h-2.5 w-full bg-[#0a0d12] border border-[#1e2638]">
                      <div
                        className="h-full bg-[#ffb300]"
                        style={{ width: `${widthPct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right: Tabular Archive Ledger */}
          <div className="lg:col-span-7 bg-[#121721] border border-[#1e2638] p-5 space-y-4">
            <h2 className="font-display text-sm font-semibold uppercase tracking-[0.06em] text-[#e1e2ea] border-b border-[#1e2638] pb-3">
              Recorded Combat Engagements ({filtered.length})
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse font-mono text-xs tabular-nums">
                <thead>
                  <tr className="border-b border-[#1e2638] text-[10px] uppercase tracking-[0.08em] text-[#8c9bb5]">
                    <th className="py-2.5 pr-3">Platform</th>
                    <th className="py-2.5 px-3">Target</th>
                    <th className="py-2.5 px-2 text-right">Range</th>
                    <th className="py-2.5 px-2 text-right">Acc</th>
                    <th className="py-2.5 px-2 text-right">Crit</th>
                    <th className="py-2.5 px-2 text-right">TTK</th>
                    <th className="py-2.5 pl-2 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1e2638]">
                  {filtered.map((run) => (
                    <tr key={run.id} className="hover:bg-[#161c28] transition-colors">
                      <td className="py-3 pr-3">
                        <div className="text-[#e1e2ea] font-semibold">{run.weaponName}</div>
                        <div className="text-[10px] text-[#00f0ff]">
                          {run.weaponCode} · {run.recordedAt}
                        </div>
                      </td>
                      <td className="py-3 px-3 text-[#8c9bb5]">{run.targetName}</td>
                      <td className="py-3 px-2 text-right text-[#e1e2ea]">{run.distanceM}m</td>
                      <td className="py-3 px-2 text-right text-[#20df78]">
                        {run.metrics.accuracyPct.toFixed(0)}%
                      </td>
                      <td className="py-3 px-2 text-right text-[#ff2a4b]">
                        {run.metrics.weakspotEfficiencyPct.toFixed(0)}%
                      </td>
                      <td className="py-3 px-2 text-right text-[#ffb300] font-semibold">
                        {run.metrics.ttkMs !== null
                          ? `${run.metrics.ttkMs} ms`
                          : `${run.metrics.theoreticalTtkMs} ms*`}
                      </td>
                      <td className="py-3 pl-2 text-right">
                        <button
                          type="button"
                          onClick={() => onDeleteRun(run.id)}
                          className="text-[10px] uppercase text-[#8c9bb5] hover:text-[#ff2a4b] cursor-pointer"
                        >
                          Del
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
