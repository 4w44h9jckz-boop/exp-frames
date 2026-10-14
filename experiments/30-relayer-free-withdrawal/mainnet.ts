// Experiment 30, part 1: what a privacy withdrawal costs on mainnet today, read from the chain.
//
// For every withdrawal from Tornado Cash's four ETH pools and from Privacy Pools' ETH pool in a
// window of blocks, it reads the fee the note paid (from the pool's own event) and what the
// transaction cost whoever sent it (gasUsed times the effective gas price, from the receipt).
// A withdrawal with a fee was relayed: the relayer sent it and the note paid the relayer. A
// withdrawal with no fee was sent by someone who already held ETH.
//
// Addresses, all read from the projects' own sources and checked on chain before use:
//   Tornado Cash ETH instances and the router: tornadocash/tornado-cli `config.js`, netId1.
//   Privacy Pools Entrypoint and ETH pool: docs.privacypools.com/deployments.
//   Events: tornado-core `contracts/Tornado.sol`; privacy-pools-core `IEntrypoint.sol` and
//   `IPrivacyPool.sol`; StakeBurned(address,uint256) is the relayer registry's TORN burn.
//
// usage: npx tsx experiments/30-relayer-free-withdrawal/mainnet.ts [toBlock] [days]
//   toBlock defaults to the latest finalized block; days to 30 (7,200 blocks a day).
//   MAINNET_RPC_URL overrides the RPC; receipts are cached in $CACHE_DIR (default: the OS temp
//   directory), so a second run over the same window makes no receipt calls.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Address, type Hex, createPublicClient, formatEther, getAddress, http, parseAbi, parseAbiItem } from 'viem'
import { mainnet } from 'viem/chains'

const RPC = process.env.MAINNET_RPC_URL ?? 'https://mainnet.gateway.tenderly.co'
const client = createPublicClient({ chain: mainnet, transport: http(RPC, { retryCount: 6, retryDelay: 1_000, timeout: 30_000 }) })

const TORNADO: Record<string, Address> = {
  '0.1': '0x12D66f87A04A9E220743712cE6d9bB1B5616B8Fc',
  '1': '0x47CE0C6eD5B0Ce3d3A51fdb1C52DC66a7c3c2936',
  '10': '0x910Cbd523D972eb0a6f4cAe4618aD62622b39DbF',
  '100': '0xA160cdAB225685dA1d56aa342Ad8841c3b53f291',
}
const TORNADO_ROUTER: Address = '0xd90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b'
const PP_ENTRYPOINT: Address = '0x6818809eefce719e480a7526d76bd3e561526b46'
const PP_ETH_POOL: Address = '0xf241d57c6debae225c0f2e6ea1529373c9a9c9fb'
const NATIVE: Address = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'

const tornadoWithdrawal = parseAbiItem('event Withdrawal(address to, bytes32 nullifierHash, address indexed relayer, uint256 fee)')
const ppRelayed = parseAbiItem('event WithdrawalRelayed(address indexed _relayer, address indexed _recipient, address indexed _asset, uint256 _amount, uint256 _feeAmount)')
const ppWithdrawn = parseAbiItem('event Withdrawn(address indexed _processooor, uint256 _value, uint256 _spentNullifier, uint256 _newCommitment)')
const STAKE_BURNED: Hex = '0x659f33fc6677bebf3a9bf3101092792e31f35766d0358e54577bdd91a655f6a0' // StakeBurned(address,uint256)

// What the note pays for the same withdrawal with no relayer, in gas: RefundPool's mined
// withdrawal on the Hegota testnet (refund.ts, 0xc992b54a...), 579,661 gasUsed, plus the 13,469
// of the post-op's budget that RefundPool keeps. It is priced below at each relayed withdrawal's
// own effective gas price. It includes 281,520 of EIP-8037 state gas (the nullifier's nonce key
// and the recipient's new account), which today's mainnet schedule prices lower.
const REFUND_POOL_GAS = 579_661n + 13_469n

// ---- the window ----
const finalized = (await client.getBlock({ blockTag: 'finalized' })).number
const toBlock = process.argv[2] ? BigInt(process.argv[2]) : finalized
const days = Number(process.argv[3] ?? 30)
const fromBlock = toBlock - BigInt(days * 7_200) + 1n
const [fromTs, toTs] = await Promise.all([fromBlock, toBlock].map(async (n) => (await client.getBlock({ blockNumber: n })).timestamp))
const date = (t: bigint) => new Date(Number(t) * 1000).toISOString().slice(0, 16).replace('T', ' ')
console.log(`RPC ${RPC}`)
console.log(`blocks ${fromBlock} to ${toBlock} (${days} days, ${date(fromTs)} to ${date(toTs)} UTC)`)

// ---- the addresses, checked on chain ----
for (const [d, a] of Object.entries(TORNADO)) {
  const v = await client.readContract({ address: a, abi: parseAbi(['function denomination() view returns (uint256)']), functionName: 'denomination' })
  if (formatEther(v) !== d) throw new Error(`Tornado ${a}: denomination ${formatEther(v)}, expected ${d}`)
}
const ppAbi = parseAbi([
  'function ASSET() view returns (address)',
  'function SCOPE() view returns (uint256)',
  'function scopeToPool(uint256) view returns (address)',
  'function assetConfig(address) view returns (address pool, uint256 minimumDepositAmount, uint256 vettingFeeBPS, uint256 maxRelayFeeBPS)',
])
const ppAsset = await client.readContract({ address: PP_ETH_POOL, abi: ppAbi, functionName: 'ASSET' })
const ppScope = await client.readContract({ address: PP_ETH_POOL, abi: ppAbi, functionName: 'SCOPE' })
const ppByScope = await client.readContract({ address: PP_ENTRYPOINT, abi: ppAbi, functionName: 'scopeToPool', args: [ppScope] })
const ppConfig = await client.readContract({ address: PP_ENTRYPOINT, abi: ppAbi, functionName: 'assetConfig', args: [NATIVE] })
if (getAddress(ppAsset) !== NATIVE || getAddress(ppByScope) !== getAddress(PP_ETH_POOL) || getAddress(ppConfig[0]) !== getAddress(PP_ETH_POOL)) {
  throw new Error('Privacy Pools: the ETH pool and the Entrypoint do not name each other')
}
console.log(`Tornado: four instances, denominations match. Privacy Pools: ETH pool registered at the Entrypoint; vetting fee ${ppConfig[2]} bps, max relay fee ${ppConfig[3]} bps`)

// ---- logs, in chunks the RPC accepts ----
async function logsOf<T>(fetch: (from: bigint, to: bigint) => Promise<T[]>): Promise<T[]> {
  const out: T[] = []
  for (let a = fromBlock; a <= toBlock; a += 10_000n) {
    const b = a + 9_999n > toBlock ? toBlock : a + 9_999n
    for (let attempt = 0; ; attempt++) {
      try {
        out.push(...(await fetch(a, b)))
        break
      } catch (e) {
        if (attempt === 5) throw e
        await new Promise((r) => setTimeout(r, 2_000 * 2 ** attempt))
      }
    }
  }
  return out
}
const tLogs = await logsOf((a, b) => client.getLogs({ address: Object.values(TORNADO), event: tornadoWithdrawal, fromBlock: a, toBlock: b }))
const rLogs = await logsOf((a, b) => client.getLogs({ address: PP_ENTRYPOINT, event: ppRelayed, args: { _asset: NATIVE }, fromBlock: a, toBlock: b }))
const wLogs = await logsOf((a, b) => client.getLogs({ address: PP_ETH_POOL, event: ppWithdrawn, fromBlock: a, toBlock: b }))
console.log(`logs: Tornado ${tLogs.length}, Privacy Pools relayed (ETH) ${rLogs.length}, Privacy Pools ETH pool withdrawals ${wLogs.length}`)

// ---- one row per withdrawal ----
type Row = {
  pool: string
  hash: Hex
  block: bigint
  recipient: Address
  relayer: Address
  amount: bigint // what left the pool
  fee: bigint // what the note paid whoever sent it
  sender: Address // tx.from
  gasUsed: bigint
  price: bigint // effective gas price
  maxFee: bigint // the sender's max fee per gas (gas price for a legacy transaction)
  gasLimit: bigint
  tornBurned: bigint
  viaRouter: boolean
}
const zero = '0x0000000000000000000000000000000000000000' as Address
const pending: Omit<Row, 'sender' | 'gasUsed' | 'price' | 'maxFee' | 'gasLimit' | 'tornBurned' | 'viaRouter'>[] = []
const denom = Object.fromEntries(Object.entries(TORNADO).map(([d, a]) => [a.toLowerCase(), d]))
for (const l of tLogs) {
  const d = denom[l.address.toLowerCase()]
  pending.push({ pool: `Tornado ${d} ETH`, hash: l.transactionHash, block: l.blockNumber, recipient: l.args.to!, relayer: l.args.relayer!, amount: BigInt(Number(d) * 1e6) * 10n ** 12n, fee: l.args.fee! })
}
const relayedTx = new Set(rLogs.map((l) => l.transactionHash))
for (const l of rLogs) {
  pending.push({ pool: 'Privacy Pools ETH', hash: l.transactionHash, block: l.blockNumber, recipient: l.args._recipient!, relayer: l.args._relayer!, amount: l.args._amount!, fee: l.args._feeAmount! })
}
for (const l of wLogs) {
  if (getAddress(l.args._processooor!) === getAddress(PP_ENTRYPOINT)) {
    if (!relayedTx.has(l.transactionHash)) throw new Error(`${l.transactionHash}: Entrypoint withdrawal without a WithdrawalRelayed event`)
    continue
  }
  pending.push({ pool: 'Privacy Pools ETH', hash: l.transactionHash, block: l.blockNumber, recipient: l.args._processooor!, relayer: zero, amount: l.args._value!, fee: 0n })
}

// Receipts and transactions, cached by hash.
const cacheDir = join(process.env.CACHE_DIR ?? tmpdir(), 'exp-frames-30')
mkdirSync(cacheDir, { recursive: true })
const cacheFile = join(cacheDir, 'receipts.json')
type Cached = { from: Address; to: Address | null; gasUsed: string; price: string; maxFee: string; gasLimit: string; tornBurned: string }
const cache: Record<string, Cached> = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {}
const hashes = [...new Set(pending.map((p) => p.hash))].filter((h) => !cache[h])
let done = 0
async function fetchOne(hash: Hex) {
  const [r, tx] = await Promise.all([client.getTransactionReceipt({ hash }), client.getTransaction({ hash })])
  let torn = 0n
  for (const l of r.logs) if (l.topics[0] === STAKE_BURNED) torn += BigInt(`0x${l.data.slice(66, 130)}`)
  cache[hash] = {
    from: r.from,
    to: r.to,
    gasUsed: r.gasUsed.toString(),
    price: r.effectiveGasPrice.toString(),
    maxFee: (tx.maxFeePerGas ?? tx.gasPrice!).toString(),
    gasLimit: tx.gas.toString(),
    tornBurned: torn.toString(),
  }
  if (++done % 200 === 0) {
    writeFileSync(cacheFile, JSON.stringify(cache))
    console.log(`  receipts ${done}/${hashes.length}`)
  }
}
for (let i = 0; i < hashes.length; i += 8) await Promise.all(hashes.slice(i, i + 8).map(fetchOne))
writeFileSync(cacheFile, JSON.stringify(cache))

const rows: Row[] = pending.map((p) => {
  const c = cache[p.hash]
  return {
    ...p,
    sender: getAddress(c.from),
    gasUsed: BigInt(c.gasUsed),
    price: BigInt(c.price),
    maxFee: BigInt(c.maxFee),
    gasLimit: BigInt(c.gasLimit),
    tornBurned: BigInt(c.tornBurned),
    viaRouter: !!c.to && getAddress(c.to) === getAddress(TORNADO_ROUTER),
  }
})

// ---- summaries ----
const med = (xs: bigint[]) => {
  if (!xs.length) return 0n
  const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return s[Math.floor((s.length - 1) / 2)]
}
const medN = (xs: number[]) => {
  if (!xs.length) return Number.NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor((s.length - 1) / 2)]
}
const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n)
const eth = (w: bigint, dp = 6) => Number(formatEther(w)).toFixed(dp)
const gwei = (w: bigint) => (Number(w) / 1e9).toFixed(3)
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(0)}%` : '-')
const cost = (r: Row) => r.gasUsed * r.price

const pools = ['Tornado 0.1 ETH', 'Tornado 1 ETH', 'Tornado 10 ETH', 'Tornado 100 ETH', 'Privacy Pools ETH']
console.log('\n### Who sent the withdrawals\n')
console.log('| Pool | Withdrawals | Relayed (fee > 0) | Sent by someone holding ETH (fee 0) | ... of which the recipient sent it | Relayers seen | Top relayer\'s share of relayed |')
console.log('|---|---|---|---|---|---|---|')
for (const p of [...pools, 'all']) {
  const rs = rows.filter((r) => p === 'all' || r.pool === p)
  const relayed = rs.filter((r) => r.fee > 0n)
  const direct = rs.filter((r) => r.fee === 0n)
  const self = direct.filter((r) => getAddress(r.recipient) === r.sender)
  const by = new Map<string, number>()
  for (const r of relayed) by.set(r.sender, (by.get(r.sender) ?? 0) + 1)
  const top = Math.max(0, ...by.values())
  console.log(`| ${p} | ${rs.length} | ${relayed.length} (${pct(relayed.length, rs.length)}) | ${direct.length} (${pct(direct.length, rs.length)}) | ${self.length} | ${by.size} | ${pct(top, relayed.length)} |`)
}

console.log('\n### What a relayed withdrawal cost the note, and what it cost the relayer (medians)\n')
console.log('| Pool | Relayed | Fee | Relayer\'s gas | `gasUsed` | Effective price (gwei) | Fee / gas | Fee less gas, in bps of the amount | Relayer\'s max fee / effective price | TORN burned | No relayer: RefundPool at the same price | Fee / that |')
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|')
for (const p of pools) {
  const rs = rows.filter((r) => r.pool === p && r.fee > 0n)
  if (!rs.length) {
    console.log(`| ${p} | 0 | | | | | | | | | | |`)
    continue
  }
  const ratio = medN(rs.map((r) => Number(r.fee) / Number(cost(r))))
  const bps = medN(rs.map((r) => (1e4 * Number(r.fee - cost(r))) / Number(r.amount)))
  const head = medN(rs.map((r) => Number(r.maxFee) / Number(r.price)))
  const torn = rs.some((r) => r.tornBurned > 0n) ? `${eth(med(rs.map((r) => r.tornBurned)), 3)} TORN` : '-'
  const own = medN(rs.map((r) => Number(r.fee) / Number(REFUND_POOL_GAS * r.price)))
  console.log(`| ${p} | ${rs.length} | ${eth(med(rs.map((r) => r.fee)))} | ${eth(med(rs.map(cost)))} | ${med(rs.map((r) => r.gasUsed))} | ${gwei(med(rs.map((r) => r.price)))} | ${ratio.toFixed(1)}x | ${bps.toFixed(1)} | ${head.toFixed(2)} | ${torn} | ${eth(med(rs.map((r) => REFUND_POOL_GAS * r.price)))} | ${own.toFixed(1)}x |`)
}

console.log('\n### Totals over the window\n')
console.log('| Pool | Relayed | Fees paid by notes | Relayers\' gas | Fees less gas | The same withdrawals through RefundPool | Self-sent: their gas |')
console.log('|---|---|---|---|---|---|---|')
for (const p of [...pools, 'all']) {
  const rs = rows.filter((r) => p === 'all' || r.pool === p)
  const relayed = rs.filter((r) => r.fee > 0n)
  const direct = rs.filter((r) => r.fee === 0n)
  const f = sum(relayed.map((r) => r.fee))
  const g = sum(relayed.map(cost))
  const own = sum(relayed.map((r) => REFUND_POOL_GAS * r.price))
  console.log(`| ${p} | ${relayed.length} | ${eth(f, 4)} ETH | ${eth(g, 4)} ETH | ${eth(f - g, 4)} ETH | ${eth(own, 4)} ETH | ${eth(sum(direct.map(cost)), 4)} ETH |`)
}

console.log('\n### Gas of one withdrawal (median `gasUsed`)\n')
console.log('| Pool | Relayed | Self-sent | Relayed through the router |')
console.log('|---|---|---|---|')
for (const p of pools) {
  const rs = rows.filter((r) => r.pool === p)
  const relayed = rs.filter((r) => r.fee > 0n)
  const direct = rs.filter((r) => r.fee === 0n)
  console.log(`| ${p} | ${med(relayed.map((r) => r.gasUsed))} | ${med(direct.map((r) => r.gasUsed))} | ${pct(relayed.filter((r) => r.viaRouter).length, relayed.length)} |`)
}

// The ten relayers with the most withdrawals, across every pool.
const byRelayer = new Map<string, Row[]>()
for (const r of rows.filter((r) => r.fee > 0n)) byRelayer.set(r.sender, [...(byRelayer.get(r.sender) ?? []), r])
console.log('\n### Relayers by withdrawals sent\n')
console.log('| Relayer (tx sender) | Withdrawals | Pools | Fees | Gas | Median fee / gas |')
console.log('|---|---|---|---|---|---|')
for (const [a, rs] of [...byRelayer.entries()].sort((x, y) => y[1].length - x[1].length).slice(0, 10)) {
  const ps = [...new Set(rs.map((r) => r.pool.replace('Tornado ', 'T').replace('Privacy Pools ETH', 'PP')))].join(', ')
  console.log(`| \`${a}\` | ${rs.length} | ${ps} | ${eth(sum(rs.map((r) => r.fee)), 4)} | ${eth(sum(rs.map(cost)), 4)} | ${medN(rs.map((r) => Number(r.fee) / Number(cost(r)))).toFixed(1)}x |`)
}

// Examples a reader can open: per pool, the relayed withdrawal at the median fee / gas ratio.
console.log('\n### One relayed withdrawal per pool, at the median fee / gas\n')
console.log('| Pool | Tx | Fee | Gas | `gasUsed` | Price (gwei) |')
console.log('|---|---|---|---|---|---|')
for (const p of pools) {
  const rs = rows.filter((r) => r.pool === p && r.fee > 0n).sort((a, b) => Number(a.fee) / Number(cost(a)) - Number(b.fee) / Number(cost(b)))
  if (!rs.length) continue
  const r = rs[Math.floor((rs.length - 1) / 2)]
  console.log(`| ${p} | [\`${r.hash.slice(0, 10)}...\`](https://etherscan.io/tx/${r.hash}) | ${eth(r.fee)} | ${eth(cost(r))} | ${r.gasUsed} | ${gwei(r.price)} |`)
}
process.exit(0)
