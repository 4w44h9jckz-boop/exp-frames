import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Address, type Hex, concatHex, keccak256, toHex } from 'viem'
import { REPO_ROOT, compileYul } from '../../src/contracts.js'
import { create2Address, deployFrame, saltOf } from '../../src/deploy.js'
import { loadKey } from '../../src/env.js'
import {
  Approve,
  type Frame,
  type FrameSignature,
  type FrameTx,
  type FrameTxFees,
  Scheme,
  frameSigHash,
  getNonceSeq,
  makeClient,
  prepareFrameTx,
  verifyFrame,
} from '../../src/frametx/index.js'
import { type Params, type Signed, type Tree, derived, keygen, sign } from './wots.js'

export const { privateKey, address: funder } = loadKey()
export const client = makeClient()

/** WotsAccount.yul with this variant's parameters written into its five parameter functions. */
export function compileVariant(p: Params): Hex {
  const values: Record<string, number> = { N: p.n, B: p.b, L2: derived(p).l2, H: p.h, K: p.k }
  let source = readFileSync(join(REPO_ROOT, 'experiments/17-pq-account/WotsAccount.yul'), 'utf8')
  for (const [name, v] of Object.entries(values)) {
    const re = new RegExp(`function ${name}\\(\\) -> v \\{ v := \\d+ \\}`)
    if (!re.test(source)) throw new Error(`parameter ${name} not found in WotsAccount.yul`)
    source = source.replace(re, `function ${name}() -> v { v := ${v} }`)
  }
  const dir = join(tmpdir(), 'exp-frames-17')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `WotsAccount-${p.name}.yul`)
  writeFileSync(file, source)
  return compileYul(file)
}

/**
 * Each variant has two accounts. `main` sends real transactions and never shows a one-time key
 * twice. `burner` is where measurements and refusals are simulated: those show one key many
 * signatures, so its keys are spent by design, and it holds only enough to pass simulation.
 */
export type Role = 'main' | 'burner'

/** The tree for a variant: its seed comes from PRIVATE_KEY, so every run finds the same root. */
export const treeOf = (p: Params, role: Role = 'main'): Tree => keygen(p, keccak256(concatHex([privateKey, toHex(`exp-frames/17/${p.name}/${role}`)])))

export function wotsAccount(p: Params, tree: Tree, role: Role = 'main') {
  const initcode = concatHex([compileVariant(p), tree.root])
  const salt = saltOf(`exp-frames/17/${p.name}/${role}`)
  return { address: create2Address(initcode, salt), deploy: deployFrame(initcode, salt).frame, initcode }
}

/** An ARBITRARY entry of the right length; its bytes are outside the sig hash. */
export const placeholder = (p: Params): FrameSignature => ({
  scheme: Scheme.ARBITRARY,
  signer: null,
  msg: '0x',
  signature: `0x${'ff'.repeat(derived(p).sigLen)}`,
})

export type PqTx = { tx: FrameTx; signed: Signed; leaf: number }

/**
 * A transaction from a WotsAccount: VERIFY, then `frames`. The one-time key is leaf
 * K * nonce + attempt; a replacement takes the next attempt, never the same leaf again.
 */
export async function pqTx(
  tree: Tree,
  account: Address,
  frames: Frame[],
  opts: { attempt?: number; fees?: FrameTxFees; verifyGas?: bigint; maxSteps?: number; nonceSeq?: bigint; nonceKeys?: bigint[] } = {},
): Promise<PqTx> {
  const p = tree.params
  const nonceKeys = opts.nonceKeys ?? [0n]
  const nonceSeq = opts.nonceSeq ?? (await getNonceSeq(client, account, nonceKeys))
  const legacy = nonceKeys[0] === 0n ? nonceSeq : await getNonceSeq(client, account, [0n])
  const leaf = p.k * Number(legacy) + (opts.attempt ?? 0)
  const tx = await prepareFrameTx(client, {
    sender: account,
    frames: [verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: opts.verifyGas ?? 99_900n }), ...frames],
    signatures: [placeholder(p)],
    nonceKeys,
    nonceSeq,
    fees: opts.fees,
  })
  const signed = sign(tree, leaf, frameSigHash(tx), opts.maxSteps)
  return { tx: { ...tx, signatures: [{ ...tx.signatures[0], signature: signed.signature }] }, signed, leaf }
}
