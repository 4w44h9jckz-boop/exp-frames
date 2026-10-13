// What the multisig and the protocol refuse, checked by simulation against the two 2-of-3
// accounts from example-multisig.ts (run that first).
//
// usage: npx tsx experiments/05-multisig/negative.ts
import { type Hex, keccak256, parseEther, toHex } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { loadKey } from '../../src/env.js'
import {
  Approve,
  type AnyKey,
  type FrameSignature,
  type FrameTx,
  Scheme,
  generateP256Key,
  makeClient,
  p256Placeholder,
  prepareFrameTx,
  secp256k1Placeholder,
  senderFrame,
  signAll,
  simulateFrameTx,
  verifyFrame,
} from '../../src/frametx/index.js'
import { addressOf, deriveP256, deriveSecp256k1, multisig } from './multisig.js'

const { privateKey, address: funder } = loadKey()
const client = makeClient()
const alice = deriveSecp256k1(privateKey, 'alice')
const bob = deriveSecp256k1(privateKey, 'bob')
const carol = deriveSecp256k1(privateKey, 'carol')
const passkey = deriveP256(privateKey, 'passkey')
const secp = multisig([alice, bob, carol].map(addressOf), 2, 'exp-frames/05/multisig-2of3-secp/v1')
const mixed = multisig([alice, bob, passkey].map(addressOf), 2, 'exp-frames/05/multisig-2of3-mixed/v1')
if (!(await client.getCode({ address: mixed.address }))) throw new Error('run example-multisig.ts first')

const stranger = generatePrivateKey()
const fakePasskey = generateP256Key()
const entry = (k: AnyKey, msg: Hex = '0x'): FrameSignature =>
  typeof k === 'string' ? secp256k1Placeholder(addressOf(k), msg) : p256Placeholder(addressOf(k), msg)
const arbitrary: FrameSignature = { scheme: Scheme.ARBITRARY, signer: null, msg: '0x', signature: '0xdeadbeef' }

/** A transfer from `account`, with the given signature entries, signed by `keys` in turn. */
async function build(account: typeof secp, signatures: FrameSignature[], keys: AnyKey[]): Promise<FrameTx> {
  const tx = await prepareFrameTx(client, {
    sender: account.address,
    frames: [
      verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 30_000n }),
      senderFrame({ target: funder, value: parseEther('0.001'), execution: 30_000n }),
    ],
    signatures,
  })
  return signAll(tx, keys)
}

const cases: [string, () => Promise<FrameTx>][] = [
  ['secp: alice + bob', () => build(secp, [entry(alice), entry(bob)], [alice, bob])],
  ['secp: bob + alice (order does not matter)', () => build(secp, [entry(bob), entry(alice)], [bob, alice])],
  ['secp: all three owners', () => build(secp, [entry(alice), entry(bob), entry(carol)], [alice, bob, carol])],
  ['secp: an ARBITRARY entry first, then alice + bob', () => build(secp, [arbitrary, entry(alice), entry(bob)], [alice, bob])],
  ['secp: alice only', () => build(secp, [entry(alice)], [alice])],
  ['secp: alice twice', () => build(secp, [entry(alice), entry(alice)], [alice])],
  ['secp: alice + a stranger', () => build(secp, [entry(alice), entry(stranger)], [alice, stranger])],
  [
    'secp: alice + bob, but bob signs an explicit digest',
    () => build(secp, [entry(alice), entry(bob, keccak256(toHex('some other message')))], [alice, bob]),
  ],
  [
    'secp: alice signs an entry with an empty signer (resolves to the multisig)',
    async () => {
      const t = await build(secp, [entry(alice), entry(bob)], [alice, bob])
      return { ...t, signatures: [{ ...t.signatures[0], signer: null }, t.signatures[1]] }
    },
  ],
  ['mixed: bob + passkey', () => build(mixed, [entry(bob), entry(passkey)], [bob, passkey])],
  ['mixed: passkey only', () => build(mixed, [entry(passkey)], [passkey])],
  [
    "mixed: bob + another P256 key claiming the passkey's address",
    async () => {
      const t = await build(mixed, [entry(bob), entry(fakePasskey)], [bob, fakePasskey])
      return { ...t, signatures: [t.signatures[0], { ...t.signatures[1], signer: addressOf(passkey) }] }
    },
  ],
]

for (const [name, make] of cases) {
  const t = await make()
  const sim = await simulateFrameTx(client, t).catch((e: Error) => ({ error: e.message.split('\n')[0] }))
  console.log(`\n• ${name}`)
  if ('error' in sim) {
    console.log(`  RPC error: ${sim.error}`)
    continue
  }
  console.log(`  valid=${sim.valid} shape=${sim.prefixShape}${sim.violation ? `\n  violation: ${sim.violation}` : ''}`)
  if (sim.frames) console.log(`  frames: ${sim.frames.map((f, i) => `[${i}] ${f.succeeded ? 'ok' : 'FAILED'} gas=${BigInt(f.gasUsed as Hex)}`).join('  ')}`)
}
