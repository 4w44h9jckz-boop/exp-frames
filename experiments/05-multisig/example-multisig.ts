// A k-of-n multisig on frames: two 2-of-3 accounts, one with three secp256k1 owners and one with
// two secp256k1 owners plus a P256 (passkey) owner. Each sends ETH with two of its owners' signatures.
//
// | Frame | Mode   | Flags                         | Target        | Signatures                         |
// | 0     | VERIFY | APPROVE_EXECUTION_AND_PAYMENT | Null (sender) | two owners, explicit signer, msg ∅ |
// | 1     | SENDER | -                             | Destination   |                                    |
//
// usage: npx tsx experiments/05-multisig/example-multisig.ts [--dry-run]
import { formatEther, parseEther } from 'viem'
import { loadKey } from '../../src/env.js'
import { DRY_RUN, execute } from '../../src/execute.js'
import { sendFrames } from '../../src/deploy.js'
import {
  Approve,
  type AnyKey,
  type Frame,
  makeClient,
  p256Placeholder,
  prepareFrameTx,
  secp256k1Placeholder,
  senderFrame,
  verifyFrame,
} from '../../src/frametx/index.js'
import { addressOf, deriveP256, deriveSecp256k1, multisig } from './multisig.js'

const { privateKey, address: funder } = loadKey()
const client = makeClient()

const alice = deriveSecp256k1(privateKey, 'alice')
const bob = deriveSecp256k1(privateKey, 'bob')
const carol = deriveSecp256k1(privateKey, 'carol')
const passkey = deriveP256(privateKey, 'passkey')

const secp = multisig([alice, bob, carol].map(addressOf), 2, 'exp-frames/05/multisig-2of3-secp/v1')
const mixed = multisig([alice, bob, passkey].map(addressOf), 2, 'exp-frames/05/multisig-2of3-mixed/v1')
const FUNDING = parseEther('0.01')

console.log(`owners: alice ${addressOf(alice)}, bob ${addressOf(bob)}, carol ${addressOf(carol)}, passkey (P256) ${addressOf(passkey)}`)
console.log(`2-of-3 secp256k1: ${secp.address}\n2-of-3 mixed:     ${mixed.address}`)

// Setup: deploy and fund whichever account needs it, in one transaction from the funder EOA.
const setup: Frame[] = []
for (const account of [secp, mixed]) {
  const [code, balance] = await Promise.all([client.getCode({ address: account.address }), client.getBalance({ address: account.address })])
  if (!code) setup.push(account.deployBySender)
  if (balance < FUNDING / 2n) setup.push(senderFrame({ target: account.address, value: FUNDING - balance, execution: 30_000n }))
}
if (setup.length) await sendFrames(client, privateKey, setup, { label: 'setup: deploy and fund both multisigs' })
else console.log('setup: already done')
if (DRY_RUN && !(await client.getCode({ address: mixed.address }))) process.exit(0)

const send = async (label: string, account: typeof secp, signers: AnyKey[]) => {
  const tx = await prepareFrameTx(client, {
    sender: account.address,
    frames: [
      verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 30_000n }),
      senderFrame({ target: funder, value: parseEther('0.001'), execution: 30_000n }),
    ],
    signatures: signers.map((k) => (typeof k === 'string' ? secp256k1Placeholder(addressOf(k)) : p256Placeholder(addressOf(k)))),
  })
  return execute(client, tx, signers, { label })
}

await send('2-of-3 secp256k1: alice + carol sign', secp, [alice, carol])
await send('2-of-3 mixed: bob (secp256k1) + passkey (P256) sign', mixed, [bob, passkey])

for (const account of [secp, mixed]) {
  const [balance, nonce] = await Promise.all([client.getBalance({ address: account.address }), client.getTransactionCount({ address: account.address })])
  console.log(`${account.address}: ${formatEther(balance)} ETH, nonce ${nonce}`)
}
