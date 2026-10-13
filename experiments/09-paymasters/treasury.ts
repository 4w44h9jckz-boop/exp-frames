// Experiment 09: a 2-of-3 multisig treasury pays for its members (Track B's shared payer).
//
// | Frame | Mode   | Flags             | Target        | Signatures                                  |
// | 0     | VERIFY | APPROVE_EXECUTION | Null (sender) | entry 0: the member (default code)          |
// | 1     | VERIFY | APPROVE_PAYMENT   | treasury      | entries 1, 2: two owners over the sig hash  |
// | 2     | SENDER | -                 | funder        |                                             |
//
// The treasury is experiment 05's Multisig, unchanged: its VERIFY approves whatever scope the frame
// allows once k owners have signed the sig hash, and it reads only its own code. A non-canonical
// paymaster with no storage reads: admitted, but capped at one pending transaction.
//
// usage: npx tsx experiments/09-paymasters/treasury.ts
import { formatEther, parseEther } from 'viem'
import { sendFrames } from '../../src/deploy.js'
import { execute } from '../../src/execute.js'
import { senderFrame } from '../../src/frametx/index.js'
import { burst, client, derive, privateKey, sponsored, treasury } from './paymaster.js'

const [alice, bob, carol] = ['alice', 'bob', 'carol'].map(derive)
const vault = treasury([alice.address, bob.address, carol.address], 2, 'treasury-2of3/v1')
const members = [0, 1, 2].map((i) => derive(`member-${i}`))

{
  const frames = []
  if (!(await client.getCode({ address: vault.address }))) frames.push(vault.deploy)
  const balance = await client.getBalance({ address: vault.address })
  if (balance < parseEther('0.005')) frames.push(senderFrame({ target: vault.address, value: parseEther('0.01') - balance, execution: 30_000n }))
  if (frames.length) await sendFrames(client, privateKey, frames, { label: 'setup: deploy and fund the 2-of-3 treasury' })
  console.log(`treasury ${vault.address}: ${formatEther(await client.getBalance({ address: vault.address }))} ETH`)
}

const pay = (i: number, owners: (typeof alice)[]) =>
  sponsored(members[i], vault.address, owners.map((o) => o.key), { extraEntries: owners.map((o) => o.address), payExecution: 30_000n })

await execute(client, await pay(0, [alice, carol]), [], { label: 'member-0, paid by the treasury (alice + carol co-sign)' })
await burst('two members at once through the treasury', await Promise.all([pay(1, [alice, bob]), pay(2, [bob, carol])]))
const one = await pay(1, [alice])
const sim = await (await import('../../src/frametx/index.js')).simulateFrameTx(client, one)
console.log(`\none owner only: valid=${sim.valid}${sim.violation ? ` (${sim.violation})` : ''}`)
console.log(`treasury ${formatEther(await client.getBalance({ address: vault.address }))} ETH`)
