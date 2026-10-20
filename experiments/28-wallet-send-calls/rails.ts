// Experiment 28, part 2: the same EIP-5792 batch (approve Token A to the DEX, swap) on four rails,
// each from a fresh EOA, two rounds each. Round 1 creates the user's Token B balance; round 2 is
// the steady state.
//
//   frames, self-paid       the wallet of `wallet.ts`, default code
//   frames, sponsored       the same wallet with the paymaster service; the user holds no ETH
//   type 2, EIP-7702        the EOA delegated to ERC-4337 v0.8's Simple7702Account, calling its
//                           own executeBatch
//   ERC-4337, EIP-7702      the same delegate, through EntryPoint v0.8's handleOps, self-paid
//
// The ERC-4337 contracts are experiment 21's deployment on this chain (EntryPoint v0.8 and
// Simple7702Account with that EntryPoint patched in).
//
// usage: npx tsx experiments/28-wallet-send-calls/rails.ts
import {
  type Address,
  type Hex,
  concatHex,
  createWalletClient,
  custom,
  decodeEventLog,
  encodeFunctionData,
  http,
  keccak256,
  pad,
  parseEther,
  parseGwei,
  serializeSignature,
  toHex,
} from 'viem'
import { privateKeyToAccount, privateKeyToAddress, sign } from 'viem/accounts'
import { create2Address, saltOf, sendFrames } from '../../src/deploy.js'
import { loadKey } from '../../src/env.js'
import { type Frame, HEGOTA_RPC_URL, NEW_ACCOUNT_STATE_GAS, STORAGE_SET_STATE_GAS, hegotaTestnet, makeClient, senderFrame } from '../../src/frametx/index.js'
import { TOKEN_A, TOKEN_B, TOY_DEX, dex, token } from '../03-atomic-batch/setup.js'
import { CANONICAL_ENTRY_POINT, artifact } from '../21-erc4337-side-by-side/artifacts.js'
import { paymasterInstance, startPaymasterService } from './paymaster.js'
import { framesWallet } from './wallet.js'

const client = makeClient()
const chainId = BigInt(await client.getChainId())
const { privateKey: funderKey } = loadKey()
const derive = (label: string) => {
  const key = keccak256(concatHex([funderKey, toHex(`exp-frames/28/${label}`)]))
  return { key, address: privateKeyToAddress(key) }
}
const run = process.argv[2] ?? 'r1'
const users = {
  framesSelf: derive(`rails/${run}/frames-self`),
  framesSponsored: derive(`rails/${run}/frames-sponsored`),
  t2: derive(`rails/${run}/7702-type2`),
  erc4337: derive(`rails/${run}/7702-4337`),
}
const bundler = derive('rails/bundler')
const E = (n: number) => parseEther(String(n))
const fees = { maxFeePerGas: parseGwei('2'), maxPriorityFeePerGas: parseGwei('1') }

// ---- experiment 21's ERC-4337 deployment ----
const ep = await artifact('EntryPoint')
const s7702Art = await artifact('Simple7702Account')
const entryPoint = create2Address(ep.bytecode, saltOf('exp-frames/21/entry-point/v0.8'))
const patched = s7702Art.bytecode.replaceAll(CANONICAL_ENTRY_POINT.slice(2).toLowerCase(), entryPoint.slice(2).toLowerCase()) as Hex
const s7702 = create2Address(patched, saltOf('exp-frames/21/simple-7702-account/v0.8-patched'))
for (const [n, a] of [['EntryPoint', entryPoint], ['Simple7702Account', s7702]] as const) {
  if (!(await client.getCode({ address: a }))) throw new Error(`${n} ${a} not deployed: run experiment 21 first`)
}
console.log(`EntryPoint ${entryPoint}, Simple7702Account ${s7702}`)
for (const [k, u] of Object.entries(users)) console.log(`${k} ${u.address}`)

// ---- setup: ETH for every rail but the sponsored one, Token A for all ----
{
  const frames: Frame[] = []
  for (const a of [users.framesSelf.address, users.t2.address, users.erc4337.address, bundler.address]) {
    if ((await client.getBalance({ address: a })) < E(0.01)) frames.push(senderFrame({ target: a, value: E(0.03), execution: 30_000n, state: NEW_ACCOUNT_STATE_GAS }))
  }
  for (const u of Object.values(users)) {
    const bal = (await client.readContract({ address: TOKEN_A, abi: token.abi, functionName: 'balanceOf', args: [u.address] } as never)) as bigint
    if (bal < E(10)) frames.push(senderFrame({ target: TOKEN_A, data: encodeFunctionData({ abi: token.abi, functionName: 'mint', args: [u.address, E(100)] }), execution: 80_000n, state: 2n * STORAGE_SET_STATE_GAS }))
  }
  if (frames.length) await sendFrames(client, funderKey, frames, { label: 'setup: ETH and Token A for the rails' })
}
const wallet = (key: Hex) => createWalletClient({ account: privateKeyToAccount(key), chain: hegotaTestnet, transport: http(HEGOTA_RPC_URL) })
for (const u of [users.t2, users.erc4337]) {
  const code = (await client.getCode({ address: u.address })) ?? '0x'
  if (code.toLowerCase().startsWith(`0xef0100${s7702.slice(2).toLowerCase()}`)) continue
  const w = wallet(u.key)
  const authorization = await w.signAuthorization({ contractAddress: s7702, executor: 'self' })
  const hash = await w.sendTransaction({ authorizationList: [authorization], to: u.address, data: '0x', gas: 200_000n, ...fees })
  const r = await client.waitForTransactionReceipt({ hash })
  console.log(`7702 delegation for ${u.address} (type 4, self-sent): ${hash} status ${r.status} gasUsed ${r.gasUsed}`)
}

const amt = E(1)
const calls = [
  { to: TOKEN_A, data: encodeFunctionData({ abi: token.abi, functionName: 'approve', args: [TOY_DEX, amt] }) },
  { to: TOY_DEX, data: encodeFunctionData({ abi: dex.abi, functionName: 'swap', args: [amt, amt] }) },
] as const
const executeBatch = encodeFunctionData({ abi: s7702Art.abi, functionName: 'executeBatch', args: [calls.map((c) => ({ target: c.to, value: 0n, data: c.data }))] })

type Row = { round: number; rail: string; hash: Hex; gasUsed: bigint; signatures: string; note: string }
const rows: Row[] = []

// ---- frames rails, through the wallet and the dapp API ----
const pm = paymasterInstance(funderKey)
const exists = async (a: Address) => (await client.getTransactionCount({ address: a })) > 0 || (await client.getBalance({ address: a })) > 0n
const service = await startPaymasterService({ paymaster: pm.address, signerKey: pm.signerKey, chainId, policies: { 'toy-dex': { name: 'toy-dex', targets: [TOKEN_A, TOY_DEX], maxCost: E(0.01) } }, senderExists: exists })
async function viaWallet(u: { key: Hex; address: Address }, round: number, rail: string, sponsored: boolean) {
  const w = framesWallet({ client, key: u.key, chainId })
  const dapp = createWalletClient({ account: u.address, chain: hegotaTestnet, transport: custom(w) })
  const { id } = await dapp.sendCalls({ calls: [...calls], forceAtomic: true, ...(sponsored ? { capabilities: { paymasterService: { url: service.url, context: { policyId: 'toy-dex' } } } } : {}) })
  const st = await dapp.waitForCallsStatus({ id, timeout: 120_000 })
  const b = w.batches.get(id)!
  const sigs = b.trace.filter((t) => t.startsWith('user signs')).length
  const pmCalls = b.trace.filter((t) => t.startsWith('pm_')).length
  rows.push({
    round,
    rail,
    hash: b.hash,
    gasUsed: st.receipts![0].gasUsed,
    signatures: `user ${sigs} (one for estimation)${sponsored ? `; paymaster ${pmCalls - 1} + 1 stub` : ''}`,
    note: `status ${st.statusCode}`,
  })
}

// ---- type 2 through the delegate ----
async function type2(round: number) {
  const w = wallet(users.t2.key)
  const hash = await w.sendTransaction({ to: users.t2.address, data: executeBatch, gas: 400_000n, ...fees })
  const r = await client.waitForTransactionReceipt({ hash })
  rows.push({ round, rail: 'type 2, EOA delegated to Simple7702Account, executeBatch', hash, gasUsed: r.gasUsed, signatures: 'user 1', note: `status ${r.status}` })
}

// ---- ERC-4337 through the delegate ----
const packed = (hi: bigint, lo: bigint) => pad(toHex((hi << 128n) | lo), { size: 32 })
async function handleOps(round: number) {
  const sender = users.erc4337.address
  const nonce = (await client.readContract({ address: entryPoint, abi: ep.abi, functionName: 'getNonce', args: [sender, 0n] })) as bigint
  const op = {
    sender,
    nonce,
    initCode: '0x' as Hex,
    callData: executeBatch,
    accountGasLimits: packed(150_000n, 250_000n),
    preVerificationGas: 50_000n,
    gasFees: packed(fees.maxPriorityFeePerGas, fees.maxFeePerGas),
    paymasterAndData: '0x' as Hex,
    signature: '0x' as Hex,
  }
  const opHash = (await client.readContract({ address: entryPoint, abi: ep.abi, functionName: 'getUserOpHash', args: [op] })) as Hex
  op.signature = serializeSignature(await sign({ hash: opHash, privateKey: users.erc4337.key }))
  const data = encodeFunctionData({ abi: ep.abi, functionName: 'handleOps', args: [[op], bundler.address] })
  const hash = await wallet(bundler.key).sendTransaction({ to: entryPoint, data, gas: 600_000n, ...fees })
  const r = await client.waitForTransactionReceipt({ hash })
  let note = `status ${r.status}`
  for (const log of r.logs) {
    try {
      const ev = decodeEventLog({ abi: ep.abi, data: log.data, topics: log.topics }) as unknown as { eventName: string; args: { success: boolean; actualGasUsed: bigint } }
      if (ev.eventName === 'UserOperationEvent') note = `op success ${ev.args.success}, EntryPoint's actualGasUsed ${ev.args.actualGasUsed}`
    } catch {}
  }
  rows.push({ round, rail: 'ERC-4337 v0.8, EOA delegated to Simple7702Account, executeBatch', hash, gasUsed: r.gasUsed, signatures: 'user 1 (userOp); bundler 1 (its own tx)', note })
}

for (const round of [1, 2]) {
  await viaWallet(users.framesSelf, round, 'frames, default code, self-paid', false)
  await viaWallet(users.framesSponsored, round, 'frames, default code, canonical paymaster', true)
  await type2(round)
  await handleOps(round)
}
service.server.close()

const balB = async (a: Address) => (await client.readContract({ address: TOKEN_B, abi: token.abi, functionName: 'balanceOf', args: [a] } as never)) as bigint
for (const [k, u] of Object.entries(users)) console.log(`${k}: Token B ${await balB(u.address)}`)
console.log('\n| Round | Rail | Tx | `gasUsed` | Signatures | Detail |\n|---|---|---|---|---|---|')
for (const r of rows) console.log(`| ${r.round} | ${r.rail} | [\`${r.hash.slice(0, 10)}...\`](https://dora.privacy.ethrex.xyz/tx/${r.hash}) | ${r.gasUsed} | ${r.signatures} | ${r.note} |`)
process.exit(0)
