// Experiment 24: a sealed paymaster with a published policy, and a paymaster the PR's scan calls
// sealed that is not. Run: npx tsx experiments/24-sealed-paymaster/example-sealed.ts [setup|run|drain|all]
//
// `run` is one sequence (A to D) because the policy leaves carry deadlines set at its start.
import { type Address, type Hex, formatEther, getAddress, hexToBigInt, keccak256, parseEther, size } from 'viem'
import { sendFrames } from '../../src/deploy.js'
import {
  Approve,
  type FrameTx,
  type FrameTxReceiptJson,
  NEW_ACCOUNT_STATE_GAS,
  calldataCost,
  describeReceipt,
  describeTx,
  expiryFrame,
  frameReceiptGas,
  frameReceiptStatus,
  frameTxHash,
  getFrameTxJson,
  getFrameTxReceipt,
  maxCost,
  prepareFrameTx,
  rpc,
  secp256k1Placeholder,
  senderFrame,
  sendFrameTx,
  signAll,
  simulateFrameTx,
  verifyFrame,
  waitForFrameTxReceipt,
} from '../../src/frametx/index.js'
import { prScan, sealedScan } from './egress.js'
import {
  AMOUNTS,
  MINT,
  POLICY_SALT,
  type Policy,
  type PolicyTree,
  type RootRef,
  SEALED_ADDRESS,
  SELF_SENDING_ADDRESS,
  SOURCE_ID,
  TOKEN_ADDRESS,
  TRANSFER,
  client,
  deployments,
  funder,
  mintFrame,
  onlyVerify,
  owner,
  policyTree,
  privateKey,
  publishRootFrame,
  recentRootFrame,
  sealedPayData,
  sealedPayFrame,
  sourceIdOf,
  sponsor,
  stranger,
  user,
} from './sealed.js'

const fmt = (wei: bigint) => formatEther(wei)
const TIP = 1_000n
const RUN = Date.now().toString(36)

async function fees(tip = TIP) {
  const block = await client.getBlock({ blockTag: 'latest' })
  const base = block.baseFeePerGas ?? 0n
  return { maxPriorityFeePerGas: tip, maxFeePerGas: base * 2n + tip, maxFeePerBlobGas: 0n }
}

async function latest(): Promise<{ number: bigint; slot: bigint; timestamp: bigint }> {
  const b = await rpc<{ number: Hex; slotNumber: Hex; timestamp: Hex }>(client, 'eth_getBlockByNumber', ['latest', false])
  return { number: hexToBigInt(b.number), slot: hexToBigInt(b.slotNumber), timestamp: hexToBigInt(b.timestamp) }
}

async function slotOf(blockNumber: Hex): Promise<bigint> {
  const b = await rpc<{ slotNumber: Hex }>(client, 'eth_getBlockByNumber', [blockNumber, false])
  return hexToBigInt(b.slotNumber)
}

async function nextBlock(): Promise<bigint> {
  const start = await client.getBlockNumber()
  for (;;) {
    const n = await client.getBlockNumber()
    if (n > start) return n
    await new Promise((r) => setTimeout(r, 250))
  }
}

const sleepUntil = async (unix: bigint) => {
  for (;;) {
    const { timestamp } = await latest()
    if (timestamp > unix) return
    await new Promise((r) => setTimeout(r, 2_000))
  }
}

async function simulate(label: string, tx: FrameTx) {
  try {
    const sim = await simulateFrameTx(client, tx)
    console.log(`  simulate ${label}: valid=${sim.valid}${sim.violation ? ` violation=${sim.violation}` : ''}${sim.executionError ? ` error=${sim.executionError}` : ''}`)
    return sim
  } catch (e) {
    const err = e as Error & { details?: string }
    console.log(`  simulate ${label}: error ${err.details ?? err.message.split('\n')[0]}`)
    return null
  }
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

async function receiptOrNull(h: Hex | null, timeoutMs = 40_000): Promise<FrameTxReceiptJson | null> {
  if (!h) return null
  try {
    return await waitForFrameTxReceipt(client, h, { timeoutMs })
  } catch {
    return null
  }
}

function frameGas(receipt: FrameTxReceiptJson) {
  return receipt.frameReceipts.map((f) => {
    const g = frameReceiptGas(f)
    return `${frameReceiptStatus(f) === 1 ? 'ok' : frameReceiptStatus(f) === 2 ? 'skipped' : 'FAILED'} ${g.execution}/${g.state}`
  })
}

// ---------------------------------------------------------------------------------------------

async function setup() {
  const [codes, sealedBal, selfBal, sponsorBal, strangerBal] = await Promise.all([
    Promise.all(deployments.map((d) => client.getCode({ address: d.address }))),
    client.getBalance({ address: SEALED_ADDRESS }),
    client.getBalance({ address: SELF_SENDING_ADDRESS }),
    client.getBalance({ address: sponsor.address }),
    client.getBalance({ address: stranger.address }),
  ])
  const frames = []
  for (const [i, d] of deployments.entries()) if (!codes[i] || codes[i] === '0x') frames.push(d.frame)
  const top = (to: Address, want: bigint, have: bigint, fresh: boolean) =>
    have < want / 2n ? [senderFrame({ target: to, value: want - have, execution: 30_000n, state: fresh && have === 0n ? NEW_ACCOUNT_STATE_GAS : 0n })] : []
  frames.push(
    ...top(SEALED_ADDRESS, AMOUNTS.sealedFloat, sealedBal, false),
    ...top(SELF_SENDING_ADDRESS, AMOUNTS.selfSendingFloat, selfBal, false),
    ...top(sponsor.address, AMOUNTS.sponsorEth, sponsorBal, true),
    ...top(stranger.address, AMOUNTS.sponsorEth, strangerBal, true),
  )
  if (!frames.length) {
    console.log('setup: already done')
    return
  }
  await sendFrames(client, privateKey, frames, { label: 'setup: token, both paymasters, floats, the two root writers' })
}

/** A root write from `writer`, as its own transaction; returns the slot it is filed under. */
async function publish(writer: { key: Hex; address: Address }, root: Hex, label: string): Promise<RootRef & { hash: Hex; receipt: FrameTxReceiptJson }> {
  let tx = await prepareFrameTx(client, {
    sender: writer.address,
    frames: [verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 20_000n }), publishRootFrame(POLICY_SALT, root)],
    signatures: [secp256k1Placeholder()],
    fees: await fees(),
  })
  tx = await signAll(tx, [writer.key])
  const hash = await sendFrameTx(client, tx)
  const receipt = await waitForFrameTxReceipt(client, hash)
  const slot = await slotOf(receipt.blockNumber)
  console.log(`  ${label}: root ${root} written in block ${BigInt(receipt.blockNumber)}, slot ${slot}; ${hash}; frames ${frameGas(receipt).join(' | ')}`)
  return { sourceId: sourceIdOf(writer.address, POLICY_SALT), slot, root, hash, receipt }
}

type Sponsored = {
  who: { key: Hex; address: Address }
  tree: PolicyTree
  index: number
  ref: RootRef
  deadline: bigint
  op?: FrameTx['frames'][number]
  extra?: FrameTx['frames']
  noExpiry?: boolean
  fees?: FrameTx['fees']
}

/** [expiry, 8272, only_verify, pay(sealed, proof), op], entry 0 = the user over the sig hash. */
async function sealedTx(s: Sponsored): Promise<FrameTx> {
  const exists = (await client.getBalance({ address: s.who.address })) > 0n || (await client.getTransactionCount({ address: s.who.address })) > 0
  const frames = [
    ...(s.noExpiry ? [] : [expiryFrame(s.deadline)]),
    recentRootFrame([s.ref]),
    onlyVerify,
    sealedPayFrame(sealedPayData(s.tree, s.index), exists),
    s.op ?? mintFrame(s.who.address),
    ...(s.extra ?? []),
  ]
  const tx = await prepareFrameTx(client, { sender: s.who.address, frames, signatures: [secp256k1Placeholder()], fees: s.fees ?? (await fees()) })
  return signAll(tx, [s.who.key])
}

function costReport(tx: FrameTx, receipt: FrameTxReceiptJson) {
  const pay = tx.frames[3]
  const rr = tx.frames[1]
  const g = receipt.frameReceipts.map(frameReceiptGas)
  console.log(`  frames: ${frameGas(receipt).join(' | ')}`)
  console.log(
    `  gasUsed ${BigInt(receipt.gasUsed)}; expiry ${g[0].execution}, 8272 ${g[1].execution}, only_verify ${g[2].execution}, pay ${g[3].execution}; pay data ${size(pay.data)} bytes (calldata ${calldataCost(pay.data)}), 8272 data ${size(rr.data)} bytes (calldata ${calldataCost(rr.data)})`,
  )
  console.log(`  payer ${getAddress(receipt.payer as Address)}; max cost ${maxCost(tx)} wei`)
}

async function run() {
  const start = await latest()
  console.log(`\nstart: block ${start.number}, slot ${start.slot}, time ${start.timestamp}`)
  // P0 lives 6 minutes, so that D can watch it end; P1 a day.
  const P0: Policy = { target: TOKEN_ADDRESS, selector: MINT, cap: AMOUNTS.cap, notAfter: start.timestamp + 360n }
  const P1: Policy = { target: TOKEN_ADDRESS, selector: TRANSFER, cap: AMOUNTS.cap, notAfter: start.timestamp + 86_400n }
  const t4 = policyTree([P0, P1], 4)
  const t20 = policyTree([P0, P1], 20)
  const revoked = policyTree([P1], 4)

  console.log('\n=== A. The sponsor publishes its policy: two roots, two slots ===')
  const r4 = await publish(sponsor, t4.root, 'depth 4')
  const r20 = await publish(sponsor, t20.root, 'depth 20')
  console.log(`  source id ${SOURCE_ID} (sponsor ${sponsor.address}, salt ${POLICY_SALT})`)

  const deadline = () => latest().then((b) => (b.timestamp + 240n < P0.notAfter ? b.timestamp + 240n : P0.notAfter))

  console.log('\n=== B. Sponsored mints by users with no ETH ===')
  const results: Record<string, { tx: FrameTx; receipt: FrameTxReceiptJson }> = {}
  for (const [label, tree, ref] of [
    ['depth 4', t4, r4],
    ['depth 20', t20, r20],
  ] as const) {
    const who = user(`${RUN}-${label}`)
    const tx = await sealedTx({ who, tree, index: 0, ref, deadline: await deadline() })
    console.log(`  ${label}: user ${who.address}, balance 0`)
    await simulate(label, tx)
    const h = await trySend(label, tx)
    const receipt = await receiptOrNull(h, 60_000)
    if (!receipt) throw new Error(`${label}: not mined`)
    console.log(describeReceipt(tx, receipt))
    costReport(tx, receipt)
    results[label] = { tx, receipt }
  }

  console.log('\n  B2. two users at once through the same sealed paymaster')
  const [u1, u2] = [user(`${RUN}-b2-1`), user(`${RUN}-b2-2`)]
  const d = await deadline()
  const [x1, x2] = await Promise.all([u1, u2].map((who) => sealedTx({ who, tree: t4, index: 0, ref: r4, deadline: d })))
  await nextBlock()
  const [h1, h2] = [await trySend('user 1', x1), await trySend('user 2', x2)]
  const [m1, m2] = await Promise.all([receiptOrNull(h1), receiptOrNull(h2)])
  console.log(`  user 1 ${m1 ? `mined in block ${BigInt(m1.blockNumber)}` : 'not mined'}; user 2 ${m2 ? `mined in block ${BigInt(m2.blockNumber)}` : h2 ? 'accepted, not mined' : 'refused'}`)

  console.log('\n=== C. What the sealed paymaster refuses ===')
  const who = user(`${RUN}-c`)
  const dl = await deadline()
  const base = { who, tree: t4, index: 0, ref: r4, deadline: dl }
  const strangerRef = await publish(stranger, t4.root, 'stranger publishes the same root under its own source id')
  const cases: [string, Sponsored][] = [
    ['C1 another target (the policy names Token S)', { ...base, op: mintFrame(who.address, parseEther('1'), SEALED_ADDRESS) }],
    ['C2 max cost above the cap', { ...base, fees: { maxPriorityFeePerGas: TIP, maxFeePerGas: 10_000_000_000n, maxFeePerBlobGas: 0n } }],
    ['C3 an extra frame appended', { ...base, extra: [mintFrame(who.address)] }],
    ['C4 the stranger\'s tuple: same root, other source', { ...base, ref: strangerRef }],
    ['C5 expiry deadline after notAfter', { ...base, deadline: P0.notAfter + 60n }],
    ['C6 no expiry frame', { ...base, noExpiry: true }],
    ['C7 a slot with no root (the protocol\'s check)', { ...base, ref: { ...r4, slot: r4.slot - 1n } }],
  ]
  for (const [label, s] of cases) {
    const tx = await sealedTx(s)
    if (label.startsWith('C2')) console.log(`  C2 max cost ${maxCost(tx)} wei against cap ${AMOUNTS.cap}`)
    await simulate(label, tx)
    await trySend(label, tx)
  }

  console.log('\n=== D. Revocation: a later root does not withdraw an earlier one ===')
  const rRevoked = await publish(sponsor, revoked.root, 'revoking root (P0 removed)')
  const late = user(`${RUN}-d`)
  const txD = await sealedTx({ who: late, tree: t4, index: 0, ref: r4, deadline: await deadline() })
  console.log(`  proving P0 under the depth-4 root of slot ${r4.slot}, after the revoking root of slot ${rRevoked.slot}`)
  await simulate('after revocation', txD)
  const hD = await trySend('after revocation', txD)
  const mD = await receiptOrNull(hD, 60_000)
  console.log(`  ${mD ? `mined in block ${BigInt(mD.blockNumber)}, payer ${getAddress(mD.payer as Address)}` : 'not mined'}`)
  results.revoked = mD ? { tx: txD, receipt: mD } : results.revoked

  console.log(`  waiting for P0's notAfter (${P0.notAfter}) to pass`)
  await sleepUntil(P0.notAfter + 12n)
  const after = await latest()
  const end1 = await sealedTx({ who: late, tree: t4, index: 0, ref: r4, deadline: after.timestamp + 120n })
  console.log(`  D1 deadline ${after.timestamp + 120n} > notAfter`)
  await simulate('D1', end1)
  await trySend('D1', end1)
  const end2 = await sealedTx({ who: late, tree: t4, index: 0, ref: r4, deadline: P0.notAfter })
  console.log(`  D2 deadline = notAfter = ${P0.notAfter}, now ${after.timestamp}`)
  await simulate('D2', end2)
  await trySend('D2', end2)

  console.log('\n=== mined ===')
  for (const [label, { tx, receipt }] of Object.entries(results)) console.log(`  ${label}: ${frameTxHash(tx)} block ${BigInt(receipt.blockNumber)}`)
}

// E. The self-sending paymaster: a sponsorship admitted against its balance, then the owner
// empties it. Both are sent right after a block, the drain at the higher tip, so the drain should
// land first; it leaves less than the sponsorship's max cost and far more than one sponsorship's
// actual cost, so the drain succeeds in either order.
async function drain() {
  console.log('\n=== E. SelfSendingPaymaster ===')
  const code = await client.getCode({ address: SELF_SENDING_ADDRESS })
  if (!code) throw new Error('not deployed')
  const pr = prScan(code)
  const st = sealedScan(code)
  console.log(`  runtime ${size(code)} bytes, keccak ${keccak256(code)}`)
  console.log(`  PR scan: sealed=${pr.sealed}${pr.findings.length ? ` ${JSON.stringify(pr.findings)}` : ''}`)
  console.log(`  amended scan: sealed=${st.sealed} ${JSON.stringify(st.findings)}`)

  const base = (await client.getBlock({ blockTag: 'latest' })).baseFeePerGas ?? 0n
  const who = user(`${RUN}-e`)
  let sponsored = await prepareFrameTx(client, {
    sender: who.address,
    frames: [onlyVerify, verifyFrame({ scope: Approve.PAYMENT, target: SELF_SENDING_ADDRESS, execution: 15_000n, state: NEW_ACCOUNT_STATE_GAS }), mintFrame(who.address)],
    signatures: [secp256k1Placeholder(), secp256k1Placeholder(owner.address)],
    // A max fee well above what it will pay: the node reserves max cost, the block charges far less.
    fees: { maxPriorityFeePerGas: TIP, maxFeePerGas: 4_000n + base, maxFeePerBlobGas: 0n },
  })
  sponsored = await signAll(sponsored, [who.key, owner.key])
  console.log(`  sponsored: tip ${sponsored.fees.maxPriorityFeePerGas} wei, base fee ${base}; max cost ${maxCost(sponsored)} wei`)

  const balance = await client.getBalance({ address: SELF_SENDING_ADDRESS })
  let out = await prepareFrameTx(client, {
    sender: SELF_SENDING_ADDRESS,
    frames: [verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 15_000n }), senderFrame({ target: owner.address, value: 0n, execution: 30_000n, state: NEW_ACCOUNT_STATE_GAS })],
    signatures: [secp256k1Placeholder(owner.address)],
    // A higher tip than the sponsorship's, and a max fee low enough that the refund of this
    // transaction's unused gas does not top the paymaster back up past the sponsorship's max cost.
    fees: await fees(2n * TIP),
  })
  // Leave behind less than the sponsorship's max cost, and more than it would actually cost.
  // The value's bytes and the signature's bytes both count toward the calldata floor, so price a
  // signed copy carrying the largest value it could; the real one costs no more.
  const leave = maxCost(sponsored) / 4n
  const withValue = (value: bigint): FrameTx => ({ ...out, frames: [out.frames[0], { ...out.frames[1], value }] })
  const priced = await signAll(withValue(balance), [owner.key])
  const value = balance - maxCost(priced) - leave
  out = await signAll(withValue(value), [owner.key])
  console.log(`  paymaster balance ${fmt(balance)} ETH; drain sends ${fmt(value)} ETH to the owner and leaves ${leave} wei; its own max cost ${maxCost(out)} wei`)
  console.log(describeTx(out))

  await simulate('sponsored', sponsored)
  await simulate('drain', out)
  const before = { pm: balance, owner: await client.getBalance({ address: owner.address }) }
  await nextBlock()
  const hs = await trySend('sponsored mint (paymaster = SelfSendingPaymaster)', sponsored)
  const hd = await trySend('drain (sender = SelfSendingPaymaster, SENDER frame with value, twice the tip)', out)
  const rd = await receiptOrNull(hd)
  if (rd) {
    console.log(`  drain: mined in block ${BigInt(rd.blockNumber)}, ${frameTxHash(out)}`)
    console.log(describeReceipt(out, rd))
    const block = await rpc<{ transactions: Hex[] }>(client, 'eth_getBlockByNumber', [rd.blockNumber, false])
    const order = block.transactions.map((h) => (h === hd ? 'drain' : h === hs ? 'sponsored' : h.slice(0, 10)))
    console.log(`  block ${BigInt(rd.blockNumber)} order: ${order.join(', ')}`)
  } else console.log('  drain: no receipt')
  const after = { pm: await client.getBalance({ address: SELF_SENDING_ADDRESS }), owner: await client.getBalance({ address: owner.address }) }
  console.log(`  paymaster ${fmt(before.pm)} -> ${fmt(after.pm)} ETH (${after.pm} wei); owner ${fmt(before.owner)} -> ${fmt(after.owner)} ETH`)
  if (hs) {
    await nextBlock()
    await nextBlock()
    const [r, j] = await Promise.all([getFrameTxReceipt(client, hs), getFrameTxJson(client, hs)])
    console.log(`  the sponsorship after the drain: ${r ? `mined in block ${BigInt(r.blockNumber)}` : j ? 'still in the pool' : 'gone from the pool'}`)
    await simulate('sponsored, after the drain', sponsored)
    await trySend('sponsored, resent after the drain', sponsored)
  }
}

const which = process.argv[2] ?? 'all'
console.log(`funder ${funder}\nsealed paymaster ${SEALED_ADDRESS}\nself-sending paymaster ${SELF_SENDING_ADDRESS} (owner ${owner.address})`)
console.log(`token ${TOKEN_ADDRESS}; sponsor ${sponsor.address}; stranger ${stranger.address}`)
if (which === 'setup' || which === 'all') await setup()
if (which === 'run' || which === 'all') await run()
if (which === 'drain' || which === 'all') await drain()
