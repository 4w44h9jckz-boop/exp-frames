// Experiment 52's mined transactions (2026-10-21), checked from public data alone: no bid, no
// commitment's randomness and no Paillier key is here.
//
// - Both settlements, the joint proof's (session 1) and the control's (session 5), are rebuilt
//   by settleTx byte for byte, and each proof verifies for (Ca, Cb, session, 1).
// - The two settlements have the same frames, limits and calldata length: what the chain shows
//   cannot tell the joint proof from the single prover's.
// - The joint proof's pi_a and pi_b are the ones the record says were opened, and its pi_c is
//   Alice's posted share plus a share Bob never posted.
// - The sessions' steps, as SealedPair logged them, are the plan's.
import { readFileSync } from 'node:fs'
import * as snarkjs from 'snarkjs'
import { type Hex, decodeEventLog, decodeFunctionData, getAddress, hexToBigInt } from 'viem'
import { describe, expect, it } from 'vitest'
import { type FrameTxJson, frameTxFromJson, frameTxHash } from '../../src/frametx/index.js'
import { VKEY } from './joint.js'
import { pair, pairAbi, settleTx } from './pair.js'

const SETTLE_JOINT: Hex = '0x13b84f26eeb5e26e6f3a177633b62ee7634b4c19964aacde8eb02b450b4eb108'
const SETTLE_CONTROL: Hex = '0xad49fd2a7df996864765f145bb51873e6b4b58bc90ef02775b5f5183c7ceefd6'
const REVEAL_1: Hex = '0x2a6619a4179937f1d5b304ca9599baa74b98ccb2f6a8d6c3fe636f35c1aa3653'
const STEPS: Hex[] = [
  '0x312fc5ea33bd652e5b3d60332d004e66fde2ddbf890ddc9f44048559729e220f', // open 1 to 5
  '0x7c6d8e76ccb4d57dd9ae06d073d3c6dbc245f0ba9b078ad7275374b1a3c6c27d', // join 1, 3, 4, 5
  REVEAL_1,
  SETTLE_JOINT,
  '0x65c756aa0213f80d8346ff428a708782f03ed3e480b623bcaa0a238b4b2d7bd9', // reveal 4
  SETTLE_CONTROL,
  '0xe95fc76aab34130e6caa2d513b0de6db3da3dcc10d704f914836efb173107258', // reclaim 2
  '0x59cda0cbf499753740e88e0a063ef462ca683beb04a2fb014e25211a78463e64', // reclaim 3
  '0xa323d8537d5f0ad28589ed917a9ebfb94dff0f3c7e2c9a6d68cd9579788a09e1', // reclaim 4
]
const record = JSON.parse(readFileSync(new URL('./record-r1.json', import.meta.url), 'utf8'))
type Log = { address: Hex; topics: [Hex, ...Hex[]]; data: Hex }
const fixture = (hash: Hex) =>
  JSON.parse(readFileSync(new URL(`../../test/fixtures/chain/${hash}.json`, import.meta.url), 'utf8')) as {
    tx: FrameTxJson
    receipt: { frameReceipts: { logs: Log[] }[] }
  }

function settled(hash: Hex) {
  const mined = frameTxFromJson(fixture(hash).tx)
  const { args } = decodeFunctionData({ abi: pairAbi, data: mined.frames[2].data })
  const [session, out, proof] = args as unknown as [Hex, bigint, readonly bigint[]]
  const deadline = BigInt(`0x${mined.frames[0].data.slice(2)}`)
  return { mined, session: hexToBigInt(session), out, proof: [...proof], deadline }
}

const asSnarkjs = (w: bigint[]) => {
  const p = w.map(String)
  return { pi_a: [p[0], p[1], '1'], pi_b: [[p[3], p[2]], [p[5], p[4]], ['1', '0']], pi_c: [p[6], p[7], '1'], protocol: 'groth16', curve: 'bn128' }
}
const signals = (session: bigint, out: bigint) => [BigInt(record.Ca), BigInt(record.Cb), session, out].map(String)

describe('experiment 52, a sealed comparison with no committee', () => {
  for (const hash of [SETTLE_JOINT, SETTLE_CONTROL] as Hex[]) {
    it(`rebuilds the settlement ${hash.slice(0, 10)} and verifies its proof`, async () => {
      const s = settled(hash)
      expect(frameTxHash(settleTx({ chainId: s.mined.chainId, session: s.session, deadline: s.deadline, out: s.out, proof: s.proof }))).toBe(hash)
      expect(s.mined.sender).toBe(pair.address)
      expect(await snarkjs.groth16.verify(VKEY, signals(s.session, s.out), asSnarkjs(s.proof))).toBe(true)
      expect(await snarkjs.groth16.verify(VKEY, signals(s.session, 1n - s.out), asSnarkjs(s.proof))).toBe(false)
    })
  }

  it('shows the same on chain for the joint proof and the single prover', () => {
    const [j, c] = [SETTLE_JOINT, SETTLE_CONTROL].map((h) => settled(h).mined)
    const shape = (t: typeof j) => t.frames.map((f) => ({ mode: f.mode, flags: f.flags, target: f.target, limits: f.limits, value: f.value, bytes: f.data.length }))
    expect(shape(j)).toEqual(shape(c))
    expect(j.signatures).toEqual(c.signatures)
    expect(j.fees).toEqual(c.fees)
  })

  it("made the joint proof from the opened pi_a and pi_b and Alice's posted share", async () => {
    const s = settled(SETTLE_JOINT)
    expect(s.session).toBe(BigInt(record.sessions['1']))
    const r = record.s1
    expect([s.proof[0], s.proof[1]]).toEqual(r.pi_a.slice(0, 2).map(BigInt))
    expect([s.proof[2], s.proof[3], s.proof[4], s.proof[5]]).toEqual([r.pi_b[0][1], r.pi_b[0][0], r.pi_b[1][1], r.pi_b[1][0]].map(BigInt))
    const log = fixture(REVEAL_1).receipt.frameReceipts.flatMap((f) => f.logs).find((l) => getAddress(l.address) === pair.address)!
    const { args } = decodeEventLog({ abi: pairAbi, ...log }) as unknown as { args: { state: bigint; x: bigint; y: bigint } }
    expect(args.state).toBe(3n)
    expect([args.x, args.y]).toEqual(r.aliceShare.slice(0, 2).map(BigInt))
    // Alice's share alone is not pi_c: Bob's half was never posted.
    expect(args.x).not.toBe(s.proof[6])
  })

  it("logged each session's steps as the plan has them", () => {
    const states: Record<string, string[]> = {}
    for (const h of STEPS) {
      for (const l of fixture(h).receipt.frameReceipts.flatMap((f) => f.logs)) {
        if (getAddress(l.address) !== pair.address) continue
        const { args } = decodeEventLog({ abi: pairAbi, ...l }) as unknown as { args: { session: Hex; state: bigint; x: bigint } }
        const i = Object.entries(record.sessions).find(([, v]) => BigInt(v as string) === hexToBigInt(args.session))![0]
        states[i] = [...(states[i] ?? []), args.state === 5n ? `reclaimed from ${args.x}` : String(args.state)]
      }
    }
    expect(states).toEqual({
      1: ['1', '2', '3', '4'], // opened, joined, Alice's share, settled
      2: ['1', 'reclaimed from 1'], // Bob never joined
      3: ['1', '2', 'reclaimed from 2'], // the prover stopped
      4: ['1', '2', '3', 'reclaimed from 3'], // Bob stopped after Alice's share
      5: ['1', '2', '4'], // the control
    })
  })
})
