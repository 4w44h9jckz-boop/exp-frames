import { readFileSync } from 'node:fs'
import { type Hex, keccak256, recoverAddress, stringToHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { ATOMIC_BATCH_FLAG, type Frame, type FrameTx, type FrameTxJson, Mode, frameTxFromJson, secp256k1Sign } from '../../src/frametx/index.js'
import {
  DOMAIN_NAME,
  DOMAIN_TYPEHASH,
  DOMAIN_VERSION,
  FRAME_EXECUTION_TYPEHASH,
  FRAME_TYPEHASH,
  executionDigest,
  executionDigestByHand,
  executionTypedData,
  isPayFrame,
} from './digest.js'
import { CASES, OWNER_KEY, SENDER, signCase } from './vectors.js'

const E = executionDigest
const PAY = CASES.find((c) => c.name === 'sponsored-transfer')!.tx
const payIndex = PAY.frames.findIndex(isPayFrame)
const transferIndex = PAY.frames.findIndex((f) => f.mode === Mode.SENDER)

const withFrame = (tx: FrameTx, i: number, patch: Partial<Frame>): FrameTx => ({
  ...tx,
  frames: tx.frames.map((f, j) => (j === i ? { ...f, ...patch } : f)),
})

describe('the two implementations', () => {
  it('agree on every vector', () => {
    for (const c of CASES) expect(executionDigestByHand(c.tx), c.name).toBe(E(c.tx))
  })

  it('the account embeds the same constants', () => {
    const yul = readFileSync(new URL('./ExecutionScopeAccount.yul', import.meta.url), 'utf8')
    for (const h of [
      FRAME_TYPEHASH,
      FRAME_EXECUTION_TYPEHASH,
      DOMAIN_TYPEHASH,
      keccak256(stringToHex(DOMAIN_NAME)),
      keccak256(stringToHex(DOMAIN_VERSION)),
      keccak256('0x'),
    ])
      expect(yul).toContain(h)
  })
})

describe('what E leaves to the payer', () => {
  it('the pay frame target, limits and data', () => {
    const other = withFrame(PAY, payIndex, {
      target: '0x00000000000000000000000000000000000000bb',
      limits: { execution: 77_777n, state: 1n },
      data: '0xdeadbeef',
    })
    expect(E(other)).toBe(E(PAY))
  })

  it('the fees and the signature list', () => {
    const other: FrameTx = {
      ...PAY,
      fees: { maxPriorityFeePerGas: 10n ** 10n, maxFeePerGas: 10n ** 12n, maxFeePerBlobGas: 0n },
      signatures: [...PAY.signatures, { scheme: 0, signer: null, msg: '0x', signature: '0x01' }],
    }
    expect(E(other)).toBe(E(PAY))
  })

  it('whether a target is written out or left null, when it resolves to the sender', () => {
    const i = PAY.frames.findIndex((f) => f.target === null)
    expect(i).toBeGreaterThanOrEqual(0)
    expect(E(withFrame(PAY, i, { target: SENDER }))).toBe(E(PAY))
  })
})

describe('what E pins', () => {
  const changed = (label: string, tx: FrameTx) => expect(E(tx), label).not.toBe(E(PAY))

  it('every field of every frame that is not a pay frame', () => {
    const f = PAY.frames[transferIndex]
    changed('mode', withFrame(PAY, transferIndex, { mode: Mode.DEFAULT }))
    changed('flags', withFrame(PAY, transferIndex, { flags: ATOMIC_BATCH_FLAG }))
    changed('target', withFrame(PAY, transferIndex, { target: '0x00000000000000000000000000000000000000cc' }))
    changed('execution limit', withFrame(PAY, transferIndex, { limits: { ...f.limits, execution: f.limits.execution + 1n } }))
    changed('state limit', withFrame(PAY, transferIndex, { limits: { ...f.limits, state: f.limits.state + 1n } }))
    changed('value', withFrame(PAY, transferIndex, { value: f.value + 1n }))
    changed('data', withFrame(PAY, transferIndex, { data: `${f.data}00` as Hex }))
  })

  it("a pay frame's mode, flags and value", () => {
    changed('pay frame becomes scope NONE', withFrame(PAY, payIndex, { flags: 0 }))
    changed('pay frame value', withFrame(PAY, payIndex, { value: 1n }))
  })

  it('the number and the order of the frames', () => {
    const extra = { ...PAY.frames[transferIndex], mode: Mode.DEFAULT }
    changed('inserted', { ...PAY, frames: [...PAY.frames.slice(0, transferIndex), extra, ...PAY.frames.slice(transferIndex)] })
    changed('appended', { ...PAY, frames: [...PAY.frames, extra] })
    changed('dropped', { ...PAY, frames: PAY.frames.slice(0, -1) })
    const two = CASES.find((c) => c.name === 'atomic-approve-swap')!.tx
    const swapped = { ...two, frames: [two.frames[0], two.frames[1], two.frames[3], two.frames[2]] }
    expect(E(swapped)).not.toBe(E(two))
  })

  it('the chain, the sender, the nonce keys, the sequence and the blobs', () => {
    changed('chain', { ...PAY, chainId: PAY.chainId + 1n })
    changed('sender', { ...PAY, sender: '0x00000000000000000000000000000000000000dd' })
    changed('nonce keys', { ...PAY, nonceKeys: [0n, 7n] })
    changed('nonce sequence', { ...PAY, nonceSeq: PAY.nonceSeq + 1n })
    changed('a blob', { ...PAY, blobVersionedHashes: [`0x01${'ab'.repeat(31)}`] })
  })
})

describe('one layout for both envelopes', () => {
  it('a plain EIP-8141 envelope with nonce 7 digests as nonce_keys [0] at sequence 7', () => {
    const keyed = CASES.find((c) => c.name === 'legacy-nonce-7')!.tx
    expect(E({ ...keyed, envelope: 'plain' })).toBe(E(keyed))
  })
})

describe('a wallet that knows nothing of frames', () => {
  it("gives the same entry as signing E directly, so the protocol's ecrecover over msg accepts it", async () => {
    const c = CASES[0]
    const viaTypedData = (await signCase(c.tx)).signatures[0].signature
    expect(viaTypedData).toBe(await secp256k1Sign(E(c.tx), OWNER_KEY))
  })

  it('signs E through eth_signTypedData_v4, and the signature recovers over E', async () => {
    const owner = privateKeyToAccount(OWNER_KEY)
    for (const c of CASES) {
      const signature = await owner.signTypedData(executionTypedData(c.tx))
      expect(await recoverAddress({ hash: E(c.tx), signature })).toBe(owner.address)
    }
  })
})

describe('the chain', () => {
  const mined = (hash: string): FrameTx =>
    frameTxFromJson((JSON.parse(readFileSync(new URL(`../../test/fixtures/chain/${hash}.json`, import.meta.url), 'utf8')) as { tx: FrameTxJson }).tx)

  it("mined sponsor 2's replacement, whose owner entry carries E as its msg", () => {
    const tx = mined('0xffb402794317f1adc6617a60fd084b1d2f60677627a4003106f1af4095482d01')
    expect(tx.signatures[0].msg).toBe(E(tx))
    expect(E(tx)).toBe('0xa99797993af177ec8e997116d725ffc75be782d5704450019c5ec1c5addf242d')
  })

  it('and the three- and six-frame transactions of scenario C', () => {
    for (const h of ['0x34ae87b165ac15ca705fbb9eb513bf7dd8d3482d35271ea9faa7393621bb3d58', '0x9b4fd03bfa47ebf7a5d46605ed8a65ad0af1dbe80ab6918447b406c477011cc5']) {
      const tx = mined(h)
      expect(tx.signatures[0].msg).toBe(E(tx))
    }
  })
})
