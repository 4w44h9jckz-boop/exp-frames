// Experiment 38's record, checked against this repository's own code: kohaku-rs rendered every
// review, and here viem and src/frametx recompute what each review rests on. The descriptors are
// the ones beside this file, the transactions are the fixtures and experiment 27's cases, and
// the facts are the hashes, E and its typed data, the maximum cost, the CREATE2 address of each
// deploy and the selector of every format a review used.
import { readFileSync, readdirSync } from 'node:fs'
import { type Hex, getAddress, getContractAddress, hashTypedData, keccak256, pad, parseEther, slice, toFunctionSelector } from 'viem'
import { describe, expect, it } from 'vitest'
import { type FrameTx, type FrameTxJson, frameSigHash, frameTxFromJson, frameTxHash, maxCost } from '../../src/frametx/index.js'
import { type Eip8250, executionDigest, executionTypedData } from '../27-execution-digest/digest.js'
import { OWNER, accountRuntime, harnessCases } from '../27-execution-digest/vectors.js'

type Gap = { frame?: number; kind: string; blind: boolean; why: string }
type Line = { section: string; frame?: number; label: string; value: string; source: string }
type Render = {
  id: string
  shape: string
  input: 'transaction' | 'typed data'
  eip8250: 'F3079a0' | 'Master'
  txHash?: Hex
  sigHash?: Hex
  executionDigest: Hex
  expected?: 'valid' | 'refused'
  typedData?: { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> }
  review: { signs: { kind: string }; intent: string; lines: Line[]; gaps: Gap[] }
  without: Record<string, { intent: string; gaps: Gap[]; blind: number }>
}

const here = (p: string) => new URL(p, import.meta.url)
const record = JSON.parse(readFileSync(here('./record.json'), 'utf8')) as { descriptors: { path: string; keccak256: Hex }[]; renders: Render[] }
const json = (p: string) => JSON.parse(readFileSync(here(`./descriptors/${p}`), 'utf8'))
const rulesOf = (r: Render): Eip8250 => (r.eip8250 === 'Master' ? 'master' : 'f3079a0')
const line = (r: Render, label: string) => r.review.lines.find((l) => l.label === label)?.value
const blind = (r: Render) => r.review.gaps.filter((g) => g.blind)

const fixture = (prefix: string): FrameTx => {
  const dir = here('../../test/fixtures/chain/')
  const file = readdirSync(dir).find((f) => f.startsWith(prefix))!
  return frameTxFromJson((JSON.parse(readFileSync(new URL(file, dir), 'utf8')) as { tx: FrameTxJson }).tx)
}

/** Every value as a lowercase string, so viem's bigints and kohaku-rs's JSON compare. */
const norm = (v: unknown): unknown => {
  if (typeof v === 'bigint' || typeof v === 'number') return v.toString()
  if (typeof v === 'string') return /^\d+$/.test(v) ? v : v.toLowerCase()
  if (Array.isArray(v)) return v.map(norm)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)]))
  return v
}

describe('the descriptors', () => {
  it('are the files kohaku-rs read, byte for byte', () => {
    expect(record.descriptors.length).toBe(8)
    for (const d of record.descriptors) expect(keccak256(readFileSync(here(`./descriptors/${d.path}`))), d.path).toBe(d.keccak256)
  })

  it('bind the account code the experiments deployed', () => {
    // ExecutionScopeAccount: experiment 27's runtime, before its owner word.
    const esa = json('accounts/execution-scope-account.json')
    expect(esa.context.account.runtimeCode).toBe(slice(accountRuntime(OWNER), 0, -32))
    // SimpleAccount and SessionAccount: the creation code their deploy frames carry, then the owner.
    for (const [file, prefix, at, owner] of [
      ['accounts/simple-account.json', '0x9882637a', '0x998bB2F3B526e56D12415D02b36580E295fc2B78', '0xa93CEe06b1e4fFACdf920BD500cb301a39DdEB74'],
      ['accounts/session-account.json', '0x922d2f82', '0x49f30D74edd539CdB026Bd05f05B9359C719276A', '0xb66e53f7394a5069933103cad898194181f8574e'],
    ] as const) {
      const deployer = getAddress(json('system/create2-deployer.json').context.deployer.deployments[0].address)
      const frame = fixture(prefix).frames.find((f) => f.target && getAddress(f.target) === deployer)!
      const salt = slice(frame.data, 0, 32)
      const initcode = slice(frame.data, 32)
      expect(initcode, file).toBe(`${json(file).context.account.creationCode}${pad(owner).slice(2)}`.toLowerCase())
      expect(getContractAddress({ opcode: 'CREATE2', from: deployer, salt, bytecode: initcode }), file).toBe(at)
    }
  })

  it('key formats by selectors the frames they showed carry', () => {
    const selectors = new Map<string, string[]>()
    for (const f of readdirSync(here('./descriptors/erc7730/'))) {
      const d = json(`erc7730/${f}`)
      selectors.set(`ERC-7730: ${d.context.$id}`, Object.keys(d.display.formats).map((k) => toFunctionSelector(`function ${k}`)))
    }
    let checked = 0
    for (const r of record.renders.filter((r) => r.id.startsWith('chain/'))) {
      const tx = fixture(r.id.slice(6))
      for (const l of r.review.lines.filter((l) => l.source.startsWith('ERC-7730'))) {
        expect(selectors.get(l.source), r.id).toContain(slice(tx.frames[l.frame!].data, 0, 4))
        checked++
      }
    }
    expect(checked).toBeGreaterThan(40)
  })
})

describe('the transactions behind the reviews', () => {
  it('the chain fixtures: hash, signature hash and maximum cost', () => {
    const chain = record.renders.filter((r) => r.id.startsWith('chain/'))
    expect(chain.length).toBe(19)
    for (const r of chain) {
      const tx = fixture(r.id.slice(6))
      expect(frameTxHash(tx), r.id).toBe(r.txHash)
      expect(frameSigHash(tx), r.id).toBe(r.sigHash)
      expect(executionDigest(tx, 'f3079a0'), r.id).toBe(r.executionDigest)
      // "at most X ETH (...)": the bound with the blob fee at its maximum.
      const shown = line(r, 'Max fee')!.match(/^at most ([\d.]+) ETH/)![1]
      expect(parseEther(shown), r.id).toBe(maxCost(tx, tx.fees.maxFeePerBlobGas))
    }
  })

  it("experiment 27's cases: hash, E and the typed data, under each revision", async () => {
    const harness = { master: await harnessCases('master'), f3079a0: await harnessCases('f3079a0') }
    const exp27 = record.renders.filter((r) => r.id.startsWith('exp27-'))
    expect(exp27.filter((r) => r.input === 'transaction').length).toBe(19 + 20 + 1)
    expect(exp27.filter((r) => r.input === 'typed data').length).toBe(11 + 12 + 1)
    for (const r of exp27) {
      const [set, rest] = r.id.split('/')
      const name = rest.split(/[,/]/)[0]
      const c = harness[set === 'exp27-master' ? 'master' : 'f3079a0'].find((c) => c.name === name)!
      const rules = rulesOf(r)
      expect(executionDigest(c.tx, rules), r.id).toBe(r.executionDigest)
      if (r.input === 'transaction') {
        expect(frameTxHash(c.tx), r.id).toBe(r.txHash)
        expect(frameSigHash(c.tx), r.id).toBe(r.sigHash)
        // The cross-revision render has no verdict of its own.
        if (!r.id.includes('read under')) expect(r.expected, r.id).toBe(c.expect)
      } else {
        const ours = executionTypedData(c.tx, rules)
        const { EIP712Domain: _, ...types } = r.typedData!.types
        expect(norm({ ...r.typedData, types }), r.id).toEqual(norm(ours))
        expect(hashTypedData(ours), r.id).toBe(r.executionDigest)
      }
    }
  })
})

describe('what each shape shows', () => {
  const shape = (s: string) => record.renders.filter((r) => r.shape === s && r.input === 'transaction')

  it('a sponsored transfer, an atomic batch, a deploy frame and a session redemption, without the account code', () => {
    // The mined ones: every frame described, nothing blind.
    for (const s of ['sponsored atomic batch', 'atomic batch', 'independent calls', 'deploy frame', 'session redemption', 'session grant', 'session revocation']) {
      const chain = shape(s).filter((r) => r.id.startsWith('chain/'))
      expect(chain.length, s).toBeGreaterThan(0)
      for (const r of chain) expect(blind(r), r.id).toEqual([])
    }
    // Experiment 27's sponsored transfers, under both revisions.
    for (const r of shape('sponsored transfer')) {
      expect(blind(r), r.id).toEqual([])
      expect(line(r, 'Payer'), r.id).toMatch(/^not signed: any payer may complete it/)
    }
    // The session's limits are the one thing a redemption cannot show: they are in storage.
    for (const r of shape('session redemption')) expect(r.review.gaps.map((g) => g.kind)).toEqual(['state'])
  })

  it("experiment 27's synthetic calls are the only blind frames, and the descriptors are what removes the rest", () => {
    for (const r of record.renders.filter((r) => r.id.startsWith('exp27-') && r.expected !== 'refused')) {
      for (const g of blind(r)) {
        expect(g.kind, r.id).toBe('noDescriptor')
        expect(g.why, r.id).toMatch(/0x27000000000000000000000000000000000000(11|12|2\d|3\d)|no ERC-7730 file binds 0x2700/)
      }
      // Without the account descriptor, a signature over E says nothing about what the account does with it.
      expect(r.without.withoutAccountDescriptors.gaps.some((g) => g.kind === 'account' && g.blind), r.id).toBe(true)
    }
    // The transaction alone: every call frame blind, the protocol lines all there.
    for (const r of record.renders.filter((r) => r.id.startsWith('chain/0x') && r.shape.includes('batch'))) {
      expect(r.without.transactionAlone.blind, r.id).toBeGreaterThan(0)
      expect(r.without.transactionAlone.gaps.every((g) => g.kind === 'noDescriptor'), r.id).toBe(true)
    }
  })

  it("experiment 27's refused cases are flagged, by the account's rule or by a digest that is no longer E", () => {
    const refused = record.renders.filter((r) => r.expected === 'refused')
    expect(refused.length).toBe(8 + 8)
    for (const r of refused) {
      const kinds = r.review.gaps.map((g) => g.kind).filter((k) => k === 'refusal' || k === 'opaque')
      const name = r.id.split('/')[1]
      expect(kinds, r.id).toEqual([name === 'self-paying' || name === 'payer-is-sender' ? 'refusal' : 'opaque'])
    }
  })

  it('the same nonce bytes read as two nonces under the two revisions', () => {
    const [master, old] = ['exp27-master/key-zero', 'exp27-master/key-zero, read under f3079a0'].map((id) => record.renders.find((r) => r.id === id)!)
    expect(line(master, 'Nonce')).toBe('keys [0] at sequence 0, in NONCE_MANAGER')
    expect(line(old, 'Nonce')).toBe('the account nonce, 0')
    expect(master.sigHash).toBe(old.sigHash)
    expect(master.executionDigest).toBe(old.executionDigest)
    // From typed data alone, the keys are a hash, unless they are the legacy selection.
    const typed = record.renders.filter((r) => r.input === 'typed data')
    for (const r of typed) {
      const hashOnly = r.review.gaps.some((g) => g.kind === 'hashOnly')
      expect(hashOnly, r.id).toBe(line(r, 'Nonce')!.startsWith('keys with hash'))
    }
    expect(typed.filter((r) => r.review.gaps.some((g) => g.kind === 'hashOnly')).map((r) => r.id)).toEqual([
      'exp27-f3079a0/keyed-nonces/typed',
      'exp27-master/keyed-nonces/typed',
      'exp27-master/key-zero/typed',
    ])
  })
})
