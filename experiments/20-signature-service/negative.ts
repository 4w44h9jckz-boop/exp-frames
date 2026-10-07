// Experiment 20, part 3: what the protocol refuses, and what is left to the contract. carol
// relays `transferBySig(alice, carol, 1 TKA, 1)` with something wrong in entry 1. Each case is
// simulated; a transaction the simulation calls invalid is also offered to eth_sendRawTransaction
// (a refusal costs nothing). Valid transactions are not sent: the transfer frame would revert and
// carol would pay for it.
//
// usage: npx tsx experiments/20-signature-service/negative.ts
import { type Hex, encodeFunctionData, parseEther } from 'viem'
import { type FrameSignature, Scheme, sendFrameTx, signAll, simulateFrameTx } from '../../src/frametx/index.js'
import { aliceK1, aliceP256, call, carol, client, k1, read, reader, relayed, short, signedEntry, tka, tokenAbi } from './service.js'

const E1 = parseEther('1')
const mallory = k1('mallory')
const nonce = await read<bigint>(tka.address, tokenAbi, 'nonces', [aliceK1.address])
const digestFor = (value: bigint, n = nonce) => read<Hex>(tka.address, tokenAbi, 'transferDigest', [aliceK1.address, carol.address, value, n])
const good = await digestFor(E1)
const zero32 = `0x${'00'.repeat(32)}` as Hex

type Case = [what: string, entries: FrameSignature[], index?: bigint]
const cases: Case[] = [
  ['baseline: alice signs the digest', [await signedEntry(aliceK1, good)]],
  ['mallory signs, entry names alice as signer', [{ ...(await signedEntry(mallory, good)), signer: aliceK1.address }]],
  ['mallory signs as mallory', [await signedEntry(mallory, good)]],
  ['alice signs the digest for 2 TKA', [await signedEntry(aliceK1, await digestFor(2n * E1))]],
  ['alice signs an already-used nonce', [await signedEntry(aliceK1, await digestFor(E1, nonce - 1n))]],
  ['alice signs the sig hash instead (`msg` ∅)', [{ scheme: Scheme.SECP256K1, signer: aliceK1.address, msg: '0x', signature: '0x' }]],
  ['explicit `msg` of 32 zero bytes', [{ ...(await signedEntry(aliceK1, good)), msg: zero32 }]],
  ['an ARBITRARY entry carrying alice\'s signature bytes', [{ scheme: Scheme.ARBITRARY, signer: null, msg: good, signature: (await signedEntry(aliceK1, good)).signature }]],
  ['a P256 entry that claims alice\'s secp256k1 address', [{ ...(await signedEntry(aliceP256, good)), signer: aliceK1.address }]],
  ['entry index 5, past the end of the list', [await signedEntry(aliceK1, good)], 5n],
]

console.log('| Entry 1 | simulation | transfer frame | `eth_sendRawTransaction` |\n|---|---|---|---|')
for (const [what, entries, index = 1n] of cases) {
  let tx = await relayed(carol.address, [call(tka.address, tokenAbi, 'transferBySig', [aliceK1.address, carol.address, E1, index])], entries)
  // carol signs her entry 0; alice's msg-∅ entry, if any, is signed by alice over the sig hash.
  const keys: Hex[] = [carol.key]
  if (entries.some((e) => e.msg === '0x')) keys.push(aliceK1.key)
  tx = await signAll(tx, keys)
  const sim = await simulateFrameTx(client, tx).catch((e) => ({ valid: false, violation: short(e), frames: null }))
  const frame = sim.frames?.[1]
  let sent = ''
  if (!sim.valid) {
    sent = await sendFrameTx(client, tx).then(
      () => 'accepted (!)',
      (e) => `refused: ${short(e)}`,
    )
  }
  console.log(`| ${what} | ${sim.valid ? 'valid' : `invalid: ${sim.violation}`} | ${frame ? (frame.succeeded ? 'success' : 'reverts') : ''} | ${sent} |`)
}

// Outside a frame transaction: SigReader, and the token through it.
const outside = [
  ['`eth_call` to SigReader', () => client.call({ to: reader.address, data: `0x${'00'.repeat(31)}00${'00'.repeat(31)}01` })],
  [
    '`eth_call` of `transferBySig` (an ordinary transaction would do the same)',
    () =>
      client.call({
        account: carol.address,
        to: tka.address,
        data: encodeFunctionData({ abi: tokenAbi, functionName: 'transferBySig', args: [aliceK1.address, carol.address, E1, 0n] }),
      }),
  ],
] as const
for (const [what, f] of outside) {
  const r = await f().then(
    (x) => `returned ${x.data}`,
    (e) => short(e),
  )
  console.log(`\n${what}: ${r}`)
}
