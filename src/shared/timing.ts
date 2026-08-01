// The sliders in popup.html, the labels the popup draws for them and the clamps
// the content script applies all have to agree, so the bounds live here.
// build.mjs fails the build when popup.html has drifted from them.

export const DELAY_MIN = 700;
export const DELAY_MAX = 2000;
export const DELAY_DEFAULT = 1100;

export const JITTER_MIN = 0;
export const JITTER_MAX = 5;
export const JITTER_DEFAULT = 2;

/**
 * Each jitter level adds up to this share of the base delay, so level 5 can
 * double it. Only ever additive: level 0 has to mean exactly the base delay.
 */
export const JITTER_SHARE = .2;

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

export const clampDelay = (ms: number | undefined): number =>
  clamp(Number(ms) || DELAY_DEFAULT, DELAY_MIN, DELAY_MAX);

export function clampJitter(level: number | undefined): number {
  const value = Number(level);
  // 0 is a meaningful level, so an absent value cannot be detected with `||`.
  return Number.isFinite(value) ? clamp(Math.round(value), JITTER_MIN, JITTER_MAX) : JITTER_DEFAULT;
}

/** Longest wait a base delay can turn into at this jitter level. */
export const jitterCeiling = (base: number, level: number): number =>
  Math.round(base * (1 + JITTER_SHARE * level));

/**
 * A wait of `base` plus a random share of it, so a scan does not turn pages on
 * a metronome. Rolled per wait rather than once per scan.
 */
export const jitteredDelay = (base: number, level: number, roll: number = Math.random()): number =>
  Math.round(base * (1 + JITTER_SHARE * level * roll));
