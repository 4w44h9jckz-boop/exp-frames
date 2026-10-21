// Experiment 42's records read back: the proofs Barretenberg made natively, each EVM verifier's
// gas on the testnet against both budgets, and the floor under any pairing-based verifier.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8')
const json = (f: string) => JSON.parse(read(f))
const summary = json('./build/summary.json') as {
  depth: number
  nullifiers: string[]
  targets: Record<string, { verifiedNatively: boolean; proofBytes: number; publicInputs: number }>
}
const onchain = json('./verifiers.json') as {
  chainId: number
  results: { target: string; proofBytes: number; publicInputs: number; deployedBytes: number; libraries: { deployedBytes: number }[]; verifyGas: number; verifySucceeded: boolean; changedInputSucceeded: boolean }[]
}
const TESTNET_VERIFY = 500_000
const EIP8141_VERIFY = 100_000

describe('experiment 42, a Noir transfer checked in a frame', () => {
  it('proved natively for both targets, and the files are those proofs', () => {
    expect(summary.depth).toBe(32)
    expect(new Set(summary.nullifiers).size).toBe(2)
    for (const [target, t] of Object.entries(summary.targets)) {
      expect(t.verifiedNatively).toBe(true)
      expect((read(`./build/${target}.proof`).trim().length - 2) / 2).toBe(t.proofBytes)
      expect(JSON.parse(read(`./build/${target}.public.json`)).length).toBe(t.publicInputs)
    }
  })

  it('verified on the testnet, refused a changed public input, and fits neither budget', () => {
    expect(onchain.chainId).toBe(8141)
    expect(onchain.results.map((r) => r.target)).toEqual(['evm', 'evm-no-zk'])
    for (const r of onchain.results) {
      expect(r.proofBytes).toBe(summary.targets[r.target].proofBytes)
      expect(r.verifySucceeded).toBe(true)
      expect(r.changedInputSucceeded).toBe(false)
      for (const size of [r.deployedBytes, ...r.libraries.map((l) => l.deployedBytes)]) expect(size).toBeLessThanOrEqual(24_576)
      expect(r.verifyGas).toBeGreaterThan(TESTNET_VERIFY)
    }
  })

  it('a pairing check of two pairs already exceeds EIP-8141 on either curve', () => {
    const bn254 = (k: number) => 34_000 * k + 45_000 // EIP-1108
    const bls12381 = (k: number) => 32_600 * k + 37_700 // EIP-2537
    expect(bn254(2)).toBe(113_000)
    expect(bls12381(2)).toBe(102_900)
    expect(Math.min(bn254(2), bls12381(2))).toBeGreaterThan(EIP8141_VERIFY)
    // Groth16 on BN254: four pairs and one scalar multiplication and addition per public input.
    expect(bn254(4) + 7 * (6_000 + 150)).toBe(224_050)
  })
})
