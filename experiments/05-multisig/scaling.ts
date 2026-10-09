// How validation cost grows with the number of signers, by simulation.
//
// One setup tx (from the funder EOA) deploys n-of-n multisigs for each size below, with owner
// keys derived from PRIVATE_KEY so they are the same on every run. The accounts hold no ETH:
// every simulated tx is paid by the funder EOA through its default code (OnlyVerifyPay):
//   [VERIFY(EXECUTION) multisig, VERIFY(PAYMENT) funder, SENDER no-op]
// Signatures: owner 0, the funder (default code reads index 1 for payment), owners 1..n-1.
// The multisig ignores the funder's entry.
//
// Then a self-deploying (Example 1b) multisig is checked against MAX_VERIFY_STATE_GAS.
//
// usage: npx tsx experiments/05-multisig/scaling.ts
import { size } from 'viem'
import { loadKey } from '../../src/env.js'
import { sendFrames } from '../../src/deploy.js'
import {
  Approve,
  type AnyKey,
  CPSB,
  type Frame,
  type FrameSignature,
  MAX_VERIFY_STATE_GAS,
  NEW_ACCOUNT_STATE_GAS,
  calldataCost,
  intrinsicGas,
  makeClient,
  p256Placeholder,
  prepareFrameTx,
  secp256k1Placeholder,
  senderFrame,
  signAll,
  signatureVerificationGas,
  simulateFrameTx,
  verifyFrame,
} from '../../src/frametx/index.js'
import { addressOf, deriveP256, deriveSecp256k1, multisig } from './multisig.js'

const { privateKey, address: funder } = loadKey()
const client = makeClient()

const SIZES = { secp256k1: [1, 2, 3, 5, 10, 20, 30], p256: [1, 2, 5, 10, 20] } as const
const keysFor = (scheme: keyof typeof SIZES, n: number): AnyKey[] =>
  Array.from({ length: n }, (_, i) => (scheme === 'p256' ? deriveP256(privateKey, `scale-${i}`) : deriveSecp256k1(privateKey, `scale-${i}`)))
const accounts = Object.entries(SIZES).flatMap(([scheme, sizes]) =>
  sizes.map((n) => {
    const keys = keysFor(scheme as keyof typeof SIZES, n)
    return { scheme, n, keys, account: multisig(keys.map(addressOf), n, `exp-frames/05/scaling/${scheme}/${n}/v1`) }
  }),
)

const missing: Frame[] = []
for (const { account } of accounts) if (!(await client.getCode({ address: account.address }))) missing.push(account.deployBySender)
if (missing.length) await sendFrames(client, privateKey, missing, { label: `setup: deploy ${missing.length} n-of-n multisigs` })

const entry = (k: AnyKey): FrameSignature => (typeof k === 'string' ? secp256k1Placeholder(addressOf(k)) : p256Placeholder(addressOf(k)))

console.log('\nscheme     n | VERIFY gas used | sig verification | sig calldata | validation work* | intrinsic | valid')
for (const { scheme, n, keys, account } of accounts) {
  let tx = await prepareFrameTx(client, {
    sender: account.address,
    frames: [
      verifyFrame({ scope: Approve.EXECUTION, execution: 10_000n + 40n * BigInt(n * n) }),
      verifyFrame({ scope: Approve.PAYMENT, target: funder, execution: 10_000n }),
      senderFrame({ target: funder, execution: 10_000n }),
    ],
    signatures: [entry(keys[0]), secp256k1Placeholder(funder), ...keys.slice(1).map(entry)],
  })
  tx = await signAll(tx, [...keys, privateKey])
  const sim = await simulateFrameTx(client, tx)
  const used = sim.frames?.map((f) => BigInt(f.gasUsed)) ?? []
  const sigGas = signatureVerificationGas(tx)
  const sigCalldata = tx.signatures.reduce((a, s) => a + calldataCost(s.signer ?? '0x') + calldataCost(s.signature), 0n)
  // MAX_VERIFY_GAS bounds the declared limits plus signature verification; this is the smallest budget that would do.
  const work = (used[0] ?? 0n) + (used[1] ?? 0n) + sigGas
  console.log(
    `${scheme.padEnd(9)} ${String(n).padStart(2)} | ${String(used[0] ?? '-').padStart(15)} | ${String(sigGas).padStart(16)} | ` +
      `${String(sigCalldata).padStart(12)} | ${String(work).padStart(16)} | ${String(intrinsicGas(tx)).padStart(9)} | ${sim.valid}` +
      (sim.violation ? ` (${sim.violation})` : ''),
  )
}
console.log('* VERIFY(sender) + VERIFY(payer) execution used, plus signature verification. MAX_VERIFY_GAS: spec 100,000, testnet 500,000.')

// Example 1b for a multisig: the deploy frame's state budget counts toward MAX_VERIFY_STATE_GAS.
const deployed = await client.getCode({ address: accounts[0].account.address }) // 1-of-1: runtime + 3 words
const runtime = BigInt(size(deployed ?? '0x')) - 96n
console.log(`\nself-deploying (Example 1b) multisig, MAX_VERIFY_STATE_GAS = ${MAX_VERIFY_STATE_GAS}:`)
for (const n of [1, 2, 3, 5]) {
  const code = runtime + 32n * BigInt(n + 2)
  const fresh = NEW_ACCOUNT_STATE_GAS + CPSB * code
  console.log(`  n=${n}: ${code} B of code → ${fresh} state gas at a fresh address, ${CPSB * code} if prefunded`)
}
console.log(
  `  largest code a deploy frame can install: ${(MAX_VERIFY_STATE_GAS - NEW_ACCOUNT_STATE_GAS) / CPSB} B at a fresh address, ` +
    `${MAX_VERIFY_STATE_GAS / CPSB} B if prefunded`,
)
const probe = accounts[0].account
const t = await prepareFrameTx(client, {
  sender: probe.address,
  frames: [probe.deployAtSender, verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 20_000n })],
  signatures: [secp256k1Placeholder(addressOf(accounts[0].keys[0]))],
  nonceSeq: 0n,
})
const sim = await simulateFrameTx(client, await signAll(t, [accounts[0].keys[0]]))
console.log(`  simulated 1-of-1 self-deploy: valid=${sim.valid} (${sim.violation})`)
