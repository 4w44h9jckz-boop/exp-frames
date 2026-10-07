// Experiment 07: what FrostAccount refuses. Simulation only; run example-frost.ts first so the
// account exists.
//
// usage: npx tsx experiments/07-threshold-wallet/negative.ts
import { type Hex, concatHex, keccak256, numberToHex, parseEther, sliceHex, toHex } from 'viem'
import { loadKey } from '../../src/env.js'
import {
  Approve,
  type FrameSignature,
  type FrameTx,
  frameSigHash,
  frameTxHash,
  makeClient,
  prepareFrameTx,
  senderFrame,
  simulateFrameTx,
  verifyFrame,
} from '../../src/frametx/index.js'
import { ID, arbitraryEntry, frostAccount, group, signFrost } from './account.js'
import { addressOf, aggregate, dkg, encodeSignature, member, round1, round2 } from './frost.js'

const { privateKey, address: funder } = loadKey()
const client = makeClient()
const g = group(privateKey)
const account = frostAccount(g, 'exp-frames/07/frost-account/v1')
if (!(await client.getCode({ address: account.address }))) throw new Error('run example-frost.ts first')

// Another 2-of-3 group with the same structure and different members.
const strangers = dkg([1n, 2n, 3n].map((id) => member(id, 2, keccak256(concatHex([privateKey, toHex(`exp-frames/07/strangers/${id}`)])))), 2)

const unsigned = (signatures: FrameSignature[] = [arbitraryEntry()], value = parseEther('0.0001')) =>
  prepareFrameTx(client, {
    sender: account.address,
    frames: [verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 20_000n }), senderFrame({ target: funder, value, execution: 30_000n })],
    signatures,
  })
const editSig = (f: (sig: Hex) => Hex) => (tx: FrameTx): FrameTx => ({ ...tx, signatures: tx.signatures.map((s, i) => (i === 0 ? { ...s, signature: f(s.signature) } : s)) })
const withSig = (tx: FrameTx, signature: Hex): FrameTx => editSig(() => signature)(tx)
const pair = [ID.alice, ID.bob]

const cases: [string, () => Promise<FrameTx>][] = [
  ['alice and bob sign (baseline)', async () => signFrost(await unsigned(), g, pair)],
  ['alice, bob and carol all sign (more than t)', async () => signFrost(await unsigned(), g, [ID.alice, ID.bob, ID.carol])],
  ['one byte appended to the 52 bytes', async () => editSig((s) => concatHex([s, '0x00']))(signFrost(await unsigned(), g, pair))],
  ['last byte dropped', async () => editSig((s) => sliceHex(s, 0, 51))(signFrost(await unsigned(), g, pair))],
  ['z = 0', async () => editSig((s) => concatHex([sliceHex(s, 0, 20), numberToHex(0n, { size: 32 })]))(signFrost(await unsigned(), g, pair))],
  ['address(R) = 0', async () => editSig((s) => concatHex([numberToHex(0n, { size: 20 }), sliceHex(s, 20)]))(signFrost(await unsigned(), g, pair))],
  ['address(R) of another nonce', async () => editSig((s) => concatHex([addressOf(round1(1n).commitment.D), sliceHex(s, 20)]))(signFrost(await unsigned(), g, pair))],
  [
    'alice\'s round-2 response alone, with the pair\'s address(R)',
    async () => {
      const tx = await unsigned()
      const msg = frameSigHash(tx)
      const r1 = pair.map((id) => round1(id))
      const cs = r1.map((r) => r.commitment)
      const responses = new Map(r1.map((r, i) => [r.nonces.id, round2(g, g.shares[i], r.nonces, msg, cs)]))
      const { rAddress } = aggregate(g, msg, cs, responses)
      return withSig(tx, encodeSignature({ rAddress, z: responses.get(ID.alice)! }))
    },
  ],
  [
    'a signature over another transaction (value 0.0002)',
    async () => {
      const other = signFrost(await unsigned(undefined, parseEther('0.0002')), g, pair)
      return withSig(await unsigned(), other.signatures[0].signature)
    },
  ],
  ['a stranger group signs', async () => signFrost(await unsigned(), strangers, pair)],
  ['signature in entry 1, entry 0 empty', async () => signFrost(await unsigned([arbitraryEntry(), arbitraryEntry()]), g, pair, 1)],
  [
    'entry 0 carries the sig hash as an explicit msg',
    async () => {
      const tx = await unsigned()
      return signFrost({ ...tx, signatures: [{ ...arbitraryEntry(), msg: frameSigHash(tx) }] }, g, pair)
    },
  ],
]

console.log('| Case | valid | violation |\n|---|---|---|')
for (const [label, build] of cases) {
  const tx = await build()
  const sim = await simulateFrameTx(client, tx).catch((e: Error) => ({ valid: 'error', violation: e.message.split('\n').find((l) => l.startsWith('Details:'))?.slice(9) }))
  console.log(`| ${label} | ${sim.valid} | ${sim.violation ?? ''} |`)
}

// Why the length check: the ARBITRARY bytes are elided from the sig hash but not from the
// transaction hash, so an encoding the account would also accept is a second hash for the same
// authorisation, and anyone relaying the transaction could mint it.
const base = signFrost(await unsigned(), g, pair)
const padded = editSig((s) => concatHex([s, '0x00']))(base)
console.log(`\nsig hash ${frameSigHash(base) === frameSigHash(padded) ? 'unchanged' : 'changed'} by the appended byte; tx hash ${frameTxHash(base).slice(0, 12)}… vs ${frameTxHash(padded).slice(0, 12)}…`)
