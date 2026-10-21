// The joint prover in the clear of a test: two fresh bids, the witness from shares checked
// against circom's own, and the jointly made proof checked against the key. It takes about two
// and a half minutes, so it runs only with JOINT=1.
import { describe, expect, it } from 'vitest'
import { Channel, commit, combine, jointProve, jointWitness, outputOf, witnessCheck } from './joint.js'
import * as P from './paillier.js'

describe.skipIf(!process.env.JOINT)('experiment 52, the joint prover', () => {
  it('proves a > b from two shares, with no dealer', async () => {
    const keys = P.keygen()
    const alice = { x: 5n, r: 11n }
    const bob = { x: 9n, r: 22n }
    const s = { Ca: commit(alice.x, alice.r), Cb: commit(bob.x, bob.r), session: 5n }
    const ch = new Channel()
    const { wA, wB } = await jointWitness(ch, keys, alice, bob, s)
    expect(await witnessCheck(wA, wB, alice, bob, s)).toBe(true)
    const p = await jointProve(ch, keys, wA, wB)
    expect(await outputOf(await combine(p.pi_a, p.pi_b, p.cA, p.cB), s)).toBe(0n)
    // Alice's share alone is not a proof for either output.
    expect(await outputOf(await combine(p.pi_a, p.pi_b, p.cA, ['0', '1', '0']), s)).toBeUndefined()
  }, 600_000)
})
