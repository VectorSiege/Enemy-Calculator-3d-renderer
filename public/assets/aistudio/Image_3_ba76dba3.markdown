---
name: Aegis Tactical Telemetry
colors:
  surface: '#111319'
  surface-dim: '#111319'
  surface-bright: '#36393f'
  surface-container-lowest: '#0b0e13'
  surface-container-low: '#191c21'
  surface-container: '#1d2025'
  surface-container-high: '#272a30'
  surface-container-highest: '#32353b'
  on-surface: '#e1e2ea'
  on-surface-variant: '#d6c4ac'
  inverse-surface: '#e1e2ea'
  inverse-on-surface: '#2e3036'
  outline: '#9e8e78'
  outline-variant: '#514532'
  surface-tint: '#ffba38'
  primary: '#ffd79b'
  on-primary: '#432c00'
  primary-container: '#ffb300'
  on-primary-container: '#6b4900'
  inverse-primary: '#7e5700'
  secondary: '#d3fbff'
  on-secondary: '#00363a'
  secondary-container: '#00eefc'
  on-secondary-container: '#00686f'
  tertiary: '#ffd3d2'
  on-tertiary: '#680015'
  tertiary-container: '#ffabac'
  on-tertiary-container: '#a20026'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#ffdeac'
  primary-fixed-dim: '#ffba38'
  on-primary-fixed: '#281900'
  on-primary-fixed-variant: '#604100'
  secondary-fixed: '#7df4ff'
  secondary-fixed-dim: '#00dbe9'
  on-secondary-fixed: '#002022'
  on-secondary-fixed-variant: '#004f54'
  tertiary-fixed: '#ffdad9'
  tertiary-fixed-dim: '#ffb3b3'
  on-tertiary-fixed: '#400009'
  on-tertiary-fixed-variant: '#920021'
  background: '#111319'
  on-background: '#e1e2ea'
  surface-variant: '#32353b'
typography:
  headline-xl:
    fontFamily: Space Grotesk
    fontSize: 40px
    fontWeight: '700'
    lineHeight: 48px
    letterSpacing: 0.04em
  headline-xl-mobile:
    fontFamily: Space Grotesk
    fontSize: 28px
    fontWeight: '700'
    lineHeight: 36px
    letterSpacing: 0.04em
  headline-lg:
    fontFamily: Space Grotesk
    fontSize: 28px
    fontWeight: '600'
    lineHeight: 36px
    letterSpacing: 0.03em
  headline-lg-mobile:
    fontFamily: Space Grotesk
    fontSize: 22px
    fontWeight: '600'
    lineHeight: 28px
    letterSpacing: 0.03em
  headline-md:
    fontFamily: Space Grotesk
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 26px
    letterSpacing: 0.02em
  body-lg:
    fontFamily: Geist
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-md:
    fontFamily: Geist
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  body-sm:
    fontFamily: Geist
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 18px
  label-lg:
    fontFamily: JetBrains Mono
    fontSize: 13px
    fontWeight: '600'
    lineHeight: 18px
    letterSpacing: 0.06em
  label-md:
    fontFamily: JetBrains Mono
    fontSize: 11px
    fontWeight: '500'
    lineHeight: 16px
    letterSpacing: 0.08em
  label-sm:
    fontFamily: JetBrains Mono
    fontSize: 10px
    fontWeight: '500'
    lineHeight: 14px
    letterSpacing: 0.1em
spacing:
  gutter: 1rem
  margin: 1.5rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 0.75rem
  space-lg: 1.25rem
  space-xl: 2rem
---

## Brand & Style
The design system embodies the clinical precision, high-stakes urgency, and uncompromising utility of modern sci-fi combat optics and advanced ballistic diagnostics. Built for tactical commanders, combat analysts, and simulator operators, the interface evokes the sensation of piloting an armored HUD or operating a specialized field terminal in hostile territory.

The visual direction fuses High-Contrast Military Brutalism with Diegetic Tactical Cyber-HUD paradigms:
- **Utilitarian Rigor:** Zero decorative fluff; every bevel, line, and readout serves telemetry, threat assessment, or combat calculation.
- **Combat-Grade Density:** Information density is elevated through modular telemetry readouts, reticle brackets, clipped corners, and tabular data matrices.
- **High-Alert Luminescence:** Controlled neon accents radiate out of deep obsidian and ballistic carbon backgrounds, instantly signaling target acquisition, critical failure, weapon state, and kinetic vulnerability.

## Colors
The palette leverages high-visibility HUD wavelengths over deeply saturated, radar-absorbent matte carbon substrates:

- **Primary (`#ffb300` - Cyber Amber):** Used for target lock indicators, ammunition counters, primary calculation controls, reticle crossbars, and prioritized system telemetry.
- **Secondary (`#00f0ff` - Neon Cyan):** Dedicated to active fire calculations, ballistic trajectory arcs, friendly unit designations, shield monitors, and active digital readouts.
- **Tertiary (`#ff2a4b` - Ballistic Red):** Reserved exclusively for enemy hitboxes, exposed organic/cybernetic weakspots, lethal damage thresholds, and critical malfunction alerts.
- **Auxiliary Tactical Green (`#20df78`):** Applied to nominal diagnostic statuses, armor integrity confirmation, optimal engagement ranges, and positive verification states.
- **Base Neutral (`#0a0d12` - Ballistic Carbon):** Deep void tint providing near-infinite contrast ratio for neon emissions. Secondary surface tiers scale through `#121721` (Tactical Slate) and `#1b2332` (Armor Plate Grey).

## Typography
Typography is split into three functional echelons:
1. **Command Display (`Space Grotesk`):** Handles section heads, module titles, and critical ballistic status badges. Rendered in uppercase or sharp casing with widened tracking.
2. **Operational Text (`Geist`):** Delivers clean, unhindered readability for combat breakdown narratives, tooltips, and weapon lore entries.
3. **Telemetry & Monospace Readouts (`JetBrains Mono`):** Powers all numeric telemetry, weapon DPS figures, coordinates, combat log timestamps, and input steppers. Tabular lining numbers (`tnum`) must remain strictly enforced across all numeric instances.

## Layout & Spacing
The layout follows an operator's multi-display console layout using a 12-column rigid modular grid.
