// Deploy the hasher, both verifiers, the pools and the sponsors, fund the sponsors, and deposit
// the notes the other scripts withdraw. Every step is skipped when already done.
//
// usage: npx tsx experiments/06-privacy-pool/setup.ts [--dry-run]
import { parseEther } from 'viem'
import { DRY_RUN } from '../../src/execute.js'
import { type Frame, makeClient, senderFrame } from '../../src/frametx/index.js'
import {
  funder,
  hasher,
  keyedPool,
  keyedSponsor,
  note,
  patchedVerifier,
  sendFrames,
  stockPool,
  stockVerifier,
  storagePool,
  storageSponsor,
} from './deployment.js'
import { type FramePoolInstance, depositFrame, hasCode, poolLeaves } from './pool.js'

const client = makeClient()
console.log(`funder ${funder}`)

async function missing(items: { name: string; address: `0x${string}`; deploy: Frame }[]) {
  const out: Frame[] = []
  for (const it of items) {
    const has = await hasCode(client, it.address)
    console.log(`${it.name.padEnd(18)} ${it.address} ${has ? 'deployed' : 'to deploy'}`)
    if (!has) out.push(it.deploy)
  }
  return out
}

// 1. The hasher alone: 11 KB of code is ~17M state gas.
const step1 = await missing([{ name: 'hasher', ...hasher }])
if (step1.length) await sendFrames(client, step1, 'deploy the MiMC hasher')

// 2. Verifiers, pools and sponsors.
const step2 = await missing([
  { name: 'verifier (stock)', ...stockVerifier },
  { name: 'verifier (patched)', ...patchedVerifier },
  { name: 'pool storage', ...storagePool },
  { name: 'pool keyed', ...keyedPool },
  { name: 'pool stock-verifier', ...stockPool },
  { name: 'sponsor storage', ...storageSponsor },
  { name: 'sponsor keyed', ...keyedSponsor },
])
for (const sponsor of [storageSponsor, keyedSponsor]) {
  if ((await client.getBalance({ address: sponsor.address })) === 0n) {
    step2.push(senderFrame({ target: sponsor.address, value: parseEther('0.001'), execution: 30_000n, state: 183_600n }))
  }
}
if (step2.length) await sendFrames(client, step2, 'deploy verifiers, pools and sponsors; fund the sponsors')
if (DRY_RUN && step1.length + step2.length) process.exit(0)

// 3. Deposits.
async function deposit(pool: FramePoolInstance, labels: string[]) {
  const leaves = await poolLeaves(client, pool.address)
  const frames = labels
    .map((l) => ({ l, n: note(l) }))
    .filter(({ l, n }) => {
      const done = leaves.includes(n.commitment)
      console.log(`${pool.label} ${l}: ${n.commitment} ${done ? 'deposited' : 'to deposit'}`)
      return !done
    })
    .map(({ n }) => depositFrame(pool.address, n.commitment))
  if (frames.length) await sendFrames(client, frames, `deposit ${frames.length} into ${pool.label}`)
}

// withdraw.ts spends storage/0-1 and keyed/0-1, concurrency.ts the other numbered notes, and
// negative.ts only simulates with the `neg` notes and stock/0, so they stay unspent.
await deposit(storagePool, ['storage/0', 'storage/1', 'storage/2', 'storage/3', 'storage/4', 'storage/5', 'storage/6', 'storage/7', 'storage/neg'])
await deposit(keyedPool, ['keyed/0', 'keyed/1', 'keyed/2', 'keyed/3', 'keyed/4', 'keyed/5', 'keyed/neg'])
// A later deposit, in a later slot, so that keyed/neg's root becomes an older one.
await deposit(keyedPool, ['keyed/late'])
await deposit(stockPool, ['stock/0'])
