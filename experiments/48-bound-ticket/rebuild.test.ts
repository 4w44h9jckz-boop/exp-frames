// Experiment 48's run (2026-10-21), checked from public data alone: no key, mnemonic or blinding
// factor is here.
// - The bound paymaster's template is BoundTicketPaymaster.yul as compiled here, and the unbound
//   one is experiment 36's: their lengths and keccak256 are the ones the mempool's profile names.
// - Every bound ticket spent verifies, under the committee's key, over the 152-byte message with
//   its binder, and carries an entry its binder signed over the transaction's signature hash.
// - Each bound copy is refused for the reason the binding gives: a binder signature over another
//   hash, no binder entry, or a binder the ticket does not name.
// - The unbound control's copy, which no one signed, was mined in the original's place.
// - Neither binder appears in anything the issuers saw.
import { readFileSync } from 'node:fs'
import { type Address, type Hex, concatHex, getAddress, keccak256, recoverAddress, serializeSignature, size, slice } from 'viem'
import { describe, expect, it } from 'vitest'
import { compileYul } from '../../src/contracts.js'
import { type FrameTx, type FrameTxJson, Mode, frameSigHash, frameTxFromJson, frameTxHash, parseFrameTx } from '../../src/frametx/index.js'
import { g1FromEip2537, g2, ticketMessage, ticketPoint, verifies } from '../36-blind-tickets/tickets.js'

type Tried = { what: string; hash: Hex; raw: Hex; simulation: { valid: boolean; violation: string | null }; sent: { result?: Hex; error?: string } }
type Mined = { what: string; hash: Hex; raw: Hex; block: Hex | number; gasUsed: Hex | number; payer: Address }
const record = JSON.parse(readFileSync(new URL('./record.json', import.meta.url), 'utf8')) as {
  committeeKey: Hex
  epoch: number
  boundPaymaster: Address
  unboundPaymaster: Address
  boundTemplate: { length: number; keccak256: Hex }
  unboundTemplate: { length: number; keccak256: Hex }
  tickets: { bound: { sender: Address; binder: Address; point: Hex }[]; unbound: { sender: Address; point: Hex }[] }
  issuers: { index: number; saw: Hex[] }[]
  steps: { hash: Hex }[]
  spends: Mined[]
  control: (Tried | Mined)[]
  binding: (Tried | Mined)[]
}
const fixture = (hash: Hex) =>
  JSON.parse(readFileSync(new URL(`../../test/fixtures/chain/${hash}.json`, import.meta.url), 'utf8')) as {
    tx: FrameTxJson
    receipt: { payer: Address; frameReceipts: { gasUsed: Hex; status: Hex }[] }
  }
const key = g2(record.committeeKey)

/** The pay frame's data, 188 bytes when bound. */
function payData(tx: FrameTx) {
  const f = tx.frames.find((x) => x.mode === Mode.VERIFY && x.target && [record.boundPaymaster, record.unboundPaymaster].map((a) => a.toLowerCase()).includes(x.target.toLowerCase()))!
  return f.data
}

/** The bound message, the ticket's point, and whether the signature verifies under the key. */
function boundTicketVerifies(tx: FrameTx, data: Hex) {
  const epoch = BigInt(slice(data, 0, 8))
  const binder = getAddress(slice(data, 40, 60))
  const message = concatHex([ticketMessage(tx, epoch, slice(data, 8, 40)), binder])
  expect(size(message)).toBe(152)
  return { binder, ok: verifies(ticketPoint(message), g1FromEip2537(slice(data, 60)), key) }
}

/** The address each secp256k1 entry with an empty msg recovers over the signature hash. */
async function signers(tx: FrameTx) {
  const out: { signer: Address | null; recovered: Address }[] = []
  for (const s of tx.signatures) {
    if (s.scheme !== 1 || s.msg !== '0x') continue
    const sig = s.signature
    const recovered = await recoverAddress({
      hash: frameSigHash(tx),
      signature: serializeSignature({ r: slice(sig, 1, 33), s: slice(sig, 33, 65), yParity: Number(slice(sig, 0, 1)) }),
    })
    out.push({ signer: s.signer ? getAddress(s.signer) : null, recovered: getAddress(recovered) })
  }
  return out
}

const byWhat = (list: (Tried | Mined)[], part: string) => list.find((s) => s.what.includes(part))!

describe("experiment 48's run (2026-10-21)", () => {
  it('compiles the templates the profile names', () => {
    const bound = compileYul('experiments/48-bound-ticket/BoundTicketPaymaster.yul')
    // The 25-byte constructor copies the runtime and appends the key and the denomination.
    const runtime = slice(bound, 25)
    expect(size(runtime)).toBe(record.boundTemplate.length)
    expect(keccak256(runtime)).toBe(record.boundTemplate.keccak256)
    const unbound = slice(compileYul('experiments/36-blind-tickets/TicketPaymaster.yul'), 25)
    expect([size(unbound), keccak256(unbound)]).toEqual([1105, '0xec9f3f855524392a3891f2f2eb554781236d5565520d68388e455be74bdf3fe0'])
    expect(record.unboundTemplate).toEqual({ length: 1105, keccak256: keccak256(unbound) })
  })

  it('re-encodes every mined transaction to its hash', () => {
    const mined = [...record.steps, ...record.spends, byWhat(record.control, 'mined'), byWhat(record.binding, 'mined')]
    for (const s of mined) expect(frameTxHash(frameTxFromJson(fixture(s.hash).tx))).toBe(s.hash)
  })

  it('pays a fresh sender with a bound ticket its binder signed', async () => {
    const s = byWhat(record.spends, ', bound ticket') as Mined
    const tx = frameTxFromJson(fixture(s.hash).tx)
    expect(getAddress(fixture(s.hash).receipt.payer)).toBe(getAddress(record.boundPaymaster))
    const { binder, ok } = boundTicketVerifies(tx, payData(tx))
    expect(ok).toBe(true)
    expect(binder).toBe(getAddress(record.tickets.bound[0].binder))
    const sigs = await signers(tx)
    expect(sigs).toContainEqual({ signer: binder, recovered: binder })
  })

  it("pays the pool's withdrawal, signed by no one but the binder, and refuses its three copies", async () => {
    const original = byWhat(record.binding, 'bound: mined') as Mined
    const tx = frameTxFromJson(fixture(original.hash).tx)
    expect(getAddress(tx.sender)).toBe(getAddress('0x73e47a8DA2C83Beb802708Fc473B5B7D094f3eE6'))
    expect(tx.signatures).toHaveLength(1)
    const { binder, ok } = boundTicketVerifies(tx, payData(tx))
    expect(ok).toBe(true)
    expect(await signers(tx)).toEqual([{ signer: binder, recovered: binder }])

    const c1 = byWhat(record.binding, 'signature kept') as Tried
    const t1 = parseFrameTx(c1.raw)
    expect(t1.fees.maxPriorityFeePerGas).toBe(tx.fees.maxPriorityFeePerGas + tx.fees.maxPriorityFeePerGas / 10n)
    // The binder's signature no longer recovers to the binder over the copy's hash.
    expect((await signers(t1))[0].recovered).not.toBe(binder)
    expect(c1.simulation.violation).toBe('frame signature list does not authenticate the sender')

    const c2 = byWhat(record.binding, 'entry removed') as Tried
    expect(parseFrameTx(c2.raw).signatures).toHaveLength(0)
    expect(c2.simulation.violation).toBe('validation prefix frame reverted')

    const c3 = byWhat(record.binding, 'another key') as Tried
    const t3 = parseFrameTx(c3.raw)
    const other = boundTicketVerifies(t3, payData(t3))
    expect(other.binder).not.toBe(binder)
    expect(other.ok).toBe(false)
    expect((await signers(t3))[0]).toEqual({ signer: other.binder, recovered: other.binder })
    expect(c3.simulation.violation).toBe('validation prefix frame reverted')
    for (const c of [c1, c2, c3]) expect(c.sent.error).toBeDefined()
  })

  it("mined the unbound control's copy, which no one signed, in the original's place", () => {
    const [first, copy, mined] = record.control as [Tried, Tried, Mined]
    expect(first.sent.result).toBe(first.hash)
    expect(copy.sent.result).toBe(copy.hash)
    expect(mined.hash).toBe(copy.hash)
    const t = frameTxFromJson(fixture(mined.hash).tx)
    expect(t.signatures).toHaveLength(0)
    expect(t.fees.maxPriorityFeePerGas).toBe(parseFrameTx(first.raw).fees.maxPriorityFeePerGas * 11n / 10n)
    expect(getAddress(fixture(mined.hash).receipt.payer)).toBe(getAddress(record.unboundPaymaster))
  })

  it('shows the issuers uniformly random points, none of them a ticket, and no binder', () => {
    const saw = record.issuers.flatMap((i) => i.saw)
    expect(saw).toHaveLength(12)
    const points = [...record.tickets.bound, ...record.tickets.unbound].map((t) => t.point)
    for (const p of points) expect(saw).not.toContain(p)
    const binders = record.tickets.bound.map((t) => t.binder.toLowerCase().slice(2))
    for (const b of saw) for (const binder of binders) expect(b.toLowerCase()).not.toContain(binder)
  })
})
