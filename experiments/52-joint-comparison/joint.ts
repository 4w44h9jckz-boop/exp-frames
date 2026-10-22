// Experiment 52's joint prover: Alice and Bob make one Groth16 proof of out = (a > b), each
// holding only its own bid. No dealer and no third party: every product of shared values gets
// its cross terms from Paillier under Alice's key. Semi-honest: each follows the protocol.
//
// Both parties run in this one process. Every value one sends the other goes through `Channel`,
// which counts flights and bytes; nothing else crosses between the two sides' variables.
//
// The witness is two additive shares, w = wA + wB mod r. A wire that depends on Alice's input
// alone is Alice's (wB = 0 there), likewise Bob's; the comparison tree's wires are computed
// jointly. Then Groth16 as snarkjs's prover computes it (node_modules/snarkjs/src/
// groth16_prove.js), on shares: the QAP vectors, FFTs and multi-scalar multiplications are linear;
// the pointwise product on the coset and r * s use the Paillier step; pi_a and pi_b are opened;
// pi_c stays two shares, so neither party learns `out` until it holds both.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as binFileUtils from '@iden3/binfileutils'
import { buildPoseidon } from 'circomlibjs'
import { Scalar } from 'ffjavascript'
import * as snarkjs from 'snarkjs'
import { REPO_ROOT } from '../../src/contracts.js'
// snarkjs does not export its zkey reader; it is read from the package's source.
import * as zkeyUtils from '../../node_modules/snarkjs/src/zkey_utils.js'
import * as P from './paillier.js'

export const DIR = 'experiments/52-joint-comparison'
const file = (f: string) => resolve(REPO_ROOT, DIR, f)
export const ZKEY = file('build/joint.zkey')
export const WASM = file('build/joint_js/joint.wasm')

/** BN254's scalar field. */
export const R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n
const mod = (x: bigint) => ((x % R) + R) % R

const poseidon = await buildPoseidon()
export const commit = (x: bigint, r: bigint): bigint => poseidon.F.toObject(poseidon([x, r]))

// ---- the channel ----

export type Flight = { from: 'A' | 'B'; what: string; bytes: number; ms: number }

export class Channel {
  flights: Flight[] = []
  private t = Date.now()
  /** Record one message, `bytes` long on the wire, and the time since the last one. */
  send(from: 'A' | 'B', what: string, bytes: number) {
    const now = Date.now()
    this.flights.push({ from, what, bytes, ms: now - this.t })
    this.t = now
  }
  bytes(from?: 'A' | 'B') {
    return this.flights.filter((f) => !from || f.from === from).reduce((s, f) => s + f.bytes, 0)
  }
}

// ---- products of shared values ----

export type Keys = { pk: P.PublicKey; sk: P.SecretKey }
/** Which shares may be nonzero, a property of the circuit, public to both. */
export type Shape = { xA: boolean; xB: boolean; yA: boolean; yB: boolean }
const DENSE: Shape = { xA: true, xB: true, yA: true, yB: true }

/**
 * Shares of x[k] * y[k] for every k. Alice sends Enc(xA) where Bob's yB may be nonzero and Enc(yA)
 * where Bob's xB may be; Bob answers Enc(xA yB + yA xB + rho) with rho his mask, statistically
 * hiding below N; Alice decrypts. One round trip for the whole batch.
 */
export function multiply(
  ch: Channel,
  what: string,
  keys: Keys,
  x: { A: bigint[]; B: bigint[] },
  y: { A: bigint[]; B: bigint[] },
  shape: Shape[] = x.A.map(() => DENSE),
): { A: bigint[]; B: bigint[] } {
  const n = x.A.length
  // Alice.
  const toBob = shape.map((s, k) => ({
    x: s.xA && s.yB ? P.encrypt(keys.pk, x.A[k]) : undefined,
    y: s.yA && s.xB ? P.encrypt(keys.pk, y.A[k]) : undefined,
  }))
  const up = toBob.reduce((c, m) => c + (m.x ? 1 : 0) + (m.y ? 1 : 0), 0)
  if (up) ch.send('A', `${what}: Enc of Alice's shares`, up * P.CIPHERTEXT_BYTES)
  // Bob.
  const rho: bigint[] = []
  const toAlice = toBob.map((m, k) => {
    if (!m.x && !m.y) return undefined
    rho[k] = P.rand(2 * 254 + 1 + 80)
    let c = P.encrypt(keys.pk, rho[k])
    if (m.x) c = P.add(keys.pk, c, P.scale(keys.pk, m.x, y.B[k]))
    if (m.y) c = P.add(keys.pk, c, P.scale(keys.pk, m.y, x.B[k]))
    return c
  })
  const down = toAlice.filter((c) => c !== undefined).length
  if (down) ch.send('B', `${what}: Enc of the cross terms, masked`, down * P.CIPHERTEXT_BYTES)
  // Each side's share.
  const A: bigint[] = []
  const B: bigint[] = []
  for (let k = 0; k < n; k++) {
    const c = toAlice[k]
    A[k] = mod(x.A[k] * y.A[k] + (c === undefined ? 0n : P.decrypt(keys.sk, c)))
    B[k] = mod(x.B[k] * y.B[k] - (c === undefined ? 0n : rho[k]))
  }
  return { A, B }
}

// ---- the witness ----

type Owner = 'A' | 'B' | 'S'

/** Each named wire of the circuit, from circom's .sym file, with its owner. */
export function wires(): { byName: Map<string, number>; owner: Owner[]; nVars: number } {
  const byName = new Map<string, number>()
  const owner: Owner[] = ['A'] // wire 0 is the constant 1, Alice's
  const ownerOf = (name: string): Owner => {
    if (/^main\.(Ca|session|a|ra|sessionSquare)$/.test(name) || /^main\.(ha|abits)\./.test(name)) return 'A'
    if (/^main\.(Cb|b|rb)$/.test(name) || /^main\.(hb|bbits)\./.test(name)) return 'B'
    if (/^main\.(out|p|gt0|eq0|t|e|gt|eq)(\[|$)/.test(name)) return 'S'
    throw new Error(`no owner for ${name}`)
  }
  let nVars = 1
  for (const line of readFileSync(file('build/joint.sym'), 'utf8').trim().split('\n')) {
    const [, w, , name] = line.split(',')
    const wire = Number(w)
    if (wire < 0) continue
    byName.set(name, wire)
    const o = ownerOf(name)
    if (owner[wire] !== undefined && owner[wire] !== o) throw new Error(`wire ${wire} has two owners`)
    owner[wire] = o
    nVars = Math.max(nVars, wire + 1)
  }
  return { byName, owner, nVars }
}

export type Bid = { x: bigint; r: bigint }
export type Session = { Ca: bigint; Cb: bigint; session: bigint }

async function calc(input: Record<string, bigint>): Promise<bigint[]> {
  const mem = { type: 'mem' }
  await snarkjs.wtns.calculate(Object.fromEntries(Object.entries(input).map(([k, v]) => [k, v.toString()])), WASM, mem)
  return (await snarkjs.wtns.exportJson(mem)).map(BigInt)
}

/**
 * One owner's own wires: circom's witness with the other's input replaced by a placeholder
 * (bid 0, randomness 0, and the commitment and output that go with it). Only the wires this
 * owner owns are kept; the placeholder's wires are thrown away.
 */
async function ownWires(who: 'A' | 'B', bid: Bid, s: Session) {
  const zero = commit(0n, 0n)
  const input =
    who === 'A'
      ? { Ca: s.Ca, Cb: zero, session: s.session, out: bid.x > 0n ? 1n : 0n, a: bid.x, ra: bid.r, b: 0n, rb: 0n }
      : { Ca: zero, Cb: s.Cb, session: s.session, out: 0n, a: 0n, ra: 0n, b: bid.x, rb: bid.r }
  const w = await calc(input)
  const { owner } = wires()
  return w.map((v, i) => (owner[i] === who ? v : 0n))
}

/**
 * The witness as two shares. Alice and Bob each fill their own wires; the comparison tree is
 * computed jointly, one Paillier round trip per level (seven).
 */
export async function jointWitness(ch: Channel, keys: Keys, alice: Bid, bob: Bid, s: Session) {
  const { byName, owner } = wires()
  const wA = await ownWires('A', alice, s)
  const wB = await ownWires('B', bob, s)
  const at = (name: string) => {
    const w = byName.get(name)
    if (w === undefined) throw new Error(`no wire ${name}`)
    return w
  }
  const aBits = Array.from({ length: 64 }, (_, i) => wA[at(`main.abits.out[${i}]`)])
  const bBits = Array.from({ length: 64 }, (_, i) => wB[at(`main.bbits.out[${i}]`)])
  const zeros = aBits.map(() => 0n)

  const set = (name: string, sh: { A: bigint; B: bigint }) => {
    const w = byName.get(name)
    if (w === undefined) return // a linear signal circom folded away
    if (owner[w] !== 'S') throw new Error(`${name} is not shared`)
    wA[w] = sh.A
    wB[w] = sh.B
  }

  // Leaves: p_i = a_i b_i, Alice's bit times Bob's.
  const p = multiply(ch, 'leaves', keys, { A: aBits, B: zeros }, { A: zeros, B: bBits }, aBits.map(() => ({ xA: true, xB: false, yA: false, yB: true })))
  let gt = { A: aBits.map((a, i) => mod(a - p.A[i])), B: p.B.map((x) => mod(-x)) }
  let eq = { A: aBits.map((a, i) => mod(1n - a + 2n * p.A[i])), B: bBits.map((b, i) => mod(-b + 2n * p.B[i])) }
  for (let i = 0; i < 64; i++) {
    set(`main.p[${i}]`, { A: p.A[i], B: p.B[i] })
    set(`main.gt0[${i}]`, { A: gt.A[i], B: gt.B[i] })
    set(`main.eq0[${i}]`, { A: eq.A[i], B: eq.B[i] })
  }

  // Levels: t = eq_hi gt_lo, e = eq_hi eq_lo (not at the root), gt = gt_hi + t.
  for (let l = 0, n = 32; l < 6; l++, n /= 2) {
    const pick = (v: { A: bigint[]; B: bigint[] }, odd: number) => ({
      A: Array.from({ length: n }, (_, k) => v.A[2 * k + odd]),
      B: Array.from({ length: n }, (_, k) => v.B[2 * k + odd]),
    })
    const eqHi = pick(eq, 1)
    const root = l === 5
    const x = { A: root ? eqHi.A : [...eqHi.A, ...eqHi.A], B: root ? eqHi.B : [...eqHi.B, ...eqHi.B] }
    const y = root ? pick(gt, 0) : { A: [...pick(gt, 0).A, ...pick(eq, 0).A], B: [...pick(gt, 0).B, ...pick(eq, 0).B] }
    const prod = multiply(ch, `level ${l + 1}`, keys, x, y)
    const gtHi = pick(gt, 1)
    const nextGt = { A: gtHi.A.map((g, k) => mod(g + prod.A[k])), B: gtHi.B.map((g, k) => mod(g + prod.B[k])) }
    const nextEq = { A: prod.A.slice(n), B: prod.B.slice(n) }
    for (let k = 0; k < n; k++) {
      set(`main.t[${l}][${k}]`, { A: prod.A[k], B: prod.B[k] })
      set(`main.gt[${l}][${k}]`, { A: nextGt.A[k], B: nextGt.B[k] })
      if (!root) {
        set(`main.e[${l}][${k}]`, { A: nextEq.A[k], B: nextEq.B[k] })
        set(`main.eq[${l}][${k}]`, { A: nextEq.A[k], B: nextEq.B[k] })
      }
    }
    gt = nextGt
    eq = nextEq
  }
  set('main.out', { A: gt.A[0], B: gt.B[0] })
  return { wA, wB }
}

// ---- the prover ----

type Curve = any // ffjavascript's curve object; it ships no types
type Zkey = any

let cached: { curve: Curve; zkey: Zkey; sections: Record<number, Uint8Array> } | undefined
async function provingKey() {
  if (cached) return cached
  const { fd, sections } = await binFileUtils.readBinFile(ZKEY, 'zkey', 2, 1 << 25, 1 << 23)
  const zkey = await zkeyUtils.readHeader(fd, sections)
  const read: Record<number, Uint8Array> = {}
  for (const k of [4, 5, 6, 7, 8, 9]) read[k] = await binFileUtils.readSection(fd, sections, k)
  await fd.close()
  cached = { curve: zkey.curve, zkey, sections: read }
  return cached
}

const toBuff = (w: bigint[]) => {
  const b = new Uint8Array(w.length * 32)
  w.forEach((v, i) => Scalar.toRprLE(b, i * 32, v, 32))
  return b
}

/** snarkjs's buildABC1, the A and B halves, on one share of the witness: linear. */
function buildAB(curve: Curve, zkey: Zkey, witness: Uint8Array, coeffs: Uint8Array) {
  const n8 = curve.Fr.n8
  const sCoef = 4 * 3 + zkey.n8r
  const nCoef = (coeffs.byteLength - 4) / sCoef
  const out = [new Uint8Array(zkey.domainSize * n8), new Uint8Array(zkey.domainSize * n8)]
  for (let i = 0; i < nCoef; i++) {
    const c = coeffs.slice(4 + i * sCoef, 4 + i * sCoef + sCoef)
    const v = new DataView(c.buffer)
    const m = v.getUint32(0, true)
    const row = v.getUint32(4, true)
    const sig = v.getUint32(8, true)
    out[m].set(curve.Fr.add(out[m].slice(row * n8, row * n8 + n8), curve.Fr.mul(c.slice(12, 12 + n8), witness.slice(sig * n8, sig * n8 + n8))), row * n8)
  }
  return out
}

/** Which rows' A and B sums each party's share can make nonzero: the circuit's shape. */
function rowShape(zkey: Zkey, coeffs: Uint8Array, owner: Owner[]): Shape[] {
  const sCoef = 4 * 3 + zkey.n8r
  const nCoef = (coeffs.byteLength - 4) / sCoef
  const shape: Shape[] = Array.from({ length: zkey.domainSize }, () => ({ xA: false, xB: false, yA: false, yB: false }))
  for (let i = 0; i < nCoef; i++) {
    const v = new DataView(coeffs.buffer, coeffs.byteOffset + 4 + i * sCoef, sCoef)
    const m = v.getUint32(0, true)
    const row = v.getUint32(4, true)
    const o = owner[v.getUint32(8, true)]
    const s = shape[row]
    if (m === 0) {
      s.xA ||= o !== 'B'
      s.xB ||= o !== 'A'
    } else {
      s.yA ||= o !== 'B'
      s.yB ||= o !== 'A'
    }
  }
  return shape
}

const values = (curve: Curve, buff: Uint8Array) =>
  Array.from({ length: buff.byteLength / 32 }, (_, i) => curve.Fr.toObject(buff.slice(i * 32, i * 32 + 32)) as bigint)
const montgomery = (curve: Curve, v: bigint[]) => {
  const b = new Uint8Array(v.length * 32)
  v.forEach((x, i) => b.set(curve.Fr.e(x), i * 32))
  return b
}

async function coset(curve: Curve, zkey: Zkey, evals: Uint8Array) {
  const power = Math.log2(zkey.domainSize)
  const inc = power === curve.Fr.s ? curve.Fr.shift : curve.Fr.w[power + 1]
  const coeffs = await curve.Fr.ifft(evals)
  return curve.Fr.fft(await curve.Fr.batchApplyKey(coeffs, curve.Fr.e(1), inc))
}

export type Proof = { pi_a: string[]; pi_b: string[][]; pi_c: string[]; protocol: 'groth16'; curve: 'bn128' }

/**
 * The joint Groth16 prover. Returns the opened pi_a and pi_b, and pi_c as Alice's and Bob's
 * shares, each serialized as the party would publish it.
 */
export async function jointProve(ch: Channel, keys: Keys, wA: bigint[], wB: bigint[]) {
  const { curve, zkey, sections } = await provingKey()
  const { Fr, G1, G2 } = curve
  const { owner } = wires()
  const shape = rowShape(zkey, sections[4], owner)
  const side = async (w: bigint[]) => {
    const buff = toBuff(w)
    const [a, b] = buildAB(curve, zkey, buff, sections[4])
    return { buff, a, b, av: values(curve, a), bv: values(curve, b) }
  }
  const A = await side(wA)
  const B = await side(wB)

  // c = a * b on the domain: local products, and the cross terms where the circuit's shape has
  // them (the comparison's rows).
  const cross = shape.map((s, k) => ((s.xA && s.yB) || (s.yA && s.xB) ? k : -1)).filter((k) => k >= 0)
  const cRows = multiply(ch, 'QAP c, cross rows', keys, { A: cross.map((k) => A.av[k]), B: cross.map((k) => B.av[k]) }, { A: cross.map((k) => A.bv[k]), B: cross.map((k) => B.bv[k]) }, cross.map((k) => shape[k]))
  const cOf = (X: typeof A, which: 'A' | 'B') => {
    const c = X.av.map((x, k) => mod(x * X.bv[k]))
    cross.forEach((k, i) => (c[k] = cRows[which][i]))
    return montgomery(curve, c)
  }
  // To the odd coset: linear.
  const odd = async (X: typeof A, which: 'A' | 'B') => ({
    a: values(curve, await coset(curve, zkey, X.a)),
    b: values(curve, await coset(curve, zkey, X.b)),
    c: values(curve, await coset(curve, zkey, cOf(X, which))),
  })
  const oA = await odd(A, 'A')
  const oB = await odd(B, 'B')
  // P = a * b - c on the coset: every point needs the cross terms.
  const ab = multiply(ch, 'coset a * b', keys, { A: oA.a, B: oB.a }, { A: oA.b, B: oB.b })
  const pA = ab.A.map((x, k) => mod(x - oA.c[k]))
  const pB = ab.B.map((x, k) => mod(x - oB.c[k]))

  // The multi-scalar multiplications: linear, each party on its own share.
  const priv = (zkey.nPublic + 1) * 32
  const msm = async (buff: Uint8Array, p: bigint[]) => ({
    a: await G1.multiExpAffine(sections[5], buff),
    b1: await G1.multiExpAffine(sections[6], buff),
    b2: await G2.multiExpAffine(sections[7], buff),
    c: G1.add(await G1.multiExpAffine(sections[8], buff.slice(priv)), await G1.multiExpAffine(sections[9], toBuff(p))),
  })
  const mA = await msm(A.buff, pA)
  const mB = await msm(B.buff, pB)

  // Randomness, each party its own half: r = rA + rB, s = sA + sB.
  const [rA, sA, rB, sB] = [0, 1, 2, 3].map(() => mod(P.rand(320)))
  const share = (m: typeof mA, r: bigint, s: bigint, alice: boolean) => ({
    a: G1.add(alice ? G1.add(m.a, zkey.vk_alpha_1) : m.a, G1.timesFr(zkey.vk_delta_1, Fr.e(r))),
    b1: G1.add(alice ? G1.add(m.b1, zkey.vk_beta_1) : m.b1, G1.timesFr(zkey.vk_delta_1, Fr.e(s))),
    b2: G2.add(alice ? G2.add(m.b2, zkey.vk_beta_2) : m.b2, G2.timesFr(zkey.vk_delta_2, Fr.e(s))),
  })
  const shA = share(mA, rA, sA, true)
  const shB = share(mB, rB, sB, false)
  // Open pi_a, pib1 and pi_b: random-looking, as in collaborative Groth16.
  ch.send('A', 'shares of pi_a, pib1 (G1) and pi_b (G2)', 64 + 64 + 128)
  ch.send('B', 'shares of pi_a, pib1 (G1) and pi_b (G2)', 64 + 64 + 128)
  const piA = G1.add(shA.a, shB.a)
  const pib1 = G1.add(shA.b1, shB.b1)
  const piB = G2.add(shA.b2, shB.b2)

  // r * s, shared.
  const rs = multiply(ch, 'r * s', keys, { A: [rA], B: [rB] }, { A: [sA], B: [sB] })
  const cShare = (m: typeof mA, r: bigint, s: bigint, rsX: bigint) =>
    G1.add(G1.add(G1.add(m.c, G1.timesFr(piA, Fr.e(s))), G1.timesFr(pib1, Fr.e(r))), G1.timesFr(zkey.vk_delta_1, Fr.e(mod(-rsX))))
  const cA = cShare(mA, rA, sA, rs.A[0])
  const cB = cShare(mB, rB, sB, rs.B[0])
  const g1 = (p: unknown) => (G1.toObject(G1.toAffine(p)) as bigint[]).map(String)
  const g2 = (p: unknown) => (G2.toObject(G2.toAffine(p)) as bigint[][]).map((c) => c.map(String))
  return { pi_a: g1(piA), pi_b: g2(piB), cA: g1(cA), cB: g1(cB) }
}

/** pi_c from its two shares: what whoever holds both can do, and then test both outputs. */
export async function combine(pi_a: string[], pi_b: string[][], cA: string[], cB: string[]): Promise<Proof> {
  const { curve } = await provingKey()
  const G1 = curve.G1
  const pt = (p: string[]) => G1.fromObject(p.map(BigInt))
  const c = G1.toObject(G1.toAffine(G1.add(pt(cA), pt(cB)))) as bigint[]
  return { pi_a, pi_b, pi_c: c.map(String), protocol: 'groth16', curve: 'bn128' }
}

export const VKEY = JSON.parse(readFileSync(file('build/joint.vkey.json'), 'utf8'))

/** The four public signals, in the circuit's order. */
export const publicSignals = (s: Session, out: bigint) => [s.Ca, s.Cb, s.session, out].map(String)

/** Which output the combined proof is valid for: 1n, 0n, or undefined for neither. */
export async function outputOf(proof: Proof, s: Session): Promise<bigint | undefined> {
  for (const out of [0n, 1n]) if (await snarkjs.groth16.verify(VKEY, publicSignals(s, out), proof)) return out
  return undefined
}

/** For the control: snarkjs alone, given both bids. */
export async function singleProve(alice: Bid, bob: Bid, s: Session): Promise<Proof> {
  const input = { Ca: s.Ca, Cb: s.Cb, session: s.session, out: alice.x > bob.x ? 1n : 0n, a: alice.x, ra: alice.r, b: bob.x, rb: bob.r }
  const { proof } = await snarkjs.groth16.fullProve(Object.fromEntries(Object.entries(input).map(([k, v]) => [k, v.toString()])), WASM, ZKEY)
  return proof as Proof
}

/** Test only: the shares added, which no party ever does, against circom's own witness. */
export async function witnessCheck(wA: bigint[], wB: bigint[], alice: Bid, bob: Bid, s: Session) {
  const full = await calc({ Ca: s.Ca, Cb: s.Cb, session: s.session, out: alice.x > bob.x ? 1n : 0n, a: alice.x, ra: alice.r, b: bob.x, rb: bob.r })
  return full.every((v, i) => mod(wA[i] + wB[i]) === mod(v))
}
