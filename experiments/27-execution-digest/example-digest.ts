// Experiment 27, live on the Hegota testnet. Run: npx tsx experiments/27-execution-digest/example-digest.ts [setup|A|B|C|all]
//
// setup  deploy the account (owner derived from PRIVATE_KEY) and a token; fund two code-less sponsors
// A      the owner signs E with eth_signTypedData_v4 semantics; sponsor 1 sends; sponsor 2 replaces it
//        with its own pay frame and fees, reusing the owner's entry byte for byte
// B      what the account refuses, by simulation against the live chain
// C      VERIFY gas: E over three frames, over six frames, and the canonical hash when the account pays
import { type Address, type Hex, concatHex, encodeAbiParameters, encodeFunctionData, formatEther, keccak256, pad, parseEther, toHex } from 'viem'
import { privateKeyToAccount, privateKeyToAddress } from 'viem/accounts'
import { compileSolidity, compileYul } from '../../src/contracts.js'
import { deployFrame, saltOf, sendFrames } from '../../src/deploy.js'
import { loadKey } from '../../src/env.js'
import {
  Approve,
  type Frame,
  type FrameTx,
  type FrameTxReceiptJson,
  NEW_ACCOUNT_STATE_GAS,
  STORAGE_SET_STATE_GAS,
  defaultFrame,
  frameReceiptGas,
  frameReceiptStatus,
  frameSigHash,
  frameTxHash,
  getFrameTxReceipt,
  getNonceSeq,
  makeClient,
  secp256k1Placeholder,
  senderFrame,
  sendFrameTx,
  signAll,
  simulateFrameTx,
  verifyFrame,
} from '../../src/frametx/index.js'
import { executionDigest, executionTypedData } from './digest.js'

const { privateKey, address: funder } = loadKey()
const client = makeClient()

const derive = (label: string) => {
  const key = keccak256(concatHex([privateKey, toHex(`exp-frames/27/${label}`)]))
  return { key, address: privateKeyToAddress(key) }
}
const owner = derive('owner')
const sponsor1 = derive('sponsor-1')
const sponsor2 = derive('sponsor-2')

const token = compileSolidity('contracts/TestToken.sol', 'TestToken')
const TOKEN = deployFrame(
  concatHex([token.bytecode, encodeAbiParameters([{ type: 'string' }, { type: 'string' }], ['Token E', 'TKE'])]),
  saltOf('exp-frames/27/token'),
  2n * STORAGE_SET_STATE_GAS,
)
const ACCOUNT = deployFrame(concatHex([compileYul('experiments/27-execution-digest/ExecutionScopeAccount.yul'), pad(owner.address)]), saltOf('exp-frames/27/account'))

const call = (functionName: string, args: unknown[]): Hex =>
  encodeFunctionData({ abi: token.abi, functionName, args } as Parameters<typeof encodeFunctionData>[0])
const transfer = (amount: bigint) =>
  senderFrame({ target: TOKEN.address, data: call('transfer', [funder, amount]), execution: 60_000n, state: STORAGE_SET_STATE_GAS })
const onlyVerify = () => verifyFrame({ scope: Approve.EXECUTION, execution: 30_000n })
const payFrame = (payer: Address, execution = 10_000n): Frame => verifyFrame({ scope: Approve.PAYMENT, target: payer, execution })

async function fees(tip = 1_000n) {
  const block = await client.getBlock({ blockTag: 'latest' })
  const base = block.baseFeePerGas ?? 0n
  return { maxPriorityFeePerGas: tip, maxFeePerGas: base * 2n + tip, maxFeePerBlobGas: 0n }
}

/** The owner's entry, as a wallet's eth_signTypedData_v4 returns it, re-encoded as yParity ‖ r ‖ s. */
async function ownerEntry(tx: FrameTx) {
  const sig = await privateKeyToAccount(owner.key).signTypedData(executionTypedData(tx))
  const r = sig.slice(0, 66) as Hex
  const s = `0x${sig.slice(66, 130)}` as Hex
  const v = Number.parseInt(sig.slice(130, 132), 16)
  return { ...secp256k1Placeholder(owner.address, executionDigest(tx)), signature: concatHex([toHex(v - 27, { size: 1 }), r, s]) }
}

/** A sponsored transaction: the owner signs E, the sponsor signs the canonical hash over all of it. */
async function sponsored(frames: (payer: Address) => Frame[], sponsor: { key: Hex; address: Address }, f: FrameTx['fees']) {
  const nonceSeq = await getNonceSeq(client, ACCOUNT.address, [0n])
  const unsigned: FrameTx = {
    chainId: 8141n,
    nonceKeys: [0n],
    nonceSeq,
    sender: ACCOUNT.address,
    frames: frames(sponsor.address),
    signatures: [secp256k1Placeholder(owner.address, '0x'), secp256k1Placeholder(sponsor.address)],
    fees: f,
    blobVersionedHashes: [],
  }
  const entry0 = await ownerEntry(unsigned)
  return signAll({ ...unsigned, signatures: [entry0, unsigned.signatures[1]] }, [sponsor.key])
}

/** Someone else's copy: keep entry 0, change the rest, let `sponsor` sign. */
function recomplete(tx: FrameTx, change: (tx: FrameTx) => FrameTx, sponsor: { key: Hex; address: Address }) {
  const next = change(tx)
  return signAll({ ...next, signatures: [tx.signatures[0], secp256k1Placeholder(sponsor.address)] }, [sponsor.key])
}

async function simulate(label: string, tx: FrameTx) {
  const sim = await simulateFrameTx(client, tx)
  console.log(`  simulate ${label}: valid=${sim.valid}${sim.violation ? ` violation=${sim.violation}` : ''}${sim.executionError ? ` error=${sim.executionError}` : ''}`)
  return sim
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

async function firstReceipt(hashes: (Hex | null)[], timeoutMs = 90_000): Promise<{ hash: Hex; receipt: FrameTxReceiptJson } | null> {
  const live = hashes.filter((h): h is Hex => h !== null)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const h of live) {
      const r = await getFrameTxReceipt(client, h)
      if (r) return { hash: h, receipt: r }
    }
    await new Promise((r) => setTimeout(r, 1_000))
  }
  return null
}

function frames(receipt: FrameTxReceiptJson) {
  return receipt.frameReceipts
    .map((f) => {
      const g = frameReceiptGas(f)
      return `${frameReceiptStatus(f) === 1 ? 'ok' : 'FAILED'} ${g.execution}/${g.state}`
    })
    .join(' · ')
}

// ---------------------------------------------------------------------------------------------

async function setup() {
  const eth = (to: Address, value: bigint, fresh: boolean) => senderFrame({ target: to, value, execution: 30_000n, state: fresh ? NEW_ACCOUNT_STATE_GAS : 0n })
  await sendFrames(
    client,
    privateKey,
    [
      ACCOUNT.frame,
      TOKEN.frame,
      senderFrame({ target: TOKEN.address, data: call('mint', [ACCOUNT.address, parseEther('1000')]), execution: 80_000n, state: 2n * STORAGE_SET_STATE_GAS }),
      eth(ACCOUNT.address, parseEther('0.002'), false),
      eth(sponsor1.address, parseEther('0.004'), true),
      eth(sponsor2.address, parseEther('0.004'), true),
    ],
    { label: 'setup: account, token, 1,000 TKE and 0.002 ETH to the account, 0.004 ETH to each sponsor', expectCode: [ACCOUNT.address, TOKEN.address] },
  )
  console.log(`  account ${ACCOUNT.address} (owner ${owner.address}), token ${TOKEN.address}`)
  console.log(`  sponsors ${sponsor1.address}, ${sponsor2.address}`)
}

async function scenarioA() {
  console.log('\nA. One typed-data signature, two payers')
  const f1 = await fees(1_000n)
  const tx1 = await sponsored((p) => [onlyVerify(), payFrame(p), transfer(parseEther('1'))], sponsor1, f1)
  const f2 = { ...f1, maxPriorityFeePerGas: (f1.maxPriorityFeePerGas * 12n) / 10n, maxFeePerGas: (f1.maxFeePerGas * 12n) / 10n }
  const tx2 = await recomplete(tx1, (t) => ({ ...t, frames: [t.frames[0], payFrame(sponsor2.address, 12_000n), t.frames[2]], fees: f2 }), sponsor2)
  console.log(`  E          ${executionDigest(tx1)} / ${executionDigest(tx2)}`)
  console.log(`  entry 0    ${tx1.signatures[0].signature === tx2.signatures[0].signature ? 'identical bytes' : 'DIFFERENT'}`)
  console.log(`  sig hash   ${frameSigHash(tx1)} / ${frameSigHash(tx2)}`)
  console.log(`  tx hash    ${frameTxHash(tx1)} / ${frameTxHash(tx2)}`)
  await simulate('via sponsor 1', tx1)
  await simulate('via sponsor 2', tx2)
  const h1 = await trySend('via sponsor 1', tx1)
  const h2 = await trySend('via sponsor 2 (replacement, 20% higher fees)', tx2)
  const mined = await firstReceipt([h2, h1])
  if (!mined) return console.log('  no receipt within 90 s')
  console.log(`  mined ${mined.hash} in block ${BigInt(mined.receipt.blockNumber)}, payer ${mined.receipt.payer}`)
  console.log(`  frames ${frames(mined.receipt)}`)
}

async function scenarioB() {
  console.log('\nB. What the account refuses (simulated against the chain)')
  const f = await fees()
  const tx = await sponsored((p) => [onlyVerify(), payFrame(p), transfer(parseEther('1'))], sponsor1, f)
  const front = defaultFrame({ target: TOKEN.address, data: call('transfer', [funder, 0n]), execution: 40_000n })
  await simulate('honest', tx)
  await simulate('DEFAULT frame inserted before the transfer', await recomplete(tx, (t) => ({ ...t, frames: [t.frames[0], t.frames[1], front, t.frames[2]] }), sponsor1))
  await simulate('DEFAULT frame appended', await recomplete(tx, (t) => ({ ...t, frames: [...t.frames, front] }), sponsor1))
  await simulate(
    'transfer amount changed',
    await recomplete(tx, (t) => ({ ...t, frames: [t.frames[0], t.frames[1], transfer(parseEther('2'))] }), sponsor1),
  )
  // The relay names the account as its own payer. E does not change, so only the account's rule
  // against approving payment on E keeps its ether.
  await simulate('pay frame naming the account itself', { ...tx, frames: [tx.frames[0], payFrame(ACCOUNT.address), tx.frames[2]], signatures: [tx.signatures[0]] })
  // The account paying for itself on the execution digest: the draft forbids it, so the account does.
  const nonceSeq = await getNonceSeq(client, ACCOUNT.address, [0n])
  const self: FrameTx = {
    chainId: 8141n,
    nonceKeys: [0n],
    nonceSeq,
    sender: ACCOUNT.address,
    frames: [verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 30_000n }), transfer(parseEther('1'))],
    signatures: [secp256k1Placeholder(owner.address, '0x')],
    fees: f,
    blobVersionedHashes: [],
  }
  const selfOnE = { ...self, signatures: [await ownerEntry(self)] }
  await simulate('self-paying, entry 0 over E', selfOnE)
  await trySend('self-paying, entry 0 over E', selfOnE)
}

async function scenarioC() {
  console.log('\nC. VERIFY gas')
  const runs: [string, () => Promise<FrameTx>][] = [
    ['E, three frames', async () => sponsored((p) => [onlyVerify(), payFrame(p), transfer(1n)], sponsor1, await fees())],
    ['E, six frames', async () => sponsored((p) => [onlyVerify(), payFrame(p), transfer(1n), transfer(2n), transfer(3n), transfer(4n)], sponsor1, await fees())],
    [
      'canonical hash, the account paying',
      async () => {
        const nonceSeq = await getNonceSeq(client, ACCOUNT.address, [0n])
        const tx: FrameTx = {
          chainId: 8141n,
          nonceKeys: [0n],
          nonceSeq,
          sender: ACCOUNT.address,
          frames: [verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 30_000n }), transfer(1n)],
          signatures: [secp256k1Placeholder(owner.address, '0x')],
          fees: await fees(),
          blobVersionedHashes: [],
        }
        return signAll(tx, [owner.key])
      },
    ],
  ]
  for (const [label, build] of runs) {
    const tx = await build()
    const h = await trySend(label, tx)
    const mined = await firstReceipt([h])
    if (!mined) {
      console.log('  no receipt within 90 s')
      continue
    }
    console.log(`  ${label}: block ${BigInt(mined.receipt.blockNumber)}, VERIFY ${frameReceiptGas(mined.receipt.frameReceipts[0]).execution} gas; frames ${frames(mined.receipt)}`)
  }
}

const which = process.argv[2] ?? 'all'
if (which === 'setup' || which === 'all') await setup()
if (which === 'A' || which === 'all') await scenarioA()
if (which === 'B' || which === 'all') await scenarioB()
if (which === 'C' || which === 'all') await scenarioC()
console.log(`\nfunder ${funder}: ${formatEther(await client.getBalance({ address: funder }))} ETH left`)
