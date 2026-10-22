// Experiment 50's mined transactions (2026-10-21), checked from public data alone: no note secret
// and no owner key's private half is here.
//
// - Each update is rebuilt by device.ts's updateTx from what it carried, byte for byte, with its
//   signature entry.
// - Each proof verifies against this experiment's kernel key, with `owner` as its seventh input.
// - Each owner signature verifies over the rebuilt transaction's signature hash, by the key whose
//   address is the proof's `owner`, with low s.
// - The deploy carried the verifier and both registries; the control differs only in its last word.
import { readFileSync } from 'node:fs'
import { p256 } from '@noble/curves/p256'
import * as snarkjs from 'snarkjs'
import { type Hex, bytesToHex, concatHex, decodeFunctionData, getAddress, hexToBigInt, hexToBytes, keccak256, slice } from 'viem'
import { describe, expect, it } from 'vitest'
import { type FrameTxJson, Mode, Scheme, frameSigHash, frameTxFromJson, frameTxHash } from '../../src/frametx/index.js'
import { bindingOf } from '../32-owned-state/registry.js'
import { N, type Route, type Update, VKEY, control, keyed, registryAbi, updateTx, verifier } from './device.js'

const DEPLOY = '0x32473dfe4d2a64c12d1ce9e3fad7de371ae73a89825cba1418359a37a949d67e'
const UPDATES: { hash: Hex; what: string; route: Route }[] = [
  { hash: '0x30978e720bbf4c9968315e3714b1cc0f84e5d0a91c759078c558f6b87276b5f0', what: 'A, ARBITRARY, with change', route: 'arbitrary' },
  { hash: '0x4a2a10d30be9da33e21d222d4f1db601af7349ac1013ff525033e0080e3ce712', what: 'B, P256 entry', route: 'p256' },
  { hash: '0x545b0204e217d83ba9ce6c57194545e54a881c38546a9178fa49a73f679f8dac', what: 'C, ARBITRARY', route: 'arbitrary' },
  { hash: '0x5d83710e73f8886950c391c13460cb8bea59473badc980489b5ccdbdb3b6eb09', what: 'E, the control', route: 'none' },
]

const fixture = (hash: Hex) =>
  JSON.parse(readFileSync(new URL(`../../test/fixtures/chain/${hash}.json`, import.meta.url), 'utf8')) as { tx: FrameTxJson }

function carried(data: Hex): { root: bigint; update: Update } {
  const { args } = decodeFunctionData({ abi: registryAbi, data })
  const [root, rows] = args as unknown as [Hex, readonly (readonly bigint[])[]]
  expect(rows).toHaveLength(1)
  const r = rows[0]
  const update = {
    nullifier: r[0],
    newCommitment: r[1],
    tag: r[2],
    withdrawn: r[3],
    recipient: getAddress(`0x${r[4].toString(16).padStart(40, '0')}`),
    fee: r[5],
    owner: r[6],
    proof: r.slice(7),
  }
  return { root: hexToBigInt(root), update }
}

describe('experiment 50, a note owned by a P-256 key', () => {
  it('deployed the verifier and both registries at their addresses', () => {
    const deploys = frameTxFromJson(fixture(DEPLOY).tx).frames.filter((f) => f.mode === Mode.SENDER).map((f) => f.data)
    for (const c of [verifier, keyed, control]) expect(deploys).toContain(c.deploy.data)
    expect(keyed.initcode.slice(0, -64)).toBe(control.initcode.slice(0, -64).replace(control.rootSalt.slice(2), keyed.rootSalt.slice(2)))
  })

  for (const { hash, what, route } of UPDATES) {
    it(`rebuilds ${hash.slice(0, 10)} (${what}), verifies its proof and its owner's signature`, async () => {
      const mined = frameTxFromJson(fixture(hash).tx)
      const { root, update } = carried(mined.frames[2].data)
      const slot = hexToBigInt(slice(mined.frames[0].data, 32, 40))
      const r = route === 'none' ? control : keyed
      const rebuilt = { ...updateTx({ chainId: mined.chainId, r, root, slot, update, route }), signatures: mined.signatures }
      expect(rebuilt.signatures.map((s) => s.scheme)).toEqual(route === 'none' ? [] : [route === 'p256' ? Scheme.P256 : Scheme.ARBITRARY])
      expect(frameTxHash(rebuilt)).toBe(hash)

      const signals = [root, update.nullifier, update.newCommitment, update.tag, update.withdrawn, bindingOf(update.recipient, update.fee, update.owner), update.owner].map(String)
      const p = update.proof.map(String)
      const proof = { pi_a: [p[0], p[1], '1'], pi_b: [[p[3], p[2]], [p[5], p[4]], ['1', '0']], pi_c: [p[6], p[7], '1'], protocol: 'groth16', curve: 'bn128' }
      expect(await snarkjs.groth16.verify(VKEY, signals, proof)).toBe(true)

      if (route === 'none') return
      const sig = mined.signatures[0].signature
      const [rr, s, qx, qy] = [0, 1, 2, 3].map((i) => slice(sig, 32 * i, 32 * i + 32))
      expect(hexToBigInt(keccak256(concatHex([qx, qy]))) % (1n << 160n)).toBe(update.owner)
      expect(hexToBigInt(s) <= N / 2n).toBe(true)
      const ok = p256.verify(hexToBytes(concatHex([rr, s])), hexToBytes(frameSigHash(rebuilt)), hexToBytes(concatHex(['0x04', qx, qy])), { prehash: false })
      expect(ok).toBe(true)
      if (route === 'p256') expect(hexToBigInt(mined.signatures[0].signer!)).toBe(update.owner)
    })
  }

  it('named a fresh key in the change note: A and B show different owners', () => {
    const [a, b] = UPDATES.slice(0, 2).map(({ hash }) => carried(frameTxFromJson(fixture(hash).tx).frames[2].data).update)
    expect(a.newCommitment).not.toBe(0n)
    expect(a.owner).not.toBe(b.owner)
  })
})

describe("experiment 50's addendum, the passkey arm", async () => {
  const { sha256 } = await import('@noble/hashes/sha256')
  const { v4 } = await import('./passkey.js')
  const addendum = JSON.parse(readFileSync(new URL('./record-addendum.json', import.meta.url), 'utf8'))
  const ARMS: [Hex, string][] = [
    ['0xfa0963fc7d68b8cc7383cac3ce9fe790e96469003bfff2177689a8160f0b291c', 'P1'],
    ['0x1424c2da3b6a1637cac02ed4115e7ad60dbe264fa53537c6a1d6b4285f05746f', 'P2'],
  ]
  for (const [hash, label] of ARMS) {
    it(`rebuilds ${label} and checks its assertion as registry version 4 does`, async () => {
      const mined = frameTxFromJson(fixture(hash).tx)
      const { root, update } = carried(mined.frames[2].data)
      const slot = hexToBigInt(slice(mined.frames[0].data, 32, 40))
      const rebuilt = { ...updateTx({ chainId: mined.chainId, r: v4, root, slot, update, route: 'arbitrary' }), signatures: mined.signatures }
      expect(frameTxHash(rebuilt)).toBe(hash)
      const e = hexToBytes(mined.signatures[0].signature)
      const authLen = (e[0] << 8) | e[1]
      const clientLen = (e[2] << 8) | e[3]
      expect(e.length).toBe(8 + authLen + clientLen + 128)
      const auth = e.slice(8, 8 + authLen)
      const client = e.slice(8 + authLen, 8 + authLen + clientLen)
      const [r, s, qx, qy] = [0, 1, 2, 3].map((i) => e.slice(8 + authLen + clientLen + 32 * i, 8 + authLen + clientLen + 32 * i + 32))
      expect(bytesToHex(auth.slice(0, 32))).toBe(bytesToHex(sha256(new TextEncoder().encode('exp-frames.test'))))
      expect(auth[32] & 1).toBe(1)
      const json = JSON.parse(new TextDecoder().decode(client))
      expect(json.type).toBe('webauthn.get')
      expect(bytesToHex(Buffer.from(json.challenge, 'base64url'))).toBe(frameSigHash(rebuilt))
      const message = sha256(new Uint8Array([...auth, ...sha256(client)]))
      expect(bytesToHex(message)).toBe(addendum.assertions[label].message)
      expect(hexToBigInt(keccak256(concatHex([bytesToHex(qx), bytesToHex(qy)]))) % (1n << 160n)).toBe(update.owner)
      expect(hexToBigInt(bytesToHex(s)) <= N / 2n).toBe(true)
      expect(p256.verify(new Uint8Array([...r, ...s]), message, new Uint8Array([4, ...qx, ...qy]), { prehash: false })).toBe(true)
    })
  }

  it('records the node counting 100 for the ARBITRARY entry at both lengths', () => {
    expect([addendum.budgetP1.entryBytes, addendum.budgetP2.entryBytes]).toEqual([309, 391])
    expect([addendum.budgetP1.countedForSignatures, addendum.budgetP2.countedForSignatures]).toEqual(['100', '100'])
  })
})
