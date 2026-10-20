// Experiment 31: recovery from the owner's own devices. The owner's phone holds the key. Two of
// the owner's devices, both needed, can hand the account to a new key after a delay, and the
// owner can cancel during it. Nobody else holds anything. The same steps run against two
// deployments that differ in one constructor word, the rule that says when a finish is too early:
// the EIP's (in execution) and ethrex's (in VERIFY, through the expiry verifier).
//
//   A  the owner pays
//   B  the two devices start a recovery to a new phone's key
//   C  the new key finishes before the delay is over
//   D  the new key finishes after the delay
//   E  the new owner pays; the lost key is refused
//   F  the devices start a recovery to a thief's key; the owner cancels; the thief is refused
//
// usage: npx tsx experiments/31-device-recovery/run.ts [eip|ethrex]...   (default: both)
import { type Hex, formatEther, keccak256, parseEther, toHex } from 'viem'
import { sendFrames } from '../../src/deploy.js'
import { type FrameTx, frameReceiptGas, frameReceiptStatus, sendFrameTx, senderFrame, simulateFrameTx, waitForFrameTxReceipt } from '../../src/frametx/index.js'
import { type Devices, Op, type Rule, accountTx, client, derive, deviceRecoveryAccount, funder, op, privateKey, readState, reveal, start } from './device.js'

const DELAY = 60n // seconds; days in practice
const rules = (process.argv.slice(2).filter((a) => a === 'eip' || a === 'ethrex') as Rule[]).concat()
const RULES: Rule[] = rules.length ? rules : ['eip', 'ethrex']
const phone = derive('phone')
const newPhone = derive('new-phone')
const thief = derive('thief')
const devices: Devices = { salt: keccak256(toHex(`${privateKey}/exp-frames/31/salt`)), m: 2, devices: ['laptop', 'hardware-key'].map(derive) }
const head = async () => (await client.getBlock({ blockTag: 'latest' })).timestamp
type Row = { rule: Rule; step: string; outcome: string; hash?: Hex; gasUsed?: bigint; frames?: string }
const rows: Row[] = []

async function send(rule: Rule, step: string, tx: FrameTx): Promise<void> {
  const sim = await simulateFrameTx(client, tx)
  if (!sim.valid) {
    // Refused in simulation: confirm the node also refuses to admit it.
    let admission = 'not sent'
    try {
      await sendFrameTx(client, tx)
      admission = 'ADMITTED'
    } catch (e) {
      admission = `eth_sendRawTransaction refused: ${(e as Error).message.split('\n')[0].slice(0, 120)}`
    }
    console.log(`${rule} ${step}: refused in simulation (${sim.violation}); ${admission}`)
    rows.push({ rule, step, outcome: `refused at admission: ${sim.violation}` })
    return
  }
  const hash = await sendFrameTx(client, tx)
  const r = await waitForFrameTxReceipt(client, hash)
  const frames = r.frameReceipts.map((f) => {
    const g = frameReceiptGas(f)
    return `${frameReceiptStatus(f)}:${g.execution}${g.state ? `+${g.state}s` : ''}`
  })
  const ok = r.frameReceipts.every((f) => frameReceiptStatus(f) === 1)
  console.log(`${rule} ${step}: ${hash} block ${BigInt(r.blockNumber)} gasUsed ${BigInt(r.gasUsed)} frames ${frames.join(' / ')}`)
  rows.push({ rule, step, outcome: ok ? 'mined' : 'mined, a frame failed', hash, gasUsed: BigInt(r.gasUsed), frames: frames.join(' / ') })
}

for (const rule of RULES) {
  const account = deviceRecoveryAccount(phone.address, devices, DELAY, rule, 'exp-frames/31/device-recovery-account')
  console.log(`\n=== ${rule}: DeviceRecoveryAccount ${account.address}; owner ${phone.address}; devices ${devices.devices.map((d) => d.address).join(', ')} (2 of 2); new phone ${newPhone.address}`)

  // Setup: the funder deploys and funds the account.
  const hasCode = Boolean(await client.getCode({ address: account.address }))
  const balance = await client.getBalance({ address: account.address })
  const frames = []
  if (!hasCode) frames.push(account.deploy)
  if (balance < parseEther('0.005')) frames.push(senderFrame({ target: account.address, value: parseEther('0.01') - balance, execution: 30_000n }))
  if (frames.length) await sendFrames(client, privateKey, frames, { label: `setup: deploy and fund the ${rule} account` })
  const s0 = await readState(account.address)
  if (s0.owner.toLowerCase() !== phone.address.toLowerCase()) throw new Error(`${rule}: the account has already been recovered; change the label to run again`)
  const pay = senderFrame({ target: funder, value: parseEther('0.0001'), execution: 30_000n })

  await send(rule, 'A. the owner pays', await accountTx(account.address, [phone], [pay]))
  // B. The phone is lost. The laptop and the hardware key start a recovery to the new phone's key.
  await send(rule, 'B. the two devices start a recovery', await accountTx(account.address, devices.devices, [start(account.address, newPhone.address)], { verifyData: reveal(devices) }))
  const { unlock } = await readState(account.address)
  console.log(`${rule}: pending ${newPhone.address}, unlock ${unlock}, head ${await head()}`)
  // C. Too early: under the EIP's rule it is admitted and reverts; under ethrex's it is refused.
  await send(rule, 'C. the new key finishes before the delay', await accountTx(account.address, [newPhone], [op(account.address, Op.FINISH)]))
  // D. After the delay.
  while ((await head()) < unlock) await new Promise((r) => setTimeout(r, 3000))
  await send(rule, 'D. the new key finishes after the delay', await accountTx(account.address, [newPhone], [op(account.address, Op.FINISH)]))
  const s1 = await readState(account.address)
  if (s1.owner.toLowerCase() !== newPhone.address.toLowerCase()) throw new Error(`${rule}: D did not hand the account over: owner ${s1.owner}`)
  await send(rule, 'E. the new owner pays', await accountTx(account.address, [newPhone], [pay]))
  await send(rule, 'E. the lost key tries to pay', await accountTx(account.address, [phone], [pay]))
  // F. The devices are stolen together, and the thief starts a recovery; the owner cancels in time.
  await send(rule, "F. the devices start a recovery to a thief's key", await accountTx(account.address, devices.devices, [start(account.address, thief.address)], { verifyData: reveal(devices) }))
  await send(rule, 'F. the owner cancels during the delay', await accountTx(account.address, [newPhone], [op(account.address, Op.CANCEL)]))
  await send(rule, 'F. the thief tries to finish', await accountTx(account.address, [thief], [op(account.address, Op.FINISH)]))
  const s2 = await readState(account.address)
  console.log(`${rule}: owner ${s2.owner}, pending ${s2.pending}; balance ${formatEther(await client.getBalance({ address: account.address }))} ETH`)
}

console.log('\n| Rule | Step | Outcome | Tx | `gasUsed` | Frames (status:execution+state) |\n|---|---|---|---|---|---|')
for (const r of rows) {
  const tx = r.hash ? `[\`${r.hash.slice(0, 10)}...\`](https://dora.privacy.ethrex.xyz/tx/${r.hash})` : ''
  console.log(`| ${r.rule} | ${r.step} | ${r.outcome} | ${tx} | ${r.gasUsed ?? ''} | ${r.frames ?? ''} |`)
}
process.exit(0)
