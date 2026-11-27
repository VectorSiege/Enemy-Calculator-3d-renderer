/**
 * @file TacticalMinimap.tsx
 * Tactical top-right 2D radar `<canvas>` renderer displaying:
 * - Room geometry perimeter walls & breakable door state (solid amber intact vs dashed breached)
 * - Additive thermal enemy heatmap (`globalCompositeOperation = 'lighter'`) + per-unit markers
 * - Dropped ammo (emerald squares) & consumable crates (cyan diamonds)
 * - Player directional arrow & FOV cone, dynamically shifting downward when backed against a rear wall
 *
 * Why `snapshotRef` + `requestAnimationFrame` throttled at ~30 FPS beats React props or 60Hz SVG:
 * - Receiving enemy coordinates/yaw via React `useState` at 60 FPS would force React reconciliation of
 *   the parent tree on every frame, causing micro-stutters in first-person aiming.
 * - Mutating `snapshotRef.current` directly from the Three.js tick loop and polling it in a standalone
 *   33ms-throttled Canvas 2D loop eliminates React re-renders completely while cutting Canvas redraw work
 *   in half with no visible radar lag.
 * - Using a single `<canvas>` instead of dozens of SVG DOM nodes keeps draw cost O(enemies) flat even
 *   when spawning the maximum 120-unit squad.
 */
import React, { useEffect, useRef } from 'react';
import { RoomLayoutId, TargetSilhouette } from '../types/ballistics';
import { WallSegment2D } from '../three/roomLayouts';

/** Mutable radar payload updated in-place every frame by `SimulationCanvas3D`. */
export interface MinimapSnapshot {
  roomId: RoomLayoutId;
  playerX: number;
  playerZ: number;
  aimYaw: number;
  wallSegments: WallSegment2D[];
  doors: {
    ax: number;
    az: number;
    bx: number;
    bz: number;
    broken: boolean;
  }[];
  enemies: {
    x: number;
    z: number;
    silhouette: TargetSilhouette;
    staggered: boolean;
  }[];
  ammoBoxes: {
    x: number;
    z: number;
  }[];
  consumableBoxes: {
    x: number;
    z: number;
  }[];
}

interface TacticalMinimapProps {
  /** Shared mutable ref written by `SimulationCanvas3D` and read at ~30 FPS by the radar draw loop. */
  snapshotRef: React.MutableRefObject<MinimapSnapshot>;
}

/**
 * 2D ray-vs-segment intersection solver in world XZ space.
 * Returns parametric forward hit distance `t >= 0.05` along ray `(ox, oz) + t*(dx, dz)`, or `Infinity` on miss.
 *
 * Used to measure front/rear wall clearance around the operator; a simpler bounding-box clamp
 * would fail on angled corridors or Double Flank side chambers.
 */
function intersectRaySegment2D(
  ox: number,
  oz: number,
  dx: number,
  dz: number,
  seg: WallSegment2D
): number {
  const sx = seg.bx - seg.ax;
  const sz = seg.bz - seg.az;
  const denom = dx * sz - dz * sx;
  if (Math.abs(denom) < 1e-6) return Infinity;
  const qpx = seg.ax - ox;
  const qpz = seg.az - oz;
  const t = (qpx * sz - qpz * sx) / denom;
  const u = (qpx * dz - qpz * dx) / denom;
  if (t >= 0.05 && u >= 0 && u <= 1) return t;
  return Infinity;
}

/**
 * Heading-up tactical radar component driven by `snapshotRef` without React re-renders.
 */
export const TacticalMinimap: React.FC<TacticalMinimapProps> = ({ snapshotRef }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let rafId = 0;
    let lastDraw = 0;

    /** Frame callback throttled to 33ms (~30 FPS) that projects world entities into heading-up radar coordinates. */
    const draw = (now: number) => {
      rafId = requestAnimationFrame(draw);
      if (now - lastDraw < 33) return; // ~30 FPS radar refresh balances crisp smoothness with low CPU draw cost
      lastDraw = now;

      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const snap = snapshotRef.current;
      const w = canvas.width;
      const h = canvas.height;
      const viewRadiusM = 34; // meters from focal center to edge
      const pxPerM = w / (viewRadiusM * 2);

      // Forward & right unit vectors in Three.js world XZ matching camera aimYaw (-Z forward at yaw=0)
      const fwdX = -Math.sin(snap.aimYaw);
      const fwdZ = -Math.cos(snap.aimYaw);
      const rightX = Math.cos(snap.aimYaw);
      const rightZ = -Math.sin(snap.aimYaw);

      // Measure rear wall proximity vs forward clearance so backing against a wall shifts the player marker downward,
      // maximizing forward radar space instead of wasting half the minimap behind an opaque wall.
      let backWallDist = viewRadiusM;
      let frontWallDist = viewRadiusM;
      for (const seg of snap.wallSegments) {
        const dBack = intersectRaySegment2D(snap.playerX, snap.playerZ, -fwdX, -fwdZ, seg);
        if (dBack < backWallDist) backWallDist = dBack;
        const dFront = intersectRaySegment2D(snap.playerX, snap.playerZ, fwdX, fwdZ, seg);
        if (dFront < frontWallDist) frontWallDist = dFront;
      }

      // Centered (0.50) in open space; smoothly pushed downward (up to 0.78) when backed to a wall
      let playerScreenYFrac = 0.5;
      if (backWallDist < 14 && frontWallDist > backWallDist + 2) {
        const pushFactor = Math.max(0, Math.min(1, 1 - backWallDist / 14));
        playerScreenYFrac = 0.5 + 0.28 * pushFactor;
      }

      const playerScreenX = w * 0.5;
      const playerScreenY = h * playerScreenYFrac;

      /** Converts world (wx, wz) into heading-up canvas pixels (Right = +X, Forward = -Y up). */
      const toMap = (wx: number, wz: number): [number, number] => {
        const dx = wx - snap.playerX;
        const dz = wz - snap.playerZ;
        const localRight = dx * rightX + dz * rightZ;
        const localFwd = dx * fwdX + dz * fwdZ;
        return [playerScreenX + localRight * pxPerM, playerScreenY - localFwd * pxPerM];
      };

      // Clear background
      ctx.fillStyle = '#070a0f';
      ctx.fillRect(0, 0, w, h);

      // Subtle tactical range rings centered on player
      ctx.strokeStyle = 'rgba(30, 38, 56, 0.85)';
      ctx.lineWidth = 1;
      for (const ringM of [15, 30, 45]) {
        ctx.beginPath();
        ctx.arc(playerScreenX, playerScreenY, ringM * pxPerM, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Crosshair axes
      ctx.strokeStyle = 'rgba(30, 38, 56, 0.55)';
      ctx.beginPath();
      ctx.moveTo(0, playerScreenY);
      ctx.lineTo(w, playerScreenY);
      ctx.moveTo(playerScreenX, 0);
      ctx.lineTo(playerScreenX, h);
      ctx.stroke();

      // Enemy Thermal Heatmap Layer (additive hot-crimson -> orange -> amber-white glow)
      if (snap.enemies.length > 0) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const heatRadiusPx = 18;
        for (const en of snap.enemies) {
          const [ex, ey] = toMap(en.x, en.z);
          if (ex < -heatRadiusPx || ex > w + heatRadiusPx || ey < -heatRadiusPx || ey > h + heatRadiusPx) {
            continue;
          }
          const isHeavy =
            en.silhouette === 'titan' || en.silhouette === 'tank' || en.silhouette === 'brute';
          const r = isHeavy ? heatRadiusPx * 1.35 : heatRadiusPx;
          const grad = ctx.createRadialGradient(ex, ey, 1, ex, ey, r);
          grad.addColorStop(0, isHeavy ? 'rgba(255, 205, 80, 0.62)' : 'rgba(255, 115, 36, 0.52)');
          grad.addColorStop(0.42, 'rgba(255, 42, 75, 0.36)');
          grad.addColorStop(1, 'rgba(255, 42, 75, 0)');
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(ex, ey, r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }

      // Room perimeter walls
      ctx.strokeStyle = '#5c7091';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (const seg of snap.wallSegments) {
        const [ax, ay] = toMap(seg.ax, seg.az);
        const [bx, by] = toMap(seg.bx, seg.bz);
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
      }
      ctx.stroke();

      // Breakable doors (solid amber when intact, dashed faint when breached)
      for (const door of snap.doors) {
        const [ax, ay] = toMap(door.ax, door.az);
        const [bx, by] = toMap(door.bx, door.bz);
        ctx.save();
        ctx.strokeStyle = door.broken ? 'rgba(140, 155, 181, 0.35)' : '#ffb300';
        ctx.lineWidth = door.broken ? 1 : 2.2;
        if (door.broken) ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
        ctx.restore();
      }

      // Dropped Ammo Supply Crates (bright emerald squares)
      for (const ab of snap.ammoBoxes) {
        const [ax, ay] = toMap(ab.x, ab.z);
        if (ax < 2 || ax > w - 2 || ay < 2 || ay > h - 2) continue;
        ctx.fillStyle = '#20df78';
        ctx.fillRect(ax - 2, ay - 2, 4, 4);
      }

      // Dropped Consumable Supply Crates (bright cyan-amber diamonds)
      for (const cb of snap.consumableBoxes) {
        const [cx, cy] = toMap(cb.x, cb.z);
        if (cx < 2 || cx > w - 2 || cy < 2 || cy > h - 2) continue;
        ctx.fillStyle = '#00f0ff';
        ctx.beginPath();
        ctx.moveTo(cx, cy - 3.2);
        ctx.lineTo(cx + 3.2, cy);
        ctx.lineTo(cx, cy + 3.2);
        ctx.lineTo(cx - 3.2, cy);
        ctx.closePath();
        ctx.fill();
      }

      // Individual hostile markers (hot crimson/yellow high-contrast dots + outer border indicator when off-edge)
      for (const en of snap.enemies) {
        const [rawX, rawY] = toMap(en.x, en.z);
        const clampedX = Math.max(4, Math.min(w - 4, rawX));
        const clampedY = Math.max(4, Math.min(h - 4, rawY));
        const isEdge = rawX !== clampedX || rawY !== clampedY;

        ctx.fillStyle = en.staggered ? '#ffd000' : '#ff2a4b';
        ctx.strokeStyle = '#070a0f';
        ctx.lineWidth = 1;
        const rad =
          en.silhouette === 'titan' || en.silhouette === 'tank'
            ? isEdge
              ? 3.2
              : 3.6
            : isEdge
              ? 2.2
              : 2.6;
        ctx.beginPath();
        ctx.arc(clampedX, clampedY, rad, 0, Math.PI * 2);
        ctx.fill();
        if (!isEdge) ctx.stroke();
      }

      // Player FOV sight cone (high-contrast electric cyan pointing forward UP)
      ctx.save();
      const coneGrad = ctx.createLinearGradient(
        playerScreenX,
        playerScreenY,
        playerScreenX,
        playerScreenY - 38
      );
      coneGrad.addColorStop(0, 'rgba(0, 240, 255, 0.32)');
      coneGrad.addColorStop(1, 'rgba(0, 240, 255, 0)');
      ctx.fillStyle = coneGrad;
      ctx.beginPath();
      ctx.moveTo(playerScreenX, playerScreenY);
      ctx.arc(playerScreenX, playerScreenY, 40, -Math.PI / 2 - 0.48, -Math.PI / 2 + 0.48);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // Player Directional Arrow (contrasting Electric Cyan + crisp White outline)
      ctx.save();
      ctx.translate(playerScreenX, playerScreenY);
      ctx.fillStyle = '#00f0ff';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(0, -7);
      ctx.lineTo(5.2, 5.5);
      ctx.lineTo(0, 2.5);
      ctx.lineTo(-5.2, 5.5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    };

    rafId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafId);
  }, [snapshotRef]);

  return (
    <div className="pointer-events-none bg-[#070a0f]/90 border border-[#1e2638] p-1 shadow-[0_4px_16px_rgba(0,0,0,0.65)]">
      <div className="flex items-center justify-between px-1 pb-0.5 font-mono text-[8px] uppercase tracking-[0.1em] text-[#8c9bb5]">
        <span className="text-[#00f0ff] font-bold">RADAR</span>
        <span className="text-[#ff2a4b]">HEATMAP</span>
      </div>
      <canvas
        ref={canvasRef}
        width={140}
        height={140}
        className="block w-[124px] h-[124px] sm:w-[140px] sm:h-[140px]"
      />
    </div>
  );
};
