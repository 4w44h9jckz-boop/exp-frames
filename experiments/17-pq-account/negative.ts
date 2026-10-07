// Experiment 17: what WotsAccount refuses, simulated on the n = 16, w = 16 burner (whose keys
// these cases spend). Each case is also run through the TypeScript verifier in wots.ts, which
// mirrors the contract; the two should agree.
//
// usage: npx tsx experiments/17-pq-account/negative.ts   (after setup.ts)
import { type Hex, concatHex, sliceHex } from 'viem'
import { type FrameTx, frameSigHash, senderFrame, simulateFrameTx } from '../../src/frametx/index.js'
import { client, funder, pqTx, treeOf, wotsAccount } from './account.js'
import { VARIANTS, derived, verify } from './wots.js'

const p = VARIANTS.n16w16
const tree = treeOf(p, 'burner')
const account = wotsAccount(p, tree, 'burner').address
if (!(await client.getCode({ address: account }))) throw new Error('run setup.ts first')
const { sigLen } = derived(p)
const pay = (value = 1n) => senderFrame({ target: funder, value, execution: 30_000n })

const withSig = (tx: FrameTx, signature: Hex): FrameTx => ({ ...tx, signatures: [{ ...tx.signatures[0], signature }] })
const flip = (sig: Hex, offset: number): Hex => {
  const byte = Number.parseInt(sig.slice(2 + 2 * offset, 4 + 2 * offset), 16) ^ 0x01
  return `0x${sig.slice(2, 2 + 2 * offset)}${byte.toString(16).padStart(2, '0')}${sig.slice(4 + 2 * offset)}` as Hex
}

const base = await pqTx(tree, account, [pay()])
const sig = base.tx.signatures[0].signature
const other = await pqTx(tree, account, [pay(2n)], { nonceSeq: base.tx.nonceSeq })
const cases: [string, () => Promise<FrameTx>][] = [
  ['baseline', async () => base.tx],
  ['a key of the previous nonce', async () => (await pqTx(tree, account, [pay()], { attempt: -1 })).tx],
  ['a key of the next nonce', async () => (await pqTx(tree, account, [pay()], { attempt: p.k })).tx],
  ['leaf 65535 (outside the tree)', async () => withSig(base.tx, concatHex(['0xffff', sliceHex(sig, 2)]))],
  ['one byte more', async () => withSig(base.tx, concatHex([sig, '0x00']))],
  ['one byte less', async () => withSig(base.tx, sliceHex(sig, 0, sigLen - 1))],
  ['one bit of R flipped', async () => withSig(base.tx, flip(sig, 2))],
  ['one bit of a chain value flipped', async () => withSig(base.tx, flip(sig, 2 + p.n + 5 * p.n))],
  ['one bit of the path flipped', async () => withSig(base.tx, flip(sig, sigLen - 1))],
  ['the signature of another transaction', async () => withSig(base.tx, other.tx.signatures[0].signature)],
  ['nonce key 1', async () => (await pqTx(tree, account, [pay()], { nonceKeys: [1n] })).tx],
  ['msg set to the sig hash', async () => ({ ...base.tx, signatures: [{ ...base.tx.signatures[0], msg: frameSigHash(base.tx) }] })],
  ['VERIFY limit 20,000', async () => (await pqTx(tree, account, [pay()], { verifyGas: 20_000n })).tx],
]

console.log('| Case | wots.ts | valid | violation |\n|---|---|---|---|')
for (const [label, build] of cases) {
  const tx = await build()
  const s = tx.signatures[0]
  const mine = s.msg !== '0x' ? 'msg not empty' : tx.nonceKeys[0] !== 0n ? 'nonce key' : (() => {
    const v = verify(p, tree.root, s.signature, frameSigHash(tx), tx.nonceSeq)
    return v.ok ? 'ok' : v.reason
  })()
  const sim = await simulateFrameTx(client, tx).catch((e: Error) => ({ valid: 'error', violation: e.message.split('\n').find((l) => l.startsWith('Details:'))?.slice(9) }))
  console.log(`| ${label} | ${mine} | ${sim.valid} | ${sim.violation ?? ''} |`)
}
