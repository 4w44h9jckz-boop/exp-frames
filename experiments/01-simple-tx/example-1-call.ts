// EIP-8141 Example 1: simple transaction (a contract call) from an EOA.
//
// | Frame | Mode   | Caller      | Flags                         | Target        | Value | Data      |
// | 0     | VERIFY | ENTRY_POINT | APPROVE_EXECUTION_AND_PAYMENT | Null (sender) | 0     | Empty     |
// | 1     | SENDER | Sender      | APPROVE_SCOPE_NONE            | Target        | 0     | Call data |
//
// Run twice over: first with the CREATE2 deployer as the target (deploying the probe
// contract), then with the probe itself as the target. The second transaction adds a
// DEFAULT frame after the SENDER frame to compare what each mode looks like to the callee.
//
// usage: npx tsx experiments/01-simple-tx/example-1-call.ts [--dry-run]
import { type Hex, hexToBigInt, isAddressEqual, stringToHex } from 'viem'
import { loadKey } from '../../src/env.js'
import { DRY_RUN, execute } from '../../src/execute.js'
import {
  Approve,
  CREATE2_DEPLOYER,
  ENTRY_POINT,
  STORAGE_SET_STATE_GAS,
  defaultFrame,
  makeClient,
  modeName,
  prepareFrameTx,
  secp256k1Placeholder,
  senderFrame,
  verifyFrame,
} from '../../src/frametx/index.js'
import { PROBE_ADDRESS, PROBE_DEPLOY_CALLDATA, PROBE_RUNTIME, decodeProbeLog } from './probe.js'

const { privateKey, address: sender } = loadKey()
const client = makeClient()
const verify = verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 20_000n })

// --- 1. Deploy the probe: Example 1 with target = CREATE2 deployer, data = salt ‖ initcode ---
const code = await client.getCode({ address: PROBE_ADDRESS })
if (code === PROBE_RUNTIME) {
  console.log(`probe already deployed at ${PROBE_ADDRESS}`)
} else {
  const deploy = await prepareFrameTx(client, {
    sender,
    frames: [
      verify,
      // State gas: the new account (120 × CPSB) plus its code deposit (CPSB per byte).
      senderFrame({ target: CREATE2_DEPLOYER, data: PROBE_DEPLOY_CALLDATA, execution: 100_000n, state: 300_000n }),
    ],
    signatures: [secp256k1Placeholder()],
  })
  await execute(client, deploy, [privateKey], { label: `Example 1: deploy probe via CREATE2 → ${PROBE_ADDRESS}` })
  if (DRY_RUN) {
    console.log('(dry run: the probe is not deployed, so the call below would hit an empty account)')
    process.exit(0)
  }
}

// --- 2. Call the probe: Example 1 with target = probe, plus a DEFAULT frame for comparison ---
const call = await prepareFrameTx(client, {
  sender,
  frames: [
    verify,
    // The first ever call sets slot 0 from zero: one fresh storage slot of state gas.
    senderFrame({ target: PROBE_ADDRESS, data: stringToHex('hello from a SENDER frame'), execution: 50_000n, state: STORAGE_SET_STATE_GAS }),
    defaultFrame({ target: PROBE_ADDRESS, data: stringToHex('hello from a DEFAULT frame'), execution: 50_000n, state: STORAGE_SET_STATE_GAS }),
  ],
  signatures: [secp256k1Placeholder()],
})
const { receipt, tx } = await execute(client, call, [privateKey], { label: 'Example 1: call the probe' })

if (receipt) {
  console.log('\nwhat the probe saw:')
  receipt.frameReceipts.forEach((fr, i) => {
    for (const log of fr.logs.filter((l) => isAddressEqual(l.address, PROBE_ADDRESS))) {
      const p = decodeProbeLog(log.data as Hex)
      const who = (a: string) => (isAddressEqual(a as Hex, sender) ? 'sender' : isAddressEqual(a as Hex, ENTRY_POINT) ? 'ENTRY_POINT' : a)
      console.log(
        `  frame ${i} (${modeName(tx.frames[i].mode)}): caller=${who(p.caller)} origin=${who(p.origin)} callvalue=${p.callvalue} counter=${p.counter} state gas=${hexToBigInt(fr.stateGasUsed)}`,
      )
    }
  })
}
