// Experiment 26: the validation prefixes timed in ethrex's own admission path
// (ethrex/exp26_validation_cpu.rs). Each workload is an account whose code is the work, run as a
// self-paying VERIFY frame, then APPROVE(EXECUTION_AND_PAYMENT). No signatures, except the
// default-code EOA's.
//
// Two groups:
// - "realistic": the prefixes behind the workloads that needed more than MAX_VERIFY_GAS here
//   (a Tornado Groth16 proof from experiment 06, verified by Tornado's own verifier; 40 ECDSA
//   recoveries, experiment 05's largest multisig; a WOTS-shaped keccak chain, experiment 17),
//   plus the cheap ones they are compared with.
// - "fill": one operation repeated to about 100,000 gas, for every precompile and for the
//   operations that read state. The question is which operation costs the most time per gas
//   inside a validation prefix, because that is what a gas cap on the prefix actually bounds.
//
// GAS is legal in a prefix only right before a CALL, so loops run a fixed count, not "until gas
// runs low"; the harness reports the gas each one used.
//
// Run: git fetch origin && npx tsx experiments/26-validation-cpu/workloads.ts
// Writes yul/*.yul (the sources) and ethrex/workloads.txt (what the harness reads).
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bls12_381 } from '@noble/curves/bls12-381'
import { bn254 } from '@noble/curves/bn254'
import { p256 } from '@noble/curves/p256'
import {
  type Address,
  type Hex,
  concat,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  keccak256,
  numberToHex,
  pad,
  parseAbi,
  toBytes,
  toHex,
} from 'viem'
import { privateKeyToAddress, sign } from 'viem/accounts'
import { EVM_VERSION } from '../../src/contracts.js'
import {
  Approve,
  type FrameTx,
  type FrameTxJson,
  frameTxFromJson,
  secp256k1Placeholder,
  senderFrame,
  serializeFrameTx,
  signFrameTx,
  verifyFrame,
} from '../../src/frametx/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const solc = createRequire(import.meta.url)('solc') as { compile(input: string): string; version(): string }

/** Compile one Yul object to bytecode, with the repository's solc settings (src/contracts.ts). */
function yul(name: string, source: string): Hex {
  mkdirSync(join(HERE, 'yul'), { recursive: true })
  writeFileSync(join(HERE, 'yul', `${name}.yul`), source)
  const input = {
    language: 'Yul',
    sources: { [name]: { content: source } },
    settings: { evmVersion: EVM_VERSION, optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['evm.bytecode.object'] } } },
  }
  const out = JSON.parse(solc.compile(JSON.stringify(input)))
  const errors = (out.errors ?? []).filter((e: { severity: string }) => e.severity === 'error')
  if (errors.length) throw new Error(`${name}: ${errors.map((e: { formattedMessage: string }) => e.formattedMessage).join('\n')}`)
  const [c] = Object.values(out.contracts[name]) as { evm: { bytecode: { object: string } } }[]
  return `0x${c.evm.bytecode.object}`
}

const word = (n: bigint) => pad(numberToHex(n), { size: 32 })
const fp64 = (n: bigint) => pad(numberToHex(n), { size: 64 }) // EIP-2537 field element
const hex = (h: Hex) => h.slice(2)

// ---- inputs ----

// ECDSA: one valid recovery, checked against the signer.
const ECDSA_KEY = keccak256(toBytes('exp-frames/26 ecrecover signer'))
const ECDSA_SIGNER = privateKeyToAddress(ECDSA_KEY)
const ECDSA_HASH = keccak256(toBytes('exp-frames/26 message'))
const ecdsa = await sign({ hash: ECDSA_HASH, privateKey: ECDSA_KEY })
const ECRECOVER_IN = concat([ECDSA_HASH, word(ecdsa.v ?? 27n), ecdsa.r, ecdsa.s])

// P256 (EIP-7951): hash, r, s, qx, qy; returns 1.
const P256_KEY = toBytes(keccak256(toBytes('exp-frames/26 p256 signer')))
const p256sig = p256.sign(toBytes(ECDSA_HASH), P256_KEY, { prehash: false })
const q = p256.ProjectivePoint.fromHex(p256.getPublicKey(P256_KEY, false)).toAffine()
const P256_IN = concat([ECDSA_HASH, word(p256sig.r), word(p256sig.s), word(q.x), word(q.y)])

// alt_bn128 (EIP-196/197). Fp2 is encoded imaginary part first.
const g1 = bn254.G1.ProjectivePoint.BASE.toAffine()
const g2 = bn254.G2.ProjectivePoint.BASE.toAffine()
const BN_G1 = concat([word(g1.x), word(g1.y)])
const BN_G2 = concat([word(g2.x.c1), word(g2.x.c0), word(g2.y.c1), word(g2.y.c0)])
const BN_ECADD_IN = concat([BN_G1, BN_G1])
const BN_ECMUL_IN = concat([BN_G1, word((1n << 255n) - 19n)])
const BN_PAIRING_IN = concat([BN_G1, BN_G2])

// BLS12-381 (EIP-2537). Fp2 is encoded real part first.
const b1 = bls12_381.G1.ProjectivePoint.BASE.toAffine()
const b2 = bls12_381.G2.ProjectivePoint.BASE.toAffine()
const BLS_G1 = concat([fp64(b1.x), fp64(b1.y)])
const BLS_G2 = concat([fp64(b2.x.c0), fp64(b2.x.c1), fp64(b2.y.c0), fp64(b2.y.c1)])
const BLS_G1ADD_IN = concat([BLS_G1, BLS_G1])
const BLS_PAIRING_IN = concat([BLS_G1, BLS_G2])
const BLS_MAP_FP2_IN = concat([fp64(1n), fp64(2n)])

// MODEXP (EIP-198): two shapes, a 256-bit exponentiation and a 2048-bit cube.
const modexp = (b: Hex, e: Hex, m: Hex) =>
  concat([word(BigInt(toBytes(b).length)), word(BigInt(toBytes(e).length)), word(BigInt(toBytes(m).length)), b, e, m])
const MODEXP_256 = modexp(word((1n << 255n) + 12345n), word((1n << 256n) - 1n), word((1n << 256n) - 189n))
const big = (seed: string) => keccak256(toBytes(seed)).slice(2).repeat(8)
const MODEXP_2048 = modexp(`0x${big('base')}`, '0x03', `0x${big('mod').slice(0, -2)}ff`)

// BLAKE2F (EIP-152): rounds, h, m, t, f.
const blake = (rounds: number) => concat([pad(numberToHex(rounds), { size: 4 }), `0x${'00'.repeat(64 + 128 + 16)}`, '0x01'])

// ---- the Tornado verifier and a proof it accepts, from experiment 06 ----

function gitShow(ref: string, path: string): string {
  return execFileSync('git', ['show', `${ref}:${path}`], { encoding: 'utf8', maxBuffer: 1 << 26 })
}
const verifierCreation = JSON.parse(gitShow('origin/exp/06-privacy-pool', 'experiments/06-privacy-pool/vendor/verifier.json')).bytecode as Hex
// solc's constructor: PUSH2 len DUP1 PUSH2 offset PUSH0/PUSH1 0 CODECOPY ... RETURN; read both.
const ctor = verifierCreation.slice(2)
const lenAt = ctor.indexOf('6110d0')
if (lenAt < 0) throw new Error('unexpected verifier constructor')
const runtimeLen = 0x10d0
const runtimeOff = Number.parseInt(ctor.slice(lenAt + 10, lenAt + 14), 16)
const STOCK_RUNTIME = ctor.slice(runtimeOff * 2, (runtimeOff + runtimeLen) * 2)
if (STOCK_RUNTIME.length !== runtimeLen * 2) throw new Error('verifier runtime length')
// Experiment 06's patchVerifier: the stock verifier calls each pairing precompile with
// `staticcall(sub(gas(), 2000), ...)`, and a GAS that is not immediately followed by a call is
// banned in a validation prefix. The patch keeps length, stack effect and jump offsets.
const STOCK_CALL = '6107d05a03fa' // PUSH2 2000, GAS, SUB, STATICCALL
const PATCHED_CALL = '5f505f505afa' // PUSH0, POP, PUSH0, POP, GAS, STATICCALL
if (STOCK_RUNTIME.split(STOCK_CALL).length - 1 !== 3) throw new Error('expected three pairing calls to patch')
const VERIFIER_RUNTIME: Hex = `0x${STOCK_RUNTIME.replaceAll(STOCK_CALL, PATCHED_CALL)}`

const WITHDRAWAL = '0x2719e9459155a1c329a3c8ab22c39e2d963ebeb5d4a538799766ab940acd5db8'
const fixture = JSON.parse(gitShow('origin/exp/06-privacy-pool', `test/fixtures/chain/${WITHDRAWAL}.json`)) as { tx: FrameTxJson }
const withdrawalTx = frameTxFromJson(fixture.tx)
const withdraw = decodeFunctionData({
  abi: parseAbi(['function withdraw(bytes,bytes32,bytes32,address,address,uint256,uint256)']),
  data: withdrawalTx.frames[withdrawalTx.frames.length - 1].data,
})
const [proof, root, nullifierHash, recipient, relayer, fee, refund] = withdraw.args
const VERIFY_PROOF_IN = encodeFunctionData({
  abi: parseAbi(['function verifyProof(bytes,uint256[6]) view returns (bool)']),
  args: [proof, [BigInt(root), BigInt(nullifierHash), BigInt(recipient), BigInt(relayer), fee, refund]],
})

// ---- accounts ----

type Account = { address: Address; balance: bigint; nonce: bigint; code: Hex; storage: [bigint, bigint][] }
const ETH = 10n ** 18n
const at = (prefix: number, i: number): Address => getAddress(`0x${prefix.toString(16).padStart(4, '0')}${'0'.repeat(32)}${i.toString(16).padStart(4, '0')}`)

const VERIFIER = at(0x2600, 0xf00d)
const shared: Account[] = [{ address: VERIFIER, balance: 0n, nonce: 1n, code: VERIFIER_RUNTIME, storage: [] }]

// Distinct accounts the state-reading workloads touch, each with code so the trace rules let a
// prefix reach it: 64 one-byte contracts, and 40 each at 24,576 and 65,536 bytes (the pre- and
// post-EIP-7954 maximums), all STOP followed by JUMPDEST filler.
const SMALL = Array.from({ length: 64 }, (_, i) => at(0x26c0, i))
const CODE_24K = Array.from({ length: 40 }, (_, i) => at(0x2624, i))
const CODE_64K = Array.from({ length: 40 }, (_, i) => at(0x2664, i))
for (const a of SMALL) shared.push({ address: a, balance: 0n, nonce: 1n, code: '0x00', storage: [] })
// The large ones are written as one `filler` line each set and expanded by the harness.
const FILLERS: [Address[], number][] = [
  [CODE_24K, 24_576],
  [CODE_64K, 65_536],
]

// ---- workloads ----

type Workload = { name: string; group: 'realistic' | 'fill'; note: string; limit: bigint; account: Account; tx: FrameTx }
const workloads: Workload[] = []
let next = 0

const approve = 'verbatim_3i_0o(hex"aa", 0, 0, 3)'
const program = (name: string, body: string, data: Record<string, Hex> = {}) =>
  `// exp-frames/26: ${name}. Generated by workloads.ts.\nobject "${name}" {\n  code {\n${body
    .trim()
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n')}\n    ${approve}\n    stop()\n  }\n${Object.entries(data)
    .map(([k, v]) => `  data "${k}" hex"${hex(v)}"\n`)
    .join('')}}\n`

/** A precompile called `n` times on one input, every call required to succeed. */
const callLoop = (precompile: number, input: Hex, outSize: number, n: number, check = '') =>
  `datacopy(0, dataoffset("in"), datasize("in"))
for { let i := 0 } lt(i, ${n}) { i := add(i, 1) } {
  if iszero(staticcall(gas(), ${precompile}, 0, datasize("in"), 0x4000, ${outSize})) { revert(0, 0) }
}
${check}`

async function add(name: string, group: Workload['group'], note: string, limit: bigint, body: string, data: Record<string, Hex> = {}, storage: [bigint, bigint][] = []) {
  const code = yul(name, program(name, body, data))
  const address = at(0x2600, next++)
  const tx: FrameTx = {
    chainId: 8141n,
    nonceKeys: [0n],
    nonceSeq: 0n,
    sender: address,
    frames: [verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: limit }), senderFrame({ target: SMALL[0], execution: 21_000n })],
    signatures: [],
    fees: { maxPriorityFeePerGas: 1_000_000_000n, maxFeePerGas: 4_000_000_000n, maxFeePerBlobGas: 0n },
    blobVersionedHashes: [],
  }
  workloads.push({ name, group, note, limit, account: { address, balance: 100n * ETH, nonce: 0n, code, storage }, tx })
}

// Realistic.
await add('empty', 'realistic', 'APPROVE and nothing else: the fixed cost of an admission', 10_000n, '')
{
  const key = keccak256(toBytes('exp-frames/26 default-code EOA'))
  const address = privateKeyToAddress(key)
  const unsigned: FrameTx = {
    chainId: 8141n,
    nonceKeys: [0n],
    nonceSeq: 0n,
    sender: address,
    frames: [verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution: 5_000n }), senderFrame({ target: SMALL[0], execution: 21_000n })],
    signatures: [secp256k1Placeholder()],
    fees: { maxPriorityFeePerGas: 1_000_000_000n, maxFeePerGas: 4_000_000_000n, maxFeePerBlobGas: 0n },
    blobVersionedHashes: [],
  }
  workloads.push({
    name: 'eoa',
    group: 'realistic',
    note: 'default code: one SECP256K1 entry, checked by the protocol',
    limit: 5_000n,
    account: { address, balance: 100n * ETH, nonce: 0n, code: '0x', storage: [] },
    tx: await signFrameTx(unsigned, key),
  })
}
await add(
  'groth16-tornado',
  'realistic',
  `Tornado's verifier, patched as in 06, on the proof of ${WITHDRAWAL.slice(0, 10)}... (06), called from VERIFY`,
  600_000n,
  `datacopy(0, dataoffset("in"), datasize("in"))
if iszero(staticcall(gas(), ${VERIFIER.toLowerCase()}, 0, datasize("in"), 0x4000, 32)) { revert(0, 0) }
if iszero(eq(mload(0x4000), 1)) { revert(0, 0) }`,
  { in: VERIFY_PROOF_IN },
)
await add(
  'ecrecover-40',
  'realistic',
  '40 ECDSA recoveries, the 40-key multisig of 05',
  200_000n,
  callLoop(1, ECRECOVER_IN, 32, 40, `if iszero(eq(mload(0x4000), ${ECDSA_SIGNER.toLowerCase()})) { revert(0, 0) }`),
  { in: ECRECOVER_IN },
)
await add(
  'p256-1',
  'realistic',
  'one P256VERIFY, the passkey account of 11',
  20_000n,
  callLoop(0x100, P256_IN, 32, 1, 'if iszero(eq(mload(0x4000), 1)) { revert(0, 0) }'),
  { in: P256_IN },
)
await add(
  'wots-shape',
  'realistic',
  '513 keccak-256 of 32 bytes: a w = 16 WOTS signature (67 chains, 7.5 steps on average) and a 10-level path, as in 17',
  100_000n,
  `for { let i := 0 } lt(i, 513) { i := add(i, 1) } { mstore(0, keccak256(0, 32)) }`,
)

// Fill: one operation, about 100,000 gas.
const fill = (name: string, note: string, body: string, data: Record<string, Hex> = {}, storage: [bigint, bigint][] = []) =>
  add(name, 'fill', note, 120_000n, body, data, storage)

await fill('fill-mulmod', 'MULMOD on 256-bit operands', `let x := 7
for { let i := 0 } lt(i, 1200) { i := add(i, 1) } { x := mulmod(x, x, 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f) }
mstore(0, x)`)
await fill('fill-exp', 'EXP with a 32-byte exponent', `let x := 3
for { let i := 0 } lt(i, 60) { i := add(i, 1) } { x := exp(x, 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff1) }
mstore(0, x)`)
await fill('fill-keccak-32', 'KECCAK256 of 32 bytes, chained', `for { let i := 0 } lt(i, 1300) { i := add(i, 1) } { mstore(0, keccak256(0, 32)) }`)
await fill('fill-keccak-1k', 'KECCAK256 of 1,024 bytes', `mstore(1000, 1)
for { let i := 0 } lt(i, 420) { i := add(i, 1) } { mstore(0, keccak256(0, 1024)) }`)
await fill('fill-ecrecover', 'ECRECOVER (0x01)', callLoop(1, ECRECOVER_IN, 32, 31), { in: ECRECOVER_IN })
await fill('fill-sha256', 'SHA256 (0x02), 32 bytes', callLoop(2, word(1n), 32, 450), { in: word(1n) })
await fill('fill-ripemd', 'RIPEMD160 (0x03), 32 bytes', callLoop(3, word(1n), 32, 115), { in: word(1n) })
await fill('fill-identity', 'IDENTITY (0x04), 32 bytes', callLoop(4, word(1n), 32, 600), { in: word(1n) })
await fill('fill-modexp-256', 'MODEXP (0x05), 256-bit base, exponent and modulus', callLoop(5, MODEXP_256, 32, 20), { in: MODEXP_256 })
await fill('fill-modexp-2048', 'MODEXP (0x05), 2048-bit base and modulus, exponent 3', callLoop(5, MODEXP_2048, 256, 40), { in: MODEXP_2048 })
await fill('fill-ecadd', 'alt_bn128 ADD (0x06)', callLoop(6, BN_ECADD_IN, 64, 320), { in: BN_ECADD_IN })
await fill('fill-ecmul', 'alt_bn128 MUL (0x07)', callLoop(7, BN_ECMUL_IN, 64, 16), { in: BN_ECMUL_IN })
await fill('fill-ecpairing', 'alt_bn128 PAIRING (0x08), one pair', callLoop(8, BN_PAIRING_IN, 32, 1), { in: BN_PAIRING_IN })
await fill('fill-blake2f-12', 'BLAKE2F (0x09), 12 rounds', callLoop(9, blake(12), 64, 550), { in: blake(12) })
await fill('fill-blake2f-90k', 'BLAKE2F (0x09), 90,000 rounds', callLoop(9, blake(90_000), 64, 1), { in: blake(90_000) })
await fill('fill-bls-g1add', 'BLS12_G1ADD (0x0b)', callLoop(0x0b, BLS_G1ADD_IN, 128, 200), { in: BLS_G1ADD_IN })
await fill('fill-bls-pairing', 'BLS12_PAIRING_CHECK (0x0f), one pair', callLoop(0x0f, BLS_PAIRING_IN, 32, 1), { in: BLS_PAIRING_IN })
await fill('fill-bls-map-g2', 'BLS12_MAP_FP2_TO_G2 (0x11)', callLoop(0x11, BLS_MAP_FP2_IN, 256, 4), { in: BLS_MAP_FP2_IN })
await fill('fill-p256', 'P256VERIFY (0x100)', callLoop(0x100, P256_IN, 32, 14), { in: P256_IN })
await fill(
  'fill-sload',
  "cold SLOAD of the sender's own slots, 1 to 45",
  `let s := 0
for { let i := 1 } lt(i, 46) { i := add(i, 1) } { s := add(s, sload(i)) }
mstore(0, s)`,
  {},
  Array.from({ length: 64 }, (_, i) => [BigInt(i + 1), BigInt(i + 1)] as [bigint, bigint]),
)
const table = (as: Address[]) => concat(as.map((a) => pad(a, { size: 32 })))
await fill(
  'fill-extcodehash',
  'EXTCODEHASH of 33 distinct cold accounts',
  `datacopy(0, dataoffset("in"), datasize("in"))
let s := 0
for { let i := 0 } lt(i, 33) { i := add(i, 1) } { s := xor(s, extcodehash(mload(mul(i, 32)))) }
mstore(0x4000, s)`,
  { in: table(SMALL) },
)
const callCold = (as: Address[], n: number) => `datacopy(0, dataoffset("in"), datasize("in"))
for { let i := 0 } lt(i, ${n}) { i := add(i, 1) } {
  if iszero(staticcall(gas(), mload(mul(i, 32)), 0, 0, 0, 0)) { revert(0, 0) }
}`
await fill('fill-call-24k', 'STATICCALL into distinct cold 24,576-byte contracts', callCold(CODE_24K, 30), { in: table(CODE_24K) })
await fill('fill-call-64k', 'STATICCALL into distinct cold 65,536-byte contracts', callCold(CODE_64K, 30), { in: table(CODE_64K) })

// ---- output ----

const lines: string[] = [
  '# Experiment 26: validation-prefix workloads for ethrex/exp26_validation_cpu.rs. Generated by workloads.ts.',
  `# solc ${solc.version()}, evmVersion ${EVM_VERSION}, optimizer 200 runs. Chain id 8141.`,
  '# account <address> <balance> <nonce> <code>; slot <address> <slot> <value>; filler <first address> <count> <bytes>;',
  '# workload <name> <group> <sender> <note>; tx <envelope>',
]
const account = (a: Account) => [
  `account ${a.address} ${toHex(a.balance)} ${a.nonce} ${a.code}`,
  ...a.storage.map(([k, v]) => `slot ${a.address} ${toHex(k)} ${toHex(v)}`),
]
lines.push(...shared.flatMap(account))
// filler <first address> <count> <bytes>: `count` consecutive addresses, code STOP then JUMPDESTs.
for (const [as, size] of FILLERS) lines.push(`filler ${as[0]} ${as.length} ${size}`)
for (const w of workloads) {
  lines.push(...account(w.account))
  lines.push(`workload ${w.name} ${w.group} ${w.account.address} ${w.note}`)
  lines.push(`tx ${serializeFrameTx(w.tx)}`)
}
mkdirSync(join(HERE, 'ethrex'), { recursive: true })
writeFileSync(join(HERE, 'ethrex', 'workloads.txt'), `${lines.join('\n')}\n`)
console.log(`${workloads.length} workloads, ${shared.length + FILLERS.reduce((n, [as]) => n + as.length, 0)} shared accounts -> ethrex/workloads.txt`)
