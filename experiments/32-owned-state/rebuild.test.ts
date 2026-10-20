// Experiment 32's mined transactions (2026-10-20), checked from public data alone: no secret of
// any note is here.
//
// - Each update is rebuilt by registry.ts's updateTx from what it carried (the root and its
//   slot, and each update's 15 words), byte for byte.
// - Each mined proof verifies against the kernel's key, with the binding recomputed from the
//   recipient, the fee and the link, and the key is the one the deployed verifier holds.
// - Each deposit's leaf, as the registry logged it, is H(tag, inner, value) of its call.
// - The two applications' updates of the same secrets used two different nonce keys.
import { readFileSync } from 'node:fs'
import * as snarkjs from 'snarkjs'
import { type Hex, decodeFunctionData, getAddress, hexToBigInt, slice } from 'viem'
import { describe, expect, it } from 'vitest'
import { type FrameTxJson, Mode, frameTxFromJson, frameTxHash } from '../../src/frametx/index.js'
import {
  CAP,
  DENOMINATION,
  type Update,
  VKEY,
  balance,
  bindingOf,
  fixedPool,
  leafOf,
  registry,
  registryAbi,
  storedRule,
  updateTx,
  verifier,
} from './registry.js'

const DEPLOY = '0x42741335b5d25984f9b1751c5b2aa648ebd0331a1437d3b03dc138c2c75f52d1'
const DEPOSITS = '0xae640af20f516dbd96c758097667615bb3126d8cc96affa6adfb42e0c2abe7d0'
const UPDATES: { hash: Hex; what: string }[] = [
  { hash: '0x511572f1bad85edc4be60bfe71126373d4be0f5bd8fe0d4a53f6f0e49d23a03d', what: 'A, FixedPool' },
  { hash: '0xa5b18e15e3bb1b8c4a137ac6c409029e833658fab85ab2ebfc156c8f89e82f76', what: 'B, Balance with change' },
  { hash: '0x587e541e7ad9192c57ac7e9b687a4d2222f5d1f22cc2ef1685c9429409a8492c', what: 'C, Balance, the change note' },
]

type Log = { address: Hex; topics: Hex[]; data: Hex }
const fixture = (hash: Hex) =>
  JSON.parse(readFileSync(new URL(`../../test/fixtures/chain/${hash}.json`, import.meta.url), 'utf8')) as {
    tx: FrameTxJson
    receipt: { frameReceipts: { logs: Log[] }[] }
  }

/** What frame 2 of an update carried: the root and the updates. */
function carried(data: Hex): { root: bigint; updates: Update[] } {
  const { args } = decodeFunctionData({ abi: registryAbi, data })
  const [root, rows] = args as unknown as [Hex, readonly (readonly bigint[])[]]
  const updates = rows.map((r) => ({
    nullifier: r[0],
    newCommitment: r[1],
    tag: r[2],
    withdrawn: r[3],
    recipient: getAddress(`0x${r[4].toString(16).padStart(40, '0')}`),
    fee: r[5],
    link: r[6],
    proof: r.slice(7),
  }))
  return { root: hexToBigInt(root), updates }
}

describe('experiment 32, the registry', () => {
  it('deployed the verifier, the registry and the three applications at their addresses', () => {
    const mined = frameTxFromJson(fixture(DEPLOY).tx)
    const deploys = mined.frames.filter((f) => f.mode === Mode.SENDER).map((f) => f.data)
    for (const c of [verifier, registry, fixedPool, balance, storedRule]) expect(deploys).toContain(c.deploy.data)
  })

  it("logged each deposit's leaf as H(tag, inner, value)", () => {
    const { tx, receipt } = fixture(DEPOSITS)
    const mined = frameTxFromJson(tx)
    let seen = 0
    mined.frames.forEach((f, i) => {
      if (f.mode !== Mode.SENDER) return
      const { args } = decodeFunctionData({ abi: registryAbi, data: f.data })
      const [app, inner] = args as unknown as [Hex, Hex]
      const log = receipt.frameReceipts[i].logs.find((l) => l.topics.length === 2 && getAddress(l.address) === registry.address)!
      expect(getAddress(slice(log.topics[1], 12))).toBe(getAddress(app))
      expect(hexToBigInt(slice(log.data, 0, 32))).toBe(leafOf(getAddress(app), hexToBigInt(inner), f.value))
      seen++
    })
    expect(seen).toBe(5)
  })

  for (const { hash, what } of UPDATES) {
    it(`rebuilds ${hash.slice(0, 10)} (${what}) and verifies its proof`, async () => {
      const mined = frameTxFromJson(fixture(hash).tx)
      const { root, updates } = carried(mined.frames[2].data)
      const slot = hexToBigInt(slice(mined.frames[0].data, 32, 40))
      const rebuilt = updateTx({ chainId: mined.chainId, root, slot, updates, fees: mined.fees })
      expect(frameTxHash(rebuilt)).toBe(hash)
      for (const u of updates) {
        const signals = [root, u.nullifier, u.newCommitment, u.tag, u.withdrawn, bindingOf(u.recipient, u.fee, u.link)].map(String)
        const p = u.proof.map(String)
        const proof = { pi_a: [p[0], p[1], '1'], pi_b: [[p[3], p[2]], [p[5], p[4]], ['1', '0']], pi_c: [p[6], p[7], '1'], protocol: 'groth16', curve: 'bn128' }
        expect(await snarkjs.groth16.verify(VKEY, signals, proof)).toBe(true)
      }
    })
  }

  it('gave the same secrets two nonce keys, one per application', () => {
    const [a, b] = UPDATES.slice(0, 2).map(({ hash }) => frameTxFromJson(fixture(hash).tx))
    expect(carried(a.frames[2].data).updates[0].tag).toBe(hexToBigInt(fixedPool.address))
    expect(carried(b.frames[2].data).updates[0].tag).toBe(hexToBigInt(balance.address))
    expect(a.nonceKeys).toHaveLength(1)
    expect(b.nonceKeys).toHaveLength(1)
    expect(a.nonceKeys[0]).not.toBe(b.nonceKeys[0])
    expect(carried(a.frames[2].data).updates[0].withdrawn).toBe(DENOMINATION)
    expect(carried(b.frames[2].data).updates[0].withdrawn).toBeLessThanOrEqual(CAP)
  })
})
