import * as THREE from 'three';
import { TargetProfile } from '../types/ballistics';

export interface BuiltWeapon3D {
  root: THREE.Group;
  muzzlePoint: THREE.Object3D;
  muzzleFlash: THREE.Mesh;
  opticOffset: THREE.Vector3; // local offset to align optic ring with camera (0,0)
  hipOffset: THREE.Vector3;
  isMelee: boolean;
  bladeRollGroup?: THREE.Group;
}

export interface BuiltEnemy3D {
  root: THREE.Group;
  bodyGroup: THREE.Group;
  leftLeg: THREE.Object3D;
  rightLeg: THREE.Object3D;
  leftClawArm: THREE.Group;
  rightClawArm: THREE.Group;
  weakspotMesh: THREE.Mesh;
  hitMeshes: THREE.Mesh[];
  weakspotHeight: number;
}

export function buildWeaponViewmodel3D(weaponId: string): BuiltWeapon3D {
  const root = new THREE.Group();

  const carbonMat = new THREE.MeshStandardMaterial({
    color: 0x161b24,
    roughness: 0.62,
    metalness: 0.55,
  });
  const gunmetalMat = new THREE.MeshStandardMaterial({
    color: 0x2c3647,
    roughness: 0.28,
    metalness: 0.88,
  });
  const forgedSteelMat = new THREE.MeshStandardMaterial({
    color: 0x5c687c,
    roughness: 0.24,
    metalness: 0.92,
  });
  const gripRubberMat = new THREE.MeshStandardMaterial({
    color: 0x11141a,
    roughness: 0.85,
    metalness: 0.12,
  });
  const accentAmberMat = new THREE.MeshStandardMaterial({
    color: 0xffb300,
    roughness: 0.32,
    metalness: 0.55,
    emissive: 0xffb300,
    emissiveIntensity: 0.35,
  });
  const cyanEmitterMat = new THREE.MeshStandardMaterial({
    color: 0x00f0ff,
    roughness: 0.2,
    metalness: 0.2,
    emissive: 0x00f0ff,
    emissiveIntensity: 1.4,
  });

  if (weaponId === 'maelstrom_hammer' || weaponId === 'valken_halberd') {
    const weaponRig = new THREE.Group();
    // Tilt slightly forward toward target so weapon silhouette reads clearly in 1st person
    weaponRig.rotation.set(-0.34, 0, 0.08);
    // Rolls shaft + head cleanly around its own longitudinal Y axis so sharp/hard face leads swings
    const bladeRollGroup = new THREE.Group();
    weaponRig.add(bladeRollGroup);

    const isHammer = weaponId === 'maelstrom_hammer';
    const shaftLen = isHammer ? 0.82 : 1.05;

    // 1. Primary reinforced haft / polearm shaft
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(isHammer ? 0.018 : 0.015, isHammer ? 0.02 : 0.017, shaftLen, 10),
      carbonMat
    );
    shaft.position.set(0, 0.14, 0);
    bladeRollGroup.add(shaft);

    // 2. Ergonomic grip wrap bands (high roughness contrast)
    const gripLower = new THREE.Mesh(
      new THREE.CylinderGeometry(0.022, 0.022, 0.16, 10),
      gripRubberMat
    );
    gripLower.position.set(0, -0.14, 0);
    bladeRollGroup.add(gripLower);

    const gripUpper = new THREE.Mesh(
      new THREE.CylinderGeometry(0.021, 0.021, 0.14, 10),
      gripRubberMat
    );
    gripUpper.position.set(0, 0.12, 0);
    bladeRollGroup.add(gripUpper);

    // 3. Pommel counterweight & shove spike
    const pommel = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.018, 0.055, 8), gunmetalMat);
    pommel.position.set(0, -shaftLen * 0.5 + 0.12, 0);
    bladeRollGroup.add(pommel);

    const buttSpike = new THREE.Mesh(new THREE.ConeGeometry(0.016, 0.065, 6), forgedSteelMat);
    buttSpike.rotation.x = Math.PI;
    buttSpike.position.set(0, -shaftLen * 0.5 + 0.065, 0);
    bladeRollGroup.add(buttSpike);

    // 4. Socket collar
    const headBaseY = shaftLen * 0.5 + 0.1;
    const collar = new THREE.Mesh(
      new THREE.BoxGeometry(0.052, 0.075, 0.052),
      gunmetalMat
    );
    collar.position.set(0, headBaseY - 0.03, 0);
    bladeRollGroup.add(collar);

    if (isHammer) {
      // 5. Massive Forged Hammer Head Block
      const headCore = new THREE.Mesh(
        new THREE.BoxGeometry(0.115, 0.125, 0.25),
        gunmetalMat
      );
      headCore.position.set(0, headBaseY + 0.04, -0.02);
      bladeRollGroup.add(headCore);

      // 6. Forward Kinetic Striking Face (-Z is the hard striking side)
      const strikeFace = new THREE.Mesh(
        new THREE.CylinderGeometry(0.068, 0.074, 0.045, 6),
        forgedSteelMat
      );
      strikeFace.rotation.x = Math.PI / 2;
      strikeFace.position.set(0, headBaseY + 0.04, -0.16);
      bladeRollGroup.add(strikeFace);

      // 7. Rear Armor-Piercing War-Pick Beak (+Z)
      const rearPick = new THREE.Mesh(
        new THREE.ConeGeometry(0.038, 0.14, 4),
        forgedSteelMat
      );
      rearPick.rotation.x = Math.PI / 2;
      rearPick.position.set(0, headBaseY + 0.04, 0.165);
      bladeRollGroup.add(rearPick);

      // 8. Amber Kinetic Capacitor Conduit Strips
      for (const side of [-1, 1]) {
        const conduit = new THREE.Mesh(
          new THREE.BoxGeometry(0.012, 0.032, 0.19),
          accentAmberMat
        );
        conduit.position.set(side * 0.06, headBaseY + 0.04, -0.02);
        bladeRollGroup.add(conduit);
      }

      const crownCap = new THREE.Mesh(
        new THREE.ConeGeometry(0.036, 0.07, 4),
        accentAmberMat
      );
      crownCap.position.set(0, headBaseY + 0.135, -0.02);
      bladeRollGroup.add(crownCap);
    } else {
      // Valken Pole-Halberd Head Assembly
      // 5. Elongated Diamond Spear Pike Tip (for lunges)
      const pikeTip = new THREE.Mesh(
        new THREE.ConeGeometry(0.028, 0.28, 4),
        forgedSteelMat
      );
      pikeTip.position.set(0, headBaseY + 0.16, 0);
      bladeRollGroup.add(pikeTip);

      // 6. Beveled Crescent Axe Blade oriented downward/forward on -Z side
      // (Rotated 180 deg from +Z top side so cutting edge sits at bottom/forward -Z)
      const bladeShape = new THREE.Shape();
      bladeShape.moveTo(0, 0.11);
      bladeShape.quadraticCurveTo(-0.17, 0.08, -0.2, -0.02);
      bladeShape.quadraticCurveTo(-0.18, -0.14, -0.02, -0.16);
      bladeShape.lineTo(0, -0.08);
      bladeShape.closePath();

      const bladeGeo = new THREE.ExtrudeGeometry(bladeShape, {
        depth: 0.012,
        bevelEnabled: true,
        bevelThickness: 0.005,
        bevelSize: 0.005,
        bevelSegments: 2,
      });
      bladeGeo.translate(0, 0, -0.006);
      const axeBlade = new THREE.Mesh(bladeGeo, forgedSteelMat);
      axeBlade.rotation.y = -Math.PI / 2;
      axeBlade.position.set(0, headBaseY + 0.02, -0.015);
      bladeRollGroup.add(axeBlade);

      // 7. Rear Armor-Hook Beak (+Z top side opposite blade)
      const rearHook = new THREE.Mesh(
        new THREE.ConeGeometry(0.02, 0.13, 4),
        forgedSteelMat
      );
      rearHook.rotation.x = Math.PI * 0.44;
      rearHook.position.set(0, headBaseY + 0.02, 0.075);
      bladeRollGroup.add(rearHook);

      // 8. Cyan Monomolecular Edge Trim seated along the -Z crescent blade edge & Cross Lugs
      const edgeTrim = new THREE.Mesh(
        new THREE.BoxGeometry(0.008, 0.17, 0.014),
        cyanEmitterMat
      );
      edgeTrim.rotation.x = -0.18;
      edgeTrim.position.set(0, headBaseY - 0.005, -0.205);
      bladeRollGroup.add(edgeTrim);

      const crossLug = new THREE.Mesh(
        new THREE.BoxGeometry(0.078, 0.02, 0.032),
        accentAmberMat
      );
      crossLug.position.set(0, headBaseY - 0.06, 0);
      bladeRollGroup.add(crossLug);
    }

    root.add(weaponRig);

    const muzzlePoint = new THREE.Object3D();
    muzzlePoint.position.set(0, headBaseY, -0.1);
    root.add(muzzlePoint);

    const muzzleFlash = new THREE.Mesh(
      new THREE.BoxGeometry(0.01, 0.01, 0.01),
      new THREE.MeshBasicMaterial({ visible: false })
    );
    muzzleFlash.visible = false;
    root.add(muzzleFlash);

    return {
      root,
      muzzlePoint,
      muzzleFlash,
      opticOffset: new THREE.Vector3(0.26, -0.26, -0.44),
      hipOffset: new THREE.Vector3(0.28, -0.27, -0.44),
      isMelee: true,
      bladeRollGroup,
    };
  }

  const reticleDotMat = new THREE.MeshBasicMaterial({
    color: 0x00f0ff,
  });
  const opticGlassMat = new THREE.MeshPhysicalMaterial({
    color: 0x0a1c28,
    roughness: 0.08,
    metalness: 0.1,
    transparent: true,
    opacity: 0.32,
  });

  // Main Receiver
  const receiverLen =
    weaponId === 'valkyrie_dmr'
      ? 0.54
      : weaponId === 'novacula_mg'
        ? 0.62
        : weaponId === 'kestrel_smg'
          ? 0.34
          : weaponId === 'choque_shotgun'
            ? 0.42
            : 0.44;
  const receiver = new THREE.Mesh(
    new THREE.BoxGeometry(0.068, 0.095, receiverLen),
    carbonMat
  );
  receiver.position.set(0, 0, 0);
  root.add(receiver);

  // Upper Picatinny Rail
  const rail = new THREE.Mesh(
    new THREE.BoxGeometry(0.036, 0.016, receiverLen * 0.92),
    gunmetalMat
  );
  rail.position.set(0, 0.055, -0.02);
  root.add(rail);

  // Handguard / Shroud
  const shroudLen =
    weaponId === 'valkyrie_dmr'
      ? 0.36
      : weaponId === 'kestrel_smg'
        ? 0.16
        : weaponId === 'choque_shotgun'
          ? 0.24
          : 0.28;
  const shroud = new THREE.Mesh(
    new THREE.BoxGeometry(0.062, 0.072, shroudLen),
    gunmetalMat
  );
  shroud.position.set(0, 0.008, -receiverLen * 0.5 - shroudLen * 0.42);
  root.add(shroud);

  // Barrel
  const barrelLen =
    weaponId === 'valkyrie_dmr'
      ? 0.52
      : weaponId === 'novacula_mg'
        ? 0.48
        : weaponId === 'kestrel_smg'
          ? 0.18
          : weaponId === 'choque_shotgun'
            ? 0.34
            : 0.32;
  const barrelRadius =
    weaponId === 'novacula_mg' ? 0.024 : weaponId === 'choque_shotgun' ? 0.021 : 0.013;
  const barrel = new THREE.Mesh(
    new THREE.CylinderGeometry(barrelRadius, barrelRadius * 1.15, barrelLen, 12),
    gunmetalMat
  );
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.015, -receiverLen * 0.5 - shroudLen * 0.5 - barrelLen * 0.45);
  root.add(barrel);

  // Underbarrel tubular magazine for shotgun
  if (weaponId === 'choque_shotgun') {
    const tubeMag = new THREE.Mesh(
      new THREE.CylinderGeometry(0.016, 0.016, barrelLen * 0.92, 10),
      carbonMat
    );
    tubeMag.rotation.x = Math.PI / 2;
    tubeMag.position.set(0, -0.022, -receiverLen * 0.5 - shroudLen * 0.5 - barrelLen * 0.4);
    root.add(tubeMag);
  }

  // Muzzle Brake / Choke
  const muzzleZ = -receiverLen * 0.5 - shroudLen * 0.5 - barrelLen * 0.92;
  const brake = new THREE.Mesh(
    new THREE.BoxGeometry(0.038, 0.038, 0.065),
    weaponId === 'novacula_mg' || weaponId === 'choque_shotgun' ? accentAmberMat : gunmetalMat
  );
  brake.position.set(0, 0.015, muzzleZ);
  root.add(brake);

  // Weapon-specific signature modules
  if (weaponId === 'm47_rail' || weaponId === 'helios_plasma') {
    const coilCount = weaponId === 'helios_plasma' ? 4 : 2;
    for (let i = 0; i < coilCount; i++) {
      const coil = new THREE.Mesh(
        new THREE.BoxGeometry(0.072, 0.022, 0.022),
        cyanEmitterMat
      );
      coil.position.set(0, 0.018, -receiverLen * 0.5 - 0.06 - i * 0.055);
      root.add(coil);
    }
  } else {
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(0.071, 0.012, 0.14),
      accentAmberMat
    );
    stripe.position.set(0, -0.01, -0.06);
    root.add(stripe);
  }

  // Pistol Grip + Magazine + Stock
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.044, 0.12, 0.052), carbonMat);
  grip.position.set(0, -0.085, 0.11);
  grip.rotation.x = 0.28;
  root.add(grip);

  const mag = new THREE.Mesh(
    new THREE.BoxGeometry(0.036, weaponId === 'helios_plasma' ? 0.13 : 0.14, 0.068),
    gunmetalMat
  );
  mag.position.set(0, -0.1, -0.05);
  mag.rotation.x = -0.15;
  root.add(mag);

  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.085, 0.24), carbonMat);
  stock.position.set(0, -0.01, receiverLen * 0.5 + 0.1);
  root.add(stock);

  // Optic Sight Housing (aligned to camera when ADS!)
  const opticY = 0.102;
  const opticZ = -0.02;
  const opticGroup = new THREE.Group();
  opticGroup.position.set(0, opticY, opticZ);

  const isLongScope = weaponId === 'valkyrie_dmr';
  if (isLongScope) {
    // Tubular Sniper Optic
    const tube = new THREE.Mesh(
      new THREE.CylinderGeometry(0.026, 0.026, 0.22, 16, 1, true),
      gunmetalMat
    );
    tube.rotation.x = Math.PI / 2;
    opticGroup.add(tube);

    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.023, 16), opticGlassMat);
    lens.position.z = -0.105;
    opticGroup.add(lens);

    // Crosshair lines inside scope
    const hLine = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.0014, 0.001), reticleDotMat);
    hLine.position.z = -0.1;
    const vLine = new THREE.Mesh(new THREE.BoxGeometry(0.0014, 0.038, 0.001), reticleDotMat);
    vLine.position.z = -0.1;
    opticGroup.add(hLine, vLine);
  } else {
    // Open Holographic Frame (left/right/top struts so sightline stays wide open)
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.014, 0.07), gunmetalMat);
    base.position.y = -0.032;
    const leftPost = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.052, 0.055), gunmetalMat);
    leftPost.position.set(-0.024, 0, 0);
    const rightPost = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.052, 0.055), gunmetalMat);
    rightPost.position.set(0.024, 0, 0);
    const topHood = new THREE.Mesh(new THREE.BoxGeometry(0.054, 0.007, 0.055), gunmetalMat);
    topHood.position.set(0, 0.026, 0);

    const lens = new THREE.Mesh(new THREE.PlaneGeometry(0.042, 0.044), opticGlassMat);
    lens.position.z = -0.01;

    // Glowing holographic center dot
    const dot = new THREE.Mesh(new THREE.BoxGeometry(0.0028, 0.0028, 0.002), reticleDotMat);
    dot.position.set(0, 0, -0.008);

    opticGroup.add(base, leftPost, rightPost, topHood, lens, dot);
  }
  root.add(opticGroup);

  // Muzzle Anchor & Flash
  const muzzlePoint = new THREE.Object3D();
  muzzlePoint.position.set(0, 0.015, muzzleZ - 0.04);
  root.add(muzzlePoint);

  const flashMat = new THREE.MeshBasicMaterial({
    color: weaponId === 'helios_plasma' ? 0x00f0ff : 0xffb300,
    transparent: true,
    opacity: 0.9,
  });
  const muzzleFlash = new THREE.Mesh(new THREE.OctahedronGeometry(0.065, 0), flashMat);
  muzzleFlash.scale.set(0.8, 0.8, 2.2);
  muzzleFlash.position.copy(muzzlePoint.position);
  muzzleFlash.visible = false;
  root.add(muzzleFlash);

  return {
    root,
    muzzlePoint,
    muzzleFlash,
    // Aligns opticGroup center directly with (0, 0) camera ray!
    opticOffset: new THREE.Vector3(0, -opticY, -0.24),
    hipOffset: new THREE.Vector3(0.22, -0.22, -0.44),
    isMelee: false,
  };
}

export function buildEnemyModel3D(target: TargetProfile, enemyIdx = 0): BuiltEnemy3D {
  const root = new THREE.Group();
  const bodyGroup = new THREE.Group();
  root.add(bodyGroup);

  const hitMeshes: THREE.Mesh[] = [];

  const armorColor =
    target.silhouette === 'titan'
      ? 0x3b242c
      : target.silhouette === 'mech'
        ? 0x263244
        : target.silhouette === 'drone'
          ? 0x1d2d3d
          : 0x242c3a;

  const plateMat = new THREE.MeshStandardMaterial({
    color: armorColor,
    roughness: 0.42,
    metalness: 0.72,
  });
  const trimMat = new THREE.MeshStandardMaterial({
    color: 0x00f0ff,
    roughness: 0.35,
    metalness: 0.6,
    emissive: 0x00f0ff,
    emissiveIntensity: 0.25,
  });
  const limbMat = new THREE.MeshStandardMaterial({
    color: 0x171d27,
    roughness: 0.65,
    metalness: 0.5,
  });
  const weakspotMat = new THREE.MeshStandardMaterial({
    color: 0xff2a4b,
    roughness: 0.2,
    metalness: 0.2,
    emissive: 0xff2a4b,
    emissiveIntensity: 1.5,
  });
  const clawMat = new THREE.MeshStandardMaterial({
    color: 0xd8dee9,
    roughness: 0.22,
    metalness: 0.92,
    emissive: 0xff2a4b,
    emissiveIntensity: 0.18,
  });

  const tagHitMesh = (mesh: THREE.Mesh, zone: 'weakspot' | 'torso' | 'limb') => {
    mesh.userData.hitZone = zone;
    mesh.userData.enemyIdx = enemyIdx;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    hitMeshes.push(mesh);
    return mesh;
  };

  // Legs (grounded at y=0)
  const legH = target.silhouette === 'drone' ? 0.1 : 0.95;
  const leftLeg = new THREE.Group();
  leftLeg.position.set(-0.24, legH, 0);
  const rightLeg = new THREE.Group();
  rightLeg.position.set(0.24, legH, 0);

  if (target.silhouette !== 'drone') {
    const legGeo = new THREE.BoxGeometry(0.22, legH, 0.26);
    const lLegMesh = tagHitMesh(new THREE.Mesh(legGeo, limbMat), 'limb');
    lLegMesh.position.y = -legH * 0.5;
    leftLeg.add(lLegMesh);

    const rLegMesh = tagHitMesh(new THREE.Mesh(legGeo, limbMat), 'limb');
    rLegMesh.position.y = -legH * 0.5;
    rightLeg.add(rLegMesh);
  }
  bodyGroup.add(leftLeg, rightLeg);

  // Torso / Hull
  const torsoY = target.silhouette === 'drone' ? 1.55 : 1.38;
  const torsoW = target.silhouette === 'titan' ? 1.05 : target.silhouette === 'mech' ? 0.9 : 0.78;
  const torsoH = target.silhouette === 'titan' ? 0.95 : 0.78;
  const torsoMesh = tagHitMesh(
    new THREE.Mesh(new THREE.BoxGeometry(torsoW, torsoH, 0.52), plateMat),
    'torso'
  );
  torsoMesh.position.set(0, torsoY, 0);
  bodyGroup.add(torsoMesh);

  // Cyan armor chest trim
  const chestBar = new THREE.Mesh(new THREE.BoxGeometry(torsoW * 0.85, 0.08, 0.55), trimMat);
  chestBar.position.set(0, torsoY + 0.12, 0);
  bodyGroup.add(chestBar);

  // Weakspot Core / Head
  let weakspotMesh: THREE.Mesh;
  let weakspotHeight = 1.95;

  if (target.silhouette === 'mech') {
    // Ventral Gyro Core in center of chest
    weakspotHeight = torsoY + 0.05;
    weakspotMesh = tagHitMesh(
      new THREE.Mesh(new THREE.OctahedronGeometry(0.22, 1), weakspotMat),
      'weakspot'
    );
    weakspotMesh.position.set(0, weakspotHeight, 0.22);
    // Upper sensor cowl
    const cowl = tagHitMesh(new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.26, 0.42), plateMat), 'torso');
    cowl.position.set(0, torsoY + 0.48, 0.04);
    bodyGroup.add(cowl);
  } else if (target.silhouette === 'drone') {
    weakspotHeight = torsoY;
    weakspotMesh = tagHitMesh(
      new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 16), weakspotMat),
      'weakspot'
    );
    weakspotMesh.position.set(0, weakspotHeight, 0.24);
  } else {
    // Exo Visor / Titan Cranial Sac
    weakspotHeight = torsoY + torsoH * 0.5 + 0.22;
    weakspotMesh = tagHitMesh(
      new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.34, 0.34), weakspotMat),
      'weakspot'
    );
    weakspotMesh.position.set(0, weakspotHeight, 0.06);
  }
  bodyGroup.add(weakspotMesh);

  // Articulated Left & Right Claw Arms (for standard & dual-claw special attacks!)
  const buildClawArm = (side: -1 | 1) => {
    const armGroup = new THREE.Group();
    armGroup.position.set(side * (torsoW * 0.5 + 0.16), torsoY + 0.22, 0.05);

    const shoulder = tagHitMesh(new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.24, 0.28), plateMat), 'limb');
    armGroup.add(shoulder);

    const forearm = tagHitMesh(new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.52, 0.2), limbMat), 'limb');
    forearm.position.set(0, -0.34, 0.14);
    forearm.rotation.x = -0.35;
    armGroup.add(forearm);

    // 3 Razor Claws extending forward
    for (let c = -1; c <= 1; c++) {
      const blade = new THREE.Mesh(new THREE.ConeGeometry(0.036, 0.42, 4), clawMat);
      blade.rotation.x = Math.PI * 0.58;
      blade.position.set(c * 0.055, -0.58, 0.42);
      armGroup.add(blade);
    }

    return armGroup;
  };

  const leftClawArm = buildClawArm(-1);
  const rightClawArm = buildClawArm(1);
  bodyGroup.add(leftClawArm, rightClawArm);

  root.scale.set(target.scaleXZ, target.scaleY, target.scaleXZ);

  return {
    root,
    bodyGroup,
    leftLeg,
    rightLeg,
    leftClawArm,
    rightClawArm,
    weakspotMesh,
    hitMeshes,
    weakspotHeight: weakspotHeight * target.scaleY,
  };
}

export function buildTacticalRangeEnvironment(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
  isSoftwareGl: boolean
): { dispose: () => void } {
  // Procedural 2D Canvas Ground Grid Texture
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#0c1018';
    ctx.fillRect(0, 0, 512, 512);

    ctx.strokeStyle = 'rgba(0, 240, 255, 0.14)';
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, 512, 512);

    ctx.strokeStyle = 'rgba(140, 155, 181, 0.08)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const p = (512 / 4) * i;
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, 512);
      ctx.moveTo(0, p);
      ctx.lineTo(512, p);
      ctx.stroke();
    }

    // Corner micro-crosshairs
    ctx.fillStyle = 'rgba(255, 179, 0, 0.35)';
    ctx.fillRect(0, 0, 6, 6);
  }

  const floorTex = new THREE.CanvasTexture(canvas);
  floorTex.colorSpace = THREE.SRGBColorSpace;
  floorTex.wrapS = THREE.RepeatWrapping;
  floorTex.wrapT = THREE.RepeatWrapping;
  floorTex.repeat.set(36, 36);
  floorTex.anisotropy = renderer.capabilities.getMaxAnisotropy();

  const floorGeo = new THREE.PlaneGeometry(180, 180);
  const floorMat = new THREE.MeshStandardMaterial({
    map: floorTex,
    roughness: 0.78,
    metalness: 0.25,
  });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = !isSoftwareGl;
  scene.add(floor);

  // Tactical distance lane rails & pylons receding into fog
  const pylonGeo = new THREE.BoxGeometry(0.42, 2.8, 0.65);
  const pylonMat = new THREE.MeshStandardMaterial({
    color: 0x1a2230,
    roughness: 0.5,
    metalness: 0.7,
  });
  const beaconGeo = new THREE.BoxGeometry(0.46, 0.18, 0.2);
  const beaconMat = new THREE.MeshStandardMaterial({
    color: 0xffb300,
    emissive: 0xffb300,
    emissiveIntensity: 0.9,
  });

  const pylons = new THREE.InstancedMesh(pylonGeo, pylonMat, 24);
  const beacons = new THREE.InstancedMesh(beaconGeo, beaconMat, 24);
  const dummy = new THREE.Object3D();

  let idx = 0;
  for (let i = 0; i < 12; i++) {
    const z = -6 - i * 10;
    for (const side of [-1, 1]) {
      dummy.position.set(side * 8.5, 1.4, z);
      dummy.updateMatrix();
      pylons.setMatrixAt(idx, dummy.matrix);

      dummy.position.set(side * 8.5, 2.55, z + 0.25);
      dummy.updateMatrix();
      beacons.setMatrixAt(idx, dummy.matrix);
      idx++;
    }
  }
  pylons.computeBoundingSphere();
  beacons.computeBoundingSphere();
  scene.add(pylons, beacons);

  return {
    dispose: () => {
      floorTex.dispose();
      floorGeo.dispose();
      floorMat.dispose();
      pylonGeo.dispose();
      pylonMat.dispose();
      beaconGeo.dispose();
      beaconMat.dispose();
    },
  };
}
