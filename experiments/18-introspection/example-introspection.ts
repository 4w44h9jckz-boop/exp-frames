// Experiment 18: what the introspection opcodes return, from every mode, against what the EIP and
// this repository's encoder say they should.
//
//   A  one transaction of eleven frames. VERIFY checks its own view against a hash of the
//      expected dump (carried in an ARBITRARY entry, outside the sig hash). SENDER, DEFAULT and
//      nested frames log their dumps, which are compared word by word with the model in
//      introspector.ts. Frames 4-7 make a FAILURE, a rolled-back batch and a SKIPPED frame for the
//      later dumps to read. Frame 9 measures what the opcodes cost.
//   B  twenty probes, one frame each: the cases the EIP says halt, and controls that should not.
//   C  the same opcode outside any frame transaction (eth_call).
//
// usage: npx tsx experiments/18-introspection/example-introspection.ts
import { type Hex, hexToBigInt, isHex, parseEther } from 'viem'
import { sendFrames } from '../../src/deploy.js'
import {
  Approve,
  type Frame,
  type FrameTx,
  type FrameTxReceiptJson,
  defaultFrame,
  describeReceipt,
  describeSimulation,
  frameSigHash,
  getNonceSeq,
  prepareFrameTx,
  secp256k1Placeholder,
  sendFrameTx,
  senderFrame,
  signAll,
  simulateFrameTx,
  verifyFrame,
  waitForFrameTxReceipt,
} from '../../src/frametx/index.js'
import { Op, client, decode, dumpHash, expectedEntry, funder, introspector, model, owner, privateKey } from './introspector.js'

const self = introspector.address
console.log(`owner ${owner.address}; Introspector ${self}`)

// Setup: deploy and fund the Introspector account.
{
  const frames: Frame[] = []
  if (!(await client.getCode({ address: self }))) frames.push(introspector.deploy)
  if ((await client.getBalance({ address: self })) < parseEther('0.005')) frames.push(senderFrame({ target: self, value: parseEther('0.01'), execution: 30_000n }))
  if (frames.length) await sendFrames(client, privateKey, frames, { label: 'setup: deploy and fund the Introspector' })
  else console.log('setup: already done')
}

/**
 * Sign, then put keccak256(expected VERIFY dump) in entry 1. The max cost (TXPARAM 0x06), which
 * the dump contains, depends on how many zero bytes entry 1 has, so the placeholder has none and
 * a hash with a zero byte is rejected: the caller changes something and tries again.
 */
async function build(frames: Frame[]): Promise<FrameTx | null> {
  const nonceSeq = await getNonceSeq(client, self, [0n])
  let tx = await prepareFrameTx(client, {
    sender: self,
    frames,
    signatures: [secp256k1Placeholder(owner.address), expectedEntry(`0x${'ff'.repeat(32)}`)],
    nonceSeq,
  })
  tx = await signAll(tx, [owner.key])
  const hash = dumpHash(model(tx, 0, { legacyNonce: nonceSeq }))
  if (hash.slice(2).match(/(..)/g)?.includes('00')) return null
  return { ...tx, signatures: [tx.signatures[0], expectedEntry(hash)] }
}

async function run(label: string, make: (salt: number) => Frame[]): Promise<{ tx: FrameTx; receipt: FrameTxReceiptJson }> {
  console.log(`\n=== ${label} ===`)
  let tx: FrameTx | null = null
  for (let salt = 1; !tx; salt++) tx = await build(make(salt))
  const sim = await simulateFrameTx(client, tx)
  console.log(describeSimulation(sim))
  if (!sim.valid) throw new Error(`VERIFY's own view differs from the model, or another refusal: ${sim.violation}`)
  console.log('VERIFY: its dump hashed to the expected value (the transaction is valid)')
  const hash = await sendFrameTx(client, tx)
  const receipt = await waitForFrameTxReceipt(client, hash)
  console.log(describeReceipt(tx, receipt))
  return { tx, receipt }
}

// ---- A ----
const verify = () => verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 100_000n })
const A = await run('A. eleven frames, four dumps', (salt) => [
  verify(),
  senderFrame({ target: self, data: Op.dump, execution: 120_000n, state: 97_920n }), // 1: SENDER, with a state budget
  senderFrame({ target: funder, value: BigInt(salt), execution: 30_000n }), //            2: value out
  defaultFrame({ target: self, data: Op.dump, execution: 120_000n }), //                  3: DEFAULT
  senderFrame({ target: self, data: Op.revert, execution: 20_000n }), //                  4: FAILURE
  senderFrame({ target: self, data: Op.dump, execution: 120_000n, atomic: true }), //     5: rolled back
  senderFrame({ target: self, data: Op.revert, execution: 20_000n, atomic: true }), //    6: FAILURE in the batch
  senderFrame({ target: self, data: Op.dump, execution: 120_000n }), //                   7: SKIPPED
  senderFrame({ target: self, data: Op.dump, execution: 150_000n }), //                   8: sees 0-7
  senderFrame({ target: self, data: Op.gas, execution: 20_000n }), //                     9: opcode costs
  senderFrame({ target: self, data: Op.nested, execution: 160_000n }), //                10: one call deeper
])

const legacyNonce = A.tx.nonceSeq
let mismatches = 0
let compared = 0
for (const [i, r] of A.receipt.frameReceipts.entries()) {
  for (const log of r.logs) {
    if (log.topics.length !== 1) continue // dumps are LOG1(frame index); probes and gas are LOG0
    const frame = Number(hexToBigInt(log.topics[0]))
    const seen = decode(log.data)
    const want = model(A.tx, frame, { legacyNonce, receipts: A.receipt.frameReceipts })
    if (seen.length !== want.length) {
      console.log(`frame ${i}: ${seen.length} words logged, ${want.length} expected`)
      mismatches++
      continue
    }
    compared += want.length
    const bad = want.flatMap((w, k) => (w.value === seen[k] ? [] : [`  ${w.label}: chain ${seen[k]}, model ${w.value}`]))
    mismatches += bad.length
    console.log(`frame ${i} (${['DEFAULT', 'VERIFY', 'SENDER'][Number(A.tx.frames[i].mode)]}${i === 10 ? ', nested call' : ''}): ${want.length} words, ${bad.length ? `${bad.length} differ` : 'all equal to the model'}`)
    for (const b of bad) console.log(b)
  }
}
console.log(`${compared} words compared, ${mismatches} differ`)
console.log(`statuses as receipts report them: ${A.receipt.frameReceipts.map((r) => Number(r.status)).join(',')}; logs per frame: ${A.receipt.frameReceipts.map((r) => r.logs.length).join(',')}`)
{
  const g = decode(A.receipt.frameReceipts[9].logs[0].data)
  const names = ['TXPARAM(0x00)', 'TXPARAM(0x08) sig hash', 'TXPARAM(0x06) max cost', 'FRAMEPARAM(0x00, 0)', 'SIGPARAM(0x01, 0)', 'FRAMEDATALOAD(0, 0)']
  console.log(`opcode gas: ${names.map((n, k) => `${n} ${g[k]}`).join(', ')}`)
}

// ---- B ----
// Probe frames start at index 1; probe k sits at frame k + 1, and there are N of them.
type Probe = [string, number, bigint | number | 'self' | 'next' | 'end', bigint | number | 'self' | 'next' | 'end', string]
const probes: Probe[] = [
  ['TXPARAM(0x11), undefined', 0, 0x11, 0, 'halt'],
  ['TXPARAM(0x10), from EIP-8250', 0, 0x10, 0, 'value'],
  ['FRAMEPARAM(0x05) of the current frame', 1, 0x05, 'self', 'halt'],
  ['FRAMEPARAM(0x05) of the next frame', 1, 0x05, 'next', 'halt'],
  ['FRAMEPARAM(0x05) of frame 0 (VERIFY)', 1, 0x05, 0, 'value'],
  ['FRAMEPARAM(0x0A) of the current frame', 1, 0x0a, 'self', 'halt'],
  ['FRAMEPARAM(0x0B) of the current frame', 1, 0x0b, 'self', 'halt'],
  ['FRAMEPARAM(0x0C), undefined', 1, 0x0c, 0, 'halt'],
  ['FRAMEPARAM(0x00) of frame N (out of range)', 1, 0x00, 'end', 'halt'],
  ['FRAMEDATALOAD of frame N (out of range)', 3, 0, 'end', 'halt'],
  ['FRAMEDATALOAD past the end of the data', 3, 1000, 'self', 'value'],
  ['FRAMEDATACOPY of frame N (out of range)', 5, 0, 'end', 'halt'],
  ['SIGPARAM(0x00) of the ARBITRARY entry', 2, 0x00, 1, 'halt'],
  ['SIGPARAM(0x03) of the SECP256K1 entry', 2, 0x03, 0, 'halt'],
  ['SIGPARAM(0x04), undefined', 2, 0x04, 0, 'halt'],
  ['SIGPARAM(0x01) of entry 2 (out of range)', 2, 0x01, 2, 'halt'],
  ['SIGDATACOPY of the SECP256K1 entry', 4, 0, 0, 'halt'],
  ['SIGDATACOPY of the ARBITRARY entry', 4, 0, 1, 'value'],
  ['SIGPARAM(0x02), msg of an empty-msg entry', 2, 0x02, 0, 'value'],
  ['SIGPARAM(0x00) of the SECP256K1 entry', 2, 0x00, 0, 'value'],
]
const n = probes.length + 1
const B = await run(`B. ${probes.length} probes, one frame each`, (salt) => [
  verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 100_000n + BigInt(salt) }),
  ...probes.map(([, op, a, b], k) => {
    const at = (x: Probe[2]) => (x === 'self' ? k + 1 : x === 'next' ? k + 2 : x === 'end' ? n : x)
    return senderFrame({ target: self, data: Op.probe(op, at(a), at(b)), execution: 20_000n })
  }),
])
console.log('\n| Probe | EIP | Status | Gas | Logged |\n|---|---|---|---|---|')
for (const [k, [label, , , , want]] of probes.entries()) {
  const r = B.receipt.frameReceipts[k + 1]
  const ok = Number(r.status) === 1
  const logged = ok && r.logs[0] ? (r.logs[0].data as Hex) : ''
  console.log(`| ${label} | ${want} | ${ok ? 'success' : 'FAILURE'} | ${hexToBigInt(r.gasUsed)} | ${logged && isHex(logged) ? `0x${hexToBigInt(logged).toString(16)}` : ''} |`)
}
console.log(`sig hash ${frameSigHash(B.tx)}; entry 1 ${B.tx.signatures[1].signature}`)

// ---- C ----
console.log('\n=== C. TXPARAM outside a frame transaction (eth_call) ===')
try {
  const r = await client.call({ account: funder, to: self, data: Op.probe(0, 0, 0) })
  console.log(`returned ${JSON.stringify(r)}`)
} catch (e) {
  console.log(`failed: ${(e as Error).message.split('\n').find((l) => l.startsWith('Details:')) ?? (e as Error).message.split('\n')[0]}`)
}
