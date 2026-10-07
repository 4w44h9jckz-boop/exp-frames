// Decode a mined frame transaction and its per-frame receipts.
// usage: npm run inspect -- <txhash>
import type { Hex } from 'viem'
import {
  describeReceipt,
  describeTx,
  frameTxFromJson,
  frameTxHash,
  gasSummary,
  getFrameTxJson,
  getFrameTxReceipt,
  makeClient,
} from '../src/frametx/index.js'

const hash = process.argv[2] as Hex
if (!hash) throw new Error('usage: npm run inspect -- <txhash>')
const client = makeClient()
const json = await getFrameTxJson(client, hash)
if (!json) throw new Error(`${hash} not found`)
if (json.type !== '0x6') throw new Error(`${hash} is type ${json.type}, not a frame transaction`)
const tx = frameTxFromJson(json)
if (frameTxHash(tx) !== json.hash) console.warn('warning: re-encoding does not reproduce the tx hash')
console.log(describeTx(tx))
console.log(gasSummary(tx))
const receipt = await getFrameTxReceipt(client, hash)
console.log(receipt ? describeReceipt(tx, receipt) : 'pending')
