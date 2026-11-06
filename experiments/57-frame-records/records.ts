// Experiment 57: every case's records and frame facts, and each refused case against its valid twin.
//
// usage: npx tsx experiments/57-frame-records/records.ts
// writes results/records.json and results/comparison.md. Reads only files in this repository.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { Hex } from 'viem'
import { type FrameTxJson, frameTxFromJson, parseFrameTx } from '../../src/frametx/index.js'
import type { Eip8250 } from '../27-execution-digest/digest.js'
import { NOT_APPLICABLE, type Record_, recordsFor } from './convert.js'

const DIR = 'experiments/57-frame-records'
type Case = { id: string; source: string; verdict: string; note: string; out: ReturnType<typeof recordsFor> }
const cases: Case[] = []

// 1. Experiment 27's nineteen signed cases, EIP-8250 at f3079a0.
function casesFile(path: string) {
  const code = new Map<string, boolean>()
  const out: { name: string; expect: string; raw: Hex; note: string }[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const [kind, ...rest] = line.split(' ')
    if (kind === 'account') code.set(rest[0].toLowerCase(), rest[3] !== '0x')
    if (kind === 'case') {
      const [name, expect, raw] = rest
      out.push({ name, expect, raw: raw as Hex, note: line.split(' # ')[1] ?? '' })
    }
  }
  return { code, out }
}
const f3079 = casesFile('experiments/27-execution-digest/erc-assets/cases-eip8250-f3079a0.txt')
for (const c of f3079.out) {
  const tx = parseFrameTx(c.raw)
  cases.push({
    id: `27/${c.name}`,
    source: 'experiment 27, cases-eip8250-f3079a0.txt',
    verdict: c.expect,
    note: c.note,
    out: recordsFor(tx, { rules: 'f3079a0', senderHasCode: f3079.code.get(tx.sender.toLowerCase()), label: `27/${c.name}` }),
  })
}

// 2. Experiment 28's twelve batches, as mined (test/fixtures/chain).
const batches = readFileSync('experiments/28-wallet-send-calls/rebuild.test.ts', 'utf8').matchAll(/\{ hash: '(0x[0-9a-f]{64})', by: '([^']+)' \}/g)
for (const [, hash, by] of batches) {
  const { tx } = JSON.parse(readFileSync(`test/fixtures/chain/${hash}.json`, 'utf8')) as { tx: FrameTxJson }
  cases.push({ id: `28/${by}`, source: 'experiment 28, mined on the Hegota testnet', verdict: 'mined', note: '', out: recordsFor(frameTxFromJson(tx), { hash: hash as Hex, rules: 'f3079a0', senderHasCode: false, label: `28/${by}` }) })
}

// 3. W3's pair: experiment 34's two withdrawals of one pool, mined in one block of a local chain.
const w3 = JSON.parse(readFileSync('experiments/34-concurrent-withdrawals/record.json', 'utf8')) as { pair: { hash: Hex; raw: Hex; block: Hex }[] }
for (const [k, p] of w3.pair.entries()) {
  cases.push({ id: `34/withdrawal-${k + 1}`, source: 'experiment 34, record.json', verdict: `mined, block ${BigInt(p.block)}`, note: 'one of two withdrawals experiment 34 found linkable by shape', out: recordsFor(parseFrameTx(p.raw), { hash: p.hash, senderHasCode: true, label: `34/withdrawal-${k + 1}` }) })
}

// 4. The EIP-8250 replay pair: one byte string, read under each revision.
const master = casesFile('experiments/27-execution-digest/erc-assets/cases.txt')
const keyZero = master.out.find((c) => c.name === 'key-zero')
if (!keyZero) throw new Error('no key-zero case')
for (const rules of ['f3079a0', 'master'] as Eip8250[]) {
  const tx = parseFrameTx(keyZero.raw)
  cases.push({
    id: `8250/key-zero@${rules}`,
    source: 'experiment 27, cases.txt (key-zero)',
    verdict: rules === 'f3079a0' ? 'nonce_keys [0] selects the legacy nonce' : 'nonce_keys [0] is an ordinary key',
    note: 'the same bytes under two EIP-8250 revisions',
    out: recordsFor(tx, { rules, senderHasCode: master.code.get(tx.sender.toLowerCase()), label: `8250/key-zero@${rules}` }),
  })
}

// ---- refused cases against their twin ----

const IDS = new Set(['tx_hash', 'request_id', 'tx_id'])
// Records are matched by type and order, so an inserted frame does not shift the match.
function byKey(rs: Record_[]) {
  const seen = new Map<string, number>()
  return new Map(
    rs.map((r) => {
      const n = seen.get(r.type) ?? 0
      seen.set(r.type, n + 1)
      return [`${r.type}#${n}`, r] as const
    }),
  )
}
function diff(a: Case, b: Case) {
  const out: string[] = []
  const ra = byKey(a.out.records)
  const rb = byKey(b.out.records)
  for (const k of new Set([...ra.keys(), ...rb.keys()])) {
    const x = ra.get(k)
    const y = rb.get(k)
    if (!x || !y) {
      out.push(`${k}: only in ${x ? a.id : b.id}`)
      continue
    }
    for (const f of new Set([...Object.keys(x.fields), ...Object.keys(y.fields)])) {
      if (IDS.has(f)) continue
      const vx = JSON.stringify(x.fields[f])
      const vy = JSON.stringify(y.fields[f])
      if (vx !== vy) out.push(`${k}.${f}${f === 'typed_data' ? ' (a different E)' : vx === undefined ? ' (not in this case\'s record)' : `: ${vy} -> ${vx}`}`)
    }
  }
  return out
}

const get = (id: string) => {
  const c = cases.find((x) => x.id === id)
  if (!c) throw new Error(`no case ${id}`)
  return c
}
/** Each refused case's valid twin: the case it was cut from. `self-paying` has none. */
const TWIN: Record<string, string | null> = {
  '27/self-paying': null,
  '27/inserted-default': '27/sponsored-transfer',
  '27/appended-default': '27/sponsored-transfer',
  '27/state-limit-lowered': '27/sponsored-transfer',
  '27/transfer-retargeted': '27/sponsored-transfer',
  '27/payer-is-sender': '27/sponsored-transfer',
  '27/other-account': '27/sponsored-transfer',
  '27/blob-swapped': '27/blobs',
}
const lines = [
  '# Experiment 57: each refused case of experiment 27 against its valid twin',
  '',
  'Generated by `records.ts`. Identifiers (`tx_hash`, `request_id`, `tx_id`) are left out of the comparison.',
  '',
  '- **At signing**: what the user is asked to sign. When entry 0 of a refused case is its twin\'s signature, the user signed the twin, and a check before signing sees the twin\'s records.',
  '- **In transit**: the records of the transaction as it travels, as a node, a co-signer or the account would see it.',
  '',
  '| Refused case | Twin | At signing | In transit: fields a check reads that differ | What the frame facts show |',
  '|---|---|---|---|---|',
]
for (const c of cases.filter((c) => c.id.startsWith('27/') && c.verdict === 'refused')) {
  const twinId = TWIN[c.id]
  const t = twinId ? get(twinId) : null
  const ff = c.out.frameFacts
  const atSigning = !t
    ? 'its own E, which the user signs'
    : ff.signatures[0]?.signs.startsWith('E') && ff.e === t.out.frameFacts.e
      ? 'the twin\'s E: the same typed data'
      : 'the twin\'s E: entry 0 is the twin\'s signature, carried over'
  const d = t ? diff(c, t) : []
  const facts = [
    `${ff.frames.length} frames: ${ff.frames.map((f) => `${f.mode}${f.scope !== null ? `/${f.scope}` : ''}${f.selector ? ` ${f.selector}` : ''}`).join(', ')}`,
    `payer ${ff.payer === ff.sender ? 'the sender' : ff.payer ?? 'none'}`,
    `entry 0 signs ${ff.signatures[0]?.signs}`,
  ]
  lines.push(`| \`${c.id.slice(3)}\` | ${twinId ? `\`${twinId.slice(3)}\`` : 'none'} | ${atSigning} | ${t ? (d.length ? d.join('; ') : 'none') : '-'} | ${facts.join('; ')} |`)
}
lines.push('', '## The EIP-8250 pair', '')
const [kz1, kz2] = cases.filter((c) => c.id.startsWith('8250/'))
lines.push(`Fields a check reads that differ between \`${kz1.id}\` and \`${kz2.id}\`: ${diff(kz2, kz1).join('; ') || 'none'}.`)
lines.push(`E under f3079a0: ${kz1.out.frameFacts.e}. E under master: ${kz2.out.frameFacts.e}. ${kz1.out.frameFacts.e === kz2.out.frameFacts.e ? 'The same: E commits to the nonce keys, not to what the chain makes of them.' : 'They differ.'}`)
lines.push('', '## W3\'s pair', '')
const [wa, wb] = cases.filter((c) => c.id.startsWith('34/'))
lines.push(`Fields a check reads that differ: ${diff(wb, wa).join('; ') || 'none'}.`)

mkdirSync(`${DIR}/results`, { recursive: true })
writeFileSync(
  `${DIR}/results/records.json`,
  `${JSON.stringify({ notApplicable: NOT_APPLICABLE, cases }, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 1)}\n`,
)
writeFileSync(`${DIR}/results/comparison.md`, `${lines.join('\n')}\n`)
// One file per case and record: the record's fields alone, under the check's own field names, as
// the check reads them. Integers that do not fit a double (amounts) are written as JSON integers.
const BIG = new Set(['approval_amount'])
const toJson = (fields: Record<string, unknown>) =>
  JSON.stringify(fields, (k, v) => (BIG.has(k) && typeof v === 'string' ? `@@int:${v}` : v), 1).replace(/"@@int:(\d+)"/g, '$1')
const slug = (id: string) => id.replace(/[^A-Za-z0-9.@-]+/g, '_')
rmSync(`${DIR}/results/records`, { recursive: true, force: true })
const index: Record<string, { source: string; verdict: string; files: { file: string; record: string; frame: number | null; underivable: string[] }[] }> = {}
for (const c of cases) {
  const dir = `${DIR}/results/records/${slug(c.id)}`
  mkdirSync(dir, { recursive: true })
  const seen = new Map<string, number>()
  const files = []
  for (const r of c.out.records) {
    const n = seen.get(r.type) ?? 0
    seen.set(r.type, n + 1)
    const total = c.out.records.filter((x) => x.type === r.type).length
    const file = `${slug(c.id)}/${r.type}${total > 1 ? `-${n + 1}` : ''}.json`
    writeFileSync(`${DIR}/results/records/${file}`, `${toJson(r.fields)}\n`)
    files.push({ file, record: r.type, frame: r.frame ?? null, underivable: r.underivable })
  }
  writeFileSync(`${dir}/frame-facts.json`, `${JSON.stringify(c.out.frameFacts, null, 1)}\n`)
  index[c.id] = { source: c.source, verdict: c.verdict, files }
}
writeFileSync(`${DIR}/results/records/index.json`, `${JSON.stringify({ notApplicable: NOT_APPLICABLE, cases: index }, null, 1)}\n`)

const counts = cases.map((c) => `${c.id}: ${c.out.records.map((r) => r.type).join(', ')}`)
console.log(`${cases.length} cases\n${counts.join('\n')}`)
