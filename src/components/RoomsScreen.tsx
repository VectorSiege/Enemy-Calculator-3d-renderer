import React from 'react';
import { ArrowUpRight, DoorOpen, ShieldAlert, Timer } from 'lucide-react';
import { ROOM_LAYOUTS } from '../data/arsenal';
import { RoomLayoutId } from '../types/ballistics';

interface RoomsScreenProps {
  selectedRoomId: RoomLayoutId;
  onSelectRoom: (roomId: RoomLayoutId) => void;
  onDeployToRange: (roomId?: RoomLayoutId) => void;
}

const CorridorSchematicSvg: React.FC = () => (
  <svg viewBox="0 0 320 170" className="w-full h-44 bg-[#0a0d12] border border-[#1e2638]" aria-hidden="true">
    {/* Outer Lane Grid */}
    <rect x="115" y="14" width="90" height="142" fill="#182030" stroke="#2c3a54" strokeWidth="1.5" />
    {[34, 56, 78, 100, 122].map((y) => (
      <line key={y} x1="115" y1={y} x2="205" y2={y} stroke="#00f0ff" strokeOpacity="0.16" strokeWidth="1" />
    ))}
    {/* Pylons */}
    {[28, 56, 84, 112].map((y) => (
      <g key={y}>
        <rect x="111" y={y} width="5" height="9" fill="#ffb300" />
        <rect x="204" y={y} width="5" height="9" fill="#ffb300" />
      </g>
    ))}
    {/* Enemy Spawn Band */}
    <rect x="122" y="18" width="76" height="6" fill="#ff2a4b" opacity="0.85" />
    <text x="160" y="36" textAnchor="middle" fill="#ff2a4b" fontSize="8" fontFamily="monospace">
      FRONTAL SPAWN (5m–140m)
    </text>
    {/* Player Position */}
    <circle cx="160" cy="144" r="5" fill="#20df78" />
    <text x="160" y="133" textAnchor="middle" fill="#20df78" fontSize="8" fontFamily="monospace">
      OPERATOR
    </text>
  </svg>
);

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
