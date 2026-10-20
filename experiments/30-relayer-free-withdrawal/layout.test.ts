// Every withdrawal experiment 30's layouts produced on the testnet, rebuilt byte for byte from
// what a wallet decides: the proof and its inputs, the recent root's slot, the fees and the
// limits it tightened from a simulation. 0x9ccc4123 (baseline) and 0xc992b54a (RefundPool) were
// built here by refund.ts; 0x339af560 (RefundPool) was built and sent by kohaku-rs,
// `crates/frame-pool/examples/refund_withdrawal.rs`.
import { readFileSync } from 'node:fs'
import { type Address, type Hex, decodeFunctionData, getAddress, hexToBigInt, keccak256, slice, toHex } from 'viem'
import { describe, expect, it } from 'vitest'
import { type FrameTxJson, Mode, RECENT_ROOT, frameTxFromJson, frameTxHash, serializeFrameTx } from '../../src/frametx/index.js'
import { type FramePoolInstance, PoolMode, type PoolProof, poolAbi } from '../06-privacy-pool/pool.js'
import { REFUND_POOL_SALT, layoutTx, tighten, worstMaxCost } from './layout.js'

const KEYED_POOL: Address = '0x73e47a8DA2C83Beb802708Fc473B5B7D094f3eE6'
const REFUND_POOL: Address = '0xe19605853A749322655470199Fd31D3F3e53Baf9'
const pools: Record<Address, FramePoolInstance> = {
  [KEYED_POOL]: { address: KEYED_POOL, mode: PoolMode.KEYED, salt: keccak256(toHex('exp-frames/06/pool-keyed')) } as FramePoolInstance,
  [REFUND_POOL]: { address: REFUND_POOL, mode: PoolMode.KEYED, salt: REFUND_POOL_SALT } as FramePoolInstance,
}

const MINED: { hash: Hex; by: string }[] = [
  { hash: '0x9ccc4123b89ec87748b524dd335b501669f59b24dc5be06fc06fb3bab4f4f7f4', by: 'refund.ts, baseline' },
  { hash: '0xc992b54ace771290579f92435cb12e7eee1368d216eb02c7ed0544343aa2cd10', by: 'refund.ts, RefundPool' },
  { hash: '0x339af560b79b175b240b4250809cc14e84b34799023cb2a847053bd2e7119659', by: 'kohaku-rs, RefundPool' },
]

const fixture = (hash: Hex) =>
  JSON.parse(readFileSync(new URL(`../../test/fixtures/chain/${hash}.json`, import.meta.url), 'utf8')) as {
    tx: FrameTxJson
    receipt: { frameReceipts: { gasUsed: Hex }[] }
  }

describe('experiment 30 withdrawals, rebuilt', () => {
  for (const { hash, by } of MINED) {
    it(`${hash.slice(0, 10)} (${by})`, () => {
      const { tx: json, receipt } = fixture(hash)
      const mined = frameTxFromJson(json)
      const pool = pools[getAddress(mined.sender)]
      const withRefund = mined.frames.length === 4
      const w = mined.frames.find((f) => f.mode === Mode.SENDER)
      const root = mined.frames.find((f) => f.target !== null && getAddress(f.target) === RECENT_ROOT)
      if (!pool || !w || !root) throw new Error('not an experiment 30 withdrawal')
      const call = decodeFunctionData({ abi: poolAbi, data: w.data })
      if (call.functionName !== 'withdraw') throw new Error('not a withdrawal')
      const [proofBytes, r, nullifierHash, recipient, relayer, fee, refund] = call.args
      const proof: PoolProof = {
        leafIndex: 0,
        commitment: '0x',
        inputs: { root: r, nullifierHash, recipient, relayer, fee: toHex(fee), refund: toHex(refund) },
        proof: proofBytes,
      }
      const slot = hexToBigInt(slice(root.data, 32, 40))

      // The limits are what tighten() makes of the mined frames' use.
      const used = receipt.frameReceipts.map((f) => hexToBigInt(f.gasUsed))
      const limits = tighten(used, withRefund)
      const rebuilt = layoutTx({ chainId: mined.chainId, pool, proof, slot, withRefund, limits, fees: mined.fees })

      expect(rebuilt).toEqual(mined)
      expect(serializeFrameTx(rebuilt)).toBe(serializeFrameTx(mined))
      expect(frameTxHash(rebuilt)).toBe(hash)
      // The note's fee is the worst-case max cost of its own shape: what the wallet proved.
      expect(fee).toBe(worstMaxCost(rebuilt))
    })
  }
})
