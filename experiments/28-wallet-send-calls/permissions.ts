// Experiment 28, ERC-7715: a dapp asks kohaku-rs's Rust wallet for an execution permission, and
// redeems it with a frame transaction, under the binding the wallet's crate writes down
// (`crates/frame-wallet/src/permissions.rs`):
//   - the user's account is a SessionAccount (experiment 12) the wallet's key owns;
//   - `to` is the dapp's session key, `native-token-allowance` the session's budget, the `expiry`
//     rule its deadline, and a `call-target` rule its one target and selector;
//   - the grant is the owner's own transaction adding the session; redemption is a session
//     transaction signed by the dapp's key, built here with experiment 12's `sessionTx`.
//
//   I  wallet_getSupportedExecutionPermissions
//   J  wallet_requestExecutionPermissions: approve on Token A, 0.002 ETH, one hour
//   K  the dapp redeems it: approve(TOY_DEX, 1) from the user's account, signed by the session key
//   L  a call outside the grant (Token A's transfer) is refused in simulation
//   M  wallet_revokeExecutionPermission, then the same redemption as K is refused
//   N  viem 2.57.3's experimental grantPermissions action
//
// usage: RUST_WALLET=<kohaku-rs>/crates/target/release/frame-wallet npx tsx experiments/28-wallet-send-calls/permissions.ts
import { type Address, type Hex, encodeFunctionData, formatEther, keccak256, numberToHex, parseEther, toFunctionSelector, toHex } from 'viem'
import { createWalletClient, custom } from 'viem'
import { erc7715Actions } from 'viem/experimental'
import { sendFrames } from '../../src/deploy.js'
import { type Frame, STORAGE_SET_STATE_GAS, frameReceiptStatus, hegotaTestnet, sendFrameTx, senderFrame, simulateFrameTx, waitForFrameTxReceipt } from '../../src/frametx/index.js'
import { TOKEN_A, TOY_DEX, token } from '../03-atomic-batch/setup.js'
import { client, derive, privateKey, readSession, sessionAccount, sessionTx } from '../12-session-keys/session.js'
import { rustWallet } from './rust-wallet.js'

const bin = process.env.RUST_WALLET
if (!bin) throw new Error('RUST_WALLET names kohaku-rs\'s frame-wallet binary')
const chainId = BigInt(await client.getChainId())
const owner = derive('28/permissions-owner')
const session = derive('28/permissions-session')
const salt = keccak256(toHex('exp-frames/28/session-account'))
const account = sessionAccount(owner.address, 'exp-frames/28/session-account')
const head = async () => (await client.getBlock({ blockTag: 'latest' })).timestamp
console.log(`owner ${owner.address}; SessionAccount ${account.address}; dapp session key ${session.address}`)

// ---- setup: the funder deploys and funds the account ----
{
  const frames = []
  if (!(await client.getCode({ address: account.address }))) frames.push(account.deploy)
  const has = await client.getBalance({ address: account.address })
  if (has < parseEther('0.01')) frames.push(senderFrame({ target: account.address, value: parseEther('0.02') - has, execution: 30_000n }))
  if (frames.length) await sendFrames(client, privateKey, frames, { label: 'setup: deploy and fund the SessionAccount' })
}

const wallet = await rustWallet({ bin, key: owner.key, sessionSalt: salt, log: console.log })
if (wallet.address !== account.address) throw new Error(`the Rust wallet serves ${wallet.address}, experiment 12 computes ${account.address}`)
const rows: { case: string; result: string; tx?: Hex; gasUsed?: bigint }[] = []
const errorOf = (e: unknown) => {
  type Err = { name?: string; code?: number; message: string; details?: string; shortMessage?: string; cause?: Err }
  let err = e as Err
  while (err.code === undefined && err.cause) err = err.cause
  return `${err.name}${err.code !== undefined ? ` (${err.code})` : ''}: ${err.details ?? err.shortMessage ?? err.message.split('\n')[0]}`
}

// I
const supported = await wallet.request({ method: 'wallet_getSupportedExecutionPermissions', params: [] })
console.log(`\nI. supported: ${JSON.stringify(supported)}`)
rows.push({ case: 'I. wallet_getSupportedExecutionPermissions', result: JSON.stringify(supported) })

// J
const approveSelector = toFunctionSelector('approve(address,uint256)')
const budget = parseEther('0.002')
const request = {
  chainId: numberToHex(chainId),
  from: account.address,
  to: session.address,
  permission: { type: 'native-token-allowance', isAdjustmentAllowed: false, data: { allowance: numberToHex(budget) } },
  rules: [
    { type: 'expiry', data: { timestamp: Number((await head()) + 3600n) } },
    { type: 'call-target', data: { target: TOKEN_A, selector: approveSelector } },
  ],
}
const [granted] = (await wallet.request({ method: 'wallet_requestExecutionPermissions', params: [[request]] })) as { context: Hex; delegationManager: Address; dependencies: unknown[] }[]
const owners = () => wallet.call<{ purpose: string; hash: Hex; blockNumber: Hex; gasUsed: Hex }[]>('kohaku_getOwnerTransactions', [])
const grantTx = (await owners()).at(-1)!
const s1 = await readSession(account.address, session.address)
console.log(`J. granted: context ${granted.context}, delegationManager ${granted.delegationManager}, dependencies ${JSON.stringify(granted.dependencies)}`)
console.log(`   owner's grant ${grantTx.hash}, block ${BigInt(grantTx.blockNumber)}, gasUsed ${BigInt(grantTx.gasUsed)}`)
console.log(`   on chain: active ${s1.active}, target ${s1.target}, selector ${s1.selector}, validUntil ${s1.validUntil}, budget ${formatEther(s1.budget)} ETH`)
rows.push({ case: 'J. wallet_requestExecutionPermissions', result: `context ${granted.context}; session active ${s1.active}, selector ${s1.selector}, budget ${formatEther(s1.budget)} ETH`, tx: grantTx.hash, gasUsed: BigInt(grantTx.gasUsed) })

// K
const approveOne = encodeFunctionData({ abi: token.abi, functionName: 'approve', args: [TOY_DEX, 1n] })
// experiment 12's sessionTx gives call frames no state budget, which suits a plain transfer to an
// existing account. An approve to a spender with no allowance yet creates a slot: without its
// 97,920 state gas the call frame fails and burns its execution budget (the first run of this
// script). The amount the account checks is priced after this edit, so it covers the state too.
const withState = (frames: Frame[]) => frames.map((f, i) => (i >= 3 ? { ...f, limits: { ...f.limits, state: STORAGE_SET_STATE_GAS } } : f))
const redeem = async (data: Hex) => sessionTx(account.address, session, TOKEN_A, [{ data }], { deadline: (await head()) + 300n, edit: withState })
{
  const tx = await redeem(approveOne)
  const sim = await simulateFrameTx(client, tx)
  if (!sim.valid) throw new Error(`K: refused in simulation: ${sim.violation}`)
  const hash = await sendFrameTx(client, tx)
  const r = await waitForFrameTxReceipt(client, hash)
  const statuses = r.frameReceipts.map((f) => frameReceiptStatus(f))
  if (statuses.some((st) => st !== 1)) throw new Error(`K: a frame failed: statuses ${statuses.join(',')} in ${hash}`)
  const allowance = (await client.readContract({ address: TOKEN_A, abi: token.abi, functionName: 'allowance', args: [account.address, TOY_DEX] } as never)) as bigint
  const s2 = await readSession(account.address, session.address)
  console.log(`\nK. the dapp redeemed: ${hash}, block ${BigInt(r.blockNumber)}, gasUsed ${BigInt(r.gasUsed)}, payer ${r.payer}, frame statuses ${statuses.join(',')}; allowance now ${allowance}; spent ${formatEther(s2.spent)} of ${formatEther(s2.budget)} ETH`)
  rows.push({ case: 'K. redemption, signed by the session key', result: `frame statuses ${statuses.join(', ')}; allowance now ${allowance}; payer ${r.payer}; spent ${formatEther(s2.spent)} of ${formatEther(s2.budget)} ETH`, tx: hash, gasUsed: BigInt(r.gasUsed) })
}

// L
{
  const transfer = encodeFunctionData({ abi: token.abi, functionName: 'transfer', args: [session.address, 1n] })
  const sim = await simulateFrameTx(client, await redeem(transfer))
  console.log(`\nL. outside the grant: valid ${sim.valid}, ${sim.violation}`)
  rows.push({ case: 'L. a call outside the grant', result: `refused in simulation: ${sim.violation}` })
}

// M
{
  await wallet.request({ method: 'wallet_revokeExecutionPermission', params: [{ permissionContext: granted.context }] })
  const revokeTx = (await owners()).at(-1)!
  const left = (await wallet.request({ method: 'wallet_getGrantedExecutionPermissions', params: [] })) as unknown[]
  const s3 = await readSession(account.address, session.address)
  const sim = await simulateFrameTx(client, await redeem(approveOne))
  console.log(`\nM. revoked by ${revokeTx.hash} (gasUsed ${BigInt(revokeTx.gasUsed)}); granted now ${left.length}; on chain active ${s3.active}; the same redemption: valid ${sim.valid}, ${sim.violation}`)
  rows.push({ case: 'M. wallet_revokeExecutionPermission, then K again', result: `${left.length} granted; session active ${s3.active}; redemption refused in simulation: ${sim.violation}`, tx: revokeTx.hash, gasUsed: BigInt(revokeTx.gasUsed) })
}

// N
{
  const dapp = createWalletClient({ account: account.address, chain: hegotaTestnet, transport: custom(wallet) }).extend(erc7715Actions())
  try {
    await dapp.grantPermissions({ expiry: Number((await head()) + 3600n), permissions: [{ type: 'native-token-recurring-allowance', data: { allowance: numberToHex(budget), start: 0, period: 3600 }, policies: [] }] } as never)
    rows.push({ case: "N. viem's grantPermissions", result: 'granted' })
  } catch (e) {
    console.log(`\nN. viem's grantPermissions: ${errorOf(e)}`)
    rows.push({ case: "N. viem's grantPermissions", result: errorOf(e) })
  }
}

console.log('\n| Case | Result | Tx | `gasUsed` |\n|---|---|---|---|')
for (const r of rows) {
  const tx = r.tx ? `[\`${r.tx.slice(0, 10)}...\`](https://dora.privacy.ethrex.xyz/tx/${r.tx})` : ''
  console.log(`| ${r.case} | ${r.result} | ${tx} | ${r.gasUsed ?? ''} |`)
}
process.exit(0)
