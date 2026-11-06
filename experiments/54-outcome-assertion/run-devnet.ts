// Experiment 54, amendment 2: cases (a) to (e) with the check in an EIP-7906 mode-3 frame, on the
// public Hegota devnet (chain 3151908), under the strong rule and under the named-state baseline.
//
// usage: npx tsx experiments/54-outcome-assertion/run-devnet.ts [setup|probe|a|b|c|d|e|cases|all]
//
// Keys are derived from PRIVATE_KEY under `exp-frames/54/devnet/...`; none is printed. The funder is
// funded from the devnet's faucet only. Records go to results/devnet-<date>.jsonl, each with the
// chain ID.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import {
  type Address,
  type Hex,
  concatHex,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  hexToBigInt,
  keccak256,
  maxUint256,
  pad,
  parseEther,
  size,
  toHex,
} from 'viem'
import { privateKeyToAddress } from 'viem/accounts'
import { compileSolidity, compileYul } from '../../src/contracts.js'
import { deployFrame, saltOf } from '../../src/deploy.js'
import { loadKey } from '../../src/env.js'
import { Approve, type Frame, STORAGE_SET_STATE_GAS, makeClient, secp256k1Placeholder, senderFrame, verifyFrame } from '../../src/frametx/index.js'
import { DEVNET_CHAIN_ID, DEVNET_EXPLORER, DEVNET_RPC, type DevnetTx, claim, frameStatus, send, signDevnet, simulate, txHash, waitReceipt } from './devnet.js'

const DIR = 'experiments/54-outcome-assertion'
const { privateKey } = loadKey()
const client = makeClient(DEVNET_RPC)

const derive = (label: string) => {
  const key = keccak256(concatHex([privateKey, toHex(`exp-frames/54/devnet/${label}`)]))
  return { key, address: privateKeyToAddress(key) }
}
const funder = derive('funder')
const owner = derive('owner')
const recipient = derive('recipient').address
const listedSpender = derive('listed-spender').address
const operator = derive('operator').address
const sink = derive('sink').address
const unlistedSpender = privateKeyToAddress(keccak256(toHex(`exp-frames/54/devnet/unlisted/${Date.now()}`)))

const token = compileSolidity('contracts/TestToken.sol', 'TestToken')
const collection = compileSolidity(`${DIR}/TestCollection.sol`, 'TestCollection')
const liar = compileSolidity(`${DIR}/LyingToken.sol`, 'LyingToken')
const ACCOUNT_CODE = compileYul(`${DIR}/PostTxAccount.yul`)

const TOKEN = deployFrame(
  concatHex([token.bytecode, encodeAbiParameters([{ type: 'string' }, { type: 'string' }], ['Token 54', 'T54'])]),
  saltOf('exp-frames/54/devnet/token'),
  2n * STORAGE_SET_STATE_GAS,
)
const COLLECTION = deployFrame(collection.bytecode, saltOf('exp-frames/54/devnet/collection'))
const LIAR = deployFrame(concatHex([liar.bytecode, encodeAbiParameters([{ type: 'address' }], [sink])]), saltOf('exp-frames/54/devnet/liar'))
const ACCOUNT = deployFrame(concatHex([ACCOUNT_CODE, pad(owner.address)]), saltOf('exp-frames/54/devnet/account'))

type Abi = typeof token.abi
const enc = (abi: Abi, functionName: string, args: unknown[]): Hex =>
  encodeFunctionData({ abi, functionName, args } as Parameters<typeof encodeFunctionData>[0])
async function read(abi: Abi, address: Address, functionName: string, args: unknown[]): Promise<bigint> {
  const { data } = await client.call({ to: address, data: enc(abi, functionName, args) })
  const v = decodeFunctionResult({ abi, functionName, data: data ?? '0x' } as Parameters<typeof decodeFunctionResult>[0]) as bigint | boolean
  return typeof v === 'boolean' ? (v ? 1n : 0n) : v
}

// ---- storage layouts, from the contracts' declarations; checked against the chain in setup ----

const mapSlot = (key: Address, slot: bigint): Hex => keccak256(concatHex([pad(key), toHex(slot, { size: 32 })]))
const mapSlot2 = (k1: Address, k2: Address, slot: bigint): Hex => keccak256(concatHex([pad(k2), mapSlot(k1, slot)]))
/** TestToken: name 0, symbol 1, totalSupply 2, balanceOf 3, allowance 4. */
const tokenBalanceSlot = (a: Address) => mapSlot(a, 3n)
/** LyingToken: totalSupply 0, held 1, told 2 (sink is immutable). */
const liarHeldSlot = (a: Address) => mapSlot(a, 1n)
const storageWord = async (address: Address, slot: Hex) => hexToBigInt((await client.getStorageAt({ address, slot })) ?? '0x0')

// ---- Q ----

const SEL = { writes: '0x25c8701e', named: '0x6c29904d', count: '0x3c812280' } as const
const w = (v: bigint | Address | Hex) => (typeof v === 'bigint' ? toHex(v, { size: 32 }) : pad(v as Hex))
type Write = { what: string; address: Address; slot: Hex; after: bigint }

function strongQ(writes: Write[], balances: { address: Address; after: bigint }[] = []): Hex {
  return concatHex([
    SEL.writes,
    w(BigInt(writes.length)),
    ...writes.flatMap((x) => [w(x.address), x.slot, w(x.after)]),
    w(BigInt(balances.length)),
    ...balances.flatMap((b) => [w(b.address), w(b.after)]),
    w(ACCOUNT.address), // the payer: its balance moves by the gas charged
  ])
}

type Entry = { what: string; target: Address; call: Hex; expected: bigint }
function namedQ(entries: Entry[], cap = 0n): Hex {
  const parts: Hex[] = [SEL.named, w(TOKEN.address), w(listedSpender), w(cap)]
  for (const e of entries) {
    const len = size(e.call)
    parts.push(w(e.target), w(e.expected), w(BigInt(len)), pad(e.call, { dir: 'right', size: Math.ceil(len / 32) * 32 }))
  }
  return concatHex(parts)
}
async function entry(what: string, abi: Abi, target: Address, fn: string, args: unknown[], change = 0n): Promise<Entry> {
  return { what, target, call: enc(abi, fn, args), expected: (await read(abi, target, fn, args)) + change }
}

const postTx = (data: Hex): Frame => ({ mode: 3, flags: 0, target: ACCOUNT.address, limits: { execution: 400_000n, state: 0n }, value: 0n, data })

// ---- sending and recording ----

const RECORD = `${DIR}/results/devnet-${new Date().toISOString().slice(0, 10)}.jsonl`
let commit = 'unknown'
try {
  const head = readFileSync('.git/HEAD', 'utf8').trim()
  commit = head.startsWith('ref: ') ? readFileSync(`.git/${head.slice(5)}`, 'utf8').trim() : head
} catch {}
function record(r: Record<string, unknown>) {
  if (!existsSync(`${DIR}/results`)) mkdirSync(`${DIR}/results`, { recursive: true })
  appendFileSync(RECORD, `${JSON.stringify({ at: new Date().toISOString(), commit, chainId: Number(DEVNET_CHAIN_ID), ...r }, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}\n`)
}
const errorText = (e: unknown) => {
  const err = e as Error & { details?: string; cause?: { details?: string } }
  return err.details ?? err.cause?.details ?? err.message.split('\n')[0]
}

async function fees() {
  const block = await client.getBlock({ blockTag: 'latest' })
  return { maxPriorityFeePerGas: 1_000_000_000n, maxFeePerGas: (block.baseFeePerGas ?? 0n) * 2n + 1_000_000_000n }
}
async function txFrom(sender: Address, key: Hex, frames: Frame[], signer: Address | null = null): Promise<DevnetTx> {
  const nonceSeq = BigInt(await client.getTransactionCount({ address: sender, blockTag: 'latest' }))
  return signDevnet({ chainId: DEVNET_CHAIN_ID, nonceKeys: [0n], nonceSeq, sender, frames, signatures: [secp256k1Placeholder(signer)], ...(await fees()) }, key)
}

async function submit(label: string, tx: DevnetTx, { sendIfInvalid = false } = {}) {
  console.log(`\n=== ${label} ===`)
  const sim = await simulate(client, tx).catch((e) => ({ error: errorText(e) }))
  console.log(`  simulate: ${JSON.stringify(sim)}`)
  let hash: Hex | null = null
  let refused: string | null = null
  if ('error' in sim || (!sim.valid && !sendIfInvalid)) refused = 'error' in sim ? sim.error : `simulation: ${sim.violation}`
  else {
    try {
      hash = await send(client, tx)
      console.log(`  sent ${hash}  ${DEVNET_EXPLORER}/tx/${hash}`)
    } catch (e) {
      refused = errorText(e)
      console.log(`  refused: ${refused}`)
    }
  }
  const receipt = hash ? await waitReceipt(client, hash) : null
  const frames = receipt?.frameReceipts?.map((f) => ({
    status: ['FAILED', 'ok', 'SKIPPED'][frameStatus(f.status)] ?? String(f.status),
    execution: f.executionGasUsed ?? f.gasUsed ?? null,
    state: f.stateGasUsed ?? null,
  }))
  if (receipt) {
    console.log(`  chain ${DEVNET_CHAIN_ID} block ${hexToBigInt(receipt.blockNumber)} status ${receipt.status} gasUsed ${hexToBigInt(receipt.gasUsed)}`)
    if (frames) console.log(`  frames: ${frames.map((f, i) => `[${i}] ${f.status} ${f.execution ? hexToBigInt(f.execution as Hex) : '?'}`).join('  ')}`)
  }
  return { label, chainId: Number(DEVNET_CHAIN_ID), hash: hash ?? txHash(tx), simulation: sim, refused, block: receipt ? hexToBigInt(receipt.blockNumber) : null, status: receipt?.status ?? null, gasUsed: receipt ? hexToBigInt(receipt.gasUsed) : null, frames: frames ?? null }
}

/** A transaction from the account: VERIFY, the body, then the mode-3 check. */
async function fromAccount(body: Frame[], check: Hex) {
  return txFrom(ACCOUNT.address, owner.key, [verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 60_000n }), ...body, postTx(check)], owner.address)
}

async function fromFunder(label: string, frames: Frame[]) {
  const tx = await txFrom(funder.address, funder.key, [verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 20_000n }), ...frames])
  const r = await submit(label, tx)
  if (!r.status || r.status !== '0x1' || r.frames?.some((f) => f.status !== 'ok')) throw new Error(`${label}: not every frame succeeded; setup stops`)
  return r
}

// ---- setup ----

async function setup() {
  let bal = await client.getBalance({ address: funder.address })
  console.log(`funder ${funder.address} holds ${bal}`)
  if (bal < parseEther('0.3')) {
    const c = await claim(funder.address)
    console.log(`faucet: ${c.status} ${c.body.slice(0, 200)}`)
    for (let i = 0; i < 20 && bal < parseEther('0.3'); i++) {
      await new Promise((r) => setTimeout(r, 3_000))
      bal = await client.getBalance({ address: funder.address })
    }
    if (bal < parseEther('0.3')) throw new Error('the faucet did not fund the funder')
  }
  const missing: Frame[] = []
  for (const c of [TOKEN, COLLECTION, LIAR, ACCOUNT]) {
    const code = await client.getCode({ address: c.address })
    if (!code || code === '0x') missing.push(c.frame)
  }
  // One deploy per transaction: the devnet admits no transaction whose limits sum past 2^24.
  for (const [k, f] of missing.entries()) {
    const total = 20_000n + f.limits.execution + f.limits.state
    console.log(`deploy ${k + 1}/${missing.length}: limits sum ${total}`)
    await fromFunder(`setup: deploy ${k + 1} of ${missing.length}`, [f])
  }
  const fund: Frame[] = []
  if ((await client.getBalance({ address: ACCOUNT.address })) < parseEther('0.05')) fund.push(senderFrame({ target: ACCOUNT.address, value: parseEther('0.1'), execution: 30_000n }))
  if ((await read(token.abi, TOKEN.address, 'balanceOf', [ACCOUNT.address])) < parseEther('100'))
    fund.push(senderFrame({ target: TOKEN.address, data: enc(token.abi, 'mint', [ACCOUNT.address, parseEther('1000')]), execution: 100_000n, state: 2n * STORAGE_SET_STATE_GAS }))
  if ((await read(liar.abi, LIAR.address, 'held', [ACCOUNT.address])) < parseEther('100'))
    fund.push(senderFrame({ target: LIAR.address, data: enc(liar.abi, 'mint', [ACCOUNT.address, parseEther('1000')]), execution: 100_000n, state: 2n * STORAGE_SET_STATE_GAS }))
  if (fund.length) await fromFunder('setup: fund the account, mint to it', fund)
  // The layouts the strong rule's Q is computed from must be the chain's.
  if ((await storageWord(TOKEN.address, tokenBalanceSlot(ACCOUNT.address))) !== (await read(token.abi, TOKEN.address, 'balanceOf', [ACCOUNT.address])))
    throw new Error('TestToken balanceOf slot is not slot 3')
  if ((await storageWord(LIAR.address, liarHeldSlot(ACCOUNT.address))) !== (await read(liar.abi, LIAR.address, 'held', [ACCOUNT.address])))
    throw new Error('LyingToken held slot is not slot 1')
  console.log(`account ${ACCOUNT.address} (${size(ACCOUNT_CODE)} bytes of initcode)  token ${TOKEN.address}  collection ${COLLECTION.address}  liar ${LIAR.address}`)
  record({ case: 'setup', account: ACCOUNT.address, token: TOKEN.address, collection: COLLECTION.address, liar: LIAR.address, funder: funder.address, owner: owner.address, recipient, listedSpender, operator, sink })
}

// ---- the cases ----

const AMOUNT = parseEther('10')
const transfer = (t: Address, abi: Abi, to: Address) => senderFrame({ target: t, data: enc(abi, 'transfer', [to, AMOUNT]), execution: 60_000n, state: 2n * STORAGE_SET_STATE_GAS })
const approve = (spender: Address) => senderFrame({ target: TOKEN.address, data: enc(token.abi, 'approve', [spender, maxUint256]), execution: 50_000n, state: STORAGE_SET_STATE_GAS })
const grant = (op: Address) => senderFrame({ target: COLLECTION.address, data: enc(collection.abi, 'setApprovalForAll', [op, true]), execution: 50_000n, state: STORAGE_SET_STATE_GAS })

/** The writes an honest transfer of `t` makes: the two balance slots. */
async function transferWrites(t: Address, slotOf: (a: Address) => Hex): Promise<Write[]> {
  return [
    { what: 'balance of the account, less 10', address: t, slot: slotOf(ACCOUNT.address), after: (await storageWord(t, slotOf(ACCOUNT.address))) - AMOUNT },
    { what: 'balance of the recipient, plus 10', address: t, slot: slotOf(recipient), after: (await storageWord(t, slotOf(recipient))) + AMOUNT },
  ]
}
async function transferNamed(): Promise<Entry[]> {
  return [
    await entry('balanceOf(account) falls by 10', token.abi, TOKEN.address, 'balanceOf', [ACCOUNT.address], -AMOUNT),
    await entry('balanceOf(recipient) rises by 10', token.abi, TOKEN.address, 'balanceOf', [recipient], AMOUNT),
    await entry('allowance(account, listed spender) stays', token.abi, TOKEN.address, 'allowance', [ACCOUNT.address, listedSpender]),
    await entry('isApprovedForAll(account, operator) stays', collection.abi, COLLECTION.address, 'isApprovedForAll', [ACCOUNT.address, operator]),
  ]
}
async function liarNamed(): Promise<Entry[]> {
  return [
    await entry('liar.balanceOf(account) falls by 10', liar.abi, LIAR.address, 'balanceOf', [ACCOUNT.address], -AMOUNT),
    await entry('liar.balanceOf(recipient) rises by 10', liar.abi, LIAR.address, 'balanceOf', [recipient], AMOUNT),
  ]
}

async function state() {
  return {
    'T54.balanceOf(account)': await read(token.abi, TOKEN.address, 'balanceOf', [ACCOUNT.address]),
    'T54.balanceOf(recipient)': await read(token.abi, TOKEN.address, 'balanceOf', [recipient]),
    'T54.allowance(account, listed)': await read(token.abi, TOKEN.address, 'allowance', [ACCOUNT.address, listedSpender]),
    'T54.allowance(account, unlisted)': await read(token.abi, TOKEN.address, 'allowance', [ACCOUNT.address, unlistedSpender]),
    'collection.isApprovedForAll(account, operator)': await read(collection.abi, COLLECTION.address, 'isApprovedForAll', [ACCOUNT.address, operator]),
    'liar.balanceOf(recipient)': await read(liar.abi, LIAR.address, 'balanceOf', [recipient]),
    'liar.held(recipient)': await read(liar.abi, LIAR.address, 'held', [recipient]),
    'liar.held(sink)': await read(liar.abi, LIAR.address, 'held', [sink]),
  }
}

type CaseDef = { id: string; label: string; body: () => Frame[]; writes: () => Promise<Write[]>; named: () => Promise<Entry[]> }
const CASES: CaseDef[] = [
  { id: 'a', label: 'an honest transfer', body: () => [transfer(TOKEN.address, token.abi, recipient)], writes: () => transferWrites(TOKEN.address, tokenBalanceSlot), named: transferNamed },
  { id: 'b', label: 'a hidden approval to the listed spender', body: () => [transfer(TOKEN.address, token.abi, recipient), approve(listedSpender)], writes: () => transferWrites(TOKEN.address, tokenBalanceSlot), named: transferNamed },
  { id: 'c', label: 'an approval to a spender Q does not list', body: () => [transfer(TOKEN.address, token.abi, recipient), approve(unlistedSpender)], writes: () => transferWrites(TOKEN.address, tokenBalanceSlot), named: transferNamed },
  { id: 'd', label: 'an operator grant on the listed collection', body: () => [transfer(TOKEN.address, token.abi, recipient), grant(operator)], writes: () => transferWrites(TOKEN.address, tokenBalanceSlot), named: transferNamed },
  { id: 'e', label: 'a token whose balanceOf lies', body: () => [transfer(LIAR.address, liar.abi, recipient)], writes: () => transferWrites(LIAR.address, liarHeldSlot), named: liarNamed },
]

async function runCase(c: CaseDef, rule: 'strong' | 'baseline') {
  const before = await state()
  const writes = rule === 'strong' ? await c.writes() : []
  const named = rule === 'baseline' ? await c.named() : []
  const check = rule === 'strong' ? strongQ(writes) : namedQ(named)
  // A failed mode-3 frame still leaves the transaction valid, so the simulation says valid.
  const r = await submit(`(${c.id}) ${c.label}, ${rule === 'strong' ? 'strong rule' : 'baseline'}`, await fromAccount(c.body(), check))
  const after = await state()
  for (const k of Object.keys(after) as (keyof typeof after)[]) if (after[k] !== before[k]) console.log(`  ${k}: ${before[k]} -> ${after[k]}`)
  record({ case: c.id, rule, ...r, q: rule === 'strong' ? writes : named, before, after })
}

// The probe: (a)'s body with a check that requires the storage count to be 2, and then 3. The first
// should pass and the second fail if the devnet numbers TXTRACE's parameters as the demo does.
async function probe() {
  for (const n of [2n, 3n]) {
    const tx = await fromAccount([transfer(TOKEN.address, token.abi, recipient)], concatHex([SEL.count, w(n)]))
    const sim = await simulate(client, tx).catch((e) => ({ error: errorText(e) }))
    console.log(`probe: storage count == ${n}: ${JSON.stringify(sim)}`)
    record({ case: 'probe', storageCount: n, simulation: sim })
  }
}

const which = process.argv[2] ?? 'all'
const order = which === 'all' ? ['setup', 'probe', 'cases'] : which.split(',')
for (const s of order) {
  if (s === 'setup') await setup()
  else if (s === 'probe') await probe()
  else if (s === 'cases') for (const c of CASES) for (const rule of ['strong', 'baseline'] as const) await runCase(c, rule)
  else {
    const c = CASES.find((x) => x.id === s)
    if (!c) throw new Error(`unknown step ${s}`)
    for (const rule of ['strong', 'baseline'] as const) await runCase(c, rule)
  }
}
console.log(`\nrecord: ${RECORD}`)
void mapSlot2
