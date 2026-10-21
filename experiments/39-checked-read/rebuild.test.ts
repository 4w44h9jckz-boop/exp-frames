// Experiment 39's run, made by kohaku-rs's `kohaku-checked-read`, read back here: the purchase,
// the read tickets, the header the reader trusted, the reads checked against it, the two lies it
// refused, and the published evidence judged again by `judge.ts`, a third party written apart
// from the Rust, holding the evidence, the header and the target's branch from the chain.
import { readFileSync } from 'node:fs'
import { bls12_381 as bls } from '@noble/curves/bls12-381'
import { type Address, type Hex, concatHex, getAddress, hexToBigInt, keccak256, slice, toHex } from 'viem'
import { describe, expect, it } from 'vitest'
import { type FrameTxJson, Mode, frameTxFromJson, frameTxHash } from '../../src/frametx/index.js'
import { DST, g1, g2, paymasterAddress, paymasterInitcode, unionUnique, verifies } from '../36-blind-tickets/tickets.js'
import { type Evidence, type Manifest, N, account, chacha20, header, isValue, judge, words } from './judge.js'

const READ_NAMESPACE = 'kohaku-read-ticket-v1'
const record = JSON.parse(readFileSync(new URL('./record.json', import.meta.url), 'utf8')) as {
  shop: Address
  denomination: Hex
  bought: { hash: Hex; block: number; count: number }
  committee: { issuers: number; quorum: number; key: Hex }
  issuance: { issuer: number; blinded: Hex }[]
  tickets: { server: Hex; serial: Hex; signature: Hex }[]
  snapshot: number
  header: { number: number; hash: Hex; stateRoot: Hex; rlp: Hex }
  entries: number
  depths: number[]
  layouts: { split: number; record: number; rows: number; cols: number; answerBytes: number; hintBytes: number; topBytes: number; topNodes: number }[]
  split: number
  servers: { name: string; manifest: Manifest }[]
  once: Record<'split' | 'whole', { hintBytes: number; topBytes: number }>
  reads: { server: string; method?: string; address: Address; value?: Hex; node?: Hex; path?: string; outcome?: string }[]
  checks: { server: string; address: Address; outcome: string; detail: string }[]
  refusals: { what: string; answer: string }[]
  thirdParty: { verdict: string; evidenceBytes: number; chainProof: { address: Address; block: number; accountProof: Hex[] } }
  thirdPartyForged: string
  serverLogs: { serial: Hex; refused?: string; answerMicros?: number; signMicros?: number; ticketCheckMicros: number; answerBytes?: number; bytesScanned?: number; queryBytes: number }[][]
  cost: { ticketCheckNanos: number; signNanos: number; readerWalkNanos: number; answers: { layout: string; tableBytes: number; answerBytes: number; answerNanos: number }[] }
}
const evidence = JSON.parse(readFileSync(new URL('./evidence.json', import.meta.url), 'utf8')) as Evidence
const fixture = (hash: Hex) =>
  JSON.parse(readFileSync(new URL(`../../test/fixtures/chain/${hash}.json`, import.meta.url), 'utf8')) as { tx: FrameTxJson }
const key = g2(record.committee.key)
const readPoint = (server: Hex, serial: Hex) =>
  bls.G1.hashToCurve(unionUnique(READ_NAMESPACE, concatHex([server, serial])), { DST }) as unknown as ReturnType<typeof g1>
const TARGET = getAddress('0x35be31B0dE16d67106F5cf0FA113dB6617B51FAf')
const chain = record.thirdParty.chainProof.accountProof
const [honest, whole, liar, forger] = record.servers

describe('experiment 39, a private read checked against a header and signed', () => {
  it("bought eight tickets from experiment 36's paymaster, under this committee's key", () => {
    const tx = frameTxFromJson(fixture(record.bought.hash).tx)
    expect(frameTxHash(tx)).toBe(record.bought.hash)
    const [deploy, buy] = tx.frames.filter((f) => f.mode === Mode.SENDER)
    const initcode = slice(deploy.data, 32)
    expect(initcode).toBe(paymasterInitcode(key, hexToBigInt(record.denomination)))
    expect(paymasterAddress(initcode, slice(deploy.data, 0, 32))).toBe(getAddress(record.shop))
    expect(buy.value).toBe(8n * hexToBigInt(record.denomination))
  })

  it('issued every read ticket for the server it names, each server named by its signing address', () => {
    expect(record.issuance.length).toBe(8 * record.committee.quorum)
    const plan = [0, 0, 0, 0, 1, 2, 3].map((i) => record.servers[i].manifest.server)
    expect(record.tickets.map((t) => t.server)).toEqual([...plan, `0x${'00'.repeat(32)}`])
    for (const s of record.servers) expect(s.manifest.server).toBe(toHex(BigInt(s.manifest.signer), { size: 32 }))
    for (const t of record.tickets) {
      expect(verifies(readPoint(t.server, t.serial), g1(t.signature), key)).toBe(true)
      expect(verifies(readPoint(honest.manifest.server === t.server ? whole.manifest.server : honest.manifest.server, t.serial), g1(t.signature), key)).toBe(false)
    }
  })

  it("trusted a header that hashes to its block's hash, and every server's snapshot is that header's", () => {
    const h = header(record.header.rlp)
    expect(h.hash).toBe(record.header.hash)
    expect(h.number).toBe(record.snapshot)
    expect(h.stateRoot).toBe(record.header.stateRoot)
    for (const s of record.servers) {
      expect(s.manifest.block).toBe(record.snapshot)
      expect(s.manifest.stateRoot).toBe(h.stateRoot)
    }
  })

  it('read the balance and nonce through the router, as the chain holds them under that header', () => {
    const st = account(record.header.stateRoot, TARGET, chain)
    expect(st).not.toBeNull()
    const [balance, nonce, absent] = record.reads
    expect(balance.path).toBe('Pir')
    expect(balance.value).toBe(balance.node)
    expect(hexToBigInt(balance.value as Hex)).toBe(st?.balance)
    expect(hexToBigInt(nonce.value as Hex)).toBe(st?.nonce)
    expect(absent.outcome).toContain('unanswered')
    // The whole-branch server's record, proven.
    expect(record.checks[0]).toMatchObject({ server: whole.name, outcome: 'proven' })
    expect(st && isValue(st, record.checks[0].detail as Hex)).toBe(true)
  })

  it('refused both lies', () => {
    expect(record.checks[1]).toMatchObject({ server: liar.name, outcome: 'refused', detail: 'the branch proves another account' })
    expect(record.checks[2]).toMatchObject({ server: forger.name, outcome: 'refused' })
    expect(record.checks[2].detail).toContain("does not reach the header's state root")
  })

  it("has the third party find the liar's signed answer wrong, here as in Rust", async () => {
    expect(evidence.manifest).toEqual(liar.manifest)
    const v = await judge(evidence, record.header.rlp, chain)
    expect(v.wrong).toBe(true)
    if (!v.wrong) return
    expect(v.address).toBe(TARGET)
    expect(v.signedBalance).toBe(v.chain!.balance + 10n ** 18n)
    expect(record.thirdParty.verdict).toContain(`signed balance ${v.signedBalance}`)
    expect(record.thirdPartyForged).toContain(`signed balance ${v.signedBalance}`)
  })

  it('dismisses the evidence if anything in it is changed', async () => {
    const changed = (f: (e: Evidence) => void) => {
      const e = structuredClone(evidence)
      f(e)
      return judge(e, record.header.rlp, chain)
    }
    await expect(changed((e) => (e.claimed = concatHex([TARGET, slice(record.checks[0].detail as Hex, 0, 40)])))).rejects.toThrow('not what is claimed')
    await expect(changed((e) => (e.hintRows[7] = `0x${'01'.repeat(4 * N)}`))).rejects.toThrow('not under the root')
    await expect(changed((e) => (e.answer = `0x${(e.answer[2] === '0' ? '1' : '0')}${e.answer.slice(3)}` as Hex))).rejects.toThrow("not the server's signature")
    await expect(changed((e) => (e.manifest.block += 1))).rejects.toThrow()
  })

  it("opens the query: the evidence names the bucket the reader read, and the query is that bucket's", () => {
    const m = evidence.manifest
    const a = chacha20(m.seed, m.cols * N)
    const s = words(evidence.secret)
    const q = words(evidence.query)
    const off = (c: number) => {
      let acc = 0
      for (let i = 0; i < N; i++) acc = (acc + Math.imul(a[c * N + i], s[i])) | 0
      return ((q[c] - (acc >>> 0)) >>> 0) | 0
    }
    for (let c = 0; c < m.cols; c++) expect(Math.abs(off(c) - (c === evidence.column ? 1 << 24 : 0)) < 64).toBe(true)
  })

  it("computes the public matrix as kohaku-rs's vector pins it", () => {
    const w = chacha20(`0x${'07'.repeat(32)}`, 40)
    expect([w[0], w[1], w[15], w[16], w[39]]).toEqual([2022834420, 1106684503, 1809837684, 204047415, 934711965])
  })

  it('has the sizes of each layout: a record per slot, the answer a word per row, the hint 1024 words per row', () => {
    expect(record.layouts.map((l) => l.split)).toEqual(record.layouts.map((_, i) => i))
    for (const l of record.layouts) {
      expect(l.rows).toBe(8 * l.record)
      expect(l.answerBytes).toBe(4 * l.rows)
      expect(l.hintBytes).toBe(4 * N * l.rows)
    }
    const byOnce = [...record.layouts].sort((x, y) => x.hintBytes + x.topBytes - (y.hintBytes + y.topBytes))
    expect(byOnce[0].split).toBe(record.split)
    expect(record.once.split).toEqual({ hintBytes: record.layouts[record.split].hintBytes, topBytes: record.layouts[record.split].topBytes })
    expect(record.once.whole).toEqual({ hintBytes: record.layouts[0].hintBytes, topBytes: 0 })
  })

  it('added less server time per read than the ticket check, in the medians', () => {
    const [bare, split, wholeBranch] = record.cost.answers
    for (const l of [split, wholeBranch]) expect(l.answerNanos - bare.answerNanos + record.cost.signNanos).toBeLessThan(record.cost.ticketCheckNanos)
  })

  it('checked every ticket first, and logged nothing of what was read', () => {
    const log = record.serverLogs[0]
    expect(log.slice(3).map((e) => e.refused)).toEqual(['a spent ticket', 'no ticket for this server', 'no ticket for this server'])
    for (const e of log.slice(3)) expect(e.answerMicros).toBeUndefined()
    const seen = JSON.stringify(record.serverLogs).toLowerCase()
    expect(seen).not.toContain(TARGET.slice(2).toLowerCase())
    expect(keccak256(record.header.rlp)).toBe(record.header.hash)
  })
})
