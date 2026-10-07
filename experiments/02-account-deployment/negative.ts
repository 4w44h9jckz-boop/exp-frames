// What the account and the protocol refuse, checked by simulation. Needs one cheap setup tx:
// a fresh counterfactual account (new salt each run) is funded so payment can be approved,
// but never deployed.
//
// usage: npx tsx experiments/02-account-deployment/negative.ts
import { type Hex, keccak256, parseEther, toHex } from 'viem'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'
import { loadKey } from '../../src/env.js'
import { sendFrames } from '../../src/deploy.js'
import {
  Approve,
  type FrameSignature,
  type FrameTx,
  NEW_ACCOUNT_STATE_GAS,
  makeClient,
  prepareFrameTx,
  secp256k1Placeholder,
  senderFrame,
  signFrameTx,
  simulateFrameTx,
  verifyFrame,
} from '../../src/frametx/index.js'
import { simpleAccount } from './account.js'

const { privateKey: ownerKey, address: owner } = loadKey()
const client = makeClient()
const deployed = simpleAccount(owner)
const fresh = simpleAccount(owner, `exp-frames/simple-account/negative/${Date.now()}`)

await sendFrames(
  client,
  ownerKey,
  [senderFrame({ target: fresh.address, value: parseEther('0.005'), execution: 30_000n, state: NEW_ACCOUNT_STATE_GAS })],
  { label: `fund a fresh, undeployed account ${fresh.address}` },
)

const verify = verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 10_000n })
const transfer = senderFrame({ target: owner, value: 1n, execution: 30_000n })
const tx = (sender: typeof fresh, frames = [sender.deploy, verify, transfer], signatures: FrameSignature[] = [secp256k1Placeholder(owner)]) =>
  prepareFrameTx(client, { sender: sender.address, frames, signatures })

const otherKey = generatePrivateKey()
const cases: [string, () => Promise<FrameTx>][] = [
  ['fresh account: Example 1b as designed', async () => signFrameTx(await tx(fresh), ownerKey)],
  ['fresh account: no deploy frame (empty code → default code wants signer == sender)', async () => signFrameTx(await tx(fresh, [verify, transfer]), ownerKey)],
  ['fresh account: VERIFY before the deploy frame', async () => signFrameTx(await tx(fresh, [verify, fresh.deploy, transfer]), ownerKey)],
  [
    'fresh account: signed by another key (signer = that key)',
    async () => signFrameTx(await tx(fresh, undefined, [secp256k1Placeholder(privateKeyToAddress(otherKey))]), otherKey),
  ],
  [
    'fresh account: owner signs an explicit 32-byte msg instead of the sig hash',
    async () => signFrameTx(await tx(fresh, undefined, [secp256k1Placeholder(owner, keccak256(toHex('not this transaction')))]), ownerKey),
  ],
  ['deployed account: replaying the deploy frame', async () => signFrameTx(await tx(deployed), ownerKey)],
  [
    'deployed account: a signature claiming to be the account itself (signer empty)',
    async () => {
      const t = await tx(deployed, [verify, transfer], [secp256k1Placeholder(null)])
      // Nobody holds the account's key. Sign with the owner key and see whether the protocol notices.
      const owned = await signFrameTx({ ...t, signatures: [secp256k1Placeholder(owner)] }, ownerKey)
      return { ...t, signatures: [{ ...owned.signatures[0], signer: null }] }
    },
  ],
]

for (const [name, build] of cases) {
  const t = await build()
  const sim = await simulateFrameTx(client, t).catch((e: Error) => ({ error: e.message.split('\n')[0] }))
  console.log(`\n• ${name}`)
  if ('error' in sim) {
    console.log(`  RPC error: ${sim.error}`)
    continue
  }
  console.log(`  valid=${sim.valid} shape=${sim.prefixShape} payer=${sim.payer ? 'set' : 'none'}${sim.violation ? `\n  violation: ${sim.violation}` : ''}`)
  if (sim.frames) console.log(`  frames: ${sim.frames.map((f, i) => `[${i}] ${f.succeeded ? 'ok' : 'FAILED'} gas=${BigInt(f.gasUsed as Hex)}`).join('  ')}`)
}
