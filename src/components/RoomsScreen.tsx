/**
 * @file RoomsScreen.tsx
 * Combat Simulation Rooms selector displaying top-down tactical SVG schematics,
 * breakable grey spawn entrance positions, sealed blue player doorway, and stagger cadence metadata.
 *
 * Why procedural top-down SVG schematics instead of live secondary WebGL preview canvases:
 * - Creating extra WebGL contexts per room card consumes precious GPU contexts (browsers typically limit
 *   active WebGL contexts to 8–16) and risks silently losing the primary `SimulationCanvas3D` context.
 * - Inline SVGs render instantaneously with crisp dashed enemy pathing vectors and zero GPU overhead.
 */
import React from 'react';
import { ArrowUpRight, DoorOpen, ShieldAlert, Timer } from 'lucide-react';
import { ROOM_LAYOUTS } from '../data/arsenal';
import { RoomLayoutId } from '../types/ballistics';

interface RoomsScreenProps {
  /** Currently active arena (`corridor_01` or `double_flank_02`). */
  selectedRoomId: RoomLayoutId;
  /** Updates the selected room configuration without immediately leaving the Rooms tab. */
  onSelectRoom: (roomId: RoomLayoutId) => void;
  /** Selects the optional target room and switches back to `Range Sim` ready for combat. */
  onDeployToRange: (roomId?: RoomLayoutId) => void;
}

/**
 * Top-down vector schematic of the 24m x 120m Firing Corridor (`corridor_01`),
 * illustrating the recessed spawn bay behind the breakable north grey door and 4-group 6s stagger lane.
 */
const CorridorSchematicSvg: React.FC = () => (
  <svg viewBox="0 0 320 170" className="w-full h-44 bg-[#0a0d12] border border-[#1e2638]" aria-hidden="true">
    {/* Recessed Behind-Door Enemy Spawn Bay */}
    <rect x="116" y="6" width="88" height="22" fill="#231822" stroke="#ff2a4b" strokeWidth="1.4" strokeDasharray="3 2" />
    <text x="160" y="19" textAnchor="middle" fill="#ff2a4b" fontSize="6.8" fontFamily="monospace">
      SPAWN BAY (BEHIND DOOR)
    </text>
    {/* 24m x 120m Walled Firing Lane */}
    <rect x="92" y="28" width="136" height="128" fill="#182030" stroke="#00f0ff" strokeWidth="2" />
    {[48, 70, 92, 114, 136].map((y) => (
      <line key={y} x1="92" y1={y} x2="228" y2={y} stroke="#00f0ff" strokeOpacity="0.16" strokeWidth="1" />
    ))}
    {/* Breakable North Grey Door & Sealed South Blue Door */}
    <rect x="132" y="24" width="56" height="7" fill="#707b8e" stroke="#ff2a4b" strokeWidth="1.3" />
    <rect x="144" y="152" width="32" height="7" fill="#2540eb" stroke="#00f0ff" strokeWidth="1.2" />
    <line x1="160" y1="32" x2="160" y2="56" stroke="#ffb300" strokeWidth="1.4" strokeDasharray="3 3" />
    <text x="160" y="68" textAnchor="middle" fill="#ffb300" fontSize="7.5" fontFamily="monospace">
      BREAKABLE DOOR · 24M × 120M (4 GRPS · 6S STAGGER)
    </text>
    {/* Player Position */}
    <circle cx="160" cy="142" r="5" fill="#20df78" />
    <text x="160" y="131" textAnchor="middle" fill="#20df78" fontSize="7.5" fontFamily="monospace">
      OPERATOR (SOUTH DOOR)
    </text>
  </svg>
);

/**
 * Top-down vector schematic of the Double Flank Chambers (`double_flank_02`),
 * illustrating left/right breakable grey entrance doors converging onto the central player hold.
 */
const DoubleFlankSchematicSvg: React.FC = () => (
  <svg viewBox="0 0 320 170" className="w-full h-44 bg-[#0a0d12] border border-[#1e2638]" aria-hidden="true">
    {/* Exact Double Flank Chambers Silhouette */}
    <polygon
      points="116,154 146,154 146,162 174,162 174,154 204,154 204,104 256,126 286,126 286,98 294,98 294,74 252,74 252,102 204,80 116,80 80,52 30,52 30,74 74,74 116,104"
      fill="#1b2230"
      stroke="#8c9bb5"
      strokeWidth="1.5"
    />
    {/* Left & Right Breakable Grey Doors (enemy spawn entrances) */}
    <rect x="24" y="52" width="7" height="22" fill="#707b8e" stroke="#ff2a4b" strokeWidth="1.2" />
    <rect x="293" y="74" width="7" height="24" fill="#707b8e" stroke="#ff2a4b" strokeWidth="1.2" />
    {/* Sealed Blue Aesthetic Player Spawn Door */}
    <rect x="146" y="155" width="28" height="8" fill="#2540eb" stroke="#00f0ff" strokeWidth="1" />
    {/* Flow Paths */}
    <polyline
      points="34,63 76,63 128,96"
      fill="none"
      stroke="#ffb300"
      strokeWidth="1.3"
      strokeDasharray="4 3"
    />
    <polyline
      points="290,86 270,86 270,114 254,114 196,90"
      fill="none"
      stroke="#ffb300"
      strokeWidth="1.3"
      strokeDasharray="4 3"
    />
    {/* Operator Marker */}
    <circle cx="160" cy="144" r="4.5" fill="#20df78" />
    <text x="48" y="42" fill="#ffb300" fontSize="7.5" fontFamily="monospace">
      GREY DOOR W
    </text>
    <text x="244" y="64" fill="#ffb300" fontSize="7.5" fontFamily="monospace">
      GREY DOOR E
    </text>
    <text x="160" y="134" textAnchor="middle" fill="#20df78" fontSize="7.5" fontFamily="monospace">
      PLAYER SPAWN (BLUE SEAL)
    </text>
  </svg>
);

export const RoomsScreen: React.FC<RoomsScreenProps> = ({
  selectedRoomId,
  onSelectRoom,
  onDeployToRange,
}) => {
  return (
    <div className="max-w-[1600px] mx-auto p-4 lg:p-6 space-y-6">
      <div className="bg-[#121721] border border-[#1e2638] p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="font-mono text-[11px] uppercase tracking-[0.1em] text-[#ffb300]">
            Arena Architecture // Deployment Sector Selection
          </div>
          <h1 className="mt-1 font-display text-xl sm:text-2xl font-bold tracking-[0.04em] uppercase text-[#e1e2ea]">
            Combat Simulation Rooms
          </h1>
          <p className="mt-1 text-xs text-[#8c9bb5] max-w-2xl">
            Select the engagement room before spawning hostiles. Walk freely with WASD / Arrow Keys, break through reinforced entrances, or hold the central hall against dual-flank waves.
          </p>
        </div>

        <button
          type="button"
          onClick={() => onDeployToRange(selectedRoomId)}
          className="chamfer-sm px-5 py-2.5 bg-[#ffb300] hover:bg-[#00f0ff] text-[#0a0d12] font-mono text-xs font-bold tracking-[0.1em] uppercase flex items-center gap-2 transition-colors cursor-pointer"
        >
          <span>Deploy To Active Room</span>
          <ArrowUpRight size={15} />
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {ROOM_LAYOUTS.map((room) => {
          const isSelected = room.id === selectedRoomId;
          return (
            <div
              key={room.id}
              className={`bg-[#121721] border transition-colors flex flex-col ${
                isSelected ? 'border-[#ffb300]' : 'border-[#1e2638] hover:border-[#2c3a54]'
              }`}
            >
              <div className="px-5 py-3.5 border-b border-[#1e2638] bg-[#161c28] flex items-center justify-between gap-2">
                <div>
                  <span className="font-mono text-[10px] tracking-[0.1em] uppercase text-[#ffb300]">
                    {room.code} · {room.subtitle}
                  </span>
                  <h2 className="font-display text-lg font-bold uppercase tracking-[0.04em] text-[#e1e2ea]">
                    {room.name}
                  </h2>
                </div>
                <span
                  className={`px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.08em] border ${
                    isSelected
                      ? 'bg-[#ffb300]/15 border-[#ffb300] text-[#ffb300]'
                      : 'bg-[#0f141d] border-[#232d42] text-[#8c9bb5]'
                  }`}
                >
                  {isSelected ? 'ACTIVE SECTOR' : 'STANDBY'}
                </span>
              </div>

              <div className="p-5 space-y-4 flex-1 flex flex-col justify-between">
                <div className="space-y-4">
                  {room.id === 'corridor_01' ? (
                    <CorridorSchematicSvg />
                  ) : (
                    <DoubleFlankSchematicSvg />
                  )}

                  <p className="text-xs leading-relaxed text-[#8c9bb5]">{room.description}</p>

                  <div className="grid grid-cols-3 gap-2 font-mono text-[11px]">
                    <div className="bg-[#0f141d] border border-[#232d42] p-2.5">
                      <div className="text-[9px] uppercase text-[#8c9bb5] flex items-center gap-1">
                        <DoorOpen size={11} className="text-[#00f0ff]" />
                        <span>Entrances</span>
                      </div>
                      <div className="mt-1 font-bold text-[#e1e2ea] tabular-nums">
                        {room.entrances} {room.entrances === 1 ? 'LANE' : 'FLANKS'}
                      </div>
                    </div>

                    <div className="bg-[#0f141d] border border-[#232d42] p-2.5">
                      <div className="text-[9px] uppercase text-[#8c9bb5] flex items-center gap-1">
                        <Timer size={11} className="text-[#ffb300]" />
                        <span>Stagger Rate</span>
                      </div>
                      <div className="mt-1 font-bold text-[#ffb300] tabular-nums">
                        {room.spawnStaggerSec > 0 ? `${room.spawnStaggerSec.toFixed(1)}s` : 'INSTANT'}
                      </div>
                    </div>

                    <div className="bg-[#0f141d] border border-[#232d42] p-2.5">
                      <div className="text-[9px] uppercase text-[#8c9bb5] flex items-center gap-1">
                        <ShieldAlert size={11} className="text-[#20df78]" />
                        <span>Dimensions</span>
                      </div>
                      <div className="mt-1 font-bold text-[#e1e2ea] tabular-nums truncate">
                        {room.dimensionsLabel}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="pt-2 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onSelectRoom(room.id)}
                    className={`flex-1 py-2.5 px-4 font-mono text-xs font-semibold uppercase tracking-[0.08em] border transition-colors cursor-pointer ${
                      isSelected
                        ? 'bg-[#1b2332] border-[#ffb300] text-[#ffb300]'
                        : 'bg-[#0f141d] border-[#232d42] text-[#e1e2ea] hover:border-[#00f0ff] hover:text-[#00f0ff]'
                    }`}
                  >
                    {isSelected ? 'Selected Room' : 'Select Room'}
                  </button>
                  <button
                    type="button"
                    onClick={() => onDeployToRange(room.id)}
                    className="chamfer-sm py-2.5 px-4 bg-[#ffb300] hover:bg-[#00f0ff] text-[#0a0d12] font-mono text-xs font-bold uppercase tracking-[0.08em] transition-colors cursor-pointer"
                  >
                    Enter Arena
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
