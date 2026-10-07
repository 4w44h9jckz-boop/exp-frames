// Experiment 21: the same ERC-20 transfer through ERC-4337 v0.8 and through frames, on one chain,
// one token, one recipient, one basefee.
//
//   setup  deploy the EntryPoint, SimpleAccountFactory, Simple7702Account (EntryPoint address
//          patched to ours), the test token and nothing else; fund and mint
//   rows   an ordinary type-2 transfer; a frame transaction from a plain EOA; a frame account,
//          created and then existing; an ERC-4337 SimpleAccount, created and then existing; an
//          EIP-7702 EOA through Simple7702Account
//
// usage: npx tsx experiments/21-erc4337-side-by-side/side-by-side.ts [rounds=2]
import {
  type Abi,
  type Address,
  type Hex,
  concatHex,
  createWalletClient,
  decodeEventLog,
  encodeAbiParameters,
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
import { compileSolidity, compileYul } from '../../src/contracts.js'
import { create2Address, deployFrame, saltOf, sendFrames } from '../../src/deploy.js'
import { loadKey } from '../../src/env.js'
import {
  Approve,
  type Frame,
  HEGOTA_RPC_URL,
  Mode,
  NEW_ACCOUNT_STATE_GAS,
  STORAGE_SET_STATE_GAS,
  type FrameTx,
  hegotaTestnet,
  makeClient,
  prepareFrameTx,
  secp256k1Placeholder,
  sendFrameTx,
  senderFrame,
  signAll,
  simulateFrameTx,
  verifyFrame,
  waitForFrameTxReceipt,
  getFrameTxReceipt,
} from '../../src/frametx/index.js'
import { CANONICAL_ENTRY_POINT, artifact } from './artifacts.js'

const rounds = Number(process.argv[2] ?? 2)
const client = makeClient()
const { privateKey: funderKey } = loadKey()
const k1 = (label: string) => {
  const key = keccak256(concatHex([funderKey, toHex(`exp-frames/21/${label}`)]))
  return { key, address: privateKeyToAddress(key) }
}
const owner = k1('owner') // owns the FrameAccount and the ERC-4337 SimpleAccount
const bundler = k1('bundler') // submits handleOps, and is its beneficiary
const eoaPlain = k1('eoa-plain') // ordinary type-2 transfers
const eoaFrames = k1('eoa-frames') // frame transactions with the default code
const eoa7702 = k1('eoa-7702') // delegated to Simple7702Account
const recipient = k1('recipient').address
const E = (n: number) => parseEther(String(n))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---- contracts ----
const ep = await artifact('EntryPoint')
const factoryArt = await artifact('SimpleAccountFactory')
const simpleAccountArt = await artifact('SimpleAccount')
const s7702Art = await artifact('Simple7702Account')
const tokenArt = compileSolidity('contracts/TestToken.sol', 'TestToken')

const at = (label: string, initcode: Hex, extraState = 0n) => {
  const salt = saltOf(`exp-frames/21/${label}`)
  return { address: create2Address(initcode, salt), deploy: deployFrame(initcode, salt, extraState).frame }
}
const entryPoint = at('entry-point/v0.8', ep.bytecode, 1_000_000n) // the constructor creates SenderCreator
const factory = at('simple-account-factory/v0.8', concatHex([factoryArt.bytecode, pad(entryPoint.address)]), 2_000_000n) // and the implementation
const patched = s7702Art.bytecode.replaceAll(CANONICAL_ENTRY_POINT.slice(2).toLowerCase(), entryPoint.address.slice(2).toLowerCase()) as Hex
if (patched === s7702Art.bytecode) throw new Error('Simple7702Account: the EntryPoint constant was not found')
const s7702 = at('simple-7702-account/v0.8-patched', patched)
const token = at('token/v1', concatHex([tokenArt.bytecode, encodeAbiParameters([{ type: 'string' }, { type: 'string' }], ['Test', 'TST'])]), 2n * STORAGE_SET_STATE_GAS)
const frameAccountInit = concatHex([compileYul('experiments/21-erc4337-side-by-side/FrameAccount.yul'), pad(owner.address)])
const frameAccount = (() => {
  const salt = saltOf('exp-frames/21/frame-account/v1')
  const { frame } = deployFrame(frameAccountInit, salt)
  return { address: create2Address(frameAccountInit, salt), deploy: { ...frame, mode: Mode.DEFAULT, limits: { execution: 80_000n, state: frame.limits.state } } as Frame }
})()
const ACCOUNT_SALT = 0n
const simpleAccount = (await client.readContract({ address: factory.address, abi: factoryArt.abi, functionName: 'getAddress', args: [owner.address, ACCOUNT_SALT] }).catch(() => null)) as Address | null

console.log(`EntryPoint ${entryPoint.address}, factory ${factory.address}, Simple7702Account ${s7702.address}, token ${token.address}`)
console.log(`frame account ${frameAccount.address}, SimpleAccount ${simpleAccount}, owner ${owner.address}`)
console.log(`bundler ${bundler.address}, plain EOA ${eoaPlain.address}, frames EOA ${eoaFrames.address}, 7702 EOA ${eoa7702.address}, recipient ${recipient}`)

{
  const missing: Frame[] = []
  for (const c of [entryPoint, factory, s7702, token]) if (!(await client.getCode({ address: c.address }))) missing.push(c.deploy)
  if (missing.length) {
    await sendFrames(client, funderKey, missing, { label: 'setup: deploy the EntryPoint, the factory, Simple7702Account, the token' })
    process.exit(0) // the factory's getAddress is needed below: run again
  }
}
if (!simpleAccount) throw new Error('factory not deployed')
const tokenAbi = tokenArt.abi
const balanceOf = (a: Address) => client.readContract({ address: token.address, abi: tokenAbi, functionName: 'balanceOf', args: [a] }) as Promise<bigint>
{
  const frames: Frame[] = []
  const eth: [Address, number][] = [
    [bundler.address, 0.03],
    [eoaPlain.address, 0.01],
    [eoaFrames.address, 0.01],
    [eoa7702.address, 0.02],
    [frameAccount.address, 0.01],
    [simpleAccount, 0.02],
  ]
  for (const [a, v] of eth) if ((await client.getBalance({ address: a })) < E(v / 2)) frames.push(senderFrame({ target: a, value: E(v), execution: 30_000n, state: NEW_ACCOUNT_STATE_GAS }))
  for (const a of [eoaPlain.address, eoaFrames.address, eoa7702.address, frameAccount.address, simpleAccount, recipient]) {
    if ((await balanceOf(a)) === 0n) frames.push(senderFrame({ target: token.address, data: encodeFunctionData({ abi: tokenAbi, functionName: 'mint', args: [a, E(1000)] }), execution: 60_000n, state: 2n * STORAGE_SET_STATE_GAS }))
  }
  if (frames.length) await sendFrames(client, funderKey, frames, { label: 'setup: fund and mint' })
}
const wallet = (key: Hex) => createWalletClient({ account: privateKeyToAccount(key), chain: hegotaTestnet, transport: http(HEGOTA_RPC_URL) })
const fees = { maxFeePerGas: parseGwei('2'), maxPriorityFeePerGas: parseGwei('1') }

// The 7702 EOA delegates to Simple7702Account once, with a type-4 the EOA sends itself.
if (!((await client.getCode({ address: eoa7702.address })) ?? '').toLowerCase().startsWith(`0xef0100${s7702.address.slice(2).toLowerCase()}`)) {
  const w = wallet(eoa7702.key)
  const authorization = await w.signAuthorization({ contractAddress: s7702.address, executor: 'self' })
  // A fixed limit: see handleOps below for why there is no estimate.
  const hash = await w.sendTransaction({ authorizationList: [authorization], to: eoa7702.address, data: '0x', gas: 200_000n, ...fees })
  const r = await client.waitForTransactionReceipt({ hash })
  console.log(`\n7702 delegation (type 4, self-sent): ${hash} status ${r.status} gasUsed ${r.gasUsed}`)
}

const transferData = encodeFunctionData({ abi: tokenAbi, functionName: 'transfer', args: [recipient, E(1)] })
type Row = { round: number; rail: string; what: string; hash: Hex; gasUsed: bigint; note: string }
const rows: Row[] = []
const settle = async (blockNumber: bigint) => {
  while ((await client.getBlockNumber()) <= blockNumber) await sleep(1000)
}

// ---- frames ----
async function frameTx(tx: FrameTx, keys: Hex[], round: number, what: string) {
  tx = await signAll(tx, keys)
  const sim = await simulateFrameTx(client, tx)
  if (!sim.valid) throw new Error(`${what}: ${sim.violation}`)
  const hash = await sendFrameTx(client, tx)
  const first = await waitForFrameTxReceipt(client, hash)
  await settle(BigInt(first.blockNumber))
  const r = (await getFrameTxReceipt(client, hash))!
  const frames = r.frameReceipts.map((f) => `${BigInt(f.gasUsed)}${BigInt(f.stateGasUsed) ? `+${BigInt(f.stateGasUsed)}s` : ''}${Number(f.status) === 1 ? '' : ' FAIL'}`).join(' · ')
  rows.push({ round, rail: 'frames', what, hash, gasUsed: BigInt(r.gasUsed), note: frames })
}

// ---- ERC-4337 ----
type UserOp = {
  sender: Address
  nonce: bigint
  initCode: Hex
  callData: Hex
  accountGasLimits: Hex
  preVerificationGas: bigint
  gasFees: Hex
  paymasterAndData: Hex
  signature: Hex
}
const packed = (hi: bigint, lo: bigint) => pad(toHex((hi << 128n) | lo), { size: 32 })
async function userOp(round: number, what: string, sender: Address, signer: Hex, initCode: Hex, callData: Hex, verificationGasLimit: bigint) {
  const nonce = (await client.readContract({ address: entryPoint.address, abi: ep.abi, functionName: 'getNonce', args: [sender, 0n] })) as bigint
  const op: UserOp = {
    sender,
    nonce,
    initCode,
    callData,
    accountGasLimits: packed(verificationGasLimit, 120_000n),
    preVerificationGas: 50_000n,
    gasFees: packed(fees.maxPriorityFeePerGas, fees.maxFeePerGas),
    paymasterAndData: '0x',
    signature: '0x',
  }
  const hash = (await client.readContract({ address: entryPoint.address, abi: ep.abi, functionName: 'getUserOpHash', args: [op] })) as Hex
  op.signature = serializeSignature(await sign({ hash, privateKey: signer }))
  const w = wallet(bundler.key)
  const data = encodeFunctionData({ abi: ep.abi, functionName: 'handleOps', args: [[op], bundler.address] })
  // eth_estimateGas refuses here ("Insufficient account funds": the node checks the balance
  // against the block gas limit times the fee), so the limit is a generous constant.
  const gas = initCode === '0x' ? 500_000n : 3_000_000n
  const txHash = await w.sendTransaction({ to: entryPoint.address, data, gas, ...fees })
  const r = await client.waitForTransactionReceipt({ hash: txHash })
  await settle(r.blockNumber)
  let note = `status ${r.status}`
  for (const log of r.logs) {
    try {
      const ev = decodeEventLog({ abi: ep.abi as Abi, data: log.data, topics: log.topics }) as unknown as { eventName: string; args: Record<string, unknown> }
      if (ev.eventName === 'UserOperationEvent') note = `op success ${ev.args.success}, EntryPoint's actualGasUsed ${ev.args.actualGasUsed}, calldata ${(data.length - 2) / 2} B`
    } catch {}
  }
  rows.push({ round, rail: 'ERC-4337', what, hash: txHash, gasUsed: r.gasUsed, note })
}
const execute = (target: Address, data: Hex) => encodeFunctionData({ abi: simpleAccountArt.abi, functionName: 'execute', args: [target, 0n, data] })

// ---- the rows ----
for (let round = 1; round <= rounds; round++) {
  // An ordinary EIP-1559 transaction: the floor every account abstraction is compared with.
  {
    const w = wallet(eoaPlain.key)
    const hash = await w.sendTransaction({ to: token.address, data: transferData, gas: 100_000n, ...fees })
    const r = await client.waitForTransactionReceipt({ hash })
    await settle(r.blockNumber)
    rows.push({ round, rail: 'type 2', what: 'plain EOA, no account abstraction', hash, gasUsed: r.gasUsed, note: `status ${r.status}` })
  }
  // Frames, the default code: a plain EOA.
  await frameTx(
    await prepareFrameTx(client, {
      sender: eoaFrames.address,
      frames: [verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 20_000n }), senderFrame({ target: token.address, data: transferData, execution: 60_000n })],
      signatures: [secp256k1Placeholder()],
    }),
    [eoaFrames.key],
    round,
    'plain EOA, default code',
  )
  // Frames, a smart account: created in round 1 (deploy frame first), existing afterwards.
  {
    const created = !!(await client.getCode({ address: frameAccount.address }))
    const frames: Frame[] = [
      ...(created ? [] : [frameAccount.deploy]),
      verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 10_000n }),
      senderFrame({ target: token.address, data: transferData, execution: 60_000n }),
    ]
    await frameTx(
      await prepareFrameTx(client, { sender: frameAccount.address, frames, signatures: [secp256k1Placeholder(owner.address)] }),
      [owner.key],
      round,
      created ? 'FrameAccount (experiment 02)' : 'FrameAccount (experiment 02), created in the same transaction',
    )
  }
  // ERC-4337 SimpleAccount: created by initCode in round 1, existing afterwards.
  {
    const created = !!(await client.getCode({ address: simpleAccount }))
    const initCode = created
      ? '0x'
      : concatHex([factory.address, encodeFunctionData({ abi: factoryArt.abi, functionName: 'createAccount', args: [owner.address, ACCOUNT_SALT] })])
    await userOp(round, created ? 'SimpleAccount' : 'SimpleAccount, created by initCode', simpleAccount, owner.key, initCode, execute(token.address, transferData), created ? 150_000n : 1_500_000n)
  }
  // ERC-4337 through an EIP-7702 EOA.
  await userOp(round, 'EOA delegated to Simple7702Account', eoa7702.address, eoa7702.key, '0x', execute(token.address, transferData), 150_000n)
}

console.log('\n| Round | Rail | Sender | Tx | `gasUsed` | Detail |\n|---|---|---|---|---|---|')
for (const r of rows) console.log(`| ${r.round} | ${r.rail} | ${r.what} | [\`${r.hash.slice(0, 10)}…\`](https://dora.privacy.ethrex.xyz/tx/${r.hash}) | ${r.gasUsed} | ${r.note} |`)
