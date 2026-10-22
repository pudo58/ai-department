/** Seeded PRNG so every resample in a report is reproducible from the registered seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export interface Interval { estimate: number; low: number; high: number; n: number }

/** Wilson score interval: honest about small samples, unlike the normal approximation. */
export function wilson(successes: number, n: number, z = 1.96): Interval {
  if (n === 0) return { estimate: NaN, low: NaN, high: NaN, n };
  const p = successes / n, z2 = z * z, denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { estimate: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half), n };
}

export const mean = (values: readonly number[]): number => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN);

export function quantile(sorted: readonly number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** z quantiles for the two-sided alpha / power values this project uses; anything else is rejected, not guessed. */
const Z: Record<string, number> = { '0.05': 1.959964, '0.1': 1.644854, '0.8': 0.841621, '0.9': 1.281552, '0.95': 1.644854 };
const zFor = (key: number): number => {
  const z = Z[String(key)];
  if (z === undefined) throw new Error(`Chưa hỗ trợ giá trị ${key}; dùng alpha 0.05/0.1 và power 0.8/0.9/0.95.`);
  return z;
};

export interface SampleSizeInput {
  /** Target difference in success proportion between two arms (e.g. 0.15). */
  delta: number;
  /** Expected share of task pairs where the arms disagree. */
  discordant: number;
  repetitions: number;
  /** Correlation between repeated runs of the same task. */
  rho: number;
  alpha?: 0.05 | 0.1;
  power?: 0.8 | 0.9 | 0.95;
}
/**
 * McNemar-style paired sample size, inflated by the design effect of repeated runs on one task.
 * Returns the number of TASKS needed; the pair count follows from repetitions.
 */
export function requiredTasks(input: SampleSizeInput): { pairs: number; tasks: number; designEffect: number } {
  const { delta, discordant: psi, repetitions: m, rho } = input;
  if (!(delta > 0 && delta < 1)) throw new Error('delta phải nằm trong (0, 1).');
  if (psi < delta) throw new Error('Tỷ lệ cặp lệch không thể nhỏ hơn delta.');
  if (!(rho >= 0 && rho <= 1) || m < 1) throw new Error('rho hoặc số lần lặp không hợp lệ.');
  const zA = zFor(input.alpha ?? 0.05) , zB = zFor(input.power ?? 0.8);
  const pairs = Math.ceil(((zA * Math.sqrt(psi) + zB * Math.sqrt(psi - delta * delta)) ** 2) / (delta * delta));
  const designEffect = 1 + (m - 1) * rho;
  return { pairs, designEffect, tasks: Math.ceil((pairs * designEffect) / m) };
}
