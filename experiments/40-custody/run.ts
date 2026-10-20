// Experiment 40: one registry, two applications, each holding its own value in a vault.
//
// Setup  deploy the registry and three vaults (A, B, and C, A's twin at another address), give
//        the registry a float for gas, and deposit four notes: the same secrets in A and in B,
//        one more in A that stays unspent, and one in C
//   X    a note of one application claimed against another's vault                 refused
//   Y    a pending withdrawal copied with another recipient, and with other fees   refused
//   A    A: the shared secrets' note spent whole                                   mined
//   B1   B: the same secrets' note, 0.001 ETH out, 0.002 ETH left in a change note  mined
//   B2   B: the change note spent                                                  mined
//   Z    the control: experiment 32's registry, a withdrawal copied with a higher
//        priority fee                                                              admitted, then mined
//
// The vaults' and the registry's balances are read after every step. Every refusal is tried in
// simulation and then with eth_sendRawTransaction. Steps already done are skipped.
//
// usage: npx tsx experiments/40-custody/run.ts [--dry-run]
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { type Address, type Hex, concatHex, keccak256, toHex } from 'viem'
import { privateKeyToAddress } from 'viem/accounts'
import { REPO_ROOT } from '../../src/contracts.js'
import { sendFrames } from '../../src/deploy.js'
import { loadKey } from '../../src/env.js'
import { DRY_RUN } from '../../src/execute.js'
import {
  type FrameTx,
  type FrameTxFees,
  frameReceiptGas,
  frameReceiptStatus,
  makeClient,
  senderFrame,
  sendFrameTx,
  simulateFrameTx,
  waitForFrameTxReceipt,
} from '../../src/frametx/index.js'
import * as v32 from '../32-owned-state/registry.js'
import { innerOf, secretsOf, verifier } from '../32-owned-state/registry.js'
import {
  DENOMINATION,
  DIR,
  FEE,
  FEES,
  FLOAT,
  type Spend,
  type Update,
  type Vault,
  depositFrame,
  isSpent,
  leafOf,
  nullifierOf,
  prove,
  registry,
  registryAbi,
  registryLeaves,
  rootSlot,
  scopeOf,
  updateTx,
  vaultA,
  vaultB,
  vaultC,
} from './custody.js'

const client = makeClient()
const chainId = BigInt(await client.getChainId())
const { privateKey } = loadKey()
const recipient = (label: string): Address => privateKeyToAddress(keccak256(concatHex([privateKey, toHex(`exp-frames/40/recipient/${label}`)])))
const secrets = (label: string) => secretsOf(privateKey, `exp40/${label}`)
const BALANCE_NOTE = 3n * DENOMINATION
/** What a copy offers the block's producer: a tip and a cap whose worst case the fee still covers. */
const RAISED: FrameTxFees = { maxPriorityFeePerGas: 8_000n, maxFeePerGas: 10_000n, maxFeePerBlobGas: 0n }

type Row = { step: string; outcome: string; hash?: Hex; block?: bigint; gasUsed?: bigint; frames?: string; effectiveGasPrice?: bigint; balances?: Record<string, bigint> }
const rows: Row[] = []
const vaults = [vaultA, vaultB, vaultC]

async function balances(): Promise<Record<string, bigint>> {
  const out: Record<string, bigint> = {}
  for (const v of vaults) out[v.label] = await client.getBalance({ address: v.address })
  out.registry = await client.getBalance({ address: registry.address })
  return out
}

async function send(step: string, tx: FrameTx, expect: 'mined' | 'refused' | 'admitted'): Promise<Row> {
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
    const row = { step, outcome: `${why}; ${admission}` }
    rows.push(row)
    if (expect !== 'refused' || admission === 'ADMITTED') throw new Error(`${step}: expected ${expect}`)
    return row
  }
  if (expect === 'refused') throw new Error(`${step}: expected a refusal, but simulation admits it`)
  if (expect === 'admitted' || DRY_RUN) {
    const g = BigInt(sim.gasUsed ?? '0x0')
    console.log(`${step}: valid in simulation, gasUsed ${g}; frames ${sim.frames?.map((f) => BigInt(f.gasUsed)).join(' / ')}`)
    const row = { step, outcome: 'valid in simulation', gasUsed: g }
    rows.push(row)
    return row
  }
  const hash = await sendFrameTx(client, tx)
  const r = await waitForFrameTxReceipt(client, hash)
  const frames = r.frameReceipts.map((f) => {
    const g = frameReceiptGas(f)
    return `${frameReceiptStatus(f)}:${g.execution}${g.state ? `+${g.state}s` : ''}`
  })
  const ok = r.frameReceipts.every((f) => frameReceiptStatus(f) === 1)
  const effectiveGasPrice = BigInt((r as unknown as { effectiveGasPrice?: Hex }).effectiveGasPrice ?? '0x0')
  console.log(`${step}: ${hash} block ${BigInt(r.blockNumber)} gasUsed ${BigInt(r.gasUsed)} price ${effectiveGasPrice} frames ${frames.join(' / ')}`)
  const row = {
    step,
    outcome: ok ? 'mined' : 'mined, a frame failed',
    hash,
    block: BigInt(r.blockNumber),
    gasUsed: BigInt(r.gasUsed),
    effectiveGasPrice,
    frames: frames.join(' / '),
    balances: await balances(),
  }
  rows.push(row)
  if (!ok) throw new Error(`${step}: a frame failed`)
  return row
}

// ---- setup ----

console.log(`registry ${registry.address}; vaults A ${vaultA.address}, B ${vaultB.address}, C ${vaultC.address}; verifier ${verifier.address}`)
if (!(await client.getCode({ address: verifier.address }))) throw new Error("experiment 32's verifier is not on this chain")
if (!(await client.getCode({ address: v32.HASHER }))) throw new Error("experiment 06's hasher is not on this chain")
const missing = []
for (const c of [registry, ...vaults]) if (!(await client.getCode({ address: c.address }))) missing.push(c.deploy)
if (missing.length) {
  const float = (await client.getBalance({ address: registry.address })) < FLOAT ? [senderFrame({ target: registry.address, value: FLOAT, execution: 30_000n })] : []
  await sendFrames(client, privateKey, [...missing, ...float], { label: 'setup: deploy the registry and the vaults; the float' })
  if (DRY_RUN) process.exit(0)
}
for (const v of vaults) {
  const s = BigInt(await client.readContract({ address: registry.address, abi: registryAbi, functionName: 'scopeOf', args: [v.address] }))
  if (s !== scopeOf(v, chainId)) throw new Error(`${v.label}: the registry's scope is not ours`)
}
console.log('every vault\'s scope, computed here, is the registry\'s')

const shared = secrets('shared')
const notes: { label: string; vault: Vault; secrets: ReturnType<typeof secrets>; value: bigint }[] = [
  { label: 'shared in A', vault: vaultA, secrets: shared, value: DENOMINATION },
  { label: 'shared in B', vault: vaultB, secrets: shared, value: BALANCE_NOTE },
  { label: 'a2, unspent', vault: vaultA, secrets: secrets('a2'), value: DENOMINATION },
  { label: 'c1, unspent', vault: vaultC, secrets: secrets('c1'), value: DENOMINATION },
]
const leafOfNote = (n: (typeof notes)[number]) => leafOf(scopeOf(n.vault, chainId), innerOf(n.secrets), n.value)
let leaves = await registryLeaves(client)
const toDeposit = notes.filter((n) => !leaves.some((l) => l.leaf === leafOfNote(n)))
if (toDeposit.length) {
  const frames = toDeposit.map((n, i) => depositFrame(n.vault.address, innerOf(n.secrets), n.value, leaves.length === 0 && i === 0))
  await sendFrames(client, privateKey, frames, { label: `setup: deposit ${toDeposit.map((n) => n.label).join(', ')}` })
  if (DRY_RUN) process.exit(0)
  leaves = await registryLeaves(client)
}
rows.push({ step: 'setup done', outcome: `${leaves.length} leaves`, balances: await balances() })
console.log('balances after setup', rows.at(-1)?.balances)
const indexOf = (leaf: bigint) => {
  const i = leaves.findIndex((l) => l.leaf === leaf)
  if (i < 0) throw new Error('note not in the tree')
  return i
}

async function spendTx(s: Spend) {
  const { root, update } = await prove(s, leaves.map((l) => l.leaf))
  const slot = await rootSlot(client, root)
  if (slot === undefined) throw new Error('the proof root was never published to EIP-8272')
  return { root, slot, update, tx: updateTx({ chainId, root, slot, update, fees: s.fees }) }
}
const reTx = (a: { root: bigint; slot: bigint }, update: Update, fees: FrameTxFees = FEES) => updateTx({ chainId, root: a.root, slot: a.slot, update, fees })

// ---- X, Y, then A ----

const scopeA = scopeOf(vaultA, chainId)
const nA = nullifierOf(scopeA, shared)
const aSpend: Spend = {
  vault: vaultA,
  chainId,
  secrets: shared,
  state: DENOMINATION,
  index: indexOf(leafOf(scopeA, innerOf(shared), DENOMINATION)),
  withdrawn: DENOMINATION,
  recipient: recipient('A'),
  fee: FEE,
  fees: FEES,
}
if (!(await isSpent(client, nA))) {
  const a = await spendTx(aSpend)
  await send("X1. A's withdrawal naming B's vault", reTx(a, { ...a.update, vault: vaultB.address }), 'refused')
  await send("X2. A's withdrawal naming C's vault, A's twin", reTx(a, { ...a.update, vault: vaultC.address }), 'refused')
  try {
    await prove({ ...aSpend, vault: vaultB }, leaves.map((l) => l.leaf))
    throw new Error("X3: a proof of A's note under B's scope was made")
  } catch (e) {
    if ((e as Error).message.startsWith('X3')) throw e
    console.log(`X3. A's note proved under B's scope: the prover fails (${(e as Error).message.split('\n')[0].slice(0, 80)})`)
    rows.push({ step: "X3. A's note proved under B's scope", outcome: 'the prover fails: no leaf under that scope opens to these secrets' })
  }
  await send('Y1. the pending withdrawal copied with another recipient', reTx(a, { ...a.update, recipient: recipient('copier') }), 'refused')
  await send('Y2. the pending withdrawal copied with a higher priority fee', reTx(a, a.update, RAISED), 'refused')
  const proved = await spendTx({ ...aSpend, fees: RAISED })
  await send('Y2, the positive control: a withdrawal proved for those fees', proved.tx, 'admitted')
  await send('A. A: the shared note spent whole', a.tx, 'mined')
} else console.log('A already mined')

// ---- B1 and B2 ----

const scopeB = scopeOf(vaultB, chainId)
const nB = nullifierOf(scopeB, shared)
const change = secrets('change')
if (!(await isSpent(client, nB))) {
  const b = await spendTx({
    vault: vaultB,
    chainId,
    secrets: shared,
    state: BALANCE_NOTE,
    index: indexOf(leafOf(scopeB, innerOf(shared), BALANCE_NOTE)),
    withdrawn: DENOMINATION,
    newInner: innerOf(change),
    recipient: recipient('B1'),
    fee: FEE,
    fees: FEES,
  })
  await send('B1. B: the same secrets, 0.001 ETH out, 0.002 ETH in change', b.tx, 'mined')
  leaves = await registryLeaves(client)
} else console.log('B1 already mined')

const changeValue = BALANCE_NOTE - DENOMINATION
const nChange = nullifierOf(scopeB, change)
if (!(await isSpent(client, nChange))) {
  const c = await spendTx({
    vault: vaultB,
    chainId,
    secrets: change,
    state: changeValue,
    index: indexOf(leafOf(scopeB, innerOf(change), changeValue)),
    withdrawn: changeValue,
    recipient: recipient('B2'),
    fee: FEE,
    fees: FEES,
  })
  await send("X4. B's change note naming A's vault, which still holds a2", reTx(c, { ...c.update, vault: vaultA.address }), 'refused')
  await send('B2. B: the change note spent', c.tx, 'mined')
} else console.log('B2 already mined')

// ---- Z, the control: experiment 32's registry ----

const zSecrets = secretsOf(privateKey, 'exp40/control')
const zLeaf = v32.leafOf(v32.fixedPool.address, innerOf(zSecrets), v32.DENOMINATION)
let leaves32 = await v32.registryLeaves(client)
if (!leaves32.some((l) => l.leaf === zLeaf)) {
  await sendFrames(client, privateKey, [v32.depositFrame(v32.fixedPool.address, innerOf(zSecrets), v32.DENOMINATION)], { label: "Z setup: a note in experiment 32's FixedPool" })
  leaves32 = await v32.registryLeaves(client)
}
const zNullifier = v32.nullifierOf(v32.fixedPool.address, zSecrets)
if (!(await v32.isSpent(client, zNullifier))) {
  const { root, update } = await v32.prove(
    {
      app: v32.fixedPool.address,
      secrets: zSecrets,
      state: v32.DENOMINATION,
      index: leaves32.findIndex((l) => l.leaf === zLeaf),
      withdrawn: v32.DENOMINATION,
      recipient: recipient('Z'),
      fee: v32.FEE,
    },
    leaves32.map((l) => l.leaf),
  )
  const slot = await v32.rootSlot(client, root)
  if (slot === undefined) throw new Error('Z: the root was never published')
  const original = v32.updateTx({ chainId, root, slot, updates: [update] })
  await send("Z0. experiment 32's withdrawal as its owner made it", original, 'admitted')
  const copy = v32.updateTx({ chainId, root, slot, updates: [update], fees: RAISED })
  await send("Z1. the same payload, copied with a higher priority fee, against experiment 32's registry", copy, 'mined')
} else console.log('Z already mined')

const record = {
  chainId,
  registry: registry.address,
  sourceId: (await client.readContract({ address: registry.address, abi: registryAbi, functionName: 'sourceId' })) as Hex,
  verifier: verifier.address,
  hasher: v32.HASHER,
  vaults: vaults.map((v) => ({ label: v.label, address: v.address, kind: v.kind, amount: v.amount, scope: toHex(scopeOf(v, chainId), { size: 32 }) })),
  float: FLOAT,
  fee: FEE,
  fees: FEES,
  raised: RAISED,
  nullifiers: { a: toHex(nA, { size: 32 }), b1: toHex(nB, { size: 32 }), b2: toHex(nChange, { size: 32 }), z: toHex(zNullifier, { size: 32 }) },
  registry32: v32.registry.address,
  rows,
  final: await balances(),
}
const json = JSON.stringify(record, (_, v) => (typeof v === 'bigint' ? `0x${v.toString(16)}` : v), 2)
if (!DRY_RUN) writeFileSync(resolve(REPO_ROOT, DIR, 'record.json'), `${json}\n`)
console.log('final balances', record.final)
process.exit(0)
