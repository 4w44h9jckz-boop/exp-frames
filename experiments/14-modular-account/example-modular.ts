// Experiment 14: a modular account. Validation lives in modules, ERC-7579 style, and the VERIFY
// frame's data names the module that judges the transaction. Three modules, three outcomes:
//
// | Module                 | Called by    | Keeps its config in   | In VERIFY                         |
// | OwnerValidator         | DELEGATECALL | the account's storage | reads sender storage only         |
// | ExternalOwnerValidator | STATICCALL   | its own storage       | reads another account's storage   |
// | CountingValidator      | DELEGATECALL | the account's storage | writes it (a use counter)         |
//
// | Frame | Mode   | Target        | Data                     | Signatures            |
// | 0     | VERIFY | Null (sender) | module (20) ‖ module data | owner, msg ∅          |
// | 1     | SENDER | funder        |                          |                       |
//
// usage: npx tsx experiments/14-modular-account/example-modular.ts [--dry-run]
import { type Hex, formatEther, pad, parseEther } from 'viem'
import { sendFrames } from '../../src/deploy.js'
import { DRY_RUN } from '../../src/execute.js'
import { type FrameTx, describeReceipt, describeSimulation, describeTx, rpc, sendFrameTx, senderFrame, simulateFrameTx, waitForFrameTxReceipt } from '../../src/frametx/index.js'
import { Kind, client, countingValidator, derive, externalOwnerValidator, funder, install, modularAccount, modules, ownerValidator, privateKey, viaModule } from './modular.js'

const alice = derive('alice')
const account = modularAccount(ownerValidator.address, Kind.DELEGATE, alice.address, 'modular-account/v1')
console.log(`owner ${alice.address}; ModularAccount ${account.address}`)
for (const m of modules) console.log(`  ${m.name} ${m.address}`)

async function send(label: string, tx: FrameTx): Promise<Hex | undefined> {
  console.log(`\n=== ${label} ===`)
  console.log(describeTx(tx))
  const sim = await simulateFrameTx(client, tx)
  console.log(describeSimulation(sim))
  if (DRY_RUN) return undefined
  if (!sim.valid) console.log('simulation says invalid; sending anyway to see what the pool says')
  let hash: Hex
  try {
    hash = await sendFrameTx(client, tx)
  } catch (e) {
    const m = (e as Error).message.split('\n')
    console.log(`refused: ${m.find((l) => l.startsWith('Details:')) ?? m[0]}`)
    return undefined
  }
  console.log(`sent ${hash}`)
  console.log(describeReceipt(tx, await waitForFrameTxReceipt(client, hash)))
  return hash
}

// Setup: the funder deploys the three modules and the account (OwnerValidator installed for alice), and funds it.
const FUNDING = parseEther('0.01')
const frames = []
for (const m of [...modules, { address: account.address, deploy: account.deploy }]) if (!(await client.getCode({ address: m.address }))) frames.push(m.deploy)
const balance = await client.getBalance({ address: account.address })
if (balance < FUNDING / 2n) frames.push(senderFrame({ target: account.address, value: FUNDING - balance, execution: 30_000n }))
if (frames.length) await sendFrames(client, privateKey, frames, { label: 'setup: deploy the modules and the account, fund it' })
else console.log('setup: already done')
if (DRY_RUN && !(await client.getCode({ address: account.address }))) process.exit(0)

const pay = senderFrame({ target: funder, value: parseEther('0.0001'), execution: 30_000n })

// A. OwnerValidator, by DELEGATECALL: the module's code over the account's storage.
await send('A. alice pays; OwnerValidator judges (DELEGATECALL)', await viaModule(account.address, ownerValidator.address, alice, [pay]))

// B. Install the other two. ExternalOwnerValidator writes alice into its own storage, keyed by the account.
const installed = async (m: { address: Hex }) => BigInt((await client.getStorageAt({ address: account.address, slot: pad(m.address) })) ?? '0x0')
if (!(await installed(externalOwnerValidator)) || !(await installed(countingValidator))) {
  await send(
    'B. alice installs ExternalOwnerValidator (CALL) and CountingValidator (DELEGATECALL)',
    await viaModule(account.address, ownerValidator.address, alice, [
      install(account.address, externalOwnerValidator.address, Kind.CALL, alice.address, 2n),
      install(account.address, countingValidator.address, Kind.DELEGATE, '0x', 1n),
    ]),
  )
} else console.log('\nB. already installed')

// C. ExternalOwnerValidator, by STATICCALL: valid by the protocol, but VERIFY reads storage that is
// not the sender's.
await send('C. alice pays; ExternalOwnerValidator judges (STATICCALL, module storage)', await viaModule(account.address, externalOwnerValidator.address, alice, [pay]))

// D. CountingValidator: VERIFY runs static, so the counter write halts the module.
await send('D. alice pays; CountingValidator judges (DELEGATECALL, writes a counter)', await viaModule(account.address, countingValidator.address, alice, [pay]))

console.log('\npool', JSON.stringify(await rpc(client, 'txpool_status', [])))
const [after, nonce] = await Promise.all([client.getBalance({ address: account.address }), client.getTransactionCount({ address: account.address })])
console.log(`${account.address}: ${formatEther(after)} ETH, nonce ${nonce}`)
