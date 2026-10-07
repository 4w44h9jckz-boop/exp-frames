// Experiment 11: what the protocol and the two passkey accounts refuse. Simulation only; run
// example-passkey.ts first so both accounts exist.
//
// usage: npx tsx experiments/11-passkey/negative.ts
import { p256 } from '@noble/curves/p256'
import { type Hex, concatHex, numberToHex, parseEther, sliceHex } from 'viem'
import { loadKey } from '../../src/env.js'
import {
  Approve,
  type FrameSignature,
  type FrameTx,
  Scheme,
  frameSigHash,
  frameTxHash,
  generateP256Key,
  makeClient,
  p256Address,
  p256Placeholder,
  prepareFrameTx,
  senderFrame,
  signAll,
  simulateFrameTx,
  verifyFrame,
} from '../../src/frametx/index.js'
import { type AssertionOptions, arbitraryEntry, deriveP256, p256Account, signWebAuthn, webauthnAccount } from './passkey.js'

const { privateKey, address: funder } = loadKey()
const client = makeClient()
const raw = deriveP256(privateKey, 'raw')
const passkey = deriveP256(privateKey, 'webauthn')
const rawAccount = p256Account(raw, 'exp-frames/11/p256-account/v1')
const webauthn = webauthnAccount(passkey, 'exp-frames/11/webauthn-account/v1')
for (const a of [rawAccount, webauthn]) if (!(await client.getCode({ address: a.address }))) throw new Error('run example-passkey.ts first')

const stranger = generateP256Key()
const pay = senderFrame({ target: funder, value: parseEther('0.0001'), execution: 30_000n })
const unsigned = (sender: Hex, signatures: FrameSignature[], execution = 60_000n) =>
  prepareFrameTx(client, { sender, frames: [verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution }), pay], signatures })

/** A WebAuthn transaction with the assertion built from `opts`, then optionally edited. */
async function webauthnTx(opts: AssertionOptions = {}, edit: (tx: FrameTx) => FrameTx = (t) => t): Promise<FrameTx> {
  return edit(signWebAuthn(await unsigned(webauthn.address, [arbitraryEntry()]), passkey, 0, opts))
}
const editSig = (f: (sig: Hex) => Hex) => (tx: FrameTx): FrameTx => ({ ...tx, signatures: tx.signatures.map((s, i) => (i === 0 ? { ...s, signature: f(s.signature) } : s)) })

const cases: [string, () => Promise<FrameTx>][] = [
  // The raw P256 key's own address, with no code: the default code accepts SECP256K1 only.
  ['code-less sender = the P256 key\'s address, P256 entry', async () => signAll(await unsigned(p256Address(raw), [p256Placeholder(null)], 20_000n), [raw])],
  ['P256Account: owner signs (baseline)', async () => signAll(await unsigned(rawAccount.address, [p256Placeholder(p256Address(raw))], 20_000n), [raw])],
  ['P256Account: a stranger\'s P256 key signs', async () => signAll(await unsigned(rawAccount.address, [p256Placeholder(p256Address(stranger))], 20_000n), [stranger])],
  [
    'P256Account: owner signs, high s',
    async () =>
      editSig((sig) => {
        const s = BigInt(sliceHex(sig, 32, 64))
        return concatHex([sliceHex(sig, 0, 32), numberToHex(p256.CURVE.n - s, { size: 32 }), sliceHex(sig, 64)])
      })(await signAll(await unsigned(rawAccount.address, [p256Placeholder(p256Address(raw))], 20_000n), [raw])),
  ],
  [
    'P256Account: owner signs an explicit digest instead of the sig hash',
    async () => signAll(await unsigned(rawAccount.address, [p256Placeholder(p256Address(raw), `0x${'11'.repeat(32)}`)], 20_000n), [raw]),
  ],
  ['WebAuthn: baseline', () => webauthnTx()],
  ['WebAuthn: assertion over another challenge', () => webauthnTx({ challenge: new Uint8Array(32).fill(7) })],
  ['WebAuthn: high s', () => webauthnTx({ highS: true })],
  ['WebAuthn: user-presence flag clear', () => webauthnTx({ flags: 0x04 })],
  ['WebAuthn: type webauthn.create', () => webauthnTx({ type: 'webauthn.create' })],
  ['WebAuthn: origin edited after signing', () => webauthnTx({ tamper: (j) => j.replace('exp-frames.test', 'evil.example') })],
  ['WebAuthn: one byte appended to the entry', () => webauthnTx({}, editSig((s) => concatHex([s, '0x00'])))],
  ['WebAuthn: a stranger\'s passkey signs', async () => signWebAuthn(await unsigned(webauthn.address, [arbitraryEntry()]), stranger)],
  [
    'WebAuthn: assertion in entry 1, entry 0 empty',
    async () => signWebAuthn(await unsigned(webauthn.address, [arbitraryEntry(), arbitraryEntry()]), passkey, 1),
  ],
  [
    'WebAuthn: entry 0 has an explicit msg (the sig hash)',
    async () => {
      const tx = await unsigned(webauthn.address, [arbitraryEntry()])
      const withMsg = { ...tx, signatures: [{ ...arbitraryEntry(), msg: frameSigHash(tx) }] }
      return signWebAuthn(withMsg, passkey)
    },
  ],
  ['WebAuthn: a protocol P256 entry by the passkey instead', async () => signAll(await unsigned(webauthn.address, [p256Placeholder(p256Address(passkey))]), [passkey])],
]

console.log('| Case | valid | violation |\n|---|---|---|')
for (const [label, build] of cases) {
  const tx = await build()
  const sim = await simulateFrameTx(client, tx).catch((e: Error) => ({ valid: 'error', violation: e.message.split('\n').find((l) => l.startsWith('Details:'))?.slice(9) }))
  console.log(`| ${label} | ${sim.valid} | ${sim.violation ?? ''} |`)
}

// The malleability the high-s check closes: flipping s leaves the sig hash alone and moves the
// transaction hash, because ARBITRARY bytes are elided from the sig hash.
const good = await webauthnTx()
const flipped = await webauthnTx({ highS: true })
console.log(`\nsame sig hash: ${frameSigHash(good) === frameSigHash(flipped)}; tx hashes ${frameTxHash(good).slice(0, 10)}… vs ${frameTxHash(flipped).slice(0, 10)}…`)
