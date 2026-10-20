// Experiment 37's run, made by kohaku-rs's `kohaku-ticket-read`, read back here: the shop is
// experiment 36's paymaster under this committee's key, every read ticket verifies with noble's
// BLS12-381 for the server it names and no other, and the server's log holds what it saw and
// nothing else.
import { readFileSync } from 'node:fs'
import { bls12_381 as bls } from '@noble/curves/bls12-381'
import { type Address, type Hex, concatHex, getAddress, hexToBigInt, slice } from 'viem'
import { describe, expect, it } from 'vitest'
import { type FrameTxJson, Mode, frameTxFromJson, frameTxHash } from '../../src/frametx/index.js'
import { DST, g1, g2, paymasterAddress, paymasterInitcode, unionUnique, verifies } from '../36-blind-tickets/tickets.js'

const READ_NAMESPACE = 'kohaku-read-ticket-v1'
const record = JSON.parse(readFileSync(new URL('./record.json', import.meta.url), 'utf8')) as {
  shop: Address
  denomination: Hex
  bought: { hash: Hex; block: Hex; count: number }
  committee: { issuers: number; quorum: number; key: Hex }
  issuance: { issuer: number; blinded: Hex }[]
  tickets: { server: Hex; serial: Hex; signature: Hex }[]
  snapshot: number
  table: { entries: number; rows: number; cols: number; capacity: number; bytes: number }
  manifest: { server: Hex; key: Hex; rows: number; cols: number; capacity: number; record: number }
  hintBytes: number
  queryBytes: number
  answerBytes: number
  reads: { method: string; address: Address; inTable: boolean; value: Hex; path: string; node: Hex }[]
  refusals: { what: string; answer: string }[]
  serverLog: { serial: Hex; ticketCheckMicros: number; refused?: string; answerMicros?: number; bytesScanned?: number; queryBytes: number; answerBytes?: number }[]
  cost: { ticketCheckNanos: number; answerNanos: { table: number; tableBytes: number; large: number; largeBytes: number }; bytesPerSecond: number }
}
const fixture = (hash: Hex) =>
  JSON.parse(readFileSync(new URL(`../../test/fixtures/chain/${hash}.json`, import.meta.url), 'utf8')) as { tx: FrameTxJson }
const key = g2(record.committee.key)

/** A read ticket's point: `server || serial` under the read namespace, hashed to G1. */
const readPoint = (server: Hex, serial: Hex) =>
  bls.G1.hashToCurve(unionUnique(READ_NAMESPACE, concatHex([server, serial])), { DST }) as unknown as ReturnType<typeof g1>

describe('experiment 37, a private read paid with a ticket', () => {
  it("bought four tickets from experiment 36's paymaster, under this committee's key", () => {
    const tx = frameTxFromJson(fixture(record.bought.hash).tx)
    expect(frameTxHash(tx)).toBe(record.bought.hash)
    const [deploy, buy] = tx.frames.filter((f) => f.mode === Mode.SENDER)
    const initcode = slice(deploy.data, 32)
    expect(initcode).toBe(paymasterInitcode(key, hexToBigInt(record.denomination)))
    expect(paymasterAddress(initcode, slice(deploy.data, 0, 32))).toBe(getAddress(record.shop))
    expect(buy.target).toBe(getAddress(record.shop))
    expect(buy.value).toBe(4n * hexToBigInt(record.denomination))
  })

  it('issued four read tickets, each through three of the four issuers', () => {
    expect(record.issuance.length).toBe(4 * record.committee.quorum)
    expect(new Set(record.issuance.map((i) => i.blinded)).size).toBe(4)
  })

  it('verifies every read ticket for the server it names, and for no other', () => {
    const [a, b, c, other] = record.tickets
    for (const t of [a, b, c]) expect(t.server).toBe(record.manifest.server)
    expect(other.server).toBe(`0x${'00'.repeat(32)}`)
    for (const t of record.tickets) {
      expect(verifies(readPoint(t.server, t.serial), g1(t.signature), key)).toBe(true)
      const elsewhere = t.server === record.manifest.server ? other.server : record.manifest.server
      expect(verifies(readPoint(elsewhere, t.serial), g1(t.signature), key)).toBe(false)
    }
    // No blinded point the issuers saw is a ticket's point.
    for (const t of record.tickets) for (const i of record.issuance) expect(g1(i.blinded).equals(readPoint(t.server, t.serial))).toBe(false)
  })

  it("answered three reads by PIR, as the node answered at the snapshot", () => {
    expect(record.reads.map((r) => r.method)).toEqual(['eth_getBalance', 'eth_getTransactionCount', 'eth_getBalance'])
    for (const r of record.reads) {
      expect(r.path).toBe('Pir')
      expect(r.value).toBe(r.node)
    }
    expect(record.reads[2].inTable).toBe(false)
    expect(record.reads[2].value).toBe('0x0')
  })

  it('checked every ticket before any work, and did the work only for unspent tickets of its own', () => {
    const [r1, r2, r3, spent, other, junk] = record.serverLog
    for (const [entry, t] of [[r1, record.tickets[0]], [r2, record.tickets[1]], [r3, record.tickets[2]]] as const) {
      expect(entry.serial).toBe(t.serial)
      expect(entry.refused).toBeUndefined()
      expect(entry.bytesScanned).toBe(record.table.bytes)
      expect(entry.answerBytes).toBe(record.answerBytes)
    }
    expect(spent.serial).toBe(record.tickets[0].serial)
    expect(spent.refused).toBe('a spent ticket')
    expect(other.serial).toBe(record.tickets[3].serial)
    expect(other.refused).toBe('no ticket for this server')
    expect(junk.refused).toBe('no ticket for this server')
    for (const e of [spent, other, junk]) expect(e.answerMicros).toBeUndefined()
    for (const e of record.serverLog) expect(e.queryBytes).toBe(record.queryBytes)
  })

  it("logged nothing of the reader's: no address it read", () => {
    const seen = JSON.stringify(record.serverLog).toLowerCase()
    for (const r of record.reads) expect(seen).not.toContain(r.address.slice(2).toLowerCase())
  })

  it('has the sizes of its table: the query a word per bucket, the answer a word per row, the hint 1024 words per row', () => {
    expect(record.table.rows).toBe(record.table.capacity * record.manifest.record)
    expect(record.table.bytes).toBe(record.table.rows * record.table.cols)
    expect(record.queryBytes).toBe(4 * record.table.cols)
    expect(record.answerBytes).toBe(4 * record.table.rows)
    expect(record.hintBytes).toBe(4 * 1024 * record.table.rows)
  })
})
