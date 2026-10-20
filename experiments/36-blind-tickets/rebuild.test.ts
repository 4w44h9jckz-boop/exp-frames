// Experiment 36's run, made by kohaku-rs's `kohaku-frame-ticket` (Commonware's BLS12-381 for the
// issuers and the buyers), read back here with noble's: every mined spend rebuilt byte for byte
// from what a wallet decides, every ticket checked against the committee's key, every issuer's
// answer against its own share's key, and the issuers' pooled answers against the spends.
import { readFileSync } from 'node:fs'
import { bls12_381 as bls } from '@noble/curves/bls12-381'
import { type Address, type Hex, getAddress, hexToBigInt, slice } from 'viem'
import { describe, expect, it } from 'vitest'
import { type FrameTxJson, Mode, frameTxFromJson, frameTxHash, parseFrameTx } from '../../src/frametx/index.js'
import {
  compressed,
  g1,
  g2,
  g2Eip2537,
  payFrame,
  paymasterAddress,
  paymasterInitcode,
  readPayData,
  spendLayout,
  ticketMessage,
  ticketPoint,
  verifies,
} from './tickets.js'

type Mined = { hash: Hex; raw: Hex; block: Hex; buyer: number; payer: Address; payVerify: { gasUsed: Hex; stateGasUsed: Hex } }
const record = JSON.parse(readFileSync(new URL('./record.json', import.meta.url), 'utf8')) as {
  chainId: number
  paymaster: Address
  denomination: Hex
  epoch: number
  committee: { issuers: number; quorum: number; key: Hex; keyEip2537: Hex; partialKeys: Hex[] }
  setup: { hash: Hex; raw: Hex }
  secondBuy: { hash: Hex; raw: Hex }
  buyers: Address[]
  transcripts: { index: number; answers: { buyer: Address; blinded: Hex; answer: Hex }[] }[]
  spends: (Mined & { sender: Address; point: Hex; signature: Hex })[]
  atOnce: (Mined & { answer: { result?: Hex; error?: string }; resent: boolean })[]
  beyondBought: string
  refusals: { what: string; hash: Hex; raw: Hex; simulation: { valid: boolean; violation: string }; sent: { error?: string } }[]
}
const fixture = (hash: Hex) =>
  JSON.parse(readFileSync(new URL(`../../test/fixtures/chain/${hash}.json`, import.meta.url), 'utf8')) as {
    tx: FrameTxJson
    receipt: { blockNumber: Hex; payer: Address; status: Hex; frameReceipts: { status: Hex; gasUsed: Hex; stateGasUsed: Hex }[] }
  }
const key = g2(record.committee.key)
const mined = [...record.spends, ...record.atOnce]
const Fr = bls.fields.Fr

/** Interpolate at zero, as Commonware's `threshold::recover` does: participant i is evaluated at i + 1. */
function recover(answers: { index: number; answer: Hex }[]) {
  const xs = answers.map((a) => BigInt(a.index + 1))
  return answers.reduce((acc, a, i) => {
    const lambda = xs.reduce((l, xj, j) => (j === i ? l : Fr.mul(l, Fr.div(xj, Fr.sub(xj, xs[i])))), 1n)
    return acc.add(g1(a.answer).multiply(lambda))
  }, bls.G1.ProjectivePoint.ZERO)
}

describe('experiment 36, blind tickets', () => {
  it('deployed the paymaster from TicketPaymaster.yul with the committee key appended', () => {
    const setup = parseFrameTx(record.setup.raw)
    expect(frameTxHash(setup)).toBe(record.setup.hash)
    const deploy = setup.frames.find((f) => f.mode === Mode.SENDER)!
    const salt = slice(deploy.data, 0, 32)
    const initcode = slice(deploy.data, 32)
    expect(initcode).toBe(paymasterInitcode(key, hexToBigInt(record.denomination)))
    expect(paymasterAddress(initcode, salt)).toBe(getAddress(record.paymaster))
    expect(g2Eip2537(key)).toBe(record.committee.keyEip2537)
  })

  for (const s of mined) {
    it(`rebuilds ${s.hash.slice(0, 10)} from kohaku-rs, and its ticket verifies`, () => {
      const { tx: json, receipt } = fixture(s.hash)
      const tx = frameTxFromJson(json)
      expect(parseFrameTx(s.raw)).toEqual(tx)
      const data = payFrame(tx).data
      expect(frameTxHash(spendLayout({ tx, paymaster: record.paymaster, payData: data }))).toBe(s.hash)

      const ticket = readPayData(data)
      expect(ticket.epoch).toBe(BigInt(record.epoch))
      const point = ticketPoint(ticketMessage(tx, ticket.epoch, ticket.salt))
      expect(verifies(point, ticket.signature, key)).toBe(true)
      // Not for the same sender at its next nonce, nor under one issuer's key alone.
      const next = ticketPoint(ticketMessage({ ...tx, nonceSeq: 1n }, ticket.epoch, ticket.salt))
      expect(verifies(next, ticket.signature, key)).toBe(false)
      expect(verifies(point, ticket.signature, g2(record.committee.partialKeys[0]))).toBe(false)
      if ('point' in s) {
        expect(compressed(point)).toBe(s.point)
        expect(compressed(ticket.signature)).toBe(s.signature)
      }

      expect(receipt.status).toBe('0x1')
      expect(receipt.payer.toLowerCase()).toBe(record.paymaster.toLowerCase())
      expect(hexToBigInt(receipt.frameReceipts[1].gasUsed)).toBe(122_006n)
      expect(hexToBigInt(receipt.frameReceipts[1].stateGasUsed)).toBe(183_600n)
    })
  }

  it("checks every issuer's answer against its own share's key", () => {
    for (const { index, answers } of record.transcripts) {
      const share = g2(record.committee.partialKeys[index])
      for (const a of answers) expect(verifies(g1(a.blinded), g1(a.answer), share)).toBe(true)
    }
  })

  it('kept one list of requests: six blinded points, three answers each, three per buyer', () => {
    const byPoint = new Map<Hex, { index: number; answer: Hex; buyer: Address }[]>()
    for (const { index, answers } of record.transcripts)
      for (const a of answers) byPoint.set(a.blinded, [...(byPoint.get(a.blinded) ?? []), { index, answer: a.answer, buyer: a.buyer }])
    expect(byPoint.size).toBe(6)
    for (const answers of byPoint.values()) {
      expect(answers.length).toBe(record.committee.quorum)
      expect(new Set(answers.map((a) => a.buyer)).size).toBe(1)
    }
    for (const buyer of record.buyers)
      expect([...byPoint.values()].filter((a) => a[0].buyer.toLowerCase() === buyer.toLowerCase()).length).toBe(3)
    expect(record.beyondBought).toContain('has no ticket left to be issued')
  })

  it("matches none of the issuers' pooled answers to a spend", () => {
    const byPoint = new Map<Hex, { index: number; answer: Hex }[]>()
    for (const { index, answers } of record.transcripts)
      for (const a of answers) byPoint.set(a.blinded, [...(byPoint.get(a.blinded) ?? []), { index, answer: a.answer }])
    const onChain = mined.map((s) => readPayData(payFrame(parseFrameTx(s.raw)).data).signature)
    const points = record.spends.map((s) => g1(s.point))
    for (const [blinded, answers] of byPoint) {
      // Pooled, the issuers hold x * B: the committee's signature on a point no spend carries.
      const pooled = recover(answers)
      expect(verifies(g1(blinded), pooled, key)).toBe(true)
      for (const sig of onChain) expect(pooled.equals(sig)).toBe(false)
      for (const p of points) expect(g1(blinded).equals(p)).toBe(false)
    }
  })

  it('refused a second pending spend with the same paymaster until the first was mined', () => {
    const [first, second] = record.atOnce
    expect(first.answer.result).toBe(first.hash)
    expect(second.answer.error).toContain('Non-canonical paymaster already sponsors the maximum number of pending frame transactions')
    expect(second.resent).toBe(true)
    expect(hexToBigInt(second.block)).toBeGreaterThan(hexToBigInt(first.block))
    expect(first.buyer).not.toBe(second.buyer)
  })

  it('had the paymaster refuse three spends at its VERIFY', () => {
    expect(record.refusals.map((r) => r.what)).toEqual([
      'a signature that is no ticket',
      'a spent ticket, carried by another fresh sender',
      "a spent ticket, at its sender's next nonce",
    ])
    for (const r of record.refusals) {
      expect(frameTxHash(parseFrameTx(r.raw))).toBe(r.hash)
      expect(r.simulation.valid).toBe(false)
      expect(r.simulation.violation).toBe('validation prefix frame reverted')
      expect(r.sent.error).toContain('validation prefix frame reverted')
    }
    const [, other, again] = record.refusals.map((r) => parseFrameTx(r.raw))
    const spent = parseFrameTx(record.spends[0].raw)
    // The same ticket bytes, on another slot.
    expect(payFrame(other).data).toBe(payFrame(spent).data)
    expect(other.sender).not.toBe(spent.sender)
    expect(payFrame(again).data).toBe(payFrame(spent).data)
    expect(again.sender).toBe(spent.sender)
    expect(again.nonceSeq).toBe(1n)
  })
})
