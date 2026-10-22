// Experiment 43's record read back: the shares named, the committee's three proofs agreeing on
// the wallet's public inputs, and the withdrawal mined carrying that proof.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8')
const json = (f: string) => JSON.parse(read(f))
const pub = json('./record/public.json') as { inputs: string[] }
const withdrawal = json('./record/withdrawal.json') as {
  chainId: number
  pool: string
  leafIndex: number
  publicInputs: { root: string; nullifierHash: string; recipient: string; relayer: string; fee: string; refund: string }
}
const members = json('./record/members.json') as {
  member: number
  solidity: string
  publicInputs: string[]
  verified: boolean
  peers: { peer: number; bytesSent: number }[]
}[]
type Frame = { execution: number; state: number; status: number }
const chain = json('./record/chain.json') as {
  deposit: { hash: string; status: number }
  withdrawal: { hash: string; status: number; sender: string; payer: string; frames: Frame[]; carriesCommitteeProof: boolean }
}

describe("experiment 43, a withdrawal proved by a committee from the wallet's shares", () => {
  it('named three shares, and the six public inputs in the clear', () => {
    const lines = read('./record/shares.sha256').trim().split('\n')
    expect(lines.map((l) => l.split(/\s+/)[1])).toEqual(['share-0.bin', 'share-1.bin', 'share-2.bin'])
    expect(new Set(lines.map((l) => l.split(/\s+/)[0])).size).toBe(3)
    const i = withdrawal.publicInputs
    const expected = [i.root, i.nullifierHash, i.recipient, i.relayer, i.fee, i.refund].map((x) => BigInt(x).toString())
    expect(pub.inputs).toEqual(expected)
    expect(BigInt(i.relayer)).toBe(BigInt(withdrawal.pool))
  })

  it('was proved once by all three members, on those inputs, and verified', () => {
    expect(members.map((m) => m.member)).toEqual([0, 1, 2])
    for (const m of members) {
      expect(m.verified).toBe(true)
      expect(m.solidity).toBe(members[0].solidity)
      expect(m.publicInputs).toEqual(pub.inputs)
      expect(m.peers.map((p) => p.peer)).toEqual([0, 1, 2].filter((p) => p !== m.member))
    }
    expect((members[0].solidity.length - 2) / 2).toBe(256)
  })

  it("was mined from the pool, unsigned, carrying the committee's proof, at experiment 30's gas", () => {
    expect(chain.deposit.status).toBe(1)
    const w = chain.withdrawal
    expect(w.status).toBe(1)
    expect(w.sender.toLowerCase()).toBe(withdrawal.pool.toLowerCase())
    expect(w.payer.toLowerCase()).toBe(withdrawal.pool.toLowerCase())
    expect(w.carriesCommitteeProof).toBe(true)
    expect(w.frames.map((f) => [f.execution, f.state, f.status])).toEqual([
      [5_579, 0, 1],
      [244_744, 97_920, 1],
      [14_255, 183_600, 1],
      [11_531, 0, 1],
    ])
  })
})
