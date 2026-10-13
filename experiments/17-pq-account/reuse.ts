// Experiment 17: what one reused one-time key gives away. A WOTS signature reveals, for each
// chain, the value at the signed digit, and anyone can hash forward from there. After s
// signatures under one key, a forger knows every chain from the lowest signed digit up, and can
// sign any digest whose digits are all at or above those minima, checksum digits included. The
// forger picks R, so each try costs one keccak; this script computes, exactly, the chance that
// one try succeeds, over random signed messages. No network.
//
// usage: npx tsx experiments/17-pq-account/reuse.ts
import { type Params, VARIANTS, derived } from './wots.js'

/** The checksum's base-w digits. */
function checksumDigits(p: Params, c: number): number[] {
  const { w1, l2 } = derived(p)
  return Array.from({ length: l2 }, (_, k) => (c >> (p.b * (l2 - 1 - k))) & w1)
}

/**
 * Digits of a uniformly random digest, as the contract derives them. With `maxSteps`, conditioned
 * on the verifier's work being at most `maxSteps`, which is exactly what an honest signer who
 * grinds R produces. Sampled exactly rather than by rejection: the work depends only on
 * c = sum(w - 1 - digit), so draw c from its distribution restricted to the allowed values, then
 * the digits one by one given what remains of c.
 */
function sampler(p: Params, maxSteps = Number.POSITIVE_INFINITY): () => number[] {
  const { w1, l1 } = derived(p)
  const max = l1 * w1
  // ways[i][s]: ways for digits i.. to contribute exactly s (additions only, so floats suffice)
  const ways = Array.from({ length: l1 + 1 }, () => new Float64Array(max + 1))
  ways[l1][0] = 1
  for (let i = l1 - 1; i >= 0; i--)
    for (let s = 0; s <= max; s++) {
      let t = 0
      for (let x = 0; x <= Math.min(w1, s); x++) t += ways[i + 1][s - x]
      ways[i][s] = t
    }
  const steps = (c: number) => c + checksumDigits(p, c).reduce((a, d) => a + w1 - d, 0)
  const allowed = Array.from({ length: max + 1 }, (_, c) => (steps(c) <= maxSteps ? ways[0][c] : 0))
  const pick = (weights: ArrayLike<number>) => {
    let total = 0
    for (let i = 0; i < weights.length; i++) total += weights[i]
    let u = Math.random() * total
    for (let i = 0; i < weights.length; i++) if ((u -= weights[i]) < 0) return i
    return weights.length - 1
  }
  return () => {
    let c = pick(allowed)
    const total = c
    const out: number[] = []
    for (let i = 0; i < l1; i++) {
      const x = pick(Array.from({ length: Math.min(w1, c) + 1 }, (_, x) => ways[i + 1][c - x]))
      out.push(w1 - x)
      c -= x
    }
    return [...out, ...checksumDigits(p, total)]
  }
}

/**
 * log2(1/P) for P = P(a uniformly random digest has every digit >= min[i], checksum digits
 * included). Counted exactly in integers: the number of message-digit vectors per checksum value.
 */
function forgeBits(p: Params, min: number[]): number {
  const { w1, l1 } = derived(p)
  let dist: bigint[] = [1n]
  for (let i = 0; i < l1; i++) {
    // this digit contributes w1 - t for t in [min_i, w1]: each of 0..(w1 - min_i) one way
    const span = w1 - min[i]
    const next: bigint[] = new Array(dist.length + span).fill(0n)
    let run = 0n
    for (let c = 0; c < next.length; c++) {
      if (c < dist.length) run += dist[c]
      if (c - span - 1 >= 0) run -= dist[c - span - 1]
      next[c] = run
    }
    dist = next
  }
  let count = 0n
  for (let c = 0; c < dist.length; c++) if (checksumDigits(p, c).every((d, k) => d >= min[l1 + k])) count += dist[c]
  if (count === 0n) return Number.POSITIVE_INFINITY
  // log2(count), from its top 53 bits
  const bitsOf = count.toString(2).length
  const shift = Math.max(0, bitsOf - 53)
  return l1 * p.b - (Math.log2(Number(count >> BigInt(shift))) + shift)
}

const quantile = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.floor(q * (xs.length - 1))]

console.log('| Variant | Signatures under one key | Samples | $\\log_2(1/P)$ per try: 10% | median | 90% |')
console.log('|---|---|---|---|---|---|')
const runs: [Params, string, number | undefined, number][] = [
  [VARIANTS.n32w16, 'n32-w16', undefined, 2000],
  [VARIANTS.n16w16, 'n16-w16', undefined, 2000],
  [VARIANTS.n16w256, 'n16-w256', undefined, 2000],
  [VARIANTS.n16w256, 'n16-w256, R ground to <= 1,020 steps', 1020, 2000],
]
for (const [p, label, maxSteps, samples] of runs) {
  const draw = sampler(p, maxSteps)
  for (const s of [1, 2, 3]) {
    const bits: number[] = []
    for (let i = 0; i < samples; i++) {
      const sigs = Array.from({ length: s }, draw)
      const min = sigs[0].map((_, j) => Math.min(...sigs.map((d) => d[j])))
      bits.push(forgeBits(p, min))
    }
    const f = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : 'never')
    console.log(`| ${label} | ${s} | ${samples} | ${f(quantile(bits, 0.1))} | ${f(quantile(bits, 0.5))} | ${f(quantile(bits, 0.9))} |`)
  }
}
