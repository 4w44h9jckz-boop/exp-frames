import { describe, expect, it } from 'vitest'
import { instructions, metadataTrailer, prScan, reachable, sealedScan } from './egress.js'

describe('egress scans', () => {
  it('skips PUSH immediates', () => {
    // PUSH2 0xf1f1, STOP: the CALL bytes are data.
    expect(instructions(Uint8Array.from([0x61, 0xf1, 0xf1, 0x00])).map((i) => i.op)).toEqual([0x61, 0x00])
    expect(prScan('0x61f1f100').sealed).toBe(true)
  })

  it('the PR scan rejects CALL anywhere, reachable or not', () => {
    expect(prScan('0x00f1').findings).toEqual([{ pc: 1, what: 'CALL' }])
  })

  it('the amended scan ignores bytes no execution reaches, until the next JUMPDEST', () => {
    // STOP, CALL (dead), JUMPDEST, CALL (live)
    const code = Uint8Array.from([0x00, 0xf1, 0x5b, 0xf1])
    expect(reachable(instructions(code))).toEqual([true, false, true, true])
    expect(sealedScan(code).findings).toEqual([{ pc: 3, what: 'CALL' }])
    expect(sealedScan('0x00f1').sealed).toBe(true)
  })

  it('accepts only APPROVE with a constant PAYMENT scope', () => {
    expect(sealedScan('0x60015f5faa').sealed).toBe(true) // PUSH1 1, PUSH0, PUSH0, APPROVE
    expect(sealedScan('0x60035f5faa').sealed).toBe(false) // scope 3
    expect(sealedScan('0x5f80aa').sealed).toBe(false) // scope from the stack
    // A JUMPDEST between the PUSH1 and APPROVE would let a jump arrive with another scope.
    expect(sealedScan('0x60015b5f5faa').sealed).toBe(false)
    // The PR scan does not look at APPROVE at all.
    expect(prScan('0x5f80aa').sealed).toBe(true)
  })

  it('no code and a delegation indicator are keyed accounts', () => {
    expect(prScan('0x').sealed).toBe(true)
    expect(sealedScan('0x').sealed).toBe(false)
    expect(sealedScan(`0xef0100${'11'.repeat(20)}`).sealed).toBe(false)
  })

  it('builds the solc metadata trailer with its length suffix', () => {
    const t = metadataTrailer(new Uint8Array(32))
    expect(t.length).toBe(0x33 + 2)
    expect([t[t.length - 2], t[t.length - 1]]).toEqual([0x00, 0x33])
  })
})
