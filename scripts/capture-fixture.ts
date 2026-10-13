// Save a mined frame tx (tx JSON + receipt JSON) as a test fixture.
// usage: npm exec tsx scripts/capture-fixture.ts <txhash>...
import { mkdirSync, writeFileSync } from 'node:fs'
import type { Hex } from 'viem'
import { getFrameTxJson, getFrameTxReceipt, makeClient, rpc } from '../src/frametx/index.js'

const client = makeClient()
const dir = new URL('../test/fixtures/chain/', import.meta.url)
mkdirSync(dir, { recursive: true })
const clientVersion = await rpc<string>(client, 'web3_clientVersion', [])

for (const hash of process.argv.slice(2) as Hex[]) {
  const [tx, receipt] = await Promise.all([getFrameTxJson(client, hash), getFrameTxReceipt(client, hash)])
  if (!tx || !receipt) {
    console.error(`${hash}: not found`)
    process.exitCode = 1
    continue
  }
  const fixture = { meta: { clientVersion, capturedAt: new Date().toISOString() }, tx, receipt }
  writeFileSync(new URL(`${hash}.json`, dir), `${JSON.stringify(fixture, null, 2)}\n`)
  console.log(`${hash}: block ${BigInt(receipt.blockNumber)}, ${tx.frames.length} frames`)
}
