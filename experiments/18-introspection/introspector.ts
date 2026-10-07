import { type Address, type Hex, concatHex, hexToBigInt, keccak256, numberToHex, pad, sliceHex, toHex } from 'viem'
import { privateKeyToAddress } from 'viem/accounts'
import { compileYul } from '../../src/contracts.js'
import { create2Address, deployFrame, saltOf } from '../../src/deploy.js'
import { loadKey } from '../../src/env.js'
import {
  APPROVE_SCOPE_MASK,
  ATOMIC_BATCH_FLAG,
  type FrameReceiptJson,
  type FrameSignature,
  type FrameTx,
  Scheme,
  frameSigHash,
  makeClient,
  maxCost,
} from '../../src/frametx/index.js'

export const { privateKey, address: funder } = loadKey()
export const client = makeClient()

export const owner = (() => {
  const key = keccak256(concatHex([privateKey, toHex('exp-frames/18/owner')]))
  return { key, address: privateKeyToAddress(key) }
})()

export const introspector = (() => {
  const initcode = concatHex([compileYul('experiments/18-introspection/Introspector.yul'), pad(owner.address)])
  const salt = saltOf('exp-frames/18/introspector/v1')
  return { address: create2Address(initcode, salt), deploy: deployFrame(initcode, salt).frame }
})()

/** Calldata for the Introspector's operations. */
export const Op = {
  dump: '0x00' as Hex,
  probe: (op: number, a: bigint | number, b: bigint | number): Hex =>
    concatHex([numberToHex(1, { size: 1 }), numberToHex(op, { size: 1 }), numberToHex(BigInt(a), { size: 32 }), numberToHex(BigInt(b), { size: 32 })]),
  gas: '0x02' as Hex,
  revert: '0x03' as Hex,
  nested: '0x04' as Hex,
}

/** A 32-byte ARBITRARY entry: the hash of the dump VERIFY is expected to see. */
export const expectedEntry = (hash: Hex): FrameSignature => ({ scheme: Scheme.ARBITRARY, signer: null, msg: '0x', signature: hash })

export type Context = {
  /** The sender's legacy nonce before the transaction (TXPARAM 0x0D). */
  legacyNonce: bigint
  /** Receipts of the frames before the current one, for status and gas used. */
  receipts?: FrameReceiptJson[]
}

export type Word = { label: string; value: bigint }

const word0 = (data: Hex): bigint => {
  const bytes = (data.length - 2) / 2
  if (bytes === 0) return 0n
  const first = bytes >= 32 ? sliceHex(data, 0, 32) : (`${data}${'00'.repeat(32 - bytes)}` as Hex)
  return hexToBigInt(first)
}

/** The dump the Introspector writes when it runs in frame `current`, as the EIP and tooling read the transaction. */
export function model(tx: FrameTx, current: number, ctx: Context): Word[] {
  const out: Word[] = []
  const put = (label: string, value: bigint) => out.push({ label, value })
  const keys = tx.nonceKeys
  put('TXPARAM 0x00 tx type', 6n)
  put('TXPARAM 0x01 nonce_seq', tx.nonceSeq)
  put('TXPARAM 0x02 sender', hexToBigInt(tx.sender))
  put('TXPARAM 0x03 max priority fee', tx.fees.maxPriorityFeePerGas)
  put('TXPARAM 0x04 max fee', tx.fees.maxFeePerGas)
  put('TXPARAM 0x05 max blob fee', tx.fees.maxFeePerBlobGas)
  put('TXPARAM 0x06 max cost', maxCost(tx))
  put('TXPARAM 0x07 blob count', BigInt(tx.blobVersionedHashes.length))
  put('TXPARAM 0x08 sig hash', hexToBigInt(frameSigHash(tx)))
  put('TXPARAM 0x09 frame count', BigInt(tx.frames.length))
  put('TXPARAM 0x0A current frame', BigInt(current))
  put('TXPARAM 0x0B signature count', BigInt(tx.signatures.length))
  put('TXPARAM 0x0C state gas left', tx.frames[current].limits.state)
  put('TXPARAM 0x0D legacy nonce', ctx.legacyNonce)
  put('TXPARAM 0x0E nonce key count', BigInt(keys.length))
  put('TXPARAM 0x0F nonce keys hash', hexToBigInt(keccak256(concatHex([numberToHex(keys.length, { size: 32 }), ...keys.map((k) => numberToHex(k, { size: 32 }))]))))
  put('TXPARAM 0x10 nonce key 0', keys[0])
  tx.frames.forEach((f, i) => {
    const at = (p: string) => `FRAMEPARAM ${p} frame ${i}`
    put(at('0x00 target'), hexToBigInt(f.target ?? tx.sender))
    put(at('0x01 execution limit'), f.limits.execution)
    put(at('0x02 mode'), BigInt(f.mode))
    put(at('0x03 flags'), BigInt(f.flags))
    put(at('0x04 data length'), BigInt((f.data.length - 2) / 2))
    put(at('0x06 allowed scope'), BigInt(f.flags & APPROVE_SCOPE_MASK))
    put(at('0x07 atomic batch'), BigInt((f.flags & ATOMIC_BATCH_FLAG) >> 2))
    put(at('0x08 value'), f.value)
    put(at('0x09 state limit'), f.limits.state)
    put(`FRAMEDATALOAD(${i}, 0)`, word0(f.data))
    if (i < current) {
      const r = ctx.receipts?.[i]
      if (!r) throw new Error(`model needs the receipt of frame ${i}`)
      put(at('0x05 status'), hexToBigInt(r.status))
      put(at('0x0A gas used, execution'), hexToBigInt(r.gasUsed))
      put(at('0x0B gas used, state'), hexToBigInt(r.stateGasUsed))
    }
  })
  tx.signatures.forEach((s, i) => {
    put(`SIGPARAM 0x01 scheme sig ${i}`, BigInt(s.scheme))
    put(`SIGPARAM 0x02 msg sig ${i}`, s.msg === '0x' ? 0n : hexToBigInt(s.msg))
    if (s.scheme === Scheme.ARBITRARY) put(`SIGPARAM 0x03 length sig ${i}`, BigInt((s.signature.length - 2) / 2))
    else put(`SIGPARAM 0x00 signer sig ${i}`, hexToBigInt((s.signer ?? tx.sender) as Address))
  })
  return out
}

export const dumpHash = (words: Word[]): Hex => keccak256(concatHex(words.map((w) => numberToHex(w.value, { size: 32 }))))

export const decode = (data: Hex): bigint[] => Array.from({ length: (data.length - 2) / 64 }, (_, i) => hexToBigInt(sliceHex(data, 32 * i, 32 * (i + 1))))
