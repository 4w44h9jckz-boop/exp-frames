// Experiment 19, part 2: is a receipt final when it arrives? Experiment 16 saw a receipt for a
// block that did not become canonical, and a transaction sent on the strength of it vanish.
// This script does two things.
//
// 1. History: the timestamp gaps between consecutive blocks over the last N blocks. A slot is
//    6 s here, so a 12 s gap is a slot with no block.
// 2. Rounds: an EOA sends A, polls for A's receipt every 250 ms, and the moment one arrives sends
//    B at the next nonce. B is valid only if A is in the parent state. Two blocks later the script
//    asks again: is A's receipt block the canonical block at that height, and did B land?
//
// usage: npx tsx experiments/19-mempool-rules/receipts.ts [rounds=60] [history=20000]
import { type Hex, concatHex, keccak256, parseEther, toHex } from 'viem'
import { privateKeyToAddress } from 'viem/accounts'
import { sendFrames } from '../../src/deploy.js'
import { loadKey } from '../../src/env.js'
import {
  Approve,
  NEW_ACCOUNT_STATE_GAS,
  type FrameTxReceiptJson,
  HEGOTA_RPC_URL,
  getFrameTxReceipt,
  makeClient,
  prepareFrameTx,
  secp256k1Placeholder,
  sendFrameTx,
  senderFrame,
  signAll,
  verifyFrame,
} from '../../src/frametx/index.js'

const rounds = Number(process.argv[2] ?? 60)
const history = Number(process.argv[3] ?? 20_000)
const { privateKey } = loadKey()
const client = makeClient()
const key = keccak256(concatHex([privateKey, toHex('exp-frames/19/rounds')]))
const eoa = privateKeyToAddress(key)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Block = { number: Hex; hash: Hex; parentHash: Hex; timestamp: Hex; transactions: Hex[] }
async function batch(numbers: bigint[]): Promise<Block[]> {
  const body = numbers.map((n, id) => ({ jsonrpc: '2.0', id, method: 'eth_getBlockByNumber', params: [toHex(n), false] }))
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(process.env.RPC_URL || HEGOTA_RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const out = (await res.json()) as { id: number; result: Block }[]
      return out.sort((a, b) => a.id - b.id).map((r) => r.result)
    } catch (e) {
      if (attempt === 4) throw e
      await sleep(2000 * 2 ** attempt)
    }
  }
}
const block = async (n: bigint) => (await batch([n]))[0]

// ---- 1. history ----
{
  const head = await client.getBlockNumber()
  const from = head - BigInt(history)
  const times: bigint[] = []
  for (let n = from; n <= head; n += 100n) {
    const numbers = Array.from({ length: Number(n + 100n > head + 1n ? head + 1n - n : 100n) }, (_, i) => n + BigInt(i))
    for (const b of await batch(numbers)) times.push(BigInt(b.timestamp))
  }
  const gaps = new Map<bigint, number>()
  for (let i = 1; i < times.length; i++) gaps.set(times[i] - times[i - 1], (gaps.get(times[i] - times[i - 1]) ?? 0) + 1)
  const total = times.length - 1
  console.log(`history: blocks ${from}..${head} (${total} gaps, ${times[times.length - 1] - times[0]} s)`)
  console.log('| gap (s) | blocks | share |\n|---|---|---|')
  for (const [gap, count] of [...gaps].sort((a, b) => Number(a[0] - b[0]))) console.log(`| ${gap} | ${count} | ${((100 * count) / total).toFixed(2)}% |`)
  const slots = Number((times[times.length - 1] - times[0]) / 6n)
  console.log(`slots ${slots}, blocks ${total}: ${slots - total} slots without a block (${((100 * (slots - total)) / slots).toFixed(2)}%)\n`)
}

// ---- 2. rounds ----
if (rounds > 0) {
  if ((await client.getBalance({ address: eoa })) < parseEther('0.005')) {
    await sendFrames(client, privateKey, [senderFrame({ target: eoa, value: parseEther('0.02'), execution: 30_000n, state: NEW_ACCOUNT_STATE_GAS })], { label: `fund the rounds EOA ${eoa}` })
  }
  const tx = async (nonceSeq: bigint) =>
    signAll(
      await prepareFrameTx(client, {
        sender: eoa,
        nonceSeq,
        frames: [verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 20_000n }), senderFrame({ target: eoa, execution: 5_000n })],
        signatures: [secp256k1Placeholder()],
      }),
      [key],
    )
  const poll = async (hash: Hex, ms: number, every = 250): Promise<{ r: FrameTxReceiptJson; at: number } | null> => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      const r = await getFrameTxReceipt(client, hash).catch(() => null)
      if (r) return { r, at: Date.now() }
      await sleep(every)
    }
    return null
  }
  console.log(`rounds from ${eoa}`)
  console.log('| round | A block (receipt) | receipt hash canonical? | canonical gap to parent (s) | B sent | B | A receipt later |\n|---|---|---|---|---|---|---|')
  const tally = { rounds: 0, rebuilt: 0, bDropped: 0, bDroppedAfterRebuilt: 0, bRefused: 0 }
  for (let round = 1; round <= rounds; round++) {
    const n = BigInt(await client.getTransactionCount({ address: eoa, blockTag: 'latest' }))
    const a = await tx(n)
    const aHash = await sendFrameTx(client, a).catch((e) => {
      console.log(`| ${round} | A refused: ${(e as Error).message.split('\n')[0]} | | | | | |`)
      return null
    })
    if (!aHash) {
      await sleep(12_000)
      continue
    }
    const ra = await poll(aHash, 60_000)
    if (!ra) {
      console.log(`| ${round} | A: no receipt in 60 s | | | | | |`)
      continue
    }
    let bText: string
    let bHash: Hex | null = null
    try {
      bHash = await sendFrameTx(client, await tx(n + 1n))
      bText = `+${Date.now() - ra.at} ms`
    } catch (e) {
      bText = `refused: ${(e as Error).message.split('\n').find((l) => l.startsWith('Details:')) ?? (e as Error).message.split('\n')[0]}`
      tally.bRefused++
    }
    const rb = bHash ? await poll(bHash, 40_000, 1000) : null
    // Two more blocks, then look again.
    const height = BigInt(ra.r.blockNumber)
    while ((await client.getBlockNumber()) < height + 2n) await sleep(2000)
    const [canon, parent] = await batch([height, height - 1n])
    const canonical = canon.hash.toLowerCase() === ra.r.blockHash.toLowerCase()
    const aLater = await getFrameTxReceipt(client, aHash)
    const bLater = bHash ? await getFrameTxReceipt(client, bHash) : null
    tally.rounds++
    if (!canonical) tally.rebuilt++
    if (bHash && !bLater) {
      tally.bDropped++
      if (!canonical) tally.bDroppedAfterRebuilt++
    }
    const aLaterText = !aLater ? 'none' : aLater.blockHash.toLowerCase() === ra.r.blockHash.toLowerCase() ? 'same' : `block ${BigInt(aLater.blockNumber)} \`${aLater.blockHash.slice(0, 10)}…\``
    const bResult = !bHash ? '' : bLater ? `block ${BigInt(bLater.blockNumber)}${rb ? '' : ' (late)'}` : '**dropped**'
    console.log(
      `| ${round} | ${height} \`${ra.r.blockHash.slice(0, 10)}…\` (\`${aHash.slice(0, 10)}…\`) | ${canonical ? 'yes' : `**no**: canonical \`${canon.hash.slice(0, 10)}…\``} | ${BigInt(canon.timestamp) - BigInt(parent.timestamp)} | ${bText} | ${bResult} | ${aLaterText} |`,
    )
  }
  console.log(`\n${JSON.stringify(tally)}`)
}
