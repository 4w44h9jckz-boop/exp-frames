// EIP-8141 Example 1a: simple ETH transfer from an EOA (default code, no contract).
//
// | Frame | Mode   | Caller      | Flags                         | Target        | Value  | Data  |
// | 0     | VERIFY | ENTRY_POINT | APPROVE_EXECUTION_AND_PAYMENT | Null (sender) | 0      | Empty |
// | 1     | SENDER | Sender      | APPROVE_SCOPE_NONE            | Destination   | Amount | Empty |
//
// usage: npx tsx experiments/01-simple-tx/example-1a-transfer.ts [destination] [--dry-run]
import { type Address, isAddress, parseEther } from 'viem'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'
import { loadKey } from '../../src/env.js'
import { execute } from '../../src/execute.js'
import {
  Approve,
  NEW_ACCOUNT_STATE_GAS,
  makeClient,
  prepareFrameTx,
  secp256k1Placeholder,
  senderFrame,
  verifyFrame,
} from '../../src/frametx/index.js'

const { privateKey, address: sender } = loadKey()
const client = makeClient()

// Default: a brand-new address, so the transfer has to create an account.
const arg = process.argv.slice(2).find((a) => !a.startsWith('--'))
const destination = (arg && isAddress(arg) ? arg : privateKeyToAddress(generatePrivateKey())) as Address
const exists = (await client.getBalance({ address: destination })) > 0n || (await client.getTransactionCount({ address: destination })) > 0
const amount = parseEther('0.001')

const tx = await prepareFrameTx(client, {
  sender,
  frames: [
    // Default code for an EOA: needs a SECP256K1 signature at index 0 over the sig hash,
    // signed by the frame's resolved target (the sender), then APPROVE(scope = flags).
    verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 20_000n }),
    // Creating the recipient account costs 120 × CPSB = 183,600 state gas, charged to
    // this frame's state budget. Execution gas cannot pay for it.
    senderFrame({
      target: destination,
      value: amount,
      execution: 30_000n,
      state: exists ? 0n : NEW_ACCOUNT_STATE_GAS,
    }),
  ],
  signatures: [secp256k1Placeholder()],
})

console.log(`destination ${destination} (${exists ? 'existing' : 'new'} account)`)
await execute(client, tx, [privateKey], { label: 'Example 1a: ETH transfer' })
