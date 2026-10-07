// Experiment 19: the validation-prefix trace rules, one probe per transaction. ProbeAccount's
// VERIFY frame does the probed thing and then approves; each transaction is simulated with
// ethrex_simulateFrameTransaction and then offered to eth_sendRawTransaction, and the two
// verdicts are compared with what the EIP says.
//
// usage: npx tsx experiments/19-mempool-rules/probes.ts [id ...]   (no ids: every probe)
import { type Address, type Hex, concatHex, createWalletClient, http, keccak256, numberToHex, pad, parseEther, toHex } from 'viem'
import { privateKeyToAccount, privateKeyToAddress } from 'viem/accounts'
import { compileYul } from '../../src/contracts.js'
import { create2Address, deployFrame, saltOf, sendFrames } from '../../src/deploy.js'
import { loadKey } from '../../src/env.js'
import {
  Approve,
  type Frame,
  HEGOTA_RPC_URL,
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
} from '../../src/frametx/index.js'

const { privateKey } = loadKey()
const client = makeClient()
const derive = (label: string) => {
  const key = keccak256(concatHex([privateKey, toHex(`exp-frames/19/${label}`)]))
  return { key, address: privateKeyToAddress(key) }
}
const owner = derive('owner')
const nobody = derive('nobody').address // never used: no code, no balance, no nonce
const DANA: Address = '0xbc263E783572AaD9C0ADAcE6bD65365727076b45' // experiment 15's EOA: a balance and a nonce, no code now
const delegated = derive('delegated') // delegated below to the Helper with a type-4 the funder sends

const helper = (() => {
  const initcode = compileYul('experiments/19-mempool-rules/Helper.yul')
  const salt = saltOf('exp-frames/19/helper/v1')
  return { address: create2Address(initcode, salt), deploy: deployFrame(initcode, salt).frame }
})()
const account = (() => {
  const initcode = concatHex([compileYul('experiments/19-mempool-rules/ProbeAccount.yul'), pad(owner.address)])
  const salt = saltOf('exp-frames/19/probe-account/v2')
  return { address: create2Address(initcode, salt), deploy: deployFrame(initcode, salt).frame }
})()
console.log(`owner ${owner.address}; ProbeAccount ${account.address}; Helper ${helper.address}; no-code address ${nobody}`)

{
  const frames: Frame[] = []
  for (const c of [helper, account]) if (!(await client.getCode({ address: c.address }))) frames.push(c.deploy)
  if ((await client.getBalance({ address: account.address })) < parseEther('0.01')) frames.push(senderFrame({ target: account.address, value: parseEther('0.02'), execution: 30_000n }))
  if (frames.length) await sendFrames(client, privateKey, frames, { label: 'setup: deploy the Helper and the ProbeAccount, fund the account' })
}
if (!((await client.getCode({ address: delegated.address })) ?? '0x').startsWith('0xef0100')) {
  const wallet = createWalletClient({ account: privateKeyToAccount(privateKey), chain: hegotaTestnet, transport: http(HEGOTA_RPC_URL) })
  const authorization = await wallet.signAuthorization({ account: privateKeyToAccount(delegated.key), contractAddress: helper.address })
  // The first attempt used a fixed 100,000 gas and failed (status 0, all gas used): the
  // authority is a fresh account, and creating it costs more than that here. Estimate, and pad.
  const gas = ((await client.estimateGas({ account: wallet.account, authorizationList: [authorization], to: delegated.address, data: '0x' })) * 6n) / 5n
  const hash = await wallet.sendTransaction({ authorizationList: [authorization], to: delegated.address, data: '0x', gas })
  const r = await client.waitForTransactionReceipt({ hash })
  console.log(`delegated ${delegated.address} to the Helper: ${hash} status ${r.status} gasUsed ${r.gasUsed} (limit ${gas})`)
  if (r.status !== 'success') throw new Error('delegation failed')
}
for (const [name, address] of [['dana', DANA], ['delegated', delegated.address], ['nobody', nobody]] as const) {
  const [code, nonce, balance] = await Promise.all([client.getCode({ address }), client.getTransactionCount({ address }), client.getBalance({ address })])
  console.log(`${name} ${address}: code ${code ?? '0x'}, nonce ${nonce}, balance ${balance}`)
}
const head = (await client.getBlock({ blockTag: 'latest' })).timestamp

type Probe = [id: number, what: string, eip: 'allowed' | 'banned' | 'reverts', arg?: Hex]
const probes: Probe[] = [
  [0, 'nothing (baseline)', 'allowed'],
  [1, 'GASPRICE', 'banned'],
  [2, 'BLOCKHASH', 'banned'],
  [3, 'COINBASE', 'banned'],
  [4, 'TIMESTAMP', 'banned'],
  [5, 'NUMBER', 'banned'],
  [6, 'PREVRANDAO', 'banned'],
  [7, 'GASLIMIT', 'banned'],
  [8, 'BASEFEE', 'banned'],
  [9, 'BLOBBASEFEE', 'banned'],
  [10, 'SLOTNUM (0x4B)', 'banned'],
  [11, 'GAS, then POP', 'banned'],
  [12, 'GAS, then STATICCALL to a precompile', 'allowed'],
  [13, 'BALANCE of the sender', 'banned'],
  [14, 'SELFBALANCE', 'banned'],
  [15, 'SLOAD of the sender', 'allowed'],
  [16, 'STATICCALL to a contract that SLOADs its own storage', 'banned', helper.address],
  [17, 'STATICCALL to a contract that reads no storage', 'allowed', helper.address],
  [18, 'DELEGATECALL to a contract that SLOADs (the sender\'s storage)', 'allowed', helper.address],
  [19, 'STATICCALL to an address with no code', 'banned', nobody],
  [20, 'EXTCODESIZE of an address with no code', 'banned', nobody],
  [21, 'EXTCODEHASH of a contract', 'allowed', helper.address],
  [22, 'STATICCALL to an EIP-7702-delegated EOA', 'banned', delegated.address],
  [19, 'STATICCALL to an EOA with a balance and a nonce, no code', 'banned', DANA],
  [23, 'INVALID', 'banned'],
  [24, 'TLOAD (not in the list)', 'allowed'],
  [25, 'ORIGIN (not in the list)', 'allowed'],
  [26, 'TXPARAM(0x0D), the legacy nonce', 'allowed'],
  [27, 'CREATE (a VERIFY frame is static)', 'reverts'],
  [28, 'EXTCODESIZE of a precompile', 'allowed'],
  [29, 'STATICCALL to the expiry verifier (TIMESTAMP inside it)', 'banned'],
  [30, '"not before" a minute ago: require the expiry verifier to refuse it', 'banned', numberToHex(head - 60n, { size: 8 })],
  [30, '"not before" two minutes from now', 'banned', numberToHex(head + 120n, { size: 8 })],
]

const short = (e: unknown) => {
  const lines = (e as Error).message.split('\n')
  return (lines.find((l) => l.startsWith('Details:')) ?? lines[0]).replace('Details: ', '').replace('Invalid params: ', '')
}

const only = process.argv.slice(2).map(Number)
console.log('\n| # | VERIFY does | EIP | simulation | eth_sendRawTransaction | mined |\n|---|---|---|---|---|---|')
for (const [id, what, eip, arg] of probes) {
  if (only.length && !only.includes(id)) continue
  const data: Hex = concatHex([numberToHex(id, { size: 1 }), ...(arg ? [arg] : [])])
  let tx = await prepareFrameTx(client, {
    sender: account.address,
    frames: [verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 60_000n, data }), senderFrame({ target: account.address, execution: 5_000n })],
    signatures: [secp256k1Placeholder(owner.address)],
  })
  tx = await signAll(tx, [owner.key])
  const sim = await simulateFrameTx(client, tx).catch((e) => ({ valid: false, violation: short(e) }))
  const simText = sim.valid ? 'valid' : `invalid: ${sim.violation}`
  let sent = ''
  let mined = ''
  try {
    const hash = await sendFrameTx(client, tx)
    sent = 'accepted'
    const r = await waitForFrameTxReceipt(client, hash, { timeoutMs: 60_000 }).catch(() => null)
    mined = r ? `block ${BigInt(r.blockNumber)} (\`${hash.slice(0, 10)}…\`)` : 'no receipt'
  } catch (e) {
    sent = `refused: ${short(e)}`
  }
  console.log(`| ${id} | ${what} | ${eip} | ${simText} | ${sent} | ${mined} |`)
}

// The second "not before" again, once its time has come: the same VERIFY code, now valid.
if (!only.length || only.includes(30)) {
  const notBefore = head + 120n
  while ((await client.getBlock({ blockTag: 'latest' })).timestamp <= notBefore) await new Promise((r) => setTimeout(r, 3000))
  let tx = await prepareFrameTx(client, {
    sender: account.address,
    frames: [verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 60_000n, data: concatHex(['0x1e', numberToHex(notBefore, { size: 8 })]) }), senderFrame({ target: account.address, execution: 5_000n })],
    signatures: [secp256k1Placeholder(owner.address)],
  })
  tx = await signAll(tx, [owner.key])
  const sim = await simulateFrameTx(client, tx)
  const hash = await sendFrameTx(client, tx)
  const r = await waitForFrameTxReceipt(client, hash)
  console.log(`\n"not before ${notBefore}" after that time: simulation ${sim.valid ? 'valid' : sim.violation}; mined in block ${BigInt(r.blockNumber)} at ${(await client.getBlock({ blockNumber: BigInt(r.blockNumber) })).timestamp} (${hash})`)
}
