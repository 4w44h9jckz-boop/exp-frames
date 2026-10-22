// Experiment 53's mined transactions (2026-10-21), checked from public data alone: the note's
// opening is not here, only its commitment and nullifier hash, which the chain shows anyway.
//
// - The deposit put the note's commitment in experiment 06's keyed pool.
// - The withdrawal is rebuilt by experiment 06's withdrawalTx byte for byte, from the proof and
//   public inputs the committee's members wrote; its nonce key is the note's nullifier hash.
// - The three members agreed on the proof, and what each sent is the record's.
import { readFileSync } from 'node:fs'
import { type Hex, decodeFunctionData, getAddress, slice, toHex } from 'viem'
import { describe, expect, it } from 'vitest'
import { type FrameTxJson, frameTxFromJson, frameTxHash } from '../../src/frametx/index.js'
import { keyedPool } from './keyed-pool.js'
import { type PoolProof, poolAbi, withdrawalTx } from '../06-privacy-pool/pool.js'

const DEPOSIT: Hex = '0x90a8c76e569f80f81f599a67aa601c82a1a9bb5dd22f61c088e108bb95be7678'
const WITHDRAWAL: Hex = '0x5a28ca2e484b69ec10a1c5740b9eeb3210745dd7a679a30a32bfd3fd1f428f2a'
const record = JSON.parse(readFileSync(new URL('./record-r1.json', import.meta.url), 'utf8'))
const fixture = (hash: Hex) =>
  JSON.parse(readFileSync(new URL(`../../test/fixtures/chain/${hash}.json`, import.meta.url), 'utf8')) as { tx: FrameTxJson }

describe('experiment 53, a note handed to a committee', () => {
  it('describes the keyed pool, without a key, at the address the run used', () => {
    expect(keyedPool.address).toBe(record.pool)
  })

  it("deposited the note's commitment in the keyed pool", () => {
    const mined = frameTxFromJson(fixture(DEPOSIT).tx)
    const call = mined.frames.find((f) => f.target && getAddress(f.target) === keyedPool.address)!
    const { args } = decodeFunctionData({ abi: poolAbi, data: call.data })
    expect(args[0]).toBe(record.commitment)
  })

  it("rebuilds the withdrawal from the committee's proof, byte for byte", () => {
    const mined = frameTxFromJson(fixture(WITHDRAWAL).tx)
    const hex = (d: string) => toHex(BigInt(d), { size: 32 })
    const [root, nh, rcpt, relayer, fee, refund] = record.publicInputs as string[]
    const proof: PoolProof = {
      leafIndex: record.leafIndex,
      commitment: record.commitment,
      inputs: { root: hex(root), nullifierHash: hex(nh), recipient: slice(hex(rcpt), 12), relayer: slice(hex(relayer), 12), fee: toHex(BigInt(fee)), refund: toHex(BigInt(refund)) },
      proof: record.proof,
    }
    const slot = BigInt(slice(mined.frames[0].data, 32, 40))
    expect(frameTxHash(withdrawalTx({ chainId: mined.chainId, pool: keyedPool, proof, slot }))).toBe(WITHDRAWAL)
    expect(mined.nonceKeys).toEqual([BigInt(record.nullifierHash)])
    expect(getAddress(slice(hex(relayer), 12))).toBe(keyedPool.address)
  })

  it('had three members agree, each sending under a kilobyte', () => {
    expect(record.members.every((m: { verified: boolean }) => m.verified)).toBe(true)
    for (const m of record.members) {
      const sent = m.peers.reduce((s: number, p: { bytesSent: number }) => s + p.bytesSent, 0)
      expect(sent).toBeLessThan(1024)
    }
    expect(record.shareBytes).toEqual([1811012, 1811012, 1811012])
  })

  it('records that any two members rebuild the opening, and none alone', () => {
    expect(record.after.pairs.every((p: { equalsWitness: boolean }) => p.equalsWitness)).toBe(true)
    expect(record.after.alone.every((a: { valuesEqualToTheWitness: number }) => a.valuesEqualToTheWitness === 0)).toBe(true)
    expect([record.after.nullifierMatches, record.after.secretMatches]).toEqual([true, true])
  })
})

describe('experiment 53, the second arm', () => {
  const arm2 = JSON.parse(readFileSync(new URL('./record-arm2-r1.json', import.meta.url), 'utf8'))
  const N2_WITHDRAWAL: Hex = '0x6d59b72823afe7c54b770c69b99d38b8051a800194867c05ef1a26960b8b0824'
  const N3_DEPOSIT: Hex = '0x3f8ea6e6add49928fb07fac505c28945953f47969238911fe67f13c4b17fab2e'

  it("withdrew N2 to R, and R itself deposited N3: the chain's link", () => {
    const w = frameTxFromJson(fixture(N2_WITHDRAWAL).tx)
    expect(w.nonceKeys).toEqual([BigInt(arm2.N2.nullifierHash)])
    const { args } = decodeFunctionData({ abi: poolAbi, data: w.frames.at(-1)!.data })
    expect(getAddress(args[3] as Hex)).toBe(getAddress(arm2.R))
    const d = frameTxFromJson(fixture(N3_DEPOSIT).tx)
    expect(getAddress(d.sender)).toBe(getAddress(arm2.R))
    const call = d.frames.find((f) => f.target && getAddress(f.target) === keyedPool.address)!
    expect(decodeFunctionData({ abi: poolAbi, data: call.data }).args[0]).toBe(arm2.N3.commitment)
  })

  it('records what the retained shares open: N2, spent; not N3', () => {
    expect(arm2.after).toMatchObject({ pairsRebuildN2: true, n2OpeningRead: true, n2Spent: true, n3OpeningInRetainedShares: false, n3Live: true })
  })
})
