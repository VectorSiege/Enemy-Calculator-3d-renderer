# Aegis Tactical Telemetry — 3D Combat & Ballistics Sandbox

## Design goals

The idea was to create a immersive sandbox where users can toggle from multiple weapon parameters to different enemy parameter to suit or modify how a weapon changes a person's play style.

Games nowadays have a tendency to make even normal enemies difficult to neutralize with basic weapons and players tend to suffer and the game loses its enjoyment. These issues stem from a developer standpoint that an enemy should be difficult to take down, and makes them harder to defeat with the minimum requirement.
Players aren't fighting a single enemy, but a group or a swarm of them.

A game is meant to be a form of entertainment to have fun, challenge yourself, relief stress and most importantly, not become frustrated.

By having multiple weapons, enemies, and 2 levels, the player is free to test and modify to how they see fit.

Enemies in this application were designed to be slow but smart in some aspects to prioritize certain targets.

**Aegis Tactical Telemetry was built around the exact opposite philosophy:**

1. Weapons were designed to dish out damage, not expend your entire magazine for a single enemy. Different weapons allow you to play differently, opening up new play styles and an opportunity to strike back. 
2. Multiple types of enemy that are designed to be difficult, but not bullet sponges.
3. Immerse yourself in testing by fighting them individually or by engaging them in groups to get immersed in the chaos. 

---

## Core Combat & Simulation Features

### Weapons & Ordnance
- **Primary Slot** is for weapons that deal damage to a single target or multiple targets that are within short to medium range. 
- **Secondary Slot** is for weapons that specialize in dealing more damage to specific groups or target that are in varying ranges.
- **Consumable Slot** is for weapons that can be thrown or deployed, and maybe even picked back up for later use. These weapons are meant for tactical use against large groups or priority target. 

### Breakable or destructible objects.
- enemies have **internal components** that can be destroyed to quickly neutralize them
- doors and barricades are destructible

### User Interface & HUD Telemetry
- Health bar to show you and your enemy their total or remaining health.
- damage pop up shows how much damage is done every hit to areas of the enemy.
- Map Heads-Up Display shows how many enemy is coming towards the player relative to a player's position.
- Ammo counter for knowing how many rounds left in your current magazine and total remaining rounds.
- Inventory pauses the game while you pick which weapons you would like to obliterate your enemies with.
- Message pop up when picking up deployed weapons.
- Pause menu
- Different tabs to check different parameters.
---

## Keybinds & Controls

| Input | Action |
| :--- | :--- |
| **W A S D / Arrows** | Move Operator |
| **Shift** | Sprint (`12.75 m/s`) |
| **Mouse Look** | Aim Camera (click viewport to lock pointer) |
| **Left Click (LMB)** | Fire Weapon / 3-Step Melee Attack (hold LMB for Melee Special Charge) |
| **Right Click (RMB)** | Throw / Deploy Consumable (when in hand) · ADS (Ranged) · Shove (Melee) |
| **Middle Mouse Button (MMB)** | Click to Detonate All Planted Sticky Remote C4 Charges, Hold and release to throw/use grenades and consumable weapons |
| **1 / 2 / G / Scroll Wheel** | Switch Primary / Secondary / Consumable Slot |
| **3 – 9** | Select Consumable (Stun, Incendiary, Explosive, Trip Mine, Laser Mine, C4, Turret) |
| **R** | Manual Reload (Interruptible shell-by-shell on Shotgun) |
| **Q** | Use Medic Kit (`+40% HP`) |
| **F** | Cycle Tactical Flashlight (Spot -> Flood -> Off) |
| **F11** | Enter or Exit Fullscreen |
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

## Credits

## Content
- Used Stitch Google for generating the prompt ideas
- Used Google AI Studio for generating the app with the prompts

## Acknowledgement and Inspirations
- GTFO for their weapons, weapon parameter, enemies, enemy parameter locations
- Far Cry 5 for the weapons and tactical weapon ideas such as AR-CL, grenades, C4
- Warhammer: Vermintide 2 for the melee weapon design and animations
- No More Rooms in Hell 2 for the idea to this project
