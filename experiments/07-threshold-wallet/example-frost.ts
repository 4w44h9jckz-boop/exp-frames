// Experiment 07: a 2-of-3 threshold wallet whose key nobody holds. Alice, bob and carol run a
// distributed key generation once; afterwards any two of them sign with the group key in two
// rounds, and the chain sees one 52-byte Schnorr signature, the same shape whichever two signed.
//
// | Frame | Mode   | Flags                         | Target        | Signatures                                 |
// | 0     | VERIFY | APPROVE_EXECUTION_AND_PAYMENT | Null (sender) | ARBITRARY, msg ∅: address(R) ‖ z (52 bytes) |
// | 1     | SENDER | -                             | funder        |                                            |
//
// usage: npx tsx experiments/07-threshold-wallet/example-frost.ts [--dry-run]
import { formatEther, parseEther, sliceHex } from 'viem'
import { sendFrames } from '../../src/deploy.js'
import { loadKey } from '../../src/env.js'
import { DRY_RUN, execute } from '../../src/execute.js'
import { Approve, type FrameTx, frameSigHash, makeClient, prepareFrameTx, senderFrame, verifyFrame } from '../../src/frametx/index.js'
import { ID, arbitraryEntry, frostAccount, group, signFrost } from './account.js'
import { aggregate, encodeSignature, round1, round2 } from './frost.js'

const { privateKey, address: funder } = loadKey()
const client = makeClient()

const g = group(privateKey)
const account = frostAccount(g, 'exp-frames/07/frost-account/v1')
console.log(`group key x ${sliceHex(`0x${g.px.toString(16).padStart(64, '0')}`, 0, 8)}…, parity ${g.parity}; FrostAccount ${account.address}`)
for (const s of g.shares) console.log(`  member ${s.id} holds a share; its verification key is public, its secret is not`)

const FUNDING = parseEther('0.01')
const hasCode = Boolean(await client.getCode({ address: account.address }))
const balance = await client.getBalance({ address: account.address })

// Setup: the funder deploys the account (395 bytes of code is past what a first transaction may
// deploy for itself) and funds it.
if (!hasCode || balance < FUNDING / 2n) {
  const frames = []
  if (!hasCode) frames.push(account.deployBySender)
  if (balance < FUNDING / 2n) frames.push(senderFrame({ target: account.address, value: FUNDING - balance, execution: 30_000n }))
  await sendFrames(client, privateKey, frames, { label: 'setup: deploy and fund the FrostAccount' })
} else console.log('setup: already done')
if (DRY_RUN && !hasCode) process.exit(0)

const pay = senderFrame({ target: funder, value: parseEther('0.0001'), execution: 30_000n })
const unsigned = () =>
  prepareFrameTx(client, { sender: account.address, frames: [verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 20_000n }), pay], signatures: [arbitraryEntry()] })
const show = (tx: FrameTx) => {
  const sig = tx.signatures[0].signature
  console.log(`entry 0: ${(sig.length - 2) / 2} bytes, address(R) ${sliceHex(sig, 0, 20)}, z ${sliceHex(sig, 20, 28)}…`)
}

// A. Alice and bob sign.
{
  const tx = signFrost(await unsigned(), g, [ID.alice, ID.bob])
  show(tx)
  await execute(client, tx, [], { label: 'A. FrostAccount: transfer signed by alice and bob' })
}

// B. Bob and carol sign. Same group key, same account, same entry shape.
{
  const tx = signFrost(await unsigned(), g, [ID.bob, ID.carol])
  show(tx)
  await execute(client, tx, [], { label: 'B. FrostAccount: transfer signed by bob and carol' })
}

// C. All three start; carol commits in round 1 and then goes silent. Round 2 cannot finish
// without her response, because her commitment is already inside R. The coordinator drops her
// and restarts with fresh nonces from alice and bob: one wasted round trip, nothing on chain.
{
  console.log('\n=== C. carol goes silent after round 1; the coordinator restarts without her ===')
  const tx0 = await unsigned()
  const msg = frameSigHash(tx0)
  const r1 = [ID.alice, ID.bob, ID.carol].map((id) => round1(id))
  const cs = r1.map((r) => r.commitment)
  const responses = new Map(
    r1.filter((r) => r.nonces.id !== ID.carol).map((r) => [r.nonces.id, round2(g, g.shares.find((s) => s.id === r.nonces.id)!, r.nonces, msg, cs)]),
  )
  try {
    aggregate(g, msg, cs, responses)
    throw new Error('aggregated without carol')
  } catch (e) {
    console.log(`first attempt: ${(e as Error).message}; alice's and bob's nonces are now spent and discarded`)
  }
  const retry = new Map<bigint, bigint>()
  const r1b = [ID.alice, ID.bob].map((id) => round1(id))
  const csb = r1b.map((r) => r.commitment)
  for (const r of r1b) retry.set(r.nonces.id, round2(g, g.shares.find((s) => s.id === r.nonces.id)!, r.nonces, msg, csb))
  const tx = { ...tx0, signatures: [{ ...tx0.signatures[0], signature: encodeSignature(aggregate(g, msg, csb, retry)) }] }
  show(tx)
  await execute(client, tx, [], { label: 'C. FrostAccount: transfer signed by alice and bob on the second attempt' })
}

const [after, nonce] = await Promise.all([client.getBalance({ address: account.address }), client.getTransactionCount({ address: account.address })])
console.log(`\n${account.address}: ${formatEther(after)} ETH, nonce ${nonce}`)
