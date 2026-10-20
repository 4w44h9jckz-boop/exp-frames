// Every batch dapp.ts sent, rebuilt by wallet.ts's layout from what a wallet decides: the calls,
// whether they are atomic, the payer's quote, the envelope, and each call frame's execution
// budget tightened from its use. Eight were sent by wallet.ts itself and four by kohaku-rs's
// Rust wallet (`crates/frame-wallet`, dapp.ts's second run with RUST_WALLET on 2026-10-20), so
// each implementation rebuilds the other's.
//
// The users' keys are not here: a rebuild must reach the mined signature hash, and with the
// mined signature put back, the mined transaction byte for byte.
import { readFileSync } from 'node:fs'
import { type Hex, hexToBigInt, numberToHex } from 'viem'
import { describe, expect, it } from 'vitest'
import { ATOMIC_BATCH_FLAG, Approve, type FrameTxJson, Mode, frameSigHash, frameTxFromJson, frameTxHash, serializeFrameTx, secp256k1Placeholder } from '../../src/frametx/index.js'
import { type Call, type PaymasterResult, batchFrames, tightened, withPayer } from './wallet.js'

const MINED: { hash: Hex; by: string }[] = [
  { hash: '0x32eb0bc5548ec482973ab785f4f49c5e9bee5668db7959324ba1a7f45590cd9e', by: 'wallet.ts, B' },
  { hash: '0x9688c1f8e5ea5f0a3fe6b8c3416d45488e06c7433e763332b18db2ede10710d7', by: 'wallet.ts, C' },
  { hash: '0x78564f0a39b40b1b7ada544bc0750c1894e3faa2a322b0c9d736f2e489928042', by: 'wallet.ts, D' },
  { hash: '0x3fc65c1d54cc3d4c422b8d38c0fec14725702f9a124d5d24e22f561e453d327b', by: 'wallet.ts, E' },
  { hash: '0x9489899ebee99bbbda3c7274ea86ee8108df1bcf3ce33eaa2238f188219c6fde', by: 'wallet.ts, rails r1 self-paid' },
  { hash: '0x57135ff7a484a2f92030479de7ae0fae015519bf8e19a0822ab641a069eaf3ad', by: 'wallet.ts, rails r1 sponsored' },
  { hash: '0x644424feaff57ea728c954f367be786567b713dcef7f49fe5feb2ee5d855067d', by: 'wallet.ts, rails r2 self-paid' },
  { hash: '0xd3c04b29114f2fc0742183f5c63d5a5af7676250993d4a4f9e903457550b6bc8', by: 'wallet.ts, rails r2 sponsored' },
  { hash: '0x28885722e31dd0b8d61bcb2ec18c25a9bd7818ccb895cc173c227d7b53fee0a6', by: 'kohaku-rs, B' },
  { hash: '0x0cd8150d99b5f9ebbb8a5d67d04a9b5c03118332bb5d1e700da28db19a7e5461', by: 'kohaku-rs, C' },
  { hash: '0x6c5d0038a0c09e444358946f7484a8c4202b7cc625dd5e97f01fff4bfaf15bc1', by: 'kohaku-rs, D' },
  { hash: '0xf00c9f2cc87d4f1220e967f5c947365896f454786921e344af7c1ab1b0c73886', by: 'kohaku-rs, E' },
]

const fixture = (hash: Hex) =>
  JSON.parse(readFileSync(new URL(`../../test/fixtures/chain/${hash}.json`, import.meta.url), 'utf8')) as {
    tx: FrameTxJson
    receipt: { frameReceipts: { gasUsed: Hex }[] }
  }

describe('experiment 28 batches, rebuilt', () => {
  for (const { hash, by } of MINED) {
    it(`${hash.slice(0, 10)} (${by})`, () => {
      const { tx: json, receipt } = fixture(hash)
      const mined = frameTxFromJson(json)
      const callIdx = mined.frames.flatMap((f, i) => (f.mode === Mode.SENDER ? [i] : []))
      const calls: Call[] = callIdx.map((i) => ({ to: mined.frames[i].target!, data: mined.frames[i].data, value: numberToHex(mined.frames[i].value) }))
      const atomic = (mined.frames[callIdx[0]].flags & ATOMIC_BATCH_FLAG) !== 0
      const pay = mined.frames.find((f) => f.mode === Mode.VERIFY && f.flags === Approve.PAYMENT && f.target !== null)
      const execution = callIdx.map((i) => tightened(hexToBigInt(receipt.frameReceipts[i].gasUsed)))

      let tx = {
        ...mined,
        frames: batchFrames(calls, { atomic, sponsored: pay !== undefined, execution }),
        signatures: [secp256k1Placeholder()],
      }
      if (pay) {
        const post = mined.frames.find((f) => f.mode === Mode.DEFAULT && f.target === pay.target)
        const quote: PaymasterResult = {
          paymaster: pay.target!,
          paymasterData: pay.data,
          paymasterVerificationGasLimit: numberToHex(pay.limits.execution),
          paymasterStateGasLimit: numberToHex(pay.limits.state),
          paymasterPostOpGasLimit: numberToHex(post?.limits.execution ?? 0n),
          paymasterSignatures: mined.signatures.slice(1).map((s) => ({ scheme: numberToHex(s.scheme), signer: s.signer, msg: s.msg, signature: s.signature })),
        }
        tx = withPayer(tx, quote, mined.sender)
      }

      expect(frameSigHash(tx)).toBe(frameSigHash(mined))
      const signed = { ...tx, signatures: [{ ...tx.signatures[0], signature: mined.signatures[0].signature }, ...tx.signatures.slice(1)] }
      expect(signed).toEqual(mined)
      expect(serializeFrameTx(signed)).toBe(serializeFrameTx(mined))
      expect(frameTxHash(signed)).toBe(hash)
    })
  }
})
