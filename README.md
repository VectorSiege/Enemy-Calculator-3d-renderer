# Aegis Tactical Telemetry — 3D Combat & Ballistics Sandbox

## Why This Project Exists: Fighting Back Against Tedious Modern Design

Far too many modern action and shooter games suffer from a fundamental misunderstanding of combat pacing: **not every enemy on the battlefield should feel like a mini-boss.**

Across contemporary releases, developers routinely inflate even basic, everyday fodder enemies into absurd bullet sponges—turning routine skirmishes into exhausting wars of attrition—while handing players deliberately lackluster, peashooter weapons with punishing falloff, sluggish handling, and anemically tuned damage numbers. Instead of creating satisfying flow, tactical clarity, and crisp risk-reward feedback, modern games frequently seem engineered to be **more frustrating than enjoyable**, leaving players feeling miserable and worn down rather than empowered.

Worse still, that artificially manufactured frustration is often paired with aggressive monetization—expecting players to pay extra real-world money (sometimes costing **more than two weeks' worth of groceries**) just to unlock basic features, decent gear, loadouts, or quality-of-life mechanics that should have shipped in the box from day one.

**As such, Aegis Tactical Telemetry was built around the exact opposite philosophy:**

1. **Weapons Should Actually Feel Lethal and Responsive:** Firearms pack punchy per-shot damage, clean logarithmic range falloff, genuine multi-target penetration, crisp weakspot multipliers, and controllable recoil. Heavy melee arms (*Maelstrom War-Hammer* and *Valken Pole-Halberd*) reward positioning with sweeping AoE cleaves, directional charge scaling, and high-impact shoves that immediately punish encroaching threats.
2. **Clear Enemy Archetypes Instead of Uniform Sponges:** Enemies are differentiated by clear battlefield roles rather than slapping boss health bars onto everything:
   - **Skitter Flanking Swarmers** (`120 HP`, `7.0 m/s`): Scaled-up (`+60%` silhouette) agile flankers that split apart to encircle the operator, sprint around camera blindspots, strike (`7 / 11 DMG`), and break contact after attacking.
   - **Vanguard Shield Drones** (`135 HP`): Hovering rear-line units firing arcing plasma bolts from afar without cheap melee rushdown.
   - **Stalker Recon Mechs** (`160 HP`): Agile striders weaving and lunging into close range.
   - **Aegis Heavy Exo-Frames** (`440 HP`): Armored frontline troopers with clear visor weakspots and stagger windows.
   - **Ravager Ferocious Brutes** (`560 HP`): Aggressive sub-titan hunters that close distance rapidly and relentlessly press melee pressure.
   - **Chitinous Bio-Titans** (`900 HP`) & **Bastion Siege Juggernauts** (`1250 HP`): Rare apex siege units earned through distinct silhouette, slow/telegraphed strikes, and rewarding stagger breakthroughs—not copied onto every basic grunt.
3. **Full Transparency & Calibration Included Free in the Box:** Every weapon stat, enemy HP pool, stagger threshold, weakspot multiplier, room layout, and wave size (`24` Wave-1 baseline, up to `120` hostiles, auto-scaling `+50%` per wave) is exposed directly to the user in real time—no paywalls, no artificial grind, and no locked sliders.

---

## Core Combat & Simulation Features

### Weapons & Ordnance
- **Primary Slot `[1]`, Secondary Slot `[2]`, & Consumable Slot `[G]`**: Equip firearms, heavy melee weapons, or tactical consumables in hand via **`1 / 2 / G`** or **Mouse Scroll Wheel** without interrupting active combat waves.
- **Ranged Penetration, Magazine Reserves & Reflected Logarithmic Falloff**:
  - Concave-down reflected logarithmic falloff starting at `10m` across rifles, pistols, SMGs, DMRs, snipers, shotguns, and machine guns.
  - Balanced magazine reserves (`6` Primary mags, `12` Sniper/DMR mags, half for Secondary sidearms, `3–4` LMG/GPMG/Plasma drums) and an interruptible `1.8s`/shell reload animation on the **SG-12 Tempest Breacher** (`42 × 32` pellets, `3.47°` spread, `1.1m` penetration).
  - **BR-18 Ironclad Battle Rifle** (`850 RPM` semi-precision) fires as rapidly as the operator taps Left Mouse Button.
- **Heavy Melee Arms**:
  - **Maelstrom War-Hammer**: 3-step animated diagonal/sweep combo (`90 / 90 / 75 DMG` with `+80%` finisher stagger), partial-to-full `1.2s` overhead special slam (`230 DMG`), and `70 DMG / 220 Stagger` right-click shove.
  - **Valken Pole-Halberd**: Thrust-pull-cleave cadence (`50 / 80 / 130 AoE DMG`), `0.7s` special two-hit sweeping strike (`70 AoE DMG`), and `60 DMG / 250 Stagger` shove.
- **7 Tactical Consumables (`[3–9]` Select, `[G]`/Wheel Equip in Hand, `[RMB]` Throw/Deploy, `-80%` Cooldown)**:
  - `[3]` **Arc Flash-Stun Grenade**: Triggers immediate posture break across `5.2m` with **+100% prolonged stagger duration**.
  - `[4]` **Thermite Incendiary Canister**: `0.6s` enemy-hit fuse bursting into **4 clustered fire circles** (`4.0m–5.4m` radius each), dealing `148` instant DMG, full `96` DoT per tick, and slowing caught hostiles by **`60%`**. Enemies disperse around flames, retreat if caught inside, and dodge grenades spotted ahead.
  - `[5]` **M-82 High-Explosive Frag**: Massive `340 DMG` AoE blast within `6.0m` plus door-breaching shockwave impulse.
  - `[6]` **TM-4 Proximity Trip Mine**: Floor-planted mine triggering a `1000 DMG` blast across a `5.0m` radius.
  - `[7]` **LTM-12 Wall Laser Trip Mine**: Mounts flush on walls (or floors) projecting a `12m` trip beam and an upward cone blast (`1200 – 400 DMG` over `12m`).
  - `[8]` **C4 Sticky Remote Explosive**: Adheres to walls, doors, floors, or moving hostiles; press **Middle Mouse Button (`MMB`)** to detonate all planted charges.
  - `[9]` **AST-60 Sentry Turret**: Automated tripod turret firing `36 DMG` rounds at `600 RPM` across a `90°` (`±45°`) horizontal cone and `-15°` to `+36°` elevation.
  - Friendly blasts & flames apply **90% reduced self-damage** (`0.1x`) to the operator.

### Procedural 3D Arenas & Persistent Doors
- **RM-01 Single Ballistic Corridor (`24m × 120m`)**: Reinforced walled firing lane where waves split into **4 difficulty-tiered groups** staggered at **`6.0s` per group** behind the north blast door (`12.0s` cooldown between waves).
- **RM-02 Double Flank Chambers**: Asymmetrical arena featuring two breakable grey flank doors (`6.0s` spawn stagger) and a sealed blue aesthetic entryway behind the operator.
- **Persistent Destruction**: Doors breached during combat never repair or respawn upon starting a new wave—staying open until you switch rooms or click Respawn Squad.

### Survival, Vision & HUD Telemetry
- **Stagger & Multi-Group Spawning**: Incoming squads divide into difficulty-tiered sub-groups (`VANGUARD`, `ASSAULT`, `HEAVY`, `APEX`). Sustained trauma triggers visible stagger vulnerability stacking `staggerDamageMultiplier` on top of zone multipliers.
- **Tactical Flashlight `[F]`**: Cycles between off, tight high-intensity spotlight (`6x` beam boost), and wide flood beam (`4x` floodlight) through dense arena fog and dynamic non-flickering ambient lighting.
- **Operator Mobility & Survival**: Enhanced `+25%` sprint velocity (`12.75 m/s`), `5s` out-of-combat window enabling passive `+4 HP/s` recovery up to `40% HP`, plus `[Q]` Medic Kit (`+40% HP`, `12s` cooldown).
- **World-Anchored Floating Damage Popups, Magazine/Reserve Counters & Consumable HUD**: Toggleable outside the 3D viewport alongside Fullscreen and Pause controls.

---

## Keybinds & Controls

| Input | Action |
| :--- | :--- |
| **W A S D / Arrows** | Move Operator |
| **Shift** | Sprint (`12.75 m/s`) |
| **Mouse Look** | Aim Camera (click viewport to lock pointer) |
| **Left Click (LMB)** | Fire Weapon / 3-Step Melee Attack (hold LMB for Melee Special Charge) |
| **Right Click (RMB)** | Throw / Deploy Consumable (when in hand) · ADS (Ranged) · Shove (Melee) |
| **Middle Click (MMB)** | Detonate All Planted Sticky Remote C4 Charges |
| **1 / 2 / G / Scroll Wheel** | Switch Primary / Secondary / Consumable Slot |
| **3 – 9** | Select Consumable (Stun, Incendiary, Explosive, Trip Mine, Laser Mine, C4, Turret) |
| **R** | Manual Reload (Interruptible shell-by-shell on Shotgun) |
| **Q** | Use Medic Kit (`+40% HP`) |
| **F** | Cycle Tactical Flashlight (Spot -> Flood -> Off) |
| **Ctrl** | Toggle Free Cursor / Pointer Lock |
| **Esc** | Toggle Pause Menu |

---

## Development Setup

```bash
npm install
npm run dev
```

Build and lint check:

```bash
npm run build
npm run lint
```
