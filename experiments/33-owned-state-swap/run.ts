// Experiment 33: two wallets that do not know each other swap owned state. Alice holds 0.002 ETH
// of asset A and wants 0.001 ETH of asset B; Bob holds that. They find each other through an
// encrypted announcement on the board, agree through a second one, exchange proofs off chain, and
// settle in one frame transaction that spends both notes or neither, with no third party.
//
//   N1  offer, answer, Alice's proof, Bob's proof, the swap mined; Alice spends what she got
//   N2  the same up to both proofs, with a short deadline that passes: the swap is refused
//   N3  the same with a long deadline, and Alice cancels by spending her note: the swap is refused
//
// After every step of N1 and at the end of N2 and N3, each note is checked to be spendable by its
// owner alone: the owner's own update is valid in simulation. In N1, between the two proofs,
// Bob tries to settle with Alice's proof only, and to settle while keeping his own note's value.
//
// Messages are sealed to the recipient's key and posted by the funder, standing in for whoever
// relays them. The proofs pass between the two wallets in this process.
//
// usage: npx tsx experiments/33-owned-state-swap/run.ts [run label, default 1]
import { type Address, type Hex, concatHex, formatEther, keccak256, toHex } from 'viem'
import { privateKeyToAddress } from 'viem/accounts'
import { sendFrames } from '../../src/deploy.js'
import { loadKey } from '../../src/env.js'
import { type FrameTx, frameReceiptGas, frameReceiptStatus, makeClient, sendFrameTx, simulateFrameTx, waitForFrameTxReceipt } from '../../src/frametx/index.js'
import {
  DENOMINATION,
  FEE,
  type Update,
  innerOf,
  isSpent,
  leafOf,
  nullifierOf,
  prove,
  registryAbi,
  registryLeaves,
  rootSlot,
  secretsOf,
  treeOf,
} from '../32-owned-state/registry.js'
import { type Offer, decodeAccept, decodeOffer, encodeAccept, encodeOffer, keysOf, offerId, scan, seal } from './announce.js'
import { type Held, assetA, assetB, board, depositFrame, pairLink, postFrame, registry, soloSpend, swapSpend, updateTx } from './swap.js'

const client = makeClient()
const chainId = BigInt(await client.getChainId())
const { privateKey } = loadKey()
const RUN = process.argv[2] ?? '1'
const label = (s: string) => `swap/${RUN}/${s}`
const recipient = (s: string): Address => privateKeyToAddress(keccak256(concatHex([privateKey, toHex(`exp-frames/33/recipient/${RUN}/${s}`)])))
const A_VALUE = 2n * DENOMINATION
const B_VALUE = DENOMINATION
const alice = keysOf(privateKey, `${RUN}/alice`)
const bob = keysOf(privateKey, `${RUN}/bob`)

type Row = { step: string; outcome: string; hash?: Hex; block?: bigint; gasUsed?: bigint; frames?: string }
const rows: Row[] = []
const head = async () => (await client.getBlock({ blockTag: 'latest' })).timestamp

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
  rows.push({ step, outcome: 'mined', hash, block: BigInt(r.blockNumber), gasUsed: BigInt(r.gasUsed), frames: frames.join(' / ') })
  if (!r.frameReceipts.every((f) => frameReceiptStatus(f) === 1)) throw new Error(`${step}: a frame failed`)
}

async function refused(step: string, tx: FrameTx) {
  const sim = await simulateFrameTx(client, tx)
  if (sim.valid && sim.executionStatus === 'success') throw new Error(`${step}: expected a refusal`)
  let admission = 'not sent'
  if (!sim.valid) {
    try {
      await sendFrameTx(client, tx)
      admission = 'ADMITTED'
    } catch (e) {
      admission = `eth_sendRawTransaction refused: ${(e as Error).message.split('\n')[0].slice(0, 80)}`
    }
  }
  const why = sim.valid ? `valid, but a frame reverts (${sim.executionError})` : `refused: ${sim.violation}`
  console.log(`${step}: ${why}; ${admission}`)
  rows.push({ step, outcome: why })
  if (admission === 'ADMITTED') throw new Error(`${step}: the node admitted it`)
}

async function post(step: string, message: Hex) {
  const r = await sendFrames(client, privateKey, [postFrame(message)], { label: step })
  const receipt = r?.receipt
  if (!receipt) throw new Error(`${step}: not mined`)
  rows.push({ step, outcome: 'mined', hash: r.hash, block: BigInt(receipt.blockNumber), gasUsed: BigInt(receipt.gasUsed) })
}

// ---- setup ----

console.log(`registry v2 ${registry.address}; asset A ${assetA.address}; asset B ${assetB.address}; board ${board.address}`)
const missing = []
for (const c of [registry, assetB, board]) if (!(await client.getCode({ address: c.address }))) missing.push(c.deploy)
if (missing.length) await sendFrames(client, privateKey, missing, { label: 'setup: deploy registry v2, asset B and the board' })

const notes = {
  a1: { app: assetA.address, secrets: secretsOf(privateKey, label('alice/1')), state: A_VALUE },
  b1: { app: assetB.address, secrets: secretsOf(privateKey, label('bob/1')), state: B_VALUE },
  a2: { app: assetA.address, secrets: secretsOf(privateKey, label('alice/2')), state: A_VALUE },
  b2: { app: assetB.address, secrets: secretsOf(privateKey, label('bob/2')), state: B_VALUE },
}
for (const n of Object.values(notes)) {
  if (await isSpent(client, nullifierOf(n.app, n.secrets), registry.address)) throw new Error(`run ${RUN} was already used; pass another run label`)
}
let leaves = await registryLeaves(client, registry.address)
const todo = Object.entries(notes).filter(([, n]) => !leaves.some((l) => l.leaf === leafOf(n.app, innerOf(n.secrets), n.state)))
if (todo.length) {
  const frames = todo.map(([, n], i) => depositFrame(n.app, innerOf(n.secrets), n.state, leaves.length === 0 && i === 0))
  await sendFrames(client, privateKey, frames, { label: `setup: deposit ${todo.map(([k]) => k).join(', ')}` })
  leaves = await registryLeaves(client, registry.address)
}
const held = (n: (typeof notes)['a1']): Held => {
  const index = leaves.findIndex((l) => l.leaf === leafOf(n.app, innerOf(n.secrets), n.state))
  if (index < 0) throw new Error('note not in the tree')
  return { ...n, index }
}

/** The leaves as they were when the tree had `root`. */
function leavesAt(root: bigint): bigint[] {
  const all = leaves.map((l) => l.leaf)
  for (let n = all.length; n > 0; n--) if (treeOf(all.slice(0, n)).root === root) return all.slice(0, n)
  throw new Error('no prefix of the tree has that root')
}

async function currentRoot() {
  leaves = await registryLeaves(client, registry.address)
  const root = treeOf(leaves.map((l) => l.leaf)).root
  const slot = await rootSlot(client, root, registry.address)
  if (slot === undefined) throw new Error('the current root was never published to EIP-8272')
  return { root, slot }
}

// Each owner's own update of each note, proven once and simulated after every step.
const far = (await head()) + 3600n
const solo = new Map<string, FrameTx>()
async function soloTx(name: string, n: Held) {
  const { root, slot } = await currentRoot()
  const { update } = await prove(soloSpend(n, recipient(`solo/${name}`), far), leavesAt(root))
  return updateTx({ chainId, root, slot, deadline: far, updates: [update] })
}
async function spendable(when: string, names: string[]) {
  for (const name of names) {
    const sim = await simulateFrameTx(client, solo.get(name)!)
    const ok = sim.valid && sim.executionStatus === 'success'
    console.log(`  ${when}: ${name} spendable by its owner alone: ${ok ? 'yes' : `NO (${sim.violation ?? sim.executionError})`}`)
    rows.push({ step: `${when}: ${name}, its owner's own update`, outcome: ok ? 'valid' : `NOT VALID: ${sim.violation ?? sim.executionError}` })
    if (!ok) throw new Error(`${when}: ${name} is not spendable by its owner alone`)
  }
}

// ---- one negotiation ----

type Party = { keys: typeof alice; note: Held; receive: ReturnType<typeof secretsOf> }

async function negotiate(n: string, a: Party, b: Party, deadline: bigint, opts: { checkAborts: boolean; tryCheating: boolean }) {
  const names = [`${n} Alice's note`, `${n} Bob's note`]
  // 1. Alice's offer, sealed to Bob's key, on the board.
  const offer: Offer = {
    registry: registry.address,
    give: { app: a.note.app, value: a.note.state },
    want: { app: b.note.app, value: b.note.state },
    deadline,
    nullifier: nullifierOf(a.note.app, a.note.secrets),
    receiveInner: innerOf(a.receive),
    replyKey: a.keys.public,
  }
  const offerMessage = seal(bob.public, encodeOffer(offer), keysOf(privateKey, `${RUN}/${n}/offer`))
  await post(`${n}. Alice posts her offer, sealed to Bob`, offerMessage)
  if (opts.checkAborts) await spendable(`${n}, after the offer`, names)

  // 2. Bob scans the board and finds it.
  const found = (await scan(client, board.address, b.keys.secret)).map((m) => ({ ...m, offer: decodeOffer(m.plaintext) })).filter((m) => m.message === offerMessage)
  if (found.length !== 1 || !found[0].offer) throw new Error(`${n}: Bob did not find the offer`)
  const got = found[0].offer
  console.log(`  ${n}: Bob's scan opened the offer posted in ${found[0].tx}: gives ${formatEther(got.give.value)} of ${got.give.app}, wants ${formatEther(got.want.value)} of ${got.want.app}`)

  // 3. Bob's answer, sealed to the key in the offer.
  const { root, slot } = await currentRoot()
  const accept = { offer: offerId(offerMessage), nullifier: nullifierOf(b.note.app, b.note.secrets), receiveInner: innerOf(b.receive), root, slot }
  const acceptMessage = seal(got.replyKey, encodeAccept(accept), keysOf(privateKey, `${RUN}/${n}/accept`))
  await post(`${n}. Bob posts his answer, sealed to Alice`, acceptMessage)
  if (opts.checkAborts) await spendable(`${n}, after the answer`, names)
  const answers = (await scan(client, board.address, a.keys.secret)).map((m) => decodeAccept(m.plaintext)).filter((x) => x?.offer === offerId(offerMessage))
  if (answers.length !== 1) throw new Error(`${n}: Alice did not find the answer`)
  const ans = answers[0]!

  // 4. Alice proves her side and hands it to Bob.
  const tree = leavesAt(ans.root)
  const aSpend = swapSpend(a.note, { app: b.note.app, nullifier: ans.nullifier, state: offer.want.value }, ans.receiveInner, offer.receiveInner, deadline)
  const aUpdate = (await prove(aSpend, tree)).update
  if (opts.checkAborts) await spendable(`${n}, Alice's proof with Bob`, names)
  if (opts.tryCheating) {
    // Bob settles with Alice's proof alone.
    await refused(`${n}. Bob settles with Alice's proof alone`, updateTx({ chainId, root: ans.root, slot: ans.slot, deadline, updates: [aUpdate] }))
    // Bob pairs it with an update that takes his own note's value out to himself.
    const selfish = soloSpend(b.note, recipient(`${n}/bob-keeps`), deadline)
    selfish.link = pairLink(aUpdate.nullifier, aUpdate.newCommitment)
    const keep = (await prove(selfish, tree)).update
    await refused(`${n}. Bob pairs it with his note paid to himself`, updateTx({ chainId, root: ans.root, slot: ans.slot, deadline, updates: sorted([aUpdate, keep]) }))
  }

  // 5. Bob proves his side and hands it to Alice: either can now settle.
  const bSpend = swapSpend(b.note, { app: got.give.app, nullifier: got.nullifier, state: got.give.value }, got.receiveInner, accept.receiveInner, got.deadline)
  const bUpdate = (await prove(bSpend, tree)).update
  if (opts.checkAborts) await spendable(`${n}, both proofs exchanged`, names)
  return updateTx({ chainId, root: ans.root, slot: ans.slot, deadline, updates: sorted([aUpdate, bUpdate]) })
}

const sorted = (us: Update[]) => [...us].sort((x, y) => (x.nullifier < y.nullifier ? -1 : 1))

// ---- N1: the swap ----

const n1 = { a: held(notes.a1), b: held(notes.b1) }
solo.set("N1 Alice's note", await soloTx('a1', n1.a))
solo.set("N1 Bob's note", await soloTx('b1', n1.b))
const aliceReceive1 = secretsOf(privateKey, label('alice/1/receive'))
const bobReceive1 = secretsOf(privateKey, label('bob/1/receive'))
const swap1 = await negotiate('N1', { keys: alice, note: n1.a, receive: aliceReceive1 }, { keys: bob, note: n1.b, receive: bobReceive1 }, (await head()) + 1800n, { checkAborts: true, tryCheating: true })
await mine('N1. Bob settles the swap', swap1)

// The new owners' notes: Alice's in asset B, Bob's in asset A.
leaves = await registryLeaves(client, registry.address)
const aliceGot: Held = { app: assetB.address, secrets: aliceReceive1, state: B_VALUE - FEE, index: -1 }
const bobGot: Held = { app: assetA.address, secrets: bobReceive1, state: A_VALUE - FEE, index: -1 }
for (const g of [aliceGot, bobGot]) {
  g.index = leaves.findIndex((l) => l.leaf === leafOf(g.app, innerOf(g.secrets), g.state))
  if (g.index < 0) throw new Error('a swapped note is not in the tree')
}
solo.set("Bob's new note (asset A)", await soloTx('bob-got', bobGot))
await spendable('N1, after the swap', ["Bob's new note (asset A)"])
await mine('N1. Alice spends the asset-B note she got', await soloTx('alice-got', aliceGot))
for (const [name, n] of [["N1 Alice's note", n1.a], ["N1 Bob's note", n1.b]] as const) {
  const spent = await isSpent(client, nullifierOf(n.app, n.secrets), registry.address)
  rows.push({ step: `N1, after the swap: ${name}`, outcome: spent ? 'spent by the swap' : 'NOT SPENT' })
  if (!spent) throw new Error(`${name} was not spent by the swap`)
}

// ---- N2: a deadline that passes ----

const n2 = { a: held(notes.a2), b: held(notes.b2) }
solo.set("N2 Alice's note", await soloTx('a2', n2.a))
solo.set("N2 Bob's note", await soloTx('b2', n2.b))
const short = (await head()) + 150n
const swap2 = await negotiate('N2', { keys: alice, note: n2.a, receive: secretsOf(privateKey, label('alice/2/receive')) }, { keys: bob, note: n2.b, receive: secretsOf(privateKey, label('bob/2/receive')) }, short, { checkAborts: false, tryCheating: false })
const before = await simulateFrameTx(client, swap2)
if (!before.valid || before.executionStatus !== 'success') throw new Error(`N2: the swap is not valid before its deadline (${before.violation})`)
rows.push({ step: 'N2. the swap, before the deadline', outcome: 'valid in simulation' })
console.log(`N2: the swap is valid in simulation ${short - (await head())} s before its deadline; nobody sends it`)
while ((await head()) <= short) await new Promise((r) => setTimeout(r, 3000))
await refused('N2. Bob settles after the deadline', swap2)
await spendable('N2, after the deadline', ["N2 Alice's note", "N2 Bob's note"])

// ---- N3: Alice cancels ----

const swap3 = await negotiate('N3', { keys: alice, note: n2.a, receive: secretsOf(privateKey, label('alice/3/receive')) }, { keys: bob, note: n2.b, receive: secretsOf(privateKey, label('bob/3/receive')) }, (await head()) + 1800n, { checkAborts: false, tryCheating: false })
await mine('N3. Alice cancels: she spends her note herself', solo.get("N2 Alice's note")!)
await refused('N3. Bob settles after the cancel', swap3)
await spendable('N3, after the cancel', ["N2 Bob's note"])

// ---- summary ----

console.log('\n| Step | Outcome | Tx | Block | gasUsed | Frames (status:execution+state) |\n|---|---|---|---|---|---|')
for (const r of rows) console.log(`| ${r.step} | ${r.outcome} | ${r.hash ?? ''} | ${r.block ?? ''} | ${r.gasUsed ?? ''} | ${r.frames ?? ''} |`)
console.log(`registry v2 root ${toHex(BigInt(await client.readContract({ address: registry.address, abi: registryAbi, functionName: 'getLastRoot' })))}`)
process.exit(0)
