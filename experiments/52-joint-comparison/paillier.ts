// Paillier encryption, as experiment 52's joint prover uses it for the cross terms of products of
// shared values. Keys of 2048 bits from node's prime generator; encryption with g = N + 1 and the
// randomness hs^alpha, hs = h^N mod N^2 for h = -x^2 mod N and a 256-bit alpha (Damgard, Jurik
// and Nielsen's speed-up); decryption by the Chinese remainder theorem.
import { generatePrimeSync, randomBytes } from 'node:crypto'

export const rand = (bits: number): bigint => BigInt(`0x${randomBytes(Math.ceil(bits / 8)).toString('hex')}`) & ((1n << BigInt(bits)) - 1n)

export function modpow(base: bigint, exp: bigint, m: bigint): bigint {
  let r = 1n
  let b = base % m
  let e = exp
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m
    b = (b * b) % m
    e >>= 1n
  }
  return r
}

function modinv(a: bigint, m: bigint): bigint {
  let [old, r] = [((a % m) + m) % m, m]
  let [s0, s1] = [1n, 0n]
  while (r !== 0n) {
    const q = old / r
    ;[old, r] = [r, old - q * r]
    ;[s0, s1] = [s1, s0 - q * s1]
  }
  if (old !== 1n) throw new Error('not invertible')
  return ((s0 % m) + m) % m
}

export type PublicKey = { N: bigint; N2: bigint; hs: bigint }
export type SecretKey = { p: bigint; q: bigint; hp: bigint; hq: bigint; pinv: bigint }

export function keygen(bits = 2048): { pk: PublicKey; sk: SecretKey } {
  for (;;) {
    const p = generatePrimeSync(bits / 2, { bigint: true }) as bigint
    const q = generatePrimeSync(bits / 2, { bigint: true }) as bigint
    if (p === q) continue
    const N = p * q
    const N2 = N * N
    const x = rand(bits) % N
    const h = (N - ((x * x) % N)) % N
    const hs = modpow(h, N, N2)
    const g = N + 1n
    const L = (u: bigint, n: bigint) => (u - 1n) / n
    const hp = modinv(L(modpow(g, p - 1n, p * p), p), p)
    const hq = modinv(L(modpow(g, q - 1n, q * q), q), q)
    return { pk: { N, N2, hs }, sk: { p, q, hp, hq, pinv: modinv(p, q) } }
  }
}

export function encrypt(pk: PublicKey, m: bigint): bigint {
  const gm = (1n + (((m % pk.N) + pk.N) % pk.N) * pk.N) % pk.N2
  return (gm * modpow(pk.hs, rand(256), pk.N2)) % pk.N2
}

export function decrypt(sk: SecretKey, c: bigint): bigint {
  const { p, q } = sk
  const mp = (((modpow(c, p - 1n, p * p) - 1n) / p) * sk.hp) % p
  const mq = (((modpow(c, q - 1n, q * q) - 1n) / q) * sk.hq) % q
  // CRT: m = mp + p * ((mq - mp) * p^-1 mod q)
  return mp + p * ((((mq - mp) % q) + q) % q * sk.pinv % q)
}

/** Enc(a)^k: the plaintext times k. */
export const scale = (pk: PublicKey, c: bigint, k: bigint): bigint => modpow(c, k, pk.N2)
/** Enc(a) * Enc(b): the plaintexts' sum. */
export const add = (pk: PublicKey, c: bigint, d: bigint): bigint => (c * d) % pk.N2

/** Bytes of a ciphertext on the wire: N^2 is 4,096 bits. */
export const CIPHERTEXT_BYTES = 512
