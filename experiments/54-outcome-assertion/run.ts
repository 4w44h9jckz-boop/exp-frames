// Experiment 54 on the Hegota testnet: an outcome check at the end of an atomic batch.
//
// usage: npx tsx experiments/54-outcome-assertion/run.ts [setup|a|b|c|d|e|f|assert|all]
//
// Every key is derived from PRIVATE_KEY under an `exp-frames/54/...` label; none is printed. The
// funder EOA pays for setup; the account pays for (a) to (e); a code-less sponsor pays in (f).
// Each run appends one record per case to results/<date>.json.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import {
  type Address,
  type Hex,
  concatHex,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  maxUint256,
  pad,
  parseEther,
  size,
  toHex,
} from 'viem'
import { privateKeyToAccount, privateKeyToAddress } from 'viem/accounts'
import { compileSolidity, compileYul } from '../../src/contracts.js'
import { deployFrame, saltOf, sendFrames } from '../../src/deploy.js'
import { loadKey } from '../../src/env.js'
import {
  ATOMIC_BATCH_FLAG,
  Approve,
  type Frame,
  type FrameTx,
  type FrameTxReceiptJson,
  STORAGE_SET_STATE_GAS,
  frameReceiptGas,
  frameReceiptStatus,
  frameTxHash,
  getNonceSeq,
  makeClient,
  prepareFrameTx,
  secp256k1Placeholder,
  sendFrameTx,
  senderFrame,
  signAll,
  simulateFrameTx,
  verifyFrame,
  waitForFrameTxReceipt,
} from '../../src/frametx/index.js'
import { executionDigest, executionTypedData } from '../27-execution-digest/digest.js'

const DIR = 'experiments/54-outcome-assertion'
const { privateKey, address: funder } = loadKey()
const client = makeClient()

const derive = (label: string) => {
  const key = keccak256(concatHex([privateKey, toHex(`exp-frames/54/${label}`)]))
  return { key, address: privateKeyToAddress(key) }
}
const owner = derive('owner')
const sponsor = derive('sponsor')
const recipient = derive('recipient').address
const listedSpender = derive('listed-spender').address
const operator = derive('operator').address
const sink = derive('sink').address
/** A spender no Q names: fresh per run, so each run's (c) starts from a zero allowance. */
const unlistedSpender = privateKeyToAddress(keccak256(toHex(`exp-frames/54/unlisted/${Date.now()}`)))

// ---- contracts ----

const token = compileSolidity('contracts/TestToken.sol', 'TestToken')
const collection = compileSolidity(`${DIR}/TestCollection.sol`, 'TestCollection')
const liar = compileSolidity(`${DIR}/LyingToken.sol`, 'LyingToken')
const ACCOUNT_CODE = compileYul(`${DIR}/OutcomeAccount.yul`)

const TOKEN = deployFrame(
  concatHex([token.bytecode, encodeAbiParameters([{ type: 'string' }, { type: 'string' }], ['Token 54', 'T54'])]),
  saltOf('exp-frames/54/token'),
  2n * STORAGE_SET_STATE_GAS,
)
const COLLECTION = deployFrame(collection.bytecode, saltOf('exp-frames/54/collection'))
const LIAR = deployFrame(concatHex([liar.bytecode, encodeAbiParameters([{ type: 'address' }], [sink])]), saltOf('exp-frames/54/liar'))
const ACCOUNT = deployFrame(concatHex([ACCOUNT_CODE, pad(owner.address)]), saltOf('exp-frames/54/account'))

// TXTRACE probe: runtime `PUSH1 0 PUSH1 0 TXTRACE PUSH1 0 MSTORE PUSH1 32 PUSH1 0 RETURN`, i.e.
// TXTRACE(param 0x00, in2 0): the count of the diff's first table, returned as one word.
const PROBE_RUNTIME: Hex = '0x60006000b660005260206000f3'
const PROBE_INIT: Hex = `0x6c${PROBE_RUNTIME.slice(2)}600052600d6013f3`
const PROBE = deployFrame(PROBE_INIT, saltOf('exp-frames/54/txtrace-probe'))

type Abi = typeof token.abi
const enc = (abi: Abi, functionName: string, args: unknown[]): Hex =>
  encodeFunctionData({ abi, functionName, args } as Parameters<typeof encodeFunctionData>[0])
const read = async (abi: Abi, address: Address, functionName: string, args: unknown[]): Promise<bigint | boolean> => {
  const data = enc(abi, functionName, args)
  const { data: out } = await client.call({ to: address, data })
  return decodeFunctionResult({ abi, functionName, data: out ?? '0x' } as Parameters<typeof decodeFunctionResult>[0]) as bigint | boolean
}

// ---- Q ----

const ASSERT_SELECTOR: Hex = '0x682c9c89'
type Entry = { what: string; target: Address; call: Hex; expected: bigint }

function encodeQ(entries: Entry[]): Hex {
  const parts: Hex[] = [ASSERT_SELECTOR]
  for (const e of entries) {
    const len = size(e.call)
    const padded = Math.ceil(len / 32) * 32
    parts.push(pad(e.target), toHex(e.expected, { size: 32 }), toHex(len, { size: 32 }), pad(e.call, { dir: 'right', size: padded }))
  }
  return concatHex(parts)
}

const word = (v: bigint | boolean) => (typeof v === 'boolean' ? (v ? 1n : 0n) : v)

async function entry(what: string, abi: Abi, target: Address, fn: string, args: unknown[], change = 0n): Promise<Entry> {
  const now = word(await read(abi, target, fn, args))
  return { what, target, call: enc(abi, fn, args), expected: now + change }
}

const checkFrame = (entries: Entry[]): Frame =>
  senderFrame({ target: ACCOUNT.address, data: encodeQ(entries), execution: 30_000n + 8_000n * BigInt(entries.length) })

// ---- body frames ----

const AMOUNT = parseEther('10')
const transfer = (tokenAddress: Address, abi: Abi, to: Address) =>
  senderFrame({ target: tokenAddress, data: enc(abi, 'transfer', [to, AMOUNT]), execution: 60_000n, state: 2n * STORAGE_SET_STATE_GAS, atomic: true })
const approve = (spender: Address) =>
  senderFrame({ target: TOKEN.address, data: enc(token.abi, 'approve', [spender, maxUint256]), execution: 50_000n, state: STORAGE_SET_STATE_GAS, atomic: true })
const grant = (op: Address) =>
  senderFrame({
    target: COLLECTION.address,
    data: enc(collection.abi, 'setApprovalForAll', [op, true]),
    execution: 50_000n,
    state: STORAGE_SET_STATE_GAS,
    atomic: true,
  })

/** Q for a transfer of TOKEN: both balances, and the named spender's and operator's standing. */
async function transferQ(): Promise<Entry[]> {
  return [
    await entry('balanceOf(account) falls by 10', token.abi, TOKEN.address, 'balanceOf', [ACCOUNT.address], -AMOUNT),
    await entry('balanceOf(recipient) rises by 10', token.abi, TOKEN.address, 'balanceOf', [recipient], AMOUNT),
    await entry('allowance(account, listed spender) stays', token.abi, TOKEN.address, 'allowance', [ACCOUNT.address, listedSpender]),
    await entry('isApprovedForAll(account, operator) stays', collection.abi, COLLECTION.address, 'isApprovedForAll', [ACCOUNT.address, operator]),
  ]
}

// ---- sending and recording ----

const RESULTS = `${DIR}/results`
const RECORD = `${RESULTS}/${new Date().toISOString().slice(0, 10)}.jsonl`
let commit = 'unknown'
try {
  const head = readFileSync('.git/HEAD', 'utf8').trim()
  commit = head.startsWith('ref: ') ? readFileSync(`.git/${head.slice(5)}`, 'utf8').trim() : head
} catch {}

function record(r: Record<string, unknown>) {
  if (!existsSync(RESULTS)) mkdirSync(RESULTS, { recursive: true })
  appendFileSync(RECORD, `${JSON.stringify({ at: new Date().toISOString(), commit, ...r }, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}\n`)
}

function frameSummary(r: FrameTxReceiptJson) {
  return r.frameReceipts.map((f) => {
    const g = frameReceiptGas(f)
    return { status: ['FAILED', 'ok', 'SKIPPED'][frameReceiptStatus(f)] ?? String(frameReceiptStatus(f)), execution: g.execution, state: g.state }
  })
}

function errorText(e: unknown): string {
  const err = e as Error & { details?: string; cause?: { details?: string } }
  return err.details ?? err.cause?.details ?? err.message.split('\n')[0]
}

/** Simulate, then send whatever the simulation says, and wait for a receipt if one comes. */
async function submit(label: string, tx: FrameTx, extra: Record<string, unknown> = {}) {
  console.log(`\n=== ${label} ===`)
  const sim = await simulateFrameTx(client, tx).catch((e) => ({ error: errorText(e) }))
  if ('error' in sim) console.log(`  simulate: RPC error ${sim.error}`)
  else console.log(`  simulate: valid=${sim.valid}${sim.violation ? ` violation=${sim.violation}` : ''}${sim.executionError ? ` error=${sim.executionError}` : ''}`)
  let hash: Hex | null = null
  let refused: string | null = null
  try {
    hash = await sendFrameTx(client, tx)
    console.log(`  sent ${hash}`)
  } catch (e) {
    refused = errorText(e)
    console.log(`  refused: ${refused}`)
  }
  let receipt: FrameTxReceiptJson | null = null
  if (hash) {
    receipt = await waitForFrameTxReceipt(client, hash)
    const frames = frameSummary(receipt)
    console.log(`  block ${BigInt(receipt.blockNumber)} status ${receipt.status} gasUsed ${BigInt(receipt.gasUsed)}`)
    console.log(`  frames: ${frames.map((f, i) => `[${i}] ${f.status} ${f.execution}/${f.state}`).join('  ')}`)
  }
  const out = {
    label,
    hash: hash ?? frameTxHash(tx),
    simulation: sim,
    refused,
    block: receipt ? BigInt(receipt.blockNumber) : null,
    status: receipt?.status ?? null,
    gasUsed: receipt ? BigInt(receipt.gasUsed) : null,
    frames: receipt ? frameSummary(receipt) : null,
    ...extra,
  }
  return out
}

/** A transaction from the account, the owner paying over the canonical signature hash. */
async function fromAccount(frames: Frame[]) {
  const tx = await prepareFrameTx(client, {
    sender: ACCOUNT.address,
    frames: [verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 60_000n }), ...frames],
    signatures: [secp256k1Placeholder(owner.address)],
  })
  return signAll(tx, [owner.key])
}

async function state(extraSpender?: Address) {
  const s: Record<string, bigint | boolean> = {
    'T54.balanceOf(account)': await read(token.abi, TOKEN.address, 'balanceOf', [ACCOUNT.address]),
    'T54.balanceOf(recipient)': await read(token.abi, TOKEN.address, 'balanceOf', [recipient]),
    'T54.allowance(account, listed)': await read(token.abi, TOKEN.address, 'allowance', [ACCOUNT.address, listedSpender]),
    'collection.isApprovedForAll(account, operator)': await read(collection.abi, COLLECTION.address, 'isApprovedForAll', [ACCOUNT.address, operator]),
    'liar.balanceOf(recipient)': await read(liar.abi, LIAR.address, 'balanceOf', [recipient]),
    'liar.held(recipient)': await read(liar.abi, LIAR.address, 'held', [recipient]),
    'liar.held(sink)': await read(liar.abi, LIAR.address, 'held', [sink]),
    'liar.balanceOf(account)': await read(liar.abi, LIAR.address, 'balanceOf', [ACCOUNT.address]),
  }
  if (extraSpender) s['T54.allowance(account, unlisted)'] = await read(token.abi, TOKEN.address, 'allowance', [ACCOUNT.address, extraSpender])
  return s
}

async function runCase(id: string, label: string, body: Frame[], q: Entry[], extraSpender?: Address) {
  const before = await state(extraSpender)
  const tx = await fromAccount([...body, checkFrame(q)])
  const r = await submit(`(${id}) ${label}`, tx)
  const after = await state(extraSpender)
  for (const k of Object.keys(after)) if (after[k] !== before[k]) console.log(`  ${k}: ${before[k]} -> ${after[k]}`)
  record({ case: id, ...r, q: q.map((e) => ({ what: e.what, target: e.target, call: e.call, expected: e.expected })), before, after })
  return r
}

// ---- setup ----

async function setup() {
  const mint = (t: Address, abi: Abi, to: Address, amount: bigint) =>
    senderFrame({ target: t, data: enc(abi, 'mint', [to, amount]), execution: 100_000n, state: 2n * STORAGE_SET_STATE_GAS })
  await sendFrames(client, privateKey, [TOKEN.frame, COLLECTION.frame, LIAR.frame, ACCOUNT.frame, PROBE.frame], {
    label: 'setup: deploy the token, the collection, the lying token, the account and the TXTRACE probe',
    expectCode: [TOKEN.address, COLLECTION.address, LIAR.address, ACCOUNT.address, PROBE.address],
  })
  const ethOf = (a: Address) => client.getBalance({ address: a })
  const fund: Frame[] = []
  if ((await ethOf(ACCOUNT.address)) < parseEther('0.05')) fund.push(senderFrame({ target: ACCOUNT.address, value: parseEther('0.1'), execution: 30_000n }))
  if ((await ethOf(sponsor.address)) < parseEther('0.02'))
    fund.push(senderFrame({ target: sponsor.address, value: parseEther('0.05'), execution: 30_000n, state: STORAGE_SET_STATE_GAS * 2n }))
  if (word(await read(token.abi, TOKEN.address, 'balanceOf', [ACCOUNT.address])) < 100n * AMOUNT) fund.push(mint(TOKEN.address, token.abi, ACCOUNT.address, 1_000n * AMOUNT))
  if (word(await read(liar.abi, LIAR.address, 'held', [ACCOUNT.address])) < 100n * AMOUNT) fund.push(mint(LIAR.address, liar.abi, ACCOUNT.address, 1_000n * AMOUNT))
  if (fund.length) await sendFrames(client, privateKey, fund, { label: 'setup: fund the account and the sponsor, mint to the account' })
  console.log(`account ${ACCOUNT.address}  token ${TOKEN.address}  collection ${COLLECTION.address}  liar ${LIAR.address}  probe ${PROBE.address}`)
  console.log(`funder ${funder}  owner ${owner.address}  sponsor ${sponsor.address}`)
  record({ case: 'setup', account: ACCOUNT.address, token: TOKEN.address, collection: COLLECTION.address, liar: LIAR.address, probe: PROBE.address, owner: owner.address, sponsor: sponsor.address, recipient, listedSpender, operator, sink, accountCodeBytes: size(ACCOUNT_CODE) })
}

// ---- the cases ----

async function caseA() {
  return runCase('a', 'an honest transfer', [transfer(TOKEN.address, token.abi, recipient)], await transferQ())
}
async function caseB() {
  return runCase('b', 'a hidden approval to the listed spender', [transfer(TOKEN.address, token.abi, recipient), approve(listedSpender)], await transferQ())
}
async function caseC() {
  return runCase('c', 'an approval to a spender Q does not list', [transfer(TOKEN.address, token.abi, recipient), approve(unlistedSpender)], await transferQ(), unlistedSpender)
}
async function caseD() {
  return runCase('d', 'an operator grant on the listed collection', [transfer(TOKEN.address, token.abi, recipient), grant(operator)], await transferQ())
}
async function caseE() {
  const q = [
    await entry('liar.balanceOf(account) falls by 10', liar.abi, LIAR.address, 'balanceOf', [ACCOUNT.address], -AMOUNT),
    await entry('liar.balanceOf(recipient) rises by 10', liar.abi, LIAR.address, 'balanceOf', [recipient], AMOUNT),
  ]
  return runCase('e', 'a token whose balanceOf lies', [transfer(LIAR.address, liar.abi, recipient)], q)
}

// (f): the owner signs E over the body and the check; the sponsor completes it with its pay frame.
const payFrame = (payer: Address): Frame => verifyFrame({ scope: Approve.PAYMENT, target: payer, execution: 10_000n })

async function ownerEntry(tx: FrameTx) {
  const sig = await privateKeyToAccount(owner.key).signTypedData(executionTypedData(tx))
  const v = Number.parseInt(sig.slice(130, 132), 16)
  return { ...secp256k1Placeholder(owner.address, executionDigest(tx)), signature: concatHex([toHex(v - 27, { size: 1 }), sig.slice(0, 66) as Hex, `0x${sig.slice(66, 130)}`]) }
}

async function caseF() {
  const q = await transferQ()
  const nonceSeq = await getNonceSeq(client, ACCOUNT.address, [0n])
  const base = await prepareFrameTx(client, {
    sender: ACCOUNT.address,
    nonceSeq,
    frames: [
      verifyFrame({ scope: Approve.EXECUTION, execution: 60_000n }),
      payFrame(sponsor.address),
      transfer(TOKEN.address, token.abi, recipient),
      checkFrame(q),
    ],
    signatures: [secp256k1Placeholder(owner.address, '0x'), secp256k1Placeholder(sponsor.address)],
  })
  const entry0 = await ownerEntry(base)
  const signed = { ...base, signatures: [entry0, base.signatures[1]] }
  const complete = (frames: Frame[]) => signAll({ ...signed, frames }, [sponsor.key])
  const [v, p, t, c] = signed.frames
  const unflag = (f: Frame): Frame => ({ ...f, flags: f.flags & ~ATOMIC_BATCH_FLAG })
  const copies: [string, Frame[]][] = [
    ['the payer drops the check frame', [v, p, unflag(t)]],
    ['the payer moves the check frame ahead of the body', [v, p, { ...c, flags: 0 }, unflag(t)]],
    ['the payer moves the check frame into a separate batch', [v, p, unflag(t), c]],
    ['the payer inserts a body frame into the batch, ahead of the check', [v, p, t, approve(unlistedSpender), c]],
  ]
  const results = []
  for (const [label, frames] of copies) {
    const r = await submit(`(f) ${label}`, await complete(frames))
    record({ case: 'f', copy: label, ...r })
    results.push(r)
  }
  const before = await state()
  const r = await submit('(f) the honest completion', await complete(signed.frames))
  const after = await state()
  record({ case: 'f', copy: 'honest completion', ...r, before, after })

  // The account's own rule, apart from E: a transaction the owner signs without a check frame.
  const bare = await fromAccount([{ ...transfer(TOKEN.address, token.abi, recipient), flags: 0 }])
  const rb = await submit('(f, control) the owner signs a body with no check frame', bare)
  record({ case: 'f-control', ...rb })
  return [...results, r, rb]
}

// ---- ASSERT and TXTRACE on this network ----

async function caseAssert() {
  const q = await transferQ()
  const assertFrame: Frame = { ...checkFrame(q), mode: 3, flags: 0 }
  const tx = await fromAccount([{ ...transfer(TOKEN.address, token.abi, recipient), flags: 0 }, assertFrame])
  const r = await submit('ASSERT: (a) with the check in a final frame of mode 3', tx)
  record({ case: 'assert-mode', ...r })
  // The same mode from the funder's EOA, whose default code does not look at the last frame, so
  // only the network's own rules decide.
  const eoaTx = await signAll(
    await prepareFrameTx(client, {
      sender: funder,
      frames: [
        verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 20_000n }),
        senderFrame({ target: TOKEN.address, data: enc(token.abi, 'balanceOf', [funder]), execution: 30_000n }),
        { mode: 3, flags: 0, target: TOKEN.address, limits: { execution: 30_000n, state: 0n }, value: 0n, data: enc(token.abi, 'balanceOf', [funder]) },
      ],
      signatures: [secp256k1Placeholder()],
    }),
    [privateKey],
  )
  const re = await submit('ASSERT: a final frame of mode 3 from an EOA', eoaTx)
  record({ case: 'assert-mode-eoa', ...re })

  let call: Record<string, unknown>
  try {
    const { data } = await client.call({ to: PROBE.address, data: '0x' })
    call = { returned: data ?? null }
  } catch (e) {
    call = { error: errorText(e) }
  }
  console.log(`\n=== TXTRACE: eth_call to the probe ===\n  ${JSON.stringify(call)}`)
  const code = await client.getCode({ address: PROBE.address })
  const probeTx = await fromAccount([
    senderFrame({ target: PROBE.address, execution: 30_000n, atomic: true }),
    checkFrame([]),
  ])
  const rp = await submit('TXTRACE: a body frame calling the probe', probeTx)
  record({ case: 'txtrace', probeCode: code ?? null, ethCall: call, ...rp })
}

// ---- main ----

const which = process.argv[2] ?? 'all'
const steps: Record<string, () => Promise<unknown>> = { setup, a: caseA, b: caseB, c: caseC, d: caseD, e: caseE, f: caseF, assert: caseAssert }
const order = which === 'all' ? ['setup', 'a', 'b', 'c', 'd', 'e', 'f', 'assert'] : which.split(',')
for (const s of order) {
  const step = steps[s]
  if (!step) throw new Error(`unknown step ${s}`)
  await step()
}
console.log(`\nrecord: ${RECORD}`)
