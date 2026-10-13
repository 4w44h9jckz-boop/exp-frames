// Experiment 10: expiry verifier frames that break a rule, simulated and then sent. A case the
// node accepts is followed until it is mined or dropped, so the next case starts clean.
//
// Protocol rules (EIP-8141 §Expiry Verifier Frame): flags == 0, value == 0, limits.state == 0,
// len(data) == 8, at most one per transaction. Mempool rule: it may appear only as the first frame.
//
// usage: npx tsx experiments/10-expiry/negative.ts
import { Approve, type Frame, Mode, senderFrame } from '../../src/frametx/index.js'
import { eoaTx, follow, fundedAccount, funder, headTimestamp, probe, rawExpiry, selfVerify, tip } from './common.js'

const sender = await fundedAccount('late')
const soon = (await headTimestamp()) + 600n
const ok = (over: Partial<Frame> = {}) => rawExpiry({ deadline: soon, ...over })

const cases: [string, Frame[]][] = [
  ['baseline: [expiry, self_verify, transfer]', [ok(), selfVerify, tip(funder)]],
  ['deadline 2^64 - 1', [rawExpiry(), selfVerify, tip(funder)]],
  ['flags = APPROVE_PAYMENT', [ok({ flags: Approve.PAYMENT }), selfVerify, tip(funder)]],
  ['flags = APPROVE_EXECUTION', [ok({ flags: Approve.EXECUTION }), selfVerify, tip(funder)]],
  ['value = 1 wei', [ok({ value: 1n }), selfVerify, tip(funder)]],
  ['limits.state = 1', [ok({ limits: { execution: 5_000n, state: 1n } }), selfVerify, tip(funder)]],
  ['data of 7 bytes', [ok({ data: `0x${(soon >> 8n).toString(16).padStart(14, '0')}` }), selfVerify, tip(funder)]],
  ['data of 9 bytes', [ok({ data: `0x${soon.toString(16).padStart(16, '0')}00` }), selfVerify, tip(funder)]],
  ['empty data', [ok({ data: '0x' }), selfVerify, tip(funder)]],
  ['deadline 0', [rawExpiry({ deadline: 0n }), selfVerify, tip(funder)]],
  ['two expiry frames', [ok(), ok(), selfVerify, tip(funder)]],
  ['expiry after self_verify', [selfVerify, ok(), tip(funder)]],
  ['expiry as the last frame', [selfVerify, tip(funder), ok()]],
  ['execution limit 3,000 (the cold access alone)', [ok({ limits: { execution: 3_000n, state: 0n } }), selfVerify, tip(funder)]],
  ['execution limit 3,050', [ok({ limits: { execution: 3_050n, state: 0n } }), selfVerify, tip(funder)]],
  ['execution limit 3,051', [ok({ limits: { execution: 3_051n, state: 0n } }), selfVerify, tip(funder)]],
  ['SENDER frame to EXPIRY_VERIFIER, deadline 0, after the prefix', [selfVerify, { ...senderFrame({ target: ok().target, execution: 5_000n }), data: rawExpiry({ deadline: 0n }).data }, tip(funder)]],
  ['DEFAULT frame to EXPIRY_VERIFIER, deadline 0, first', [{ ...ok(), mode: Mode.DEFAULT, data: rawExpiry({ deadline: 0n }).data }, selfVerify, tip(funder)]],
  ['DEFAULT frame to EXPIRY_VERIFIER, future deadline, first', [{ ...ok(), mode: Mode.DEFAULT }, selfVerify, tip(funder)]],
]

for (const [label, frames] of cases) {
  const { hash } = await probe(label, await eoaTx(sender.key, frames))
  if (hash) console.log(`    -> ${await follow(hash, 30_000)}`)
}
