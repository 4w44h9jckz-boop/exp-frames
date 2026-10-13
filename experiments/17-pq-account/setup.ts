// Experiment 17: deploy and fund the six WotsAccounts, a main and a burner for each parameter
// set. Run once before the other scripts; the first run also hashes all six trees (a few
// minutes), which later runs read back from a cache.
//
// usage: npx tsx experiments/17-pq-account/setup.ts [--dry-run]
import { parseEther } from 'viem'
import { sendFrames } from '../../src/deploy.js'
import { type Frame, senderFrame } from '../../src/frametx/index.js'
import { type Role, client, privateKey, treeOf, wotsAccount } from './account.js'
import { VARIANTS, derived } from './wots.js'

const FUNDING: Record<Role, bigint> = { main: parseEther('0.01'), burner: parseEther('0.002') }

const frames: Frame[] = []
for (const p of Object.values(VARIANTS)) {
  for (const role of ['main', 'burner'] as const) {
    const t0 = performance.now()
    const tree = treeOf(p, role)
    const account = wotsAccount(p, tree, role)
    const { l, sigLen } = derived(p)
    console.log(`${p.name} ${role}: n = ${p.n} B, w = ${1 << p.b}, ${l} chains, signature ${sigLen} B, code ${(account.initcode.length - 2) / 2 - 32} B, ${account.address} (keys in ${((performance.now() - t0) / 1000).toFixed(1)} s)`)
    if (!(await client.getCode({ address: account.address }))) frames.push(account.deploy)
    const balance = await client.getBalance({ address: account.address })
    if (balance < FUNDING[role] / 2n) frames.push(senderFrame({ target: account.address, value: FUNDING[role] - balance, execution: 30_000n }))
  }
}
if (frames.length) await sendFrames(client, privateKey, frames, { label: 'setup: deploy and fund the WotsAccounts' })
else console.log('setup: already done')
