// Experiment 17: VERIFY gas against the verifier's work, measured by simulation on the burner
// accounts (their one-time keys are shown many signatures here, which is what burners are for).
// For each parameter set, 12 transfers whose sig hashes differ only in the value sent; for
// w = 256, R is ground to several step counts to spread the points. A least-squares line through
// (steps, VERIFY gas) gives the fixed cost and the cost of one hash step.
//
// usage: npx tsx experiments/17-pq-account/measure.ts   (after setup.ts)
import { senderFrame, simulateFrameTx } from '../../src/frametx/index.js'
import { client, funder, pqTx, treeOf, wotsAccount } from './account.js'
import { VARIANTS, derived } from './wots.js'

const VERIFY_LIMIT = 499_900n // the testnet's cap, so that no point runs out of gas

console.log('| Variant | Points | Steps (min-max) | VERIFY gas (min-max) | Fixed | Per step | Largest residual | Steps that fit 99,900 |')
console.log('|---|---|---|---|---|---|---|---|')
for (const p of Object.values(VARIANTS)) {
  const tree = treeOf(p, 'burner')
  const account = wotsAccount(p, tree, 'burner').address
  if (!(await client.getCode({ address: account }))) throw new Error('run setup.ts first')
  const points: [number, number][] = []
  for (let i = 0; i < 12; i++) {
    const maxSteps = p.b === 8 ? [1020, 1275, 1530, 1785, 2040, undefined][i % 6] : undefined
    const q = await pqTx(tree, account, [senderFrame({ target: funder, value: BigInt(i + 1), execution: 30_000n })], { verifyGas: VERIFY_LIMIT, maxSteps })
    const sim = await simulateFrameTx(client, q.tx)
    if (!sim.valid || !sim.frames) throw new Error(`${p.name}: ${sim.violation}`)
    points.push([q.signed.steps, Number(BigInt(sim.frames[0].gasUsed))])
  }
  const n = points.length
  const mx = points.reduce((a, [x]) => a + x, 0) / n
  const my = points.reduce((a, [, y]) => a + y, 0) / n
  const slope = points.reduce((a, [x, y]) => a + (x - mx) * (y - my), 0) / points.reduce((a, [x]) => a + (x - mx) ** 2, 0)
  const fixed = my - slope * mx
  const residual = Math.max(...points.map(([x, y]) => Math.abs(y - (fixed + slope * x))))
  const xs = points.map(([x]) => x)
  const ys = points.map(([, y]) => y)
  const fit = Math.floor((99_900 - fixed) / slope)
  console.log(`| ${p.name} (${derived(p).l} chains) | ${n} | ${Math.min(...xs)}-${Math.max(...xs)} | ${Math.min(...ys)}-${Math.max(...ys)} | ${fixed.toFixed(0)} | ${slope.toFixed(2)} | ${residual.toFixed(1)} | ${fit} |`)
}
