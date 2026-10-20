// SPDX-License-Identifier: CC0-1.0, pending the copyright waiver
//
// The execution-scope digest E of a frame transaction (EIP-8141, with EIP-8250 keyed nonces), as
// EIP-712 typed data. A reference implementation with no dependency but viem.
//
//   domain  = EIP712Domain("FrameExecution", "1", chain_id, verifyingContract = sender)
//   message = FrameExecution(nonceKeysHash, nonceSeq, Frame[] frames, bytes32[] blobVersionedHashes)
//   Frame   = (mode, flags, resolved target, execution limit, state limit, value, data)
//
// A pay frame is a VERIFY frame (mode 1) whose allowed scope (flags & 3) is PAYMENT (1) alone. Its
// target, both limits and data are the payer's, and are zeroed; its mode, flags and value stay.
// A null target resolves to the sender. A plain EIP-8141 envelope's nonce is the legacy nonce, so
// it digests as the legacy selection of EIP-8250: `nonce_keys == []` at master, `[0]` before
// commit 56b645be.
//
// `executionDigest` goes through viem's EIP-712 encoder; `executionDigestByHand` follows the byte
// layout. vectors.json holds every input this takes and the E each must give.
import { type Address, type Hex, concatHex, encodeAbiParameters, hashTypedData, keccak256, numberToHex, pad, stringToHex, zeroAddress } from 'viem'

export type DigestFrame = {
  mode: number
  flags: number
  target: Address | null
  executionLimit: bigint
  stateLimit: bigint
  value: bigint
  data: Hex
}

export type DigestTx = {
  chainId: bigint
  sender: Address
  nonceKeys: bigint[]
  nonceSeq: bigint
  frames: DigestFrame[]
  blobVersionedHashes: Hex[]
}

export const DOMAIN_NAME = 'FrameExecution'
export const DOMAIN_VERSION = '1'
const VERIFY = 1
const PAYMENT = 1
const SCOPE_MASK = 3

export const types = {
  FrameExecution: [
    { name: 'nonceKeysHash', type: 'bytes32' },
    { name: 'nonceSeq', type: 'uint64' },
    { name: 'frames', type: 'Frame[]' },
    { name: 'blobVersionedHashes', type: 'bytes32[]' },
  ],
  Frame: [
    { name: 'mode', type: 'uint8' },
    { name: 'flags', type: 'uint8' },
    { name: 'target', type: 'address' },
    { name: 'executionLimit', type: 'uint64' },
    { name: 'stateLimit', type: 'uint64' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
  ],
} as const

const word = (n: bigint | number) => numberToHex(BigInt(n), { size: 32 })

export const isPayFrame = (f: Pick<DigestFrame, 'mode' | 'flags'>) => f.mode === VERIFY && (f.flags & SCOPE_MASK) === PAYMENT

/** EIP-8250's nonce_keys_hash: keccak256 of the key count and the keys, as 32-byte words. */
export const nonceKeysHash = (keys: bigint[]): Hex => keccak256(concatHex([word(keys.length), ...keys.map(word)]))

/** A frame as E sees it. */
export function digestFrame(tx: DigestTx, f: DigestFrame) {
  const pay = isPayFrame(f)
  return {
    mode: f.mode,
    flags: f.flags,
    target: pay ? zeroAddress : (f.target ?? tx.sender),
    executionLimit: pay ? 0n : f.executionLimit,
    stateLimit: pay ? 0n : f.stateLimit,
    value: f.value,
    data: pay ? ('0x' as Hex) : f.data,
  }
}

/** The typed data a wallet signs through eth_signTypedData_v4. */
export const executionTypedData = (tx: DigestTx) => ({
  domain: { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId: tx.chainId, verifyingContract: tx.sender },
  types,
  primaryType: 'FrameExecution' as const,
  message: {
    nonceKeysHash: nonceKeysHash(tx.nonceKeys),
    nonceSeq: tx.nonceSeq,
    frames: tx.frames.map((f) => digestFrame(tx, f)),
    blobVersionedHashes: tx.blobVersionedHashes,
  },
})

export const executionDigest = (tx: DigestTx): Hex => hashTypedData(executionTypedData(tx))

// ---- by hand ----

const typeString = (name: keyof typeof types) => `${name}(${types[name].map((m) => `${m.type} ${m.name}`).join(',')})`
export const FRAME_TYPEHASH = keccak256(stringToHex(typeString('Frame')))
export const FRAME_EXECUTION_TYPEHASH = keccak256(stringToHex(typeString('FrameExecution') + typeString('Frame')))
export const DOMAIN_TYPEHASH = keccak256(stringToHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'))

export const domainSeparator = (chainId: bigint, sender: Address): Hex =>
  keccak256(concatHex([DOMAIN_TYPEHASH, keccak256(stringToHex(DOMAIN_NAME)), keccak256(stringToHex(DOMAIN_VERSION)), word(chainId), pad(sender)]))

export function frameHash(tx: DigestTx, f: DigestFrame): Hex {
  const d = digestFrame(tx, f)
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint8' }, { type: 'uint8' }, { type: 'address' }, { type: 'uint64' }, { type: 'uint64' }, { type: 'uint256' }, { type: 'bytes32' }],
      [FRAME_TYPEHASH, d.mode, d.flags, d.target, d.executionLimit, d.stateLimit, d.value, keccak256(d.data)],
    ),
  )
}

export const structHash = (tx: DigestTx): Hex =>
  keccak256(
    concatHex([
      FRAME_EXECUTION_TYPEHASH,
      nonceKeysHash(tx.nonceKeys),
      word(tx.nonceSeq),
      keccak256(concatHex(tx.frames.map((f) => frameHash(tx, f)))),
      keccak256(concatHex(tx.blobVersionedHashes)),
    ]),
  )

export const executionDigestByHand = (tx: DigestTx): Hex => keccak256(concatHex(['0x1901', domainSeparator(tx.chainId, tx.sender), structHash(tx)]))

/** A vector's `tx` field, as vectors.json writes it. */
export type VectorTx = {
  chainId: number
  sender: Address
  nonceKeys: Hex[]
  nonceSeq: number
  frames: { mode: number; flags: number; target: Address | null; executionLimit: number; stateLimit: number; value: Hex; data: Hex }[]
  blobVersionedHashes: Hex[]
}

export const fromVector = (v: VectorTx): DigestTx => ({
  chainId: BigInt(v.chainId),
  sender: v.sender,
  nonceKeys: v.nonceKeys.map((k) => BigInt(k)),
  nonceSeq: BigInt(v.nonceSeq),
  frames: v.frames.map((f) => ({ ...f, executionLimit: BigInt(f.executionLimit), stateLimit: BigInt(f.stateLimit), value: BigInt(f.value) })),
  blobVersionedHashes: v.blobVersionedHashes,
})
