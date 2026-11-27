import * as THREE from 'three';
import { getEnemyLoadoutForSpawn } from '../data/enemyArsenal';
import {
  BodyRegionKey,
  EnemyLoadoutSpec,
  GrenadeId,
  TargetProfile,
} from '../types/ballistics';

/** First-person 3D weapon rig returned for attachment to the player camera anchor. */
export interface BuiltWeapon3D {
  root: THREE.Group;
  muzzlePoint: THREE.Object3D;
  muzzleFlash: THREE.Mesh;
  opticOffset: THREE.Vector3; // local offset to align optic ring with camera (0,0)
  hipOffset: THREE.Vector3;
  isMelee: boolean;
  bladeRollGroup?: THREE.Group;
  magGroup?: THREE.Group;
  boltGroup?: THREE.Group;
  topCoverGroup?: THREE.Group;
  pumpGroup?: THREE.Group;
  shellMesh?: THREE.Mesh;
}

/** Articulated 3D hostile chassis model with humanoid joints, defined faces, loadouts, and per-region materials. */
export interface BuiltEnemy3D {
  root: THREE.Group;
  bodyGroup: THREE.Group;
  leftLeg: THREE.Object3D;
  rightLeg: THREE.Object3D;
  leftKnee?: THREE.Object3D;
  rightKnee?: THREE.Object3D;
  leftClawArm: THREE.Group;
  rightClawArm: THREE.Group;
  leftElbow?: THREE.Group;
  rightElbow?: THREE.Group;
  weakspotMesh: THREE.Mesh;
  hitMeshes: THREE.Mesh[];
  weakspotHeight: number;
  loadout: EnemyLoadoutSpec;
  shieldGroup?: THREE.Group;
  shieldMat?: THREE.MeshStandardMaterial;
  weaponMuzzlePoint?: THREE.Object3D;
  rocketMuzzlePoints: THREE.Object3D[];
  regionMaterials: Record<BodyRegionKey, THREE.MeshStandardMaterial[]>;
  baseRegionColors: WeakMap<THREE.MeshStandardMaterial, THREE.Color>;
}

/**
 * Constructs detailed composite Three.js first-person viewmodels for every firearm
 * and melee weapon (including aligned holo/sniper optics, rolling hammer/halberd heads,
 * and articulated magazines, bolts, pump forends, and top feed covers for reload animations).
 */
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
    weaponRig.rotation.set(-0.34, 0, 0.08);
    // Rolls shaft + head cleanly around its own longitudinal Y axis so sharp/hard face leads swings
    const bladeRollGroup = new THREE.Group();
    weaponRig.add(bladeRollGroup);

    const isHammer = weaponId === 'maelstrom_hammer';
    const shaftLen = isHammer ? 0.82 : 1.05;

    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(isHammer ? 0.018 : 0.015, isHammer ? 0.02 : 0.017, shaftLen, 10),
      carbonMat
    );
    shaft.position.set(0, 0.14, 0);
    bladeRollGroup.add(shaft);

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

    const pommel = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.018, 0.055, 8), gunmetalMat);
    pommel.position.set(0, -shaftLen * 0.5 + 0.12, 0);
    bladeRollGroup.add(pommel);

    const buttSpike = new THREE.Mesh(new THREE.ConeGeometry(0.016, 0.065, 6), forgedSteelMat);
    buttSpike.rotation.x = Math.PI;
    buttSpike.position.set(0, -shaftLen * 0.5 + 0.065, 0);
    bladeRollGroup.add(buttSpike);

    const headBaseY = shaftLen * 0.5 + 0.1;
    const collar = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.075, 0.052), gunmetalMat);
    collar.position.set(0, headBaseY - 0.03, 0);
    bladeRollGroup.add(collar);

    if (isHammer) {
      const headCore = new THREE.Mesh(new THREE.BoxGeometry(0.115, 0.125, 0.25), gunmetalMat);
      headCore.position.set(0, headBaseY + 0.04, -0.02);
      bladeRollGroup.add(headCore);

      const strikeFace = new THREE.Mesh(
        new THREE.CylinderGeometry(0.068, 0.074, 0.045, 6),
        forgedSteelMat
      );
      strikeFace.rotation.x = Math.PI / 2;
      strikeFace.position.set(0, headBaseY + 0.04, -0.16);
      bladeRollGroup.add(strikeFace);

      const rearPick = new THREE.Mesh(new THREE.ConeGeometry(0.038, 0.14, 4), forgedSteelMat);
      rearPick.rotation.x = Math.PI / 2;
      rearPick.position.set(0, headBaseY + 0.04, 0.165);
      bladeRollGroup.add(rearPick);

      for (const side of [-1, 1]) {
        const conduit = new THREE.Mesh(
          new THREE.BoxGeometry(0.012, 0.032, 0.19),
          accentAmberMat
        );
        conduit.position.set(side * 0.06, headBaseY + 0.04, -0.02);
        bladeRollGroup.add(conduit);
      }

      const crownCap = new THREE.Mesh(new THREE.ConeGeometry(0.036, 0.07, 4), accentAmberMat);
      crownCap.position.set(0, headBaseY + 0.135, -0.02);
      bladeRollGroup.add(crownCap);
    } else {
      const pikeTip = new THREE.Mesh(new THREE.ConeGeometry(0.028, 0.28, 4), forgedSteelMat);
      pikeTip.position.set(0, headBaseY + 0.16, 0);
      bladeRollGroup.add(pikeTip);

      // Crescent axe blade oriented forward on -Z side (cutting edge facing target)
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

      const rearHook = new THREE.Mesh(new THREE.ConeGeometry(0.02, 0.13, 4), forgedSteelMat);
      rearHook.rotation.x = Math.PI * 0.44;
      rearHook.position.set(0, headBaseY + 0.02, 0.075);
      bladeRollGroup.add(rearHook);

      const edgeTrim = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.17, 0.014), cyanEmitterMat);
      edgeTrim.rotation.x = -0.18;
      edgeTrim.position.set(0, headBaseY - 0.005, -0.205);
      bladeRollGroup.add(edgeTrim);

      const crossLug = new THREE.Mesh(new THREE.BoxGeometry(0.078, 0.02, 0.032), accentAmberMat);
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

  const reticleDotMat = new THREE.MeshBasicMaterial({ color: 0x00f0ff });
  const opticGlassMat = new THREE.MeshPhysicalMaterial({
    color: 0x0a1c28,
    roughness: 0.08,
    metalness: 0.1,
    transparent: true,
    opacity: 0.32,
  });

  const isPistol = weaponId === 'paladin_pistol';
  const isLongSniper = weaponId === 'valkyrie_dmr' || weaponId === 'longbow_sniper';
  const isHeavyMg =
    weaponId === 'novacula_mg' || weaponId === 'hydra_lmg' || weaponId === 'titanbane_gpmg';
  const isTopFeed = isHeavyMg || weaponId === 'helios_plasma';
  const isShotgun = weaponId === 'choque_shotgun' || weaponId === 'breacher_shotgun';

  const receiverLen = isPistol
    ? 0.22
    : isLongSniper
      ? 0.56
      : isHeavyMg
        ? 0.62
        : weaponId === 'kestrel_smg'
          ? 0.34
          : weaponId === 'ironclad_br'
            ? 0.5
            : isShotgun
              ? 0.42
              : 0.44;

  const receiver = new THREE.Mesh(
    new THREE.BoxGeometry(isPistol ? 0.042 : 0.068, isPistol ? 0.042 : 0.095, receiverLen),
    carbonMat
  );
  if (isPistol) {
    receiver.position.y = -0.014;
  }
  root.add(receiver);

  // Articulated sub-groups for realistic mechanical reload & cycling animations
  const boltGroup = new THREE.Group();
  root.add(boltGroup);

  let topCoverGroup: THREE.Group | undefined;
  if (isTopFeed) {
    // Hinged top cover pivoted forward of the receiver feed tray so it flips upward cleanly
    topCoverGroup = new THREE.Group();
    topCoverGroup.position.set(0, 0.048, -receiverLen * 0.28);
    root.add(topCoverGroup);

    const coverPlate = new THREE.Mesh(
      new THREE.BoxGeometry(0.066, 0.016, receiverLen * 0.56),
      gunmetalMat
    );
    coverPlate.position.set(0, 0.008, receiverLen * 0.28);
    topCoverGroup.add(coverPlate);

    const coverLatch = new THREE.Mesh(
      new THREE.BoxGeometry(0.032, 0.014, 0.036),
      accentAmberMat
    );
    coverLatch.position.set(0, 0.012, receiverLen * 0.53);
    topCoverGroup.add(coverLatch);
  }

  const rail = new THREE.Mesh(
    new THREE.BoxGeometry(isPistol ? 0.028 : 0.036, 0.014, receiverLen * 0.92),
    gunmetalMat
  );
  if (isPistol) {
    rail.position.set(0, 0.041, -0.02);
    boltGroup.add(rail);
  } else if (topCoverGroup) {
    rail.scale.z = 0.55;
    rail.position.set(0, 0.018, receiverLen * 0.26);
    topCoverGroup.add(rail);
  } else {
    rail.position.set(0, 0.055, -0.02);
    root.add(rail);
  }

  const shroudLen = isPistol
    ? 0.24
    : isLongSniper
      ? 0.38
      : weaponId === 'kestrel_smg'
        ? 0.16
        : isShotgun
          ? 0.24
          : 0.28;
  const shroud = new THREE.Mesh(
    new THREE.BoxGeometry(isPistol ? 0.044 : 0.062, isPistol ? 0.038 : 0.072, shroudLen),
    gunmetalMat
  );
  if (isPistol) {
    // Full upper pistol slide attached to boltGroup for slide lock/rack reload
    shroud.position.set(0, 0.021, -0.02);
    boltGroup.add(shroud);
  } else {
    shroud.position.set(0, 0.008, -receiverLen * 0.5 - shroudLen * 0.42);
    root.add(shroud);

    // Side bolt carrier + charging handle for rifles, SMGs, shotguns, and MGs
    const boltCarrier = new THREE.Mesh(
      new THREE.BoxGeometry(0.012, 0.024, 0.09),
      forgedSteelMat
    );
    boltCarrier.position.set(0.035, 0.018, -0.03);
    boltGroup.add(boltCarrier);

    const boltHandle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.008, 0.008, 0.032, 8),
      accentAmberMat
    );
    boltHandle.rotation.z = Math.PI / 2;
    boltHandle.position.set(0.048, 0.018, -0.055);
    boltGroup.add(boltHandle);
  }

  const barrelLen = isPistol
    ? 0.14
    : weaponId === 'longbow_sniper'
      ? 0.64
      : weaponId === 'valkyrie_dmr'
        ? 0.52
        : isHeavyMg
          ? 0.48
          : weaponId === 'kestrel_smg'
            ? 0.18
            : isShotgun
              ? 0.34
              : 0.32;
  const barrelRadius = isHeavyMg ? 0.024 : isShotgun ? 0.021 : isPistol ? 0.011 : 0.013;
  const barrel = new THREE.Mesh(
    new THREE.CylinderGeometry(barrelRadius, barrelRadius * 1.15, barrelLen, 12),
    gunmetalMat
  );
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(
    0,
    0.015,
    -receiverLen * 0.5 - (isPistol ? 0.06 : shroudLen) * 0.5 - barrelLen * 0.45
  );
  root.add(barrel);

  let pumpGroup: THREE.Group | undefined;
  let shellMesh: THREE.Mesh | undefined;
  if (isShotgun) {
    const tubeMag = new THREE.Mesh(
      new THREE.CylinderGeometry(0.016, 0.016, barrelLen * 0.92, 10),
      carbonMat
    );
    tubeMag.rotation.x = Math.PI / 2;
    tubeMag.position.set(0, -0.022, -receiverLen * 0.5 - shroudLen * 0.5 - barrelLen * 0.4);
    root.add(tubeMag);

    // Sliding ribbed pump-action forend
    pumpGroup = new THREE.Group();
    const pumpBody = new THREE.Mesh(
      new THREE.BoxGeometry(0.056, 0.046, 0.16),
      gripRubberMat
    );
    pumpBody.position.set(0, -0.026, -receiverLen * 0.5 - shroudLen * 0.45);
    pumpGroup.add(pumpBody);

    for (let r = 0; r < 4; r++) {
      const rib = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.008, 0.016), accentAmberMat);
      rib.position.set(0, -0.028, -receiverLen * 0.5 - shroudLen * 0.25 - r * 0.036);
      pumpGroup.add(rib);
    }
    root.add(pumpGroup);

    // Individual 12-gauge shell animated into the lower loading port during shotgun reload
    const shellGeo = new THREE.CylinderGeometry(0.012, 0.012, 0.062, 10);
    shellGeo.rotateX(Math.PI / 2);
    shellMesh = new THREE.Mesh(
      shellGeo,
      new THREE.MeshStandardMaterial({
        color: 0xd92638,
        roughness: 0.35,
        metalness: 0.3,
      })
    );
    const brassHead = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0126, 0.0126, 0.018, 10),
      accentAmberMat
    );
    brassHead.rotation.x = Math.PI / 2;
    brassHead.position.z = 0.024;
    shellMesh.add(brassHead);
    shellMesh.position.set(0, -0.14, -0.02);
    shellMesh.visible = false;
    root.add(shellMesh);
  }

  const muzzleZ = -receiverLen * 0.5 - (isPistol ? 0.06 : shroudLen) * 0.5 - barrelLen * 0.92;
  const brake = new THREE.Mesh(
    new THREE.BoxGeometry(isPistol ? 0.028 : 0.038, isPistol ? 0.032 : 0.038, 0.065),
    isHeavyMg || isShotgun || weaponId === 'longbow_sniper' ? accentAmberMat : gunmetalMat
  );
  brake.position.set(0, 0.015, muzzleZ);
  root.add(brake);

  if (
    weaponId === 'm47_rail' ||
    weaponId === 'helios_plasma' ||
    weaponId === 'longbow_sniper' ||
    weaponId === 'titanbane_gpmg' ||
    weaponId === 'paladin_pistol'
  ) {
    const coilCount = weaponId === 'helios_plasma' ? 4 : weaponId === 'longbow_sniper' ? 3 : 2;
    for (let i = 0; i < coilCount; i++) {
      const coil = new THREE.Mesh(
        new THREE.BoxGeometry(isPistol ? 0.048 : 0.072, 0.02, 0.022),
        cyanEmitterMat
      );
      coil.position.set(0, 0.018, -receiverLen * 0.5 - 0.05 - i * 0.055);
      root.add(coil);
    }
  } else {
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.071, 0.012, 0.14), accentAmberMat);
    stripe.position.set(0, -0.01, -0.06);
    root.add(stripe);
  }

  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.12, 0.05), carbonMat);
  grip.position.set(0, -0.085, isPistol ? 0.05 : 0.11);
  grip.rotation.x = 0.28;
  root.add(grip);

  // Removable Magazine / Ammo Box Group for ALL ranged weapons (pistols, rifles, SMGs, MGs)
  const magGroup = new THREE.Group();
  if (isPistol) {
    const pistolMag = new THREE.Mesh(
      new THREE.BoxGeometry(0.028, 0.11, 0.036),
      forgedSteelMat
    );
    pistolMag.rotation.x = 0.28;
    const baseplate = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.018, 0.044), accentAmberMat);
    baseplate.position.set(0, -0.058, 0.016);
    baseplate.rotation.x = 0.28;
    magGroup.add(pistolMag, baseplate);
    magGroup.position.set(0, -0.095, 0.052);
    root.add(magGroup);
  } else if (!isShotgun) {
    const mag = new THREE.Mesh(
      new THREE.BoxGeometry(
        isTopFeed ? 0.082 : 0.036,
        weaponId === 'helios_plasma' || isTopFeed ? 0.13 : 0.14,
        isTopFeed ? 0.11 : 0.068
      ),
      gunmetalMat
    );
    mag.rotation.x = isTopFeed ? 0 : -0.15;
    magGroup.add(mag);

    const magBand = new THREE.Mesh(
      new THREE.BoxGeometry(isTopFeed ? 0.086 : 0.04, 0.018, isTopFeed ? 0.114 : 0.072),
      weaponId === 'helios_plasma' ? cyanEmitterMat : accentAmberMat
    );
    magBand.position.y = -0.045;
    magBand.rotation.x = isTopFeed ? 0 : -0.15;
    magGroup.add(magBand);

    magGroup.position.set(0, -0.1, -0.05);
    root.add(magGroup);
  }

  if (!isPistol) {
    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.085, 0.24), carbonMat);
    stock.position.set(0, -0.01, receiverLen * 0.5 + 0.1);
    root.add(stock);
  }

  // Optic Sight Housing aligned with camera when ADS (mounted on topCover for LMG/GPMG/Plasma)
  const opticY = isPistol ? 0.078 : 0.102;
  const opticZ = isPistol ? 0.02 : -0.02;
  const opticGroup = new THREE.Group();
  if (topCoverGroup) {
    opticGroup.position.set(0, opticY - topCoverGroup.position.y, opticZ - topCoverGroup.position.z);
  } else {
    opticGroup.position.set(0, opticY, opticZ);
  }

  if (isLongSniper) {
    const tube = new THREE.Mesh(
      new THREE.CylinderGeometry(0.026, 0.026, 0.22, 16, 1, true),
      gunmetalMat
    );
    tube.rotation.x = Math.PI / 2;
    opticGroup.add(tube);

    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.023, 16), opticGlassMat);
    lens.position.z = -0.105;
    opticGroup.add(lens);

    const hLine = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.0014, 0.001), reticleDotMat);
    hLine.position.z = -0.1;
    const vLine = new THREE.Mesh(new THREE.BoxGeometry(0.0014, 0.038, 0.001), reticleDotMat);
    vLine.position.z = -0.1;
    opticGroup.add(hLine, vLine);
  } else {
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

    const dot = new THREE.Mesh(new THREE.BoxGeometry(0.0028, 0.0028, 0.002), reticleDotMat);
    dot.position.set(0, 0, -0.008);

    opticGroup.add(base, leftPost, rightPost, topHood, lens, dot);
  }

  if (isPistol) {
    opticGroup.position.set(0, 0.068, 0.02);
    boltGroup.add(opticGroup);
  } else if (topCoverGroup) {
    topCoverGroup.add(opticGroup);
  } else {
    root.add(opticGroup);
  }

  const muzzlePoint = new THREE.Object3D();
  muzzlePoint.position.set(0, 0.015, muzzleZ - 0.04);
  root.add(muzzlePoint);

  const flashMat = new THREE.MeshBasicMaterial({
    color: weaponId === 'helios_plasma' || weaponId === 'longbow_sniper' ? 0x00f0ff : 0xffb300,
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
    opticOffset: new THREE.Vector3(0, -opticY, isPistol ? -0.3 : -0.24),
    hipOffset: new THREE.Vector3(0.22, -0.22, -0.44),
    isMelee: false,
    magGroup: isShotgun ? undefined : magGroup,
    boltGroup,
    topCoverGroup,
    pumpGroup,
    shellMesh,
  };
}

/**
 * Constructs articulated 3D enemy silhouettes with tough armored facial geometry,
 * flying ATGM chassis for Vanguard drones (zero legs/arms), per-region weathering materials,
 * large ballistic shields, melee/ranged weapons, and Brute shoulder rocket pods.
 */
export function buildEnemyModel3D(
  target: TargetProfile,
  enemyIdx = 0,
  overrideLoadout?: EnemyLoadoutSpec
): BuiltEnemy3D {
  const root = new THREE.Group();
  const bodyGroup = new THREE.Group();
  root.add(bodyGroup);

  const hitMeshes: THREE.Mesh[] = [];
  const sil = target.silhouette;
  const loadout = overrideLoadout ?? getEnemyLoadoutForSpawn(sil, enemyIdx);

  const armorColor =
    sil === 'titan'
      ? 0x3b242c
      : sil === 'brute'
        ? 0x4d1e28
        : sil === 'tank'
          ? 0x2a313b
          : sil === 'swarmer'
            ? 0x162925
            : sil === 'mech'
              ? 0x263244
              : sil === 'drone'
                ? 0x1d2d3d
                : 0x242c3a;

  const trimColor =
    sil === 'tank'
      ? 0xffb300
      : sil === 'brute'
        ? 0xff2a4b
        : sil === 'swarmer'
          ? 0x20df78
          : 0x00f0ff;

  const baseRegionColors = new WeakMap<THREE.MeshStandardMaterial, THREE.Color>();
  const registerRegionMat = (
    region: BodyRegionKey,
    mat: THREE.MeshStandardMaterial
  ): THREE.MeshStandardMaterial => {
    baseRegionColors.set(mat, mat.color.clone());
    regionMaterials[region].push(mat);
    return mat;
  };

  const regionMaterials: Record<BodyRegionKey, THREE.MeshStandardMaterial[]> = {
    head: [],
    torso: [],
    leftArm: [],
    rightArm: [],
    leftLeg: [],
    rightLeg: [],
    shield: [],
  };

  const makePlateMat = (region: BodyRegionKey) =>
    registerRegionMat(
      region,
      new THREE.MeshStandardMaterial({
        color: armorColor,
        roughness: sil === 'tank' ? 0.55 : 0.42,
        metalness: sil === 'tank' ? 0.85 : 0.72,
      })
    );

  const makeLimbMat = (region: BodyRegionKey) =>
    registerRegionMat(
      region,
      new THREE.MeshStandardMaterial({
        color: 0x1b222e,
        roughness: 0.65,
        metalness: 0.5,
      })
    );

  const headPlateMat = makePlateMat('head');
  const torsoPlateMat = makePlateMat('torso');
  const leftArmPlateMat = makePlateMat('leftArm');
  const rightArmPlateMat = makePlateMat('rightArm');
  const leftLegPlateMat = makePlateMat('leftLeg');
  const rightLegPlateMat = makePlateMat('rightLeg');

  const leftArmLimbMat = makeLimbMat('leftArm');
  const rightArmLimbMat = makeLimbMat('rightArm');
  const leftLegLimbMat = makeLimbMat('leftLeg');
  const rightLegLimbMat = makeLimbMat('rightLeg');
  const neckLimbMat = makeLimbMat('torso');

  const abdomenMat = registerRegionMat(
    'torso',
    new THREE.MeshStandardMaterial({
      color: 0x151b24,
      roughness: 0.72,
      metalness: 0.45,
    })
  );
  const trimMat = new THREE.MeshStandardMaterial({
    color: trimColor,
    roughness: 0.35,
    metalness: 0.6,
    emissive: trimColor,
    emissiveIntensity: 0.42,
  });
  const opticVisorMat = new THREE.MeshStandardMaterial({
    color: sil === 'swarmer' ? 0x20df78 : sil === 'drone' ? 0x00f0ff : 0xff4422,
    roughness: 0.18,
    metalness: 0.2,
    emissive: sil === 'swarmer' ? 0x20df78 : sil === 'drone' ? 0x00f0ff : 0xff2a4b,
    emissiveIntensity: 1.65,
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
  const enemyGunMat = new THREE.MeshStandardMaterial({
    color: 0x222936,
    roughness: 0.34,
    metalness: 0.85,
  });
  const enemyBladeMat = new THREE.MeshStandardMaterial({
    color: 0xc8d2e3,
    roughness: 0.2,
    metalness: 0.94,
    emissive: 0xff7b29,
    emissiveIntensity: 0.12,
  });

  const tagHitMesh = (
    mesh: THREE.Mesh,
    zone: 'weakspot' | 'torso' | 'limb',
    bodyRegion: BodyRegionKey,
    castShadow = false
  ) => {
    mesh.userData.hitZone = zone;
    mesh.userData.bodyRegion = bodyRegion;
    mesh.userData.enemyIdx = enemyIdx;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    hitMeshes.push(mesh);
    return mesh;
  };

  /** Builds a sculpted tough armored mech face (brow ridge, recessed glowing eyes, cheek plates, mandible vent). */
  const attachToughMechFace = (
    parent: THREE.Object3D,
    hx: number,
    hy: number,
    hz: number,
    headW: number,
    headH: number,
    headD: number,
    isWeakHead: boolean
  ) => {
    const faceGroup = new THREE.Group();
    faceGroup.position.set(hx, hy, hz);
    const matForFace = isWeakHead ? weakspotMat : headPlateMat;

    // Angry angled brow ridge
    const brow = tagHitMesh(
      new THREE.Mesh(new THREE.BoxGeometry(headW * 1.1, headH * 0.24, headD * 0.42), headPlateMat),
      isWeakHead ? 'weakspot' : 'torso',
      'head'
    );
    brow.position.set(0, headH * 0.28, headD * 0.42);
    brow.rotation.x = 0.24;
    faceGroup.add(brow);

    // Armored nose bridge dividing twin recessed optics
    const noseBridge = tagHitMesh(
      new THREE.Mesh(new THREE.BoxGeometry(headW * 0.18, headH * 0.3, headD * 0.28), headPlateMat),
      isWeakHead ? 'weakspot' : 'torso',
      'head'
    );
    noseBridge.position.set(0, headH * 0.06, headD * 0.5);
    faceGroup.add(noseBridge);

    // Twin narrow menacing optic eye slits
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(
        new THREE.BoxGeometry(headW * 0.28, headH * 0.14, 0.04),
        opticVisorMat
      );
      eye.position.set(side * headW * 0.23, headH * 0.1, headD * 0.52);
      eye.rotation.z = -side * 0.16;
      faceGroup.add(eye);

      // Angled cheek/temple armor flanges
      const cheek = tagHitMesh(
        new THREE.Mesh(new THREE.BoxGeometry(headW * 0.22, headH * 0.46, headD * 0.52), matForFace),
        isWeakHead ? 'weakspot' : 'torso',
        'head'
      );
      cheek.position.set(side * headW * 0.44, -headH * 0.1, headD * 0.22);
      cheek.rotation.y = side * 0.28;
      faceGroup.add(cheek);
    }

    // Heavy armored jaw / respirator grille
    const jaw = tagHitMesh(
      new THREE.Mesh(new THREE.BoxGeometry(headW * 0.78, headH * 0.34, headD * 0.56), headPlateMat),
      isWeakHead ? 'weakspot' : 'torso',
      'head'
    );
    jaw.position.set(0, -headH * 0.28, headD * 0.34);
    faceGroup.add(jaw);

    const vent = new THREE.Mesh(
      new THREE.BoxGeometry(headW * 0.48, headH * 0.14, 0.04),
      trimMat
    );
    vent.position.set(0, -headH * 0.29, headD * 0.62);
    faceGroup.add(vent);

    parent.add(faceGroup);
  };

  const isDrone = sil === 'drone';
  const rocketMuzzlePoints: THREE.Object3D[] = [];

  // =========================================================================
  // VANGUARD SHIELD DRONE: Mini flying chassis (NO legs, NO arms) + Shoulder ATGM
  // =========================================================================
  if (isDrone) {
    const hoverCenterY = 1.48;
    const droneChassis = new THREE.Group();
    droneChassis.position.set(0, hoverCenterY, 0);
    bodyGroup.add(droneChassis);

    // Sleek angular armored fuselage
    const hull = tagHitMesh(
      new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.42, 0.72), torsoPlateMat),
      'torso',
      'torso',
      true
    );
    droneChassis.add(hull);

    // Angled top carapace & dorsal spine
    const dorsalCowling = tagHitMesh(
      new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.16, 0.62), torsoPlateMat),
      'torso',
      'torso'
    );
    dorsalCowling.position.set(0, 0.24, -0.04);
    dorsalCowling.rotation.x = -0.14;
    droneChassis.add(dorsalCowling);

    // Tough forward armored face & optical brow
    const facePlate = tagHitMesh(
      new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.28, 0.2), headPlateMat),
      'torso',
      'head'
    );
    facePlate.position.set(0, 0.24, 0.28);
    droneChassis.add(facePlate);
    attachToughMechFace(droneChassis, 0, 0.24, 0.28, 0.44, 0.26, 0.2, false);

    // Central Stabilizer Lens (Weakspot — NO longer fires projectiles from here)
    const weakspotMesh = tagHitMesh(
      new THREE.Mesh(new THREE.SphereGeometry(0.19, 12, 10), weakspotMat),
      'weakspot',
      'torso'
    );
    weakspotMesh.position.set(0, -0.02, 0.39);
    droneChassis.add(weakspotMesh);

    // Twin lateral swept hover-thruster pods (no arms or legs)
    for (const side of [-1, 1] as const) {
      const wingRegion: BodyRegionKey = side === -1 ? 'leftArm' : 'rightArm';
      const wingMat = side === -1 ? leftArmPlateMat : rightArmPlateMat;
      const wing = tagHitMesh(
        new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.1, 0.36), wingMat),
        'limb',
        wingRegion
      );
      wing.position.set(side * 0.52, 0.04, -0.06);
      wing.rotation.z = -side * 0.18;
      droneChassis.add(wing);

      const thruster = tagHitMesh(
        new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 0.34, 8), wingMat),
        'limb',
        wingRegion
      );
      thruster.position.set(side * 0.68, -0.06, -0.08);
      droneChassis.add(thruster);

      const glowNozzle = new THREE.Mesh(
        new THREE.CylinderGeometry(0.09, 0.06, 0.08, 8),
        trimMat
      );
      glowNozzle.position.set(side * 0.68, -0.25, -0.08);
      droneChassis.add(glowNozzle);
    }

    // Shoulder-mounted ATGM Missile Pod on right dorsal winglet
    const atgmGroup = new THREE.Group();
    atgmGroup.position.set(0.38, 0.34, 0.04);
    const podBox = tagHitMesh(
      new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.22, 0.62), enemyGunMat),
      'torso',
      'rightArm'
    );
    const podRail = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.04, 0.52), trimMat);
    podRail.position.y = 0.12;
    const tubeL = new THREE.Mesh(
      new THREE.CylinderGeometry(0.055, 0.055, 0.64, 8),
      clawMat
    );
    tubeL.rotation.x = Math.PI / 2;
    tubeL.position.set(-0.055, 0, 0.03);
    const tubeR = tubeL.clone();
    tubeR.position.set(0.055, 0, 0.03);
    atgmGroup.add(podBox, podRail, tubeL, tubeR);

    const weaponMuzzlePoint = new THREE.Object3D();
    weaponMuzzlePoint.position.set(0, 0, 0.42);
    atgmGroup.add(weaponMuzzlePoint);
    droneChassis.add(atgmGroup);

    // Dummy invisible leg/arm pivots to keep animation contract clean with zero leg/arm geometry
    const leftLeg = new THREE.Group();
    const rightLeg = new THREE.Group();
    const leftClawArm = new THREE.Group();
    const rightClawArm = new THREE.Group();
    bodyGroup.add(leftLeg, rightLeg, leftClawArm, rightClawArm);

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
      weakspotHeight: hoverCenterY * target.scaleY,
      loadout,
      weaponMuzzlePoint,
      rocketMuzzlePoints,
      regionMaterials,
      baseRegionColors,
    };
  }

  // =========================================================================
  // HUMANOID COMBAT MECHS: FEET -> SHINS -> THIGHS -> PELVIS -> ABDOMEN -> CHEST -> HEAD + LOADOUT
  // =========================================================================
  const isSwarmer = sil === 'swarmer';
  const isTank = sil === 'tank';
  const isTitan = sil === 'titan';
  const isBrute = sil === 'brute';
  const isMech = sil === 'mech';

  const footH = isSwarmer ? 0.07 : isTank ? 0.12 : 0.095;
  const shinLen = isSwarmer ? 0.30 : isTank ? 0.40 : 0.44;
  const thighLen = isSwarmer ? 0.31 : isTank ? 0.42 : 0.45;
  const hipY = footH + shinLen + thighLen;
  const legSpread = isTank ? 0.31 : isTitan ? 0.24 : isSwarmer ? 0.21 : 0.20;

  const thighRTop = isTank ? 0.17 : isTitan ? 0.14 : isSwarmer ? 0.105 : 0.125;
  const thighRBot = thighRTop * 0.76;
  const shinRTop = isTank ? 0.145 : isTitan ? 0.115 : isSwarmer ? 0.085 : 0.10;
  const shinRBot = shinRTop * 0.72;
  const footW = isTank ? 0.28 : isSwarmer ? 0.15 : 0.18;
  const footD = isTank ? 0.38 : isSwarmer ? 0.24 : 0.28;

  const buildHumanoidLeg = (side: -1 | 1) => {
    const legRegion: BodyRegionKey = side === -1 ? 'leftLeg' : 'rightLeg';
    const lPlateMat = side === -1 ? leftLegPlateMat : rightLegPlateMat;
    const lLimbMat = side === -1 ? leftLegLimbMat : rightLegLimbMat;

    const hipGroup = new THREE.Group();
    hipGroup.position.set(side * legSpread, hipY, 0);

    const hipSocket = tagHitMesh(
      new THREE.Mesh(new THREE.SphereGeometry(thighRTop * 0.85, 8, 6), lLimbMat),
      'limb',
      legRegion
    );
    hipGroup.add(hipSocket);

    const thighMesh = tagHitMesh(
      new THREE.Mesh(new THREE.CylinderGeometry(thighRTop, thighRBot, thighLen, 8), lLimbMat),
      'limb',
      legRegion
    );
    thighMesh.position.y = -thighLen * 0.5;
    hipGroup.add(thighMesh);

    const thighPlate = tagHitMesh(
      new THREE.Mesh(
        new THREE.BoxGeometry(thighRTop * 1.45, thighLen * 0.68, thighRTop * 1.55),
        lPlateMat
      ),
      'limb',
      legRegion
    );
    thighPlate.position.set(side * 0.02, -thighLen * 0.46, 0.02);
    hipGroup.add(thighPlate);

    const kneeGroup = new THREE.Group();
    kneeGroup.position.set(0, -thighLen, 0);
    hipGroup.add(kneeGroup);

    const kneePad = tagHitMesh(
      new THREE.Mesh(
        new THREE.BoxGeometry(thighRBot * 1.65, 0.12, thighRBot * 1.65),
        lPlateMat
      ),
      'limb',
      legRegion
    );
    kneePad.position.set(0, 0, 0.04);
    kneeGroup.add(kneePad);

    const shinMesh = tagHitMesh(
      new THREE.Mesh(new THREE.CylinderGeometry(shinRTop, shinRBot, shinLen, 8), lLimbMat),
      'limb',
      legRegion
    );
    shinMesh.position.y = -shinLen * 0.5;
    kneeGroup.add(shinMesh);

    const shinGreave = tagHitMesh(
      new THREE.Mesh(
        new THREE.BoxGeometry(shinRTop * 1.55, shinLen * 0.78, shinRTop * 1.35),
        lPlateMat
      ),
      'limb',
      legRegion
    );
    shinGreave.position.set(0, -shinLen * 0.48, 0.045);
    kneeGroup.add(shinGreave);

    const footGroup = new THREE.Group();
    footGroup.position.set(0, -shinLen, 0);
    kneeGroup.add(footGroup);

    const heelMesh = tagHitMesh(
      new THREE.Mesh(new THREE.BoxGeometry(footW, footH, footD * 0.62), lPlateMat),
      'limb',
      legRegion
    );
    heelMesh.position.set(0, -footH * 0.5, 0.0);
    footGroup.add(heelMesh);

    const toeMesh = tagHitMesh(
      new THREE.Mesh(new THREE.BoxGeometry(footW * 0.96, footH * 0.78, footD * 0.48), lLimbMat),
      'limb',
      legRegion
    );
    toeMesh.position.set(0, -footH * 0.61, footD * 0.44);
    footGroup.add(toeMesh);

    return { hipGroup, kneeGroup };
  };

  const leftLegBuilt = buildHumanoidLeg(-1);
  const rightLegBuilt = buildHumanoidLeg(1);
  const leftLeg = leftLegBuilt.hipGroup;
  const rightLeg = rightLegBuilt.hipGroup;
  const leftKnee = leftLegBuilt.kneeGroup;
  const rightKnee = rightLegBuilt.kneeGroup;
  bodyGroup.add(leftLeg, rightLeg);

  // === PELVIS, ABDOMEN & UPPER CHEST ===
  const pelvisW = isTank ? 0.76 : isTitan ? 0.58 : isSwarmer ? 0.48 : 0.50;
  const pelvisD = isTank ? 0.44 : isSwarmer ? 0.30 : 0.32;
  const pelvisMesh = tagHitMesh(
    new THREE.Mesh(new THREE.BoxGeometry(pelvisW, 0.16, pelvisD), torsoPlateMat),
    'torso',
    'torso'
  );
  pelvisMesh.position.set(0, hipY + 0.04, 0);
  bodyGroup.add(pelvisMesh);

  const torsoPitch = isSwarmer ? 0.28 : isBrute ? 0.12 : isTitan ? 0.06 : 0.02;
  const upperBodyPivot = new THREE.Group();
  upperBodyPivot.position.set(0, hipY + 0.11, 0);
  upperBodyPivot.rotation.x = torsoPitch;
  bodyGroup.add(upperBodyPivot);

  const abdomenH = isSwarmer ? 0.24 : isTank ? 0.32 : isTitan ? 0.34 : 0.29;
  const abdomenW = isTank ? 0.66 : isTitan ? 0.52 : isSwarmer ? 0.38 : 0.42;
  const abdomenD = isTank ? 0.42 : isSwarmer ? 0.28 : 0.29;
  const abdomenMesh = tagHitMesh(
    new THREE.Mesh(new THREE.BoxGeometry(abdomenW, abdomenH, abdomenD), abdomenMat),
    'torso',
    'torso'
  );
  abdomenMesh.position.set(0, abdomenH * 0.5, 0);
  upperBodyPivot.add(abdomenMesh);

  for (let r = 0; r < 2; r++) {
    const rib = tagHitMesh(
      new THREE.Mesh(new THREE.BoxGeometry(abdomenW * 1.06, 0.065, abdomenD * 1.08), torsoPlateMat),
      'torso',
      'torso'
    );
    rib.position.set(0, abdomenH * (0.34 + r * 0.36), 0.01);
    upperBodyPivot.add(rib);
  }

  const chestH = isTank ? 0.56 : isTitan ? 0.52 : isBrute ? 0.48 : isSwarmer ? 0.34 : 0.44;
  const chestW = isTank ? 1.12 : isTitan ? 0.88 : isBrute ? 0.84 : isSwarmer ? 0.58 : isMech ? 0.74 : 0.72;
  const chestD = isTank ? 0.62 : isTitan ? 0.48 : isSwarmer ? 0.38 : 0.40;
  const chestCenterY = abdomenH + chestH * 0.5;

  const upperChestMesh = tagHitMesh(
    new THREE.Mesh(new THREE.BoxGeometry(chestW, chestH, chestD), torsoPlateMat),
    'torso',
    'torso',
    true
  );
  upperChestMesh.position.set(0, chestCenterY, 0.02);
  upperBodyPivot.add(upperChestMesh);

  for (const side of [-1, 1] as const) {
    const pec = tagHitMesh(
      new THREE.Mesh(
        new THREE.BoxGeometry(chestW * 0.42, chestH * 0.52, 0.12),
        torsoPlateMat
      ),
      'torso',
      'torso'
    );
    pec.position.set(side * chestW * 0.24, chestCenterY + chestH * 0.08, chestD * 0.5 + 0.03);
    pec.rotation.y = -side * 0.12;
    upperBodyPivot.add(pec);
  }

  const chestBar = new THREE.Mesh(
    new THREE.BoxGeometry(chestW * 0.74, 0.065, chestD + 0.1),
    trimMat
  );
  chestBar.position.set(0, chestCenterY + chestH * 0.12, 0.03);
  upperBodyPivot.add(chestBar);

  if (isTank) {
    const shieldApron = tagHitMesh(
      new THREE.Mesh(new THREE.BoxGeometry(chestW * 0.86, chestH * 0.68, 0.18), torsoPlateMat),
      'torso',
      'torso'
    );
    shieldApron.position.set(0, chestCenterY - 0.04, chestD * 0.5 + 0.14);
    shieldApron.rotation.x = -0.18;
    upperBodyPivot.add(shieldApron);
  } else if (isBrute) {
    for (let s = 0; s < 3; s++) {
      const spine = tagHitMesh(
        new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.32, 4), clawMat),
        'torso',
        'torso'
      );
      spine.position.set(0, chestCenterY + chestH * 0.46 - s * 0.09, -chestD * 0.5 - 0.08);
      spine.rotation.x = -0.48;
      upperBodyPivot.add(spine);
    }

    // Brute Larger Shoulder-Mounted Rocket Pods (24-round volley pods on left & right shoulders)
    if (loadout.rocketPodWeaponId === 'enemy_rocket_pods') {
      for (const side of [-1, 1] as const) {
        const podGrp = new THREE.Group();
        podGrp.position.set(side * (chestW * 0.46), abdomenH + chestH + 0.16, -0.02);
        const podShell = tagHitMesh(
          new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.28, 0.46), enemyGunMat),
          'torso',
          side === -1 ? 'leftArm' : 'rightArm',
          true
        );
        const podCap = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.06, 0.48), trimMat);
        podCap.position.y = 0.14;
        podGrp.add(podShell, podCap);

        // 4x3 Rocket Launch Tube grid on the front face
        for (let r = 0; r < 2; r++) {
          for (let c = 0; c < 3; c++) {
            const nozzle = new THREE.Mesh(
              new THREE.CylinderGeometry(0.032, 0.032, 0.08, 6),
              clawMat
            );
            nozzle.rotation.x = Math.PI / 2;
            nozzle.position.set((c - 1) * 0.085, (r - 0.5) * 0.095, 0.23);
            podGrp.add(nozzle);
          }
        }
        const podMuzzle = new THREE.Object3D();
        podMuzzle.position.set(0, 0, 0.3);
        podGrp.add(podMuzzle);
        rocketMuzzlePoints.push(podMuzzle);
        upperBodyPivot.add(podGrp);
      }
    }
  }

  const neckMesh = tagHitMesh(
    new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.14, 0.12, 8), neckLimbMat),
    'torso',
    'torso'
  );
  neckMesh.position.set(0, abdomenH + chestH + 0.04, 0.02);
  upperBodyPivot.add(neckMesh);

  // === HEAD / DEFINED TOUGH FACE / WEAKSPOT ===
  let weakspotMesh: THREE.Mesh;
  const headLocalY = abdomenH + chestH + 0.22;

  if (isMech) {
    // Ventral Gyro Core weakspot in chest + tough armored recon head
    weakspotMesh = tagHitMesh(
      new THREE.Mesh(new THREE.OctahedronGeometry(0.19, 1), weakspotMat),
      'weakspot',
      'torso'
    );
    weakspotMesh.position.set(0, chestCenterY, chestD * 0.5 + 0.08);
    const cowl = tagHitMesh(
      new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.28, 0.34), headPlateMat),
      'torso',
      'head',
      true
    );
    cowl.position.set(0, headLocalY, 0.04);
    upperBodyPivot.add(cowl);
    attachToughMechFace(upperBodyPivot, 0, headLocalY, 0.04, 0.34, 0.28, 0.34, false);
  } else if (isTank) {
    weakspotMesh = tagHitMesh(
      new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.28, 0.36), weakspotMat),
      'weakspot',
      'head',
      true
    );
    weakspotMesh.position.set(0, headLocalY + 0.02, 0.08);
    attachToughMechFace(upperBodyPivot, 0, headLocalY + 0.02, 0.08, 0.42, 0.28, 0.36, true);
  } else if (isSwarmer) {
    weakspotMesh = tagHitMesh(
      new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.28, 0.32), weakspotMat),
      'weakspot',
      'head',
      true
    );
    weakspotMesh.position.set(0, headLocalY - 0.01, 0.1);
    attachToughMechFace(upperBodyPivot, 0, headLocalY - 0.01, 0.1, 0.32, 0.28, 0.32, true);
  } else {
    weakspotMesh = tagHitMesh(
      new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.32, 0.32), weakspotMat),
      'weakspot',
      'head',
      true
    );
    weakspotMesh.position.set(0, headLocalY, isBrute ? 0.10 : 0.05);
    attachToughMechFace(
      upperBodyPivot,
      0,
      headLocalY,
      isBrute ? 0.10 : 0.05,
      0.32,
      0.32,
      0.32,
      true
    );
  }
  upperBodyPivot.add(weakspotMesh);

  const weakspotWorldY =
    hipY +
    0.11 +
    Math.cos(torsoPitch) * weakspotMesh.position.y -
    Math.sin(torsoPitch) * weakspotMesh.position.z;

  // === ARTICULATED ARMS + SHIELD / MELEE WEAPONS / RANGED WEAPONS ===
  const shoulderR = isTank ? 0.22 : isTitan ? 0.18 : isSwarmer ? 0.115 : 0.15;
  const upperArmLen = isSwarmer ? 0.25 : isTank ? 0.36 : 0.33;
  const forearmLen = isSwarmer ? 0.27 : isTank ? 0.38 : 0.34;
  const upperArmW = isTank ? 0.20 : isTitan ? 0.16 : isSwarmer ? 0.10 : 0.13;
  const forearmW = isTank ? 0.22 : isTitan ? 0.17 : isSwarmer ? 0.105 : 0.14;

  let shieldGroup: THREE.Group | undefined;
  let shieldMat: THREE.MeshStandardMaterial | undefined;
  let weaponMuzzlePoint: THREE.Object3D | undefined;

  const buildHumanoidArm = (side: -1 | 1) => {
    const armRegion: BodyRegionKey = side === -1 ? 'leftArm' : 'rightArm';
    const aPlateMat = side === -1 ? leftArmPlateMat : rightArmPlateMat;
    const aLimbMat = side === -1 ? leftArmLimbMat : rightArmLimbMat;

    const armGroup = new THREE.Group();
    armGroup.position.set(
      side * (chestW * 0.5 + shoulderR * 0.62),
      abdomenH + chestH * 0.82,
      0.02
    );

    const shoulderCap = tagHitMesh(
      new THREE.Mesh(new THREE.SphereGeometry(shoulderR, 8, 6), aPlateMat),
      'limb',
      armRegion
    );
    shoulderCap.scale.set(1.12, 1.0, 1.12);
    armGroup.add(shoulderCap);

    const shoulderArmor = tagHitMesh(
      new THREE.Mesh(
        new THREE.BoxGeometry(shoulderR * 2.0, shoulderR * 1.15, shoulderR * 2.05),
        aPlateMat
      ),
      'limb',
      armRegion
    );
    shoulderArmor.position.set(side * 0.03, 0.05, 0);
    shoulderArmor.rotation.z = -side * 0.22;
    armGroup.add(shoulderArmor);

    const upperArmMesh = tagHitMesh(
      new THREE.Mesh(
        new THREE.CylinderGeometry(upperArmW * 0.65, upperArmW * 0.55, upperArmLen, 8),
        aLimbMat
      ),
      'limb',
      armRegion
    );
    upperArmMesh.position.set(0, -upperArmLen * 0.5, 0);
    armGroup.add(upperArmMesh);

    const bicepPlate = tagHitMesh(
      new THREE.Mesh(
        new THREE.BoxGeometry(upperArmW * 1.1, upperArmLen * 0.66, upperArmW * 1.15),
        aPlateMat
      ),
      'limb',
      armRegion
    );
    bicepPlate.position.set(side * 0.015, -upperArmLen * 0.46, 0);
    armGroup.add(bicepPlate);

    const elbowGroup = new THREE.Group();
    elbowGroup.position.set(0, -upperArmLen, 0);
    elbowGroup.rotation.x = -0.45;
    armGroup.add(elbowGroup);

    const forearmMesh = tagHitMesh(
      new THREE.Mesh(
        new THREE.BoxGeometry(forearmW, forearmLen, forearmW * 1.15),
        aLimbMat
      ),
      'limb',
      armRegion
    );
    forearmMesh.position.set(0, -forearmLen * 0.5, 0.02);
    elbowGroup.add(forearmMesh);

    const bracerPlate = tagHitMesh(
      new THREE.Mesh(
        new THREE.BoxGeometry(forearmW * 1.18, forearmLen * 0.72, forearmW * 0.72),
        aPlateMat
      ),
      'limb',
      armRegion
    );
    bracerPlate.position.set(side * 0.02, -forearmLen * 0.48, forearmW * 0.42);
    elbowGroup.add(bracerPlate);

    const handMesh = tagHitMesh(
      new THREE.Mesh(
        new THREE.BoxGeometry(forearmW * 0.95, 0.11, forearmW * 1.1),
        aPlateMat
      ),
      'limb',
      armRegion
    );
    handMesh.position.set(0, -forearmLen - 0.03, 0.05);
    elbowGroup.add(handMesh);

    // Left Arm: Attach Large Ballistic Riot Shield when loadout.hasShield is enabled
    if (side === -1 && loadout.hasShield) {
      shieldGroup = new THREE.Group();
      shieldGroup.position.set(-0.08, -forearmLen * 0.35, 0.24);
      shieldMat = registerRegionMat(
        'shield',
        new THREE.MeshStandardMaterial({
          color: 0x364152,
          roughness: 0.42,
          metalness: 0.85,
        })
      );
      const shieldW = isTank ? 0.96 : isTitan ? 0.86 : 0.76;
      const shieldH = isTank ? 1.56 : isTitan ? 1.44 : 1.32;
      const shieldPlate = tagHitMesh(
        new THREE.Mesh(new THREE.BoxGeometry(shieldW, shieldH, 0.1), shieldMat),
        'torso',
        'shield',
        true
      );
      shieldPlate.userData.isShield = true;

      const shieldViewport = new THREE.Mesh(
        new THREE.BoxGeometry(shieldW * 0.56, 0.14, 0.12),
        trimMat
      );
      shieldViewport.position.y = shieldH * 0.24;

      const bossPlate = tagHitMesh(
        new THREE.Mesh(new THREE.BoxGeometry(shieldW * 0.42, shieldH * 0.42, 0.14), shieldMat),
        'torso',
        'shield'
      );
      bossPlate.userData.isShield = true;

      shieldGroup.add(shieldPlate, shieldViewport, bossPlate);
      elbowGroup.add(shieldGroup);
    } else if (side === 1 && loadout.meleeWeaponId) {
      // Right Arm: Attach Long Sword, Great Sword, or Halberd
      const mw = new THREE.Group();
      mw.position.set(0, -forearmLen - 0.02, 0.08);
      mw.rotation.x = Math.PI * 0.38;

      if (loadout.meleeWeaponId === 'enemy_long_sword') {
        const hilt = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.03, 0.04), trimMat);
        const blade = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.95, 0.02), enemyBladeMat);
        blade.position.y = 0.52;
        const tip = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.18, 4), enemyBladeMat);
        tip.position.y = 1.08;
        mw.add(hilt, blade, tip);
      } else if (loadout.meleeWeaponId === 'enemy_great_sword') {
        const hilt = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.05, 0.06), trimMat);
        const blade = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.28, 0.032), enemyBladeMat);
        blade.position.y = 0.68;
        const tip = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.24, 4), enemyBladeMat);
        tip.position.y = 1.44;
        mw.add(hilt, blade, tip);
      } else {
        // Halberd matching player's polearm geometry
        const shaft = new THREE.Mesh(
          new THREE.CylinderGeometry(0.022, 0.024, 1.55, 8),
          enemyGunMat
        );
        shaft.position.y = 0.62;
        const spearTip = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.34, 4), enemyBladeMat);
        spearTip.position.y = 1.52;
        const axeHead = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.32, 0.24), enemyBladeMat);
        axeHead.position.set(0, 1.22, 0.11);
        const axeEdge = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.28, 0.03), trimMat);
        axeEdge.position.set(0, 1.22, 0.23);
        mw.add(shaft, spearTip, axeHead, axeEdge);
      }
      elbowGroup.add(mw);
    } else if (side === 1 && loadout.rangedWeaponId) {
      // Right Arm: Detailed Assault Rifle, Shotgun, Plasma Rifle, or 20mm Cannon
      // Rotated +90 deg around X so when arm+elbow aim forward (-90 deg), the gun points straight ahead (+Z)
      const rw = new THREE.Group();
      rw.position.set(0.03, -forearmLen - 0.02, 0.08);
      rw.rotation.x = Math.PI * 0.5;

      const isPlasma = loadout.rangedWeaponId === 'enemy_plasma';
      const isCannon = loadout.rangedWeaponId === 'enemy_20mm';
      const isShotgun = loadout.rangedWeaponId === 'enemy_shotgun';

      const bodyW = isCannon ? 0.135 : isPlasma ? 0.115 : 0.082;
      const bodyH = isCannon ? 0.145 : isPlasma ? 0.125 : 0.115;
      const bodyL = isCannon ? 0.66 : isPlasma ? 0.58 : isShotgun ? 0.52 : 0.48;
      const barrelLen = isCannon ? 0.52 : isShotgun ? 0.44 : isPlasma ? 0.38 : 0.36;
      const barrelR = isCannon ? 0.032 : isShotgun ? 0.022 : 0.017;

      // Pistol grip seated in mech hand + compact rear shoulder stock
      const grip = new THREE.Mesh(
        new THREE.BoxGeometry(bodyW * 0.62, 0.12, 0.065),
        aLimbMat
      );
      grip.position.set(0, -0.075, 0.02);
      grip.rotation.x = 0.22;

      const stock = new THREE.Mesh(
        new THREE.BoxGeometry(bodyW * 0.72, bodyH * 0.74, 0.18),
        aPlateMat
      );
      stock.position.set(0, -0.01, -0.1);

      // Main upper & lower receiver
      const receiver = new THREE.Mesh(
        new THREE.BoxGeometry(bodyW, bodyH, bodyL),
        enemyGunMat
      );
      receiver.position.set(0, 0.01, bodyL * 0.5 - 0.04);

      // Ventilated barrel shroud / handguard
      const shroudLen = bodyL * 0.65;
      const shroud = new THREE.Mesh(
        new THREE.BoxGeometry(bodyW * 0.9, bodyH * 0.78, shroudLen),
        aPlateMat
      );
      shroud.position.set(0, 0.012, bodyL + shroudLen * 0.42 - 0.04);

      // Top tactical Picatinny rail + reflex optic sight
      const topRail = new THREE.Mesh(
        new THREE.BoxGeometry(bodyW * 0.46, 0.022, bodyL * 0.78),
        clawMat
      );
      topRail.position.set(0, bodyH * 0.5 + 0.018, bodyL * 0.48);

      const opticBody = new THREE.Mesh(
        new THREE.BoxGeometry(bodyW * 0.52, 0.055, 0.12),
        aPlateMat
      );
      opticBody.position.set(0, bodyH * 0.5 + 0.048, bodyL * 0.38);

      const opticLens = new THREE.Mesh(
        new THREE.BoxGeometry(bodyW * 0.36, 0.03, 0.02),
        isPlasma ? opticVisorMat : trimMat
      );
      opticLens.position.set(0, bodyH * 0.5 + 0.048, bodyL * 0.38 + 0.058);

      // Angled foregrip under handguard
      const foregrip = new THREE.Mesh(
        new THREE.BoxGeometry(bodyW * 0.45, 0.095, 0.052),
        aLimbMat
      );
      foregrip.position.set(0, -0.075, bodyL * 0.85);
      foregrip.rotation.x = -0.25;

      // Primary barrel + muzzle brake
      const barrelStartZ = bodyL - 0.04;
      const barrel = new THREE.Mesh(
        new THREE.CylinderGeometry(barrelR, barrelR * 1.12, barrelLen, 8),
        clawMat
      );
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(0, 0.02, barrelStartZ + barrelLen * 0.5);

      const muzzleTipZ = barrelStartZ + barrelLen;
      const muzzleBrake = new THREE.Mesh(
        new THREE.BoxGeometry(barrelR * 2.8, barrelR * 2.5, 0.085),
        enemyGunMat
      );
      muzzleBrake.position.set(0, 0.02, muzzleTipZ - 0.01);

      // Side energy / heat indicator strip
      const glowStrip = new THREE.Mesh(
        new THREE.BoxGeometry(bodyW + 0.014, 0.026, bodyL * 0.58),
        isPlasma ? opticVisorMat : trimMat
      );
      glowStrip.position.set(0, 0.028, bodyL * 0.56);

      rw.add(
        grip,
        stock,
        receiver,
        shroud,
        topRail,
        opticBody,
        opticLens,
        foregrip,
        barrel,
        muzzleBrake,
        glowStrip
      );

      // Weapon-class-specific magazine / tube / plasma coils
      if (isShotgun) {
        const underTube = new THREE.Mesh(
          new THREE.CylinderGeometry(barrelR * 0.88, barrelR * 0.88, barrelLen * 0.86, 8),
          aPlateMat
        );
        underTube.rotation.x = Math.PI / 2;
        underTube.position.set(0, -0.02, barrelStartZ + barrelLen * 0.42);
        const pumpSleeve = new THREE.Mesh(
          new THREE.BoxGeometry(bodyW * 0.84, 0.065, 0.2),
          aLimbMat
        );
        pumpSleeve.position.set(0, -0.025, barrelStartZ + 0.14);
        rw.add(underTube, pumpSleeve);
      } else if (isPlasma) {
        const cell = new THREE.Mesh(
          new THREE.BoxGeometry(bodyW * 0.72, 0.11, 0.15),
          opticVisorMat
        );
        cell.position.set(0, -0.078, bodyL * 0.48);
        rw.add(cell);
        for (let c = 0; c < 3; c++) {
          const coil = new THREE.Mesh(
            new THREE.BoxGeometry(bodyW * 0.96, bodyH * 0.84, 0.036),
            opticVisorMat
          );
          coil.position.set(0, 0.018, barrelStartZ + 0.09 + c * 0.095);
          rw.add(coil);
        }
      } else if (isCannon) {
        const ammoDrum = new THREE.Mesh(
          new THREE.CylinderGeometry(0.09, 0.09, 0.13, 10),
          aPlateMat
        );
        ammoDrum.rotation.z = Math.PI / 2;
        ammoDrum.position.set(-0.04, -0.09, bodyL * 0.52);
        rw.add(ammoDrum);
      } else {
        const mag = new THREE.Mesh(
          new THREE.BoxGeometry(bodyW * 0.56, 0.17, 0.075),
          aPlateMat
        );
        mag.position.set(0, -0.1, bodyL * 0.52);
        mag.rotation.x = -0.18;
        rw.add(mag);
      }

      weaponMuzzlePoint = new THREE.Object3D();
      weaponMuzzlePoint.position.set(0, 0.02, muzzleTipZ + 0.05);
      rw.add(weaponMuzzlePoint);
      elbowGroup.add(rw);
    } else {
      // Default twin/triple gauntlet claws for off-hand without shield/weapon
      const bladeCount = isTank ? 2 : 3;
      for (let c = 0; c < bladeCount; c++) {
        const offset = c - (bladeCount - 1) * 0.5;
        const blade = new THREE.Mesh(
          new THREE.ConeGeometry(isTank ? 0.045 : 0.03, isBrute ? 0.46 : 0.34, 4),
          clawMat
        );
        blade.rotation.x = Math.PI * 0.56;
        blade.position.set(offset * 0.06, -forearmLen - 0.1, 0.24);
        elbowGroup.add(blade);
      }
    }

    return { armGroup, elbowGroup };
  };

  const leftArmBuilt = buildHumanoidArm(-1);
  const rightArmBuilt = buildHumanoidArm(1);
  const leftClawArm = leftArmBuilt.armGroup;
  const rightClawArm = rightArmBuilt.armGroup;
  const leftElbow = leftArmBuilt.elbowGroup;
  const rightElbow = rightArmBuilt.elbowGroup;
  upperBodyPivot.add(leftClawArm, rightClawArm);

  root.scale.set(target.scaleXZ, target.scaleY, target.scaleXZ);

  return {
    root,
    bodyGroup,
    leftLeg,
    rightLeg,
    leftKnee,
    rightKnee,
    leftClawArm,
    rightClawArm,
    leftElbow,
    rightElbow,
    weakspotMesh,
    hitMeshes,
    weakspotHeight: weakspotWorldY * target.scaleY,
    loadout,
    shieldGroup,
    shieldMat,
    weaponMuzzlePoint,
    rocketMuzzlePoints,
    regionMaterials,
    baseRegionColors,
  };
}

/** Legacy standalone firing lane generator retained for compatibility. */
export function buildTacticalRangeEnvironment(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
  isSoftwareGl: boolean
): { dispose: () => void } {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#0c1018';
    ctx.fillRect(0, 0, size, size);

    ctx.strokeStyle = 'rgba(0, 240, 255, 0.14)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0, 0, size, size);

    ctx.strokeStyle = 'rgba(140, 155, 181, 0.08)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const p = (size / 4) * i;
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, size);
      ctx.moveTo(0, p);
      ctx.lineTo(size, p);
      ctx.stroke();
    }

    ctx.fillStyle = 'rgba(255, 179, 0, 0.35)';
    ctx.fillRect(0, 0, 3, 3);
  }

  const floorTex = new THREE.CanvasTexture(canvas);
  floorTex.colorSpace = THREE.SRGBColorSpace;
  floorTex.wrapS = THREE.RepeatWrapping;
  floorTex.wrapT = THREE.RepeatWrapping;
  floorTex.repeat.set(36, 36);
  floorTex.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());

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

/**
 * Builds the first-person held viewmodel when the player switches to the CONSUMABLE slot
 * so thrown canisters, mines, sticky C4 + clacker, and turret pods are visibly equipped in hand.
 */
export function buildConsumableViewmodel3D(consumableId: GrenadeId): BuiltWeapon3D {
  const root = new THREE.Group();
  const darkBodyMat = new THREE.MeshStandardMaterial({
    color: 0x1b2330,
    roughness: 0.48,
    metalness: 0.72,
  });
  const oliveMat = new THREE.MeshStandardMaterial({
    color: 0x2c3c2e,
    roughness: 0.58,
    metalness: 0.35,
  });

  const accentHex =
    consumableId === 'stun'
      ? 0x00f0ff
      : consumableId === 'incendiary'
        ? 0xff7b29
        : consumableId === 'explosive'
          ? 0xff2a4b
          : consumableId === 'trip_mine'
            ? 0xffb300
            : consumableId === 'laser_trip_mine'
              ? 0xff2a88
              : consumableId === 'sticky_c4'
                ? 0xff5a1f
                : 0x20df78;

  const accentMat = new THREE.MeshStandardMaterial({
    color: accentHex,
    roughness: 0.25,
    metalness: 0.35,
    emissive: accentHex,
    emissiveIntensity: 0.85,
  });

  if (consumableId === 'trip_mine') {
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.09, 0.042, 16), darkBodyMat);
    disc.rotation.x = 0.55;
    const beacon = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.02, 12), accentMat);
    beacon.position.y = 0.026;
    disc.add(beacon);
    for (let i = 0; i < 3; i++) {
      const prong = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.014, 0.045), darkBodyMat);
      const ang = (i * Math.PI * 2) / 3;
      prong.position.set(Math.sin(ang) * 0.085, 0.01, Math.cos(ang) * 0.085);
      prong.rotation.y = ang;
      disc.add(prong);
    }
    root.add(disc);
  } else if (consumableId === 'laser_trip_mine') {
    const housing = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.075, 0.095), darkBodyMat);
    housing.rotation.set(0.18, -0.25, 0);
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.025, 12), accentMat);
    lens.rotation.x = Math.PI / 2;
    lens.position.set(0, 0.01, -0.048);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.125, 0.012, 0.04), accentMat);
    fin.position.set(0, -0.02, 0.015);
    housing.add(lens, fin);
    root.add(housing);
  } else if (consumableId === 'sticky_c4') {
    const brick = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.055, 0.14), oliveMat);
    brick.rotation.set(0.28, -0.22, 0.08);
    const strap = new THREE.Mesh(new THREE.BoxGeometry(0.116, 0.06, 0.03), darkBodyMat);
    const detonatorCap = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.02, 0.045), darkBodyMat);
    detonatorCap.position.set(0, 0.034, -0.02);
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.01, 8, 8), accentMat);
    led.position.set(0.015, 0.045, -0.02);
    brick.add(strap, detonatorCap, led);
    root.add(brick);
  } else if (consumableId === 'deployable_turret') {
    const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.068, 0.082, 0.13, 12), darkBodyMat);
    pod.rotation.set(0.22, -0.18, 0);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.074, 0.008, 8, 18), accentMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.03;
    const barrelStub = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.09, 8), darkBodyMat);
    barrelStub.rotation.x = Math.PI / 2;
    barrelStub.position.set(0, 0.045, -0.06);
    pod.add(ring, barrelStub);
    root.add(pod);
  } else {
    // Standard tactical cylindrical canister for Stun, Incendiary, and Explosive grenades
    const canister = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.036, 0.13, 14), darkBodyMat);
    canister.rotation.set(0.2, 0, -0.16);
    const stripe = new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.038, 0.032, 14), accentMat);
    const spoon = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.09, 0.014), darkBodyMat);
    spoon.position.set(0.042, 0.01, 0);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.016, 0.003, 6, 12), accentMat);
    ring.position.set(-0.022, 0.068, 0);
    canister.add(stripe, spoon, ring);
    root.add(canister);
  }

  const muzzlePoint = new THREE.Object3D();
  muzzlePoint.position.set(0, 0, -0.12);
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
    opticOffset: new THREE.Vector3(0.24, -0.22, -0.36),
    hipOffset: new THREE.Vector3(0.24, -0.22, -0.36),
    isMelee: false,
  };
}

/** World-space 3D mesh for a proximity floor trip mine (1000 DMG @ 5m). */
export function buildTripMineMesh3D(): {
  root: THREE.Group;
  ledMesh: THREE.Mesh;
  hitMesh: THREE.Mesh;
} {
  const root = new THREE.Group();
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.22, 0.26, 0.09, 16),
    new THREE.MeshStandardMaterial({ color: 0x1d2430, roughness: 0.45, metalness: 0.78 })
  );
  base.position.y = 0.045;
  root.add(base);

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.21, 0.018, 8, 24),
    new THREE.MeshBasicMaterial({ color: 0xffb300, transparent: true, opacity: 0.75 })
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.06;
  root.add(ring);

  const ledMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.045, 10, 10),
    new THREE.MeshBasicMaterial({ color: 0xffb300 })
  );
  ledMesh.position.y = 0.1;
  root.add(ledMesh);

  // Invisible raycast proxy for shooting or [E] pickup
  const hitMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.38, 0.38, 0.34, 12),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  hitMesh.position.y = 0.17;
  root.add(hitMesh);

  return { root, ledMesh, hitMesh };
}

/** World-space 3D mesh for wall/floor-mountable Laser Trip Mine projecting a 12m visible beam along +Z. */
export function buildLaserTripMineMesh3D(beamLength = 12): {
  root: THREE.Group;
  beamMesh: THREE.Mesh;
  hitMesh: THREE.Mesh;
} {
  const root = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.24, 0.16, 0.14),
    new THREE.MeshStandardMaterial({ color: 0x1c222e, roughness: 0.4, metalness: 0.82 })
  );
  root.add(body);

  const emitter = new THREE.Mesh(
    new THREE.CylinderGeometry(0.036, 0.036, 0.06, 12),
    new THREE.MeshStandardMaterial({
      color: 0xff2a88,
      emissive: 0xff2a88,
      emissiveIntensity: 1.5,
    })
  );
  emitter.rotation.x = Math.PI / 2;
  emitter.position.z = 0.08;
  root.add(emitter);

  const beamGeo = new THREE.CylinderGeometry(0.018, 0.018, beamLength, 8);
  beamGeo.rotateX(Math.PI / 2);
  beamGeo.translate(0, 0, beamLength * 0.5);
  const beamMesh = new THREE.Mesh(
    beamGeo,
    new THREE.MeshBasicMaterial({
      color: 0xff2a88,
      transparent: true,
      opacity: 0.72,
    })
  );
  beamMesh.position.z = 0.09;
  root.add(beamMesh);

  const hitMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.46, 0.4, 0.42),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  root.add(hitMesh);

  return { root, beamMesh, hitMesh };
}

/** World-space 3D mesh for Sticky Remote C4 pack (attaches to walls, floors, or enemies). */
export function buildStickyC4Mesh3D(): {
  root: THREE.Group;
  ledMesh: THREE.Mesh;
  hitMesh: THREE.Mesh;
} {
  const root = new THREE.Group();
  const pack = new THREE.Mesh(
    new THREE.BoxGeometry(0.24, 0.11, 0.3),
    new THREE.MeshStandardMaterial({ color: 0x2c3c2e, roughness: 0.65, metalness: 0.3 })
  );
  root.add(pack);

  const receiver = new THREE.Mesh(
    new THREE.BoxGeometry(0.11, 0.04, 0.12),
    new THREE.MeshStandardMaterial({ color: 0x151922, roughness: 0.4, metalness: 0.75 })
  );
  receiver.position.y = 0.07;
  root.add(receiver);

  const ledMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.026, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0xff3b2f })
  );
  ledMesh.position.set(0.03, 0.095, -0.02);
  root.add(ledMesh);

  const hitMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.32, 10, 8),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  root.add(hitMesh);

  return { root, ledMesh, hitMesh };
}

/** Articulated world-space 3D model for the Deployable Sentry Turret (90° yaw cone, -15°..+36° pitch). */
export function buildDeployableTurretMesh3D(): {
  root: THREE.Group;
  yawGroup: THREE.Group;
  pitchGroup: THREE.Group;
  muzzlePoint: THREE.Object3D;
  muzzleFlash: THREE.Mesh;
  hitMesh: THREE.Mesh;
} {
  const root = new THREE.Group();
  const metalMat = new THREE.MeshStandardMaterial({
    color: 0x252f3e,
    roughness: 0.35,
    metalness: 0.85,
  });
  const accentMat = new THREE.MeshStandardMaterial({
    color: 0x20df78,
    emissive: 0x20df78,
    emissiveIntensity: 0.9,
  });

  // 3-leg heavy tripod pedestal
  for (let i = 0; i < 3; i++) {
    const ang = (i * Math.PI * 2) / 3;
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.56, 0.12), metalMat);
    leg.position.set(Math.sin(ang) * 0.28, 0.25, Math.cos(ang) * 0.28);
    leg.rotation.y = ang;
    leg.rotation.x = 0.38;
    root.add(leg);
  }

  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 0.18, 12), metalMat);
  hub.position.y = 0.52;
  root.add(hub);

  const yawGroup = new THREE.Group();
  yawGroup.position.y = 0.66;
  root.add(yawGroup);

  const pitchGroup = new THREE.Group();
  yawGroup.add(pitchGroup);

  const gunBody = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.22, 0.48), metalMat);
  pitchGroup.add(gunBody);

  const optic = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 10), accentMat);
  optic.position.set(0, 0.13, 0.16);
  pitchGroup.add(optic);

  for (const sx of [-0.05, 0.05]) {
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.024, 0.52, 8), metalMat);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(sx, 0.01, 0.44);
    pitchGroup.add(barrel);
  }

  const muzzlePoint = new THREE.Object3D();
  muzzlePoint.position.set(0, 0.01, 0.72);
  pitchGroup.add(muzzlePoint);

  const muzzleFlash = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.09, 0),
    new THREE.MeshBasicMaterial({ color: 0xffb300, transparent: true, opacity: 0.9 })
  );
  muzzleFlash.scale.set(0.8, 0.8, 2.2);
  muzzleFlash.position.copy(muzzlePoint.position);
  muzzleFlash.visible = false;
  pitchGroup.add(muzzleFlash);

  // Invisible pickup raycast proxy for [E] retrieval
  const hitMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.42, 0.42, 0.92, 10),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  hitMesh.position.y = 0.46;
  root.add(hitMesh);

  root.scale.setScalar(1.3);

  return { root, yawGroup, pitchGroup, muzzlePoint, muzzleFlash, hitMesh };
}

/**
 * Builds a dropped tactical ammo supply crate with olive-steel casing,
 * high-visibility emerald/amber stencil stripes, carry handles, and floating pickup beacon.
 */
export function buildAmmoBox3D(): THREE.Group {
  const root = new THREE.Group();

  const crateMat = new THREE.MeshStandardMaterial({
    color: 0x2d3b2c,
    roughness: 0.45,
    metalness: 0.65,
  });
  const trimMat = new THREE.MeshStandardMaterial({
    color: 0x161c24,
    roughness: 0.35,
    metalness: 0.85,
  });
  const stripeMat = new THREE.MeshStandardMaterial({
    color: 0xffb300,
    emissive: 0x4a3200,
    emissiveIntensity: 0.7,
    roughness: 0.35,
  });
  const beaconMat = new THREE.MeshStandardMaterial({
    color: 0x20df78,
    emissive: 0x20df78,
    emissiveIntensity: 1.25,
    roughness: 0.25,
    transparent: true,
    opacity: 0.9,
  });

  // Main reinforced steel ammo case
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.30, 0.38), crateMat);
  body.position.y = 0.15;
  body.castShadow = true;
  body.receiveShadow = true;
  root.add(body);

  // Lid overhang + locking latches
  const lid = new THREE.Mesh(new THREE.BoxGeometry(0.59, 0.06, 0.41), trimMat);
  lid.position.y = 0.31;
  lid.castShadow = true;
  root.add(lid);

  // High-visibility amber tactical stripe around center
  const band = new THREE.Mesh(new THREE.BoxGeometry(0.575, 0.065, 0.395), stripeMat);
  band.position.y = 0.16;
  root.add(band);

  // Side carry handles
  for (const sx of [-0.30, 0.30]) {
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.06, 0.18), trimMat);
    handle.position.set(sx, 0.20, 0);
    root.add(handle);
  }

  // Floating emerald diamond beacon above crate for high combat readability
  const beacon = new THREE.Mesh(new THREE.OctahedronGeometry(0.11, 0), beaconMat);
  beacon.position.y = 0.58;
  beacon.name = 'ammoBeacon';
  root.add(beacon);

  return root;
}

/**
 * Builds a dropped tactical consumable ordnance resupply case with slate-alloy casing,
 * thermite-orange hazard band, and floating electric-cyan diamond beacon.
 */
export function buildConsumableBox3D(): THREE.Group {
  const root = new THREE.Group();

  const crateMat = new THREE.MeshStandardMaterial({
    color: 0x1d2536,
    roughness: 0.4,
    metalness: 0.72,
  });
  const trimMat = new THREE.MeshStandardMaterial({
    color: 0x101520,
    roughness: 0.35,
    metalness: 0.85,
  });
  const stripeMat = new THREE.MeshStandardMaterial({
    color: 0xff6a00,
    emissive: 0x6b2800,
    emissiveIntensity: 0.9,
    roughness: 0.3,
  });
  const beaconMat = new THREE.MeshStandardMaterial({
    color: 0x00f0ff,
    emissive: 0x00f0ff,
    emissiveIntensity: 1.35,
    roughness: 0.2,
    transparent: true,
    opacity: 0.92,
  });

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.28, 0.42), crateMat);
  body.position.y = 0.14;
  body.castShadow = true;
  body.receiveShadow = true;
  root.add(body);

  const lid = new THREE.Mesh(new THREE.BoxGeometry(0.51, 0.06, 0.45), trimMat);
  lid.position.y = 0.29;
  lid.castShadow = true;
  root.add(lid);

  const band = new THREE.Mesh(new THREE.BoxGeometry(0.495, 0.06, 0.435), stripeMat);
  band.position.y = 0.15;
  root.add(band);

  const beacon = new THREE.Mesh(new THREE.OctahedronGeometry(0.115, 0), beaconMat);
  beacon.position.y = 0.56;
  beacon.name = 'consumableBeacon';
  root.add(beacon);

  return root;
}


