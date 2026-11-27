/**
 * @file TopBar.tsx
 * Global sticky navigation bar switching between Range Sim, Rooms, Armory, Targets,
 * and Telemetry Archive without resetting active waves, deployed ordnance, or WebGL resources.
 *
 * Why CSS-hidden tab switching in the parent (`App.tsx`) is better than routing/unmounting:
 * - Triggering `onSelectScreen` only toggles the visible tab state while keeping `SimulationCanvas3D`
 *   mounted via CSS `hidden`. If switching to Armory or Targets unmounted the range canvas, the
 *   Three.js WebGL2 context, compiled skybox/weather shaders, enemy meshes, and deployed mines/turrets
 *   would be destroyed and require expensive synchronous GPU re-compilation on return.
 * - Similarly, the single context-sensitive primary action button (`Engage` / `Halt Fire` / `Open Range`)
 *   avoids cluttering the header with separate wave controls that could conflict with Pointer Lock.
 */
import React from 'react';
import { AppScreen } from '../types/ballistics';

interface TopBarProps {
  /** Currently visible top-level screen (`range` | `rooms` | `armory` | `targets` | `telemetry`). */
  activeScreen: AppScreen;
  /** Switches active tab without destroying the live simulation state. */
  onSelectScreen: (screen: AppScreen) => void;
  /** Mirrors `isSimRunning` so the primary CTA swaps between `Engage` and `Halt Fire` on the range. */
  isSimRunning: boolean;
  /** Starts/stops simulation when on `range`, or navigates back to `range` from other tabs. */
  onPrimaryAction: () => void;
}

/** Static navigation manifest kept outside render to avoid per-frame array reallocation. */
const NAV_ITEMS: { id: AppScreen; label: string }[] = [
  { id: 'range', label: 'Range Sim' },
  { id: 'rooms', label: 'Rooms' },
  { id: 'armory', label: 'Armory' },
  { id: 'targets', label: 'Targets' },
  { id: 'telemetry', label: 'Telemetry' },
];

/**
 * Sticky three-zone header: brand return button, single-line tab bar, and primary combat CTA.
 */
export const TopBar: React.FC<TopBarProps> = ({
  activeScreen,
  onSelectScreen,
  isSimRunning,
  onPrimaryAction,
}) => {
  return (
    <header className="sticky top-0 z-40 w-full bg-[#121721] border-b border-[#1e2638] px-4 lg:px-6 h-14 flex items-center justify-between gap-8">
      {/* Zone 1: Single text wordmark */}
      <button
        type="button"
        onClick={() => onSelectScreen('range')}
        className="font-display text-base lg:text-lg font-bold tracking-[0.08em] uppercase text-[#e1e2ea] hover:text-[#ffb300] transition-colors duration-150 whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-[#00f0ff]"
      >
        Aegis Telemetry
      </button>

      {/* Zone 2: 4 clean single-line navigation links */}
      <nav
        aria-label="Primary Console Navigation"
        className="flex items-center gap-4 sm:gap-7 overflow-x-auto no-scrollbar"
      >
        {NAV_ITEMS.map((item) => {
          const isActive = activeScreen === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectScreen(item.id)}
              className={`relative py-4 text-xs sm:text-sm font-display font-semibold tracking-[0.06em] uppercase transition-colors duration-150 whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-[#00f0ff] ${
                isActive
                  ? 'text-[#ffb300]'
                  : 'text-[#8c9bb5] hover:text-[#e1e2ea]'
              }`}
            >
              {item.label}
              {isActive && (
                <span
                  aria-hidden="true"
                  className="absolute bottom-0 left-0 right-0 h-[2px] bg-[#ffb300]"
                />
              )}
            </button>
          );
        })}
      </nav>

      {/* Zone 3: 1 primary action */}
      <div className="flex items-center shrink-0">
        <button
          type="button"
          onClick={onPrimaryAction}
          className={`chamfer-sm px-4 py-2 font-mono text-xs font-semibold tracking-[0.08em] uppercase whitespace-nowrap shrink-0 transition-all duration-150 cursor-pointer focus-visible:outline-2 focus-visible:outline-[#00f0ff] ${
            activeScreen === 'range'
              ? isSimRunning
                ? 'bg-[#ff2a4b] text-[#0a0d12] hover:bg-[#ff526d] glow-red'
                : 'bg-[#ffb300] text-[#0a0d12] hover:bg-[#00f0ff] hover:shadow-[0_0_12px_rgba(0,240,255,0.45)]'
              : 'bg-[#ffb300] text-[#0a0d12] hover:bg-[#00f0ff] hover:shadow-[0_0_12px_rgba(0,240,255,0.45)]'
          }`}
        >
          {activeScreen === 'range'
            ? isSimRunning
              ? 'Halt Fire'
              : 'Engage'
            : 'Open Range'}
        </button>
      </div>
    </header>
  );
};
