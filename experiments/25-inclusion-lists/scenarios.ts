// Experiment 25: the inclusion lists fed to ethrex's own budget fill (ethrex/exp25_fill_order.rs).
//
// Every transaction but the attacker's is a mined one from this repository. The attacker's is
// built here: a self-relayed frame transaction from a key that has never held ether, so it can
// never be valid, declaring a VERIFY limit that makes its cost exactly MAX_VERIFY_GAS_PER_TX.
// Its signature is valid, which is all the budget fill checks before it debits.
// Run: git fetch origin && npx tsx experiments/25-inclusion-lists/scenarios.ts > experiments/25-inclusion-lists/ethrex/scenarios.txt
import { type Hex, keccak256, toBytes } from 'viem'
import { privateKeyToAccount, privateKeyToAddress } from 'viem/accounts'
import {
  Approve,
  type FrameTx,
  secp256k1Placeholder,
  senderFrame,
  serializeFrameTx,
  signFrameTx,
  verifyFrame,
} from '../../src/frametx/index.js'
import { loadCorpus } from './corpus.js'
import { MAX_VERIFY_GAS_PER_TX, shape, verifyBudgetCost } from './profiles.js'

const corpus = loadCorpus()
const pick = (branch: string, sh: string, n: number) => {
  const xs = corpus.filter((m) => m.branch === branch && shape(m.tx) === sh).sort((a, b) => a.hash.localeCompare(b.hash))
  if (xs.length < n) throw new Error(`${branch} has ${xs.length} transactions of shape ${sh}, need ${n}`)
  return xs.slice(0, n)
}

const withdrawals = pick('exp/06-privacy-pool', 'recent_root_verify | self_verify', 4)
const sealed = pick('exp/24-sealed-paymaster', 'expiry_verify | recent_root_verify | only_verify | pay', 3)
const eoa = pick('exp/01-simple-tx', 'self_verify', 4)

/** A key nobody funds: its transactions fail APPROVE's balance check at every state. */
const ATTACKER_KEY = keccak256(toBytes('exp-frames/25 attacker, never funded'))
const attacker = privateKeyToAddress(ATTACKER_KEY)

async function attackerTx(seq: bigint, cost: bigint): Promise<FrameTx> {
  const unsigned: FrameTx = {
    chainId: 8141n,
    nonceKeys: [0n],
    nonceSeq: seq,
    sender: attacker,
    frames: [
      // Signature verification (2,800 for one SECP256K1 entry) plus this limit is the cost.
      verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: cost - 2_800n }),
      senderFrame({ target: attacker, execution: 21_000n }),
    ],
    signatures: [secp256k1Placeholder()],
    fees: { maxPriorityFeePerGas: 1_000_000_000n, maxFeePerGas: 2_000_000_000n, maxFeePerBlobGas: 0n },
    blobVersionedHashes: [],
  }
  const tx = await signFrameTx(unsigned, ATTACKER_KEY)
  if (verifyBudgetCost(tx) !== cost) throw new Error('attacker cost mismatch')
  return tx
}

const big = await attackerTx(0n, MAX_VERIFY_GAS_PER_TX)
// Three, each just cheaper than a privacy withdrawal, for the canonical-order variant.
const under = await Promise.all([1n, 2n, 3n].map((s) => attackerTx(s, verifyBudgetCost(withdrawals[0].tx) - 10_000n)))

// Thirty that share the budget evenly: one committee member's 8 KiB list, no position needed.
const FLOOD = 30n
const flood = await Promise.all(
  Array.from({ length: Number(FLOOD) }, (_, i) => attackerTx(10n + BigInt(i), MAX_VERIFY_GAS_PER_TX / FLOOD)),
)
const floodBytes = flood.reduce((n, t) => n + (serializeFrameTx(t).length - 2) / 2, 0)
if (floodBytes > 8192) throw new Error(`flood list is ${floodBytes} bytes`)

const line = (label: string, raw: Hex, note: string) => `${label} ${raw} ${note}`
const out: string[] = [
  '# Experiment 25: inclusion lists for ethrex budget_fill. Format: "label 0xenvelope note".',
  `# attacker ${attacker}, key keccak256("exp-frames/25 attacker, never funded"), never funded`,
]
const W = withdrawals.map((m, i) => line(`W${i + 1}`, m.raw, `${m.hash} exp/06 keyed withdrawal, cost ${verifyBudgetCost(m.tx)}`))
const S = sealed.map((m, i) => line(`S${i + 1}`, m.raw, `${m.hash} exp/24 sealed sponsorship, cost ${verifyBudgetCost(m.tx)}`))
const E = eoa.map((m, i) => line(`E${i + 1}`, m.raw, `${m.hash} exp/01 default-code EOA, cost ${verifyBudgetCost(m.tx)}`))
const A = line('A', serializeFrameTx(big), `attacker, never valid, cost ${verifyBudgetCost(big)}`)
const U = under.map((t, i) => line(`U${i + 1}`, serializeFrameTx(t), `attacker, never valid, cost ${verifyBudgetCost(t)}`))
const F = flood.map((t, i) => line(`F${i + 1}`, serializeFrameTx(t), `attacker, never valid, cost ${verifyBudgetCost(t)}`))

// A type-2 transfer for the Profile 1 baseline: what an attester already checks today.
const type2 = await privateKeyToAccount(ATTACKER_KEY).signTransaction({
  type: 'eip1559',
  chainId: 8141,
  nonce: 0,
  to: attacker,
  value: 1n,
  gas: 21_000n,
  maxFeePerGas: 2_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
})

out.push('scenario withdrawals', ...W)
out.push('scenario grief', A, W[0], S[0], E[0])
// The same honest transactions without the attacker's: what a node that never received its list sees.
out.push('scenario grief-honest', W[0], S[0], E[0])
out.push('scenario mixed', ...W, ...S, ...E)
out.push('scenario grief-under', ...U, W[0], S[0], E[0])
// Four committee members' lists, each in its includer's order: two attackers and two honest
// includers who both list W1. "-- list" separates members; EIP-8369 fills each list on its own.
out.push('scenario committee', A, '-- list', ...U, '-- list', W[0], S[0], E[0], '-- list', W[1], W[0], S[1], E[1])
// One member lists thirty never-valid transactions (${floodBytes} bytes); two honest members split
// the mixed set so that each honest list fits its own budget.
out.push(
  'scenario flood',
  ...F,
  '-- list',
  W[0], W[1], S[0], S[1], E[0], E[1],
  '-- list',
  W[2], W[3], S[2], E[2], E[3],
)
out.push('scenario timing', line('T1', type2, 'type-2 transfer, never sent'), ...E, ...S, ...W)
console.log(out.join('\n'))
