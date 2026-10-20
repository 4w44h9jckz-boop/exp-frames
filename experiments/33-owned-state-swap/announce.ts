// Encrypted announcements on the board, and the two messages of a swap.
//
// A message is sealed to a recipient's secp256k1 public key P with a fresh key e:
//
//   shared   = x(e * P)                                   32 bytes
//   view tag = keccak256(shared)[0]                        lets a scanner skip most messages
//   key, iv  = HKDF-SHA256(shared, salt = E, info = "exp-frames/33/announcement"), 32 + 12 bytes
//   message  = 0x01 || view tag || E (33, compressed) || AES-256-GCM(key, iv, plaintext) || tag (16)
//
// A wallet scans the board's Posted events and opens what it can. Nobody else learns who a
// message is for; who posted it is the posting transaction's sender.
import { createCipheriv, createDecipheriv, hkdfSync } from 'node:crypto'
import { secp256k1 } from '@noble/curves/secp256k1'
import { type Address, type Hex, type PublicClient, bytesToHex, concat, concatHex, getAddress, hexToBigInt, hexToBytes, keccak256, numberToHex, parseAbi, slice, toHex } from 'viem'

const INFO = 'exp-frames/33/announcement'
const VERSION = 0x01

export type Keys = { secret: Hex; public: Hex }

/** A key pair from PRIVATE_KEY and a label, so every run sees the same keys. */
export function keysOf(base: Hex, label: string): Keys {
  const secret = keccak256(concatHex([base, toHex(`exp-frames/33/key/${label}`)]))
  return { secret, public: bytesToHex(secp256k1.getPublicKey(hexToBytes(secret), true)) }
}

function derive(shared: Uint8Array, ephemeral: Uint8Array) {
  const okm = new Uint8Array(hkdfSync('sha256', shared, ephemeral, INFO, 44))
  return { key: okm.slice(0, 32), iv: okm.slice(32, 44) }
}

const viewTag = (shared: Uint8Array) => hexToBytes(keccak256(shared))[0]

/** Seal `plaintext` to `to` (33-byte compressed key) with the ephemeral key `ephemeral`. */
export function seal(to: Hex, plaintext: Hex, ephemeral: Keys): Hex {
  const shared = secp256k1.getSharedSecret(hexToBytes(ephemeral.secret), hexToBytes(to), true).slice(1)
  const e = hexToBytes(ephemeral.public)
  const { key, iv } = derive(shared, e)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const body = concat([c.update(hexToBytes(plaintext)), c.final(), c.getAuthTag()])
  return bytesToHex(concat([new Uint8Array([VERSION, viewTag(shared)]), e, body]))
}

/** Open a message with `secret`, or undefined if it is not for this key. */
export function open(secret: Hex, message: Hex): Hex | undefined {
  const m = hexToBytes(message)
  if (m.length < 2 + 33 + 16 || m[0] !== VERSION) return undefined
  const e = m.slice(2, 35)
  let shared: Uint8Array
  try {
    shared = secp256k1.getSharedSecret(hexToBytes(secret), e, true).slice(1)
  } catch {
    return undefined
  }
  if (viewTag(shared) !== m[1]) return undefined
  const { key, iv } = derive(shared, e)
  try {
    const d = createDecipheriv('aes-256-gcm', key, iv)
    d.setAuthTag(m.slice(m.length - 16))
    return bytesToHex(concat([d.update(m.slice(35, m.length - 16)), d.final()]))
  } catch {
    return undefined
  }
}

// ---- the board ----

export const boardAbi = parseAbi(['function post(bytes message)', 'event Posted(bytes message)'])

export async function boardMessages(client: PublicClient, board: Address): Promise<{ message: Hex; tx: Hex; block: bigint }[]> {
  const logs = await client.getContractEvents({ address: board, abi: boardAbi, eventName: 'Posted', fromBlock: 'earliest' })
  return logs.map((l) => ({ message: l.args.message as Hex, tx: l.transactionHash, block: l.blockNumber }))
}

/** Every message on the board `secret` can open, with the plaintext. */
export async function scan(client: PublicClient, board: Address, secret: Hex) {
  const out: { message: Hex; plaintext: Hex; tx: Hex; block: bigint }[] = []
  for (const m of await boardMessages(client, board)) {
    const plaintext = open(secret, m.message)
    if (plaintext) out.push({ ...m, plaintext })
  }
  return out
}

// ---- the swap's two messages ----

const w = (x: bigint, size = 32) => numberToHex(x, { size })

/** An offer: what the offerer gives and wants, the note it spends, and where to answer. */
export type Offer = {
  registry: Address
  give: { app: Address; value: bigint }
  want: { app: Address; value: bigint }
  /** The expiry frame's deadline both proofs will bind. */
  deadline: bigint
  /** The nullifier of the note the offerer gives. */
  nullifier: bigint
  /** The offerer's inner for the note it receives. */
  receiveInner: bigint
  /** The offerer's announcement key, for the answer. */
  replyKey: Hex
}

export const encodeOffer = (o: Offer): Hex =>
  concatHex(['0x01', o.registry, o.give.app, w(o.give.value, 8), o.want.app, w(o.want.value, 8), w(o.deadline, 8), w(o.nullifier), w(o.receiveInner), o.replyKey])

export function decodeOffer(p: Hex): Offer | undefined {
  if (hexToBytes(p).length !== 182 || slice(p, 0, 1) !== '0x01') return undefined
  const at = (s: number, n: number) => slice(p, s, s + n)
  return {
    registry: getAddress(at(1, 20)),
    give: { app: getAddress(at(21, 20)), value: hexToBigInt(at(41, 8)) },
    want: { app: getAddress(at(49, 20)), value: hexToBigInt(at(69, 8)) },
    deadline: hexToBigInt(at(77, 8)),
    nullifier: hexToBigInt(at(85, 32)),
    receiveInner: hexToBigInt(at(117, 32)),
    replyKey: at(149, 33),
  }
}

/** An acceptance: the offer it answers, the note the acceptor gives, and the root to prove against. */
export type Accept = { offer: Hex; nullifier: bigint; receiveInner: bigint; root: bigint; slot: bigint }

/** An offer is named by the hash of its message as posted. */
export const offerId = (message: Hex): Hex => keccak256(message)

export const encodeAccept = (a: Accept): Hex => concatHex(['0x02', a.offer, w(a.nullifier), w(a.receiveInner), w(a.root), w(a.slot, 8)])

export function decodeAccept(p: Hex): Accept | undefined {
  if (hexToBytes(p).length !== 137 || slice(p, 0, 1) !== '0x02') return undefined
  const at = (s: number, n: number) => slice(p, s, s + n)
  return { offer: at(1, 32), nullifier: hexToBigInt(at(33, 32)), receiveInner: hexToBigInt(at(65, 32)), root: hexToBigInt(at(97, 32)), slot: hexToBigInt(at(129, 8)) }
}
