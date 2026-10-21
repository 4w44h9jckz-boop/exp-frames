// Experiment 46's run (2026-10-21), checked from public data alone: no key, share, phrase or
// word of the seed is here.
// - Each commitment the owner set is keccak256(salt || 1 || address(R)) of the start that later
//   revealed it, and each start was signed by that R.
// - The old set's start, refused after the rotation, revealed the commitment that had been
//   replaced.
// - Every envelope is the same size, carries the locator of its R, and was posted by a fresh
//   sender its ticket paid for.
// - The guardians' posts carry nothing but an announcement of a 33-byte share.
import { readFileSync } from 'node:fs'
import { type Address, type Hex, concatHex, decodeFunctionData, getAddress, keccak256, parseAbi, recoverAddress, serializeSignature, size, slice, toHex } from 'viem'
import { describe, expect, it } from 'vitest'
import { type FrameTxJson, Mode, frameSigHash, frameTxFromJson, frameTxHash, parseFrameTx } from '../../src/frametx/index.js'

type Step = { what: string; hash: Hex; raw: Hex; payer: Address }
const record = JSON.parse(readFileSync(new URL('./record.json', import.meta.url), 'utf8')) as {
  setup: {
    public: { account: Address; paymaster: Address }
    owner0: Address
    recoveryKeys: Address[]
    commitments: Hex[]
    steps: Step[]
    refusals: { what: string; raw: Hex; simulation: { valid: boolean }; sent: { error?: string } }[]
  }
  recover: { owner1: Address; recoveryKeys: Address[]; commitment2: Hex; steps: Step[] }
  firstAttempt: Hex[]
}
const fixture = (hash: Hex) =>
  JSON.parse(readFileSync(new URL(`../../test/fixtures/chain/${hash}.json`, import.meta.url), 'utf8')) as {
    tx: FrameTxJson
    receipt: { payer: Address; status: Hex; frameReceipts: { status: Hex }[] }
  }
const boardAbi = parseAbi(['function post(bytes message)'])
const DOMAIN = toHex('kohaku-seed-envelope-v1')
const SHARE_TAG = toHex('kohaku-guardian-share-v1')
const all = [...record.setup.steps, ...record.recover.steps]
const step = (part: string) => all.find((s) => s.what.includes(part))!
const account = getAddress(record.setup.public.account)
const [r0, r1] = record.setup.recoveryKeys.map((a) => getAddress(a))
const r2 = getAddress(record.recover.recoveryKeys[1])
const posts = (s: Step) =>
  parseFrameTx(s.raw)
    .frames.filter((f) => f.mode === Mode.SENDER)
    .map((f) => decodeFunctionData({ abi: boardAbi, data: f.data }).args[0] as Hex)

/** The start: VERIFY data salt || 1 || address(R), signed by R, and the new owner it names. */
async function start(raw: Hex) {
  const tx = parseFrameTx(raw)
  const verify = tx.frames.find((f) => f.mode === Mode.VERIFY)!
  const sig = tx.signatures[0].signature
  const signer = await recoverAddress({
    hash: frameSigHash(tx),
    signature: serializeSignature({ r: slice(sig, 1, 33), s: slice(sig, 33, 65), yParity: Number(slice(sig, 0, 1)) }),
  })
  const op = tx.frames.find((f) => f.mode === Mode.SENDER)!.data
  return {
    sender: getAddress(tx.sender),
    reveal: verify.data,
    commitment: keccak256(verify.data),
    revealed: getAddress(slice(verify.data, 33, 53)),
    signer: getAddress(signer),
    op: slice(op, 0, 1),
    next: getAddress(slice(op, 1, 21)),
  }
}

describe("experiment 46's run (2026-10-21)", () => {
  it('re-encodes every mined transaction to its hash, every frame succeeding', () => {
    expect(all).toHaveLength(15)
    for (const s of all) {
      const f = fixture(s.hash)
      expect(frameTxHash(frameTxFromJson(f.tx)), s.what).toBe(s.hash)
      expect(frameTxHash(parseFrameTx(s.raw)), s.what).toBe(s.hash)
      expect(f.receipt.frameReceipts.every((r) => r.status === '0x1'), s.what).toBe(true)
    }
    for (const h of record.firstAttempt) expect(frameTxHash(frameTxFromJson(fixture(h).tx))).toBe(h)
  })

  it('has the owner set each commitment, the first into a fresh slot', () => {
    const sets = [step('commits the account to R0'), step('rotates to R1'), step('rotates to R2')]
    const commitments = sets.map((s) => {
      const op = parseFrameTx(s.raw).frames.find((f) => f.mode === Mode.SENDER)!
      expect(getAddress(op.target!)).toBe(account)
      expect(slice(op.data, 0, 1)).toBe('0x04')
      return slice(op.data, 1, 33)
    })
    expect(commitments).toEqual([...record.setup.commitments, record.recover.commitment2])
    expect(parseFrameTx(sets[0].raw).frames[1].limits.state).toBe(97_920n)
    expect(new Set(commitments).size).toBe(3)
  })

  it("reveals R0 in the hostile start and R1 in the recovery's, each signed by its R", async () => {
    const hostile = await start(step('guardians 2 and 3 start').raw)
    expect(hostile.sender).toBe(account)
    expect(hostile.commitment).toBe(record.setup.commitments[0])
    expect([hostile.revealed, hostile.signer]).toEqual([r0, r0])
    expect(size(hostile.reveal)).toBe(53)
    const recovery = await start(step('R1 starts a recovery').raw)
    expect(recovery.commitment).toBe(record.setup.commitments[1])
    expect([recovery.revealed, recovery.signer]).toEqual([r1, r1])
    expect([recovery.op, recovery.next]).toEqual(['0x01', getAddress(record.recover.owner1)])
    // The owner's cancel and owner 1's finish.
    expect(slice(parseFrameTx(step('owner cancels').raw).frames[1].data, 0, 1)).toBe('0x03')
    expect(parseFrameTx(step('owner 1 finishes').raw).frames[1].data).toBe('0x02')
  })

  it("refused the old set's start, which revealed the replaced commitment", async () => {
    const old = record.setup.refusals.find((r) => r.what.includes('old set'))!
    expect(old.simulation.valid).toBe(false)
    expect(old.sent.error).toContain('validation prefix frame reverted')
    const s = await start(old.raw)
    expect(s.commitment).toBe(record.setup.commitments[0])
    expect(s.signer).toBe(r0)
    const finish = record.setup.refusals.find((r) => r.what.includes('finish'))!
    expect(finish.simulation.valid).toBe(false)
  })

  it('posts every envelope at one size, under its R, from a fresh sender its ticket paid for', () => {
    const envelopes = [step('envelope under R0'), step('envelope under R1'), step('envelope under R2')]
    for (const [i, r] of [r0, r1, r2].entries()) {
      const [m] = posts(envelopes[i])
      expect(size(m)).toBe(1 + 32 + 12 + 216 + 16)
      expect(slice(m, 0, 1)).toBe('0x20')
      expect(slice(m, 1, 33)).toBe(keccak256(concatHex([DOMAIN, r])))
      const f = fixture(envelopes[i].hash)
      expect(getAddress(f.receipt.payer)).toBe(getAddress(record.setup.public.paymaster))
      expect(frameTxFromJson(f.tx).nonceSeq).toBe(0n)
    }
  })

  it("posts each guardian's share as an announcement of 33 bytes and nothing else", () => {
    for (const g of ['guardian 4', 'guardian 6']) {
      const [m] = posts(step(g))
      expect(slice(m, 0, size(SHARE_TAG))).toBe(SHARE_TAG)
      // version, view tag, ephemeral key (33), AES-GCM of 33 bytes, tag (16).
      expect(size(m) - size(SHARE_TAG)).toBe(2 + 33 + 33 + 16)
    }
  })
})
