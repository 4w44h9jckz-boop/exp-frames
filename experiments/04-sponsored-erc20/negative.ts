// What TokenSponsor and the protocol refuse, checked by simulation. Needs one setup tx: a fresh
// user gets 100 tUSD through an EOA-sponsored transaction (as in step 1 of the example).
//
// usage: npx tsx experiments/04-sponsored-erc20/negative.ts
import { type Hex, parseEther } from 'viem'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'
import { loadKey } from '../../src/env.js'
import { execute } from '../../src/execute.js'
import {
  ATOMIC_BATCH_FLAG,
  Approve,
  CREATE2_DEPLOYER,
  type Frame,
  type FrameSignature,
  type FrameTx,
  NEW_ACCOUNT_STATE_GAS,
  STORAGE_SET_STATE_GAS,
  makeClient,
  prepareFrameTx,
  secp256k1Placeholder,
  senderFrame,
  signFrameTx,
  simulateFrameTx,
  verifyFrame,
} from '../../src/frametx/index.js'
import { TOKEN, call, ensureSetup, feeTransfer, postOp, prepareSponsored, sponsorVerify } from './sponsor.js'

const { privateKey: ownerKey, address: owner } = loadKey()
const client = makeClient()
const sponsor = await ensureSetup(client, ownerKey, owner)

const userKey = generatePrivateKey()
const user = privateKeyToAddress(userKey)
const friend = privateKeyToAddress(generatePrivateKey())

const userVerify = verifyFrame({ scope: Approve.EXECUTION, execution: 10_000n })
const ownerPays = (state = 0n) => verifyFrame({ scope: Approve.PAYMENT, target: owner, execution: 10_000n, state })
const mint = senderFrame({ target: TOKEN, data: call('mint', [user, parseEther('100')]), execution: 60_000n, state: 2n * STORAGE_SET_STATE_GAS })
await execute(
  client,
  await prepareFrameTx(client, {
    sender: user,
    frames: [userVerify, ownerPays(NEW_ACCOUNT_STATE_GAS), mint],
    signatures: [secp256k1Placeholder(), secp256k1Placeholder(owner)],
  }),
  [userKey, ownerKey],
  { label: `setup: fresh user ${user} gets 100 tUSD, gas paid by the owner EOA` },
)

const send5 = senderFrame({ target: TOKEN, data: call('transfer', [friend, parseEther('5')]), execution: 50_000n, state: STORAGE_SET_STATE_GAS })
const { tx: good, fee } = await prepareSponsored(client, { user, sponsor, calls: [send5] })

/** Example 3 with its frames replaced. Same nonce, fees and signature layout. */
const variant = (frames: Frame[], sender = user): FrameTx => ({ ...good, sender, frames })
const at = (i: number, frame: Frame) => good.frames.map((f, j) => (j === i ? frame : f))
const withFlags = (frame: Frame, flags: number): Frame => ({ ...frame, flags })

const nobodyKey = generatePrivateKey()
const nobody = privateKeyToAddress(nobodyKey)
const nobodyTx = await prepareSponsored(client, { user: nobody, sponsor, calls: [send5], payState: NEW_ACCOUNT_STATE_GAS })

const cases: [string, () => Promise<FrameTx>][] = [
  ['Example 3 as designed', () => signFrameTx(good, userKey)],
  // Not "1 unit short": the quote assumes a signature with no zero bytes, so it can sit up to
  // 65 × 12 gas × max_fee × RATE above what the signed transaction needs.
  ['fee 1% short', () => signFrameTx(variant(at(2, feeTransfer(sponsor, fee - fee / 100n))), userKey)],
  [
    'fee paid to someone else',
    () => signFrameTx(variant(at(2, { ...feeTransfer(sponsor, fee), data: call('transfer', [friend, fee]) })), userKey),
  ],
  ['fee frame targets another contract', () => signFrameTx(variant(at(2, { ...feeTransfer(sponsor, fee), target: CREATE2_DEPLOYER })), userKey)],
  ['fee transfer batched with the user call (ATOMIC_BATCH_FLAG)', () => signFrameTx(variant(at(2, withFlags(feeTransfer(sponsor, fee), ATOMIC_BATCH_FLAG))), userKey)],
  ['user call before the fee transfer', () => signFrameTx(variant([good.frames[0], good.frames[1], send5, good.frames[2], good.frames[4]]), userKey)],
  ['pay frame flags APPROVE_EXECUTION_AND_PAYMENT', () => signFrameTx(variant(at(1, withFlags(sponsorVerify(sponsor), Approve.EXECUTION_AND_PAYMENT))), userKey)],
  ['pay frame before the sender approves execution', () => signFrameTx(variant([good.frames[1], good.frames[0], ...good.frames.slice(2)]), userKey)],
  [
    'two post-op frames, fee re-quoted (refund twice?)',
    async () => signFrameTx((await prepareSponsored(client, { user, sponsor, calls: [send5, postOp(sponsor)] })).tx, userKey),
  ],
  ['sender holds no tokens (fresh key, no account)', () => signFrameTx(nobodyTx.tx, nobodyKey)],
  [
    'EOA sponsor: signatures swapped (sponsor at index 0)',
    async () => {
      const t = await prepareFrameTx(client, { sender: user, frames: [userVerify, ownerPays(), send5], signatures: [secp256k1Placeholder(owner), secp256k1Placeholder()] })
      return signFrameTx(await signFrameTx(t, userKey), ownerKey)
    },
  ],
  [
    'EOA sponsor: its entry has an empty signer (resolves to the sender)',
    async () => {
      const sigs: FrameSignature[] = [secp256k1Placeholder(), secp256k1Placeholder()]
      const t = await prepareFrameTx(client, { sender: user, frames: [userVerify, ownerPays(), send5], signatures: sigs })
      return signFrameTx(t, userKey) // fills both entries with the user's signature
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
  console.log(
    `  valid=${sim.valid} shape=${sim.prefixShape} payer=${sim.payer ?? 'none'}` +
      (sim.gasUsed ? ` gasUsed=${BigInt(sim.gasUsed)} (pre-refund)` : '') +
      (sim.violation ? `\n  violation: ${sim.violation}` : ''),
  )
  if (sim.frames) console.log(`  frames: ${sim.frames.map((f, i) => `[${i}] ${f.succeeded ? 'ok' : 'FAILED'} gas=${BigInt(f.gasUsed as Hex)}`).join('  ')}`)
}
