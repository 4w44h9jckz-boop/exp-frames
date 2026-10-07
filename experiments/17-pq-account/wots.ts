// WOTS one-time signatures under a Merkle tree, as WotsAccount.yul verifies them. Key
// generation, signing and a verifier that mirrors the contract step for step, so a signature can
// be checked (and its verification work counted) before it is sent.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { keccak_256 } from '@noble/hashes/sha3'
import { type Hex, bytesToHex, concatHex, hexToBytes } from 'viem'

export type Params = { name: string; n: number; b: number; h: number; k: number }

export const VARIANTS = {
  /** 256-bit values, w = 16: the conservative choice. */
  n32w16: { name: 'n32-w16', n: 32, b: 4, h: 10, k: 4 },
  /** 128-bit values (with a randomized digest), w = 16. */
  n16w16: { name: 'n16-w16', n: 16, b: 4, h: 10, k: 4 },
  /** 128-bit values, w = 256: fewer, longer chains. */
  n16w256: { name: 'n16-w256', n: 16, b: 8, h: 10, k: 4 },
} as const satisfies Record<string, Params>

const bitLength = (x: number) => (x === 0 ? 0 : Math.floor(Math.log2(x)) + 1)

export function derived(p: Params) {
  const w1 = (1 << p.b) - 1
  const l1 = (8 * p.n) / p.b
  const l2 = Math.ceil(bitLength(l1 * w1) / p.b)
  const l = l1 + l2
  return { w1, l1, l2, l, sigLen: 2 + p.n * (1 + l + p.h) }
}

// ---- hashing, exactly as the contract lays out its input ----

const word = (x: bigint) => {
  const out = new Uint8Array(32)
  for (let i = 31; i >= 0; i--, x >>= 8n) out[i] = Number(x & 0xffn)
  return out
}

/** One chain step: keccak256(leaf << 32 | i << 16 | j ‖ x)[0:n]. */
function makeF(n: number) {
  const buf = new Uint8Array(32 + n)
  // the tweak word is zero but for its last six bytes: leaf, i and j, two bytes each
  return (leaf: number, i: number, j: number, x: Uint8Array) => {
    buf[26] = leaf >> 8
    buf[27] = leaf & 0xff
    buf[28] = i >> 8
    buf[29] = i & 0xff
    buf[30] = j >> 8
    buf[31] = j & 0xff
    buf.set(x, 32)
    return keccak_256(buf).subarray(0, n)
  }
}

function node(n: number, level: number, parent: number, left: Uint8Array, right: Uint8Array) {
  const buf = new Uint8Array(32 + 2 * n)
  buf.set(word((1n << 255n) | (BigInt(level) << 32n) | BigInt(parent)), 0)
  buf.set(left, 32)
  buf.set(right, 32 + n)
  return keccak_256(buf).subarray(0, n)
}

/** The digest's base-w digits, most significant first, followed by the checksum's digits. */
function digitsOf(p: Params, digest: Uint8Array): number[] {
  const { w1, l1, l2 } = derived(p)
  const out: number[] = []
  for (let i = 0; i < l1; i++) {
    const bit = i * p.b
    out.push((digest[bit >> 3] >> (8 - p.b - (bit & 7))) & w1)
  }
  const checksum = out.reduce((acc, d) => acc + (w1 - d), 0)
  for (let k = 0; k < l2; k++) out.push((checksum >> (p.b * (l2 - 1 - k))) & w1)
  return out
}

/** digest = keccak256(R ‖ sig hash)[0:n], as digits. */
export const digits = (p: Params, r: Uint8Array, sigHash: Hex): number[] =>
  digitsOf(p, keccak_256(new Uint8Array([...r, ...hexToBytes(sigHash)])).subarray(0, p.n))

/** Chain steps the verifier hashes: sum(w - 1 - digit) over every chain. */
export const verifySteps = (p: Params, ds: number[]) => ds.reduce((acc, d) => acc + derived(p).w1 - d, 0)

// ---- keys ----

export type Tree = { params: Params; seed: Hex; leaves: Uint8Array[]; levels: Uint8Array[][]; root: Hex }

function secret(p: Params, seed: Uint8Array, leaf: number, i: number) {
  return keccak_256(new Uint8Array([...seed, ...word(BigInt(leaf)), ...word(BigInt(i))])).subarray(0, p.n)
}

function leafHash(p: Params, seed: Uint8Array, leaf: number) {
  const { w1, l } = derived(p)
  const F = makeF(p.n)
  const ends = new Uint8Array(l * p.n)
  for (let i = 0; i < l; i++) {
    let x = secret(p, seed, leaf, i)
    for (let j = 0; j < w1; j++) x = F(leaf, i, j, x)
    ends.set(x, i * p.n)
  }
  return keccak_256(ends).subarray(0, p.n)
}

/**
 * The whole tree. Every leaf needs its L chains hashed to the end, which is millions of keccak
 * calls for w = 256, so the leaf layer is cached in the system temp directory, keyed by the seed
 * and the parameters. The cache holds only public values.
 */
export function keygen(p: Params, seed: Hex): Tree {
  const id = createHash('sha256').update(`${seed}/${p.n}/${p.b}/${p.h}`).digest('hex').slice(0, 16)
  const dir = join(tmpdir(), 'exp-frames-17')
  const file = join(dir, `${p.name}-${id}.bin`)
  const count = 1 << p.h
  let flat: Uint8Array
  if (existsSync(file)) flat = new Uint8Array(readFileSync(file))
  else {
    const s = hexToBytes(seed)
    flat = new Uint8Array(count * p.n)
    for (let leaf = 0; leaf < count; leaf++) flat.set(leafHash(p, s, leaf), leaf * p.n)
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, flat)
  }
  const leaves = Array.from({ length: count }, (_, i) => flat.slice(i * p.n, (i + 1) * p.n))
  const levels: Uint8Array[][] = [leaves]
  for (let level = 0; level < p.h; level++) {
    const below = levels[level]
    const above: Uint8Array[] = []
    for (let i = 0; i < below.length / 2; i++) above.push(node(p.n, level, i, below[2 * i], below[2 * i + 1]))
    levels.push(above)
  }
  return { params: p, seed, leaves, levels, root: rootWord(p, levels[p.h][0]) }
}

/** The root as the contract stores it: the first n bytes of a 32-byte word. */
const rootWord = (p: Params, r: Uint8Array): Hex => bytesToHex(new Uint8Array([...r, ...new Uint8Array(32 - p.n)]))

// ---- signing ----

export type Signed = { signature: Hex; digits: number[]; steps: number; tries: number }

/**
 * Sign `sigHash` with one-time key `leaf`. R is n - 4 bytes derived from the seed and the hash,
 * then a 4-byte counter. With `maxSteps`, the counter moves on until the verifier's work is at
 * most `maxSteps`: the grinding w = 256 needs to fit a verification gas cap. Each try costs one
 * keccak. Never call twice for one leaf with two different hashes: that is the one thing a
 * one-time key must not do.
 */
export function sign(tree: Tree, leaf: number, sigHash: Hex, maxSteps = Number.POSITIVE_INFINITY): Signed {
  const p = tree.params
  const { l } = derived(p)
  const seed = hexToBytes(tree.seed)
  const input = new Uint8Array(p.n + 32)
  input.set(keccak_256(new Uint8Array([...seed, ...new TextEncoder().encode('R'), ...hexToBytes(sigHash)])).subarray(0, p.n - 4), 0)
  input.set(hexToBytes(sigHash), p.n)
  let ds: number[] = []
  let tries = 0
  for (;;) {
    if (tries === 2 ** 32 - 1) throw new Error(`no R gives at most ${maxSteps} steps`)
    input[p.n - 4] = tries >>> 24
    input[p.n - 3] = (tries >>> 16) & 0xff
    input[p.n - 2] = (tries >>> 8) & 0xff
    input[p.n - 1] = tries & 0xff
    tries++
    ds = digitsOf(p, keccak_256(input).subarray(0, p.n))
    if (verifySteps(p, ds) <= maxSteps) break
  }
  const r = input.slice(0, p.n)
  const F = makeF(p.n)
  const values = new Uint8Array(l * p.n)
  for (let i = 0; i < l; i++) {
    let x = secret(p, seed, leaf, i)
    for (let j = 0; j < ds[i]; j++) x = F(leaf, i, j, x)
    values.set(x, i * p.n)
  }
  const path = new Uint8Array(p.h * p.n)
  for (let level = 0; level < p.h; level++) path.set(tree.levels[level][(leaf >> level) ^ 1], level * p.n)
  const signature = concatHex([bytesToHex(word(BigInt(leaf)).subarray(30)), bytesToHex(r), bytesToHex(values), bytesToHex(path)])
  if ((signature.length - 2) / 2 !== derived(p).sigLen) throw new Error('signature length')
  return { signature, digits: ds, steps: verifySteps(p, ds), tries }
}

// ---- verification, the contract's steps in TypeScript ----

export function verify(p: Params, root: Hex, signature: Hex, sigHash: Hex, nonce: bigint): { ok: boolean; reason?: string } {
  const { w1, l, sigLen } = derived(p)
  const s = hexToBytes(signature)
  if (s.length !== sigLen) return { ok: false, reason: 'length' }
  const leaf = (s[0] << 8) | s[1]
  if (leaf >= 1 << p.h) return { ok: false, reason: 'leaf out of range' }
  if (BigInt(Math.floor(leaf / p.k)) !== nonce) return { ok: false, reason: 'leaf belongs to another nonce' }
  const r = s.subarray(2, 2 + p.n)
  const ds = digits(p, r, sigHash)
  const F = makeF(p.n)
  const ends = new Uint8Array(l * p.n)
  for (let i = 0; i < l; i++) {
    let x: Uint8Array = s.slice(2 + p.n + i * p.n, 2 + p.n + (i + 1) * p.n)
    for (let j = ds[i]; j < w1; j++) x = F(leaf, i, j, x)
    ends.set(x, i * p.n)
  }
  let cur = keccak_256(ends).subarray(0, p.n)
  const path = 2 + p.n + l * p.n
  for (let level = 0; level < p.h; level++) {
    const sibling = s.subarray(path + level * p.n, path + (level + 1) * p.n)
    const parent = leaf >> (level + 1)
    cur = (leaf >> level) & 1 ? node(p.n, level, parent, sibling, cur) : node(p.n, level, parent, cur, sibling)
  }
  return rootWord(p, cur) === root ? { ok: true } : { ok: false, reason: 'root' }
}
