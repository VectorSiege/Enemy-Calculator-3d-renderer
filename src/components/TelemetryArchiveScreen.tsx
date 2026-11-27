/**
 * @file TelemetryArchiveScreen.tsx
 * Combat Telemetry Archive screen displaying:
 * 1. Encountered enemy dossier + 2D anatomical thermal hit & `<= 0.1m` near-miss heatmap,
 *    with Shots-Taken-To-Kill (`STK`) hover tooltips breaking down weakspot, armor, extremity, and near-miss shots.
 * 2. All-weapons live combat performance table (total hits, weakspot/armor/extremity distribution,
 *    accuracy %, user effective DPS, and average Time-To-Kill per enemy chassis).
 * 3. Saved Combat Blackbox engagement runs with comparative DPS bars and RFC-style CSV export.
 *
 * How the telemetry visualizations work & why Canvas 2D + normalized coordinates beats alternatives:
 * - Hits recorded in 3D world space by `SimulationCanvas3D` are normalized relative to the enemy's
 *   facing yaw, width, and height (`nx`, `ny`), so rotating or scaling enemies of the same chassis map onto
 *   one unified anatomical silhouette (`normToCanvas`). Storing raw world XYZ coordinates instead would fail
 *   whenever an enemy turns or moves across the corridor.
 * - `EnemyBodyHeatmapCanvas` renders overlapping radial gradients with `globalCompositeOperation = 'lighter'`
 *   onto a single 280x350 `<canvas>`. Rendering hundreds of SVG `<radialGradient>` DOM nodes instead would
 *   bloat SVG `<defs>` and tank scroll performance when inspecting high-pellet shotgun engagements.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  EnemyEncounterRecord,
  SavedTelemetryRun,
  TargetProfile,
  TargetSilhouette,
  WeaponPerformanceRecord,
  WeaponProfile,
} from '../types/ballistics';

interface TelemetryArchiveScreenProps {
  /** Saved Blackbox runs (seeded presets + user-archived engagements). */
  runs: SavedTelemetryRun[];
  /** Full arsenal manifest so even unfired weapons can be inspected or filtered. */
  weapons: WeaponProfile[];
  /** Hostile chassis list used to map per-target kill pills in deterministic order. */
  targets: TargetProfile[];
  /** Per-enemy live encounter dossiers populated from `handleSquadShotResolved` in `App.tsx`. */
  enemyEncounters: EnemyEncounterRecord[];
  /** Per-weapon accumulated shot/hit/damage/TTK metrics populated from `App.tsx`. */
  weaponPerformances: Record<string, WeaponPerformanceRecord>;
  /** Clears live enemy dossiers and weapon performance stats without purging saved archive runs. */
  onClearLiveTelemetry: () => void;
  /** Deletes a single saved Blackbox run by ID. */
  onDeleteRun: (id: string) => void;
  /** Purges all saved Blackbox runs. */
  onClearAll: () => void;
  /** Navigates back to the 3D Range Simulator tab. */
  onOpenRange: () => void;
}

/**
 * Projects normalized enemy-local coordinates (`nx` in `-1.2..1.2`, `ny` in `-0.05..1.15`)
 * into `<canvas>` pixel coordinates while leaving margin for `<= 0.1m` near-miss halos.
 */
function normToCanvas(nx: number, ny: number, w: number, h: number): [number, number] {
  const cx = w * 0.5 + nx * (w * 0.34);
  const cy = h * 0.9 - ny * (h * 0.78);
  return [cx, cy];
}

/**
 * Draws a human-proportioned anatomical chassis silhouette (or hover-drone carapace for `drone`)
 * plus the dashed 0.1m near-miss perimeter box onto the heatmap canvas.
 */
function drawAnatomicalSilhouette(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  silhouette: TargetSilhouette
) {
  const mapPt = (nx: number, ny: number): [number, number] => normToCanvas(nx, ny, w, h);

  const drawRoundedLimb = (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    widthPx: number,
    strokeStyle: string
  ) => {
    const [ax, ay] = mapPt(x1, y1);
    const [bx, by] = mapPt(x2, y2);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineWidth = widthPx;
    ctx.strokeStyle = strokeStyle;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.restore();
  };

  // Faint 0.1m near-miss halo boundary
  ctx.save();
  ctx.strokeStyle = 'rgba(168, 85, 247, 0.25)';
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  const [hx0, hy0] = mapPt(-0.72, 1.03);
  const [hx1, hy1] = mapPt(0.72, -0.03);
  ctx.strokeRect(hx0, hy0, hx1 - hx0, hy1 - hy0);
  ctx.restore();

  if (silhouette === 'drone') {
    // Recon Hover-Drone upper carapace & stabilizer wings
    const [cx, cy] = mapPt(0, 0.76);
    ctx.save();
    ctx.fillStyle = 'rgba(26, 36, 54, 0.75)';
    ctx.strokeStyle = 'rgba(92, 112, 145, 0.6)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(cx, cy, w * 0.2, h * 0.08, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    drawRoundedLimb(-0.48, 0.82, -0.18, 0.77, 8, 'rgba(30, 40, 60, 0.85)');
    drawRoundedLimb(0.48, 0.82, 0.18, 0.77, 8, 'rgba(30, 40, 60, 0.85)');

    // Glowing optical weakspot core
    ctx.fillStyle = 'rgba(255, 42, 75, 0.28)';
    ctx.strokeStyle = 'rgba(255, 42, 75, 0.8)';
    ctx.beginPath();
    ctx.arc(cx, cy, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    return;
  }

  const bulk =
    silhouette === 'titan' || silhouette === 'tank'
      ? 1.18
      : silhouette === 'brute'
        ? 1.08
        : silhouette === 'swarmer'
          ? 0.86
          : 1.0;

  // Thighs, Shins & Feet (Extremities)
  drawRoundedLimb(-0.17, 0.44, -0.19, 0.24, 15 * bulk, 'rgba(30, 42, 62, 0.85)');
  drawRoundedLimb(0.17, 0.44, 0.19, 0.24, 15 * bulk, 'rgba(30, 42, 62, 0.85)');
  drawRoundedLimb(-0.19, 0.24, -0.2, 0.04, 12 * bulk, 'rgba(26, 36, 54, 0.85)');
  drawRoundedLimb(0.19, 0.24, 0.2, 0.04, 12 * bulk, 'rgba(26, 36, 54, 0.85)');
  drawRoundedLimb(-0.2, 0.02, -0.26, 0.01, 9 * bulk, 'rgba(22, 30, 46, 0.9)');
  drawRoundedLimb(0.2, 0.02, 0.26, 0.01, 9 * bulk, 'rgba(22, 30, 46, 0.9)');

  // Shoulders, Upper Arms & Forearms (Extremities)
  drawRoundedLimb(-0.34, 0.76, -0.44, 0.58, 12 * bulk, 'rgba(30, 42, 62, 0.85)');
  drawRoundedLimb(0.34, 0.76, 0.44, 0.58, 12 * bulk, 'rgba(30, 42, 62, 0.85)');
  drawRoundedLimb(-0.44, 0.58, -0.47, 0.4, 10 * bulk, 'rgba(26, 36, 54, 0.85)');
  drawRoundedLimb(0.44, 0.58, 0.47, 0.4, 10 * bulk, 'rgba(26, 36, 54, 0.85)');

  // Pelvis & Abdomen + Upper Chest Armor Core
  ctx.save();
  ctx.fillStyle = 'rgba(28, 38, 56, 0.88)';
  ctx.strokeStyle = 'rgba(92, 112, 145, 0.65)';
  ctx.lineWidth = 1.4;

  const [abL, abT] = mapPt(-0.21 * bulk, 0.61);
  const [abR, abB] = mapPt(0.21 * bulk, 0.43);
  ctx.fillRect(abL, abT, abR - abL, abB - abT);
  ctx.strokeRect(abL, abT, abR - abL, abB - abT);

  const [chL, chT] = mapPt(-0.33 * bulk, 0.81);
  const [chR, chB] = mapPt(0.33 * bulk, 0.61);
  ctx.fillRect(chL, chT, chR - chL, chB - chT);
  ctx.strokeRect(chL, chT, chR - chL, chB - chT);

  // Shoulders pauldrons
  const [shL, shT] = mapPt(-0.39 * bulk, 0.82);
  const [shW] = mapPt(-0.25 * bulk, 0.82);
  ctx.fillRect(shL, shT, (shW - shL) * 1.15, 16);
  const [shR] = mapPt(0.25 * bulk, 0.82);
  ctx.fillRect(shR, shT, (shW - shL) * 1.15, 16);

  // Head / Weakspot Crown
  const [headX, headY] = mapPt(0, 0.91);
  ctx.fillStyle = 'rgba(255, 42, 75, 0.16)';
  ctx.strokeStyle = 'rgba(255, 42, 75, 0.78)';
  ctx.beginPath();
  ctx.arc(headX, headY, 16 * Math.min(1.12, bulk), 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/**
 * Canvas component layering the chassis silhouette, additive thermal radial clusters,
 * and crisp impact/near-miss scatter points whenever the selected encounter updates.
 */
const EnemyBodyHeatmapCanvas: React.FC<{ encounter: EnemyEncounterRecord }> = ({ encounter }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;

    ctx.fillStyle = '#070a0f';
    ctx.fillRect(0, 0, w, h);

    // Tactical measurement grid
    ctx.strokeStyle = 'rgba(30, 38, 56, 0.5)';
    ctx.lineWidth = 1;
    for (let gx = 28; gx < w; gx += 28) {
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, h);
      ctx.stroke();
    }
    for (let gy = 28; gy < h; gy += 28) {
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(w, gy);
      ctx.stroke();
    }

    drawAnatomicalSilhouette(ctx, w, h, encounter.silhouette);

    // Additive radial thermal density field across hits and <=0.1m near-misses
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const s of encounter.samples) {
      const [px, py] = normToCanvas(s.nx, s.ny, w, h);
      const radius = s.zone === 'miss' ? 16 : 20;
      const grad = ctx.createRadialGradient(px, py, 1, px, py, radius);
      if (s.zone === 'weakspot') {
        grad.addColorStop(0, 'rgba(255, 225, 90, 0.72)');
        grad.addColorStop(0.4, 'rgba(255, 42, 75, 0.45)');
        grad.addColorStop(1, 'rgba(255, 42, 75, 0)');
      } else if (s.zone === 'miss') {
        grad.addColorStop(0, 'rgba(168, 85, 247, 0.48)');
        grad.addColorStop(0.55, 'rgba(0, 240, 255, 0.22)');
        grad.addColorStop(1, 'rgba(0, 240, 255, 0)');
      } else {
        grad.addColorStop(0, 'rgba(255, 179, 0, 0.56)');
        grad.addColorStop(0.5, 'rgba(255, 90, 20, 0.3)');
        grad.addColorStop(1, 'rgba(255, 90, 20, 0)');
      }
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Crisp scatter impact markers on top of thermal glow
    for (const s of encounter.samples) {
      const [px, py] = normToCanvas(s.nx, s.ny, w, h);
      ctx.save();
      if (s.zone === 'miss') {
        ctx.strokeStyle = '#c084fc';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(px, py, 3, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.fillStyle =
          s.zone === 'weakspot'
            ? '#ffd000'
            : s.zone === 'torso'
              ? '#ffb300'
              : '#00f0ff';
        ctx.strokeStyle = '#070a0f';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(px, py, s.zone === 'weakspot' ? 3.2 : 2.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }
  }, [encounter]);

  return (
    <canvas
      ref={canvasRef}
      width={280}
      height={350}
      className="w-full max-w-[280px] h-auto border border-[#1e2638] bg-[#070a0f] mx-auto block"
    />
  );
};

/**
 * Hover/focus-accessible STK badge revealing weakspot, armor, extremity, and <=0.1m near-miss breakdown.
 * Uses pure CSS `group-hover`/`group-focus-within` rather than React hover state to avoid list re-renders.
 */
const StkTooltipBadge: React.FC<{ encounter: EnemyEncounterRecord }> = ({ encounter }) => {
  return (
    <div className="relative inline-block group">
      <span
        tabIndex={0}
        className="inline-flex items-center gap-1 px-2 py-0.5 bg-[#0f141d] border border-[#2a364f] group-hover:border-[#00f0ff] font-mono text-[10px] font-bold text-[#ffb300] cursor-help tabular-nums"
      >
        <span>{encounter.killed ? 'STK' : 'SHOTS'}: {encounter.shotsTakenToKill}</span>
        <span className="text-[#8c9bb5]">ⓘ</span>
      </span>

      <div className="pointer-events-none opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-150 absolute right-0 bottom-full mb-1.5 z-40 w-52 bg-[#0a0d12] border border-[#00f0ff] p-2.5 shadow-[0_6px_20px_rgba(0,0,0,0.85)] font-mono text-[10px] space-y-1">
        <div className="text-[#00f0ff] font-bold uppercase tracking-[0.06em] border-b border-[#1e2638] pb-1">
          Shot Placement Breakdown
        </div>
        <div className="flex justify-between tabular-nums">
          <span className="text-[#ff2a4b]">Weakspot Hits</span>
          <span className="text-[#e1e2ea] font-bold">{encounter.hitsWeakspot}</span>
        </div>
        <div className="flex justify-between tabular-nums">
          <span className="text-[#ffb300]">Armor Hits</span>
          <span className="text-[#e1e2ea] font-bold">{encounter.hitsArmor}</span>
        </div>
        <div className="flex justify-between tabular-nums">
          <span className="text-[#00f0ff]">Extremity Hits</span>
          <span className="text-[#e1e2ea] font-bold">{encounter.hitsExtremity}</span>
        </div>
        <div className="flex justify-between tabular-nums border-t border-[#1e2638] pt-1">
          <span className="text-[#c084fc]">Misses (&le;0.1m)</span>
          <span className="text-[#e1e2ea] font-bold">{encounter.nearMisses}</span>
        </div>
      </div>
    </div>
  );
};

export const TelemetryArchiveScreen: React.FC<TelemetryArchiveScreenProps> = ({
  runs,
  weapons,
  targets,
  enemyEncounters,
  weaponPerformances,
  onClearLiveTelemetry,
  onDeleteRun,
  onClearAll,
  onOpenRange,
}) => {
  const [search, setSearch] = useState('');
  const [selectedEnemyUid, setSelectedEnemyUid] = useState<number | null>(null);
  const [showOnlyFiredWeapons, setShowOnlyFiredWeapons] = useState(false);

  const filteredEncounters = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return enemyEncounters;
    return enemyEncounters.filter(
      (e) =>
        e.targetName.toLowerCase().includes(q) ||
        e.targetCode.toLowerCase().includes(q) ||
        e.lastWeaponName.toLowerCase().includes(q)
    );
  }, [enemyEncounters, search]);

  const activeEncounter = useMemo(() => {
    if (filteredEncounters.length === 0) return null;
    if (selectedEnemyUid !== null) {
      const match = filteredEncounters.find((e) => e.enemyUid === selectedEnemyUid);
      if (match) return match;
    }
    return filteredEncounters[0];
  }, [filteredEncounters, selectedEnemyUid]);

  const weaponRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return weapons
      .map((w) => {
        const rec = weaponPerformances[w.id];
        const shotsFired = rec?.shotsFired ?? 0;
        const shotsLanded = rec?.shotsLanded ?? 0;
        const totalHits = rec?.totalHits ?? 0;
        const weakspotHits = rec?.weakspotHits ?? 0;
        const armorHits = rec?.armorHits ?? 0;
        const extremityHits = rec?.extremityHits ?? 0;
        const nearMisses = rec?.nearMisses ?? 0;
        const totalDamage = rec?.totalDamage ?? 0;
        const activeTimeSec = (rec?.activeTimeMs ?? 0) / 1000;
        const accuracyPct = shotsFired > 0 ? Math.min(100, (shotsLanded / shotsFired) * 100) : 0;
        const effectiveDps = activeTimeSec > 0 ? totalDamage / activeTimeSec : 0;
        const perTarget = rec?.perTarget ?? {};
        return {
          weapon: w,
          shotsFired,
          totalHits,
          weakspotHits,
          armorHits,
          extremityHits,
          nearMisses,
          totalDamage,
          accuracyPct,
          effectiveDps,
          perTarget,
        };
      })
      .filter((row) => {
        if (showOnlyFiredWeapons && row.shotsFired === 0) return false;
        if (!q) return true;
        return (
          row.weapon.name.toLowerCase().includes(q) ||
          row.weapon.code.toLowerCase().includes(q) ||
          row.weapon.category.toLowerCase().includes(q)
        );
      });
  }, [weapons, weaponPerformances, showOnlyFiredWeapons, search]);

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

  /**
   * Serializes filtered Blackbox runs to CSV via a temporary in-memory `Blob` URL and immediately
   * revokes the object URL to prevent memory leaks (never relies on server-side endpoints).
   */
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
    <div className="max-w-[1520px] mx-auto p-4 lg:p-6 space-y-6">
      {/* Header Toolbar */}
      <div className="bg-[#121721] border border-[#1e2638] p-4 sm:p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="font-mono text-[11px] uppercase tracking-[0.1em] text-[#00f0ff]">
            Combat Blackbox · Anatomical Heatmaps &amp; Arsenal Breakdown
          </div>
          <h1 className="mt-1 font-display text-2xl font-bold tracking-[0.04em] uppercase text-[#e1e2ea]">
            Engagement Telemetry &amp; Performance
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter enemy or weapon..."
            aria-label="Filter telemetry records"
            className="bg-[#0f141d] border border-[#232d42] focus:border-[#00f0ff] px-3 py-2 font-mono text-xs text-[#e1e2ea] placeholder:text-[#8c9bb5]/60 focus:outline-none w-56"
          />
          <button
            type="button"
            onClick={onClearLiveTelemetry}
            disabled={enemyEncounters.length === 0}
            className="px-3.5 py-2 border border-[#2a364f] text-[#ffb300] font-mono text-xs uppercase tracking-[0.06em] hover:border-[#ffb300] disabled:opacity-40 cursor-pointer"
          >
            Reset Live Stats
          </button>
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

      {/* Section 1: Encountered Enemies & Anatomical Body Heatmap */}
      <div className="bg-[#121721] border border-[#1e2638] p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1e2638] pb-3">
          <div>
            <h2 className="font-display text-sm font-semibold uppercase tracking-[0.06em] text-[#e1e2ea]">
              01. Encountered Hostiles &amp; Shot Impact Heatmap ({filteredEncounters.length})
            </h2>
            <p className="font-mono text-[10px] text-[#8c9bb5] mt-0.5">
              Select any hostile to inspect exact hit cluster density plus misses within 0.1m. Hover STK for shot zone breakdown.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3 font-mono text-[10px] text-[#8c9bb5]">
            <span className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 inline-block bg-[#ffd000] rounded-full" /> WEAKSPOT
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 inline-block bg-[#ffb300] rounded-full" /> ARMOR
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 inline-block bg-[#00f0ff] rounded-full" /> EXTREMITY
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 inline-block border border-[#c084fc] rounded-full" /> MISS &le;0.1M
            </span>
          </div>
        </div>

        {filteredEncounters.length === 0 ? (
          <div className="py-10 text-center space-y-3">
            <div className="font-mono text-xs uppercase tracking-[0.08em] text-[#8c9bb5]">
              No Live Enemy Encounters Recorded Yet
            </div>
            <p className="font-mono text-[11px] text-[#8c9bb5]/80 max-w-lg mx-auto">
              Engage hostiles in the Range Simulator to generate per-enemy hit heatmaps, 0.1m near-miss tracking, and STK breakdowns.
            </p>
            <button
              type="button"
              onClick={onOpenRange}
              className="chamfer-sm px-4 py-2 bg-[#ffb300] text-[#0a0d12] font-mono text-xs font-bold uppercase tracking-[0.08em] hover:bg-[#00f0ff] cursor-pointer"
            >
              Open Range Simulator
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
            {/* Enemy Encounter Selector Ledger */}
            <div className="lg:col-span-7 max-h-[420px] overflow-y-auto pr-1 space-y-2">
              {filteredEncounters.map((enc) => {
                const isSelected = activeEncounter?.enemyUid === enc.enemyUid;
                return (
                  <div
                    key={enc.enemyUid}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedEnemyUid(enc.enemyUid)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelectedEnemyUid(enc.enemyUid);
                      }
                    }}
                    className={`p-3 border transition-colors flex flex-wrap items-center justify-between gap-3 cursor-pointer ${
                      isSelected
                        ? 'bg-[#171e2c] border-[#00f0ff]'
                        : 'bg-[#0f141d] border-[#1e2638] hover:border-[#2a364f]'
                    }`}
                  >
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-2 font-mono text-xs">
                        <span className="text-[#00f0ff] font-bold">
                          #{enc.enemyUid} · W{enc.waveNumber}
                        </span>
                        <span className="text-[#e1e2ea] font-semibold">{enc.targetName}</span>
                        <span
                          className={`px-1.5 py-0.2 text-[9px] font-bold border ${
                            enc.killed
                              ? 'border-[#20df78]/60 text-[#20df78] bg-[#20df78]/10'
                              : 'border-[#ffb300]/60 text-[#ffb300] bg-[#ffb300]/10'
                          }`}
                        >
                          {enc.killed ? 'KILLED' : 'ACTIVE'}
                        </span>
                      </div>
                      <div className="font-mono text-[10px] text-[#8c9bb5]">
                        Platform: {enc.lastWeaponName} · {enc.totalDamage} DMG ·{' '}
                        {enc.ttkMs !== null ? `TTK ${enc.ttkMs} ms` : 'In Progress'} ·{' '}
                        {enc.samples.length} Plotted Points
                      </div>
                    </div>

                    <div
                      onClick={(e) => e.stopPropagation()}
                      className="flex items-center gap-2"
                    >
                      <StkTooltipBadge encounter={enc} />
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Selected Enemy Anatomical Body Heatmap */}
            <div className="lg:col-span-5 bg-[#0f141d] border border-[#1e2638] p-4 space-y-3">
              {activeEncounter && (
                <>
                  <div className="flex items-start justify-between gap-2 border-b border-[#1e2638] pb-2.5">
                    <div>
                      <div className="font-mono text-[10px] uppercase text-[#00f0ff]">
                        Hostile #{activeEncounter.enemyUid} · {activeEncounter.targetCode} · Wave{' '}
                        {activeEncounter.waveNumber}
                      </div>
                      <div className="font-display text-base font-bold uppercase text-[#e1e2ea]">
                        {activeEncounter.targetName}
                      </div>
                    </div>
                    <StkTooltipBadge encounter={activeEncounter} />
                  </div>

                  <EnemyBodyHeatmapCanvas encounter={activeEncounter} />

                  <div className="grid grid-cols-4 gap-2 pt-1 font-mono text-[10px] text-center tabular-nums">
                    <div className="bg-[#0a0d12] border border-[#1e2638] p-1.5">
                      <div className="text-[#ff2a4b] font-bold">
                        {activeEncounter.hitsWeakspot}
                      </div>
                      <div className="text-[#8c9bb5] text-[9px]">WEAKSPOT</div>
                    </div>
                    <div className="bg-[#0a0d12] border border-[#1e2638] p-1.5">
                      <div className="text-[#ffb300] font-bold">{activeEncounter.hitsArmor}</div>
                      <div className="text-[#8c9bb5] text-[9px]">ARMOR</div>
                    </div>
                    <div className="bg-[#0a0d12] border border-[#1e2638] p-1.5">
                      <div className="text-[#00f0ff] font-bold">
                        {activeEncounter.hitsExtremity}
                      </div>
                      <div className="text-[#8c9bb5] text-[9px]">EXTREMITY</div>
                    </div>
                    <div className="bg-[#0a0d12] border border-[#1e2638] p-1.5">
                      <div className="text-[#c084fc] font-bold">{activeEncounter.nearMisses}</div>
                      <div className="text-[#8c9bb5] text-[9px]">MISS &le;0.1M</div>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Section 2: All-Weapons Combat Performance & Time-To-Kill Per Target */}
      <div className="bg-[#121721] border border-[#1e2638] p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1e2638] pb-3">
          <div>
            <h2 className="font-display text-sm font-semibold uppercase tracking-[0.06em] text-[#e1e2ea]">
              02. Arsenal Performance &amp; Time-To-Kill Per Target ({weaponRows.length} Weapons)
            </h2>
            <p className="font-mono text-[10px] text-[#8c9bb5] mt-0.5">
              Live hit breakdowns, shot accuracy, effective DPS, and average kill speed per enemy chassis across every weapon.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowOnlyFiredWeapons((v) => !v)}
            className={`px-3 py-1 border font-mono text-[10px] uppercase tracking-[0.06em] cursor-pointer ${
              showOnlyFiredWeapons
                ? 'border-[#00f0ff] bg-[#00f0ff]/15 text-[#00f0ff]'
                : 'border-[#232d42] bg-[#0f141d] text-[#8c9bb5] hover:text-[#e1e2ea]'
            }`}
          >
            {showOnlyFiredWeapons ? 'Showing Fired Only' : 'Showing All Weapons'}
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse font-mono text-xs tabular-nums">
            <thead>
              <tr className="border-b border-[#1e2638] text-[10px] uppercase tracking-[0.08em] text-[#8c9bb5]">
                <th className="py-2.5 pr-3">Weapon</th>
                <th className="py-2.5 px-2 text-right">Total Hits</th>
                <th className="py-2.5 px-2 text-right">Weakspots</th>
                <th className="py-2.5 px-2 text-right">Armor</th>
                <th className="py-2.5 px-2 text-right">Extremity</th>
                <th className="py-2.5 px-2 text-right">Accuracy</th>
                <th className="py-2.5 px-2 text-right">Eff. DPS</th>
                <th className="py-2.5 pl-3">Avg TTK Per Target Chassis</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1e2638]">
              {weaponRows.map((row) => {
                const targetStats = targets
                  .map((t) => row.perTarget[t.id])
                  .filter((st) => Boolean(st && st.kills > 0));
                return (
                  <tr key={row.weapon.id} className="hover:bg-[#161c28] transition-colors">
                    <td className="py-3 pr-3 whitespace-nowrap">
                      <div className="text-[#e1e2ea] font-semibold">{row.weapon.name}</div>
                      <div className="text-[10px] text-[#00f0ff]">
                        {row.weapon.code} · {row.weapon.category}
                      </div>
                    </td>
                    <td className="py-3 px-2 text-right text-[#e1e2ea] font-bold">
                      {row.totalHits}
                    </td>
                    <td className="py-3 px-2 text-right text-[#ff2a4b] font-semibold">
                      {row.weakspotHits}
                    </td>
                    <td className="py-3 px-2 text-right text-[#ffb300]">{row.armorHits}</td>
                    <td className="py-3 px-2 text-right text-[#00f0ff]">{row.extremityHits}</td>
                    <td className="py-3 px-2 text-right text-[#20df78]">
                      {row.shotsFired > 0 ? `${row.accuracyPct.toFixed(1)}%` : '—'}
                    </td>
                    <td className="py-3 px-2 text-right text-[#ffb300] font-bold">
                      {row.shotsFired > 0 ? `${Math.round(row.effectiveDps)} DPS` : '—'}
                    </td>
                    <td className="py-3 pl-3">
                      {targetStats.length === 0 ? (
                        <span className="text-[10px] text-[#606f89]">No kills logged</span>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {targetStats.map((st) => (
                            <span
                              key={st.targetId}
                              title={`${st.targetName}: ${st.kills} kills · Avg STK ${st.avgStk ?? '-'}`}
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-[#0a0d12] border border-[#232d42] text-[10px]"
                            >
                              <span className="text-[#8c9bb5]">{st.targetCode}</span>
                              <span className="text-[#20df78] font-bold">
                                {st.avgTtkMs !== null ? `${st.avgTtkMs}ms` : '—'}
                              </span>
                              <span className="text-[#606f89]">({st.kills})</span>
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Section 3: Saved Blackbox Archive Runs */}
      {filtered.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          {/* Left: Comparative Effective DPS Bars */}
          <div className="lg:col-span-5 bg-[#121721] border border-[#1e2638] p-5 space-y-4">
            <h2 className="font-display text-sm font-semibold uppercase tracking-[0.06em] text-[#e1e2ea] border-b border-[#1e2638] pb-3">
              03. Comparative Archived DPS
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
              04. Archived Engagement Runs ({filtered.length})
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
