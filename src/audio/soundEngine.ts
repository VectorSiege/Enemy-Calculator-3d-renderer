/**
 * Zero-dependency Web Audio synthesizer producing distinct procedural SFX for every
 * firearm, melee weapon, impact surface, player damage, door breach, flashlight click,
 * and tactical grenade type.
 */
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
  private lastIncendiaryTickAt = 0;
  private lastEnemyShotAt = 0;
  private lastShieldHitAt = 0;
  private lastReactorBlastAt = 0;
  private lastThunderAt = 0;
  private nextBirdAtMs = 0;

  // Continuous soothing ambient weather mix nodes
  private ambientGain: GainNode | null = null;
  private rainBodyGain: GainNode | null = null;
  private rainPatterGain: GainNode | null = null;
  private rainNoiseSrc: AudioBufferSourceNode | null = null;
  private rainLfo: OscillatorNode | null = null;

  /**
   * Lazily initializes or resumes the shared Web Audio graph with vendor fallback
   * (`webkitAudioContext`) and safe promise handling for Safari/Firefox autoplay rules.
   */
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

      // Pre-allocate 1.5s reusable white noise buffer for filtered bursts
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
      void this.ctx.resume().catch(() => {});
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
    if (next && this.ambientGain && this.ctx) {
      this.ambientGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.08);
    }
  }

  private ensureAmbientRainNodes(): void {
    const ctx = this.ctx;
    if (!ctx || !this.masterGain || this.rainNoiseSrc) return;

    // Generate 3.0s warm pink/brown-weighted noise buffer for soothing rain (zero harsh hiss)
    const sampleCount = Math.floor(ctx.sampleRate * 3.0);
    const rainBuf = ctx.createBuffer(1, sampleCount, ctx.sampleRate);
    const ch = rainBuf.getChannelData(0);
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    for (let i = 0; i < sampleCount; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.997 * b0 + white * 0.029;
      b1 = 0.985 * b1 + white * 0.032;
      b2 = 0.95 * b2 + white * 0.048;
      ch[i] = Math.max(-1, Math.min(1, (b0 + b1 + b2 + white * 0.055) * 1.65));
    }
    // Crossfade start & end 1000 samples for click-free seamless looping
    const fadeLen = Math.min(1200, Math.floor(sampleCount / 8));
    for (let i = 0; i < fadeLen; i++) {
      const w = i / fadeLen;
      ch[i] = ch[i] * w + ch[sampleCount - fadeLen + i] * (1 - w);
    }

    const src = ctx.createBufferSource();
    src.buffer = rainBuf;
    src.loop = true;

    const ambientGain = ctx.createGain();
    ambientGain.gain.value = 1.0;

    // Warm lowpass body (cozy distant downpour / glass roof resonance)
    const bodyFilter = ctx.createBiquadFilter();
    bodyFilter.type = 'lowpass';
    bodyFilter.frequency.value = 780;
    bodyFilter.Q.value = 0.55;

    const bodyGain = ctx.createGain();
    bodyGain.gain.value = 0;

    // Gentle skylight patter texture
    const patterFilter = ctx.createBiquadFilter();
    patterFilter.type = 'bandpass';
    patterFilter.frequency.value = 2300;
    patterFilter.Q.value = 0.85;

    const patterGain = ctx.createGain();
    patterGain.gain.value = 0;

    // Slow organic breathing LFO so rain ebbs & flows soothingly
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.11;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 180;
    lfo.connect(lfoDepth);
    lfoDepth.connect(bodyFilter.frequency);

    src.connect(bodyFilter);
    bodyFilter.connect(bodyGain);
    bodyGain.connect(ambientGain);

    src.connect(patterFilter);
    patterFilter.connect(patterGain);
    patterGain.connect(ambientGain);

    ambientGain.connect(this.masterGain);

    src.start();
    lfo.start();

    this.ambientGain = ambientGain;
    this.rainBodyGain = bodyGain;
    this.rainPatterGain = patterGain;
    this.rainNoiseSrc = src;
    this.rainLfo = lfo;
  }

  /** Smoothly mixes soothing rainfall bed & daytime songbird chirps */
  public updateAmbientWeather(options: {
    rainIntensity: number;
    isNight: boolean;
    paused: boolean;
  }): void {
    if (this.muted || !this.ctx || this.ctx.state !== 'running') {
      if (this.ambientGain && this.ctx) {
        this.ambientGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.2);
      }
      return;
    }

    this.ensureAmbientRainNodes();
    const ctx = this.ctx;
    if (!this.ambientGain || !this.rainBodyGain || !this.rainPatterGain) return;

    const t = ctx.currentTime;
    const activeRain = options.paused ? options.rainIntensity * 0.35 : options.rainIntensity;
    this.ambientGain.gain.setTargetAtTime(1.0, t, 0.25);

    // Soothing progressive rain curve: soft drizzle -> gentle shower -> rich torrential wash
    const bodyTarget = activeRain > 0.02 ? 0.045 + Math.pow(activeRain, 1.15) * 0.24 : 0;
    const patterTarget = activeRain > 0.02 ? 0.015 + Math.pow(activeRain, 1.35) * 0.085 : 0;
    this.rainBodyGain.gain.setTargetAtTime(bodyTarget, t, 0.45);
    this.rainPatterGain.gain.setTargetAtTime(patterTarget, t, 0.45);

    // Natural daytime songbirds when clear, cloudy, or light drizzle (silent in heavy storms or night)
    if (!options.paused && !options.isNight && options.rainIntensity <= 0.34) {
      const nowMs = performance.now();
      if (this.nextBirdAtMs === 0) {
        this.nextBirdAtMs = nowMs + 1600 + Math.random() * 2400;
      } else if (nowMs >= this.nextBirdAtMs) {
        const gainScale = options.rainIntensity > 0.1 ? 0.55 : 1.0;
        this.playBirdChirp(gainScale);
        this.nextBirdAtMs =
          nowMs + (options.rainIntensity > 0.1 ? 5200 : 3200) + Math.random() * 4800;
      }
    }
  }

  public stopAmbient(): void {
    if (this.rainNoiseSrc) {
      try {
        this.rainNoiseSrc.stop();
        this.rainNoiseSrc.disconnect();
      } catch {
        // ignore already stopped
      }
      this.rainNoiseSrc = null;
    }
    if (this.rainLfo) {
      try {
        this.rainLfo.stop();
        this.rainLfo.disconnect();
      } catch {
        // ignore already stopped
      }
      this.rainLfo = null;
    }
    this.ambientGain = null;
    this.rainBodyGain = null;
    this.rainPatterGain = null;
  }

  /** Melodic multi-note songbird chirp & gentle trill */
  public playBirdChirp(volumeScale = 1.0): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.ambientGain) return;

    const t = ctx.currentTime;
    const baseFreq = 2350 + Math.random() * 1150;
    const notes = Math.random() < 0.55 ? 3 : 2;

    for (let i = 0; i < notes; i++) {
      const start = t + i * (0.11 + Math.random() * 0.05);
      const dur = 0.075 + Math.random() * 0.045;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      const f0 = baseFreq * (1 + i * 0.14 + (Math.random() - 0.5) * 0.08);
      const f1 = f0 * (Math.random() < 0.5 ? 1.28 : 0.82);
      osc.frequency.setValueAtTime(f0, start);
      osc.frequency.exponentialRampToValueAtTime(f1, start + dur);

      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, start);
      g.gain.linearRampToValueAtTime(0.028 * volumeScale, start + 0.014);
      g.gain.exponentialRampToValueAtTime(0.0001, start + dur);

      osc.connect(g);
      g.connect(this.ambientGain);
      osc.start(start);
      osc.stop(start + dur + 0.02);
    }
  }

  /** Rolling atmospheric thunderclap + deep rumble following lightning */
  public playThunder(strength = 1.0): void {
    const nowMs = performance.now();
    if (nowMs - this.lastThunderAt < 1800) return;
    this.lastThunderAt = nowMs;

    const ctx = this.ensureContext();
    if (!ctx || !this.compressor || !this.noiseBuffer) return;
    const t = ctx.currentTime;
    const s = Math.max(0.35, Math.min(1.2, strength));

    // Initial high-altitude sky crack + rolling low-frequency thunder tail
    this.playNoise(t, 0.45 * s, 'bandpass', 620, 140, 0.85, 0.34 * s);
    this.playNoise(t + 0.08, 2.35 * s, 'lowpass', 240, 52, 0.7, 0.62 * s);
    this.playNoise(t + 0.45, 2.8 * s, 'lowpass', 165, 38, 0.65, 0.46 * s);
    this.playTone(t + 0.04, 1.45 * s, 'sine', 74, 28, 0.38 * s);
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
        this.playTone(t, 0.075, 'sawtooth', 2200, 320, 0.24);
        this.playTone(t, 0.09, 'triangle', 220, 64, 0.42);
        this.playNoise(t, 0.1, 'bandpass', 2400, 950, 1.4, 0.46);
        break;
      }
      case 'valkyrie_dmr': {
        this.playTone(t, 0.16, 'sine', 195, 42, 0.65);
        this.playTone(t, 0.09, 'sawtooth', 980, 140, 0.28);
        this.playNoise(t, 0.07, 'highpass', 2600, 1400, 0.9, 0.52);
        this.playNoise(t + 0.015, 0.24, 'bandpass', 1400, 360, 1.1, 0.44);
        break;
      }
      case 'helios_plasma': {
        this.playTone(t, 0.11, 'sawtooth', 1280, 210, 0.28);
        this.playTone(t, 0.1, 'square', 640, 140, 0.16);
        this.playNoise(t, 0.12, 'bandpass', 3400, 720, 2.2, 0.34);
        break;
      }
      case 'kestrel_smg': {
        this.playTone(t, 0.055, 'triangle', 290, 92, 0.34);
        this.playNoise(t, 0.06, 'bandpass', 2700, 1100, 1.5, 0.38);
        break;
      }
      case 'novacula_mg': {
        this.playTone(t, 0.115, 'sawtooth', 180, 48, 0.52);
        this.playTone(t, 0.075, 'square', 340, 95, 0.22);
        this.playNoise(t, 0.145, 'lowpass', 2600, 480, 0.85, 0.55);
        break;
      }
      case 'choque_shotgun':
      case 'breacher_shotgun': {
        this.playTone(t, 0.19, 'sine', 145, 34, 0.72);
        this.playNoise(t, 0.22, 'lowpass', 2900, 320, 0.7, 0.74);
        this.playNoise(t, 0.08, 'highpass', 2200, 1600, 0.8, 0.36);
        this.playNoise(t + 0.12, 0.04, 'bandpass', 1900, 1400, 3.2, 0.16);
        break;
      }
      case 'ironclad_br': {
        this.playTone(t, 0.11, 'sawtooth', 210, 52, 0.56);
        this.playNoise(t, 0.13, 'bandpass', 2100, 620, 1.0, 0.5);
        break;
      }
      case 'hydra_lmg': {
        this.playTone(t, 0.075, 'sawtooth', 260, 74, 0.38);
        this.playNoise(t, 0.085, 'lowpass', 2400, 650, 1.0, 0.44);
        break;
      }
      case 'titanbane_gpmg': {
        this.playTone(t, 0.135, 'sawtooth', 160, 42, 0.62);
        this.playTone(t, 0.08, 'square', 840, 160, 0.22);
        this.playNoise(t, 0.16, 'lowpass', 2800, 420, 0.8, 0.58);
        break;
      }
      case 'longbow_sniper': {
        this.playTone(t, 0.22, 'sine', 180, 36, 0.78);
        this.playTone(t, 0.11, 'sawtooth', 2600, 220, 0.34);
        this.playNoise(t, 0.28, 'bandpass', 1800, 290, 0.9, 0.64);
        break;
      }
      case 'paladin_pistol': {
        this.playTone(t, 0.085, 'triangle', 320, 72, 0.5);
        this.playTone(t, 0.055, 'sawtooth', 1850, 420, 0.22);
        this.playNoise(t, 0.09, 'highpass', 1800, 900, 1.1, 0.44);
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
      this.playTone(t, 0.24, 'sawtooth', 165, 52, 0.38);
      this.playTone(t, 0.2, 'square', 310, 88, 0.2);
      this.playNoise(t, 0.24, 'bandpass', 950, 280, 1.4, 0.45);
    } else {
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
    this.playTone(t + 0.03, 0.09, 'square', 680, 460, 0.14);
  }

  /** Operator down / incapacitated power-down & flatline cue */
  public playPlayerDown(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const t = ctx.currentTime;

    this.playTone(t, 0.28, 'sine', 120, 32, 0.68);
    this.playNoise(t, 0.25, 'lowpass', 900, 140, 0.9, 0.52);
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

  /** Tactical ammo box pickup & magazine pouch restock chime */
  public playAmmoPickup(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const t = ctx.currentTime;

    this.playTone(t, 0.05, 'triangle', 460, 720, 0.28);
    this.playNoise(t + 0.02, 0.05, 'bandpass', 2100, 1500, 2.2, 0.2);
    this.playTone(t + 0.06, 0.09, 'sine', 880, 1240, 0.24);
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

  /** Canister pin pull & throw whoosh */
  public playGrenadeThrow(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const t = ctx.currentTime;

    this.playTone(t, 0.04, 'triangle', 1600, 2400, 0.15);
    this.playNoise(t + 0.02, 0.14, 'bandpass', 1400, 480, 1.5, 0.24);
  }

  /** High-voltage EMP flashbang crack for Stun Grenade */
  public playGrenadeStun(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const t = ctx.currentTime;

    this.playTone(t, 0.28, 'sine', 2400, 320, 0.42);
    this.playTone(t + 0.015, 0.24, 'square', 1100, 180, 0.22);
    this.playNoise(t, 0.22, 'highpass', 1800, 650, 0.9, 0.52);
  }

  /** Thermite ignition whoosh & roar for Incendiary Grenade */
  public playGrenadeIncendiary(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const t = ctx.currentTime;

    this.playTone(t, 0.24, 'sawtooth', 260, 78, 0.34);
    this.playNoise(t, 0.42, 'bandpass', 1900, 520, 1.1, 0.56);
  }

  /** Subtle thermal crackle when Incendiary DoT pool burns enemies */
  public playIncendiaryTick(): void {
    const nowMs = performance.now();
    if (nowMs - this.lastIncendiaryTickAt < 380) return;
    this.lastIncendiaryTickAt = nowMs;

    const ctx = this.ensureContext();
    if (!ctx) return;
    const t = ctx.currentTime;
    this.playNoise(t, 0.1, 'bandpass', 1200, 700, 1.8, 0.16);
  }

  /** Deep sub-bass detonation + shrapnel boom for Explosive Grenade */
  public playGrenadeExplode(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const t = ctx.currentTime;

    this.playTone(t, 0.48, 'sine', 125, 26, 0.85);
    this.playTone(t, 0.25, 'sawtooth', 190, 40, 0.36);
    this.playNoise(t, 0.55, 'lowpass', 2400, 160, 0.75, 0.8);
  }

  /** Individual 12-gauge shell thumb-insertion snap for shotgun shell-by-shell reload */
  public playShellInsert(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const t = ctx.currentTime;

    this.playTone(t, 0.045, 'triangle', 740, 290, 0.28);
    this.playTone(t + 0.035, 0.04, 'square', 1350, 1850, 0.14);
    this.playNoise(t + 0.01, 0.045, 'bandpass', 1900, 950, 2.6, 0.2);
  }

  /** Mechanical latch/arming clack when planting mines, sticky C4, or deployable turrets */
  public playConsumableDeploy(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const t = ctx.currentTime;

    this.playTone(t, 0.075, 'triangle', 320, 120, 0.35);
    this.playTone(t + 0.07, 0.06, 'sine', 1120, 1480, 0.2);
    this.playNoise(t, 0.065, 'bandpass', 1400, 620, 1.8, 0.26);
  }

  /** Remote clacker RF pulse before Sticky C4 charges detonate */
  public playC4DetonatorClick(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const t = ctx.currentTime;

    this.playTone(t, 0.035, 'square', 2100, 2400, 0.22);
    this.playTone(t + 0.045, 0.04, 'sine', 2600, 2600, 0.24);
  }

  /** Massive shaped-charge detonation for proximity/laser trip mines and C4 stacks */
  public playTripMineExplosion(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const t = ctx.currentTime;

    this.playTone(t, 0.56, 'sine', 105, 22, 0.92);
    this.playTone(t, 0.32, 'sawtooth', 160, 34, 0.45);
    this.playNoise(t, 0.62, 'lowpass', 2800, 140, 0.7, 0.88);
  }

  /** Crisp 600 RPM rotary sentry turret discharge */
  public playTurretFire(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const t = ctx.currentTime;

    this.playTone(t, 0.055, 'sawtooth', 380, 110, 0.24);
    this.playNoise(t, 0.06, 'bandpass', 2900, 980, 1.4, 0.28);
  }

  /** High-tech ordnance supply pickup / deployable retrieval double chime */
  public playConsumablePickup(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const t = ctx.currentTime;

    this.playTone(t, 0.065, 'triangle', 720, 1080, 0.24);
    this.playTone(t + 0.06, 0.09, 'sine', 1240, 1680, 0.26);
    this.playNoise(t, 0.045, 'highpass', 2200, 1600, 1.6, 0.14);
  }

  /** Crisp tactical UI latch sound when opening/closing E inventory */
  public playInventoryToggle(opening: boolean): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const t = ctx.currentTime;

    this.playTone(
      t,
      0.045,
      'triangle',
      opening ? 640 : 980,
      opening ? 1040 : 580,
      0.16
    );
  }

  /** Distinct hostile firearm / ATGM / rocket pod discharge with throttling */
  public playEnemyWeaponFire(weaponId: string): void {
    const nowMs = performance.now();
    if (nowMs - this.lastEnemyShotAt < 55) return;
    this.lastEnemyShotAt = nowMs;

    const ctx = this.ensureContext();
    if (!ctx) return;
    const t = ctx.currentTime;

    switch (weaponId) {
      case 'enemy_plasma':
        this.playTone(t, 0.14, 'sawtooth', 980, 180, 0.22);
        this.playNoise(t, 0.12, 'bandpass', 2600, 620, 2.0, 0.24);
        break;
      case 'enemy_shotgun':
        this.playTone(t, 0.16, 'sine', 135, 38, 0.38);
        this.playNoise(t, 0.18, 'lowpass', 2200, 280, 0.8, 0.42);
        break;
      case 'enemy_20mm':
        this.playTone(t, 0.12, 'sawtooth', 190, 48, 0.34);
        this.playNoise(t, 0.14, 'bandpass', 1700, 420, 1.1, 0.34);
        break;
      case 'enemy_atgm':
        this.playTone(t, 0.2, 'sawtooth', 340, 140, 0.24);
        this.playNoise(t, 0.24, 'bandpass', 1500, 520, 1.4, 0.28);
        break;
      case 'enemy_rocket_pods':
        this.playTone(t, 0.11, 'triangle', 260, 90, 0.2);
        this.playNoise(t, 0.13, 'bandpass', 1600, 540, 1.5, 0.22);
        break;
      default:
        // enemy_ar
        this.playTone(t, 0.065, 'triangle', 260, 85, 0.2);
        this.playNoise(t, 0.07, 'bandpass', 2100, 820, 1.4, 0.22);
    }
  }

  /** Metallic ballistic deflection ping on heavy mech shield */
  public playShieldHit(): void {
    const nowMs = performance.now();
    if (nowMs - this.lastShieldHitAt < 35) return;
    this.lastShieldHitAt = nowMs;

    const ctx = this.ensureContext();
    if (!ctx) return;
    const t = ctx.currentTime;

    this.playTone(t, 0.09, 'square', 920, 410, 0.22);
    this.playTone(t + 0.015, 0.1, 'triangle', 1520, 860, 0.18);
    this.playNoise(t, 0.06, 'highpass', 2400, 1400, 1.8, 0.22);
  }

  /** Internal power supply / battery detonation boom */
  public playReactorExplosion(): void {
    const nowMs = performance.now();
    if (nowMs - this.lastReactorBlastAt < 80) return;
    this.lastReactorBlastAt = nowMs;

    const ctx = this.ensureContext();
    if (!ctx) return;
    const t = ctx.currentTime;

    this.playTone(t, 0.52, 'sine', 135, 24, 0.82);
    this.playTone(t, 0.34, 'sawtooth', 320, 46, 0.38);
    this.playNoise(t, 0.54, 'lowpass', 2600, 150, 0.75, 0.78);
  }
}

export const soundEngine = new TacticalSoundEngine();
