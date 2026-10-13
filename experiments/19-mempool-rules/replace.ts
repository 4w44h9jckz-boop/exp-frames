// Experiment 19, part 3: what a replacement must raise. Experiments 09 and 12 found that a
// replacement needs both fees 10% higher, and refused 5% and 9.98%. This asks which of the two
// fees the rule looks at. Each case waits for a new head, sends an original with max fee 2 gwei
// and tip 1 gwei, and at once offers a replacement at the same nonce.
//
// usage: npx tsx experiments/19-mempool-rules/replace.ts
import { type Hex, concatHex, keccak256, parseEther, parseGwei, toHex } from 'viem'
import { privateKeyToAddress } from 'viem/accounts'
import { sendFrames } from '../../src/deploy.js'
import { loadKey } from '../../src/env.js'
import {
  Approve,
  NEW_ACCOUNT_STATE_GAS,
  getFrameTxReceipt,
  makeClient,
  prepareFrameTx,
  secp256k1Placeholder,
  sendFrameTx,
  senderFrame,
  signAll,
  verifyFrame,
} from '../../src/frametx/index.js'

const { privateKey } = loadKey()
const client = makeClient()
const key = keccak256(concatHex([privateKey, toHex('exp-frames/19/replace')]))
const eoa = privateKeyToAddress(key)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

if ((await client.getBalance({ address: eoa })) < parseEther('0.002')) {
  await sendFrames(client, privateKey, [senderFrame({ target: eoa, value: parseEther('0.01'), execution: 30_000n, state: NEW_ACCOUNT_STATE_GAS })], { label: `fund ${eoa}` })
}
// The SENDER frame's execution limit differs between original and replacement, so the two have
// different hashes even when the fees are equal.
const tx = async (nonceSeq: bigint, maxFeePerGas: bigint, maxPriorityFeePerGas: bigint, mark: bigint) =>
  signAll(
    await prepareFrameTx(client, {
      sender: eoa,
      nonceSeq,
      fees: { maxFeePerGas, maxPriorityFeePerGas, maxFeePerBlobGas: 0n },
      frames: [verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 20_000n }), senderFrame({ target: eoa, execution: 5_000n + mark })],
      signatures: [secp256k1Placeholder()],
    }),
    [key],
  )

const base = { fee: parseGwei('2'), tip: parseGwei('1') }
const pct = (v: bigint, p: number) => (v * BigInt(Math.round(100 * (100 + p)))) / 10_000n
const cases: [string, bigint, bigint][] = [
  ['both fees +10%', pct(base.fee, 10), pct(base.tip, 10)],
  ['both fees +9%', pct(base.fee, 9), pct(base.tip, 9)],
  ['tip +10%, max fee unchanged', base.fee, pct(base.tip, 10)],
  ['max fee +10%, tip unchanged', pct(base.fee, 10), base.tip],
  ['tip +100%, max fee unchanged', base.fee, pct(base.tip, 100)],
  ['max fee +100%, tip unchanged', pct(base.fee, 100), base.tip],
  ['both fees unchanged', base.fee, base.tip],
]

const short = (e: unknown) => (e as Error).message.split('\n').find((l) => l.startsWith('Details:'))?.replace('Details: ', '') ?? (e as Error).message.split('\n')[0]
console.log(`EOA ${eoa}; original max fee ${base.fee}, tip ${base.tip}`)
console.log('| Replacement | max fee | tip | offered | mined |\n|---|---|---|---|---|')
for (const [what, fee, tip] of cases) {
  const head = await client.getBlockNumber()
  while ((await client.getBlockNumber()) === head) await sleep(200)
  const n = BigInt(await client.getTransactionCount({ address: eoa, blockTag: 'latest' }))
  const [orig, repl] = await Promise.all([tx(n, base.fee, base.tip, 0n), tx(n, fee, tip, 1n)])
  const origHash = await sendFrameTx(client, orig)
  let offered: string
  let replHash: Hex | null = null
  try {
    replHash = await sendFrameTx(client, repl)
    offered = 'accepted'
  } catch (e) {
    offered = `refused: ${short(e)}`
  }
  let mined = ''
  for (let i = 0; i < 30 && !mined; i++) {
    await sleep(1000)
    const [ro, rr] = await Promise.all([getFrameTxReceipt(client, origHash), replHash ? getFrameTxReceipt(client, replHash) : null])
    if (rr) mined = `the replacement, block ${BigInt(rr.blockNumber)} (\`${replHash!.slice(0, 10)}…\`)`
    else if (ro) mined = `the original, block ${BigInt(ro.blockNumber)} (\`${origHash.slice(0, 10)}…\`)`
  }
  console.log(`| ${what} | ${fee} | ${tip} | ${offered} | ${mined || 'neither in 30 s'} |`)
}
