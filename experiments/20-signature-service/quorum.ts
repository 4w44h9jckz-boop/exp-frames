// Experiment 20, part 2: what one more signature costs, four ways, and how many protocol-
// validated signatures one transaction can carry through the public mempool.
//
// Each transaction is relayed by bob and counts N votes over one digest:
//   SIGPARAM, secp256k1   N explicit-digest SECP256K1 entries, read through SigReader
//   SIGPARAM, P256        N explicit-digest P256 entries, the same function
//   ecrecover             N × 65 bytes in frame data, recovered in the EVM
//   P256VERIFY            N × 128 bytes in frame data, verified by the precompile
//
// usage: npx tsx experiments/20-signature-service/quorum.ts [N ...]   (default 1 2 4 8 16 32 64)
//        npx tsx experiments/20-signature-service/quorum.ts limit       (the MAX_VERIFY_GAS edge)
import { type Hex, concatHex } from 'viem'
import {
  type FrameTx,
  MAX_VERIFY_GAS_TESTNET,
  calldataFloorGas,
  intrinsicGas,
  sendFrameTx,
  signAll,
  signatureVerificationGas,
  simulateFrameTx,
} from '../../src/frametx/index.js'
import { bob, call, client, confirmed, k1, link, p256Key, quorum, quorumAbi, read, relayed, short, signedEntry } from './service.js'

const args = process.argv.slice(2)
const byAddress = <T extends { address: string }>(xs: T[]) => xs.sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1))
const k1Voters = byAddress(Array.from({ length: 200 }, (_, i) => k1(`voter/${i}`)))
const p256Voters = byAddress(Array.from({ length: 64 }, (_, i) => p256Key(`voter-p256/${i}`)))
const digest = await read<Hex>(quorum.address, quorumAbi, 'voteDigest', [1n, 1])

type Method = 'SIGPARAM, secp256k1' | 'SIGPARAM, P256' | 'ecrecover' | 'P256VERIFY'
async function build(method: Method, n: number): Promise<FrameTx> {
  const voters = method.includes('P256') ? p256Voters.slice(0, n) : k1Voters.slice(0, n)
  if (voters.length < n) throw new Error(`only ${voters.length} voters`)
  const entries = await Promise.all(voters.map((v) => signedEntry(v, digest)))
  const N = BigInt(n)
  if (method.startsWith('SIGPARAM')) return relayed(bob.address, [call(quorum.address, quorumAbi, 'countBySig', [1n, 1, 1n, N], 40_000n + 1_500n * N, 0n)], entries)
  const sigs = concatHex(entries.map((e) => e.signature))
  const fn = method === 'ecrecover' ? 'countByEcrecover' : 'countByP256'
  return relayed(bob.address, [call(quorum.address, quorumAbi, fn, [1n, 1, sigs], 40_000n + (method === 'ecrecover' ? 6_000n : 10_000n) * N, 0n)])
}

const fit = (pts: [number, number][]) => {
  const n = pts.length
  const mx = pts.reduce((a, p) => a + p[0], 0) / n
  const my = pts.reduce((a, p) => a + p[1], 0) / n
  const b = pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0)
  return { slope: b, intercept: my - b * mx }
}

if (args[0] === 'limit') {
  // The prefix budget: VERIFY's limit (20,000) + every signature's gas, bob's own included.
  const edge = Number((MAX_VERIFY_GAS_TESTNET - 20_000n - 2_800n) / 2_800n)
  console.log(`| N secp256k1 entries | prefix budget (VERIFY 20,000 + signatures) | simulation | \`eth_sendRawTransaction\` | mined |\n|---|---|---|---|---|`)
  for (const n of [edge, edge + 1]) {
    const tx = await signAll(await build('SIGPARAM, secp256k1', n), [bob.key])
    const budget = 20_000n + signatureVerificationGas(tx)
    const sim = await simulateFrameTx(client, tx).catch((e) => ({ valid: false, violation: short(e) }))
    let sent = ''
    let mined = ''
    try {
      const hash = await sendFrameTx(client, tx)
      sent = 'accepted'
      const r = await confirmed(hash)
      mined = `${link(hash)}, \`gasUsed\` ${BigInt(r.gasUsed)} (floor ${calldataFloorGas(tx)}), count frame ${Number(r.frameReceipts[1].status) === 1 ? 'success' : 'FAILED'}`
    } catch (e) {
      sent = `refused: ${short(e)}`
    }
    console.log(`| ${n} | ${budget} | ${sim.valid ? 'valid' : `invalid: ${sim.violation}`} | ${sent} | ${mined} |`)
  }
} else {
  const ns = args.length ? args.map(Number) : [1, 2, 4, 8, 16, 32, 64]
  const methods: Method[] = ['SIGPARAM, secp256k1', 'ecrecover', 'SIGPARAM, P256', 'P256VERIFY']
  const points = new Map<Method, [number, number][]>(methods.map((m) => [m, []]))
  console.log('| N | Method | Tx | `gasUsed` | intrinsic | floor | count frame |\n|---|---|---|---|---|---|---|')
  for (const n of ns) {
    for (const method of methods) {
      const tx = await signAll(await build(method, n), [bob.key])
      const sim = await simulateFrameTx(client, tx)
      if (!sim.valid) {
        console.log(`| ${n} | ${method} | invalid: ${sim.violation} | | | | |`)
        continue
      }
      const hash = await sendFrameTx(client, tx)
      const r = await confirmed(hash)
      const f = r.frameReceipts[1]
      points.get(method)!.push([n, Number(BigInt(r.gasUsed))])
      console.log(
        `| ${n} | ${method} | ${link(hash)} | ${BigInt(r.gasUsed)} | ${intrinsicGas(tx)} | ${calldataFloorGas(tx)} | ${BigInt(f.gasUsed)}${Number(f.status) === 1 ? '' : ' FAILED'} |`,
      )
    }
  }
  console.log('\n| Method | gas per signature | fixed |\n|---|---|---|')
  for (const [m, pts] of points) if (pts.length > 1) {
    const { slope, intercept } = fit(pts)
    console.log(`| ${m} | ${slope.toFixed(0)} | ${intercept.toFixed(0)} |`)
  }
}
