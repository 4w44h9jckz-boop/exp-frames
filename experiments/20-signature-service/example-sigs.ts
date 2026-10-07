// Experiment 20: protocol-validated signatures as a service to ordinary contracts.
//
//   setup  deploy SigReader, two SigTokens, the Exchange and the Quorum; fund bob and carol; mint
//   A      a gasless transfer four ways: SIGPARAM with a secp256k1 entry, ecrecover in the EVM,
//          SIGPARAM with a P256 entry, P256VERIFY in the EVM; two rounds
//   B      a passkey-signed order: a P256-only address approves and sells in bob's transaction
//   C      the same entries lifted from bob's transaction by carol, with and without a taker
//
// usage: npx tsx experiments/20-signature-service/example-sigs.ts
import { type Address, type Hex, parseEther } from 'viem'
import { sendFrames } from '../../src/deploy.js'
import { execute } from '../../src/execute.js'
import {
  type FrameTx,
  NEW_ACCOUNT_STATE_GAS,
  calldataFloorGas,
  intrinsicGas,
  sendFrameTx,
  senderFrame,
  signAll,
  simulateFrameTx,
} from '../../src/frametx/index.js'
import {
  aliceK1,
  aliceP256,
  bob,
  call,
  carol,
  client,
  confirmed,
  exchange,
  exchangeAbi,
  funderKey,
  link,
  quorum,
  read,
  reader,
  relayed,
  rsxy,
  short,
  signedEntry,
  tka,
  tkb,
  tokenAbi,
  vrs,
} from './service.js'

const E = (n: number) => parseEther(String(n))
console.log(`reader ${reader.address}, TKA ${tka.address}, TKB ${tkb.address}, exchange ${exchange.address}, quorum ${quorum.address}`)
console.log(`bob ${bob.address}, carol ${carol.address}, alice (secp256k1) ${aliceK1.address}, alice (P256) ${aliceP256.address}`)

// ---- setup ----
{
  const missing = []
  for (const c of [reader, tka, tkb, exchange, quorum]) if (!(await client.getCode({ address: c.address }))) missing.push(c.deploy)
  if (missing.length) await sendFrames(client, funderKey, missing, { label: 'setup: deploy SigReader, TKA, TKB, Exchange, Quorum' })
  const frames = []
  for (const [who, eth] of [[bob.address, 0.05], [carol.address, 0.02]] as const) {
    if ((await client.getBalance({ address: who })) < E(eth / 2)) frames.push(senderFrame({ target: who, value: E(eth), execution: 30_000n, state: NEW_ACCOUNT_STATE_GAS }))
  }
  const mints: [Address, Address, number][] = [
    [tka.address, aliceK1.address, 1000],
    [tka.address, aliceP256.address, 1000],
    [tka.address, carol.address, 1],
    [tkb.address, bob.address, 1000],
    [tkb.address, carol.address, 1000],
    [tkb.address, aliceP256.address, 1],
  ]
  for (const [token, to, amount] of mints) {
    if ((await read<bigint>(token, tokenAbi, 'balanceOf', [to])) === 0n) frames.push(call(token, tokenAbi, 'mint', [to, E(amount)], 80_000n, 3n * 97_920n))
  }
  if (frames.length) await sendFrames(client, funderKey, frames, { label: 'setup: fund bob and carol, mint' })
}

const send = async (tx: FrameTx, keys: Hex[]) => {
  tx = await signAll(tx, keys)
  const sim = await simulateFrameTx(client, tx)
  if (!sim.valid) throw new Error(`invalid: ${sim.violation}`)
  const hash = await sendFrameTx(client, tx)
  const r = await confirmed(hash)
  return { tx, hash, r }
}

// ---- A. one transfer, four ways ----
console.log('\n### A. A gasless transfer of 1 TKA to carol, relayed by bob\n')
console.log('| Round | Method | Signature checked by | Tx | `gasUsed` | intrinsic | floor | transfer frame |\n|---|---|---|---|---|---|---|---|')
for (const round of [1, 2]) {
  for (const method of ['SIGPARAM, secp256k1 entry', 'ecrecover', 'SIGPARAM, P256 entry', 'P256VERIFY']) {
    const alice = method.includes('256k1') || method === 'ecrecover' ? aliceK1 : aliceP256
    const nonce = await read<bigint>(tka.address, tokenAbi, 'nonces', [alice.address])
    const digest = await read<Hex>(tka.address, tokenAbi, 'transferDigest', [alice.address, carol.address, E(1), nonce])
    const entry = await signedEntry(alice, digest)
    let tx: FrameTx
    if (method.startsWith('SIGPARAM')) {
      tx = await relayed(bob.address, [call(tka.address, tokenAbi, 'transferBySig', [alice.address, carol.address, E(1), 1n])], [entry])
    } else if (method === 'ecrecover') {
      const { v, r, s } = vrs(entry.signature)
      tx = await relayed(bob.address, [call(tka.address, tokenAbi, 'transferByEcrecover', [alice.address, carol.address, E(1), v, r, s])])
    } else {
      tx = await relayed(bob.address, [call(tka.address, tokenAbi, 'transferByP256', [alice.address, carol.address, E(1), ...rsxy(entry.signature)])])
    }
    const { tx: signed, hash, r } = await send(tx, [bob.key])
    const by = method.startsWith('SIGPARAM') ? 'the protocol, before any frame' : 'the token, in the EVM'
    const frame = r.frameReceipts[1]
    console.log(
      `| ${round} | ${method} | ${by} | ${link(hash)} | ${BigInt(r.gasUsed)} | ${intrinsicGas(signed)} | ${calldataFloorGas(signed)} | ${BigInt(frame.gasUsed)} + ${BigInt(frame.stateGasUsed)} state, ${frame.status === '0x1' ? 'success' : 'FAILED'} |`,
    )
  }
}

// ---- B. a passkey-signed order ----
type Order = { maker: Address; sellToken: Address; sellAmount: bigint; buyToken: Address; buyAmount: bigint; taker: Address; expiry: bigint; salt: bigint }
const ZERO = '0x0000000000000000000000000000000000000000' as Address
const head = (await client.getBlock({ blockTag: 'latest' })).timestamp
const order = (taker: Address, salt: bigint): Order => ({
  maker: aliceP256.address,
  sellToken: tka.address,
  sellAmount: E(10),
  buyToken: tkb.address,
  buyAmount: E(5),
  taker,
  expiry: head + 3600n,
  salt,
})
/** alice's two entries: approve the exchange for the order's amount, and the order itself. */
const aliceSigns = async (o: Order, nonceOffset = 0n) => {
  const nonce = (await read<bigint>(tka.address, tokenAbi, 'nonces', [aliceP256.address])) + nonceOffset
  const approveDigest = await read<Hex>(tka.address, tokenAbi, 'approveDigest', [aliceP256.address, exchange.address, o.sellAmount, nonce])
  const orderDigest = await read<Hex>(exchange.address, exchangeAbi, 'orderDigest', [o])
  return [await signedEntry(aliceP256, approveDigest), await signedEntry(aliceP256, orderDigest)]
}
/** the taker's frames: alice's permit, the taker's own approve, the fill; one atomic batch. */
const takerFrames = (o: Order) => [
  { ...call(tka.address, tokenAbi, 'approveBySig', [aliceP256.address, exchange.address, o.sellAmount, 1n]), flags: 4 },
  { ...call(tkb.address, tokenAbi, 'approve', [exchange.address, o.buyAmount]), flags: 4 },
  call(exchange.address, exchangeAbi, 'fill', [o, 2n], 150_000n, 3n * 97_920n),
]
const balances = async () => {
  const out: string[] = []
  for (const [name, who] of [['alice', aliceP256.address], ['bob', bob.address], ['carol', carol.address]] as const) {
    const [a, b] = await Promise.all([read<bigint>(tka.address, tokenAbi, 'balanceOf', [who]), read<bigint>(tkb.address, tokenAbi, 'balanceOf', [who])])
    out.push(`${name} ${Number(a) / 1e18} TKA / ${Number(b) / 1e18} TKB`)
  }
  return out.join('; ')
}

console.log('\n### B. alice (a P256 key, no account) sells 10 TKA for 5 TKB; bob takes\n')
console.log(`before: ${await balances()}`)
{
  const o = order(ZERO, BigInt(head))
  const entries = await aliceSigns(o)
  const ex = await execute(client, await relayed(bob.address, takerFrames(o), entries), [bob.key], { label: 'B: bob fills alice\'s order' })
  console.log(`B ${ex.hash} gasUsed ${ex.receipt ? BigInt(ex.receipt.gasUsed) : '-'}`)
}
console.log(`after:  ${await balances()}`)

// ---- C. lifting alice's entries from bob's transaction ----
console.log('\n### C. carol copies alice\'s entries out of bob\'s transaction\n')
for (const [what, taker] of [['open order (taker 0)', ZERO], ['order for bob only', bob.address]] as const) {
  const o = order(taker, BigInt(head) + (taker === ZERO ? 1n : 2n))
  const entries = await aliceSigns(o)
  // bob's transaction, signed but not yet sent: in a public pool, this is what carol would see.
  const bobs = await signAll(await relayed(bob.address, takerFrames(o), entries), [bob.key])
  const lifted = bobs.signatures.slice(1) // alice's two entries, byte for byte
  const carols = await signAll(await relayed(carol.address, takerFrames(o), lifted), [carol.key])
  const sim = await simulateFrameTx(client, carols)
  let line = `${what}: carol's copy simulates ${sim.valid ? 'valid' : `invalid (${sim.violation})`}, frames ${sim.frames?.map((f) => (f.succeeded ? 'ok' : 'fail')).join(' ')}`
  try {
    const hash = await sendFrameTx(client, carols)
    const r = await confirmed(hash)
    line += `; sent: ${link(hash)}, gasUsed ${BigInt(r.gasUsed)}, frame statuses ${r.frameReceipts.map((f) => Number(f.status)).join(' ')}`
  } catch (e) {
    line += `; send refused: ${short(e)}`
  }
  console.log(line)
  console.log(`  then: ${await balances()}`)
  // bob's original, rebuilt at his current nonce with the same entries.
  const bobsAfter = await signAll(await relayed(bob.address, takerFrames(o), entries), [bob.key])
  const sim2 = await simulateFrameTx(client, bobsAfter)
  let line2 = `  bob's own fill afterwards simulates ${sim2.valid ? 'valid' : 'invalid'}, frames ${sim2.frames?.map((f) => (f.succeeded ? 'ok' : 'fail')).join(' ')}`
  if (taker !== ZERO) {
    const hash = await sendFrameTx(client, bobsAfter)
    const r = await confirmed(hash)
    line2 += `; sent: ${link(hash)}, gasUsed ${BigInt(r.gasUsed)}, frame statuses ${r.frameReceipts.map((f) => Number(f.status)).join(' ')}`
  }
  console.log(line2)
  console.log(`  then: ${await balances()}`)
}
