import { readdirSync, readFileSync } from 'node:fs'
import { type Hex, hexToBigInt, isAddressEqual, recoverAddress, serializeSignature } from 'viem'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import {
  Approve,
  Scheme,
  encodePayload,
  frameSigHash,
  frameTxFromJson,
  frameTxHash,
  parseFrameTx,
  secp256k1Placeholder,
  senderFrame,
  serializeFrameTx,
  settledGasUsed,
  signFrameTx,
  verifyFrame,
  type FrameTx,
  type FrameTxJson,
  type FrameTxReceiptJson,
} from '../src/frametx/index.js'

/** Recover the signer of a 65-byte yParity||r||s entry. */
async function recover(digest: Hex, sig: Hex) {
  const yParity = Number.parseInt(sig.slice(2, 4), 16)
  const r = `0x${sig.slice(4, 68)}` as Hex
  const s = `0x${sig.slice(68, 132)}` as Hex
  return recoverAddress({ hash: digest, signature: serializeSignature({ r, s, yParity }) })
}

describe('ethrex golden vector (scripts/hegota-testnet/frametx.py)', () => {
  const golden: FrameTx = {
    chainId: 1n,
    nonceKeys: [0n],
    nonceSeq: 7n,
    sender: '0x000000000000000000000000000000000000ABcD',
    frames: [
      { mode: 1, flags: 3, target: null, limits: { execution: 0x5208n, state: 0n }, value: 0n, data: '0x1122' },
      {
        mode: 2,
        flags: 0,
        target: '0x0000000000000000000000000000000000001234',
        limits: { execution: 0x9c40n, state: 0n },
        value: 0n,
        data: '0x',
      },
    ],
    signatures: [
      {
        scheme: Scheme.SECP256K1,
        signer: '0x000000000000000000000000000000000000ABcD',
        msg: '0x',
        signature: `0x${'01'.repeat(65)}`,
      },
    ],
    fees: { maxPriorityFeePerGas: 0x3b9aca00n, maxFeePerGas: 0x6fc23ac00n, maxFeePerBlobGas: 0n },
    blobVersionedHashes: [],
  }

  it('encodes to the golden RLP', () => {
    expect(encodePayload(golden)).toBe(
      '0xf8b201c1800794000000000000000000000000000000000000abcdeccc010380c48252088080821122de0280940000000000000000000000000000000000001234c4829c40808080f85cf85a0194000000000000000000000000000000000000abcd80b8410101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101cc843b9aca008506fc23ac0080c0',
    )
  })

  it('computes the golden sig hash', () => {
    expect(frameSigHash(golden)).toBe('0x73827d510b0029220c237a46b27f6b6b8e7a3fd3b52c42a55c6c6e343fc45951')
  })

  it('round-trips through the decoder', () => {
    expect(parseFrameTx(serializeFrameTx(golden))).toEqual(golden)
  })
})

describe('mined testnet transactions', () => {
  const dir = new URL('./fixtures/chain/', import.meta.url)
  const fixtures = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map(
      (f) =>
        JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as {
          // The RPC does not expose the EIP-3529 refund counter. Fixtures whose execution clears
          // storage record it in meta.refund (derived from ethrex's SSTORE rules) with a note.
          meta?: { refund?: string }
          tx: FrameTxJson
          receipt: FrameTxReceiptJson
        },
    )

  it('has fixtures', () => expect(fixtures.length).toBeGreaterThan(0))

  for (const { meta, tx: json, receipt } of fixtures) {
    describe(`${json.hash.slice(0, 10)} (${json.frames.length} frames)`, () => {
      const tx = frameTxFromJson(json)

      it('re-encodes to the on-chain hash', () => {
        expect(frameTxHash(tx)).toBe(json.hash)
        expect(parseFrameTx(serializeFrameTx(tx))).toEqual(tx)
      })

      it('every empty-msg secp256k1 signature recovers to its signer over our sig hash', async () => {
        const sigHash = frameSigHash(tx)
        for (const s of tx.signatures.filter((s) => s.scheme === Scheme.SECP256K1)) {
          const digest = s.msg === '0x' ? sigHash : s.msg
          expect(isAddressEqual(await recover(digest, s.signature), s.signer ?? tx.sender)).toBe(true)
        }
      })

      it('settles to the receipt gasUsed', () => {
        const frames = receipt.frameReceipts.map((f) => ({
          execution: hexToBigInt(f.gasUsed),
          state: hexToBigInt(f.stateGasUsed),
        }))
        expect(settledGasUsed(tx, frames, BigInt(meta?.refund ?? 0))).toBe(hexToBigInt(receipt.gasUsed))
      })
    })
  }
})

describe('signFrameTx', () => {
  it('signs the sig hash with a bare recovery id and low s', async () => {
    const key = generatePrivateKey()
    const sender = privateKeyToAddress(key)
    const unsigned: FrameTx = {
      chainId: 8141n,
      nonceKeys: [0n],
      nonceSeq: 0n,
      sender,
      frames: [
        verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 10_000n }),
        senderFrame({ target: '0x000000000000000000000000000000000000dEaD', value: 1n, execution: 30_000n }),
      ],
      signatures: [secp256k1Placeholder()],
      fees: { maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, maxFeePerBlobGas: 0n },
      blobVersionedHashes: [],
    }
    const signed = await signFrameTx(unsigned, key)
    const sig = signed.signatures[0].signature
    expect(sig.length).toBe(2 + 130)
    expect(['00', '01']).toContain(sig.slice(2, 4))
    const s = BigInt(`0x${sig.slice(68)}`)
    expect(s <= 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n).toBe(true)
    // Filling an empty-msg signature must not change the sig hash.
    expect(frameSigHash(signed)).toBe(frameSigHash(unsigned))
    expect(isAddressEqual(await recover(frameSigHash(signed), sig), sender)).toBe(true)
  })

  it('refuses a key that matches no entry', async () => {
    const tx: FrameTx = {
      chainId: 1n,
      nonceKeys: [0n],
      nonceSeq: 0n,
      sender: '0x000000000000000000000000000000000000dEaD',
      frames: [],
      signatures: [secp256k1Placeholder()],
      fees: { maxPriorityFeePerGas: 0n, maxFeePerGas: 0n, maxFeePerBlobGas: 0n },
      blobVersionedHashes: [],
    }
    await expect(signFrameTx(tx, generatePrivateKey())).rejects.toThrow(/no SECP256K1/)
  })
})
