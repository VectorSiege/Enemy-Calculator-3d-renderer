/**
 * @file ViewportInventoryModal.tsx
 * In-Viewport Tactical Inventory accessed via the `[E]` keybind.
 * Displays all Primary weapons, Secondary weapons, and Consumable ordnance with live
 * charge/ammo counters (`weaponAmmoMap`, `consumableUsages`) and supports three equip flows:
 * 1. Click any weapon or consumable card (`!prev.active` on mouseup -> `triggerEquip`)
 * 2. LMB drag a card (`dist > 6px`) over the top Equipped Loadout Dock and release
 * 3. Hold `[E]`, hover a card (which populates `hoveredItemRef.current`), and release `[E]` in `SimulationCanvas3D`
 *
 * Why custom `window.addEventListener('mousemove'/'mouseup')` drag + `hoveredItemRef` beats native HTML5 Drag & Drop:
 * - Native `draggable="true"` / `ondrop` creates translucent browser drag snapshots that frequently glitch
 *   or clip inside `overflow-hidden` viewport overlays, fail to trigger cleanly immediately after Pointer Lock
 *   releases, and do not report cursor coordinates continuously for custom floating ghosts.
 * - Tracking `DragState` with a `6px` deadzone seamlessly unifies single-click equip and drag-to-dock equip
 *   inside one pointer lifecycle, while `onMouseDown={(e) => e.stopPropagation()}` keeps clicks inside the
 *   inventory from accidentally firing shots or re-locking the pointer on the 3D canvas underneath.
 */
import React, { useEffect, useRef, useState } from 'react';
import { GripVertical, ShieldAlert, X } from 'lucide-react';
import { GRENADES } from '../data/arsenal';
import {
  GrenadeId,
  GrenadeProfile,
  SimulationConfig,
  WeaponProfile,
  WeaponSlot,
} from '../types/ballistics';

/** Descriptor stored in `hoveredItemRef` so releasing `[E]` equips whichever card the pointer sits on. */
export interface InventoryHoverItem {
  slot: WeaponSlot;
  id: string;
  label: string;
}

interface ViewportInventoryModalProps {
  /** Active simulation config holding current `primaryWeaponId`, `secondaryWeaponId`, `grenadeId`, and `activeSlot`. */
  config: SimulationConfig;
  /** Live weapon array; reflects Armory edits and shows current per-weapon ammo below. */
  weapons: WeaponProfile[];
  /** Live consumable ordnance array. */
  grenades?: GrenadeProfile[];
  /** Remaining charge count per consumable ID. */
  consumableUsages: Record<GrenadeId, number>;
  /** Saved `(mag, reserve)` state per weapon ID so non-equipped guns retain partial magazines. */
  weaponAmmoMap: Record<string, { mag: number; reserve: number }>;
  /** Shared mutable ref read by `SimulationCanvas3D`'s `keyup` `[E]` handler to equip on key release. */
  hoveredItemRef: React.MutableRefObject<InventoryHoverItem | null>;
  /** Equips a Primary/Secondary weapon and updates its active slot & ammo state in `App.tsx`. */
  onEquipWeapon: (slot: 'PRIMARY' | 'SECONDARY', weaponId: string) => void;
  /** Selects a consumable ordnance item and switches active hand to `CONSUMABLE`. */
  onEquipConsumable: (grenadeId: GrenadeId) => void;
  /** Closes the inventory overlay and lets the operator resume combat. */
  onClose: () => void;
}

interface DragState {
  item: InventoryHoverItem;
  code: string;
  accentHex: string;
  startX: number;
  startY: number;
  curX: number;
  curY: number;
  active: boolean;
}

/**
 * Overlay arsenal cache rendered inside the 3D viewport when `[E]` opens the inventory.
 */
export const ViewportInventoryModal: React.FC<ViewportInventoryModalProps> = ({
  config,
  weapons,
  grenades = GRENADES,
  consumableUsages,
  weaponAmmoMap,
  hoveredItemRef,
  onEquipWeapon,
  onEquipConsumable,
  onClose,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dockRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [hoverDropSlot, setHoverDropSlot] = useState<WeaponSlot | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [recentEquippedId, setRecentEquippedId] = useState<string | null>(null);

  const primaryWeapons = weapons.filter((w) => w.slot === 'PRIMARY');
  const secondaryWeapons = weapons.filter((w) => w.slot === 'SECONDARY');
  const equippedPrimary = primaryWeapons.find((w) => w.id === config.primaryWeaponId) ?? primaryWeapons[0];
  const equippedSecondary =
    secondaryWeapons.find((w) => w.id === config.secondaryWeaponId) ?? secondaryWeapons[0];
  const equippedConsumable = grenades.find((g) => g.id === config.grenadeId) ?? grenades[2] ?? grenades[0];

  /** Commits the chosen weapon or consumable and flashes a 650ms emerald highlight on the card. */
  const triggerEquip = (item: InventoryHoverItem) => {
    if (item.slot === 'CONSUMABLE') {
      onEquipConsumable(item.id as GrenadeId);
    } else {
      onEquipWeapon(item.slot, item.id);
    }
    setRecentEquippedId(item.id);
    window.setTimeout(() => {
      setRecentEquippedId((prev) => (prev === item.id ? null : prev));
    }, 650);
  };

  // Clear stale hover target on mount/unmount so releasing [E] after closing never triggers unintended swaps.
  useEffect(() => {
    hoveredItemRef.current = null;
    return () => {
      hoveredItemRef.current = null;
    };
  }, [hoveredItemRef]);

  // Global window pointer listeners handle dragging smoothly even if cursor leaves card bounds.
  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      setDrag((prev) => {
        if (!prev) return null;
        const dist = Math.hypot(e.clientX - prev.startX, e.clientY - prev.startY);
        const isNowActive = prev.active || dist > 6;

        if (dockRef.current) {
          const rect = dockRef.current.getBoundingClientRect();
          const insideDock =
            e.clientX >= rect.left - 8 &&
            e.clientX <= rect.right + 8 &&
            e.clientY >= rect.top - 8 &&
            e.clientY <= rect.bottom + 14;
          setHoverDropSlot(insideDock ? prev.item.slot : null);
        }

        return {
          ...prev,
          curX: e.clientX,
          curY: e.clientY,
          active: isNowActive,
        };
      });
    };

    const handleUp = (e: MouseEvent) => {
      setDrag((prev) => {
        if (!prev) {
          // If user held LMB from outside a card and released over an item card, equip hovered item
          if (hoveredItemRef.current) {
            triggerEquip(hoveredItemRef.current);
          }
          return null;
        }

        const dockRect = dockRef.current?.getBoundingClientRect();
        const droppedInDock =
          dockRect &&
          e.clientX >= dockRect.left - 8 &&
          e.clientX <= dockRect.right + 8 &&
          e.clientY >= dockRect.top - 8 &&
          e.clientY <= dockRect.bottom + 14;

        // Treat movement <=6px as an immediate click-to-equip; >6px drops onto dock or target card.
        const isClick = !prev.active;
        if (isClick || droppedInDock) {
          triggerEquip(prev.item);
        } else if (
          hoveredItemRef.current &&
          hoveredItemRef.current.id !== prev.item.id
        ) {
          triggerEquip(hoveredItemRef.current);
        }
        setHoverDropSlot(null);
        return null;
      });
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  });

  /** Formats saved mag/reserve counts (or full default mag/reserve if weapon hasn't been drawn yet). */
  const getWeaponAmmoDisplay = (w: WeaponProfile) => {
    if (w.weaponClass === 'MELEE') return 'MELEE';
    const saved = weaponAmmoMap[w.id];
    const mag = saved ? saved.mag : w.magSize;
    const res = saved ? saved.reserve : Math.max(0, (w.maxMagazines - 1) * w.magSize);
    return `${mag}/${res}`;
  };

  const renderWeaponCard = (w: WeaponProfile, slot: 'PRIMARY' | 'SECONDARY') => {
    const isEquipped =
      slot === 'PRIMARY'
        ? config.primaryWeaponId === w.id
        : config.secondaryWeaponId === w.id;
    const isActiveInHand = isEquipped && config.activeSlot === slot;
    const isHovered = hoveredId === w.id;
    const isJustEquipped = recentEquippedId === w.id;
    const accent = slot === 'PRIMARY' ? '#ffb300' : '#00f0ff';
    const dmgLabel =
      w.weaponClass === 'MELEE' && w.melee
        ? `${w.melee.comboSteps[0].damage}/${w.melee.specialDamage}`
        : w.pellets > 1
          ? `${w.baseDamage}x${w.pellets}`
          : `${w.baseDamage}`;

    return (
      <div
        key={w.id}
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          const item: InventoryHoverItem = { slot, id: w.id, label: w.name };
          hoveredItemRef.current = item;
          setDrag({
            item,
            code: w.code,
            accentHex: accent,
            startX: e.clientX,
            startY: e.clientY,
            curX: e.clientX,
            curY: e.clientY,
            active: false,
          });
        }}
        onMouseEnter={() => {
          setHoveredId(w.id);
          hoveredItemRef.current = { slot, id: w.id, label: w.name };
        }}
        onMouseLeave={() => {
          setHoveredId((prev) => (prev === w.id ? null : prev));
          if (hoveredItemRef.current?.id === w.id) {
            hoveredItemRef.current = null;
          }
        }}
        className={`group border px-2 py-1.5 transition-colors cursor-grab active:cursor-grabbing ${
          isJustEquipped
            ? 'bg-[#20df78]/20 border-[#20df78]'
            : isActiveInHand
              ? 'bg-[#1a2233] border-[#ffb300]'
              : isEquipped
                ? 'bg-[#151c29] border-[#00f0ff]/60'
                : isHovered
                  ? 'bg-[#171f2e] border-[#5c7091]'
                  : 'bg-[#0f141d] border-[#1e2638]'
        }`}
      >
        <div className="flex items-center justify-between gap-1 font-mono text-[9px] tabular-nums">
          <div className="flex items-center gap-1 min-w-0">
            <GripVertical size={10} className="text-[#606f89] shrink-0" />
            <span style={{ color: accent }} className="font-bold">
              {w.code}
            </span>
            <span className="text-[#8c9bb5] truncate">{w.category}</span>
          </div>
          <span
            className={`font-bold shrink-0 ${
              isActiveInHand
                ? 'text-[#20df78]'
                : isEquipped
                  ? 'text-[#00f0ff]'
                  : 'text-[#8c9bb5]'
            }`}
          >
            {isActiveInHand ? 'ACTIVE' : isEquipped ? 'EQUIPPED' : getWeaponAmmoDisplay(w)}
          </span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-1">
          <span className="font-display text-[11px] font-semibold text-[#e1e2ea] truncate">
            {w.name}
          </span>
          <span className="font-mono text-[9px] text-[#ffb300] tabular-nums shrink-0">
            {dmgLabel}
          </span>
        </div>
      </div>
    );
  };

  return (
    <div
      ref={containerRef}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      className="absolute inset-0 z-30 bg-[#0a0d12]/92 flex flex-col p-3 sm:p-4 overflow-hidden select-none"
    >
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-[#1e2638]">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-[#ffb300]">
            Arsenal Field Cache // [E] Inventory
          </div>
          <div className="font-mono text-[10px] text-[#8c9bb5]">
            Drag any weapon or consumable to the Equipped Loadout Dock (or click) to equip · Hold E + hover + release also equips
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="px-2.5 py-1 border border-[#ffb300] bg-[#ffb300]/15 text-[#ffb300] hover:bg-[#ffb300] hover:text-[#0a0d12] font-mono text-[10px] font-bold uppercase tracking-[0.08em] flex items-center gap-1 cursor-pointer transition-colors"
        >
          <X size={12} />
          <span>CLOSE [E]</span>
        </button>
      </div>

      {/* Equipped Loadout Drop Dock */}
      <div
        ref={dockRef}
        className="grid grid-cols-3 gap-2 my-2.5 shrink-0"
      >
        {/* Primary Drop Zone */}
        <div
          className={`border p-2 transition-all ${
            drag?.active && drag.item.slot === 'PRIMARY'
              ? hoverDropSlot === 'PRIMARY'
                ? 'border-[#20df78] bg-[#20df78]/20'
                : 'border-dashed border-[#ffb300] bg-[#ffb300]/10'
              : config.activeSlot === 'PRIMARY'
                ? 'border-[#ffb300] bg-[#171d2a]'
                : 'border-[#232d42] bg-[#0f141d]'
          }`}
        >
          <div className="flex items-center justify-between font-mono text-[9px] uppercase">
            <span className="text-[#ffb300] font-bold">PRIMARY [1]</span>
            <span className="text-[#8c9bb5] tabular-nums">
              {drag?.active && drag.item.slot === 'PRIMARY'
                ? 'DROP TO EQUIP'
                : getWeaponAmmoDisplay(equippedPrimary)}
            </span>
          </div>
          <div className="mt-0.5 font-display text-xs font-bold text-[#e1e2ea] truncate">
            {equippedPrimary.name}
          </div>
        </div>

        {/* Secondary Drop Zone */}
        <div
          className={`border p-2 transition-all ${
            drag?.active && drag.item.slot === 'SECONDARY'
              ? hoverDropSlot === 'SECONDARY'
                ? 'border-[#20df78] bg-[#20df78]/20'
                : 'border-dashed border-[#00f0ff] bg-[#00f0ff]/10'
              : config.activeSlot === 'SECONDARY'
                ? 'border-[#00f0ff] bg-[#171d2a]'
                : 'border-[#232d42] bg-[#0f141d]'
          }`}
        >
          <div className="flex items-center justify-between font-mono text-[9px] uppercase">
            <span className="text-[#00f0ff] font-bold">SECONDARY [2]</span>
            <span className="text-[#8c9bb5] tabular-nums">
              {drag?.active && drag.item.slot === 'SECONDARY'
                ? 'DROP TO EQUIP'
                : getWeaponAmmoDisplay(equippedSecondary)}
            </span>
          </div>
          <div className="mt-0.5 font-display text-xs font-bold text-[#e1e2ea] truncate">
            {equippedSecondary.name}
          </div>
        </div>

        {/* Consumable Drop Zone */}
        <div
          className={`border p-2 transition-all ${
            drag?.active && drag.item.slot === 'CONSUMABLE'
              ? hoverDropSlot === 'CONSUMABLE'
                ? 'border-[#20df78] bg-[#20df78]/20'
                : 'border-dashed border-[#20df78] bg-[#20df78]/10'
              : config.activeSlot === 'CONSUMABLE'
                ? 'border-[#20df78] bg-[#171d2a]'
                : 'border-[#232d42] bg-[#0f141d]'
          }`}
        >
          <div className="flex items-center justify-between font-mono text-[9px] uppercase">
            <span className="text-[#20df78] font-bold">CONSUMABLE [MMB]</span>
            <span className="text-[#e1e2ea] tabular-nums font-bold">
              {drag?.active && drag.item.slot === 'CONSUMABLE'
                ? 'DROP TO EQUIP'
                : `${consumableUsages[equippedConsumable.id] ?? 0}/${equippedConsumable.maxUsages}`}
            </span>
          </div>
          <div
            className="mt-0.5 font-display text-xs font-bold truncate"
            style={{ color: equippedConsumable.accentHex }}
          >
            {equippedConsumable.shortLabel}
          </div>
        </div>
      </div>

      {/* 3-Column Armory Grid */}
      <div className="grid grid-cols-3 gap-2.5 flex-1 min-h-0">
        {/* Primary Weapons Column */}
        <div className="flex flex-col min-h-0 border border-[#1e2638] bg-[#121721]/80 p-2">
          <div className="flex items-center justify-between pb-1.5 mb-1.5 border-b border-[#1e2638] font-mono text-[10px] uppercase">
            <span className="text-[#ffb300] font-bold">Primary Weapons</span>
            <span className="text-[#8c9bb5]">{primaryWeapons.length}</span>
          </div>
          <div className="space-y-1.5 overflow-y-auto pr-1 flex-1">
            {primaryWeapons.map((w) => renderWeaponCard(w, 'PRIMARY'))}
          </div>
        </div>

        {/* Secondary Weapons Column */}
        <div className="flex flex-col min-h-0 border border-[#1e2638] bg-[#121721]/80 p-2">
          <div className="flex items-center justify-between pb-1.5 mb-1.5 border-b border-[#1e2638] font-mono text-[10px] uppercase">
            <span className="text-[#00f0ff] font-bold">Secondary Weapons</span>
            <span className="text-[#8c9bb5]">{secondaryWeapons.length}</span>
          </div>
          <div className="space-y-1.5 overflow-y-auto pr-1 flex-1">
            {secondaryWeapons.map((w) => renderWeaponCard(w, 'SECONDARY'))}
          </div>
        </div>

        {/* Consumable Ordnance Column */}
        <div className="flex flex-col min-h-0 border border-[#1e2638] bg-[#121721]/80 p-2">
          <div className="flex items-center justify-between pb-1.5 mb-1.5 border-b border-[#1e2638] font-mono text-[10px] uppercase">
            <span className="text-[#20df78] font-bold">Consumables</span>
            <span className="text-[#8c9bb5]">{grenades.length}</span>
          </div>
          <div className="space-y-1.5 overflow-y-auto pr-1 flex-1">
            {grenades.map((grn) => {
              const curUses = consumableUsages[grn.id] ?? 0;
              const isSelected = config.grenadeId === grn.id;
              const isInHand = isSelected && config.activeSlot === 'CONSUMABLE';
              const isHovered = hoveredId === grn.id;
              const isJustEquipped = recentEquippedId === grn.id;
              return (
                <div
                  key={grn.id}
                  onMouseDown={(e) => {
                    if (e.button !== 0) return;
                    e.preventDefault();
                    const item: InventoryHoverItem = {
                      slot: 'CONSUMABLE',
                      id: grn.id,
                      label: grn.shortLabel,
                    };
                    hoveredItemRef.current = item;
                    setDrag({
                      item,
                      code: grn.code,
                      accentHex: grn.accentHex,
                      startX: e.clientX,
                      startY: e.clientY,
                      curX: e.clientX,
                      curY: e.clientY,
                      active: false,
                    });
                  }}
                  onMouseEnter={() => {
                    setHoveredId(grn.id);
                    hoveredItemRef.current = {
                      slot: 'CONSUMABLE',
                      id: grn.id,
                      label: grn.shortLabel,
                    };
                  }}
                  onMouseLeave={() => {
                    setHoveredId((prev) => (prev === grn.id ? null : prev));
                    if (hoveredItemRef.current?.id === grn.id) {
                      hoveredItemRef.current = null;
                    }
                  }}
                  className={`border px-2 py-1.5 transition-colors cursor-grab active:cursor-grabbing ${
                    isJustEquipped
                      ? 'bg-[#20df78]/20 border-[#20df78]'
                      : isInHand
                        ? 'bg-[#1a2433] border-[#20df78]'
                        : isSelected
                          ? 'bg-[#151c29]'
                          : isHovered
                            ? 'bg-[#171f2e] border-[#5c7091]'
                            : 'bg-[#0f141d] border-[#1e2638]'
                  }`}
                  style={
                    isSelected && !isInHand && !isJustEquipped
                      ? { borderColor: grn.accentHex }
                      : undefined
                  }
                >
                  <div className="flex items-center justify-between gap-1 font-mono text-[9px] tabular-nums">
                    <div className="flex items-center gap-1 min-w-0">
                      <GripVertical size={10} className="text-[#606f89] shrink-0" />
                      <span style={{ color: grn.accentHex }} className="font-bold">
                        {grn.code}
                      </span>
                      <span className="text-[#8c9bb5] truncate">{grn.radiusM}M</span>
                    </div>
                    <span
                      className={`font-bold shrink-0 ${
                        curUses === 0
                          ? 'text-[#ff2a4b]'
                          : curUses === grn.maxUsages
                            ? 'text-[#20df78]'
                            : 'text-[#ffb300]'
                      }`}
                    >
                      {curUses}/{grn.maxUsages}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center justify-between gap-1">
                    <span className="font-display text-[11px] font-semibold text-[#e1e2ea] truncate">
                      {grn.shortLabel}
                    </span>
                    <span className="font-mono text-[9px] text-[#8c9bb5] tabular-nums shrink-0">
                      {grn.id === 'deployable_turret' ? `${grn.damage}x10/s` : `${grn.damage} DMG`}
                    </span>
                  </div>
                  {curUses === 0 && (
                    <div className="mt-0.5 flex items-center gap-1 font-mono text-[8px] text-[#ff2a4b]">
                      <ShieldAlert size={9} />
                      <span>DEPLETED · LOOT DROP</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Floating Drag Ghost Preview */}
      {drag?.active && (
        <div
          className="fixed z-50 pointer-events-none px-2.5 py-1.5 border bg-[#0a0d12]/95 font-mono text-[10px] shadow-[0_6px_18px_rgba(0,0,0,0.8)]"
          style={{
            left: drag.curX + 12,
            top: drag.curY + 12,
            borderColor: drag.accentHex,
          }}
        >
          <span style={{ color: drag.accentHex }} className="font-bold mr-1.5">
            {drag.code}
          </span>
          <span className="text-[#e1e2ea] font-semibold">{drag.item.label}</span>
        </div>
      )}
    </div>
  );
};
