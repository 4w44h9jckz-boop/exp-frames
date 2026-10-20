// Experiment 34's pair, built in Rust by kohaku-rs's `chain::keyed_batch` and sent at once
// through a skandha node, rebuilt here by experiment 30's layout from what a wallet decides: the
// proof and its inputs, the recent root's slot, the fees, and the limits tightened from each
// frame's use. The same note's second spend, refused by the node and never mined, is kept as
// bytes in record.json and rebuilt from its own limits.
import { readFileSync } from 'node:fs'
import { type Address, type Hex, decodeFunctionData, hexToBigInt, keccak256, slice, toHex } from 'viem'
import { describe, expect, it } from 'vitest'
import { type FrameTx, type FrameTxJson, Mode, frameTxFromJson, frameTxHash, parseFrameTx } from '../../src/frametx/index.js'
import { type FramePoolInstance, PoolMode, type PoolProof, poolAbi } from '../06-privacy-pool/pool.js'
import { layoutTx, tighten, worstMaxCost } from '../30-relayer-free-withdrawal/layout.js'

const KEYED_POOL: Address = '0x73e47a8DA2C83Beb802708Fc473B5B7D094f3eE6'
const pool = { address: KEYED_POOL, mode: PoolMode.KEYED, salt: keccak256(toHex('exp-frames/06/pool-keyed')) } as FramePoolInstance
const record = JSON.parse(readFileSync(new URL('./record.json', import.meta.url), 'utf8')) as {
  pair: { hash: Hex; raw: Hex; block: Hex }[]
  sameNote: { hash: Hex; raw: Hex; replaces: Hex; mined: boolean; answer: { error?: string } }
}
const fixture = (hash: Hex) =>
  JSON.parse(readFileSync(new URL(`../../test/fixtures/chain/${hash}.json`, import.meta.url), 'utf8')) as {
    tx: FrameTxJson
    receipt: { blockNumber: Hex; transactionIndex: Hex; frameReceipts: { gasUsed: Hex }[] }
  }

/** What the wallet decided, read back from a withdrawal. */
function decided(tx: FrameTx) {
  const w = tx.frames.find((f) => f.mode === Mode.SENDER)!
  const call = decodeFunctionData({ abi: poolAbi, data: w.data })
  if (call.functionName !== 'withdraw') throw new Error('not a withdrawal')
  const [proofBytes, root, nullifierHash, recipient, relayer, fee, refund] = call.args
  const proof: PoolProof = { leafIndex: 0, commitment: '0x', inputs: { root, nullifierHash, recipient, relayer, fee: toHex(fee), refund: toHex(refund) }, proof: proofBytes }
  return { proof, fee, slot: hexToBigInt(slice(tx.frames[0].data, 32, 40)) }
}

describe('experiment 34, two withdrawals at once through skandha', () => {
  for (const { hash, raw } of record.pair) {
    it(`rebuilds ${hash.slice(0, 10)} from kohaku-rs`, () => {
      const { tx: json, receipt } = fixture(hash)
      const mined = frameTxFromJson(json)
      expect(parseFrameTx(raw)).toEqual(mined)
      const { proof, fee, slot } = decided(mined)
      const limits = tighten(receipt.frameReceipts.map((f) => hexToBigInt(f.gasUsed)), false)
      const rebuilt = layoutTx({ chainId: mined.chainId, pool, proof, slot, withRefund: false, limits, fees: mined.fees })
      expect(frameTxHash(rebuilt)).toBe(hash)
      // The note's fee is the worst-case max cost of its own shape, in both implementations.
      expect(fee).toBe(worstMaxCost(rebuilt))
    })
  }

  it('mined the pair in one block, against one root, with two nonce keys', () => {
    const [a, b] = record.pair.map(({ hash }) => fixture(hash))
    expect(a.receipt.blockNumber).toBe(b.receipt.blockNumber)
    const [ta, tb] = [a, b].map((f) => frameTxFromJson(f.tx))
    expect(ta.nonceKeys).not.toEqual(tb.nonceKeys)
    expect(ta.frames[0].data).toBe(tb.frames[0].data)
  })

  it('kept the same note again: one nonce key with the first, refused by the node, never mined', () => {
    const again = parseFrameTx(record.sameNote.raw)
    expect(frameTxHash(again)).toBe(record.sameNote.hash)
    const first = parseFrameTx(record.pair.find((p) => p.hash === record.sameNote.replaces)!.raw)
    expect(again.nonceKeys).toEqual(first.nonceKeys)
    expect(decided(again).proof.inputs.recipient).not.toBe(decided(first).proof.inputs.recipient)
    expect(record.sameNote.answer.error).toContain('ErrReplaceUnderpriced')
    expect(record.sameNote.mined).toBe(false)
    const { proof, fee, slot } = decided(again)
    const rebuilt = layoutTx({ chainId: again.chainId, pool, proof, slot, withRefund: false, limits: again.frames.map((f) => f.limits.execution), fees: again.fees })
    expect(frameTxHash(rebuilt)).toBe(record.sameNote.hash)
    expect(fee).toBe(worstMaxCost(rebuilt))
  })
})
