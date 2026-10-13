// The execution-scope digest of erc-draft.md, two ways: through viem's EIP-712 implementation, and
// by hand from the byte layout the draft states. The tests hold them equal; the vectors come from
// the first, the on-chain account and the Rust port are checked against those vectors.
import {
  type Address,
  type Hex,
  type TypedDataDefinition,
  concatHex,
  encodeAbiParameters,
  hashTypedData,
  keccak256,
  numberToHex,
  pad,
  stringToHex,
  zeroAddress,
} from 'viem'
import { APPROVE_SCOPE_MASK, Approve, type Frame, type FrameTx, Mode } from '../../src/frametx/index.js'

export const DOMAIN_NAME = 'FrameExecution'
export const DOMAIN_VERSION = '1'

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

/** A pay frame: `VERIFY` whose allowed scope is `PAYMENT` alone. Decided by mode and flags only. */
export const isPayFrame = (f: Pick<Frame, 'mode' | 'flags'>) => f.mode === Mode.VERIFY && (f.flags & APPROVE_SCOPE_MASK) === Approve.PAYMENT

const word = (n: bigint | number) => numberToHex(BigInt(n), { size: 32 })

/** EIP-8250's `nonce_keys_hash`. A plain EIP-8141 envelope is `nonce_keys = [0]`. */
export const nonceKeysHash = (keys: bigint[]): Hex => keccak256(concatHex([word(keys.length), ...keys.map(word)]))

/** A frame as the digest sees it: the resolved target, and a pay frame's open fields zeroed. */
export function digestFrame(tx: FrameTx, f: Frame) {
  const pay = isPayFrame(f)
  return {
    mode: f.mode,
    flags: f.flags,
    target: pay ? zeroAddress : (f.target ?? tx.sender),
    executionLimit: pay ? 0n : f.limits.execution,
    stateLimit: pay ? 0n : f.limits.state,
    value: f.value,
    data: pay ? ('0x' as Hex) : f.data,
  }
}

/** The typed data a wallet is asked to sign (`eth_signTypedData_v4`). */
export function executionTypedData(tx: FrameTx) {
  return {
    domain: { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId: tx.chainId, verifyingContract: tx.sender },
    types,
    primaryType: 'FrameExecution',
    message: {
      nonceKeysHash: nonceKeysHash(tx.nonceKeys),
      nonceSeq: tx.nonceSeq,
      frames: tx.frames.map((f) => digestFrame(tx, f)),
      blobVersionedHashes: tx.blobVersionedHashes,
    },
  } satisfies TypedDataDefinition<typeof types, 'FrameExecution'>
}

/** $E$, through viem's EIP-712 encoder. */
export const executionDigest = (tx: FrameTx): Hex => hashTypedData(executionTypedData(tx))

// ---- by hand, from the layout in erc-draft.md ----

const typeString = (name: keyof typeof types) => `${name}(${types[name].map((m) => `${m.type} ${m.name}`).join(',')})`
export const FRAME_TYPEHASH = keccak256(stringToHex(typeString('Frame')))
export const FRAME_EXECUTION_TYPEHASH = keccak256(stringToHex(typeString('FrameExecution') + typeString('Frame')))
export const DOMAIN_TYPEHASH = keccak256(stringToHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'))

export const domainSeparator = (chainId: bigint, sender: Address): Hex =>
  keccak256(concatHex([DOMAIN_TYPEHASH, keccak256(stringToHex(DOMAIN_NAME)), keccak256(stringToHex(DOMAIN_VERSION)), word(chainId), pad(sender)]))

export function frameHash(tx: FrameTx, f: Frame): Hex {
  const d = digestFrame(tx, f)
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'uint8' },
        { type: 'uint8' },
        { type: 'address' },
        { type: 'uint64' },
        { type: 'uint64' },
        { type: 'uint256' },
        { type: 'bytes32' },
      ],
      [FRAME_TYPEHASH, d.mode, d.flags, d.target, d.executionLimit, d.stateLimit, d.value, keccak256(d.data)],
    ),
  )
}

export function structHash(tx: FrameTx): Hex {
  return keccak256(
    concatHex([
      FRAME_EXECUTION_TYPEHASH,
      nonceKeysHash(tx.nonceKeys),
      word(tx.nonceSeq),
      keccak256(concatHex(tx.frames.map((f) => frameHash(tx, f)))),
      keccak256(concatHex(tx.blobVersionedHashes)),
    ]),
  )
}

/** $E$, by hand: keccak256(0x1901 ‖ domain separator ‖ struct hash). */
export const executionDigestByHand = (tx: FrameTx): Hex => keccak256(concatHex(['0x1901', domainSeparator(tx.chainId, tx.sender), structHash(tx)]))
