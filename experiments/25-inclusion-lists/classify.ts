// Experiment 25, offline: which of this repository's mined frame transactions an inclusion list
// could protect, under EIP-8369 as written, under EIP-8272's (and ethrex's) shape rule, and under
// the post's proposed Profile 1; what each costs of the VERIFY budget; and how many fit a slot.
// Run: git fetch origin && npx tsx experiments/25-inclusion-lists/classify.ts   (no network)
import { hexToBytes } from 'viem'
import { maxGas, executionReservation, totalStateLimit } from '../../src/frametx/index.js'
import { branchHeads, loadCorpus, type Mined } from './corpus.js'
import {
  IL_COMMITTEE_SIZE,
  MAX_BYTES_PER_INCLUSION_LIST,
  MAX_VERIFY_GAS_PER_IL,
  profile1Frames,
  profile2Candidate,
  shape,
  usedBudgetCost,
  verifyBudgetCost,
  verifyBudgetCostWithState,
} from './profiles.js'

const corpus = loadCorpus()
const fmt = (n: bigint | number) => n.toLocaleString('en-US')
const bytesOf = (m: Mined) => hexToBytes(m.raw).length
const chainName = (m: Mined) => (m.tx.chainId === 8141n ? 'Hegota' : 'devnet-0')

console.log('Branches read (remote-tracking heads):')
console.log(branchHeads().map(([b, c]) => `${b}@${c}`).join(', '))
console.log(`\n${corpus.length} mined frame transactions: ${corpus.filter((m) => m.tx.chainId === 8141n).length} from the Hegota testnet, ${corpus.filter((m) => m.tx.chainId !== 8141n).length} from frames-devnet-0.\n`)

type Row = {
  m: Mined
  shape: string
  p2a: ReturnType<typeof profile2Candidate>
  p2b: ReturnType<typeof profile2Candidate>
  p1: ReturnType<typeof profile1Frames>
  cost: bigint
  costState: bigint
  used: bigint
  bytes: number
}
const rows: Row[] = corpus.map((m) => ({
  m,
  shape: shape(m.tx),
  p2a: profile2Candidate(m.tx, 'eip8369'),
  p2b: profile2Candidate(m.tx, 'eip8272'),
  p1: profile1Frames(m.tx, m.receipt),
  cost: verifyBudgetCost(m.tx),
  costState: verifyBudgetCostWithState(m.tx),
  used: usedBudgetCost(m.tx, m.receipt),
  bytes: bytesOf(m),
}))

// ---- 1. the three rules over the whole corpus ----
const count = (f: (r: Row) => boolean) => rows.filter(f).length
console.log('## 1. Eligibility of every mined transaction\n')
console.log('| rule | eligible | not eligible |')
console.log('|---|---:|---:|')
console.log(`| Profile 2 candidate, EIP-8369 as written | ${count((r) => r.p2a.ok)} | ${count((r) => !r.p2a.ok)} |`)
console.log(`| Profile 2 candidate, skipping both verifier frames (EIP-8272, ethrex) | ${count((r) => r.p2b.ok)} | ${count((r) => !r.p2b.ok)} |`)
console.log(`| proposed Profile 1 (directly evaluable prefix) | ${count((r) => r.p1.ok)} | ${count((r) => !r.p1.ok)} |`)
console.log(`| either Profile 2 (EIP-8272 reading) or proposed Profile 1 | ${count((r) => r.p2b.ok || r.p1.ok)} | ${count((r) => !r.p2b.ok && !r.p1.ok)} |`)

const flipped = rows.filter((r) => r.p2b.ok && !r.p2a.ok)
console.log(`\nCandidates under EIP-8272's rule that EIP-8369's text excludes: ${flipped.length}, all with shape(s) ${[...new Set(flipped.map((r) => r.shape))].join('; ')}.`)

const reasons = new Map<string, number>()
for (const r of rows) if (!r.p2b.ok) reasons.set(r.p2b.reason, (reasons.get(r.p2b.reason) ?? 0) + 1)
console.log('\nWhy the rest are not Profile 2 candidates (EIP-8272 reading):')
if (reasons.size === 0) console.log('- none: every mined transaction is a candidate.')
for (const [why, n] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`- ${why}: ${n}`)
const p1reasons = new Map<string, number>()
for (const r of rows) if (!r.p1.ok) p1reasons.set(r.p1.reason, (p1reasons.get(r.p1.reason) ?? 0) + 1)
console.log('\nWhy the rest are not eligible for the proposed Profile 1:')
for (const [why, n] of [...p1reasons].sort((a, b) => b[1] - a[1])) console.log(`- ${why}: ${n}`)

// ---- 2. by experiment and shape ----
console.log('\n## 2. By experiment and validation prefix\n')
console.log('Budget = signature verification + declared execution limits up to the payer frame (EIP-8369, ethrex). "Used" = the same with each frame\'s measured execution gas.\n')
console.log('| branch | chain | prefix shape | txs | P2 (8369) | P2 (8272) | P1 (proposed) | budget declared | budget used | budget with state limits | bytes |')
console.log('|---|---|---|---:|---|---|---|---:|---:|---:|---:|')
const groups = new Map<string, Row[]>()
for (const r of rows) {
  const key = `${r.m.branch}\u0000${chainName(r.m)}\u0000${r.shape}`
  groups.set(key, [...(groups.get(key) ?? []), r])
}
const range = (xs: (bigint | number)[]) => {
  const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return s[0] === s[s.length - 1] ? fmt(s[0]) : `${fmt(s[0])} to ${fmt(s[s.length - 1])}`
}
const yes = (rs: Row[], f: (r: Row) => boolean) => {
  const n = rs.filter(f).length
  return n === rs.length ? 'yes' : n === 0 ? 'no' : `${n}/${rs.length}`
}
for (const [key, rs] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
  const [branch, chain, sh] = key.split('\u0000')
  console.log(
    `| ${branch} | ${chain} | \`${sh.replaceAll('|', '\\|')}\` | ${rs.length} | ${yes(rs, (r) => r.p2a.ok)} | ${yes(rs, (r) => r.p2b.ok)} | ${yes(rs, (r) => r.p1.ok)} | ${range(rs.map((r) => r.cost))} | ${range(rs.map((r) => r.used))} | ${range(rs.map((r) => r.costState))} | ${range(rs.map((r) => r.bytes))} |`,
  )
}

// ---- 3. what a slot can carry ----
console.log('\n## 3. What one slot of inclusion lists can protect\n')
console.log(`Per slot: ${IL_COMMITTEE_SIZE} lists of ${fmt(MAX_BYTES_PER_INCLUSION_LIST)} bytes. Budget ${fmt(MAX_VERIFY_GAS_PER_IL)} per list (EIP-8369) or per payload (ethrex, since the Engine API delivers one array). A homogeneous slot of each kind; "declared" uses the transaction's own limits, "tight" the gas it used.\n`)
// Representatives: the cheapest declared budget of each kind of transaction, Hegota testnet only
// (devnet-0 prices cold access at 2,600, not 3,000), from the experiment that built the kind.
const hegota = (r: Row) => r.m.tx.chainId === 8141n
const reps: [string, (r: Row) => boolean][] = [
  ['self-relayed EOA, default code (01)', (r) => hegota(r) && r.m.branch === 'tooling' && r.shape === 'self_verify' && r.p1.ok],
  ['EOA sponsored by a code-less EOA (04, 09)', (r) => hegota(r) && r.shape === 'only_verify | pay' && r.p1.ok],
  ['deadline-bounded EOA (10)', (r) => hegota(r) && r.m.branch === 'exp/10-expiry' && r.shape === 'expiry_verify | self_verify' && r.p1.ok],
  ['smart account, own VERIFY (05)', (r) => hegota(r) && r.m.branch === 'exp/05-multisig' && r.shape === 'self_verify' && !r.p1.ok],
  ['privacy withdrawal, keyed pool (06)', (r) => hegota(r) && r.m.branch === 'exp/06-privacy-pool' && r.shape.startsWith('recent_root_verify')],
  ['sealed-paymaster sponsorship (24)', (r) => hegota(r) && r.m.branch === 'exp/24-sealed-paymaster' && r.shape.includes('recent_root_verify | only_verify | pay')],
]
console.log('| kind | example | bytes | budget declared / tight | per slot, ethrex (2^20 per payload) | per slot, EIP-8369 (2^20 per list) | per slot, proposed Profile 1 (bytes only) |')
console.log('|---|---|---:|---:|---:|---:|---:|')
for (const [name, pick] of reps) {
  const cands = rows.filter(pick)
  if (cands.length === 0) {
    console.log(`| ${name} | none in corpus | | | | | |`)
    continue
  }
  const r = cands.sort((a, b) => (a.cost < b.cost ? -1 : a.cost > b.cost ? 1 : 0))[0]
  const perList = Math.floor(MAX_BYTES_PER_INCLUSION_LIST / r.bytes)
  const byBytes = perList * IL_COMMITTEE_SIZE
  const flat = (c: bigint) => Math.min(byBytes, Number(MAX_VERIFY_GAS_PER_IL / c))
  const perIl = (c: bigint) => Math.min(perList, Number(MAX_VERIFY_GAS_PER_IL / c)) * IL_COMMITTEE_SIZE
  const p2 = r.p2b.ok
  console.log(
    `| ${name} | \`${r.m.hash.slice(0, 10)}…\` | ${r.bytes} | ${fmt(r.cost)} / ${fmt(r.used)} | ${p2 ? `${fmt(flat(r.cost))} / ${fmt(flat(r.used))}` : 'not a candidate'} | ${p2 ? `${fmt(perIl(r.cost))} / ${fmt(perIl(r.used))}` : 'not a candidate'} | ${r.p1.ok ? fmt(byBytes) : 'not eligible'} |`,
  )
}

// ---- 4. one dimension or two ----
console.log('\n## 4. "Fits the remaining gas", in one dimension or two\n')
console.log('EIP-8141 includes a frame transaction only if its execution reservation and its state reservation each fit their own dimension. EIP-7805 step 2 and ethrex\'s `gas_fits` compare one number, `max_gas`, against `gas_limit - gas_used`. The difference is what the one-dimensional rule additionally requires to be free.\n')
const gaps = rows.map((r) => maxGas(r.m.tx) - executionReservation(r.m.tx)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
const withState = rows.filter((r) => totalStateLimit(r.m.tx) > 0n).length
console.log(`- ${withState} of ${rows.length} transactions declare state gas; for them \`max_gas\` exceeds the execution reservation.`)
console.log(`- \`max_gas - execution_reservation\`: median ${fmt(gaps[Math.floor(gaps.length / 2)])}, largest ${fmt(gaps[gaps.length - 1])} gas.`)
const top = rows.reduce((a, b) => (maxGas(b.m.tx) - executionReservation(b.m.tx) > maxGas(a.m.tx) - executionReservation(a.m.tx) ? b : a))
const creating = top.m.tx.frames.filter((f) => f.limits.state > 0n).length
console.log(`- The largest is \`${top.m.hash.slice(0, 10)}…\` on ${top.m.branch}: ${top.shape}, then ${creating} frames declaring ${fmt(totalStateLimit(top.m.tx))} state gas between them (contract creation). Under the one-dimensional rule it needs that much more room than its execution reservation in a block whose state dimension may be empty.`)
