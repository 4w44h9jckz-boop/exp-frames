// Experiment 40's mined transactions (2026-10-20), checked from public data alone: no secret of
// any note is here.
//
// - Each update is rebuilt by custody.ts's updateTx from what it carried, byte for byte.
// - Each proof verifies against experiment 32's kernel key, with the scope recomputed from the
//   vault the update names and the context from its recipient, fee and the transaction's fees.
// - Each deposit's leaf, as the registry logged it, is H(scope, inner, value) of its call.
// - Every payment an update made, as its receipt logs it, came from the vault of its note.
// - The control: experiment 32's update, mined from a copy with another priority fee, carried a
//   proof that verifies whatever the transaction's fees are.
import { readFileSync } from 'node:fs'
import * as snarkjs from 'snarkjs'
import { type Address, type Hex, decodeFunctionData, getAddress, hexToBigInt, slice } from 'viem'
import { describe, expect, it } from 'vitest'
import { type FrameTxJson, Mode, frameTxFromJson, frameTxHash } from '../../src/frametx/index.js'
import * as v32 from '../32-owned-state/registry.js'
import { VKEY } from '../32-owned-state/registry.js'
import {
  CAP,
  DENOMINATION,
  FEE,
  FEES,
  FLOAT,
  type Update,
  contextOf,
  leafOf,
  registry,
  registryAbi,
  scopeOf,
  updateTx,
  vaultA,
  vaultB,
  vaultC,
} from './custody.js'

const record = JSON.parse(readFileSync(new URL('./record.json', import.meta.url), 'utf8')) as {
  chainId: Hex
  rows: { step: string; outcome: string; hash?: Hex; effectiveGasPrice?: Hex; balances?: Record<string, Hex> }[]
  final: Record<string, Hex>
  raised: { maxPriorityFeePerGas: Hex; maxFeePerGas: Hex }
}
const chainId = hexToBigInt(record.chainId)
const vaults = [vaultA, vaultB, vaultC]
const vaultAt = (a: Address) => vaults.find((v) => v.address === getAddress(a))!

const DEPLOY = '0x34181a825e9cf8b3180ba45642aa7cc6d0887248047f710dd2fa813278605b3f'
const DEPOSITS = '0x78a32be20e034d2a0b6d6bf9da11da6ab2cb8ed031a5c053fd16edd7556e88aa'
const UPDATES: { hash: Hex; step: string; vault: Address }[] = [
  { hash: '0xdc4debd1c5050b21921893c84220dd88665155071e412000e292d15a1596084b', step: 'A.', vault: vaultA.address },
  { hash: '0x4e1ceffa630e9479d5839bef550b78521e5ad4637a05bf804018f00ac3a9d485', step: 'B1.', vault: vaultB.address },
  { hash: '0xb8c106513ddacdc937ec57c2b635f8feb1cb5d9d2ed5130b3524240da141971a', step: 'B2.', vault: vaultB.address },
]
const CONTROL = '0x59272e374c551bae00b271f03b7313a28ab16b2d4d6253e95ba1d698f074b305'
const PAID = '0x737c69225d647e5994eab1a6c301bf6d9232beb2759ae1e27a8966b4732bc489'

type Log = { address: Hex; topics: Hex[]; data: Hex }
const fixture = (hash: Hex) =>
  JSON.parse(readFileSync(new URL(`../../test/fixtures/chain/${hash}.json`, import.meta.url), 'utf8')) as {
    tx: FrameTxJson
    receipt: { frameReceipts: { logs: Log[] }[] }
  }

function carried(data: Hex): { root: bigint; update: Update } {
  const { args } = decodeFunctionData({ abi: registryAbi, data })
  const [root, rows] = args as unknown as [Hex, readonly (readonly bigint[])[]]
  expect(rows.length).toBe(1)
  const r = rows[0]
  expect(r[6]).toBe(0n)
  return {
    root: hexToBigInt(root),
    update: {
      nullifier: r[0],
      newCommitment: r[1],
      vault: getAddress(`0x${r[2].toString(16).padStart(40, '0')}`),
      withdrawn: r[3],
      recipient: getAddress(`0x${r[4].toString(16).padStart(40, '0')}`),
      fee: r[5],
      proof: r.slice(7),
    },
  }
}

const verifies = (proof: bigint[], signals: bigint[]) =>
  snarkjs.groth16.verify(VKEY, signals.map(String), {
    pi_a: [String(proof[0]), String(proof[1]), '1'],
    pi_b: [[String(proof[3]), String(proof[2])], [String(proof[5]), String(proof[4])], ['1', '0']],
    pi_c: [String(proof[6]), String(proof[7]), '1'],
    protocol: 'groth16',
    curve: 'bn128',
  })

describe('experiment 40, one registry with a vault per application', () => {
  it('deployed the registry and the three vaults at their addresses, and gave the registry its float', () => {
    const mined = frameTxFromJson(fixture(DEPLOY).tx)
    const senders = mined.frames.filter((f) => f.mode === Mode.SENDER)
    for (const c of [registry, ...vaults]) expect(senders.map((f) => f.data)).toContain(c.deploy.data)
    expect(senders.some((f) => f.target === registry.address && f.value === FLOAT)).toBe(true)
  })

  it('gives A and its twin C the same parameters and different scopes', () => {
    expect(vaultA.kind).toBe(vaultC.kind)
    expect(vaultA.amount).toBe(vaultC.amount)
    expect(new Set(vaults.map((v) => scopeOf(v, chainId))).size).toBe(3)
  })

  it("logged each deposit's leaf as H(scope, inner, value), the value going to the vault", () => {
    const { tx, receipt } = fixture(DEPOSITS)
    const mined = frameTxFromJson(tx)
    let seen = 0
    mined.frames.forEach((f, i) => {
      if (f.mode !== Mode.SENDER) return
      const { args } = decodeFunctionData({ abi: registryAbi, data: f.data })
      const [vault, inner] = args as unknown as [Address, Hex]
      const log = receipt.frameReceipts[i].logs.find((l) => l.topics.length === 2 && getAddress(l.address) === registry.address)!
      expect(getAddress(slice(log.topics[1], 12))).toBe(getAddress(vault))
      expect(hexToBigInt(slice(log.data, 0, 32))).toBe(leafOf(scopeOf(vaultAt(vault), chainId), hexToBigInt(inner), f.value))
      seen++
    })
    expect(seen).toBe(4)
  })

  for (const u of UPDATES) {
    it(`rebuilds ${u.step} byte for byte, verifies its proof under its vault's scope, and paid from that vault only`, async () => {
      const { tx, receipt } = fixture(u.hash)
      const mined = frameTxFromJson(tx)
      const { root, update } = carried(mined.frames[2].data)
      expect(update.vault).toBe(u.vault)
      const slot = hexToBigInt(slice(mined.frames[0].data, 32, 40))
      const rebuilt = updateTx({ chainId, root, slot, update, fees: mined.fees })
      expect(frameTxHash(rebuilt)).toBe(u.hash)
      expect(mined.fees).toEqual(FEES)
      const scope = scopeOf(vaultAt(update.vault), chainId)
      const signals = [root, update.nullifier, update.newCommitment, scope, update.withdrawn, contextOf(update.recipient, update.fee, mined.fees)]
      expect(await verifies(update.proof, signals)).toBe(true)
      // Under any other vault's scope, or other fees, the same proof fails.
      for (const other of vaults.filter((v) => v.address !== update.vault)) {
        expect(await verifies(update.proof, [root, update.nullifier, update.newCommitment, scopeOf(other, chainId), update.withdrawn, signals[5]])).toBe(false)
      }
      const raised = { ...mined.fees, maxPriorityFeePerGas: hexToBigInt(record.raised.maxPriorityFeePerGas), maxFeePerGas: hexToBigInt(record.raised.maxFeePerGas) }
      expect(await verifies(update.proof, [...signals.slice(0, 5), contextOf(update.recipient, update.fee, raised)])).toBe(false)
      // Every payment in the update frame came from the note's vault: the recipient's and the fee.
      const paid = receipt.frameReceipts[2].logs.filter((l) => l.topics[0] === PAID)
      expect(paid.map((l) => getAddress(l.address))).toEqual([u.vault, u.vault])
      expect(paid.map((l) => getAddress(slice(l.topics[1], 12)))).toEqual([update.recipient, registry.address])
      expect(paid.map((l) => hexToBigInt(l.data))).toEqual([update.withdrawn - update.fee, FEE])
    })
  }

  it("shows each vault paying exactly its own application's withdrawals, step by step", () => {
    const rows = record.rows.filter((r) => r.balances)
    const at = (step: string) => {
      const b = rows.find((r) => r.step.startsWith(step))!.balances!
      return Object.fromEntries(Object.entries(b).map(([k, v]) => [k, hexToBigInt(v)]))
    }
    const setup = at('setup')
    expect(setup).toMatchObject({ 'vault/a': 2n * DENOMINATION, 'vault/b': 3n * DENOMINATION, 'vault/c': DENOMINATION, registry: FLOAT })
    expect(at('A.')).toMatchObject({ 'vault/a': DENOMINATION, 'vault/b': 3n * DENOMINATION, 'vault/c': DENOMINATION })
    expect(at('B1.')).toMatchObject({ 'vault/a': DENOMINATION, 'vault/b': 2n * DENOMINATION, 'vault/c': DENOMINATION })
    expect(at('B2.')).toMatchObject({ 'vault/a': DENOMINATION, 'vault/b': 0n, 'vault/c': DENOMINATION })
    expect(CAP).toBe(2n * DENOMINATION)
    // The registry paid each update's gas from its float, and each vault paid it the fee back.
    expect(hexToBigInt(record.final.registry) > FLOAT).toBe(true)
  })

  it('refused every crossing and every copy before inclusion, and admitted the positive control', () => {
    const outcome = (step: string) => record.rows.find((r) => r.step.startsWith(step))!.outcome
    for (const s of ['X1.', 'X2.', 'X4.', 'Y1.', 'Y2. ']) {
      expect(outcome(s)).toContain('refused: validation prefix frame reverted')
      expect(outcome(s)).toContain('eth_sendRawTransaction refused')
    }
    expect(outcome('X3.')).toContain('the prover fails')
    expect(outcome('Y2, the positive control')).toBe('valid in simulation')
  })

  it("mined the control: experiment 32's update, copied with a higher priority fee, its proof blind to the fees", async () => {
    const { tx } = fixture(CONTROL)
    const mined = frameTxFromJson(tx)
    expect(mined.sender).toBe(v32.registry.address)
    expect(mined.fees.maxPriorityFeePerGas).toBe(hexToBigInt(record.raised.maxPriorityFeePerGas))
    const { args } = decodeFunctionData({ abi: v32.registryAbi, data: mined.frames[2].data })
    const [root, rows] = args as unknown as [Hex, readonly (readonly bigint[])[]]
    const r = rows[0]
    const recipient = getAddress(`0x${r[4].toString(16).padStart(40, '0')}`)
    const signals = [hexToBigInt(root), r[0], r[1], r[2], r[3], v32.bindingOf(recipient, r[5], r[6])]
    expect(await verifies(r.slice(7), signals)).toBe(true)
    const z = record.rows.find((x) => x.step.startsWith('Z1.'))!
    expect(z.hash).toBe(CONTROL)
    expect(hexToBigInt(z.effectiveGasPrice!)).toBeGreaterThan(1000n * 8n)
  })
})
