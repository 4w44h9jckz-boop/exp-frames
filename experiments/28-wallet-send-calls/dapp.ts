// Experiment 28: a dapp written against EIP-5792 with viem's stock wallet actions, talking to a
// wallet that turns each batch into one frame transaction (`wallet.ts`), with an ERC-7677-shaped
// paymaster service bound to frames (`paymaster.ts`).
//
//   A  wallet_getCapabilities
//   B  approve + swap, atomic, self-paid
//   C  approve + swap, atomic, sponsored through paymasterService, by an EOA that holds no ETH
//   D  three independent calls, the middle one fails
//   E  approve + swap, atomic, the swap fails
//   F  sponsored, with a call outside the paymaster's policy
//   G  a non-optional capability the wallet does not have
//   H  a call with no `to`
//
// usage: npx tsx experiments/28-wallet-send-calls/dapp.ts
import { type Address, type Hex, concatHex, createWalletClient, custom, encodeFunctionData, keccak256, parseEther, toHex } from 'viem'
import { privateKeyToAddress } from 'viem/accounts'
import { sendFrames } from '../../src/deploy.js'
import { loadKey } from '../../src/env.js'
import { type Frame, NEW_ACCOUNT_STATE_GAS, STORAGE_SET_STATE_GAS, hegotaTestnet, makeClient, senderFrame } from '../../src/frametx/index.js'
import { TOKEN_A, TOKEN_B, TOY_DEX, dex, token } from '../03-atomic-batch/setup.js'
import { paymasterInstance, startPaymasterService } from './paymaster.js'
import { framesWallet } from './wallet.js'

const client = makeClient()
const chainId = BigInt(await client.getChainId())
const { privateKey: funderKey } = loadKey()
const derive = (label: string) => {
  const key = keccak256(concatHex([funderKey, toHex(`exp-frames/28/${label}`)]))
  return { key, address: privateKeyToAddress(key) }
}
const alice = derive('alice') // holds ETH, pays for herself
const bob = derive('bob') // holds Token A and no ETH
const pm = paymasterInstance(funderKey)
const E = (n: number) => parseEther(String(n))
const read = (address: Address, abi: typeof token.abi, functionName: string, args: unknown[]) =>
  client.readContract({ address, abi, functionName, args } as Parameters<typeof client.readContract>[0]) as Promise<bigint>

console.log(`chain ${chainId}; alice ${alice.address}; bob ${bob.address}; paymaster ${pm.address} (signer ${pm.signer})`)

// ---- setup: the paymaster instance, its deposit, alice's ETH, both users' Token A, the DEX's Token B ----
{
  const frames: Frame[] = []
  if (!(await client.getCode({ address: pm.address }))) frames.push(pm.deploy)
  const topUp = async (a: Address, want: bigint) => {
    const has = await client.getBalance({ address: a })
    if (has < want / 2n) frames.push(senderFrame({ target: a, value: want - has, execution: 30_000n, state: has === 0n ? NEW_ACCOUNT_STATE_GAS : 0n }))
  }
  await topUp(pm.address, E(0.2))
  await topUp(alice.address, E(0.05))
  const mint = (t: Address, to: Address, amount: bigint) =>
    frames.push(senderFrame({ target: t, data: encodeFunctionData({ abi: token.abi, functionName: 'mint', args: [to, amount] }), execution: 80_000n, state: 2n * STORAGE_SET_STATE_GAS }))
  for (const u of [alice.address, bob.address]) if ((await read(TOKEN_A, token.abi, 'balanceOf', [u])) < E(10)) mint(TOKEN_A, u, E(100))
  if ((await read(TOKEN_B, token.abi, 'balanceOf', [TOY_DEX])) < E(100)) mint(TOKEN_B, TOY_DEX, E(1000))
  if (frames.length) await sendFrames(client, funderKey, frames, { label: 'setup: paymaster, deposits, tokens' })
}

const exists = async (a: Address) => (await client.getTransactionCount({ address: a })) > 0 || (await client.getBalance({ address: a })) > 0n
const service = await startPaymasterService({
  paymaster: pm.address,
  signerKey: pm.signerKey,
  chainId,
  policies: { 'toy-dex': { name: 'toy-dex', targets: [TOKEN_A, TOY_DEX], maxCost: E(0.01) } },
  senderExists: exists,
  log: console.log,
})
const paymasterService = { url: service.url, context: { policyId: 'toy-dex' } }

const walletOf = (u: { key: Hex; address: Address }) => {
  const w = framesWallet({ client, key: u.key, chainId, log: console.log })
  return { w, dapp: createWalletClient({ account: u.address, chain: hegotaTestnet, transport: custom(w) }) }
}
const A = walletOf(alice)
const B = walletOf(bob)

const approve = (amount: bigint) => ({ to: TOKEN_A, abi: token.abi, functionName: 'approve', args: [TOY_DEX, amount] }) as const
const swap = (amountIn: bigint, minOut: bigint) => ({ to: TOY_DEX, abi: dex.abi, functionName: 'swap', args: [amountIn, minOut] }) as const
const allowance = (u: Address) => read(TOKEN_A, token.abi, 'allowance', [u, TOY_DEX])

type Row = { case: string; status: string; hash?: Hex; gasUsed?: bigint; frames?: string; payer?: Address; trace?: string; maxCost?: string; note: string }
const rows: Row[] = []

async function run(label: string, who: ReturnType<typeof walletOf>, params: Parameters<typeof who.dapp.sendCalls>[0], note: (r: Row) => Promise<string> = async () => '') {
  console.log(`\n=== ${label} ===`)
  let id: string
  try {
    ;({ id } = await who.dapp.sendCalls(params as never))
  } catch (e) {
    // viem wraps the provider's error; the EIP-5792 code is on the innermost RPC error.
    type Err = { name?: string; code?: number; shortMessage?: string; details?: string; message: string; cause?: Err }
    let err = e as Err
    while (err.code === undefined && err.cause) err = err.cause
    const line = `${err.name}${err.code !== undefined ? ` (${err.code})` : ''}: ${err.details ?? err.shortMessage ?? err.message.split('\n')[0]}`
    console.log(`  dapp sees ${line}`)
    rows.push({ case: label, status: 'error', note: line })
    return
  }
  const st = await who.dapp.waitForCallsStatus({ id, timeout: 120_000 })
  const b = who.w.batches.get(id)!
  const caps = (st as { capabilities?: { frames?: { payer: Address; frameStatuses: number[] } } }).capabilities?.frames
  const row: Row = {
    case: label,
    status: `${st.statusCode} (${st.status})`,
    hash: b.hash,
    gasUsed: st.receipts?.[0]?.gasUsed,
    frames: caps?.frameStatuses.join(','),
    payer: caps?.payer,
    trace: b.trace.join(' -> '),
    maxCost: `${b.estimate.draftMaxCost} -> ${b.estimate.finalMaxCost}`,
    note: '',
  }
  row.note = await note(row)
  console.log(`  status ${row.status}, atomic ${st.atomic}, receipts ${st.receipts?.length}, logs ${st.receipts?.[0]?.logs.length}, frame statuses [${row.frames}], payer ${row.payer}, gasUsed ${row.gasUsed}`)
  console.log(`  round trips: ${row.trace}`)
  console.log(`  max cost draft -> final: ${row.maxCost}`)
  if (row.note) console.log(`  ${row.note}`)
  rows.push(row)
}

// A
console.log('\n=== A. wallet_getCapabilities ===')
const caps = await A.dapp.getCapabilities()
console.log(JSON.stringify(caps, (_, v) => (typeof v === 'bigint' ? v.toString() : v)))
rows.push({ case: 'A. capabilities', status: '', note: JSON.stringify(caps) })

const amt = E(1)
// B
await run('B. approve + swap, atomic, self-paid', A, { calls: [approve(amt), swap(amt, amt)], forceAtomic: true })
// C
await run('C. approve + swap, atomic, sponsored, sender holds no ETH', B, { calls: [approve(amt), swap(amt, amt)], forceAtomic: true, capabilities: { paymasterService } }, async () => `bob's ETH balance ${await client.getBalance({ address: bob.address })}`)
// D
await run('D. three independent calls, the middle one fails', A, { calls: [approve(amt), swap(2n * amt, 2n * amt), approve(0n)] }, async () => `allowance after: ${await allowance(alice.address)} (the third call ran after the second failed)`)
// E
await run('E. approve + swap, atomic, the swap fails (slippage)', A, { calls: [approve(amt), swap(amt, amt + 1n)], forceAtomic: true }, async () => `allowance after: ${await allowance(alice.address)} (frame 1, the approve, reported SUCCESS and was rolled back)`)
// F
await run('F. sponsored, a call outside the policy', B, { calls: [approve(amt), { to: TOKEN_B, abi: token.abi, functionName: 'transfer', args: [alice.address, 1n] }], forceAtomic: true, capabilities: { paymasterService } })
// G
await run('G. a non-optional capability the wallet lacks', A, { calls: [approve(0n)], capabilities: { auxiliaryFunds: { supported: true } } })
// H
await run('H. a call with no `to`', A, { calls: [{ data: '0x6000' }] })

service.server.close()
console.log(`\npaymaster service calls: ${service.calls.join(', ')}`)
console.log('\n| Case | EIP-5792 status | Tx | `gasUsed` | Frame statuses | Payer | Note |\n|---|---|---|---|---|---|---|')
for (const r of rows) {
  const tx = r.hash ? `[\`${r.hash.slice(0, 10)}...\`](https://dora.privacy.ethrex.xyz/tx/${r.hash})` : ''
  console.log(`| ${r.case} | ${r.status} | ${tx} | ${r.gasUsed ?? ''} | ${r.frames ?? ''} | ${r.payer ? `${r.payer.slice(0, 8)}...` : ''} | ${r.note} |`)
}
console.log('\n| Case | Round trips | Max cost, draft -> final (wei) |\n|---|---|---|')
for (const r of rows) if (r.trace) console.log(`| ${r.case} | ${r.trace} | ${r.maxCost} |`)
process.exit(0)
