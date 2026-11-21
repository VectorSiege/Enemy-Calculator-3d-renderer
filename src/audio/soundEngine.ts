class TacticalSoundEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private muted = false;

  private lastEmptyAt = 0;
  private lastGroundAt = 0;
  private lastArmorAt = 0;
  private lastWeakspotAt = 0;

  private ensureContext(): AudioContext | null {
    if (this.muted || typeof window === 'undefined') return null;

    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return null;

      const ctx = new AudioCtx();
      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -14;
      compressor.knee.value = 18;
      compressor.ratio.value = 6;
      compressor.attack.value = 0.002;
      compressor.release.value = 0.14;

      const masterGain = ctx.createGain();
      masterGain.gain.value = 0.72;

      compressor.connect(masterGain);
      masterGain.connect(ctx.destination);

      // Pre-allocate 1.5s reusable white noise buffer
      const sampleCount = Math.floor(ctx.sampleRate * 1.5);
      const buffer = ctx.createBuffer(1, sampleCount, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < sampleCount; i++) {
        data[i] = Math.random() * 2 - 1;
      }

      this.ctx = ctx;
      this.compressor = compressor;
      this.masterGain = masterGain;
      this.noiseBuffer = buffer;
    }

    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }

    return this.ctx;
  }

  public unlock(): void {
    this.ensureContext();
  }

  public isMuted(): boolean {
    return this.muted;
  }

  public setMuted(next: boolean): void {
    this.muted = next;
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(next ? 0 : 0.72, this.ctx.currentTime, 0.015);
    }
  }

  private playNoise(
    startTime: number,
    duration: number,
    filterType: BiquadFilterType,
    freqStart: number,
    freqEnd: number,
    q: number,
    gainPeak: number
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.compressor || !this.noiseBuffer) return;

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(Math.max(20, freqStart), startTime);
    if (freqEnd !== freqStart) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), startTime + duration);
    }

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.linearRampToValueAtTime(gainPeak, startTime + Math.min(0.008, duration * 0.2));
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.compressor);

    src.start(startTime, Math.random() * 0.8);
    src.stop(startTime + duration + 0.02);
  }

  private playTone(
    startTime: number,
    duration: number,
    type: OscillatorType,
    freqStart: number,
    freqEnd: number,
    gainPeak: number
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.compressor) return;

    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(20, freqStart), startTime);
    if (freqEnd !== freqStart) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), startTime + duration);
    }

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.linearRampToValueAtTime(gainPeak, startTime + Math.min(0.006, duration * 0.18));
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

    osc.connect(gain);
    gain.connect(this.compressor);

    osc.start(startTime);
    osc.stop(startTime + duration + 0.02);
  }

  /** Distinct procedural gunshot per weapon platform */
  public playWeaponFire(weaponId: string): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const t = ctx.currentTime;

    switch (weaponId) {
      case 'm47_rail': {
        // Electromagnetic rail crack + snappy kinetic body
        this.playTone(t, 0.075, 'sawtooth', 2200, 320, 0.24);
        this.playTone(t, 0.09, 'triangle', 220, 64, 0.42);
        this.playNoise(t, 0.1, 'bandpass', 2400, 950, 1.4, 0.46);
        break;
      }
      case 'valkyrie_dmr': {
        // Heavy anti-materiel crack + deep chest punch + resonant tail
        this.playTone(t, 0.16, 'sine', 195, 42, 0.65);
        this.playTone(t, 0.09, 'sawtooth', 980, 140, 0.28);
        this.playNoise(t, 0.07, 'highpass', 2600, 1400, 0.9, 0.52);
        this.playNoise(t + 0.015, 0.24, 'bandpass', 1400, 360, 1.1, 0.44);
        break;
      }
      case 'helios_plasma': {
        // Ionized plasma bolt discharge + thermal hiss
        this.playTone(t, 0.11, 'sawtooth', 1280, 210, 0.28);
        this.playTone(t, 0.1, 'square', 640, 140, 0.16);
        this.playNoise(t, 0.12, 'bandpass', 3400, 720, 2.2, 0.34);
        break;
      }
      case 'kestrel_smg': {
        // Fast high-cyclic compact caseless pop
        this.playTone(t, 0.055, 'triangle', 290, 92, 0.34);
        this.playNoise(t, 0.06, 'bandpass', 2700, 1100, 1.5, 0.38);
        break;
      }
      case 'novacula_mg': {
        // Heavy 7.62mm machine gun bark
        this.playTone(t, 0.115, 'sawtooth', 180, 48, 0.52);
        this.playTone(t, 0.075, 'square', 340, 95, 0.22);
        this.playNoise(t, 0.145, 'lowpass', 2600, 480, 0.85, 0.55);
        break;
      }
      case 'choque_shotgun': {
        // Massive 12-gauge flechette boom + shell blast + subtle cycle clack
        this.playTone(t, 0.19, 'sine', 145, 34, 0.72);
        this.playNoise(t, 0.22, 'lowpass', 2900, 320, 0.7, 0.74);
        this.playNoise(t, 0.08, 'highpass', 2200, 1600, 0.8, 0.36);
        this.playNoise(t + 0.12, 0.04, 'bandpass', 1900, 1400, 3.2, 0.16);
        break;
      }
      default: {
        this.playTone(t, 0.09, 'triangle', 220, 68, 0.4);
        this.playNoise(t, 0.1, 'bandpass', 2000, 750, 1.2, 0.4);
      }
    }
  }

  /** Standard composite/armor plate hit */
  public playHitArmor(): void {
    const nowMs = performance.now();
    if (nowMs - this.lastArmorAt < 28) return;
    this.lastArmorAt = nowMs;

    const ctx = this.ensureContext();
    if (!ctx) return;
    const t = ctx.currentTime;

    this.playTone(t, 0.075, 'triangle', 460, 165, 0.28);
    this.playNoise(t, 0.065, 'bandpass', 1450, 680, 2.2, 0.3);
  }

  /** High-priority weakspot / critical strike */
  public playHitWeakspot(): void {
    const nowMs = performance.now();
    if (nowMs - this.lastWeakspotAt < 25) return;
    this.lastWeakspotAt = nowMs;

    const ctx = this.ensureContext();
    if (!ctx) return;
    const t = ctx.currentTime;

    this.playTone(t, 0.12, 'sine', 1480, 1980, 0.28);
    this.playTone(t + 0.02, 0.14, 'triangle', 2220, 2640, 0.22);
    this.playNoise(t, 0.065, 'highpass', 2600, 1900, 1.2, 0.28);
  }

  /** Bullet/pellet impacting the tactical floor/ground */
  public playHitGround(): void {
    const nowMs = performance.now();
    if (nowMs - this.lastGroundAt < 35) return;
    this.lastGroundAt = nowMs;

    const ctx = this.ensureContext();
    if (!ctx) return;
    const t = ctx.currentTime;

    this.playTone(t, 0.06, 'sine', 165, 58, 0.26);
    this.playTone(t + 0.01, 0.055, 'triangle', 2400, 920, 0.12);
    this.playNoise(t, 0.09, 'lowpass', 780, 180, 1.0, 0.34);
  }

  /** Dry-fire click when magazine is empty */
  public playGunEmpty(): void {
    const nowMs = performance.now();
    if (nowMs - this.lastEmptyAt < 180) return;
    this.lastEmptyAt = nowMs;

    const ctx = this.ensureContext();
    if (!ctx) return;
    const t = ctx.currentTime;

    this.playTone(t, 0.024, 'square', 2350, 780, 0.22);
    this.playNoise(t, 0.022, 'highpass', 3200, 2400, 2.5, 0.2);
  }

  /** Magazine release & eject click on reload start */
  public playReloadStart(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const t = ctx.currentTime;

    this.playTone(t, 0.045, 'triangle', 680, 320, 0.24);
    this.playNoise(t + 0.015, 0.07, 'bandpass', 1800, 880, 3.0, 0.22);
  }

  /** Magazine lock & bolt rack on reload completion */
  public playReloadComplete(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const t = ctx.currentTime;

    this.playTone(t, 0.055, 'triangle', 240, 110, 0.32);
    this.playNoise(t, 0.045, 'bandpass', 1200, 900, 2.8, 0.24);
    this.playTone(t + 0.09, 0.04, 'square', 1420, 2100, 0.18);
    this.playNoise(t + 0.09, 0.055, 'highpass', 2500, 1900, 2.4, 0.26);
  }

  /** Enemy claw slash or dual-claw special attack */
  public playEnemyAttack(isDualSpecial: boolean): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const t = ctx.currentTime;

    if (isDualSpecial) {
      // Heavy dual-blade windup/slam roar
      this.playTone(t, 0.24, 'sawtooth', 165, 52, 0.38);
      this.playTone(t, 0.2, 'square', 310, 88, 0.2);
      this.playNoise(t, 0.24, 'bandpass', 950, 280, 1.4, 0.45);
    } else {
      // Fast serrated claw whoosh
      this.playTone(t, 0.13, 'sawtooth', 420, 120, 0.22);
      this.playNoise(t, 0.14, 'bandpass', 1900, 520, 1.8, 0.34);
    }
  }

  /** Player suit impact + warning pulse when hurt */
  public playPlayerHurt(isDualSpecial: boolean): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const t = ctx.currentTime;

    const punchGain = isDualSpecial ? 0.62 : 0.45;
    this.playTone(t, 0.16, 'sine', isDualSpecial ? 130 : 160, 42, punchGain);
    this.playNoise(t, 0.12, 'lowpass', 1100, 220, 1.1, isDualSpecial ? 0.55 : 0.38);
    // Brief tactical armor warning chirp
    this.playTone(t + 0.03, 0.09, 'square', 680, 460, 0.14);
  }

  /** Operator down / incapacitated power-down & flatline cue */
  public playPlayerDown(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const t = ctx.currentTime;

    // Heavy collapse impact
    this.playTone(t, 0.28, 'sine', 120, 32, 0.68);
    this.playNoise(t, 0.25, 'lowpass', 900, 140, 0.9, 0.52);

    // Descending HUD power-down + flatline telemetry tone
    this.playTone(t + 0.08, 0.35, 'sawtooth', 440, 110, 0.2);
    this.playTone(t + 0.38, 0.72, 'sine', 740, 720, 0.18);
  }

  /** Heavy melee swing whoosh tailored for Hammer vs Halberd */
  public playMeleeSwing(weaponId: string, isSpecial: boolean): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const t = ctx.currentTime;

    if (weaponId === 'maelstrom_hammer') {
      const pitchStart = isSpecial ? 170 : 210;
      this.playTone(t, isSpecial ? 0.24 : 0.16, 'triangle', pitchStart, 48, isSpecial ? 0.42 : 0.28);
      this.playNoise(t, isSpecial ? 0.26 : 0.17, 'bandpass', 620, 180, 1.1, isSpecial ? 0.48 : 0.32);
    } else {
      const pitchStart = isSpecial ? 520 : 420;
      this.playTone(t, isSpecial ? 0.22 : 0.14, 'sawtooth', pitchStart, 140, isSpecial ? 0.26 : 0.18);
      this.playNoise(t, isSpecial ? 0.24 : 0.15, 'bandpass', 1800, 420, 1.7, isSpecial ? 0.42 : 0.3);
    }
  }

  /** Heavy melee impact, cleave, or shove bash */
  public playMeleeImpact(isWeakspot: boolean, isShove: boolean): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const t = ctx.currentTime;

    if (isShove) {
      this.playTone(t, 0.14, 'sine', 150, 44, 0.55);
      this.playNoise(t, 0.11, 'lowpass', 950, 210, 1.0, 0.44);
      return;
    }

    this.playTone(t, 0.13, 'sine', 165, 42, 0.58);
    this.playNoise(t, 0.12, 'bandpass', 1100, 280, 1.3, 0.42);
    if (isWeakspot) {
      this.playTone(t + 0.01, 0.14, 'triangle', 1560, 2240, 0.26);
    }
  }

  /** Subtle lock chime when melee special charge hits 100% */
  public playMeleeChargeReady(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const t = ctx.currentTime;

    this.playTone(t, 0.08, 'sine', 880, 1320, 0.16);
  }

  /** Posture break / enemy stagger stun chime */
  public playEnemyStagger(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const t = ctx.currentTime;

    this.playTone(t, 0.22, 'sawtooth', 260, 72, 0.32);
    this.playTone(t + 0.03, 0.18, 'triangle', 620, 310, 0.22);
    this.playNoise(t, 0.16, 'bandpass', 720, 240, 2.0, 0.32);
  }

  /** Medic kit bio-seal injection + shield chime */
  public playMedkitHeal(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const t = ctx.currentTime;

    this.playNoise(t, 0.14, 'highpass', 2200, 1400, 1.4, 0.18);
    this.playTone(t, 0.14, 'sine', 520, 780, 0.24);
    this.playTone(t + 0.09, 0.18, 'sine', 780, 1040, 0.22);
  }

  /** Vanguard Drone arcing plasma discharge */
  public playDroneShoot(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const t = ctx.currentTime;

    this.playTone(t, 0.11, 'sine', 1340, 420, 0.18);
    this.playTone(t, 0.09, 'triangle', 680, 240, 0.14);
    this.playNoise(t, 0.08, 'bandpass', 2800, 900, 2.4, 0.14);
  }

  /** Reinforced grey bulkhead door smash/breach */
  public playDoorBreak(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const t = ctx.currentTime;

    this.playTone(t, 0.28, 'sawtooth', 145, 36, 0.56);
    this.playNoise(t, 0.32, 'lowpass', 1800, 220, 0.9, 0.58);
    this.playTone(t + 0.04, 0.18, 'square', 380, 95, 0.22);
  }

  /** Tactical weapon/helmet flashlight mode switch click */
  public playFlashlightToggle(mode: 'OFF' | 'SPOT' | 'FLOOD'): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const t = ctx.currentTime;

    const pitch = mode === 'SPOT' ? 1720 : mode === 'FLOOD' ? 1280 : 820;
    this.playTone(t, 0.025, 'square', pitch, pitch * 0.72, 0.14);
    this.playNoise(t, 0.02, 'highpass', 2400, 1800, 2.2, 0.12);
  }
}

export const soundEngine = new TacticalSoundEngine();
