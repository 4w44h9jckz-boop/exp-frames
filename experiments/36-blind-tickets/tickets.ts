// Blind tickets, read back in TypeScript with an implementation of its own: the ticket message
// rebuilt from a transaction, hashed to G1 with noble's RFC 9380 hasher, and the pairing checked
// with noble's pairing. kohaku-rs's `kohaku-frame-ticket` issued the tickets with Commonware's
// BLS12-381 (blst); the paymaster checked them with EIP-2537's precompiles. Three
// implementations, one answer.
import { bls12_381 as bls } from '@noble/curves/bls12-381'
import {
  type Address,
  type Hex,
  concatHex,
  encodeFunctionData,
  hexToBigInt,
  hexToBytes,
  keccak256,
  numberToHex,
  parseAbi,
  size,
  slice,
  stringToHex,
} from 'viem'
import { compileYul } from '../../src/contracts.js'
import { create2Address } from '../../src/deploy.js'
import { Approve, type FrameTx, Mode, senderFrame, verifyFrame } from '../../src/frametx/index.js'

export const NAMESPACE = 'kohaku-ticket-v1'
/** Commonware's `MinSig` message tag: RFC 9380's BLS12381G1_XMD:SHA-256_SSWU_RO_ with POP. */
export const DST = 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_POP_'
export const EPOCH_SECONDS = 384n
/** experiment 33's board. */
export const BOARD: Address = '0x93DD748B72dA1b1B6F1d5ec78Cb91ee52F01727d'

type G1 = ReturnType<typeof bls.G1.ProjectivePoint.fromHex>
type G2 = ReturnType<typeof bls.G2.ProjectivePoint.fromHex>

const word = (n: bigint | number) => numberToHex(BigInt(n), { size: 32 })
export const nonceKeysHash = (keys: bigint[]): Hex => keccak256(concatHex([word(keys.length), ...keys.map(word)]))

/** What a pay frame carries: epoch (8) || salt (32) || signature (128, EIP-2537's G1). */
export type PayData = { epoch: bigint; salt: Hex; signature: G1 }

export function readPayData(data: Hex): PayData {
  if (size(data) !== 168) throw new Error(`pay data of ${size(data)} bytes`)
  return { epoch: hexToBigInt(slice(data, 0, 8)), salt: slice(data, 8, 40), signature: g1FromEip2537(slice(data, 40)) }
}

/** The ticket message for `tx`'s slot: chain_id || sender || nonce_keys_hash || nonce_seq || epoch || salt. */
export function ticketMessage(tx: FrameTx, epoch: bigint, salt: Hex): Hex {
  return concatHex([
    word(tx.chainId),
    tx.sender,
    nonceKeysHash(tx.nonceKeys),
    numberToHex(tx.nonceSeq, { size: 8 }),
    numberToHex(epoch, { size: 8 }),
    salt,
  ])
}

/** Commonware's `union_unique`: the namespace's length as a varint, the namespace, the message. */
export function unionUnique(namespace: string, message: Hex): Uint8Array {
  const ns = hexToBytes(stringToHex(namespace))
  if (ns.length >= 128) throw new Error('a one-byte varint only')
  return new Uint8Array([ns.length, ...ns, ...hexToBytes(message)])
}

/** The point the issuers' signature is on. */
export function ticketPoint(message: Hex): G1 {
  return bls.G1.hashToCurve(unionUnique(NAMESPACE, message), { DST }) as unknown as G1
}

/** e(signature, g2) = e(point, key): `MinSig`'s verification equation. */
export function verifies(point: G1, signature: G1, key: G2): boolean {
  if (signature.equals(bls.G1.ProjectivePoint.ZERO)) return false
  return bls.fields.Fp12.eql(bls.pairing(signature, bls.G2.ProjectivePoint.BASE), bls.pairing(point, key))
}

export const g1 = (compressed: Hex): G1 => bls.G1.ProjectivePoint.fromHex(compressed.slice(2))
export const g2 = (compressed: Hex): G2 => bls.G2.ProjectivePoint.fromHex(compressed.slice(2))
export const compressed = (p: G1 | G2): Hex => `0x${p.toHex(true)}`

export function g1FromEip2537(b: Hex): G1 {
  const x = hexToBigInt(slice(b, 0, 64))
  const y = hexToBigInt(slice(b, 64, 128))
  const p = bls.G1.ProjectivePoint.fromAffine({ x, y })
  p.assertValidity()
  return p
}

/** EIP-2537's encoding of a G2 point: x.c0 || x.c1 || y.c0 || y.c1, 64 bytes each. */
export function g2Eip2537(p: G2): Hex {
  const { x, y } = p.toAffine()
  return concatHex([x.c0, x.c1, y.c0, y.c1].map((v) => numberToHex(v, { size: 64 })))
}

/** The paymaster's initcode: TicketPaymaster.yul || key || denomination. */
export function paymasterInitcode(key: G2, denomination: bigint): Hex {
  return concatHex([compileYul('experiments/36-blind-tickets/TicketPaymaster.yul'), g2Eip2537(key), word(denomination)])
}

export const paymasterAddress = create2Address

const boardAbi = parseAbi(['function post(bytes message)'])

/**
 * A fresh sender's first transaction paid with a ticket, laid out as kohaku-rs's builder lays
 * it out: the sender's own VERIFY (default code), the paymaster's VERIFY(PAYMENT) with the
 * ticket, which also pays the new account's 183,600 state gas, and one post to the board.
 */
export function spendLayout(opts: { tx: Pick<FrameTx, 'chainId' | 'sender' | 'fees' | 'signatures'>; paymaster: Address; payData: Hex }): FrameTx {
  return {
    chainId: opts.tx.chainId,
    nonceKeys: [0n],
    nonceSeq: 0n,
    sender: opts.tx.sender,
    frames: [
      verifyFrame({ scope: Approve.EXECUTION, execution: 20_000n }),
      verifyFrame({ scope: Approve.PAYMENT, target: opts.paymaster, data: opts.payData, execution: 130_000n, state: 183_600n }),
      senderFrame({ target: BOARD, data: encodeFunctionData({ abi: boardAbi, args: [stringToHex('paid with a blind ticket')] }), execution: 30_000n }),
    ],
    signatures: opts.tx.signatures,
    fees: opts.tx.fees,
    blobVersionedHashes: [],
  }
}

/** The pay frame of a spend: the VERIFY frame with scope PAYMENT. */
export const payFrame = (tx: FrameTx) => tx.frames.find((f) => f.mode === Mode.VERIFY && f.flags === Approve.PAYMENT)!

export const epochOf = (timestamp: bigint) => timestamp / EPOCH_SECONDS
