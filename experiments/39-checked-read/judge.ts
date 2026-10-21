// The third party of experiment 39, written apart from the Rust that made the evidence: it holds
// the published evidence, a header and the disputed account's branch, and decides whether the
// server signed a wrong answer. Nothing here is the reader's or the server's code.
import { type Address, type Hex, concat, fromRlp, getAddress, hexToBigInt, keccak256, recoverAddress, slice, toHex, toRlp } from 'viem'

export const N = 1024
const DELTA = 1 << 24
const CLAIM = 60
const EMPTY_CODE = keccak256('0x')
const EMPTY_ROOT = keccak256(toRlp('0x'))

export type Manifest = {
  server: Hex
  signer: Address
  block: number
  stateRoot: Hex
  seed: Hex
  salt: Hex
  rows: number
  cols: number
  capacity: number
  record: number
  split: number
  hintRoot: Hex
}
export type Evidence = {
  manifest: Manifest
  query: Hex
  answer: Hex
  signature: Hex
  secret: Hex
  column: number
  slot: number
  hintRows: Hex[]
  hintPaths: Hex[][]
  claimed: Hex
}
export type AccountState = { nonce: bigint; balance: bigint; storageRoot: Hex; codeHash: Hex }

/** `u32`s, little-endian, as they travel. */
export const words = (h: Hex): Uint32Array => {
  const b = Buffer.from(h.slice(2), 'hex')
  return new Uint32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length))
}

/** The keystream of ChaCha20 (20 rounds, 64-bit block counter from 0, zero stream) under `seed`,
 * as `u32`s: what `rand_chacha`'s `ChaCha20Rng::from_seed(seed)` yields word by word. */
export function chacha20(seed: Hex, count: number): Uint32Array {
  const key = words(seed)
  const out = new Uint32Array(count)
  const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n))
  const s = new Uint32Array(16)
  for (let block = 0, at = 0; at < count; block++) {
    const init = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574, ...key, block >>> 0, Math.floor(block / 2 ** 32), 0, 0]
    s.set(init)
    const qr = (a: number, b: number, c: number, d: number) => {
      s[a] += s[b]; s[d] = rotl(s[d] ^ s[a], 16)
      s[c] += s[d]; s[b] = rotl(s[b] ^ s[c], 12)
      s[a] += s[b]; s[d] = rotl(s[d] ^ s[a], 8)
      s[c] += s[d]; s[b] = rotl(s[b] ^ s[c], 7)
    }
    for (let r = 0; r < 10; r++) {
      qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15)
      qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14)
    }
    for (let i = 0; i < 16 && at < count; i++) out[at++] = (s[i] + init[i]) >>> 0
  }
  return out
}

const inner = (a: Uint32Array, b: Uint32Array) => {
  let acc = 0
  for (let i = 0; i < a.length; i++) acc = (acc + Math.imul(a[i], b[i])) | 0
  return acc >>> 0
}
const be = (n: number, bytes: number) => toHex(BigInt(n), { size: bytes })

export const commitment = (m: Manifest): Hex =>
  keccak256(concat([toHex('kohaku-checked-read-v1'), m.server, be(m.block, 8), m.stateRoot, m.seed, m.salt,
    be(m.rows, 4), be(m.cols, 4), be(m.capacity, 4), be(m.record, 4), m.hintRoot]))

export const digest = (m: Manifest, query: Hex, answer: Hex): Hex =>
  keccak256(concat([commitment(m), keccak256(query), keccak256(answer)]))

export function rowUnder(root: Hex, row: Hex, index: number, path: Hex[]): boolean {
  let h = keccak256(row)
  for (const s of path) {
    h = index % 2 === 0 ? keccak256(concat([h, s])) : keccak256(concat([s, h]))
    index = Math.floor(index / 2)
  }
  return index === 0 && h === root
}

/** A header from its RLP: its hash computed here, its number and state root read from it. */
export function header(rlp: Hex) {
  const f = fromRlp(rlp, 'hex') as Hex[]
  return { hash: keccak256(rlp), stateRoot: f[3], number: Number(f[8] === '0x' ? 0n : hexToBigInt(f[8])) }
}

const nibbles = (h: Hex) => [...h.slice(2)].map((c) => Number.parseInt(c, 16))

/** `address`'s account under `root`, walking nodes taken by their hashes. */
export function account(root: Hex, address: Address, proof: Hex[]): AccountState | null {
  if (root === EMPTY_ROOT) return null
  const nodes = new Map(proof.map((n) => [keccak256(n), n]))
  const key = nibbles(keccak256(address))
  let at = 0
  let node: unknown = fromRlp(nodes.get(root) ?? fail(`no node ${root}`), 'hex')
  for (;;) {
    const items = node as (Hex | unknown[])[]
    let next: Hex | unknown[]
    if (items.length === 17) {
      next = items[key[at++]]
    } else if (items.length === 2) {
      const enc = nibbles(items[0] as Hex)
      const path = enc[0] & 1 ? enc.slice(1) : enc.slice(2)
      if (enc[0] & 2) {
        if (key.slice(at).join() !== path.join()) return null
        const [nonce, balance, storageRoot, codeHash] = fromRlp(items[1] as Hex, 'hex') as Hex[]
        const q = (x: Hex) => (x === '0x' ? 0n : hexToBigInt(x))
        return { nonce: q(nonce), balance: q(balance), storageRoot, codeHash }
      }
      if (key.slice(at, at + path.length).join() !== path.join()) return null
      at += path.length
      next = items[1]
    } else return fail('a node of neither 17 nor 2 items')
    if (Array.isArray(next)) node = next
    else if (next === '0x') return null
    else node = fromRlp(nodes.get(next) ?? fail(`no node ${next}`), 'hex')
  }
}
function fail(why: string): never {
  throw new Error(why)
}

/** Whether a record's `delegate || balance (12) || nonce (8)` is `st`. */
export function isValue(st: AccountState, value: Hex): boolean {
  const delegate = slice(value, 0, 20)
  const codeHash = BigInt(delegate) === 0n ? EMPTY_CODE : keccak256(concat(['0xef0100', delegate]))
  return st.balance === hexToBigInt(slice(value, 20, 32)) && st.nonce === hexToBigInt(slice(value, 32, 40)) && st.codeHash === codeHash
}

export type Verdict =
  | { wrong: true; address: Address; signedBalance: bigint; chain: AccountState | null }
  | { wrong: false; address: Address }

/** Judge `e` against a header and a branch the judge holds. Throws if the evidence is dismissed. */
export async function judge(e: Evidence, headerRlp: Hex, chainProof: Hex[]): Promise<Verdict> {
  const m = e.manifest
  const query = words(e.query)
  const answer = words(e.answer)
  const secret = words(e.secret)
  if (query.length !== m.cols || answer.length !== m.rows || secret.length !== N) fail('sizes')
  // 1. The server's signature, under its identity.
  const signer = await recoverAddress({ hash: digest(m, e.query, e.answer), signature: e.signature })
  if (getAddress(signer) !== getAddress(m.signer) || m.server.toLowerCase() !== toHex(BigInt(m.signer), { size: 32 })) fail('not the server\'s signature')
  // 2. The snapshot is the chain's.
  const h = header(headerRlp)
  if (h.number !== m.block || h.stateRoot !== m.stateRoot) fail('not the snapshot\'s header')
  // 3. The query is well formed.
  const a = chacha20(m.seed, m.cols * N)
  let noise = 0
  for (let c = 0; c < m.cols; c++) {
    let v = (query[c] - inner(a.subarray(c * N, (c + 1) * N), secret)) >>> 0
    if (c === e.column) v = (v - DELTA) >>> 0
    noise += Math.abs(v | 0)
  }
  if (noise * 255 >= DELTA / 2) fail(`a query whose error sums to ${noise}`)
  // 4. The hint rows and the record they decode.
  if (e.hintRows.length !== CLAIM) fail('hint rows')
  const record = new Uint8Array(CLAIM)
  e.hintRows.forEach((row, k) => {
    const index = e.slot * m.record + k
    if (!rowUnder(m.hintRoot, row, index, e.hintPaths[k])) fail(`hint row ${index} is not under the root`)
    record[k] = (((answer[index] - inner(words(row), secret) + DELTA / 2) >>> 0) >>> 24) & 0xff
  })
  if (toHex(record) !== e.claimed.toLowerCase()) fail('the record is not what is claimed')
  const address = getAddress(slice(toHex(record), 0, 20))
  const value = slice(toHex(record), 20, CLAIM)
  // 5. The chain.
  const chain = account(h.stateRoot, address, chainProof)
  if (chain && isValue(chain, value)) return { wrong: false, address }
  return { wrong: true, address, signedBalance: hexToBigInt(slice(value, 20, 32)), chain }
}

