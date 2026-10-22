// Experiment 41's records read back: the floor recomputed from EIP-2537's schedule and the
// transcript's size, the testnet's measured price for the two precompile calls, and the native
// runs on BLS12-381.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (f: string) => JSON.parse(readFileSync(new URL(f, import.meta.url), 'utf8'))
const measure = read('./measure.json') as {
  floors: { k: number; floor: { g2MsmGas: number; pairingGas: number; absorbedBytes: number; squeezedBytes: number; permutations: number; hashingGas: number; totalGas: number } }[]
  runs: { curve: string; d: number; k: number; load: string; verified: boolean; tamperedRefused: boolean; evmProofBytes: number }[]
}
const pre = read('./precompiles.json') as { g2Msm128: { gas: number; ok: boolean; schedule: number }; pairing8: { gas: number; ok: boolean; schedule: number } }

describe('experiment 41, an encrypted input proof in VERIFY', () => {
  it('recomputes each floor from EIP-2537 and the transcript', () => {
    for (const { k, floor: f } of measure.floors) {
      const d = 2048
      expect(f.g2MsmGas).toBe(Math.floor((128 * 22500 * 524) / 1000))
      expect(f.pairingGas).toBe(32600 * 8 + 37700)
      expect(f.absorbedBytes).toBe(8 * (3 * d + k))
      expect(f.squeezedBytes).toBe(128 * (2 * (d + k) + 4))
      expect(f.permutations).toBe(Math.ceil(f.absorbedBytes / 136) + Math.ceil(f.squeezedBytes / 136))
      expect(f.hashingGas).toBe(f.permutations * 24 * 7 * 3)
      expect(f.totalGas).toBe(f.g2MsmGas + f.pairingGas + f.hashingGas)
      expect(f.totalGas).toBeGreaterThan(500_000)
    }
  })

  it('was charged the schedule by the testnet, plus the call', () => {
    for (const m of [pre.g2Msm128, pre.pairing8]) {
      expect(m.ok).toBe(true)
      expect(m.gas - m.schedule).toBe(110)
    }
    expect(pre.g2Msm128.gas + pre.pairing8.gas).toBeGreaterThan(500_000)
  })

  it('proved and verified on BLS12-381 at tfhe-rs dimension, and refused a changed ciphertext', () => {
    const on381 = measure.runs.filter((r) => r.curve === 'BLS12-381')
    expect(on381.length).toBe(4)
    for (const r of measure.runs) {
      expect(r.d).toBe(2048)
      expect(r.verified).toBe(true)
      expect(r.tamperedRefused).toBe(true)
    }
    expect(on381.find((r) => r.load === 'proof')?.evmProofBytes).toBe(2304)
  })
})
