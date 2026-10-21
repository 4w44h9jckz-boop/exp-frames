// Experiment 45, checked offline. The derivation is computed again here, independently of
// kohaku-rs, from a public mnemonic. The run's own seed is not published, so its records are
// checked from public data alone:
// - every mined transaction re-encodes to its hash (and the shared suite checks its gas);
// - each ticket's request and the committee's blinded answer, as posted, satisfy the
//   committee's key, and the issuers saw those requests and nothing else;
// - each spend made after the rebuild is what the rebuild said: the pool paid a withdrawal, the
//   paymaster paid a ticket that verifies under the committee's key, and the account sent;
// - no equation an observer can check tells the request of the spent ticket from the other.
import { readFileSync } from 'node:fs'
import { type Address, type Hex, decodeFunctionData, getAddress, parseAbi, slice } from 'viem'
import { describe, expect, it } from 'vitest'
import { type FrameTxJson, Mode, frameTxFromJson, frameTxHash, parseFrameTx } from '../../src/frametx/index.js'
import { g1, g2, payFrame, readPayData, ticketMessage, ticketPoint, verifies } from '../36-blind-tickets/tickets.js'
import { blinding, custody, key, owner, secpAddress, seedOf, viewPublic, word } from './derive.js'

const vector = JSON.parse(readFileSync(new URL('./vector.json', import.meta.url), 'utf8'))
type Step = { what: string; hash: Hex; raw?: Hex; block: number; payer?: Address }
const record = JSON.parse(readFileSync(new URL('./record.json', import.meta.url), 'utf8')) as {
  build: {
    public: { chainId: number; pool: Address; paymaster: Address; committeeKey: Hex; board: Address }
    owner0: Address
    account0: Address
    epoch: number
    steps: Step[]
    issuers: { index: number; saw: Hex[] }[]
    posted: { blinded: Hex; blindedAnswer: Hex }[]
  }
  restore: {
    found: Record<string, unknown>[]
    spends: (Step & { recipient?: { address: Address; received: Hex } })[]
    paths: { label: string; kind: string }[]
  }
}
const fixture = (hash: Hex) =>
  JSON.parse(readFileSync(new URL(`../../test/fixtures/chain/${hash}.json`, import.meta.url), 'utf8')) as {
    tx: FrameTxJson
    receipt: { payer: Address; status: Hex }
  }
const boardAbi = parseAbi(['function post(bytes message)'])
const key0 = g2(record.build.public.committeeKey)

describe('the derivation, from a public mnemonic, against kohaku-rs', () => {
  const seed = seedOf(vector.mnemonic)

  it('gives every K(label) kohaku-rs gives', () => {
    for (const [label, value] of Object.entries(vector.K)) expect(key(seed, label), label).toBe(value)
  })

  it('puts the owners on BIP-44, and the keys at the same addresses', () => {
    expect([owner(seed, 0), owner(seed, 1)].map((a) => a.toLowerCase())).toEqual(vector.owner)
    for (const [label, a] of Object.entries(vector.addresses)) expect(secpAddress(seed, label).toLowerCase(), label).toBe(a)
    expect(viewPublic(seed)).toBe(vector.view)
  })

  it('gives the same vault secrets and ticket blinding factor', () => {
    const c = custody(seed, getAddress(vector.custody.vault), 0)
    expect(word(c.nullifierSecret)).toBe(vector.custody.nullifierSecret)
    expect(word(c.secret)).toBe(vector.custody.secret)
    expect(word(blinding(seed, 0))).toBe(vector.ticketBlinding.scalar)
  })

  it('refuses a mnemonic whose checksum fails', () => {
    expect(() => seedOf(vector.mnemonic.replace(/art$/, 'zoo'))).toThrow()
  })
})

describe("experiment 45's run (2026-10-21)", () => {
  const all = [...record.build.steps, ...record.restore.spends]

  it('re-encodes every mined transaction to its hash', () => {
    expect(all).toHaveLength(10)
    for (const s of all) {
      const f = fixture(s.hash)
      expect(f.receipt.status, s.what).toBe('0x1')
      const tx = frameTxFromJson(f.tx)
      expect(frameTxHash(tx), s.what).toBe(s.hash)
      if (s.raw) expect(frameTxHash(parseFrameTx(s.raw)), s.what).toBe(s.hash)
    }
  })

  // The board post carrying ANSWER_TAG || epoch || B || x * B, twice.
  const post = record.build.steps.find((s) => s.what.includes('blinded answer'))!
  const posted = parseFrameTx(post.raw!)
    .frames.filter((f) => f.mode === Mode.SENDER)
    .map((f) => decodeFunctionData({ abi: boardAbi, data: f.data }).args[0] as Hex)
    .map((m) => ({ tag: slice(m, 0, 1), epoch: BigInt(slice(m, 1, 9)), blinded: slice(m, 9, 57), answer: slice(m, 57, 105) }))

  it("posts each request beside the committee's answer, which checks under its key", () => {
    expect(posted).toHaveLength(2)
    for (const [k, p] of posted.entries()) {
      expect(p.tag).toBe('0x10')
      expect(p.epoch).toBe(BigInt(record.build.epoch))
      expect(p.blinded).toBe(record.build.posted[k].blinded)
      // e(x * B, g2) = e(B, X): the answer is the committee's, on a point that says nothing.
      expect(verifies(g1(p.blinded), g1(p.answer), key0)).toBe(true)
    }
  })

  it('had each issuer see only the posted requests', () => {
    const blinded = new Set(posted.map((p) => p.blinded))
    for (const i of record.build.issuers) for (const b of i.saw) expect(blinded.has(b)).toBe(true)
    // Four issuers, a quorum of three: each request reached three.
    expect(record.build.issuers.flatMap((i) => i.saw)).toHaveLength(6)
  })

  const [withdrawal, ticketSpend, accountTx] = record.restore.spends

  it('withdrew the rebuilt pool note to a derived recipient, paid by the pool', () => {
    const f = fixture(withdrawal.hash)
    expect(getAddress(f.receipt.payer)).toBe(getAddress(record.build.public.pool))
    expect(frameTxFromJson(f.tx).signatures).toHaveLength(0)
    expect(BigInt(withdrawal.recipient!.received)).toBe(10n ** 15n - 10n ** 10n)
  })

  it('spent a rebuilt ticket from a fresh sender, paid by the paymaster', () => {
    const tx = frameTxFromJson(fixture(ticketSpend.hash).tx)
    expect(getAddress(fixture(ticketSpend.hash).receipt.payer)).toBe(getAddress(record.build.public.paymaster))
    const pay = readPayData(payFrame(tx).data)
    const point = ticketPoint(ticketMessage(tx, pay.epoch, pay.salt))
    expect(verifies(point, pay.signature, key0)).toBe(true)
    expect(pay.epoch).toBe(BigInt(record.build.epoch))
    // The equations anyone can check hold for both posted requests alike: e(x * B, g2) =
    // e(B, X) for each, and e(sigma, g2) = e(H(m), X) for the spend. Nothing pairs the spend
    // with one request rather than the other.
    for (const p of posted) expect(verifies(g1(p.blinded), g1(p.answer), key0)).toBe(true)
  })

  it('sent from the account with owner 0', () => {
    const tx = frameTxFromJson(fixture(accountTx.hash).tx)
    expect(getAddress(tx.sender)).toBe(getAddress(record.build.account0))
    expect(getAddress(fixture(accountTx.hash).receipt.payer)).toBe(getAddress(record.build.account0))
  })

  it('lists every derivation path', () => {
    expect(record.restore.paths.map((p) => p.label)).toContain('ticket/<k>/blinding')
    expect(record.restore.paths).toHaveLength(13)
  })
})
