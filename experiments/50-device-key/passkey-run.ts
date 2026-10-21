// Experiment 50's addendum: notes owned by a WebAuthn passkey (SIMULATED: a software key and a
// software authenticator), checked by registry version 4's VERIFY. README, "Addendum".
//
// Setup  deploy version 4; deposit P1 and P2 in it, and one more note in version 3
//   budget  P1's and P2's updates offered over the budget: the node's computed prefix budget
//   N1-N8   refusals, each attributed to the node or to the registry
//   P1      a passkey-owned note updated                                                    mined
//   P2      the same with one more clientDataJSON field: a longer entry                    mined
//
// usage: npx tsx experiments/50-device-key/passkey-run.ts
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { type Address, type Hex, concatHex, keccak256, toHex } from 'viem'
import { privateKeyToAddress } from 'viem/accounts'
import { REPO_ROOT } from '../../src/contracts.js'
import { sendFrames } from '../../src/deploy.js'
import { loadKey } from '../../src/env.js'
import {
  type FrameTx,
  frameReceiptGas,
  frameReceiptStatus,
  frameSigHash,
  makeClient,
  sendFrameTx,
  simulateFrameTx,
  waitForFrameTxReceipt,
} from '../../src/frametx/index.js'
import { DENOMINATION, balance, isSpent, registryLeaves, rootSlot } from '../32-owned-state/registry.js'
import {
  DIR,
  FEE,
  type Registry,
  type Route,
  type Spend,
  depositFrame,
  deviceKey,
  innerOf,
  keyed as v3,
  leafOf,
  nullifierOf,
  ownerOf,
  prove,
  secretsOf,
  signUpdate,
  updateTx,
} from './device.js'
import { type Assertion, signPasskey, v4 } from './passkey.js'

const client = makeClient()
const chainId = BigInt(await client.getChainId())
const { privateKey } = loadKey()
const recipient = (label: string): Address => privateKeyToAddress(keccak256(concatHex([privateKey, toHex(`exp-frames/50/addendum/recipient/${label}`)])))

type Row = { step: string; by: string; outcome: string; hash?: Hex; block?: string; gasUsed?: string; frames?: string }
const rows: Row[] = []
const record: Record<string, unknown> = { registryV4: v4.address }

/** Who refused: the registry's VERIFY reverting, or the node before any frame ran. */
const attribute = (violation: string | null) =>
  violation === 'validation prefix frame reverted' ? 'the registry (its VERIFY reverted)' : 'the node'

async function refuse(step: string, tx: FrameTx, simulationMayAdmit = false) {
  const sim = await simulateFrameTx(client, tx)
  const simOk = sim.valid && sim.executionStatus === 'success'
  if (simOk && !simulationMayAdmit) throw new Error(`${step}: expected a refusal`)
  let admission = 'not sent'
  try {
    await sendFrameTx(client, tx)
    throw new Error(`${step}: admitted`)
  } catch (e) {
    if ((e as Error).message.endsWith('admitted')) throw e
    admission = `eth_sendRawTransaction refused: ${(e as Error).message.split('\n').find((l) => /refused|invalid|Invalid|chain|Missing/.test(l))?.trim().slice(0, 120) ?? (e as Error).message.split('\n')[0].slice(0, 120)}`
  }
  const why = simOk ? 'the simulation endpoint calls it valid' : sim.valid ? `valid, but a frame reverts (${sim.executionError})` : `refused: ${sim.violation}`
  console.log(`${step}: ${why}; ${admission}`)
  const by = simOk ? 'the node, at admission (not its simulation endpoint)' : sim.valid ? 'the registry, in execution' : attribute(sim.violation)
  rows.push({ step, by, outcome: `${why}; ${admission}` })
}

async function mine(step: string, tx: FrameTx) {
  const sim = await simulateFrameTx(client, tx)
  if (!sim.valid || sim.executionStatus !== 'success') throw new Error(`${step}: ${sim.violation ?? sim.executionError}`)
  const hash = await sendFrameTx(client, tx)
  const r = await waitForFrameTxReceipt(client, hash)
  const frames = r.frameReceipts.map((f) => {
    const g = frameReceiptGas(f)
    return `${frameReceiptStatus(f)}:${g.execution}${g.state ? `+${g.state}s` : ''}`
  })
  console.log(`${step}: ${hash} block ${BigInt(r.blockNumber)} gasUsed ${BigInt(r.gasUsed)} frames ${frames.join(' / ')}`)
  rows.push({ step, by: '', outcome: 'mined', hash, block: BigInt(r.blockNumber).toString(), gasUsed: BigInt(r.gasUsed).toString(), frames: frames.join(' / ') })
  if (!r.frameReceipts.every((f) => frameReceiptStatus(f) === 1)) throw new Error(`${step}: a frame failed`)
}

/** The node's computed prefix budget, read from its refusal of an over-budget VERIFY limit. */
async function budget(tx: FrameTx, label: string) {
  const over = structuredClone(tx)
  over.frames[1].limits.execution = 600_000n
  const sim = await simulateFrameTx(client, over)
  const m = /(\d+) > (\d+)/.exec(sim.violation ?? '')
  const limits = over.frames.filter((f) => f.mode === 1).reduce((s, f) => s + f.limits.execution, 0n)
  const counted = m ? BigInt(m[1]) - limits : undefined
  console.log(`${label}: entry ${(over.signatures[0].signature.length - 2) / 2} bytes; node: "${sim.violation}"; VERIFY frames' limits ${limits}; counted for signatures ${counted}`)
  return { entryBytes: (over.signatures[0].signature.length - 2) / 2, violation: sim.violation, prefixLimits: limits.toString(), countedForSignatures: counted?.toString() }
}

// ---- setup ----

const k1 = deviceKey(privateKey, 'addendum/passkey/1')
const k2 = deviceKey(privateKey, 'addendum/passkey/2')
const k5 = deviceKey(privateKey, 'addendum/v3/5')
const stranger = deviceKey(privateKey, 'addendum/stranger')
const notes = [
  { label: 'P1', r: v4, key: k1, secrets: secretsOf(privateKey, 'addendum/P1'), value: DENOMINATION },
  { label: 'P2', r: v4, key: k2, secrets: secretsOf(privateKey, 'addendum/P2'), value: DENOMINATION },
  { label: 'V3', r: v3, key: k5, secrets: secretsOf(privateKey, 'addendum/V3'), value: DENOMINATION },
]
console.log(`registry v4 ${v4.address}`)
if (!(await client.getCode({ address: v4.address }))) await sendFrames(client, privateKey, [v4.deploy], { label: 'setup: deploy registry version 4' })
const leavesOf = async (r: Registry) => (await registryLeaves(client, r.address)).map((l) => l.leaf)
for (const r of [v4, v3]) {
  const have = await leavesOf(r)
  const todo = notes.filter((n) => n.r === r && !have.includes(leafOf(balance.address, innerOf(n.secrets, ownerOf(n.key)), n.value)))
  if (todo.length) {
    await sendFrames(client, privateKey, todo.map((n, i) => depositFrame(r, balance.address, innerOf(n.secrets, ownerOf(n.key)), n.value, have.length === 0 && i === 0)), {
      label: `setup: deposit ${todo.map((n) => n.label).join(', ')}`,
    })
  }
}

async function update(n: (typeof notes)[number], to: Address, route: Route, chain = chainId) {
  const leaves = await leavesOf(n.r)
  const index = leaves.indexOf(leafOf(balance.address, innerOf(n.secrets, ownerOf(n.key)), n.value))
  const s: Spend = { app: balance.address, secrets: n.secrets, owner: ownerOf(n.key), state: n.value, index, withdrawn: n.value, recipient: to, fee: FEE }
  const { root, update: u } = await prove(s, leaves)
  const slot = await rootSlot(client, root, n.r.address)
  if (slot === undefined) throw new Error('root not published')
  return updateTx({ chainId: chain, r: n.r, root, slot, update: u, route })
}

const [P1, P2, V3] = notes
const assertions: Record<string, Assertion> = {}

// ---- P1, its refusals, its budget ----

if (!(await isSpent(client, nullifierOf(balance.address, P1.secrets), v4.address))) {
  const base = await update(P1, recipient('P1'), 'arbitrary')
  const good = signPasskey(base, k1)
  record.budgetP1 = await budget(good.tx, 'budget P1')
  await refuse('N1. a challenge that is not the signature hash', signPasskey(base, k1, { challenge: keccak256(toHex('another challenge')) }).tx)
  await refuse('N2. the user-presence flag clear', signPasskey(base, k1, { flags: 0x04 }).tx)
  await refuse("N3. another relying party's hash", signPasskey(base, k1, { rpId: 'another.example' }).tx)
  await refuse('N4. eight trailing bytes after the declared parts', signPasskey(base, k1, { trailing: '0x0000000000000000' }).tx)
  await refuse('N5. high s', signPasskey(base, k1, { highS: true }).tx)
  await refuse("N6. a stranger's passkey", signPasskey(base, stranger).tx)
  // N7: the assertion made over the signature hash this same update has with another chain ID.
  const other = await update(P1, recipient('P1'), 'arbitrary', 1n)
  await refuse('N7. an assertion over the same update on another chain, sent here', { ...base, signatures: signPasskey(other, k1).tx.signatures })
  await refuse('N8. the same update, signed for and sent with another chain ID', signPasskey(other, k1).tx, true)
  assertions.P1 = good.assertion
  record.sigHashP1 = frameSigHash(good.tx)
  await mine('P1. a passkey-owned note updated through the WebAuthn arm', good.tx)
} else console.log('P1 already mined')

// ---- P2: a longer entry; P1's assertion on it ----

if (!(await isSpent(client, nullifierOf(balance.address, P2.secrets), v4.address))) {
  const base = await update(P2, recipient('P2'), 'arbitrary')
  const good = signPasskey(base, k2, { extra: { other_keys_can_be_added_here: 'do not compare clientDataJSON against a template' } })
  record.budgetP2 = await budget(good.tx, 'budget P2')
  if (assertions.P1) await refuse("N9. P1's assertion reused on P2's update", { ...base, signatures: [{ ...base.signatures[0], signature: assertions.P1.entry }] })
  assertions.P2 = good.assertion
  record.sigHashP2 = frameSigHash(good.tx)
  await mine('P2. the same, with one more clientDataJSON field', good.tx)
} else console.log('P2 already mined')

// ---- N10: the protocol's own P256 entry, high s, on version 3 ----

if (!(await isSpent(client, nullifierOf(balance.address, V3.secrets), v3.address))) {
  await refuse('N10. a protocol P256 entry with high s, registry version 3', signUpdate(await update(V3, recipient('V3'), 'p256'), k5, true))
}

record.assertions = assertions
record.rows = rows
writeFileSync(resolve(REPO_ROOT, DIR, 'record-addendum.json'), `${JSON.stringify(record, null, 2)}\n`)
console.log('\n| Step | Refused by | Outcome | Tx | Block | gasUsed | Frames |\n|---|---|---|---|---|---|---|')
for (const r of rows) console.log(`| ${r.step} | ${r.by} | ${r.outcome} | ${r.hash ?? ''} | ${r.block ?? ''} | ${r.gasUsed ?? ''} | ${r.frames ?? ''} |`)
process.exit(0)
