// Experiment 08: operating a 2-of-3 multisig on frames, with two account layouts:
//
//   code:    CodeProxy    → MultisigImpl, owner-set commitment in the proxy's code
//   storage: StorageProxy → MultisigImpl, owner-set commitment in slot 0
//
// | Frame | Mode    | Flags                         | Target        | Data                  | Signatures      |
// | (0)   | VERIFY  | 0                             | EXPIRY        | deadline              | (E only)        |
// | (0)   | DEFAULT | -                             | CREATE2       | salt ‖ initcode       | (A only)        |
// | 0     | VERIFY  | APPROVE_EXECUTION_AND_PAYMENT | Null (sender) | k ‖ owners            | k owners, msg ∅ |
// | 1…    | SENDER  | -                             | …             | the proposal's calls  |                 |
//
// A. each account deploys itself in its first transaction (Example 1b) and pays;
// B. two proposals at once, each on its own fresh EIP-8250 nonce key;
// C. a fee bump on a pending proposal: the old signatures no longer fit; re-signed, it replaces;
// D. cancelling a signed proposal that was never sent, by spending its nonce key;
// E. a proposal with a deadline;
// F. rotating the owner set (storage account only).
//
// usage: npx tsx experiments/08-multisig-ops/ops.ts [A] [B] [C] [D] [E] [F]   (default: all)
import { type Hex, formatEther, parseEther } from 'viem'
import { sendFrames } from '../../src/deploy.js'
import { execute } from '../../src/execute.js'
import {
  type FrameTx,
  type FrameTxFees,
  frameSigHash,
  rpc,
  senderFrame,
  serializeFrameTx,
  simulateFrameTx,
  waitForFrameTxReceipt,
} from '../../src/frametx/index.js'
import {
  type Account,
  type OwnerSet,
  account,
  alice,
  bob,
  carol,
  client,
  commitment,
  dave,
  funder,
  impl,
  privateKey,
  proposal,
  proposalKey,
  sign,
} from './multisig.js'

const parts = process.argv.slice(2).filter((a) => /^[A-F]$/.test(a))
const run = (p: string) => parts.length === 0 || parts.includes(p)
const stamp = Date.now()

const first: OwnerSet = { owners: [alice, bob, carol], k: 2 }
const second: OwnerSet = { owners: [alice, bob, dave], k: 2 }
const codeAcct = account('code', first, 'code-2of3/v1')
const storeAcct = account('storage', first, 'storage-2of3/v1')
const pay = (eth = '0.0001') => senderFrame({ target: funder, value: parseEther(eth), execution: 30_000n })

const detail = (e: Error) => e.message.split('\n').find((l) => l.startsWith('Details:'))?.slice(9) ?? e.message.split('\n')[0]
type Sent = { hash?: Hex; error?: string }
const send = (tx: FrameTx): Promise<Sent> => rpc<Hex>(client, 'eth_sendRawTransaction', [serializeFrameTx(tx)]).then((hash) => ({ hash }), (e: Error) => ({ error: detail(e) }))
const outcome = async (r: Sent) => {
  if (!r.hash) return `refused: ${r.error}`
  try {
    const receipt = await waitForFrameTxReceipt(client, r.hash, { timeoutMs: 40_000 })
    return `mined in block ${BigInt(receipt.blockNumber)} (${r.hash})`
  } catch {
    return `admitted, no receipt (${r.hash})`
  }
}
/** The owner set a storage account's slot 0 currently commits to. */
async function currentSet(acct: Account): Promise<OwnerSet> {
  if (acct.kind === 'code') return acct.initial
  const slot = await client.getStorageAt({ address: acct.address, slot: '0x0' })
  return slot === commitment(second) ? second : first
}
const keysOf = (s: OwnerSet, n = s.k) => s.owners.slice(0, n)

// Setup: deploy the shared implementation, prefund both counterfactual accounts.
{
  const frames = []
  if (!(await client.getCode({ address: impl.address }))) frames.push(impl.deploy)
  for (const a of [codeAcct, storeAcct]) {
    const balance = await client.getBalance({ address: a.address })
    if (balance < parseEther('0.005')) frames.push(senderFrame({ target: a.address, value: parseEther('0.01') - balance, execution: 30_000n, state: balance ? 0n : 183_600n }))
  }
  if (frames.length) await sendFrames(client, privateKey, frames, { label: 'setup: deploy MultisigImpl, prefund both accounts' })
  console.log(`MultisigImpl ${impl.address}\ncode account ${codeAcct.address}\nstorage account ${storeAcct.address}`)
}

// A. First transaction: deploy at tx.sender, validate through the proxy, pay.
if (run('A')) {
  for (const a of [codeAcct, storeAcct]) {
    if (await client.getCode({ address: a.address })) continue
    const tx = await proposal(a, first, [alice.address, bob.address], [pay()], { deploy: a.deployAtSender })
    await execute(client, await sign(tx, [alice.key, bob.key]), [], { label: `A. ${a.kind} account: deploy at tx.sender + transfer` })
  }
}

// B. Two proposals at once, on disjoint fresh nonce keys.
if (run('B')) {
  for (const a of [codeAcct, storeAcct]) {
    const set = await currentSet(a)
    const signers = keysOf(set)
    const txs = await Promise.all(
      ['1', '2'].map(async (n) => sign(await proposal(a, set, signers.map((s) => s.address), [pay()], { nonceKey: proposalKey(`B-${a.kind}-${stamp}-${n}`) }), signers.map((s) => s.key))),
    )
    console.log(`\n=== B. ${a.kind} account: two proposals on keys ${txs.map((t) => `0x${t.nonceKeys[0].toString(16).slice(0, 8)}…`).join(', ')} ===`)
    const results = [await send(txs[0]), await send(txs[1])]
    for (const [i, r] of results.entries()) console.log(`  proposal ${i + 1}: ${await outcome(r)}`)
  }
}

// C. A fee bump needs every signer again: the fees are inside the sig hash.
if (run('C')) {
  const a = codeAcct
  const set = await currentSet(a)
  const signers = keysOf(set)
  const base = (await client.getBlock({ blockTag: 'latest' })).baseFeePerGas ?? 0n
  const fees: FrameTxFees = { maxPriorityFeePerGas: 1_000n, maxFeePerGas: 2n * base + 2_000n, maxFeePerBlobGas: 0n }
  const up = (x: bigint) => (x * 110n + 99n) / 100n
  const bumped: FrameTxFees = { maxPriorityFeePerGas: up(fees.maxPriorityFeePerGas), maxFeePerGas: up(fees.maxFeePerGas), maxFeePerBlobGas: 0n }
  const nonceKey = proposalKey(`C-${stamp}`)
  const original = await sign(await proposal(a, set, signers.map((s) => s.address), [pay()], { nonceKey, fees }), signers.map((s) => s.key))
  const stale: FrameTx = { ...original, fees: bumped }
  const resigned = await sign({ ...stale, signatures: stale.signatures.map((s) => ({ ...s, signature: '0x' as Hex })) }, signers.map((s) => s.key))
  console.log(`\n=== C. fee bump on key 0x${nonceKey.toString(16).slice(0, 8)}…: ${fees.maxPriorityFeePerGas}/${fees.maxFeePerGas} -> ${bumped.maxPriorityFeePerGas}/${bumped.maxFeePerGas} ===`)
  console.log(`  sig hash before ${frameSigHash(original).slice(0, 10)}…, after ${frameSigHash(stale).slice(0, 10)}…`)
  const r1 = await send(original)
  const simStale = await simulateFrameTx(client, stale).catch((e: Error) => ({ valid: 'error', violation: detail(e) }))
  const r2 = await send(stale)
  const r3 = await send(resigned)
  console.log(`  original: ${r1.hash ?? r1.error}`)
  console.log(`  bumped, old signatures: simulate valid=${simStale.valid} (${simStale.violation}); send: ${r2.hash ?? r2.error}`)
  console.log(`  bumped, re-signed by ${signers.length} owners: ${r3.hash ?? r3.error}`)
  for (const [label, r] of [['original', r1], ['re-signed', r3]] as const) console.log(`  ${label}: ${await outcome(r)}`)
}

// D. Cancel a proposal that was signed but never sent: spend its nonce key with an empty proposal.
if (run('D')) {
  const a = codeAcct
  const set = await currentSet(a)
  const signers = keysOf(set)
  const nonceKey = proposalKey(`D-${stamp}`)
  const doomed = await sign(await proposal(a, set, signers.map((s) => s.address), [pay('0.002')], { nonceKey }), signers.map((s) => s.key))
  console.log(`\n=== D. cancel by spending the key ===`)
  console.log(`  before: the signed proposal simulates valid=${(await simulateFrameTx(client, doomed)).valid}`)
  const cancel = await sign(await proposal(a, set, signers.map((s) => s.address), [], { nonceKey }), signers.map((s) => s.key))
  await execute(client, cancel, [], { label: 'D. the owners spend the key with a VERIFY-only transaction' })
  const after = await simulateFrameTx(client, doomed)
  console.log(`  after: the signed proposal simulates valid=${after.valid} (${after.violation})`)
}

// E. A proposal with a deadline.
if (run('E')) {
  const a = codeAcct
  const set = await currentSet(a)
  const signers = keysOf(set)
  const deadline = (await client.getBlock({ blockTag: 'latest' })).timestamp + 120n
  const tx = await sign(await proposal(a, set, signers.map((s) => s.address), [pay()], { nonceKey: proposalKey(`E-${stamp}`), deadline }), signers.map((s) => s.key))
  await execute(client, tx, [], { label: `E. a proposal valid until ${deadline} (head + 120 s)` })
}

// F. Rotate the owner set of the storage account, from whichever set it holds to the other.
if (run('F')) {
  const a = storeAcct
  const from = await currentSet(a)
  const to = from === first ? second : first
  const signers = keysOf(from)
  const rotate = senderFrame({ target: a.address, data: `0x01${commitment(to).slice(2)}`, execution: 60_000n })
  const tx = await sign(await proposal(a, from, signers.map((s) => s.address), [rotate]), signers.map((s) => s.key))
  await execute(client, tx, [], { label: `F. rotate: {${from.owners.map((o) => o.address.slice(0, 6)).join(',')}} -> {${to.owners.map((o) => o.address.slice(0, 6)).join(',')}}` })
  const old = await sign(await proposal(a, from, signers.map((s) => s.address), [pay()]), signers.map((s) => s.key))
  const oldSim = await simulateFrameTx(client, old)
  console.log(`  old owner set now: valid=${oldSim.valid} (${oldSim.violation})`)
  const newSigners = to.owners.filter((o) => !from.owners.includes(o)).concat(to.owners.filter((o) => from.owners.includes(o))).slice(0, to.k)
  const fresh = await sign(await proposal(a, to, newSigners.map((s) => s.address), [pay()]), newSigners.map((s) => s.key))
  await execute(client, fresh, [], { label: `F. the new set pays (${newSigners.map((s) => s.address.slice(0, 6)).join(' + ')})` })
}

for (const a of [codeAcct, storeAcct]) console.log(`${a.kind} ${a.address}: ${formatEther(await client.getBalance({ address: a.address }))} ETH`)
