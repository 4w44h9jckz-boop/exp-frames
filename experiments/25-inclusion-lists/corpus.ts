// Experiment 25: every mined transaction this repository keeps, read from every experiment branch.
//
// Each experiment branch carries its own fixtures in test/fixtures/chain/, on top of the ones it
// inherited from `tooling`. The corpus is their union, each transaction attributed to the first
// experiment branch that carries it (`tooling` for the inherited ones). Run `git fetch origin`
// first: the script reads the remote-tracking branches and prints the commit of each.
import { execFileSync } from 'node:child_process'
import type { Hex } from 'viem'
import {
  type FrameTx,
  type FrameTxJson,
  type FrameTxReceiptJson,
  frameTxFromJson,
  frameTxHash,
  serializeFrameTx,
} from '../../src/frametx/index.js'

export type Mined = {
  hash: Hex
  /** `exp/NN-name` or `tooling`. */
  branch: string
  tx: FrameTx
  receipt: FrameTxReceiptJson
  /** The EIP-2718 envelope: what an inclusion list carries. */
  raw: Hex
}

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 26 })

/** Branch name, short commit, for every branch the corpus reads. */
export function branchHeads(): [string, string][] {
  const refs = git('for-each-ref', '--format=%(refname:short) %(objectname:short)', 'refs/remotes/origin/exp/', 'refs/remotes/origin/tooling')
  return refs
    .trim()
    .split('\n')
    .map((l) => l.split(' ') as [string, string])
    .map(([r, c]) => [r.replace(/^origin\//, ''), c])
}

export function loadCorpus(): Mined[] {
  const heads = branchHeads()
  const inTooling = new Set(listFixtures('tooling'))
  const seen = new Map<string, Mined>()
  // `tooling` first, then the experiments in number order.
  const order = [...heads.map(([b]) => b)].sort((a, b) => (a === 'tooling' ? -1 : b === 'tooling' ? 1 : a.localeCompare(b)))
  for (const branch of order) {
    for (const file of listFixtures(branch)) {
      if (seen.has(file)) continue
      if (branch !== 'tooling' && inTooling.has(file)) continue
      const j = JSON.parse(git('show', `origin/${branch}:test/fixtures/chain/${file}`)) as {
        tx: FrameTxJson
        receipt: FrameTxReceiptJson
      }
      const tx = frameTxFromJson(j.tx)
      // The encoder must reproduce the hash the chain assigned, or nothing below is about that tx.
      if (frameTxHash(tx) !== j.tx.hash) throw new Error(`${file}: re-encoding does not reproduce ${j.tx.hash}`)
      seen.set(file, { hash: j.tx.hash, branch, tx, receipt: j.receipt, raw: serializeFrameTx(tx) })
    }
  }
  return [...seen.values()]
}

function listFixtures(branch: string): string[] {
  return git('ls-tree', '--name-only', `origin/${branch}`, 'test/fixtures/chain/')
    .split('\n')
    .filter((p) => p.endsWith('.json'))
    .map((p) => p.slice('test/fixtures/chain/'.length))
}
