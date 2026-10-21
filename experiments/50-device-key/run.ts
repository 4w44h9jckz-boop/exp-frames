// Experiment 50: notes owned by a P-256 key (SIMULATED: a software key stands in for a device's
// enclave key), updated through the registry version 3, whose VERIFY checks the key's signature.
//
// Setup  deploy the verifier and both registries; deposit two keyed notes and one control note
//   A    keyed note 1, ARBITRARY route (P256VERIFY in VERIFY), with a change note to a fresh key  mined
//   B    the change note, P256 route (the protocol checks the signature)                          mined
//   D1-4 keyed note 2: a stranger's key, high s, no signature, a signature moved to another update refused
//   D5   a proof naming another owner than the note's                                             refused by the prover
//   C    keyed note 2, ARBITRARY route, spent whole                                               mined
//   E    the control registry's note, spent whole, no signature: C's shape without the check     mined
//
// usage: npx tsx experiments/50-device-key/run.ts [--dry-run]
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
  p256Address,
  sendFrameTx,
  simulateFrameTx,
  waitForFrameTxReceipt,
} from '../../src/frametx/index.js'
import { DENOMINATION, balance, isSpent, registryLeaves, rootSlot } from '../32-owned-state/registry.js'
import {
  FEE,
  type Registry,
  type Route,
  type Spend,
  checkSignature,
  control,
  depositFrame,
  deviceKey,
  innerOf,
  kernelInput,
  keyed,
  leafOf,
  nullifierOf,
  ownerOf,
  prove,
  proveInput,
  secretsOf,
  signUpdate,
  updateTx,
  verifier,
} from './device.js'

const client = makeClient()
const chainId = BigInt(await client.getChainId())
const { privateKey, address: funder } = loadKey()
const recipient = (label: string): Address => privateKeyToAddress(keccak256(concatHex([privateKey, toHex(`exp-frames/50/recipient/${label}`)])))

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
    rows.push({ step, outcome: `${why}; ${admission}` })
    if (expect === 'mined') throw new Error(`${step}: expected to be mined`)
    if (admission === 'ADMITTED') throw new Error(`${step}: admitted`)
    return
  }
  if (expect === 'refused') throw new Error(`${step}: expected a refusal, but simulation admits it`)
  const simFrames = sim.frames?.map((f) => BigInt(f.gasUsed)).join(' / ')
  if (DRY_RUN) {
    console.log(`${step}: valid in simulation, gasUsed ${BigInt(sim.gasUsed ?? '0x0')}; frames ${simFrames}`)
    rows.push({ step, outcome: 'valid in simulation', frames: simFrames })
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

// ---- the precompile ----

// EIP-7951's P256VERIFY at 0x100, called directly with a fresh signature and with a broken one.
{
  const k = deviceKey(privateKey, 'probe')
  const digest = keccak256(toHex('exp-frames/50/probe'))
  const { p256Sign } = await import('../../src/frametx/index.js')
  const sig = p256Sign(digest, k) // r s qx qy
  const good = concatHex([digest, sig])
  const bad = concatHex([digest, `0x${sig.slice(2, 66)}`, `0x${(BigInt(`0x${sig.slice(66, 130)}`) ^ 1n).toString(16).padStart(64, '0')}`, `0x${sig.slice(130)}`])
  const to = '0x0000000000000000000000000000000000000100'
  const a = await client.call({ to, data: good })
  const b = await client.call({ to, data: bad })
  const g = await client.estimateGas({ account: funder, to, data: good })
  const v = await client.request({ method: 'web3_clientVersion' as never })
  console.log(`P256VERIFY at 0x100: valid -> ${a.data}; broken s -> ${b.data ?? '(empty)'}; eth_estimateGas ${g}; client ${v}`)
}

// ---- setup ----

const owner1 = deviceKey(privateKey, 'owner/1')
const owner2 = deviceKey(privateKey, 'owner/2')
const owner3 = deviceKey(privateKey, 'owner/3') // the change note's: a fresh key
const stranger = deviceKey(privateKey, 'stranger')
console.log(`registry v3 ${keyed.address}, control ${control.address}, verifier ${verifier.address}, Balance ${balance.address}`)
console.log(`owner keys: 1 ${p256Address(owner1)}, 2 ${p256Address(owner2)}, 3 ${p256Address(owner3)}`)

const NOTE1 = 3n * DENOMINATION
const notes = [
  { label: 'keyed/1', r: keyed, secrets: secretsOf(privateKey, 'keyed/1'), owner: ownerOf(owner1), value: NOTE1 },
  { label: 'keyed/2', r: keyed, secrets: secretsOf(privateKey, 'keyed/2'), owner: ownerOf(owner2), value: DENOMINATION },
  { label: 'control', r: control, secrets: secretsOf(privateKey, 'control'), owner: ownerOf(owner2), value: DENOMINATION },
]

const missing = [verifier, keyed, control]
const absent = []
for (const c of missing) if (!(await client.getCode({ address: c.address }))) absent.push(c.deploy)
if (absent.length) await sendFrames(client, privateKey, absent, { label: 'setup: deploy the verifier and both registries' })
if (DRY_RUN && absent.length) process.exit(0)

const leavesOf = async (r: Registry) => (await registryLeaves(client, r.address)).map((l) => l.leaf)
for (const r of [keyed, control]) {
  const have = await leavesOf(r)
  const todo = notes.filter((n) => n.r === r && !have.includes(leafOf(balance.address, innerOf(n.secrets, n.owner), n.value)))
  if (todo.length) {
    await sendFrames(
      client,
      privateKey,
      todo.map((n, i) => depositFrame(r, balance.address, innerOf(n.secrets, n.owner), n.value, have.length === 0 && i === 0)),
      { label: `setup: deposit ${todo.map((n) => n.label).join(', ')}` },
    )
    if (DRY_RUN) process.exit(0)
  }
}

async function spendTx(r: Registry, s: Spend, route: Route) {
  const leaves = await leavesOf(r)
  const { root, update } = await prove(s, leaves)
  const slot = await rootSlot(client, root, r.address)
  if (slot === undefined) throw new Error('the proof root was never published to EIP-8272')
  return { root, slot, update, tx: updateTx({ chainId, r, root, slot, update, route }) }
}
const indexIn = async (r: Registry, inner: bigint, value: bigint) => {
  const i = (await leavesOf(r)).indexOf(leafOf(balance.address, inner, value))
  if (i < 0) throw new Error('note not in the tree')
  return i
}

// ---- A. keyed note 1, ARBITRARY route, change to owner 3 ----

const n1 = notes[0]
const changeSecrets = secretsOf(privateKey, 'keyed/1/change')
const changeInner = innerOf(changeSecrets, ownerOf(owner3))
if (!(await isSpent(client, nullifierOf(balance.address, n1.secrets), keyed.address))) {
  const a = await spendTx(
    keyed,
    {
      app: balance.address,
      secrets: n1.secrets,
      owner: n1.owner,
      state: n1.value,
      index: await indexIn(keyed, innerOf(n1.secrets, n1.owner), n1.value),
      withdrawn: DENOMINATION,
      newInner: changeInner,
      recipient: recipient('A'),
      fee: FEE,
    },
    'arbitrary',
  )
  const signed = signUpdate(a.tx, owner1)
  if (!checkSignature(signed, n1.owner)) throw new Error('A: the signature does not check offline')
  await send('A. note 1: 0.001 ETH out, 0.002 ETH to a fresh key; ARBITRARY, P256VERIFY in VERIFY', signed, 'mined')
} else console.log('A already mined')

// ---- B. the change note, P256 route ----

const changeValue = NOTE1 - DENOMINATION
if (!(await isSpent(client, nullifierOf(balance.address, changeSecrets), keyed.address))) {
  const b = await spendTx(
    keyed,
    {
      app: balance.address,
      secrets: changeSecrets,
      owner: ownerOf(owner3),
      state: changeValue,
      index: await indexIn(keyed, changeInner, changeValue),
      withdrawn: changeValue,
      recipient: recipient('B'),
      fee: FEE,
    },
    'p256',
  )
  await send('B. the change note: 0.002 ETH out; P256 entry checked by the protocol', signUpdate(b.tx, owner3), 'mined')
} else console.log('B already mined')

// ---- D and C. keyed note 2 ----

const n2 = notes[1]
const spend2: Spend = {
  app: balance.address,
  secrets: n2.secrets,
  owner: n2.owner,
  state: n2.value,
  index: await indexIn(keyed, innerOf(n2.secrets, n2.owner), n2.value),
  withdrawn: DENOMINATION,
  recipient: recipient('C'),
  fee: FEE,
}
if (!(await isSpent(client, nullifierOf(balance.address, n2.secrets), keyed.address))) {
  const c = await spendTx(keyed, spend2, 'arbitrary')
  await send("D1. note 2 signed by a stranger's P-256 key", signUpdate(c.tx, stranger), 'refused')
  await send('D2. note 2 signed by its owner with high s', signUpdate(c.tx, owner2, true), 'refused')
  await send('D3. note 2 with its secrets and a valid proof, and no signature', updateTx({ chainId, r: keyed, root: c.root, slot: c.slot, update: c.update, route: 'none' }), 'refused')
  // D4: the owner's signature for C, moved onto an update that pays someone else, with its own
  // valid proof for that recipient.
  const signedC = signUpdate(c.tx, owner2)
  const other = await spendTx(keyed, { ...spend2, recipient: recipient('D4') }, 'arbitrary')
  await send("D4. C's signature on an update paying another recipient", { ...other.tx, signatures: signedC.signatures }, 'refused')
  // D5: the prover is asked for note 2 under owner 1's key.
  try {
    await proveInput({ ...kernelInput(spend2, await leavesOf(keyed)), owner: ownerOf(owner1) })
    throw new Error('D5: proved note 2 under another owner')
  } catch (e) {
    const msg = (e as Error).message
    if (msg.startsWith('D5')) throw e
    console.log(`D5. the prover refuses note 2 under owner 1's key: ${msg.split('\n')[0].slice(0, 100)}`)
    rows.push({ step: "D5. note 2 proved under owner 1's key", outcome: 'refused by the prover: the witness fails at the root' })
  }
  await send('C. note 2: 0.001 ETH out, spent whole; ARBITRARY, P256VERIFY in VERIFY', signedC, 'mined')
} else console.log('C already mined')

// ---- E. the control ----

const nc = notes[2]
if (!(await isSpent(client, nullifierOf(balance.address, nc.secrets), control.address))) {
  const e = await spendTx(
    control,
    {
      app: balance.address,
      secrets: nc.secrets,
      owner: nc.owner,
      state: nc.value,
      index: await indexIn(control, innerOf(nc.secrets, nc.owner), nc.value),
      withdrawn: DENOMINATION,
      recipient: recipient('E'),
      fee: FEE,
    },
    'none',
  )
  await send('E. control: C\'s shape, no owner check, no signature', e.tx, 'mined')
} else console.log('E already mined')

console.log('\n| Step | Outcome | Tx | Block | gasUsed | Frames (status:execution+state) |\n|---|---|---|---|---|---|')
for (const r of rows) console.log(`| ${r.step} | ${r.outcome} | ${r.hash ?? ''} | ${r.block ?? ''} | ${r.gasUsed ?? ''} | ${r.frames ?? ''} |`)
for (const l of ['A', 'B', 'C', 'E']) console.log(`recipient ${l} ${recipient(l)}: ${formatEther(await client.getBalance({ address: recipient(l) }))} ETH`)
process.exit(0)
