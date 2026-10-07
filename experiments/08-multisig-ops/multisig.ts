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
  Mode,
  STORAGE_SET_STATE_GAS,
  expiryFrame,
  getNonceSeq,
  makeClient,
  prepareFrameTx,
  secp256k1Placeholder,
  signAll,
  verifyFrame,
} from '../../src/frametx/index.js'

export const { privateKey, address: funder } = loadKey()
export const client = makeClient()

const IMPL = compileYul('experiments/08-multisig-ops/MultisigImpl.yul')
const CODE_PROXY = compileYul('experiments/08-multisig-ops/CodeProxy.yul')
const STORAGE_PROXY = compileYul('experiments/08-multisig-ops/StorageProxy.yul')

/** secp256k1 owner keys derived from PRIVATE_KEY. */
export function derive(label: string): { key: Hex; address: Address } {
  const key = keccak256(concatHex([privateKey, toHex(`exp-frames/08/${label}`)]))
  return { key, address: privateKeyToAddress(key) }
}
export const [alice, bob, carol, dave] = ['alice', 'bob', 'carol', 'dave'].map(derive)

const implSalt = saltOf('exp-frames/08/impl/v1')
export const impl = { address: create2Address(IMPL, implSalt), deploy: deployFrame(IMPL, implSalt).frame }

/** The owner set as the VERIFY frame carries it: k (1 byte) ‖ owners (20 bytes each). */
export type OwnerSet = { owners: { key: Hex; address: Address }[]; k: number }
export const config = (s: OwnerSet): Hex => concatHex([numberToHex(s.k, { size: 1 }), ...s.owners.map((o) => o.address)])
export const commitment = (s: OwnerSet): Hex => keccak256(config(s))

export type Account = ReturnType<typeof account>

/** A counterfactual multisig behind a CodeProxy (commitment in code) or a StorageProxy (slot 0). */
export function account(kind: 'code' | 'storage', initial: OwnerSet, label: string) {
  const initcode = concatHex([kind === 'code' ? CODE_PROXY : STORAGE_PROXY, pad(impl.address), commitment(initial)])
  const salt = saltOf(`exp-frames/08/${label}`)
  const { frame } = deployFrame(initcode, salt, kind === 'storage' ? STORAGE_SET_STATE_GAS : 0n)
  return {
    kind,
    initial,
    address: create2Address(initcode, salt),
    /** DEFAULT frame at the head of the account's own first transaction (Example 1b). */
    deployAtSender: { ...frame, mode: Mode.DEFAULT, limits: { ...frame.limits, execution: 80_000n } } satisfies Frame,
  }
}

/** A fresh EIP-8250 nonce key, one per proposal. */
export const proposalKey = (label: string): bigint => BigInt(keccak256(toHex(`exp-frames/08/proposal/${label}`))) >> 8n

export type ProposalOpts = {
  /** EIP-8250 key; 0 (the default) is the account nonce. */
  nonceKey?: bigint
  nonceSeq?: bigint
  fees?: FrameTxFees
  /** Prepend an expiry verifier frame. */
  deadline?: bigint
  /** Prepend the account's own deployment (its first transaction). */
  deploy?: Frame
}

/**
 * A proposal: [expiry?] [deploy?] VERIFY(owner set) ops…, with one signature entry per signer.
 * Unsigned: owners sign it with `sign`, in any order, on any machine.
 */
export async function proposal(acct: Account, set: OwnerSet, signers: Address[], ops: Frame[], opts: ProposalOpts = {}): Promise<FrameTx> {
  const key = opts.nonceKey ?? 0n
  const seq = opts.nonceSeq ?? (await getNonceSeq(client, acct.address, [key]))
  // First use of a key creates its slot in the nonce manager: 97,920 state gas, charged when
  // APPROVE increments it.
  const verify = verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 40_000n, data: config(set), state: key !== 0n && seq === 0n ? STORAGE_SET_STATE_GAS : 0n })
  const frames = [...(opts.deadline === undefined ? [] : [expiryFrame(opts.deadline)]), ...(opts.deploy ? [opts.deploy] : []), verify, ...ops]
  return prepareFrameTx(client, {
    sender: acct.address,
    frames,
    signatures: signers.map((s) => secp256k1Placeholder(s)),
    nonceKeys: [key],
    nonceSeq: seq,
    fees: opts.fees,
  })
}

export const sign = (tx: FrameTx, keys: Hex[]) => signAll(tx, keys)
