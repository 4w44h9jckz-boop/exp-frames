// EIP-8141 Example 1b: deploy a smart account at tx.sender, then use it in the same tx.
//
// | Frame | Mode    | Caller      | Flags                         | Target        | Value  | Data           |
// | 0     | DEFAULT | ENTRY_POINT | APPROVE_SCOPE_NONE            | Deployer      | 0      | Initcode, Salt |
// | 1     | VERIFY  | ENTRY_POINT | APPROVE_EXECUTION_AND_PAYMENT | Null (sender) | 0      | Empty          |
// | 2     | SENDER  | Sender      | APPROVE_SCOPE_NONE            | Destination   | Amount | Empty          |
//
// The sender is a counterfactual CREATE2 address with no key. Its code, deployed by frame 0,
// validates frame 1 by checking that signature 0 was made by the owner EOA. Then a second
// transaction from the now-deployed account drops the deploy frame.
//
// usage: npx tsx experiments/02-account-deployment/example-1b-deploy.ts [--dry-run]
import { formatEther, parseEther } from 'viem'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'
import { loadKey } from '../../src/env.js'
import { sendFrames } from '../../src/deploy.js'
import { DRY_RUN, execute } from '../../src/execute.js'
import {
  Approve,
  NEW_ACCOUNT_STATE_GAS,
  makeClient,
  prepareFrameTx,
  secp256k1Placeholder,
  senderFrame,
  verifyFrame,
} from '../../src/frametx/index.js'
import { simpleAccount } from './account.js'

const { privateKey: ownerKey, address: owner } = loadKey()
const client = makeClient()
const account = simpleAccount(owner)

const state = async (label: string) => {
  const [code, balance, nonce] = await Promise.all([
    client.getCode({ address: account.address }),
    client.getBalance({ address: account.address }),
    client.getTransactionCount({ address: account.address }),
  ])
  const deployed = !!code && code !== '0x'
  console.log(`${label}: account ${account.address} code=${deployed ? `${(code.length - 2) / 2}B` : 'none'} balance=${formatEther(balance)} nonce=${nonce}`)
  return { deployed, balance, nonce }
}

// Signature 0 is the owner's: the account is the sender, the owner only signs.
const ownerSignature = () => [secp256k1Placeholder(owner)]
const verify = verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 10_000n })
const transfer = () =>
  senderFrame({
    target: privateKeyToAddress(generatePrivateKey()),
    value: parseEther('0.001'),
    execution: 30_000n,
    state: NEW_ACCOUNT_STATE_GAS,
  })

let s = await state('before')

if (!s.deployed) {
  // 1. The account pays its own gas (self_verify), so fund the counterfactual address first.
  if (s.balance < parseEther('0.01')) {
    await sendFrames(
      client,
      ownerKey,
      [senderFrame({ target: account.address, value: parseEther('0.02'), execution: 30_000n, state: s.balance > 0n ? 0n : NEW_ACCOUNT_STATE_GAS })],
      { label: 'prefund the counterfactual account' },
    )
    if (DRY_RUN) process.exit(0)
    s = await state('funded')
  }

  // 2. Example 1b proper.
  const tx = await prepareFrameTx(client, {
    sender: account.address,
    frames: [account.deploy, verify, transfer()],
    signatures: ownerSignature(),
  })
  await execute(client, tx, [ownerKey], { label: 'Example 1b: deploy the account at tx.sender and transfer from it' })
  if (DRY_RUN) process.exit(0)
  s = await state('after 1b')
}

// 3. From now on the deploy frame must be dropped: the code is already there.
const tx = await prepareFrameTx(client, {
  sender: account.address,
  frames: [verify, transfer()],
  signatures: ownerSignature(),
})
await execute(client, tx, [ownerKey], { label: 'follow-up: the deployed account validates on its own' })
if (!DRY_RUN) await state('after follow-up')
