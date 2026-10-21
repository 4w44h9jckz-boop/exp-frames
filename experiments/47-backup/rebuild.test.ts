// Experiment 47's run (2026-10-21), checked from public data and the run's two records: no key,
// share, phrase, word or plaintext is here, only each plaintext's SHA-256.
// - Every mined transaction re-encodes to its hash.
// - Each backup, as posted, is its locator, a nonce, whole 2,048-byte buckets and a tag, with
//   nothing else to tell what it is.
// - The fresh device reopened exactly what the lost one wrote: the same plaintexts, by hash.
// - What an observer has: two fresh senders at nonce 0, one paymaster whose only buyer is owner 0.
import { readFileSync } from 'node:fs'
import { type Address, type Hex, decodeFunctionData, getAddress, parseAbi, size, slice } from 'viem'
import { describe, expect, it } from 'vitest'
import { type FrameTxJson, Mode, frameTxFromJson, frameTxHash, parseFrameTx } from '../../src/frametx/index.js'

type Backup = { hash: Hex; raw: Hex; plaintextBytes: number; postedBytes: number; plaintextSha256: Hex; locator: Hex }
const record = JSON.parse(readFileSync(new URL('./record.json', import.meta.url), 'utf8')) as {
  write: { owner0: Address; ticketPaymaster: Address; steps: { what: string; hash: Hex; raw: Hex }[]; backups: Backup[] }
  reopen: {
    versions: { v: number; tx: Hex; plaintextBytes: number; plaintextSha256: Hex }[]
    checks: { what: string; ok: boolean }[]
    metadata: { v: number; sender: Address; senderNonceNow: number; payer: Address; payersBuyers: Address[]; postedBytes: number }[]
    leak: { leaked: string; opens: string }[]
  }
}
const fixture = (hash: Hex) =>
  JSON.parse(readFileSync(new URL(`../../test/fixtures/chain/${hash}.json`, import.meta.url), 'utf8')) as {
    tx: FrameTxJson
    receipt: { payer: Address }
  }
const boardAbi = parseAbi(['function post(bytes message)'])
const posted = (b: Backup) => {
  const f = parseFrameTx(b.raw).frames.find((x) => x.mode === Mode.SENDER)!
  return decodeFunctionData({ abi: boardAbi, data: f.data }).args[0] as Hex
}

describe("experiment 47's run (2026-10-21)", () => {
  it('re-encodes every mined transaction to its hash', () => {
    expect(record.write.steps).toHaveLength(4)
    for (const s of record.write.steps) {
      expect(frameTxHash(frameTxFromJson(fixture(s.hash).tx)), s.what).toBe(s.hash)
      expect(frameTxHash(parseFrameTx(s.raw)), s.what).toBe(s.hash)
    }
  })

  it('posts each version as its locator, a nonce, whole buckets and a tag, and nothing else', () => {
    for (const b of record.write.backups) {
      const m = posted(b)
      expect(size(m)).toBe(b.postedBytes)
      expect(slice(m, 0, 32)).toBe(b.locator)
      expect((size(m) - 32 - 12 - 16) % 2048).toBe(0)
    }
    const [v0, v1] = record.write.backups
    expect(v0.locator).not.toBe(v1.locator)
    // Version 0 carried one ticket more and crossed into a third bucket: the size class shows.
    expect([v0.postedBytes, v1.postedBytes]).toEqual([6204, 4156])
  })

  it('reopened exactly what was written, by hash, and checked it against the chain', () => {
    expect(record.reopen.versions.map((v) => [v.tx, v.plaintextSha256])).toEqual(
      record.write.backups.map((b) => [b.hash, b.plaintextSha256]),
    )
    expect(record.reopen.checks.length).toBe(7)
    expect(record.reopen.checks.every((c) => c.ok)).toBe(true)
  })

  it('shows an observer two fresh senders and a paymaster whose only buyer is owner 0', () => {
    for (const [i, m] of record.reopen.metadata.entries()) {
      const tx = frameTxFromJson(fixture(record.write.backups[i].hash).tx)
      expect(getAddress(tx.sender)).toBe(getAddress(m.sender))
      expect(tx.nonceSeq).toBe(0n)
      expect(m.senderNonceNow).toBe(1)
      expect(getAddress(fixture(record.write.backups[i].hash).receipt.payer)).toBe(getAddress(record.write.ticketPaymaster))
      expect(m.payersBuyers.map((a) => getAddress(a))).toEqual([getAddress(record.write.owner0)])
    }
    expect(record.reopen.metadata[0].sender).not.toBe(record.reopen.metadata[1].sender)
  })

  it("records that one version's key opens that version only, and an old set with the phrase opens both", () => {
    expect(record.reopen.leak[0].opens).toBe('version 0 only')
    expect(record.reopen.leak[2].opens).toContain('2 backup version(s)')
  })
})
