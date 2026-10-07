// Experiment 09: the canonical paymaster (EIP-8141 + ethereum/EIPs#12041) in the public mempool.
//
// | Frame | Mode   | Flags             | Target        | Signatures                              |
// | 0     | VERIFY | APPROVE_EXECUTION | Null (sender) | entry 0: the user (default code)        |
// | 1     | VERIFY | APPROVE_PAYMENT   | paymaster     | entry 1: the paymaster's signer, msg ∅  |
// | 2     | SENDER | -                 | funder        | (a 0-value call: the user holds no ETH) |
//
// A. one sponsored transaction from a user with no ETH;
// B. bursts of four users' transactions through (1) a canonical instance, (2) a byte-different
//    copy with identical behaviour, (3) a code-less EOA sponsor;
// C. reservation: a canonical instance funded for 2.5 transactions, and a burst of three;
// D. a pending withdrawal (slot 1) on the main instance, then the same burst;
// E. the pay frame's gas limit around the PR's 15,000;
// F. what the paymaster refuses.
//
// usage: npx tsx experiments/09-paymasters/canonical.ts [A] [B] [C] [D] [E] [F]   (default: all)
import { type Address, type Hex, concatHex, formatEther, keccak256, numberToHex, parseEther } from 'viem'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'
import { sendFrames } from '../../src/deploy.js'
import { execute } from '../../src/execute.js'
import {
  Approve,
  type FrameSignature,
  type FrameTx,
  NEW_ACCOUNT_STATE_GAS,
  Scheme,
  maxCost,
  prepareFrameTx,
  secp256k1Placeholder,
  senderFrame,
  signAll,
  simulateFrameTx,
  verifyFrame,
} from '../../src/frametx/index.js'
import { CANONICAL_CODE_HASH, burst, client, derive, funder, paymaster, privateKey, sponsor, sponsored } from './paymaster.js'

const parts = process.argv.slice(2).filter((a) => /^[A-F]$/.test(a))
const run = (p: string) => parts.length === 0 || parts.includes(p)

const main = paymaster('canonical', 'main/v1')
const copy = paymaster('non-canonical', 'copy/v1')
const users = Array.from({ length: 12 }, (_, i) => derive(`user-${i}`))

// Setup: deploy and fund the two instances, fund the sponsor EOA (it pays in B3 and signs admin calls).
{
  const frames = []
  for (const pm of [main, copy]) {
    if (!(await client.getCode({ address: pm.address }))) frames.push(pm.deploy)
    const balance = await client.getBalance({ address: pm.address })
    if (balance < parseEther('0.005')) frames.push(senderFrame({ target: pm.address, value: parseEther('0.01') - balance, execution: 30_000n }))
  }
  const sb = await client.getBalance({ address: sponsor.address })
  if (sb < parseEther('0.005')) frames.push(senderFrame({ target: sponsor.address, value: parseEther('0.01') - sb, execution: 30_000n, state: sb ? 0n : NEW_ACCOUNT_STATE_GAS }))
  if (frames.length) await sendFrames(client, privateKey, frames, { label: 'setup: deploy and fund the paymasters, fund the sponsor' })
  for (const pm of [main, copy]) {
    const code = await client.getCode({ address: pm.address })
    const slot0 = await client.getStorageAt({ address: pm.address, slot: '0x0' })
    console.log(`${pm.kind} ${pm.address}: code hash ${keccak256(code!) === CANONICAL_CODE_HASH ? '= canonical' : '≠ canonical'}, ${(code!.length - 2) / 2} B, signer ${slot0}, ${formatEther(await client.getBalance({ address: pm.address }))} ETH`)
  }
}

/** A sponsored transaction from users[i] through `payer`, signed by the user and the sponsor key. */
const tx = (i: number, payer: Address, opts: Parameters<typeof sponsored>[3] = {}) => sponsored(users[i], payer, [sponsor.key], opts)

// A. One sponsored transaction.
if (run('A')) {
  await execute(client, await tx(0, main.address), [], { label: 'A. a user with no ETH, sponsored by the canonical paymaster' })
}

// B. Four users at once, through each kind of payer.
if (run('B')) {
  await burst('B1. four users through the canonical instance', await Promise.all([1, 2, 3, 4].map((i) => tx(i, main.address))))
  await burst('B2. four users through the byte-different copy', await Promise.all([5, 6, 7, 8].map((i) => tx(i, copy.address))))
  await burst('B3. four users through the sponsor EOA (default code)', await Promise.all([9, 10, 11, 1].map((i) => tx(i, sponsor.address))))
}

// C. Reservation: an instance holding 2.5 transactions' max cost, three transactions at once.
if (run('C')) {
  const small = paymaster('canonical', `small/${Date.now()}`)
  const txs = await Promise.all([2, 3, 4].map((i) => tx(i, small.address)))
  const costs = txs.map((t) => maxCost(t))
  const fund = costs[0] + costs[1] + costs[2] / 2n
  console.log(`\nC. max costs ${costs.join(', ')} wei; funding ${small.address} with ${fund} wei`)
  await sendFrames(client, privateKey, [small.deploy, senderFrame({ target: small.address, value: fund, execution: 30_000n })], { label: 'C. setup: a small canonical instance' })
  await burst('C. three transactions against 2.5 transactions of balance', txs)
}

// D. A pending withdrawal: nodes subtract slot 1 from what the instance can sponsor.
if (run('D')) {
  const txs = await Promise.all([5, 6].map((i) => tx(i, main.address)))
  const balance = await client.getBalance({ address: main.address })
  const amount = balance - (maxCost(txs[0]) * 3n) / 2n
  const admin = async (label: string, data: Hex) => {
    const t = await prepareFrameTx(client, {
      sender: sponsor.address,
      frames: [verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 20_000n }), senderFrame({ target: main.address, data, execution: 60_000n, state: 2n * 97_920n })],
      signatures: [secp256k1Placeholder()],
    })
    return execute(client, t, [sponsor.key], { label })
  }
  await admin(`D. setup: the signer initiates a withdrawal of ${formatEther(amount)} ETH (op 0x01)`, concatHex(['0x01', numberToHex(amount, { size: 32 })]))
  console.log(`slot 1 ${await client.getStorageAt({ address: main.address, slot: '0x1' })}, slot 2 ${await client.getStorageAt({ address: main.address, slot: '0x2' })}`)
  await burst('D. two transactions while balance − withdrawal covers 1.5 of them', txs)
  await admin('D. cleanup: cancel the withdrawal (op 0x03)', '0x03')
}

// E. The pay frame's gas limit. The PR: "a canonical pay frame needs a gas_limit of at most 15,000
// … nodes MAY reject canonical pay frames with a higher gas_limit as non-canonical usage".
if (run('E')) {
  console.log('\n=== E. pay frame execution limits ===')
  for (const limit of [10_000n, 15_000n, 15_001n, 50_000n]) {
    const t = await tx(7, main.address, { payExecution: limit })
    const sim = await simulateFrameTx(client, t)
    console.log(`  limit ${limit}: valid=${sim.valid}${sim.violation ? ` (${sim.violation})` : ''}${sim.frames ? `, pay frame used ${BigInt(sim.frames[1].gasUsed)}` : ''}`)
  }
}

// F. Refusals (simulated).
if (run('F')) {
  console.log('\n=== F. refusals ===')
  const stranger = generatePrivateKey()
  const arbitrary: FrameSignature = { scheme: Scheme.ARBITRARY, signer: null, msg: '0x', signature: '0x00' }
  const variants: [string, () => Promise<FrameTx>][] = [
    ['baseline', () => tx(8, main.address)],
    ['entry 1 signed by a stranger', () => sponsored(users[8], main.address, [stranger], { extraEntries: [privateKeyToAddress(stranger)] })],
    ['no entry 1', () => sponsored(users[8], main.address, [], { extraEntries: [] })],
    [
      'entry 1 is ARBITRARY',
      async () => {
        const t = await sponsored(users[8], main.address, [], { extraEntries: [] })
        return signAll({ ...t, signatures: [{ ...t.signatures[0], signature: '0x' }, arbitrary] }, [users[8].key])
      },
    ],
    [
      'entry 1 by the signer over an explicit digest',
      async () => {
        const t = await sponsored(users[8], main.address, [], { extraEntries: [] })
        return signAll({ ...t, signatures: [{ ...t.signatures[0], signature: '0x' }, secp256k1Placeholder(sponsor.address, `0x${'22'.repeat(32)}`)] }, [users[8].key, sponsor.key])
      },
    ],
    [
      'pay frame with data (an admin op instead)',
      async () => {
        const t = await sponsored(users[8], main.address, [sponsor.key])
        const frames = t.frames.map((f, i) => (i === 1 ? { ...f, data: '0x03' as Hex } : f))
        return signAll({ ...t, frames, signatures: t.signatures.map((s) => ({ ...s, signature: '0x' as Hex })) }, [users[8].key, sponsor.key])
      },
    ],
    [
      'pay frame before only_verify',
      async () => {
        const t = await sponsored(users[8], main.address, [sponsor.key])
        return signAll({ ...t, frames: [t.frames[1], t.frames[0], t.frames[2]], signatures: t.signatures.map((s) => ({ ...s, signature: '0x' as Hex })) }, [users[8].key, sponsor.key])
      },
    ],
  ]
  for (const [label, build] of variants) {
    const sim = await simulateFrameTx(client, await build()).catch((e: Error) => ({ valid: 'error', violation: e.message.split('\n').find((l) => l.startsWith('Details:'))?.slice(9) }))
    console.log(`  ${label}: valid=${sim.valid}${sim.violation ? ` (${sim.violation})` : ''}`)
  }
}

console.log(`\nmain ${formatEther(await client.getBalance({ address: main.address }))} ETH, copy ${formatEther(await client.getBalance({ address: copy.address }))} ETH, funder ${formatEther(await client.getBalance({ address: funder }))} ETH`)
