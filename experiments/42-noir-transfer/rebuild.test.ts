// Experiment 42's records read back: the proofs Barretenberg made natively, each EVM verifier's
// gas on the testnet against both budgets, and the floor under any pairing-based verifier.
import { createHash } from 'node:crypto'
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

const hasher = json('./hasher.json') as { results: { inputs: number; matches: boolean; gas: number }[] }
type Receipt = { label: string; hash: string; block: number; frames: { execution: number; state: number; status: number }[] }
type Attempt = { verifyExecution: number; simulation: { valid: boolean; violation: string | null }; hash?: string; error?: string }
const pools = (json('./pool.json') as {
  pools: { label: string; pool: string; txs: Receipt[]; transfer: { nullifiers: string[]; honkAcceptsByCall: boolean; proofBytes: number; attempts: Attempt[]; again: Attempt } }[]
}).pools
const pool = (label: string) => pools.find((p) => p.label === label)!

describe('experiment 42, the transfer as a frame transaction', () => {
  it("hashed as Barretenberg does, at one permutation per three inputs", () => {
    expect(hasher.results.map((r) => r.inputs)).toEqual([1, 2, 3, 4, 5, 6, 7])
    for (const r of hasher.results) expect(r.matches).toBe(true)
  })

  it('gave both pools a real proof that Barretenberg accepts by call', () => {
    for (const p of pools) {
      expect(p.transfer.honkAcceptsByCall).toBe(true)
      expect(p.transfer.proofBytes).toBe(8000)
      expect(BigInt(p.transfer.nullifiers[0])).toBeLessThan(BigInt(p.transfer.nullifiers[1]))
    }
  })

  it('was refused with the real verifier, by its limits and then by running out within them', () => {
    const [full, capped] = pool('zk').transfer.attempts
    expect(full.verifyExecution).toBeGreaterThan(onchain.results[0].verifyGas)
    expect(full.simulation.violation).toMatch(/MAX_VERIFY_GAS/)
    expect(full.error).toMatch(/exceeds MAX_VERIFY_GAS/)
    expect(capped.verifyExecution).toBeLessThan(TESTNET_VERIFY)
    expect(capped.simulation.violation).toBe('validation prefix frame reverted')
    expect(capped.hash).toBeUndefined()
  })

  it('was mined with AcceptAnyProof, with the nullifiers as nonce keys, and not again', () => {
    const p = pool('layout')
    const [mined] = p.transfer.attempts
    expect(mined.simulation.valid).toBe(true)
    const transfer = p.txs.find((t) => t.label === 'transfer')!
    expect(transfer.hash).toBe(mined.hash)
    expect(transfer.frames.map((f) => f.status)).toEqual([1, 1, 1])
    // Everything the prefix pays besides the verifier, and the nonce keys' two fresh slots.
    expect(transfer.frames[0].execution + transfer.frames[1].execution).toBeLessThan(12_000)
    expect(transfer.frames[1].state).toBe(2 * 97_920)
    expect(p.transfer.again.error).toMatch(/Nonce mismatch/)
  })
})

const rust = json('./pool.rust.json') as {
  pool: string
  prover: string
  nullifiers: string[]
  honkAcceptsByCall: boolean
  attempt: Attempt
  mined: Receipt | null
}

describe('experiment 42, a transfer proved from kohaku-rs', () => {
  it("was Noir's executor and Barretenberg from Rust, accepted by Barretenberg's verifier, and mined", () => {
    expect(rust.pool).toBe(pool('layout').pool)
    expect(rust.prover).toMatch(/^kohaku-noir-transfer, Noir 1\.0\.0-rc\.6\+2c22344a/)
    expect(rust.honkAcceptsByCall).toBe(true)
    expect(BigInt(rust.nullifiers[0])).toBeLessThan(BigInt(rust.nullifiers[1]))
    expect(rust.attempt.simulation.valid).toBe(true)
    expect(rust.mined?.hash).toBe(rust.attempt.hash)
    expect(rust.mined?.frames.map((f) => f.status)).toEqual([1, 1, 1])
  })
})

const g16 = json('./groth16.json') as { verifyGas: number; verifySucceeded: boolean; changedInputSucceeded: boolean; proofBytes: number }
const g16pool = json('./pool.groth16.json') as {
  adapter: string
  txs: Receipt[]
  transfer: { proofBytes: number; honkAcceptsByCall: boolean; attempts: Attempt[]; again: Attempt }
}

describe('experiment 42, Groth16 through Sunspot', () => {
  it("costs gnark's verifier less than the testnet's budget and more than EIP-8141's", () => {
    expect(g16.verifySucceeded).toBe(true)
    expect(g16.changedInputSucceeded).toBe(false)
    expect(g16.proofBytes).toBe(384)
    expect(g16.verifyGas).toBeLessThan(TESTNET_VERIFY)
    expect(g16.verifyGas).toBeGreaterThan(EIP8141_VERIFY)
    // Four pairs for the proof, two for the commitment's proof of knowledge, seven inputs.
    const pairing = (k: number) => 34_000 * k + 45_000
    expect(g16.verifyGas).toBeGreaterThan(pairing(4) + pairing(2) + 7 * (6_000 + 150))
  })

  it('carried the transfer, mined within the budget, and refused it again', () => {
    expect(g16pool.transfer.honkAcceptsByCall).toBe(true)
    expect(g16pool.transfer.proofBytes).toBe(384)
    const [mined] = g16pool.transfer.attempts
    expect(mined.simulation.valid).toBe(true)
    const transfer = g16pool.txs.find((t) => t.label === 'transfer')!
    expect(transfer.hash).toBe(mined.hash)
    expect(transfer.frames.map((f) => f.status)).toEqual([1, 1, 1])
    const prefix = transfer.frames[0].execution + transfer.frames[1].execution
    expect(prefix).toBeLessThan(TESTNET_VERIFY)
    expect(prefix).toBeGreaterThan(g16.verifyGas)
    expect(g16pool.transfer.again.error).toMatch(/Nonce mismatch/)
  })
})

describe("experiment 42, Groth16's keys", () => {
  it('are the keys the setup recorded', () => {
    const setup = json('./build/groth16/setup.json') as { proving_key_sha256: string; verifying_key_sha256: string; circuit: { ccs_sha256: string } }
    const sha = (f: string) => createHash('sha256').update(readFileSync(new URL(f, import.meta.url))).digest('hex')
    expect(sha('./build/groth16/transfer.pk')).toBe(setup.proving_key_sha256)
    expect(sha('./build/groth16/transfer.vk')).toBe(setup.verifying_key_sha256)
    expect(sha('./build/groth16/transfer.ccs')).toBe(setup.circuit.ccs_sha256)
  })
})
