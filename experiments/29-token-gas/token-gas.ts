// Experiment 29: gas paid in tokens, with no server. A user holding only Token A swaps some of it for
// ETH and repays a stateless paymaster (GasForOutput.yul) out of the proceeds, in one atomic batch.
//
//   B  carol (Token A, no ETH) swaps and repays: mined
//   C  dave (nothing at all) sends the same layout: the swap fails, the paymaster pays: mined
//   D  carol asks for more than the pool gives (slippage): the paymaster pays: mined
//   E  carol and erin at once, through the same paymaster: the public mempool's pending cap
//   F  a transaction whose maximum cost is above the paymaster's cap: refused
//   G  the variant that reads the token's balanceOf(sender) in VERIFY: refused by the public mempool
//   H  dave's batch calls a contract that is one INVALID opcode, with a budget near the cap: mined
//
// usage: npx tsx experiments/29-token-gas/token-gas.ts
import { type Address, type Hex, concatHex, encodeAbiParameters, encodeFunctionData, formatEther, keccak256, parseEther, toHex } from 'viem'
import { privateKeyToAddress } from 'viem/accounts'
import { compileSolidity, compileYul } from '../../src/contracts.js'
import { create2Address, deployFrame, saltOf, sendFrames } from '../../src/deploy.js'
import { loadKey } from '../../src/env.js'
import {
  Approve,
  type Frame,
  type FrameTx,
  type FrameTxFees,
  NEW_ACCOUNT_STATE_GAS,
  STORAGE_SET_STATE_GAS,
  defaultFrame,
  frameReceiptGas,
  frameReceiptStatus,
  makeClient,
  maxCost,
  prepareFrameTx,
  rpc,
  secp256k1Placeholder,
  senderFrame,
  serializeFrameTx,
  signAll,
  simulateFrameTx,
  sendFrameTx,
  verifyFrame,
  waitForFrameTxReceipt,
} from '../../src/frametx/index.js'
import { TOKEN_A, token } from '../03-atomic-batch/setup.js'

const client = makeClient()
const { privateKey: funderKey, address: funder } = loadKey()
const derive = (label: string) => {
  const key = keccak256(concatHex([funderKey, toHex(`exp-frames/29/${label}`)]))
  return { key, address: privateKeyToAddress(key) }
}
const carol = derive('carol')
const dave = derive('dave')
const erin = derive('erin')
const E = (n: number) => parseEther(String(n))
const CAP = E(0.005)

// ---- contracts ----
const dexArt = compileSolidity('experiments/29-token-gas/ToyEthDex.sol', 'ToyEthDex')
const dexInit = concatHex([dexArt.bytecode, encodeAbiParameters([{ type: 'address' }], [TOKEN_A])])
const DEX = create2Address(dexInit, saltOf('exp-frames/29/toy-eth-dex/v1'))
const pmCode = compileYul('experiments/29-token-gas/GasForOutput.yul')
const pmInit = (check: boolean) =>
  concatHex([pmCode, encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }], [CAP, check ? 1n : 0n, TOKEN_A, funder])])
const PM = create2Address(pmInit(false), saltOf('exp-frames/29/gas-for-output/v1'))
const PM_CHECKED = create2Address(pmInit(true), saltOf('exp-frames/29/gas-for-output-checked/v1'))
// A contract whose code is one INVALID opcode: any call to it fails and uses all the gas it was given.
// initcode: PUSH1 0xfe PUSH0 MSTORE8 PUSH1 1 PUSH0 RETURN
const BURNER_INIT = '0x60fe5f5360015ff3' as Hex
const BURNER = create2Address(BURNER_INIT, saltOf('exp-frames/29/burner/v1'))
const bal = (a: Address) => client.getBalance({ address: a })
const tokenBal = (a: Address) => client.readContract({ address: TOKEN_A, abi: token.abi, functionName: 'balanceOf', args: [a] } as never) as Promise<bigint>
const call = (abi: typeof token.abi, functionName: string, args: unknown[]) => encodeFunctionData({ abi, functionName, args } as never)

console.log(`DEX ${DEX}; GasForOutput ${PM}; checked variant ${PM_CHECKED}`)
console.log(`carol ${carol.address}; dave ${dave.address}; erin ${erin.address}`)

// ---- setup ----
{
  const frames: Frame[] = []
  if (!(await client.getCode({ address: DEX }))) frames.push(deployFrame(dexInit, saltOf('exp-frames/29/toy-eth-dex/v1')).frame)
  if (!(await client.getCode({ address: PM }))) frames.push(deployFrame(pmInit(false), saltOf('exp-frames/29/gas-for-output/v1')).frame)
  if (!(await client.getCode({ address: PM_CHECKED }))) frames.push(deployFrame(pmInit(true), saltOf('exp-frames/29/gas-for-output-checked/v1')).frame)
  if (!(await client.getCode({ address: BURNER }))) frames.push(deployFrame(BURNER_INIT, saltOf('exp-frames/29/burner/v1')).frame)
  const mint = (to: Address, amount: bigint) => frames.push(senderFrame({ target: TOKEN_A, data: call(token.abi, 'mint', [to, amount]), execution: 80_000n, state: 2n * STORAGE_SET_STATE_GAS }))
  if ((await tokenBal(DEX)) === 0n) mint(DEX, E(1000))
  for (const u of [carol, erin]) if ((await tokenBal(u.address)) < E(20)) mint(u.address, E(100))
  const topUp = async (a: Address, want: bigint) => {
    const has = await bal(a)
    if (has < want / 2n) frames.push(senderFrame({ target: a, value: want - has, execution: 60_000n, state: has === 0n ? NEW_ACCOUNT_STATE_GAS : 0n }))
  }
  await topUp(DEX, E(0.5))
  await topUp(PM, E(0.1))
  if (frames.length) await sendFrames(client, funderKey, frames, { label: 'setup: pool, paymasters, liquidity, tokens' })
}

const exists = async (a: Address) => (await client.getTransactionCount({ address: a })) > 0 || (await bal(a)) > 0n
const quote = (amountIn: bigint) => client.readContract({ address: DEX, abi: dexArt.abi, functionName: 'quote', args: [amountIn] }) as Promise<bigint>

/**
 * [VERIFY sender, EXECUTION] [VERIFY paymaster, PAYMENT] [approve, atomic] [swap, atomic]
 * [repay the paymaster max cost] [post-op]. The repayment's value is part of what is priced, so
 * it is iterated to a fixed point.
 */
async function swapAndRepay(u: { key: Hex; address: Address }, opts: { amountIn: bigint; minOut: bigint; paymaster?: Address; extraExecution?: bigint; fees?: FrameTxFees; swapTarget?: Address }) {
  const paymaster = opts.paymaster ?? PM
  const frames = (value: bigint): Frame[] => [
    verifyFrame({ scope: Approve.EXECUTION, execution: 20_000n }),
    verifyFrame({ scope: Approve.PAYMENT, target: paymaster, execution: 40_000n, state: 0n }),
    senderFrame({ target: TOKEN_A, data: call(token.abi, 'approve', [DEX, opts.amountIn]), atomic: true, execution: 60_000n, state: STORAGE_SET_STATE_GAS }),
    senderFrame({ target: opts.swapTarget ?? DEX, data: call(dexArt.abi, 'swapForEth', [opts.amountIn, opts.minOut]), atomic: true, execution: 100_000n + (opts.extraExecution ?? 0n), state: STORAGE_SET_STATE_GAS }),
    senderFrame({ target: paymaster, value, execution: 30_000n }),
    defaultFrame({ target: paymaster, execution: 60_000n }),
  ]
  const fresh = !(await exists(u.address))
  let tx = await prepareFrameTx(client, { sender: u.address, frames: frames(0n), signatures: [secp256k1Placeholder()], fees: opts.fees })
  const withPayState = (t: FrameTx): FrameTx => ({ ...t, frames: t.frames.map((f, i) => (i === 1 ? { ...f, limits: { ...f.limits, state: fresh ? NEW_ACCOUNT_STATE_GAS : 0n } } : f)) })
  tx = withPayState(tx)
  // The signature's 65 bytes are calldata, so they are in the maximum cost: price the worst case
  // (no zero bytes), as experiment 04 does.
  const worst = (t: FrameTx): FrameTx => ({ ...t, signatures: t.signatures.map((s) => ({ ...s, signature: `0x${'ff'.repeat(65)}` as Hex })) })
  for (let i = 0; i < 5; i++) {
    const want = maxCost(worst(tx))
    if (tx.frames[4].value === want) break
    tx = withPayState({ ...tx, frames: frames(want) })
  }
  if (tx.frames[4].value !== maxCost(worst(tx))) throw new Error('repayment did not converge')
  return signAll(tx, [u.key])
}

type Row = { case: string; hash?: Hex; gasUsed?: bigint; frames?: string; pm?: string; user?: string; note: string }
const rows: Row[] = []
const fmt = (wei: bigint) => `${wei < 0n ? '-' : '+'}${formatEther(wei < 0n ? -wei : wei)}`

async function mined(label: string, u: { key: Hex; address: Address }, tx: FrameTx, note = '') {
  console.log(`\n=== ${label} ===`)
  const sim = await simulateFrameTx(client, tx)
  console.log(`  simulate: valid ${sim.valid}${sim.violation ? ` (${sim.violation})` : ''}, execution ${sim.executionStatus}, max cost ${maxCost(tx)}`)
  if (!sim.valid) {
    rows.push({ case: label, note: `refused: ${sim.violation}` })
    return
  }
  const [pm0, u0, t0] = await Promise.all([bal(PM), bal(u.address), tokenBal(u.address)])
  const hash = await sendFrameTx(client, tx)
  const r = await waitForFrameTxReceipt(client, hash)
  // read balances at the receipt's block
  const at = BigInt(r.blockNumber)
  const [pm1, u1, t1] = await Promise.all([
    client.getBalance({ address: PM, blockNumber: at }),
    client.getBalance({ address: u.address, blockNumber: at }),
    client.readContract({ address: TOKEN_A, abi: token.abi, functionName: 'balanceOf', args: [u.address], blockNumber: at } as never) as Promise<bigint>,
  ])
  const gas = r.frameReceipts.map((f) => {
    const g = frameReceiptGas(f)
    return `${frameReceiptStatus(f)}:${g.execution}${g.state ? `+${g.state}s` : ''}`
  })
  const fee = BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice)
  console.log(`  ${hash} block ${at} gasUsed ${r.gasUsed} effective price ${BigInt(r.effectiveGasPrice)} fee ${formatEther(fee)} payer ${r.payer}`)
  console.log(`  frames (status:execution+state): ${gas.join(' | ')}`)
  console.log(`  paymaster ${fmt(pm1 - pm0)} ETH; user ${fmt(u1 - u0)} ETH, ${fmt(t1 - t0)} Token A`)
  rows.push({ case: label, hash, gasUsed: BigInt(r.gasUsed), frames: gas.join(' / '), pm: fmt(pm1 - pm0), user: `${fmt(u1 - u0)} ETH, ${fmt(t1 - t0)} A`, note })
}

const amt = E(10)
// B
{
  const q = await quote(amt)
  await mined('B. carol swaps 10 A for ETH and repays the paymaster', carol, await swapAndRepay(carol, { amountIn: amt, minOut: q }), `quote ${formatEther(q)} ETH`)
}
// C
await mined('C. dave, who holds no Token A, sends the same layout', dave, await swapAndRepay(dave, { amountIn: amt, minOut: 0n }), 'the swap cannot pull tokens dave does not have')
// D
{
  const q = await quote(amt)
  await mined('D. carol asks for 1 wei more than the pool gives', carol, await swapAndRepay(carol, { amountIn: amt, minOut: q + 1n }), 'slippage')
}
// E
{
  console.log('\n=== E. carol and erin at once, through the same paymaster ===')
  const txs = [await swapAndRepay(carol, { amountIn: E(1), minOut: 0n }), await swapAndRepay(erin, { amountIn: E(1), minOut: 0n })]
  const results = await Promise.all(txs.map((t) => rpc<Hex>(client, 'eth_sendRawTransaction', [serializeFrameTx(t)]).then((h) => ({ h }), (e: Error) => ({ e: e.message.split('\n').find((l) => l.startsWith('Details:'))?.slice(9) ?? e.message.split('\n')[0] }))))
  for (const [i, r] of results.entries()) console.log(`  [${i}] ${'h' in r ? `accepted ${r.h}` : `refused: ${r.e}`}`)
  for (const r of results) if ('h' in r) await waitForFrameTxReceipt(client, r.h).then((rc) => console.log(`  ${r.h} mined in block ${BigInt(rc.blockNumber)}, gasUsed ${BigInt(rc.gasUsed)}`))
  rows.push({ case: 'E. carol and erin at once', note: results.map((r, i) => `[${i}] ${'h' in r ? `accepted ${r.h.slice(0, 10)}...` : `refused: ${r.e}`}`).join('; ') })
}
// F
{
  const tx = await swapAndRepay(carol, { amountIn: E(1), minOut: 0n, extraExecution: 5_000_000n })
  await mined(`F. a maximum cost above the cap (${formatEther(maxCost(tx))} ETH > ${formatEther(CAP)})`, carol, tx)
}
// G
for (const u of [carol, dave]) {
  const tx = await swapAndRepay(u, { amountIn: E(1), minOut: 0n, paymaster: PM_CHECKED })
  await mined(`G. the variant that reads balanceOf(sender), ${u === carol ? 'carol (holds Token A)' : 'dave (holds none)'}`, u, tx)
}

// H
{
  // As much execution as the cap allows, all of it in the call that fails.
  let extra = 4_000_000n
  let tx = await swapAndRepay(dave, { amountIn: E(1), minOut: 0n, swapTarget: BURNER, extraExecution: extra })
  while (maxCost(tx) > CAP) {
    extra -= 100_000n
    tx = await swapAndRepay(dave, { amountIn: E(1), minOut: 0n, swapTarget: BURNER, extraExecution: extra })
  }
  await mined('H. dave calls a contract that is one INVALID opcode, budget near the cap', dave, tx, `max cost ${formatEther(maxCost(tx))} ETH of a ${formatEther(CAP)} cap`)
}

console.log(`\ncarol: ${formatEther(await bal(carol.address))} ETH, ${formatEther(await tokenBal(carol.address))} A; paymaster ${formatEther(await bal(PM))} ETH`)
console.log('\n| Case | Tx | `gasUsed` | Frames (status:execution+state) | Paymaster | User | Note |\n|---|---|---|---|---|---|---|')
for (const r of rows) {
  const tx = r.hash ? `[\`${r.hash.slice(0, 10)}...\`](https://dora.privacy.ethrex.xyz/tx/${r.hash})` : ''
  console.log(`| ${r.case} | ${tx} | ${r.gasUsed ?? ''} | ${r.frames ?? ''} | ${r.pm ?? ''} | ${r.user ?? ''} | ${r.note} |`)
}
process.exit(0)
