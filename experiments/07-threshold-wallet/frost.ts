// FROST (Komlo and Goldberg, RFC 9591) over secp256k1, for teaching: a t-of-n group holds one
// Schnorr key that no member ever knows, and any t members sign with it in two rounds.
//
// The signature is shaped for the EVM's ecrecover precompile (the trick Chainlink's
// SchnorrSECP256K1 uses), so an account can verify it for 3,000 gas without a Schnorr precompile:
//
//   challenge  c = keccak256(Px ‖ parity(P) ‖ msg ‖ address(R)) mod n
//   signature  (address(R), z)  with  z = k − c·x,  so  z·G + c·P = R
//   check      ecrecover(h = −z·Px, v = 27 + parity(P), r = Px, s = c·Px) == address(R)
//
// because ecrecover returns the address of r⁻¹·(s·P − h·G) = c·P + z·G.
//
// Not production code. The key generation is Pedersen's DKG without the proofs of knowledge
// RFC 9591's trusted-dealer-free setups add against rogue keys, the hash domains are ad hoc, and
// nothing here is constant-time.
import { secp256k1 } from '@noble/curves/secp256k1'
import { invert, mod } from '@noble/curves/abstract/modular'
import { type Address, type Hex, concatHex, getAddress, keccak256, numberToHex, toHex } from 'viem'

const Point = secp256k1.ProjectivePoint
type Point = InstanceType<typeof Point>
export const N = secp256k1.CURVE.n
const G = Point.BASE
const modN = (a: bigint) => mod(a, N)
const mul = (p: Point, k: bigint) => p.multiply(modN(k))

export function addressOf(p: Point): Address {
  const { x, y } = p.toAffine()
  return getAddress(`0x${keccak256(concatHex([numberToHex(x, { size: 32 }), numberToHex(y, { size: 32 })])).slice(26)}`)
}
const scalar = (...parts: Hex[]) => modN(BigInt(keccak256(concatHex(parts))))
const randomScalar = () => modN(BigInt(`0x${Buffer.from(secp256k1.utils.randomPrivateKey()).toString('hex')}`))

// ---- key generation: every member deals a share of its own secret polynomial ----

export type Member = { id: bigint; poly: bigint[] }
export type KeyShare = { id: bigint; secret: bigint; verification: Point }
export type Group = { t: number; publicKey: Point; px: bigint; parity: number; shares: KeyShare[] }

/** A member's degree t−1 polynomial, from `seed` so a run can be repeated. */
export function member(id: bigint, t: number, seed: Hex): Member {
  return { id, poly: Array.from({ length: t }, (_, k) => scalar(seed, toHex(`frost/poly/${id}/${k}`))) }
}

const evaluate = (poly: bigint[], x: bigint) => poly.reduceRight((acc, a) => modN(acc * x + a), 0n)

/**
 * Pedersen DKG. Member i publishes C_i = [a_i0·G, …], sends f_i(j) to member j privately; j checks
 * f_i(j)·G against C_i and keeps x_j = Σ_i f_i(j). The group key is Σ_i a_i0·G. Nobody holds Σ_i a_i0.
 */
export function dkg(members: Member[], t: number): Group {
  const commitments = members.map((m) => m.poly.map((a) => mul(G, a)))
  const shares = members.map((receiver) => {
    let secret = 0n
    for (const [i, dealer] of members.entries()) {
      const share = evaluate(dealer.poly, receiver.id)
      // receiver's check: f_i(j)·G == Σ_k C_ik · j^k
      const expected = commitments[i].reduce((acc, c, k) => acc.add(mul(c, receiver.id ** BigInt(k))), Point.ZERO)
      if (!mul(G, share).equals(expected)) throw new Error(`member ${dealer.id} dealt a bad share to ${receiver.id}`)
      secret = modN(secret + share)
    }
    return { id: receiver.id, secret, verification: mul(G, secret) }
  })
  const publicKey = commitments.reduce((acc, c) => acc.add(c[0]), Point.ZERO)
  const { x, y } = publicKey.toAffine()
  if (x >= N) throw new Error('group key x >= n: ecrecover cannot take it as r; pick other seeds')
  return { t, publicKey, px: x, parity: Number(y & 1n), shares }
}

// ---- signing: two rounds ----

export type Nonces = { id: bigint; d: bigint; e: bigint }
export type Commitment = { id: bigint; D: Point; E: Point }

/** Round 1: fresh nonces, published as commitments. They must never be used twice. */
export function round1(id: bigint): { nonces: Nonces; commitment: Commitment } {
  const d = randomScalar()
  const e = randomScalar()
  return { nonces: { id, d, e }, commitment: { id, D: mul(G, d), E: mul(G, e) } }
}

const encodeCommitments = (cs: Commitment[]): Hex =>
  concatHex(cs.flatMap((c) => [numberToHex(c.id, { size: 32 }), toHex(c.D.toRawBytes(true)), toHex(c.E.toRawBytes(true))]))

const bindingFactor = (id: bigint, msg: Hex, cs: Commitment[]) => scalar(toHex('frost/rho'), numberToHex(id, { size: 32 }), msg, encodeCommitments(cs))

function groupCommitment(msg: Hex, cs: Commitment[]): Point {
  return cs.reduce((acc, c) => acc.add(c.D).add(mul(c.E, bindingFactor(c.id, msg, cs))), Point.ZERO)
}

export function challenge(group: Pick<Group, 'px' | 'parity'>, msg: Hex, rAddress: Address): bigint {
  return scalar(numberToHex(group.px, { size: 32 }), numberToHex(group.parity, { size: 1 }), msg, rAddress)
}

/** Lagrange coefficient of `id` at 0 over the signing set. */
export function lagrange(id: bigint, ids: bigint[]): bigint {
  let num = 1n
  let den = 1n
  for (const j of ids) {
    if (j === id) continue
    num = modN(num * j)
    den = modN(den * (j - id))
  }
  return modN(num * invert(den, N))
}

/** Round 2: member `share.id`'s response z_i = d_i + e_i·ρ_i − λ_i·x_i·c. */
export function round2(group: Group, share: KeyShare, nonces: Nonces, msg: Hex, cs: Commitment[]): bigint {
  const ids = cs.map((c) => c.id)
  const R = groupCommitment(msg, cs)
  const c = challenge(group, msg, addressOf(R))
  const rho = bindingFactor(share.id, msg, cs)
  return modN(nonces.d + nonces.e * rho - lagrange(share.id, ids) * share.secret * c)
}

/** The coordinator checks each response, then adds them up: (address(R), z). */
export function aggregate(group: Group, msg: Hex, cs: Commitment[], responses: Map<bigint, bigint>): { rAddress: Address; z: bigint } {
  const ids = cs.map((c) => c.id)
  const R = groupCommitment(msg, cs)
  const rAddress = addressOf(R)
  const c = challenge(group, msg, rAddress)
  let z = 0n
  for (const cm of cs) {
    const zi = responses.get(cm.id)
    if (zi === undefined) throw new Error(`no response from member ${cm.id}`)
    const share = group.shares.find((s) => s.id === cm.id)!
    // z_i·G == D_i + ρ_i·E_i − c·λ_i·X_i
    const lhs = mul(G, zi)
    const rhs = cm.D.add(mul(cm.E, bindingFactor(cm.id, msg, cs))).subtract(mul(share.verification, c * lagrange(cm.id, ids)))
    if (!lhs.equals(rhs)) throw new Error(`member ${cm.id} sent a bad response`)
    z = modN(z + zi)
  }
  if (!mul(G, z).add(mul(group.publicKey, c)).equals(R)) throw new Error('aggregate does not verify')
  return { rAddress, z }
}

/** The 52 bytes FrostAccount reads from its ARBITRARY entry. */
export const encodeSignature = (sig: { rAddress: Address; z: bigint }): Hex => concatHex([sig.rAddress, numberToHex(sig.z, { size: 32 })])

/** The whole two-round protocol among `signers`, with every message passed in memory. */
export function sign(group: Group, signers: bigint[], msg: Hex): { rAddress: Address; z: bigint } {
  const r1 = signers.map((id) => round1(id))
  const cs = r1.map((r) => r.commitment)
  const responses = new Map(r1.map((r) => [r.nonces.id, round2(group, group.shares.find((s) => s.id === r.nonces.id)!, r.nonces, msg, cs)]))
  return aggregate(group, msg, cs, responses)
}
