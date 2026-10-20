// Experiment 32: one registry for the private owned state of two applications.
//
// Setup  deploy the verifier, the registry and three applications; deposit five notes, two of
//        them with the same secrets in two applications
//   A    FixedPool: the shared secrets' note spent whole, the registry as sender      mined
//   B    Balance: the same secrets' note, 0.001 ETH out, 0.002 ETH left in a change note mined
//   C    Balance: the change note spent, 0.002 ETH out, nothing left                   mined
//   D    a nullifier from one application presented to the other                      refused
//   E    each application's rule, and the control whose rule reads its own storage    refused
//
// Every refusal is tried in simulation and then with eth_sendRawTransaction. Steps already done
// are skipped, so the script can be run again.
//
// usage: npx tsx experiments/32-owned-state/run.ts [--dry-run]
import { type Address, type Hex, concatHex, formatEther, keccak256, toHex } from 'viem'
import { privateKeyToAddress } from 'viem/accounts'
import { sendFrames } from '../../src/deploy.js'
import { loadKey } from '../../src/env.js'
import { DRY_RUN } from '../../src/execute.js'
import {
  type FrameTx,
  frameReceiptGas,
  frameReceiptStatus,
  makeClient,
  sendFrameTx,
  simulateFrameTx,
  waitForFrameTxReceipt,
} from '../../src/frametx/index.js'
import {
  CAP,
  DENOMINATION,
  FEE,
  type Spend,
  type Update,
  balance,
  depositFrame,
  fixedPool,
  innerOf,
  isSpent,
  kernelInput,
  leafOf,
  nullifierOf,
  prove,
  proveInput,
  registry,
  registryAbi,
  registryLeaves,
  rootSlot,
  secretsOf,
  storedRule,
  updateTx,
  verifier,
} from './registry.js'

const client = makeClient()
const chainId = BigInt(await client.getChainId())
const { privateKey, address: funder } = loadKey()
const recipient = (label: string): Address => privateKeyToAddress(keccak256(concatHex([privateKey, toHex(`exp-frames/32/recipient/${label}`)])))
const BALANCE_NOTE = 3n * DENOMINATION

type Row = { step: string; outcome: string; hash?: Hex; block?: bigint; gasUsed?: bigint; frames?: string }
const rows: Row[] = []

async function send(step: string, tx: FrameTx, expect: 'mined' | 'refused'): Promise<void> {
  const sim = await simulateFrameTx(client, tx)
  if (!sim.valid || sim.executionStatus !== 'success') {
    let admission = 'not sent'
    if (!sim.valid && !DRY_RUN) {
      try {
        await sendFrameTx(client, tx)
        admission = 'ADMITTED'
      } catch (e) {
        admission = `eth_sendRawTransaction refused: ${(e as Error).message.split('\n')[0].slice(0, 120)}`
      }
    }
    const why = sim.valid ? `valid, but a frame reverts (${sim.executionError})` : `refused: ${sim.violation}`
    console.log(`${step}: ${why}; ${admission}`)
    rows.push({ step, outcome: why })
    if (expect === 'mined') throw new Error(`${step}: expected to be mined`)
    return
  }
  if (expect === 'refused') throw new Error(`${step}: expected a refusal, but simulation admits it`)
  if (DRY_RUN) {
    console.log(`${step}: valid in simulation, gasUsed ${BigInt(sim.gasUsed ?? '0x0')}; frames ${sim.frames?.map((f) => BigInt(f.gasUsed)).join(' / ')}`)
    rows.push({ step, outcome: 'valid in simulation' })
    return
  }
  const hash = await sendFrameTx(client, tx)
  const r = await waitForFrameTxReceipt(client, hash)
  const frames = r.frameReceipts.map((f) => {
    const g = frameReceiptGas(f)
    return `${frameReceiptStatus(f)}:${g.execution}${g.state ? `+${g.state}s` : ''}`
  })
  const ok = r.frameReceipts.every((f) => frameReceiptStatus(f) === 1)
  console.log(`${step}: ${hash} block ${BigInt(r.blockNumber)} gasUsed ${BigInt(r.gasUsed)} frames ${frames.join(' / ')}`)
  rows.push({ step, outcome: ok ? 'mined' : 'mined, a frame failed', hash, block: BigInt(r.blockNumber), gasUsed: BigInt(r.gasUsed), frames: frames.join(' / ') })
  if (!ok) throw new Error(`${step}: a frame failed`)
}

// ---- setup ----

console.log(`registry ${registry.address}, verifier ${verifier.address}`)
console.log(`apps: FixedPool ${fixedPool.address}, Balance ${balance.address}, StoredRule ${storedRule.address}`)
const contracts = [verifier, registry, fixedPool, balance, storedRule]
const missing = []
for (const c of contracts) if (!(await client.getCode({ address: c.address }))) missing.push(c.deploy)
if (missing.length) await sendFrames(client, privateKey, missing, { label: 'setup: deploy the verifier, the registry and the applications' })
if (DRY_RUN && missing.length) process.exit(0)

const shared = secretsOf(privateKey, 'shared')
const notes = [
  { label: 'shared in FixedPool', app: fixedPool.address, secrets: shared, value: DENOMINATION },
  { label: 'shared in Balance', app: balance.address, secrets: shared, value: BALANCE_NOTE },
  { label: 'fixed/neg', app: fixedPool.address, secrets: secretsOf(privateKey, 'fixed/neg'), value: DENOMINATION },
  { label: 'balance/big', app: balance.address, secrets: secretsOf(privateKey, 'balance/big'), value: BALANCE_NOTE },
  { label: 'stored', app: storedRule.address, secrets: secretsOf(privateKey, 'stored'), value: DENOMINATION },
]
let leaves = await registryLeaves(client)
const toDeposit = notes.filter((n) => !leaves.some((l) => l.leaf === leafOf(n.app, innerOf(n.secrets), n.value)))
if (toDeposit.length) {
  const frames = toDeposit.map((n, i) => depositFrame(n.app, innerOf(n.secrets), n.value, leaves.length === 0 && i === 0))
  await sendFrames(client, privateKey, frames, { label: `setup: deposit ${toDeposit.map((n) => n.label).join(', ')}` })
  if (DRY_RUN) process.exit(0)
  leaves = await registryLeaves(client)
}
const indexOf = (app: Address, inner: bigint, value: bigint) => {
  const i = leaves.findIndex((l) => l.leaf === leafOf(app, inner, value))
  if (i < 0) throw new Error('note not in the tree')
  return i
}
const onChainRoot = BigInt(await client.readContract({ address: registry.address, abi: registryAbi, functionName: 'getLastRoot' }))
console.log(`${leaves.length} leaves; ${leaves.filter((l) => l.app === fixedPool.address).length} FixedPool, ${leaves.filter((l) => l.app === balance.address).length} Balance, ${leaves.filter((l) => l.app === storedRule.address).length} StoredRule`)

/** Prove a spend against the current tree, and the update transaction carrying it. */
async function spendTx(s: Spend) {
  const tree = leaves.map((l) => l.leaf)
  const { root, update } = await prove(s, tree)
  const slot = await rootSlot(client, root)
  if (slot === undefined) throw new Error('the proof root was never published to EIP-8272')
  return { root, slot, update, tx: updateTx({ chainId, root, slot, updates: [update] }) }
}

// ---- A. FixedPool ----

const nFixed = nullifierOf(fixedPool.address, shared)
const nBalance = nullifierOf(balance.address, shared)
console.log(`\nshared secrets: FixedPool nullifier ${toHex(nFixed)}, Balance nullifier ${toHex(nBalance)}`)
const fixedSpend: Spend = {
  app: fixedPool.address,
  secrets: shared,
  state: DENOMINATION,
  index: indexOf(fixedPool.address, innerOf(shared), DENOMINATION),
  withdrawn: DENOMINATION,
  recipient: recipient('A'),
  fee: FEE,
}
const a = await spendTx(fixedSpend)
const { root: treeRoot } = a
if (treeRoot !== onChainRoot) throw new Error(`the local tree's root ${toHex(treeRoot)} is not the registry's ${toHex(onChainRoot)}`)
console.log(`local tree root = registry root ${toHex(onChainRoot)}`)

// D1, before A: A's proof presented as Balance's. The proof binds the tag.
const asBalance = (u: Update): Update => ({ ...u, tag: BigInt(balance.address) })
const aSpent = await isSpent(client, nFixed)
if (!aSpent) {
  await send("D1. A's update with Balance's tag, before A", updateTx({ chainId, root: a.root, slot: a.slot, updates: [asBalance(a.update)] }), 'refused')
  await send('A. FixedPool: the shared note spent whole', a.tx, 'mined')
} else console.log('A already mined')

// ---- B and C. Balance ----

const change = secretsOf(privateKey, 'change')
const balanceSpend: Spend = {
  app: balance.address,
  secrets: shared,
  state: BALANCE_NOTE,
  index: indexOf(balance.address, innerOf(shared), BALANCE_NOTE),
  withdrawn: DENOMINATION,
  newInner: innerOf(change),
  recipient: recipient('B'),
  fee: FEE,
}
if (!(await isSpent(client, nBalance))) {
  const b = await spendTx(balanceSpend)
  await send('B. Balance: the same secrets, 0.001 ETH out, 0.002 ETH in change', b.tx, 'mined')
  leaves = await registryLeaves(client)
} else console.log('B already mined')

const changeValue = BALANCE_NOTE - DENOMINATION
const nChange = nullifierOf(balance.address, change)
if (!(await isSpent(client, nChange))) {
  const c = await spendTx({
    app: balance.address,
    secrets: change,
    state: changeValue,
    index: indexOf(balance.address, innerOf(change), changeValue),
    withdrawn: changeValue,
    recipient: recipient('C'),
    fee: FEE,
  })
  await send('C. Balance: the change note spent, 0.002 ETH out', c.tx, 'mined')
} else console.log('C already mined')

// ---- D. A nullifier from one application, presented to the other ----

// D2. The prover cannot make a Balance update with FixedPool's nullifier: no Balance leaf opens
// to it. The witness fails at the tree root, the first constraint the wrong tag breaks.
try {
  await proveInput({ ...kernelInput(fixedSpend, leaves.map((l) => l.leaf)), tag: BigInt(balance.address) })
  throw new Error('D2: proved a Balance update with a FixedPool nullifier')
} catch (e) {
  const msg = (e as Error).message
  if (msg.startsWith('D2')) throw e
  console.log(`D2. the prover refuses a Balance update with FixedPool's nullifier: ${msg.split('\n')[0].slice(0, 100)}`)
  rows.push({ step: "D2. a Balance update with FixedPool's nullifier, proved", outcome: 'refused by the prover: the witness fails at the root' })
}
// D3. After A: A again, and A's nullifier with Balance's tag. Its nonce key is used.
await send('D3. A again', a.tx, 'refused')
await send("D4. A's nullifier with Balance's tag, after A", updateTx({ chainId, root: a.root, slot: a.slot, updates: [asBalance(a.update)] }), 'refused')

// ---- E. The applications' rules ----

const fixedNeg = secretsOf(privateKey, 'fixed/neg')
const e1 = await spendTx({
  app: fixedPool.address,
  secrets: fixedNeg,
  state: DENOMINATION,
  index: indexOf(fixedPool.address, innerOf(fixedNeg), DENOMINATION),
  withdrawn: DENOMINATION / 2n,
  newInner: innerOf(secretsOf(privateKey, 'fixed/neg/change')),
  recipient: recipient('E1'),
  fee: FEE,
})
await send('E1. FixedPool: half out, half in change (a valid kernel proof)', e1.tx, 'refused')
const big = secretsOf(privateKey, 'balance/big')
const e2 = await spendTx({
  app: balance.address,
  secrets: big,
  state: BALANCE_NOTE,
  index: indexOf(balance.address, innerOf(big), BALANCE_NOTE),
  withdrawn: BALANCE_NOTE,
  recipient: recipient('E2'),
  fee: FEE,
})
await send('E2. Balance: 0.003 ETH out, above the cap', e2.tx, 'refused')
const stored = secretsOf(privateKey, 'stored')
const e3 = await spendTx({
  app: storedRule.address,
  secrets: stored,
  state: DENOMINATION,
  index: indexOf(storedRule.address, innerOf(stored), DENOMINATION),
  withdrawn: DENOMINATION,
  recipient: recipient('E3'),
  fee: FEE,
})
await send('E3. StoredRule: a rule that reads its own storage', e3.tx, 'refused')
// E4. Starving the update frame after approval would burn the note; the registry refuses it.
const starved = structuredClone(e2.tx)
starved.frames[2].limits.execution = 50_000n
await send('E4. Balance: the update frame given less than the floor', starved, 'refused')

// ---- summary ----

console.log('\n| Step | Outcome | Tx | Block | gasUsed | Frames (status:execution+state) |\n|---|---|---|---|---|---|')
for (const r of rows) console.log(`| ${r.step} | ${r.outcome} | ${r.hash ?? ''} | ${r.block ?? ''} | ${r.gasUsed ?? ''} | ${r.frames ?? ''} |`)
for (const [l, who] of [['A', recipient('A')], ['B', recipient('B')], ['C', recipient('C')]] as const) {
  console.log(`recipient ${l} ${who}: ${formatEther(await client.getBalance({ address: who }))} ETH`)
}
console.log(`registry balance ${formatEther(await client.getBalance({ address: registry.address }))} ETH; funder ${funder}`)
console.log(`cap ${formatEther(CAP)} ETH`)
process.exit(0)
