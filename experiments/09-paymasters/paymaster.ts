import { type Address, type Hex, concatHex, keccak256, numberToHex, pad, toHex } from 'viem'
import { privateKeyToAddress } from 'viem/accounts'
import { compileYul } from '../../src/contracts.js'
import { create2Address, deployFrame, saltOf } from '../../src/deploy.js'
import { loadKey } from '../../src/env.js'
import {
  Approve,
  type Frame,
  type FrameTx,
  type FrameTxFees,
  NEW_ACCOUNT_STATE_GAS,
  STORAGE_SET_STATE_GAS,
  makeClient,
  prepareFrameTx,
  rpc,
  secp256k1Placeholder,
  senderFrame,
  serializeFrameTx,
  signAll,
  verifyFrame,
  waitForFrameTxReceipt,
} from '../../src/frametx/index.js'

export const { privateKey, address: funder } = loadKey()
export const client = makeClient()

export const CANONICAL_CODE_HASH = '0xda42f0d11838c4c0c3129b8b8e93e9718127ad6b315e517e1088125707c4d45c'
const CANONICAL = compileYul('experiments/09-paymasters/CanonicalPaymaster.yul')
const NON_CANONICAL = compileYul('experiments/09-paymasters/NonCanonicalPaymaster.yul')
const MULTISIG = compileYul('experiments/09-paymasters/Multisig.yul')

/** secp256k1 keys derived from PRIVATE_KEY: the same accounts on every run, nothing stored. */
export function derive(label: string): { key: Hex; address: Address } {
  const key = keccak256(concatHex([privateKey, toHex(`exp-frames/09/${label}`)]))
  return { key, address: privateKeyToAddress(key) }
}

/** The sponsor's signing key. It signs; it never needs to hold ETH for the paymaster path. */
export const sponsor = derive('sponsor')

/** A paymaster instance: canonical runtime, or the one-byte-longer control, with `signer` in slot 0. */
export function paymaster(kind: 'canonical' | 'non-canonical', label: string, signer: Address = sponsor.address) {
  const initcode = concatHex([kind === 'canonical' ? CANONICAL : NON_CANONICAL, pad(signer)])
  const salt = saltOf(`exp-frames/09/${label}`)
  return {
    kind,
    label,
    address: create2Address(initcode, salt),
    // The constructor writes slot 0: one fresh slot on top of the account and the code.
    deploy: deployFrame(initcode, salt, STORAGE_SET_STATE_GAS).frame,
  }
}

/** A k-of-n multisig (experiment 05's code) used as a payer. */
export function treasury(owners: Address[], k: number, label: string) {
  const initcode = concatHex([MULTISIG, ...owners.map((o) => pad(o)), numberToHex(owners.length, { size: 32 }), numberToHex(k, { size: 32 })])
  const salt = saltOf(`exp-frames/09/${label}`)
  return { owners, k, address: create2Address(initcode, salt), deploy: deployFrame(initcode, salt).frame }
}

/** `only_verify` through the sender's default code: entry 0, scope EXECUTION. */
export const onlyVerify = verifyFrame({ scope: Approve.EXECUTION, execution: 20_000n })

/** `pay`: VERIFY(PAYMENT) aimed at the payer. State gas covers APPROVE creating a new sender. */
export const payFrame = (payer: Address, senderExists: boolean, execution = 15_000n): Frame =>
  verifyFrame({ scope: Approve.PAYMENT, target: payer, execution, state: senderExists ? 0n : NEW_ACCOUNT_STATE_GAS })

/** A 0-value call to the funder: the user op of a user who holds no ETH. */
export const ping = senderFrame({ target: funder, execution: 30_000n })

export const exists = async (address: Address) => (await client.getTransactionCount({ address })) > 0 || (await client.getBalance({ address })) > 0n

/**
 * A sponsored transaction: [only_verify, pay, ...ops], entry 0 by the user, entry 1 by the
 * payer's signer (the canonical paymaster reads index 1). Signed by `keys`.
 */
export async function sponsored(
  user: { key: Hex; address: Address },
  payer: Address,
  keys: Hex[],
  opts: { ops?: Frame[]; payExecution?: bigint; extraEntries?: Address[]; fees?: FrameTxFees; nonceSeq?: bigint } = {},
): Promise<FrameTx> {
  const tx = await prepareFrameTx(client, {
    sender: user.address,
    frames: [onlyVerify, payFrame(payer, await exists(user.address), opts.payExecution), ...(opts.ops ?? [ping])],
    signatures: [secp256k1Placeholder(), ...(opts.extraEntries ?? [sponsor.address]).map((a) => secp256k1Placeholder(a))],
    fees: opts.fees,
    nonceSeq: opts.nonceSeq,
  })
  return signAll(tx, [user.key, ...keys])
}

const detail = (e: Error) => e.message.split('\n').find((l) => l.startsWith('Details:'))?.slice(9) ?? e.message.split('\n')[0]

/** Send signed transactions back to back, as fast as the RPC takes them, and report each verdict. */
export async function burst(label: string, txs: FrameTx[]) {
  console.log(`\n=== ${label} ===`)
  const raws = txs.map(serializeFrameTx)
  const results = await Promise.all(raws.map((raw) => rpc<Hex>(client, 'eth_sendRawTransaction', [raw]).then((hash) => ({ hash }), (e: Error) => ({ error: detail(e) }))))
  results.forEach((r, i) => console.log(`  [${i}] ${'hash' in r ? `accepted ${r.hash}` : `rejected: ${r.error}`}`))
  const mined = await Promise.all(
    results.map(async (r) => {
      if (!('hash' in r)) return null
      try {
        const receipt = await waitForFrameTxReceipt(client, r.hash, { timeoutMs: 40_000 })
        return { hash: r.hash, block: BigInt(receipt.blockNumber), gasUsed: BigInt(receipt.gasUsed), payer: receipt.payer, frames: receipt.frameReceipts }
      } catch {
        return { hash: r.hash, block: null }
      }
    }),
  )
  mined.forEach((m, i) => m && console.log(`  [${i}] ${m.block === null ? 'no receipt (dropped)' : `mined in block ${m.block}, gasUsed ${m.gasUsed}, payer ${m.payer}`}`))
  return mined
}
