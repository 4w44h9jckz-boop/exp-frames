// Experiment 58's cases for the local chain: the genesis allocation, the layouts, and every case as a
// raw transaction with its template, parameters and predicted verdict. Run from the repository root.
//
//   npx tsx experiments/58-write-list/cases.ts                write cases/ (deterministic)
//   npx tsx experiments/58-write-list/cases.ts honest h1 <seq> print H1's provisional transaction at <seq>
//   npx tsx experiments/58-write-list/cases.ts honest h2 <seq> the same for H2
//   npx tsx experiments/58-write-list/cases.ts noise <seq>     print the noise sender's transfer at <seq>
//
// Every key is derived from a public label, `exp-frames/58/<label>`: these are local-chain test keys,
// not accounts. A ControlAccount case's transaction is provisional: its final assert(Q) frame is
// empty, and write-check --sign replaces it with the compiled Q and signs again with the owner's key
// (SIGNER_KEY = the `owner` label's key, printed in cases/keys.json).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { type Address, type Hex, concatHex, encodeFunctionData, getAddress, keccak256, maxUint256, numberToHex, pad, parseEther, toHex } from 'viem'
import { privateKeyToAddress } from 'viem/accounts'
import { TOKEN_A, TOKEN_B, TOY_DEX } from '../03-atomic-batch/setup.js'
import { compileSolidity, compileYul } from '../../src/contracts.js'
import {
  ATOMIC_BATCH_FLAG,
  Approve,
  type Frame,
  type FrameTx,
  type FrameTxJson,
  STORAGE_SET_STATE_GAS,
  defaultFrame,
  frameTxFromJson,
  parseFrameTx,
  secp256k1Placeholder,
  senderFrame,
  serializeFrameTx,
  signAll,
  verifyFrame,
} from '../../src/frametx/index.js'

const DIR = 'experiments/58-write-list'
const OUT = `${DIR}/cases`
const CHAIN_ID = 8141n
const FEES = { maxPriorityFeePerGas: 1_000_000_000n, maxFeePerGas: 2_000_000_000n, maxFeePerBlobGas: 0n }

const key = (label: string) => keccak256(toHex(`exp-frames/58/${label}`))
const OWNER = key('owner')
const owner = privateKeyToAddress(OWNER)
const a = (n: number): Address => getAddress(`0x58${n.toString(16).padStart(38, '0')}`)

// ---- addresses ----
const T58 = a(0x10)
const COLLECTION = a(0x20)
const LIAR = a(0x30)
const PROBES = a(0x40)
const R = a(0x13) // the recipient, an EOA
const SPENDER = a(0xbadd1)
const SPENDER2 = a(0xbadd2)
const OPERATOR = a(0xaa1)
const ATTACKER = a(0xbad)
const DELEGATE = a(0xde1e)
const SINK = getAddress('0x00000000000000000000000000000000000051c4')
const IMPL_SLOT: Hex = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const ACCOUNT_KIND = { kind: 'account', ownerSlot: '0x0', implementationSlot: IMPL_SLOT }

// ---- code ----
const token = compileSolidity('contracts/TestToken.sol', 'TestToken')
const collection = compileSolidity(`${DIR}/TestCollection.sol`, 'TestCollection')
const liar = compileSolidity(`${DIR}/LyingToken.sol`, 'LyingToken')
const CONTROL = compileYul(`${DIR}/ControlAccount.yul`)
const PROBES_CODE = compileYul(`${DIR}/Probes.yul`)

/** ToyDex's runtime with its two immutables filled, since a genesis allocation runs no constructor. */
function toyDexRuntime(tokenIn: Address, tokenOut: Address): Hex {
  const solc = createRequire(import.meta.url)('solc') as { compile: (s: string) => string }
  const file = 'experiments/03-atomic-batch/ToyDex.sol'
  const out = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: 'Solidity',
        sources: { [file]: { content: readFileSync(file, 'utf8') } },
        settings: { evmVersion: 'osaka', optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { ToyDex: ['evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences', 'abi'] } } },
      }),
    ),
  )
  const c = out.contracts[file].ToyDex
  const code = c.evm.deployedBytecode.object as string
  const astIds = Object.keys(c.evm.deployedBytecode.immutableReferences).map(Number).sort((x, y) => x - y) // declaration order
  const values = [tokenIn, tokenOut]
  let patched = code
  astIds.forEach((id, i) => {
    for (const { start, length } of c.evm.deployedBytecode.immutableReferences[id]) {
      patched = patched.slice(0, 2 * start) + pad(values[i]).slice(2) + patched.slice(2 * (start + length))
    }
  })
  return `0x${patched}`
}

// ---- storage helpers ----
const word = (v: bigint) => toHex(v, { size: 32 })
const mapSlot = (k: Address, slot: number): Hex => keccak256(concatHex([pad(k), word(BigInt(slot))]))
const nestedSlot = (k1: Address, k2: Address, slot: number): Hex => keccak256(concatHex([pad(k2), mapSlot(k1, slot)]))

type AllocEntry = { balance: Hex; code?: Hex; nonce?: Hex; storage?: Record<Hex, Hex> }
const alloc: Record<string, AllocEntry> = {}
const put = (addr: Address, e: Partial<AllocEntry>) => {
  const cur = alloc[addr] ?? { balance: '0x0' }
  alloc[addr] = { ...cur, ...e, storage: { ...(cur.storage ?? {}), ...(e.storage ?? {}) } }
  if (!Object.keys(alloc[addr].storage ?? {}).length) delete alloc[addr].storage
}
const tokenBalances = (t: Address, slot: number, holders: Address[], amount: bigint) =>
  put(t, { storage: Object.fromEntries(holders.map((h) => [mapSlot(h, slot), word(amount)])) })

const layouts: Record<string, unknown> = {}
const ERC20 = { kind: 'erc20', balanceSlot: 3, allowanceSlot: 4 }

// ---- case records ----
type Case = {
  id: string
  family: string
  runnable: boolean
  raw: Hex
  provisional: boolean
  template: string
  params: Record<string, string>
  rules: 'f3079a0' | 'master'
  predicted: 'pass' | 'fail' | 'not-simulated'
  note: string
  fixture?: string
}
const cases: Case[] = []

// ---- A. Experiment 27's nineteen, at f3079a0 ----
{
  const file = readFileSync('experiments/27-execution-digest/erc-assets/cases-eip8250-f3079a0.txt', 'utf8')
  for (const line of file.split('\n')) {
    const [kind, addr, balance, nonce, code] = line.split(' ')
    if (kind === 'account') put(getAddress(addr), { balance: balance as Hex, nonce: numberToHex(BigInt(nonce)), ...(code !== '0x' ? { code: code as Hex } : {}) })
  }
  const holders = ['0x2700000000000000000000000000000000000001', '0x2700000000000000000000000000000000000002', '0x2700000000000000000000000000000000000003'].map(getAddress)
  for (const t of ['0x2700000000000000000000000000000000000010', '0x2700000000000000000000000000000000000011'].map(getAddress)) {
    put(t, { code: token.deployedBytecode })
    tokenBalances(t, 3, holders, parseEther('1000'))
    layouts[t] = ERC20
  }
  const TOKEN_E = getAddress('0x2700000000000000000000000000000000000010')
  const OTHER_E = getAddress('0x2700000000000000000000000000000000000011')
  const TO_E = getAddress('0x2700000000000000000000000000000000000013')
  const transfer = (amount: string) => ({ template: 'erc20-transfer', params: { token: TOKEN_E, to: TO_E, amount } })
  const eth = (value: string) => ({ template: 'eth-transfer', params: { to: TO_E, value } })
  const plan: Record<string, { template: string; params: Record<string, string>; predicted: Case['predicted'] }> = {
    'sponsored-transfer': { ...transfer('1000000000000000000'), predicted: 'pass' },
    'with-expiry': { ...transfer('1'), predicted: 'pass' },
    'atomic-approve-swap': { template: 'approve-and-swap', params: { 'token-in': TOKEN_E, 'amount-in': '10000000000000000000', dex: OTHER_E, 'token-out': OTHER_E, 'min-out': '1' }, predicted: 'fail' },
    'deploy-first': { ...eth('1'), predicted: 'pass' },
    'keyed-nonces': { ...eth('5'), predicted: 'pass' },
    'legacy-nonce-7': { ...eth('5'), predicted: 'pass' },
    'value-and-default': { ...eth('100000000000000000'), predicted: 'pass' },
    blobs: { template: 'calls-only', params: {}, predicted: 'pass' },
    'many-frames': { template: 'calls-only', params: {}, predicted: 'pass' },
    'self-paying': { ...eth('1'), predicted: 'not-simulated' },
    'payer-replaced': { ...transfer('1000000000000000000'), predicted: 'pass' },
    'target-written-out': { ...transfer('1000000000000000000'), predicted: 'pass' },
    'inserted-default': { ...transfer('1000000000000000000'), predicted: 'not-simulated' },
    'appended-default': { ...transfer('1000000000000000000'), predicted: 'not-simulated' },
    'state-limit-lowered': { ...transfer('1000000000000000000'), predicted: 'not-simulated' },
    'transfer-retargeted': { ...transfer('1000000000000000000'), predicted: 'not-simulated' },
    'payer-is-sender': { ...transfer('1000000000000000000'), predicted: 'not-simulated' },
    'other-account': { ...transfer('1000000000000000000'), predicted: 'not-simulated' },
    'blob-swapped': { template: 'calls-only', params: {}, predicted: 'not-simulated' },
  }
  for (const line of file.split('\n')) {
    const [kind, name, expect, raw] = line.split(' ')
    if (kind !== 'case') continue
    const p = plan[name]
    if (!p) throw new Error(`no plan for ${name}`)
    cases.push({ id: `A27/${name}`, family: 'A: experiment 27', runnable: true, raw: raw as Hex, provisional: false, template: p.template, params: p.params, rules: 'f3079a0', predicted: p.predicted, note: `experiment 27 verdict: ${expect}. ${line.split(' # ')[1] ?? ''}` })
  }
}

// ---- A. Experiment 28's twelve batches, rebuilt for the local chain ----
{
  put(TOKEN_A, { code: token.deployedBytecode })
  put(TOKEN_B, { code: token.deployedBytecode })
  put(TOY_DEX, { code: toyDexRuntime(TOKEN_A, TOKEN_B) })
  tokenBalances(TOKEN_B, 3, [TOY_DEX], parseEther('1000'))
  layouts[TOKEN_A] = ERC20
  layouts[TOKEN_B] = ERC20
  layouts[TOY_DEX] = { kind: 'dex' }
  const src = readFileSync('experiments/28-wallet-send-calls/rebuild.test.ts', 'utf8')
  let i = 0
  for (const [, hash, by] of src.matchAll(/\{ hash: '(0x[0-9a-f]{64})', by: '([^']+)' \}/g)) {
    const mined = frameTxFromJson((JSON.parse(readFileSync(`test/fixtures/chain/${hash}.json`, 'utf8')) as { tx: FrameTxJson }).tx)
    const userKey = key(`batch/${i}`)
    const user = privateKeyToAddress(userKey)
    put(user, { balance: word(parseEther('1')) })
    tokenBalances(TOKEN_A, 3, [user], parseEther('1000'))
    // The calls, as mined: targets, data and atomic flags. Pay frames and the sponsor's VERIFY are
    // dropped (the user pays), and the budgets are widened for fresh slots on a new chain.
    const calls = mined.frames
      .filter((f) => f.mode !== 1)
      .map((f): Frame => ({ ...f, limits: { execution: f.limits.execution > 100_000n ? f.limits.execution : 100_000n, state: 4n * STORAGE_SET_STATE_GAS } }))
    const tx: FrameTx = {
      chainId: CHAIN_ID,
      nonceKeys: [0n],
      nonceSeq: 0n,
      sender: user,
      frames: [verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 20_000n }), ...calls],
      signatures: [secp256k1Placeholder()],
      fees: FEES,
      blobVersionedHashes: [],
    }
    const signed = await signAll(tx, [userKey])
    const approve = calls.find((f) => f.data.startsWith('0x095ea7b3'))
    const swap = calls.find((f) => f.data.startsWith('0xd96073cf'))
    if (!approve || !swap) throw new Error(`${by}: no approve or swap`)
    const amountIn = BigInt(`0x${swap.data.slice(10, 74)}`)
    const minOut = BigInt(`0x${swap.data.slice(74, 138)}`)
    const approved = BigInt(`0x${approve.data.slice(74, 138)}`)
    const d = by.endsWith(', D')
    cases.push({
      id: `A28/${by}`,
      family: 'A: experiment 28',
      runnable: true,
      raw: serializeFrameTx(signed),
      provisional: false,
      template: 'approve-and-swap',
      params: { 'token-in': TOKEN_A, 'amount-in': amountIn.toString(), dex: TOY_DEX, 'token-out': TOKEN_B, 'min-out': minOut.toString(), approve: approved.toString() },
      rules: 'f3079a0',
      predicted: d ? 'fail' : 'pass',
      note: d
        ? `experiment 28's ${hash}: approve ${approved}, swap ${amountIn} without the atomic flag, approve 0. The swap reverts for want of allowance, so no swap happens (amendment 1)`
        : `experiment 28's ${hash}, rebuilt: approve and swap ${amountIn}`,
    })
    i++
  }
}

// ---- B and C: ControlAccount cases ----
put(T58, { code: token.deployedBytecode })
put(COLLECTION, { code: collection.deployedBytecode })
put(LIAR, { code: liar.deployedBytecode })
put(PROBES, { code: PROBES_CODE })
layouts[T58] = ERC20
layouts[COLLECTION] = { kind: 'collection', operatorSlot: 1 }
layouts[LIAR] = { kind: 'erc20', balanceSlot: 1, allowanceSlot: 99 }

const enc = (abi: typeof token.abi, functionName: string, args: unknown[]): Hex =>
  encodeFunctionData({ abi, functionName, args } as Parameters<typeof encodeFunctionData>[0])
const selfCall = (sel: Hex, arg: Address): Hex => concatHex([sel, pad(arg)])
const AMOUNT = parseEther('1')

let accountIndex = 0x100
function controlAccount(extra: Partial<AllocEntry> = {}) {
  const acct = a(accountIndex++)
  put(acct, { balance: word(parseEther('1')), code: CONTROL, storage: { [word(0n)]: pad(owner) }, ...extra })
  tokenBalances(T58, 3, [acct], parseEther('1000'))
  put(LIAR, { storage: { [mapSlot(acct, 1)]: word(parseEther('1000')) } })
  layouts[acct] = ACCOUNT_KIND
  return acct
}

const atomic = (f: Frame): Frame => ({ ...f, flags: f.flags | ATOMIC_BATCH_FLAG })
async function provisional(sender: Address, body: Frame[], seq = 0n): Promise<Hex> {
  const tx: FrameTx = {
    chainId: CHAIN_ID,
    nonceKeys: [0n],
    nonceSeq: seq,
    sender,
    frames: [
      verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 60_000n }),
      ...body.map(atomic),
      senderFrame({ target: sender, data: '0x682c9c89', execution: 60_000n }),
    ],
    signatures: [secp256k1Placeholder(owner)],
    fees: FEES,
    blobVersionedHashes: [],
  }
  return serializeFrameTx(await signAll(tx, [OWNER]))
}

const t58Transfer = () => senderFrame({ target: T58, data: enc(token.abi, 'transfer', [R, AMOUNT]), execution: 60_000n, state: 2n * STORAGE_SET_STATE_GAS })
const transferParams = { token: T58, to: R, amount: AMOUNT.toString() }

async function control(id: string, family: string, body: (acct: Address) => Frame[], predicted: Case['predicted'], note: string, opts: { template?: string; params?: Record<string, string>; alloc?: (acct: Address) => void } = {}) {
  const acct = controlAccount()
  opts.alloc?.(acct)
  cases.push({ id, family, runnable: true, raw: await provisional(acct, body(acct)), provisional: true, template: opts.template ?? 'erc20-transfer', params: opts.params ?? transferParams, rules: 'f3079a0', predicted, note })
}

await control('B0', 'B: control state', () => [t58Transfer()], 'pass', 'the honest transfer')
await control('B1', 'B: control state', () => [t58Transfer(), senderFrame({ target: T58, data: enc(token.abi, 'approve', [SPENDER, maxUint256]), execution: 50_000n, state: STORAGE_SET_STATE_GAS })], 'fail', 'an approval: one unlisted allowance slot')
await control('B2', 'B: control state', () => [t58Transfer(), senderFrame({ target: COLLECTION, data: enc(collection.abi, 'setApprovalForAll', [OPERATOR, true]), execution: 50_000n, state: STORAGE_SET_STATE_GAS })], 'fail', 'an operator grant: one unlisted operator slot')
await control('B3', 'B: control state', (acct) => [t58Transfer(), senderFrame({ target: acct, data: selfCall('0xd784d426', DELEGATE), execution: 30_000n, state: STORAGE_SET_STATE_GAS })], 'fail', 'a delegation through the account\'s EIP-1967 implementation slot: one unlisted slot. EIP-7702 is not exercised')
await control('B4', 'B: control state', (acct) => [t58Transfer(), senderFrame({ target: acct, data: selfCall('0x13af4035', ATTACKER), execution: 30_000n, state: STORAGE_SET_STATE_GAS })], 'fail', 'the owner slot: slot 0 of the account, unlisted')
await control('B5', 'B: control state', () => [senderFrame({ target: LIAR, data: enc(liar.abi, 'transfer', [R, AMOUNT]), execution: 80_000n, state: 3n * STORAGE_SET_STATE_GAS })], 'fail', 'the lying token: the sink\'s and the told slots unlisted, the recipient\'s held slot missing', { params: { token: LIAR, to: R, amount: AMOUNT.toString() } })
await control('B6', 'B: control state', () => [t58Transfer(), senderFrame({ target: T58, data: enc(token.abi, 'approve', [SPENDER2, maxUint256]), execution: 50_000n, state: STORAGE_SET_STATE_GAS })], 'fail', 'experiment 54\'s (c): an approval to a spender the intent does not name')
await control('C2', 'C: probes', () => [t58Transfer(), senderFrame({ target: PROBES, data: concatHex(['0xa45f7cc4', pad(ATTACKER)]), execution: 30_000n })], 'pass', 'an event linking the sender to another address: a harm with no write')
await control('C3', 'C: probes', () => [t58Transfer(), senderFrame({ target: T58, data: enc(token.abi, 'approve', [SPENDER, 0n]), execution: 50_000n })], 'pass', 'an approval set to its current value, 0: no slot changes')
await control(
  'C4',
  'C: probes',
  (acct) => [t58Transfer(), defaultFrame({ target: PROBES, data: concatHex(['0xdc772e94', pad(T58), pad(acct), pad(ATTACKER), word(parseEther('5'))]), execution: 80_000n })],
  'fail',
  'a pre-existing allowance (to the puller, 100) spent in the user\'s transaction: the allowance and the attacker\'s balance unlisted, the sender\'s balance mismatched',
  { alloc: (acct) => put(T58, { storage: { [nestedSlot(acct, PROBES, 4)]: word(parseEther('100')) } }) },
)
// DEFAULT frames have no state budget in defaultFrame(); give C4's one.
{
  const c4 = cases.find((c) => c.id === 'C4')
  if (c4) {
    const tx = parseFrameTx(c4.raw)
    tx.frames[2] = { ...tx.frames[2], limits: { execution: 80_000n, state: 2n * STORAGE_SET_STATE_GAS } }
    c4.raw = serializeFrameTx(await signAll({ ...tx, signatures: [secp256k1Placeholder(owner)] }, [OWNER]))
  }
}

// ---- the revert share: H1 (a token transfer to R) and H2 (an ether transfer to R) ----
const H1 = controlAccount()
const H2 = controlAccount()
const NOISE_KEY = key('noise')
const NOISE = privateKeyToAddress(NOISE_KEY)
put(NOISE, { balance: word(parseEther('100')) })
tokenBalances(T58, 3, [NOISE], parseEther('1000000'))
put(R, { balance: word(1n) })
tokenBalances(T58, 3, [R], 1n) // R's slots start non-zero, so every honest transfer and noise transfer is a change
const honestBody = { h1: () => [t58Transfer()], h2: () => [senderFrame({ target: R, value: 1000n, execution: 30_000n })] }
const honestTemplate = { h1: { template: 'erc20-transfer', params: transferParams }, h2: { template: 'eth-transfer', params: { to: R, value: '1000' } } }
async function noise(seq: bigint): Promise<Hex> {
  const tx: FrameTx = {
    chainId: CHAIN_ID,
    nonceKeys: [0n],
    nonceSeq: seq,
    sender: NOISE,
    frames: [verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 20_000n }), senderFrame({ target: T58, data: enc(token.abi, 'transfer', [R, 1n]), execution: 60_000n }), senderFrame({ target: R, value: 1n, execution: 30_000n })],
    signatures: [secp256k1Placeholder()],
    fees: FEES,
    blobVersionedHashes: [],
  }
  return serializeFrameTx(await signAll(tx, [NOISE_KEY]))
}

// ---- fixtures: experiment 34's pair and the EIP-8250 replay pair ----
const fixtures: Record<string, unknown> = {}
{
  const w3 = JSON.parse(readFileSync('experiments/34-concurrent-withdrawals/record.json', 'utf8')) as { pair: { raw: Hex }[] }
  w3.pair.forEach((p, k) => {
    const tx = parseFrameTx(p.raw)
    const data = tx.frames[2].data
    const nullifier = `0x${data.slice(10 + 64 * 2, 10 + 64 * 3)}` as Hex
    const recipient = getAddress(`0x${data.slice(10 + 64 * 3 + 24, 10 + 64 * 4)}`)
    const amount = parseEther('0.1') // hand-written: the fixture's denomination, not the pool's record
    const pool = tx.sender
    layouts[pool] = { kind: 'pool', nullifierSlot: 4 }
    const nullSlot = keccak256(concatHex([nullifier, word(4n)]))
    fixtures[`w3-${k + 1}`] = {
      fixture: 'hand-written in docs/simulated-writes.md\'s format; not a chain\'s output',
      valid: true,
      executionStatus: 'success',
      maxCost: word(10n ** 15n),
      payer: pool,
      writes: [
        { address: '0x0000000000000000000000000000000000000000', balance: [word(0n), word(42_000n)] },
        { address: pool, balance: [word(parseEther('10')), word(parseEther('10') - amount - 42_000n)], storage: [{ slot: nullSlot, before: word(0n), after: word(1n) }] },
        { address: recipient, balance: [word(0n), word(amount)] },
        { address: '0x0000000000000000000000000000000000008250', storage: [{ slot: keccak256(concatHex([pad(pool), word(tx.nonceKeys[0])])), before: word(0n), after: word(1n) }] },
      ].sort((x, y) => (x.address.toLowerCase() < y.address.toLowerCase() ? -1 : 1)),
    }
    cases.push({ id: `A34/withdrawal-${k + 1}`, family: 'A: experiment 34', runnable: false, raw: p.raw, provisional: false, template: 'pool-withdrawal', params: { pool, to: recipient, amount: amount.toString(), nullifier }, rules: 'f3079a0', predicted: 'pass', note: 'a fixture: experiment 34\'s pool needs its deposit and proof on the local chain. The pair\'s linkability is not a write', fixture: `fixtures/w3-${k + 1}.json` })
  })
}
{
  const master = readFileSync('experiments/27-execution-digest/erc-assets/cases.txt', 'utf8')
  const line = master.split('\n').find((l) => l.startsWith('case key-zero '))
  if (!line) throw new Error('no key-zero')
  const raw = line.split(' ')[3] as Hex
  const tx = parseFrameTx(raw)
  const to = getAddress('0x2700000000000000000000000000000000000013')
  const value = tx.frames.find((f) => f.mode === 2)?.value ?? 0n
  const common = [
    { address: '0x0000000000000000000000000000000000000000', balance: [word(0n), word(21_000n)] },
    { address: to, balance: [word(0n), word(value)] },
  ]
  const sponsor = getAddress('0x87761a88398830f371282d2d3e35D227ebfb8777')
  const pay = { address: sponsor, balance: [word(parseEther('1000')), word(parseEther('1000') - 21_000n)] }
  // The original, mined under f3079a0: key [0] is the legacy nonce, so the account nonce moves.
  fixtures['replay-original'] = { fixture: 'hand-written; the original under f3079a0', valid: true, executionStatus: 'success', maxCost: word(10n ** 15n), payer: sponsor, writes: [...common, pay, { address: tx.sender, nonce: [word(0n), word(1n)] }] }
  // The replay, on the same chain after it moves to master in place: key 0 is an ordinary key, read
  // from an empty nonce record, which it writes 0 -> 1.
  fixtures['replay-after-switch'] = { fixture: 'hand-written; the same bytes under master', valid: true, executionStatus: 'success', maxCost: word(10n ** 15n), payer: sponsor, writes: [...common, pay, { address: '0x0000000000000000000000000000000000008250', storage: [{ slot: keccak256(concatHex([pad(tx.sender), word(0n)])), before: word(0n), after: word(1n) }] }] }
  cases.push({ id: 'A8250/original', family: 'A: the EIP-8250 pair', runnable: false, raw, provisional: false, template: 'eth-transfer', params: { to, value: value.toString() }, rules: 'f3079a0', predicted: 'pass', note: 'a fixture: the original', fixture: 'fixtures/replay-original.json' })
  cases.push({ id: 'A8250/replay', family: 'A: the EIP-8250 pair', runnable: false, raw, provisional: false, template: 'eth-transfer', params: { to, value: value.toString() }, rules: 'master', predicted: 'pass', note: 'a fixture: the replay after a revision switch. Its writes equal a harmless first use of key 0, so the claim is predicted to fail here', fixture: 'fixtures/replay-after-switch.json' })
}

// ---- main ----
const [cmd, which, seqArg] = process.argv.slice(2)
if (cmd === 'honest') {
  const k = which as 'h1' | 'h2'
  const acct = k === 'h1' ? H1 : H2
  console.log(JSON.stringify({ raw: await provisional(acct, honestBody[k](), BigInt(seqArg ?? '0')), sender: acct, ...honestTemplate[k] }))
} else if (cmd === 'noise') {
  console.log(JSON.stringify({ raw: await noise(BigInt(which ?? '0')), sender: NOISE }))
} else {
  mkdirSync(`${OUT}/fixtures`, { recursive: true })
  const sorted = Object.fromEntries(Object.entries(alloc).sort(([x], [y]) => (x.toLowerCase() < y.toLowerCase() ? -1 : 1)))
  writeFileSync(`${OUT}/genesis-alloc.json`, `${JSON.stringify(sorted, null, 1)}\n`)
  writeFileSync(`${OUT}/layouts.json`, `${JSON.stringify(layouts, null, 1)}\n`)
  writeFileSync(`${OUT}/cases.json`, `${JSON.stringify(cases, null, 1)}\n`)
  for (const [k, v] of Object.entries(fixtures)) writeFileSync(`${OUT}/fixtures/${k}.json`, `${JSON.stringify(v, null, 1)}\n`)
  writeFileSync(
    `${OUT}/keys.json`,
    `${JSON.stringify({ note: 'local-chain test keys derived from public labels; not accounts', owner: { label: 'exp-frames/58/owner', address: owner, key: OWNER }, noise: { label: 'exp-frames/58/noise', address: NOISE }, h1: H1, h2: H2, recipient: R }, null, 1)}\n`,
  )
  console.log(`${cases.length} cases (${cases.filter((c) => c.runnable).length} runnable), ${Object.keys(alloc).length} genesis accounts`)
}
