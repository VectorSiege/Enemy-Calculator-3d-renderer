import React from 'react';
import { AppScreen } from '../types/ballistics';

interface TopBarProps {
  activeScreen: AppScreen;
  onSelectScreen: (screen: AppScreen) => void;
  isSimRunning: boolean;
  onPrimaryAction: () => void;
}

const NAV_ITEMS: { id: AppScreen; label: string }[] = [
  { id: 'range', label: 'Range Sim' },
  { id: 'rooms', label: 'Rooms' },
  { id: 'armory', label: 'Armory' },
  { id: 'targets', label: 'Targets' },
  { id: 'telemetry', label: 'Telemetry' },
];

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
