// Experiment 23: what an approval has to commit to. Run: npx tsx experiments/23-approval-scope/example-scope.ts [setup|A|B|C|D|all]
import { type Address, type Hex, formatEther, getAddress } from 'viem'
import { sendFrames } from '../../src/deploy.js'
import {
  type FrameTx,
  type FrameTxReceiptJson,
  NEW_ACCOUNT_STATE_GAS,
  describeReceipt,
  describeTx,
  frameReceiptGas,
  frameReceiptStatus,
  frameSigHash,
  frameTxHash,
  getFrameTxReceipt,
  prepareFrameTx,
  secp256k1Placeholder,
  senderFrame,
  sendFrameTx,
  signAll,
  simulateFrameTx,
  waitForFrameTxReceipt,
} from '../../src/frametx/index.js'
import {
  AMM_ADDRESS,
  AMOUNTS,
  BOT_ADDRESS,
  LITERAL_ACCOUNT_ADDRESS,
  PAY_THE_PAYER_ADDRESS,
  SCOPED_ACCOUNT_ADDRESS,
  TOKEN_A,
  TOKEN_B,
  ammAbi,
  approveFrame,
  backFrame,
  balanceOf,
  call,
  client,
  deployedAt,
  deployments,
  executionDigest,
  frontFrame,
  funder,
  literalOwner,
  mint,
  onlyVerify,
  payFrame,
  payThePayerFrame,
  planSandwich,
  privateKey,
  quote,
  reserves,
  scopedOwner,
  selfVerify,
  senderFramesDigest,
  sponsor1,
  sponsor2,
  swapFrame,
} from './scope.js'

const fmt = (wei: bigint) => formatEther(wei)
const TIP = 1_000n

async function fees(tip = TIP) {
  const block = await client.getBlock({ blockTag: 'latest' })
  const base = block.baseFeePerGas ?? 0n
  return { maxPriorityFeePerGas: tip, maxFeePerGas: base * 2n + tip, maxFeePerBlobGas: 0n }
}

/** Both fee fields up by at least the conventional 10 per cent, as a replacement needs. */
const bumped = (f: FrameTx['fees'], num = 12n, den = 10n) => ({
  ...f,
  maxPriorityFeePerGas: (f.maxPriorityFeePerGas * num) / den,
  maxFeePerGas: (f.maxFeePerGas * num) / den,
})

async function nextBlock(): Promise<bigint> {
  const start = await client.getBlockNumber()
  for (;;) {
    const n = await client.getBlockNumber()
    if (n > start) return n
    await new Promise((r) => setTimeout(r, 250))
  }
}

async function simulate(label: string, tx: FrameTx) {
  const sim = await simulateFrameTx(client, tx)
  console.log(`  simulate ${label}: valid=${sim.valid}${sim.violation ? ` violation=${sim.violation}` : ''}${sim.executionError ? ` error=${sim.executionError}` : ''}`)
  return sim
}

async function trySend(label: string, tx: FrameTx): Promise<Hex | null> {
  try {
    const h = await sendFrameTx(client, tx)
    console.log(`  sent ${label}: ${h}`)
    return h
  } catch (e) {
    const err = e as Error & { details?: string; cause?: { details?: string } }
    console.log(`  refused ${label}: ${err.details ?? err.cause?.details ?? err.message.split('\n')[0]}`)
    return null
  }
}

/** Wait for whichever of the hashes gets a receipt. */
async function firstReceipt(hashes: (Hex | null)[], timeoutMs = 90_000): Promise<{ hash: Hex; receipt: FrameTxReceiptJson } | null> {
  const live = hashes.filter((h): h is Hex => h !== null)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const h of live) {
      const r = await getFrameTxReceipt(client, h)
      if (r) return { hash: h, receipt: r }
    }
    await new Promise((r) => setTimeout(r, 1_000))
  }
  return null
}

function frameGas(receipt: FrameTxReceiptJson) {
  return receipt.frameReceipts.map((f) => {
    const g = frameReceiptGas(f)
    return `${frameReceiptStatus(f) === 1 ? 'ok' : frameReceiptStatus(f) === 2 ? 'skipped' : 'FAILED'} ${g.execution}/${g.state}`
  })
}

// ---------------------------------------------------------------------------------------------

async function setup() {
  const codes = await Promise.all(deployedAt.map((address) => client.getCode({ address })))
  if (codes.every((c) => c && c !== '0x')) {
    console.log('setup: already done')
    return
  }
  const eth = (to: Address, newAccount: boolean) =>
    senderFrame({ target: to, value: AMOUNTS.accountEth, execution: 30_000n, state: newAccount ? NEW_ACCOUNT_STATE_GAS : 0n })
  await sendFrames(
    client,
    privateKey,
    [
      ...deployments.map((d) => d.frame),
      mint(TOKEN_A, AMM_ADDRESS, AMOUNTS.reserve),
      mint(TOKEN_B, AMM_ADDRESS, AMOUNTS.reserve),
      senderFrame({ target: AMM_ADDRESS, data: call(ammAbi, 'sync', []), execution: 60_000n, state: 2n * 97_920n }),
      mint(TOKEN_A, BOT_ADDRESS, AMOUNTS.botA),
      mint(TOKEN_A, LITERAL_ACCOUNT_ADDRESS, AMOUNTS.victimA),
      mint(TOKEN_A, SCOPED_ACCOUNT_ADDRESS, AMOUNTS.victimA),
      eth(LITERAL_ACCOUNT_ADDRESS, false),
      eth(SCOPED_ACCOUNT_ADDRESS, false),
      eth(sponsor1.address, true),
      eth(sponsor2.address, true),
    ],
    { label: 'setup: tokens, pool, bot, PayThePayer, both accounts; reserves, balances and ETH' },
  )
}

async function swapTerms() {
  const r = await reserves()
  const quoted = quote(AMOUNTS.swap, r.a, r.b)
  const minOut = (quoted * (10_000n - AMOUNTS.slippageBps)) / 10_000n
  return { r, quoted, minOut }
}

async function snapshot(account: Address) {
  const [ethBal, a, b, botA, botB] = await Promise.all([
    client.getBalance({ address: account }),
    balanceOf(TOKEN_A, account),
    balanceOf(TOKEN_B, account),
    balanceOf(TOKEN_A, BOT_ADDRESS),
    balanceOf(TOKEN_B, BOT_ADDRESS),
  ])
  return { eth: ethBal, a, b, botA, botB }
}

function diff(label: string, before: Awaited<ReturnType<typeof snapshot>>, after: Awaited<ReturnType<typeof snapshot>>) {
  console.log(
    `  ${label}: account ETH ${fmt(after.eth - before.eth)}, A ${fmt(after.a - before.a)}, B ${fmt(after.b - before.b)}; bot A ${fmt(after.botA - before.botA)}, B ${fmt(after.botB - before.botB)}`,
  )
}

/** The literal account's honest swap: [self_verify, approve, swap], signed over D. */
async function literalHonest(tip = TIP) {
  const { r, quoted, minOut } = await swapTerms()
  let tx = await prepareFrameTx(client, {
    sender: LITERAL_ACCOUNT_ADDRESS,
    frames: [selfVerify(), approveFrame(TOKEN_A, AMM_ADDRESS, AMOUNTS.swap), swapFrame(AMOUNTS.swap, minOut, LITERAL_ACCOUNT_ADDRESS)],
    signatures: [secp256k1Placeholder(literalOwner.address, `0x${'11'.repeat(32)}`)],
    fees: await fees(tip),
  })
  const D = senderFramesDigest(tx)
  tx = { ...tx, signatures: [secp256k1Placeholder(literalOwner.address, D)] }
  tx = await signAll(tx, [literalOwner.key])
  return { tx, D, r, quoted, minOut }
}

// A. Anyone who sees the literal account's transaction inserts a sandwich and replaces it.
async function scenarioA() {
  console.log('\n=== A. The literal account: a sandwich inserted by replacement ===')
  const { tx: honest, D, r, quoted, minOut } = await literalHonest()
  const botA = await balanceOf(TOKEN_A, BOT_ADDRESS)
  const plan = planSandwich(AMOUNTS.swap, minOut, r.a, r.b, botA)
  console.log(`  pool ${fmt(r.a)} A / ${fmt(r.b)} B; quote ${fmt(quoted)} B for ${fmt(AMOUNTS.swap)} A; minOut ${fmt(minOut)}`)
  console.log(`  plan: front ${fmt(plan.x)} A, victim gets ${fmt(plan.victimB)} B, bot ends +${fmt(plan.profit)} A`)

  const frames = [...honest.frames]
  const attacked: FrameTx = {
    ...honest,
    frames: [frames[0], frames[1], frontFrame(plan.x), frames[2], backFrame()],
    fees: bumped(honest.fees),
  }
  console.log(`  D(honest) = ${D}\n  D(attacked) = ${senderFramesDigest(attacked)} (same signature entry, not re-signed)`)
  console.log(`  tx hash honest ${frameTxHash(honest)}, attacked ${frameTxHash(attacked)}`)
  await simulate('honest', honest)
  await simulate('attacked', attacked)

  const before = await snapshot(LITERAL_ACCOUNT_ADDRESS)
  await nextBlock()
  const h1 = await trySend('honest', honest)
  const h2 = await trySend('attacked (replacement, fees x1.2)', attacked)
  const got = await firstReceipt([h2, h1])
  if (!got) throw new Error('nothing mined')
  console.log(`  mined: ${got.hash === h2 ? 'ATTACKED' : 'honest'} ${got.hash} in block ${BigInt(got.receipt.blockNumber)}`)
  console.log(describeReceipt(got.hash === h2 ? attacked : honest, got.receipt))
  const after = await snapshot(LITERAL_ACCOUNT_ADDRESS)
  diff('balances', before, after)
  if (got.hash === h2) {
    console.log(`  the victim received ${fmt(after.b - before.b)} B where the quote was ${fmt(quoted)}: ${fmt(quoted - (after.b - before.b))} B less`)
  }
  return got
}

// B. The fees are outside D: whoever relays the literal account's transaction sets them.
async function scenarioB() {
  console.log('\n=== B. The literal account: fees set by the relay ===')
  const { tx: honest } = await literalHonest()
  const rewritten: FrameTx = {
    ...honest,
    fees: { ...honest.fees, maxPriorityFeePerGas: 10_000_000_000n, maxFeePerGas: honest.fees.maxFeePerGas + 10_000_000_000n },
  }
  console.log(`  honest tip ${honest.fees.maxPriorityFeePerGas} wei; relayed tip ${rewritten.fees.maxPriorityFeePerGas} wei, same signature entry`)
  await simulate('rewritten', rewritten)
  const before = await snapshot(LITERAL_ACCOUNT_ADDRESS)
  const h = await trySend('rewritten', rewritten)
  if (!h) return
  const receipt = await waitForFrameTxReceipt(client, h)
  console.log(describeReceipt(rewritten, receipt))
  const after = await snapshot(LITERAL_ACCOUNT_ADDRESS)
  diff('balances', before, after)
  const gasUsed = BigInt(receipt.gasUsed)
  const price = BigInt(receipt.effectiveGasPrice)
  const base = price - rewritten.fees.maxPriorityFeePerGas
  console.log(`  frames: ${frameGas(receipt).join(' | ')}`)
  console.log(
    `  paid ${fmt(before.eth - after.eth)} ETH for ${gasUsed} gas at ${price} wei; at the tip the owner chose (${honest.fees.maxPriorityFeePerGas} wei) it was ${fmt(gasUsed * (base + honest.fees.maxPriorityFeePerGas))} ETH`,
  )
  return receipt
}

/** The scoped account, sponsored: [only_verify, pay(payer), ...ops], entry 0 = owner over E. */
async function scopedSponsored(ops: FrameTx['frames'], payer: { key: Hex; address: Address }, tip = TIP) {
  let tx = await prepareFrameTx(client, {
    sender: SCOPED_ACCOUNT_ADDRESS,
    frames: [onlyVerify(40_000n), payFrame(payer.address), ...ops],
    signatures: [secp256k1Placeholder(scopedOwner.address, `0x${'11'.repeat(32)}`), secp256k1Placeholder(payer.address)],
    fees: await fees(tip),
  })
  const E = executionDigest(tx)
  tx = { ...tx, signatures: [secp256k1Placeholder(scopedOwner.address, E), secp256k1Placeholder(payer.address)] }
  tx = await signAll(tx, [scopedOwner.key, payer.key])
  return { tx, E }
}

/** Give the same owner signature (entry 0) to another payer: new pay frame, fees and entry 1. */
async function repay(tx: FrameTx, payer: { key: Hex; address: Address }, newFees: FrameTx['fees']) {
  const frames = tx.frames.map((f, i) => (i === 1 ? payFrame(payer.address) : f))
  const next: FrameTx = { ...tx, frames, fees: newFees, signatures: [tx.signatures[0], secp256k1Placeholder(payer.address)] }
  return signAll(next, [payer.key])
}

// C. The same two attacks against the scoped account.
async function scenarioC() {
  console.log('\n=== C. The scoped account against the same attacks ===')
  const { r, minOut } = await swapTerms()
  const botA = await balanceOf(TOKEN_A, BOT_ADDRESS)
  const plan = planSandwich(AMOUNTS.swap, minOut, r.a, r.b, botA)

  // C1: paying for itself, it signs the canonical sig hash.
  let self = await prepareFrameTx(client, {
    sender: SCOPED_ACCOUNT_ADDRESS,
    frames: [selfVerify(), approveFrame(TOKEN_A, AMM_ADDRESS, AMOUNTS.swap), swapFrame(AMOUNTS.swap, minOut, SCOPED_ACCOUNT_ADDRESS)],
    signatures: [secp256k1Placeholder(scopedOwner.address)],
    fees: await fees(),
  })
  self = await signAll(self, [scopedOwner.key])
  const selfAttacked: FrameTx = { ...self, frames: [self.frames[0], self.frames[1], frontFrame(plan.x), self.frames[2], backFrame()], fees: bumped(self.fees) }
  console.log('  C1. self-paying (canonical sig hash): sandwich + fee bump, owner signature reused')
  await simulate('C1 attacked', selfAttacked)
  await trySend('C1 attacked', selfAttacked)

  // C2: sponsored, and the sponsor is the attacker: it re-signs its own entry, not the owner's.
  const ops = [approveFrame(TOKEN_A, AMM_ADDRESS, AMOUNTS.swap), swapFrame(AMOUNTS.swap, minOut, SCOPED_ACCOUNT_ADDRESS)]
  const { tx: honest, E } = await scopedSponsored(ops, sponsor1)
  let attacked: FrameTx = {
    ...honest,
    frames: [honest.frames[0], honest.frames[1], honest.frames[2], frontFrame(plan.x), honest.frames[3], backFrame()],
    signatures: [honest.signatures[0], secp256k1Placeholder(sponsor1.address)],
  }
  attacked = await signAll(attacked, [sponsor1.key])
  console.log(`  C2. sponsored, attacker = sponsor: E(honest) ${E}, E(attacked) ${executionDigest(attacked)}`)
  await simulate('C2 honest', honest)
  await simulate('C2 attacked', attacked)
  await trySend('C2 attacked', attacked)

  // C3: appending only (a back-run inside the transaction, on the owner's nonce).
  let appended: FrameTx = { ...honest, frames: [...honest.frames, backFrame()], signatures: [honest.signatures[0], secp256k1Placeholder(sponsor1.address)] }
  appended = await signAll(appended, [sponsor1.key])
  await simulate('C3 appended DEFAULT frame', appended)
}

// D. One owner signature, two sponsors: the second replaces the first and is paid in Token A.
async function scenarioD() {
  console.log('\n=== D. Open sponsorship: one signature, two payers ===')
  const { quoted, minOut } = await swapTerms()
  const ops = [
    approveFrame(TOKEN_A, PAY_THE_PAYER_ADDRESS, AMOUNTS.fee),
    payThePayerFrame(AMOUNTS.fee),
    approveFrame(TOKEN_A, AMM_ADDRESS, AMOUNTS.swap),
    swapFrame(AMOUNTS.swap, minOut, SCOPED_ACCOUNT_ADDRESS),
  ]
  const { tx: viaS1, E } = await scopedSponsored(ops, sponsor1)
  const viaS2 = await repay(viaS1, sponsor2, bumped(viaS1.fees))
  console.log(`  owner signs once: E = ${E}`)
  console.log(`  via sponsor 1: E ${executionDigest(viaS1)}, sig hash ${frameSigHash(viaS1)}, tx ${frameTxHash(viaS1)}`)
  console.log(`  via sponsor 2: E ${executionDigest(viaS2)}, sig hash ${frameSigHash(viaS2)}, tx ${frameTxHash(viaS2)}`)
  console.log(`  entry 0 identical: ${viaS1.signatures[0].signature === viaS2.signatures[0].signature}`)
  console.log(describeTx(viaS2))
  await simulate('via sponsor 1', viaS1)
  await simulate('via sponsor 2', viaS2)

  const bal = async () => ({
    s1: await client.getBalance({ address: sponsor1.address }),
    s2: await client.getBalance({ address: sponsor2.address }),
    s1A: await balanceOf(TOKEN_A, sponsor1.address),
    s2A: await balanceOf(TOKEN_A, sponsor2.address),
    b: await balanceOf(TOKEN_B, SCOPED_ACCOUNT_ADDRESS),
  })
  const before = await bal()
  await nextBlock()
  const h1 = await trySend('via sponsor 1', viaS1)
  const h2 = await trySend('via sponsor 2 (replacement, other payer, fees x1.2)', viaS2)
  const got = await firstReceipt([h2, h1])
  if (!got) throw new Error('nothing mined')
  const which = got.hash === h2 ? 'sponsor 2' : 'sponsor 1'
  console.log(`  mined: via ${which} ${got.hash}, payer ${getAddress(got.receipt.payer as Address)}`)
  console.log(describeReceipt(got.hash === h2 ? viaS2 : viaS1, got.receipt))
  const after = await bal()
  console.log(
    `  sponsor 1: ETH ${fmt(after.s1 - before.s1)}, A ${fmt(after.s1A - before.s1A)}; sponsor 2: ETH ${fmt(after.s2 - before.s2)}, A ${fmt(after.s2A - before.s2A)}; account B +${fmt(after.b - before.b)} (quote ${fmt(quoted)})`,
  )
  return got
}

// E. Baseline: the scoped account paying for itself over the canonical sig hash.
async function scenarioE() {
  console.log('\n=== E. Baseline: the scoped account pays, canonical sig hash ===')
  const { minOut } = await swapTerms()
  let tx = await prepareFrameTx(client, {
    sender: SCOPED_ACCOUNT_ADDRESS,
    frames: [selfVerify(), approveFrame(TOKEN_A, AMM_ADDRESS, AMOUNTS.swap), swapFrame(AMOUNTS.swap, minOut, SCOPED_ACCOUNT_ADDRESS)],
    signatures: [secp256k1Placeholder(scopedOwner.address)],
    fees: await fees(),
  })
  tx = await signAll(tx, [scopedOwner.key])
  await simulate('baseline', tx)
  const h = await trySend('baseline', tx)
  if (!h) return
  const receipt = await waitForFrameTxReceipt(client, h)
  console.log(describeReceipt(tx, receipt))
  return receipt
}

const which = process.argv[2] ?? 'all'
console.log(`funder ${funder}\nliteral account ${LITERAL_ACCOUNT_ADDRESS} (owner ${literalOwner.address})\nscoped account ${SCOPED_ACCOUNT_ADDRESS} (owner ${scopedOwner.address})`)
console.log(`sponsors ${sponsor1.address}, ${sponsor2.address}; pool ${AMM_ADDRESS}; bot ${BOT_ADDRESS}`)
if (which === 'setup' || which === 'all') await setup()
if (which === 'A' || which === 'all') await scenarioA()
if (which === 'B' || which === 'all') await scenarioB()
if (which === 'C' || which === 'all') await scenarioC()
if (which === 'D' || which === 'all') await scenarioD()
if (which === 'E' || which === 'all') await scenarioE()
