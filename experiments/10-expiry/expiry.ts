// Experiment 10: the expiry verifier frame, the one place the validation prefix may read the
// clock. A VERIFY frame to EXPIRY_VERIFIER (0x…8141 on this testnet) carrying an 8-byte deadline;
// it reverts, invalidating the transaction, once block.timestamp > deadline.
//
// | Frame | Mode   | Flags                         | Target          | Data               |
// | 0     | VERIFY | 0                             | EXPIRY_VERIFIER | deadline (8 B, BE) |
// | 1     | VERIFY | APPROVE_EXECUTION_AND_PAYMENT | Null (sender)   |                    |
// | 2     | SENDER | -                             | funder          | 0.0001 ETH         |
//
// A. a deadline two minutes out: mined.
// B. deadlines from the head's timestamp to two slots past it (slots are 6 s): what the pool
//    admits, and what is mined.
// C. a deadline already past: refused.
// D. a DEFAULT frame to the same contract after the prefix is not an expiry verifier frame: a
//    past deadline there fails the frame, not the transaction.
//
// pool.ts does the mempool half: a transaction that sits in the pool past its deadline.
//
// usage: npx tsx experiments/10-expiry/expiry.ts [A] [B] [C] [D]   (default: all)
import { type Hex, formatEther } from 'viem'
import { execute } from '../../src/execute.js'
import {
  EXPIRY_VERIFIER,
  defaultFrame,
  expiryFrame,
  prepareFrameTx,
  secp256k1Placeholder,
} from '../../src/frametx/index.js'
import { client, eoaTx, follow, fundedAccount, funder, headTimestamp, privateKey, probe, selfVerify, tip } from './common.js'

const parts = process.argv.slice(2).filter((a) => /^[A-D]$/.test(a))
const run = (part: string) => parts.length === 0 || parts.includes(part)
const encodeDeadline = (t: bigint): Hex => `0x${t.toString(16).padStart(16, '0')}`
const late = await fundedAccount('late')

// A. A deadline two minutes out.
if (run('A')) {
  const deadline = (await headTimestamp()) + 120n
  const tx = await prepareFrameTx(client, {
    sender: funder,
    frames: [expiryFrame(deadline), selfVerify, tip(funder)],
    signatures: [secp256k1Placeholder()],
  })
  await execute(client, tx, [privateKey], { label: `A. deadline = head + 120 s (${deadline})` })
}

// B. Deadlines at the head's timestamp and a little after it. Blocks come every 6 s.
if (run('B')) console.log('\n=== B. deadlines near the head ===')
if (run('B')) for (const ahead of [0n, 3n, 5n, 6n, 7n, 12n]) {
  const deadline = (await headTimestamp()) + ahead
  const { hash } = await probe(`deadline = head + ${ahead} s (${deadline})`, await eoaTx(late.key, [expiryFrame(deadline), selfVerify, tip(funder)]))
  if (hash) console.log(`    → ${await follow(hash, 30_000, deadline)}`)
}

// C. A deadline already past.
if (run('C')) {
  console.log('\n=== C. deadline already past ===')
  const deadline = (await headTimestamp()) - 1n
  await probe(`deadline = head − 1 s (${deadline})`, await eoaTx(late.key, [expiryFrame(deadline), selfVerify, tip(funder)]))
}

// D. Not an expiry verifier frame: a DEFAULT frame to the same contract, after the prefix.
if (run('D')) {
  const deadline = (await headTimestamp()) - 60n
  const tx = await prepareFrameTx(client, {
    sender: funder,
    frames: [selfVerify, defaultFrame({ target: EXPIRY_VERIFIER, data: encodeDeadline(deadline), execution: 5_000n }), tip(funder)],
    signatures: [secp256k1Placeholder()],
  })
  await execute(client, tx, [privateKey], { label: 'D. DEFAULT frame to EXPIRY_VERIFIER with a past deadline, after the prefix' })
}

console.log(`\nfunder ${funder}: ${formatEther(await client.getBalance({ address: funder }))} ETH`)
