/**
 * Valve Client Audio Synthesizer
 * Synthesizes authentic Valve / Steam client audio cues using the Web Audio API.
 * Zero external audio files required.
 */
class ValveSoundEngine {
  constructor() {
    this.ctx = null;
    this.muted = localStorage.getItem("vf_sound_muted") === "true";
  }

  _initContext() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === "suspended") {
      this.ctx.resume();
    }
  }

  isMuted() {
    return this.muted;
  }

  toggleMute() {
    this.muted = !this.muted;
    localStorage.setItem("vf_sound_muted", this.muted ? "true" : "false");
    return this.muted;
  }

  setMute(state) {
    this.muted = !!state;
    localStorage.setItem("vf_sound_muted", this.muted ? "true" : "false");
  }

  /**
   * Subtle Steam UI hover tick
   */
  playHover() {
    if (this.muted) return;
    try {
      this._initContext();
      if (!this.ctx) return;

      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      const now = this.ctx.currentTime;

      osc.type = "sine";
      osc.frequency.setValueAtTime(820, now);
      osc.frequency.exponentialRampToValueAtTime(640, now + 0.02);

      gain.gain.setValueAtTime(0.04, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.02);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(now);
      osc.stop(now + 0.02);
    } catch (e) {
      // Audio playback safely ignored if browser permissions restrict
    }
  }

  /**
   * Steam UI Affirmative Select chime
   */
  playSelect() {
    if (this.muted) return;
    try {
      this._initContext();
      if (!this.ctx) return;

      const now = this.ctx.currentTime;

      // First tone
      const osc1 = this.ctx.createOscillator();
      const gain1 = this.ctx.createGain();
      osc1.type = "sine";
      osc1.frequency.setValueAtTime(587.33, now); // D5
      gain1.gain.setValueAtTime(0.09, now);
      gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
      osc1.connect(gain1);
      gain1.connect(this.ctx.destination);
      osc1.start(now);
      osc1.stop(now + 0.08);

      // Second harmonizing tone
      const osc2 = this.ctx.createOscillator();
      const gain2 = this.ctx.createGain();
      osc2.type = "sine";
      osc2.frequency.setValueAtTime(880, now + 0.04); // A5
      gain2.gain.setValueAtTime(0.08, now + 0.04);
      gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
      osc2.connect(gain2);
      gain2.connect(this.ctx.destination);
      osc2.start(now + 0.04);
      osc2.stop(now + 0.16);
    } catch (e) {}
  }

  /**
   * Steam UI Back / Cancel tone
   */
  playBack() {
    if (this.muted) return;
    try {
      this._initContext();
      if (!this.ctx) return;

      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = "triangle";
      osc.frequency.setValueAtTime(440, now);
      osc.frequency.exponentialRampToValueAtTime(311.13, now + 0.1);

      gain.gain.setValueAtTime(0.07, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(now);
      osc.stop(now + 0.1);
    } catch (e) {}
  }

  /**
   * Triumphant Steam download completion / achievement celebration chime
   */
  playComplete() {
    if (this.muted) return;
    try {
      this._initContext();
      if (!this.ctx) return;

      const now = this.ctx.currentTime;
      const notes = [
        { freq: 523.25, time: 0.0, dur: 0.15 }, // C5
        { freq: 659.25, time: 0.08, dur: 0.2 }, // E5
        { freq: 783.99, time: 0.16, dur: 0.35 }, // G5
        { freq: 1046.50, time: 0.26, dur: 0.55 }, // C6
      ];

      notes.forEach((n) => {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(n.freq, now + n.time);
        gain.gain.setValueAtTime(0.12, now + n.time);
        gain.gain.exponentialRampToValueAtTime(0.001, now + n.time + n.dur);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(now + n.time);
        osc.stop(now + n.time + n.dur);
      });
    } catch (e) {}
  }

  /**
   * Modal Pop / Dialog open sound
   */
  playModalOpen() {
    if (this.muted) return;
    try {
      this._initContext();
      if (!this.ctx) return;

      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = "sine";
      osc.frequency.setValueAtTime(320, now);
      osc.frequency.exponentialRampToValueAtTime(540, now + 0.07);

      gain.gain.setValueAtTime(0.06, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.07);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(now);
      osc.stop(now + 0.07);
    } catch (e) {}
  }
}

// Global sound singleton
const valveSound = new ValveSoundEngine();

// Auto-bind sound listeners to UI elements with data attributes
document.addEventListener("DOMContentLoaded", () => {
  document.addEventListener("mouseover", (e) => {
    const el = e.target.closest("button, .nav-tab, .game-list-item, .library-card, .menu-item");
    if (el && !el.disabled) {
      valveSound.playHover();
    }
  });

  document.addEventListener("click", (e) => {
    const el = e.target.closest("button, .nav-tab, .game-list-item, .menu-item");
    if (el && !el.disabled) {
      if (el.classList.contains("btn-close") || el.classList.contains("modal-close") || el.dataset.sound === "back") {
        valveSound.playBack();
      } else {
        valveSound.playSelect();
      }
    }
  });
});

