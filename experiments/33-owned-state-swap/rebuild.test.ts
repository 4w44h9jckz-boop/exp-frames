// Experiment 33's mined transactions (2026-10-20), checked from public data alone.
//
// - The swap and the two owners' own updates are rebuilt by swap.ts's updateTx from what they
//   carried, byte for byte, and every proof verifies with the deadline in its binding.
// - In the swap, each update names the other's nullifier and change note.
// - Each posted message is a sealed offer or answer, by its length and version byte.
// - vector.json seals to the same bytes again, and opens.
import { readFileSync } from 'node:fs'
import * as snarkjs from 'snarkjs'
import { type Hex, decodeFunctionData, getAddress, hexToBigInt, hexToBytes, slice } from 'viem'
import { describe, expect, it } from 'vitest'
import { type FrameTxJson, Mode, frameTxFromJson, frameTxHash } from '../../src/frametx/index.js'
import { VKEY, bindingOf, registryAbi } from '../32-owned-state/registry.js'
import { boardAbi, decodeAccept, decodeOffer, encodeAccept, encodeOffer, offerId, open, seal } from './announce.js'
import { assetB, board, pairLink, registry, updateTx } from './swap.js'

const DEPLOY = '0x5b6337411c4dc5f064d997092c7bc402945ec72d79eab80464ed51561cde08b8'
const UPDATES: { hash: Hex; what: string; k: number }[] = [
  { hash: '0x5c365fc175720516a5b42c6698bb6c5c49d04a3ee6e7afeeed0417163b5b31c6', what: 'N1, the swap', k: 2 },
  { hash: '0xb3ad9012421ceb90f2036ac487245f1287ad00b686b00354623da809f397a59d', what: 'N1, Alice spends what she got', k: 1 },
  { hash: '0x7cf64acf879235591a839a839245eaf695a9388e6092be939f35b9df4b75a3a5', what: 'N3, Alice cancels', k: 1 },
]
const POSTS: { hash: Hex; kind: 'offer' | 'answer' }[] = [
  { hash: '0x3b738bc4148383dd59b95cb25f072060152a5374238e8a53144da3c1bdececf5', kind: 'offer' },
  { hash: '0xcaf0a6750deecf96ccbb5343f70e9d53c487ad3748e98169bf734509515d3758', kind: 'answer' },
  { hash: '0x26c2a5dbd21c43b5dae25d297b3b16a30afe107e4537d21763f289eb898278f7', kind: 'offer' },
  { hash: '0x112912eeb61a6cafc5d88af3ea32425ffb9b66c07be4da76b84abce890f94d4b', kind: 'answer' },
  { hash: '0xbd11755a16be048d3230aa886417a9d82a9bdaf3010dac6de0425aabdf8d3e15', kind: 'offer' },
  { hash: '0xcb150c4958a7297544b2cabc6354f1c5648c2f4874cb05863e970b71f0263625', kind: 'answer' },
]

const fixture = (hash: Hex) =>
  JSON.parse(readFileSync(new URL(`../../test/fixtures/chain/${hash}.json`, import.meta.url), 'utf8')) as { tx: FrameTxJson }

function carried(data: Hex) {
  const { args } = decodeFunctionData({ abi: registryAbi, data })
  const [root, rows] = args as unknown as [Hex, readonly (readonly bigint[])[]]
  return {
    root: hexToBigInt(root),
    updates: rows.map((r) => ({
      nullifier: r[0],
      newCommitment: r[1],
      tag: r[2],
      withdrawn: r[3],
      recipient: getAddress(`0x${r[4].toString(16).padStart(40, '0')}`),
      fee: r[5],
      link: r[6],
      proof: r.slice(7),
    })),
  }
}

describe('experiment 33, the swap', () => {
  it('deployed registry v2, asset B and the board at their addresses', () => {
    const deploys = frameTxFromJson(fixture(DEPLOY).tx).frames.filter((f) => f.mode === Mode.SENDER).map((f) => f.data)
    for (const c of [registry, assetB, board]) expect(deploys).toContain(c.deploy.data)
  })

  for (const { hash, what, k } of UPDATES) {
    it(`rebuilds ${hash.slice(0, 10)} (${what}) and verifies its proofs`, async () => {
      const mined = frameTxFromJson(fixture(hash).tx)
      const deadline = hexToBigInt(mined.frames[0].data)
      const slot = hexToBigInt(slice(mined.frames[1].data, 32, 40))
      const { root, updates } = carried(mined.frames[3].data)
      expect(updates).toHaveLength(k)
      expect(frameTxHash(updateTx({ chainId: mined.chainId, root, slot, deadline, updates }))).toBe(hash)
      for (const u of updates) {
        const signals = [root, u.nullifier, u.newCommitment, u.tag, u.withdrawn, bindingOf(u.recipient, u.fee, u.link, deadline)].map(String)
        const p = u.proof.map(String)
        const proof = { pi_a: [p[0], p[1], '1'], pi_b: [[p[3], p[2]], [p[5], p[4]], ['1', '0']], pi_c: [p[6], p[7], '1'], protocol: 'groth16', curve: 'bn128' }
        expect(await snarkjs.groth16.verify(VKEY, signals, proof)).toBe(true)
        // Without the deadline, as experiment 32's registry would bind it, the proof fails.
        signals[5] = String(bindingOf(u.recipient, u.fee, u.link))
        expect(await snarkjs.groth16.verify(VKEY, signals, proof)).toBe(false)
      }
      if (k === 2) {
        const [x, y] = updates
        expect(x.link).toBe(pairLink(y.nullifier, y.newCommitment))
        expect(y.link).toBe(pairLink(x.nullifier, x.newCommitment))
        expect(x.tag).not.toBe(y.tag)
        expect([x.newCommitment, y.newCommitment].every((c) => c !== 0n)).toBe(true)
      } else expect(updates[0].link).toBe(0n)
    })
  }

  it('posted three sealed offers and three sealed answers', () => {
    for (const { hash, kind } of POSTS) {
      const frame = frameTxFromJson(fixture(hash).tx).frames.find((f) => f.mode === Mode.SENDER)!
      expect(frame.target).toBe(board.address)
      const { args } = decodeFunctionData({ abi: boardAbi, data: frame.data })
      const m = hexToBytes(args[0] as Hex)
      expect(m[0]).toBe(1)
      // 2 + 33 + 16 bytes around a 182-byte offer or a 137-byte answer.
      expect(m.length).toBe(51 + (kind === 'offer' ? 182 : 137))
    }
  })

  it('seals vector.json to the same bytes, and opens it', () => {
    const v = JSON.parse(readFileSync(new URL('./vector.json', import.meta.url), 'utf8'))
    expect(seal(v.keys.bob.public, v.offer.plaintext, v.keys.offerEphemeral)).toBe(v.offer.message)
    expect(seal(v.keys.alice.public, v.accept.plaintext, v.keys.acceptEphemeral)).toBe(v.accept.message)
    expect(offerId(v.offer.message)).toBe(v.offer.id)
    const offer = decodeOffer(open(v.keys.bob.secret, v.offer.message)!)!
    expect(encodeOffer(offer)).toBe(v.offer.plaintext)
    expect(open(v.keys.alice.secret, v.offer.message)).toBeUndefined()
    const accept = decodeAccept(open(v.keys.alice.secret, v.accept.message)!)!
    expect(accept.offer).toBe(v.offer.id)
    expect(encodeAccept(accept)).toBe(v.accept.plaintext)
  })
})
