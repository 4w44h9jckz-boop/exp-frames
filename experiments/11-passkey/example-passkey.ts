// Experiment 11: accounts owned by P256 keys, two ways.
//
// P256Account (raw P256: Secure Enclave, Android Keystore, an HSM, anything that signs a digest)
// | Frame | Mode    | Flags                         | Target        | Signatures                  |
// | 0     | DEFAULT | -                             | CREATE2       | (first transaction only)    |
// | 1     | VERIFY  | APPROVE_EXECUTION_AND_PAYMENT | Null (sender) | P256, signer = owner, msg ∅ |
// | 2     | SENDER  | -                             | funder        |                             |
//
// WebAuthnAccount (a browser passkey, which signs a WebAuthn assertion, never a raw digest)
// | Frame | Mode   | Flags                         | Target        | Signatures                         |
// | 0     | VERIFY | APPROVE_EXECUTION_AND_PAYMENT | Null (sender) | ARBITRARY, msg ∅: the assertion    |
// | 1     | SENDER | -                             | funder        |                                    |
//
// usage: npx tsx experiments/11-passkey/example-passkey.ts [--dry-run]
import { formatEther, parseEther } from 'viem'
import { sendFrames } from '../../src/deploy.js'
import { loadKey } from '../../src/env.js'
import { DRY_RUN, execute } from '../../src/execute.js'
import {
  Approve,
  type Frame,
  NEW_ACCOUNT_STATE_GAS,
  makeClient,
  p256Address,
  p256Placeholder,
  prepareFrameTx,
  senderFrame,
  verifyFrame,
} from '../../src/frametx/index.js'
import { arbitraryEntry, assertionSize, deriveP256, p256Account, signWebAuthn, webauthnAccount } from './passkey.js'

const { privateKey, address: funder } = loadKey()
const client = makeClient()

const raw = deriveP256(privateKey, 'raw')
const passkey = deriveP256(privateKey, 'webauthn')
const rawAccount = p256Account(raw, 'exp-frames/11/p256-account/v1')
const webauthn = webauthnAccount(passkey, 'exp-frames/11/webauthn-account/v1')
console.log(`raw P256 key ${p256Address(raw)} owns P256Account ${rawAccount.address}`)
console.log(`passkey ${p256Address(passkey)} owns WebAuthnAccount ${webauthn.address}`)

const hasCode = async (address: `0x${string}`) => Boolean(await client.getCode({ address }))
const FUNDING = parseEther('0.01')

// Setup: fund the P256Account's address (it deploys itself), deploy and fund the WebAuthnAccount.
const setup: Frame[] = []
for (const account of [rawAccount, webauthn]) {
  const balance = await client.getBalance({ address: account.address })
  if (account === webauthn && !(await hasCode(account.address))) setup.push(account.deployBySender)
  if (balance < FUNDING / 2n) {
    const exists = balance > 0n || (await hasCode(account.address)) || account === webauthn
    setup.push(senderFrame({ target: account.address, value: FUNDING - balance, execution: 30_000n, state: exists ? 0n : NEW_ACCOUNT_STATE_GAS }))
  }
}
if (setup.length) await sendFrames(client, privateKey, setup, { label: 'setup: fund the P256Account address, deploy and fund the WebAuthnAccount' })
else console.log('setup: already done')
if (DRY_RUN && !(await hasCode(webauthn.address))) process.exit(0)

const pay = senderFrame({ target: funder, value: parseEther('0.0001'), execution: 30_000n })

// A. The P256Account deploys itself at tx.sender and pays, in its first transaction.
if (!(await hasCode(rawAccount.address))) {
  const tx = await prepareFrameTx(client, {
    sender: rawAccount.address,
    frames: [rawAccount.deployAtSender, verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 20_000n }), pay],
    signatures: [p256Placeholder(p256Address(raw))],
  })
  await execute(client, tx, [raw], { label: 'A. P256Account: deploy at tx.sender + transfer (Example 1b, P256 owner)' })
}

// B. The P256Account, deployed.
{
  const tx = await prepareFrameTx(client, {
    sender: rawAccount.address,
    frames: [verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 20_000n }), pay],
    signatures: [p256Placeholder(p256Address(raw))],
  })
  await execute(client, tx, [raw], { label: 'B. P256Account: transfer' })
}

// C. The WebAuthnAccount: the assertion travels in an ARBITRARY entry and is checked in the EVM.
{
  const unsigned = await prepareFrameTx(client, {
    sender: webauthn.address,
    frames: [verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 60_000n }), pay],
    signatures: [arbitraryEntry()],
  })
  const tx = signWebAuthn(unsigned, passkey)
  console.log(`assertion: ${assertionSize(tx)} bytes`)
  await execute(client, tx, [], { label: 'C. WebAuthnAccount: transfer authorised by a WebAuthn assertion' })
}

for (const account of [rawAccount, webauthn]) {
  const [balance, nonce] = await Promise.all([client.getBalance({ address: account.address }), client.getTransactionCount({ address: account.address })])
  console.log(`${account.address}: ${formatEther(balance)} ETH, nonce ${nonce}`)
}
