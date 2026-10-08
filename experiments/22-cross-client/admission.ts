// Experiment 22, part B: what each client refuses, and what it says.
//
// Every probe is a transaction that must not be admitted: unfunded, statically invalid, invalid
// in its signatures, or outside the public mempool's rules. Each is sent to each client alone
// (pinned through the balancer, one at a time), and the client's refusal is recorded verbatim.
// Nothing here needs funds and nothing can land. Every probe has its own sender, a key derived
// from a public string, so one probe cannot leave state another trips over, and the script stops
// if any of them holds a balance.
//
// The interesting output is not that the clients refuse, it is which rule each one names first.
// The EIP orders some checks (stateless before sender state; signatures before frames) and leaves
// the rest to the client, and a wallet reads these messages to decide what to fix.
//
// Each probe is sent twice. Priced, with fees over the base fee, which nobody can pay. Free, with
// every fee zero, so that `max_cost` is zero and a client that checks the balance first has to
// say what else is wrong. A free `unfunded` probe is valid apart from its fee, and a client may
// hold it; it cannot be included while the base fee is above zero.
//
// usage: npx tsx experiments/22-cross-client/admission.ts [--dry]
import { p256 } from '@noble/curves/p256'
import { type Address, type Hex, concatHex, fromRlp, hexToBigInt, hexToBytes, keccak256, numberToHex, pad, toHex, toRlp } from 'viem'
import { privateKeyToAddress } from 'viem/accounts'
import {
  ATOMIC_BATCH_FLAG,
  Approve,
  FRAMES_DEVNET_0_RPC_URL,
  type Frame,
  type FrameSignature,
  type FrameTx,
  type FrameTxFees,
  Mode,
  NEW_ACCOUNT_STATE_GAS,
  Scheme,
  TX_MAX_GAS_LIMIT,
  expiryFrame,
  frameSigHash,
  makeClient,
  p256Address,
  p256PublicKey,
  p256Sign,
  rpc,
  secp256k1Placeholder,
  secp256k1Sign,
  senderFrame,
  serializeFrameTx,
  signAll,
  suggestFees,
  verifyFrame,
} from '../../src/frametx/index.js'
import { CLIENTS, type ClientName } from './observe.js'

const derive = (label: string) => keccak256(toHex(`exp-frames/22 admission probe ${label}`))
const SPONSOR_KEY = derive('sponsor')
const OTHER_KEY = derive('other')
const SPONSOR = privateKeyToAddress(SPONSOR_KEY)
const OTHER = privateKeyToAddress(OTHER_KEY)
const P256_KEY = { scheme: 'p256' as const, privateKey: derive('p256') }
const DEAD: Address = '0x000000000000000000000000000000000000dEaD'
const IDENTITY: Address = '0x0000000000000000000000000000000000000004'
const SECP256K1N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

/** One probe's base transaction and the key that signs as its sender. */
type Base = FrameTx & { key: Hex }

type Probe = {
  name: string
  /** The rule the probe breaks, and where the EIP states it. */
  rule: string
  /** A refusal that names the rule. */
  names: RegExp
  raw: (base: Base) => Promise<Hex>
}

// Every sender here is new, so the frame that approves payment budgets APPROVE's new-account charge.
const self = (execution = 10_000n, state = NEW_ACCOUNT_STATE_GAS) => verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution, state })
const transfer = (over: Partial<Frame> = {}): Frame => ({ ...senderFrame({ target: DEAD, execution: 10_000n }), ...over })

let now = 0n
const deadline = () => now + 3_600n

/** `base` with some fields replaced, signed by the sender (and any `extra` keys it names). */
async function signed({ key, ...base }: Base, over: Partial<FrameTx>, extra: Hex[] = []): Promise<Hex> {
  return serializeFrameTx(await signAll({ ...base, ...over }, [key, ...extra]))
}

/** Replace one top-level field of the RLP payload with raw bytes, for encodings the encoder refuses. */
function patchField(raw: Hex, index: number, value: Hex | Hex[]): Hex {
  const fields = fromRlp(`0x${raw.slice(4)}`) as unknown as (Hex | Hex[])[]
  fields[index] = value
  return concatHex(['0x06', toRlp(fields as never)])
}

/** The sender's SECP256K1 entry, signed and then changed by `edit`. */
async function editedSecp({ key, ...base }: Base, edit: (v: number, r: bigint, s: bigint) => [number, bigint, bigint]): Promise<Hex> {
  const tx = { ...base, signatures: [secp256k1Placeholder()] }
  const sig = await secp256k1Sign(frameSigHash(tx), key)
  const [v, r, s] = edit(Number.parseInt(sig.slice(2, 4), 16), hexToBigInt(`0x${sig.slice(4, 68)}`), hexToBigInt(`0x${sig.slice(68)}`))
  const bytes = concatHex([numberToHex(v, { size: 1 }), pad(numberToHex(r), { size: 32 }), pad(numberToHex(s), { size: 32 })])
  return serializeFrameTx({ ...tx, signatures: [{ ...tx.signatures[0], signature: bytes }] })
}

/**
 * The sender's entry over the sig hash, and a second entry with an explicit `msg`. The second is
 * someone else's, so `signAll` leaves it as it is, and its bytes are signed into the sig hash.
 */
async function withExplicit(base: Base, msg: Hex): Promise<Hex> {
  const explicit: FrameSignature = { scheme: Scheme.SECP256K1, signer: OTHER, msg, signature: await secp256k1Sign(pad(msg, { size: 32 }), OTHER_KEY) }
  return signed(base, { signatures: [secp256k1Placeholder(), explicit] })
}

/**
 * The sender's entry, and a second entry over the sig hash that no frame reads, filled by `fill`.
 * Its bytes are outside the sig hash, so it can be filled after the sender has signed.
 */
async function withSecond({ key, ...base }: Base, second: FrameSignature, fill: (sigHash: Hex) => Promise<Hex> | Hex): Promise<Hex> {
  const tx = await signAll({ ...base, signatures: [secp256k1Placeholder(), second] }, [key])
  return serializeFrameTx({ ...tx, signatures: [tx.signatures[0], { ...second, signature: await fill(frameSigHash(tx)) }] })
}

const SIGNATURE = /signature|signer|recover|canonical|p-?256|public key/

const probes: Probe[] = [
  // ---- the baseline: well formed, correctly signed, nobody can pay ----
  { name: 'unfunded', rule: 'none but funds: APPROVE reverts, the payer cannot cover max_cost', names: /insufficient|balance|funds/, raw: (b) => signed(b, {}) },
  {
    name: 'unfunded-sponsored',
    rule: 'as above, a default-code sponsor paying (only_verify, pay); pay budgets the sender\'s creation',
    names: /insufficient|balance|funds/,
    raw: (b) =>
      signed(
        b,
        {
          frames: [verifyFrame({ scope: Approve.EXECUTION, execution: 10_000n }), verifyFrame({ scope: Approve.PAYMENT, target: SPONSOR, execution: 10_000n, state: NEW_ACCOUNT_STATE_GAS }), transfer()],
          signatures: [secp256k1Placeholder(), secp256k1Placeholder(SPONSOR)],
        },
        [SPONSOR_KEY],
      ),
  },

  // A sender's first transaction creates its account, and APPROVE charges the creation to the
  // approving frame's state budget. Without it, APPROVE halts before it looks at the balance.
  { name: 'new-account-no-state', rule: 'APPROVE halts: the new-account charge exceeds the frame\'s state budget', names: /state/, raw: (b) => signed(b, { frames: [self(10_000n, 0n), transfer()] }) },
  // A cancel: one VERIFY frame that bumps the nonce. Its calldata floor binds, at about 19,400 gas
  // in all. Valid for any existing, funded EOA; these senders do not exist, so it also fails on
  // the new-account charge.
  { name: 'cancel', rule: 'none but funds and existence: a one-frame nonce bump, max_gas about 19,400', names: /insufficient funds|balance|revert|execution failed/, raw: (b) => signed(b, { frames: [self(480n, 0n)] }) },

  // ---- decoding ----
  { name: 'keyed-envelope', rule: 'Payload Encoding: 7 fields (EIP-8250 adds nonce_keys)', names: /rlp|decod|nonce/, raw: async ({ key, ...b }) => serializeFrameTx(await signAll({ ...b, envelope: undefined }, [key])) },
  { name: 'nonce-leading-zero', rule: 'RLP: integers are minimal', names: /rlp|canonical|malformed|decod/, raw: async (b) => patchField(await signed(b, {}), 1, '0x00') },
  { name: 'empty-list', rule: 'Payload Encoding', names: /rlp|decod|too few/, raw: async () => '0x06c0' },

  // ---- static constraints ----
  { name: 'wrong-chain-id', rule: 'chain_id is this chain', names: /chain/, raw: (b) => signed(b, { chainId: 8141n }) },
  { name: 'nonce-2^64', rule: 'Constraints: nonce < 2**64', names: /nonce|uint64|rlp|decod/, raw: (b) => signed(b, { nonceSeq: 2n ** 64n }) },
  { name: 'no-frames', rule: 'Constraints: 0 < len(frames)', names: /between 1 and 64|frame count/, raw: (b) => signed(b, { frames: [] }) },
  { name: '65-frames', rule: 'Constraints: len(frames) <= MAX_FRAMES', names: /between 1 and 64|frame count|too many frames/, raw: (b) => signed(b, { frames: [self(), ...Array.from({ length: 64 }, () => transfer({ limits: { execution: 100n, state: 0n } }))] }) },
  { name: 'mode-3', rule: 'Constraints: mode < 3', names: /mode|post_tx/, raw: (b) => signed(b, { frames: [self(), transfer({ mode: 3 })] }) },
  { name: 'flags-8', rule: 'Constraints: flags < 8', names: /reserved|flag/, raw: (b) => signed(b, { frames: [self(), transfer({ flags: 8 })] }) },
  { name: 'value-in-verify', rule: 'Constraints: only SENDER frames carry value', names: /value/, raw: (b) => signed(b, { frames: [{ ...self(), value: 1n }, transfer()] }) },
  { name: 'value-in-default', rule: 'Constraints: only SENDER frames carry value', names: /value/, raw: (b) => signed(b, { frames: [self(), transfer({ mode: Mode.DEFAULT, value: 1n })] }) },
  { name: 'approve-execution-elsewhere', rule: 'Constraints: APPROVE_EXECUTION only on tx.sender', names: /target|sender/, raw: (b) => signed(b, { frames: [verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, target: DEAD, execution: 10_000n }), transfer()] }) },
  { name: 'atomic-last', rule: 'Constraints: an atomic flag needs a next frame', names: /atomic/, raw: (b) => signed(b, { frames: [self(), transfer({ flags: ATOMIC_BATCH_FLAG })] }) },
  { name: 'atomic-into-verify', rule: 'Constraints: batches contain no VERIFY frame', names: /atomic/, raw: (b) => signed(b, { frames: [self(), transfer({ flags: ATOMIC_BATCH_FLAG }), self()] }) },
  { name: 'scope-in-batch', rule: 'Constraints: no approval scope in a batch', names: /atomic|batch/, raw: (b) => signed(b, { frames: [self(), transfer({ flags: ATOMIC_BATCH_FLAG }), transfer({ flags: Approve.PAYMENT })] }) },
  { name: 'gas-over-cap', rule: 'Constraints: intrinsic + execution <= TX_MAX_GAS_LIMIT', names: /cap|7825|16777216/, raw: (b) => signed(b, { frames: [self(), transfer({ limits: { execution: TX_MAX_GAS_LIMIT, state: 0n } })] }) },
  { name: 'gas-over-2^64', rule: 'Constraints: total frame gas < 2**64', names: /uint64|u64|rlp|decod|length/, raw: (b) => signed(b, { frames: [self(), transfer({ limits: { execution: 10_000n, state: 2n ** 64n } })] }) },
  { name: 'blob-fee-no-blobs', rule: 'Constraints: max_fee_per_blob_gas == 0 without blobs', names: /blob/, raw: (b) => signed(b, { fees: { ...b.fees, maxFeePerBlobGas: 1n } }) },
  { name: 'blob-hash-version', rule: 'Constraints: versioned hash starts 0x01', names: /version/, raw: (b) => signed(b, { blobVersionedHashes: [pad('0x02', { size: 32, dir: 'right' })], fees: { ...b.fees, maxFeePerBlobGas: 1n } }) },

  // ---- signature entries ----
  { name: 'scheme-3', rule: 'Constraints: scheme in {ARBITRARY, SECP256K1, P256}', names: /scheme/, raw: async (b) => signed(b, { signatures: [secp256k1Placeholder(), { scheme: 3, signer: null, msg: '0x', signature: '0x01' }] }) },
  { name: 'arbitrary-with-signer', rule: 'Constraints: ARBITRARY has no signer', names: /arbitrary|signer/, raw: (b) => signed(b, { signatures: [secp256k1Placeholder(), { scheme: Scheme.ARBITRARY, signer: b.sender, msg: '0x', signature: '0x01' }] }) },
  { name: 'msg-31-bytes', rule: 'Constraints: msg is empty or 32 bytes', names: /msg|digest/, raw: (b) => withExplicit(b, pad('0x01', { size: 31 })) },
  { name: 'msg-zero', rule: 'Constraints: msg is not 32 zero bytes', names: /msg|digest/, raw: (b) => withExplicit(b, pad('0x00', { size: 32 })) },
  { name: 'secp-high-s', rule: 'validate_signature: s <= n/2', names: SIGNATURE, raw: (b) => editedSecp(b, (v, r, s) => [v ^ 1, r, SECP256K1N - s]) },
  { name: 'secp-v-27', rule: 'validate_signature: v is 0 or 1', names: SIGNATURE, raw: (b) => editedSecp(b, (v, r, s) => [v + 27, r, s]) },
  { name: 'secp-r-zero', rule: 'validate_signature: 0 < r', names: SIGNATURE, raw: (b) => editedSecp(b, (v, _r, s) => [v, 0n, s]) },
  {
    name: 'secp-other-signer',
    rule: 'validate_signature: ecrecover == resolved signer (the entry the default code reads)',
    names: SIGNATURE,
    raw: async ({ key: _, ...b }) => {
      const tx = { ...b, signatures: [secp256k1Placeholder()] }
      return serializeFrameTx({ ...tx, signatures: [{ ...tx.signatures[0], signature: await secp256k1Sign(frameSigHash(tx), OTHER_KEY) }] })
    },
  },
  {
    name: 'unused-secp-wrong',
    rule: 'validate_signature on an entry no frame reads: ecrecover == signer',
    names: SIGNATURE,
    raw: (b) => withSecond(b, secp256k1Placeholder(OTHER), (h) => secp256k1Sign(h, b.key)),
  },
  {
    name: 'unused-p256-wrong',
    rule: 'validate_signature on an entry no frame reads: P256VERIFY',
    names: SIGNATURE,
    raw: (b) => withSecond(b, { scheme: Scheme.P256, signer: p256Address(P256_KEY), msg: '0x', signature: '0x' }, (h) => p256Sign(keccak256(h), P256_KEY)),
  },
  {
    name: 'p256-signer-not-key',
    rule: 'validate_signature: P256 signer == keccak(qx || qy)[12:]',
    names: SIGNATURE,
    raw: (b) => withSecond(b, { scheme: Scheme.P256, signer: SPONSOR, msg: '0x', signature: '0x' }, (h) => p256Sign(h, P256_KEY)),
  },
  {
    name: 'p256-high-s',
    rule: 'validate_signature: P256 s <= n/2',
    names: SIGNATURE,
    raw: (b) =>
      withSecond(b, { scheme: Scheme.P256, signer: p256Address(P256_KEY), msg: '0x', signature: '0x' }, (h) => {
        const sig = p256.sign(hexToBytes(h), hexToBytes(P256_KEY.privateKey), { prehash: false, lowS: true })
        const { qx, qy } = p256PublicKey(P256_KEY)
        return concatHex([pad(numberToHex(sig.r), { size: 32 }), pad(numberToHex(p256.CURVE.n - sig.s), { size: 32 }), qx, qy])
      }),
  },

  // ---- expiry verifier frame ----
  { name: 'expiry-flags', rule: 'Expiry Verifier Frame: flags == 0', names: /expiry/, raw: (b) => signed(b, { frames: [{ ...expiryFrame(deadline()), flags: 1 }, self(), transfer()] }) },
  { name: 'expiry-7-bytes', rule: 'Expiry Verifier Frame: len(data) == 8', names: /expiry/, raw: (b) => signed(b, { frames: [{ ...expiryFrame(deadline()), data: '0x00000000ffffff' }, self(), transfer()] }) },
  { name: 'expiry-state-gas', rule: 'Expiry Verifier Frame: limits.state == 0', names: /expiry/, raw: (b) => signed(b, { frames: [{ ...expiryFrame(deadline()), limits: { execution: 5_000n, state: 1n } }, self(), transfer()] }) },
  { name: 'two-expiry', rule: 'Expiry Verifier Frame: at most one', names: /expiry/, raw: (b) => signed(b, { frames: [expiryFrame(deadline()), expiryFrame(deadline()), self(), transfer()] }) },
  { name: 'expiry-past', rule: 'Mempool: drop a passed deadline', names: /expir|deadline/, raw: (b) => signed(b, { frames: [expiryFrame(deadline() - 7_200n), self(), transfer()] }) },
  { name: 'expiry-second', rule: 'Mempool: expiry_verify only as the first frame', names: /expiry|after (its |the )?validation prefix/, raw: (b) => signed(b, { frames: [self(), expiryFrame(deadline()), transfer()] }) },

  // ---- public mempool structure ----
  { name: 'no-verify', rule: 'Behavior: SENDER needs sender_approved; Mempool: no recognised prefix', names: /recogni|payer|shape/, raw: (b) => signed(b, { frames: [transfer()] }) },
  { name: 'no-signature', rule: 'Default code: needs a SECP256K1 entry at index 0', names: /signature/, raw: async ({ key: _, ...b }) => serializeFrameTx({ ...b, signatures: [] }) },
  {
    name: 'pay-before-verify',
    rule: 'Mempool: no recognised prefix (APPROVE_PAYMENT before execution)',
    names: /recogni|shape|after (its |the )?validation prefix/,
    raw: (b) => signed(b, { frames: [verifyFrame({ scope: Approve.PAYMENT, execution: 10_000n }), verifyFrame({ scope: Approve.EXECUTION, execution: 10_000n }), transfer()], signatures: [secp256k1Placeholder(), secp256k1Placeholder()] }),
  },
  // A VERIFY frame that succeeds (the identity precompile), so only the mempool rule is broken.
  { name: 'verify-after-prefix', rule: 'Mempool rule 8: no VERIFY after the prefix', names: /after/, raw: (b) => signed(b, { frames: [self(), transfer(), verifyFrame({ scope: Approve.NONE, target: IDENTITY, execution: 5_000n, data: '0x01' })] }) },
  { name: 'two-default-first', rule: 'Mempool rule 2: at most one deploy, first', names: /recogni|shape|deploy/, raw: (b) => signed(b, { frames: [transfer({ mode: Mode.DEFAULT }), transfer({ mode: Mode.DEFAULT }), self(), transfer()] }) },
  { name: 'verify-gas-150k', rule: 'Mempool rule 6: prefix execution <= MAX_VERIFY_GAS (100,000)', names: /max_verify_gas|verification gas|gas budget/, raw: (b) => signed(b, { frames: [self(150_000n), transfer()] }) },
  { name: 'verify-gas-600k', rule: 'Mempool rule 6, against a 500,000 cap', names: /max_verify_gas|verification gas|gas budget/, raw: (b) => signed(b, { frames: [self(600_000n), transfer()] }) },
  { name: 'verify-state-600k', rule: 'Mempool rule 6: prefix state <= MAX_VERIFY_STATE_GAS (500,000)', names: /state/, raw: (b) => signed(b, { frames: [self(10_000n, 600_000n), transfer()] }) },
]

type Answer = { accepted: boolean; message: string }

/** `eth_sendRawTransaction` to one client, without viem's retries (a retry would send it twice). */
async function send(client: ClientName, raw: Hex): Promise<Answer> {
  const response = await fetch(FRAMES_DEVNET_0_RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-ERPC-Use-Upstream': `*${client}*`, 'X-ERPC-Skip-Cache-Read': 'true' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] }),
  })
  // eRPC sends no x-erpc-upstream header with an error; a success is checked like any pinned call.
  const answered = response.headers.get('x-erpc-upstream')
  if (answered && !answered.includes(client)) throw new Error(`asked ${client}, answered by ${answered.replace(/#.*/, '')}`)
  const body = (await response.json()) as { result?: Hex; error?: { message: string } }
  return body.error ? { accepted: false, message: body.error.message } : { accepted: true, message: `accepted ${body.result}` }
}

/** `✓` when the refusal names the broken rule, otherwise what it named instead. */
export function classify(probe: Probe, answer: Answer): string {
  const m = answer.message.toLowerCase()
  if (answer.accepted) return '**accepted**'
  if (/^already known|already imported|known transaction/.test(m)) return 'already known'
  // geth's balance message mentions "value", which some probes' rules also name.
  if (/insufficient funds/.test(m) && !probe.names.test('insufficient funds')) return 'sender balance'
  if (probe.names.test(m)) return '✓'
  const instead: [RegExp, string][] = [
    [/insufficient funds|insufficient balance/, 'sender balance'],
    [/underpriced|fee cap|base ?fee|tip|max fee|maxfeepergas|fee too low|feetoolow/, 'fee'],
    [/rlp|decod/, 'decoder'],
    [/floor data gas|intrinsic gas|insufficient gas/, 'gas floor'],
    [/never set a payer|recogni|shape|structure|after (its |the )?validation prefix/, 'prefix shape'],
    [/revert|execution failed|simulation failed/, 'prefix reverted'],
    [/use-upstream/, 'balancer'],
  ]
  return instead.find(([re]) => re.test(m))?.[1] ?? 'other'
}

async function main() {
  const dry = process.argv.includes('--dry')
  const client = makeClient(FRAMES_DEVNET_0_RPC_URL)
  const block = await client.getBlock({ blockTag: 'latest' })
  now = block.timestamp
  const priced = await suggestFees(client)
  const free: FrameTxFees = { maxPriorityFeePerGas: 0n, maxFeePerGas: 0n, maxFeePerBlobGas: 0n }
  const passes = [
    ['priced', priced],
    ['free', free],
  ] as const

  const bases = new Map<string, Base>()
  for (const [pass, fees] of passes) {
    for (const probe of probes) {
      const key = derive(`${pass} ${probe.name}`)
      const sender = privateKeyToAddress(key)
      const [balance, nonce] = await Promise.all([rpc<Hex>(client, 'eth_getBalance', [sender, 'latest']), rpc<Hex>(client, 'eth_getTransactionCount', [sender, 'latest'])])
      if (hexToBigInt(balance) !== 0n) throw new Error(`${sender} holds ${hexToBigInt(balance)} wei; these probes assume nobody can pay`)
      bases.set(`${pass} ${probe.name}`, {
        key,
        chainId: 7_034_189_865n,
        envelope: 'plain',
        nonceKeys: [0n],
        nonceSeq: hexToBigInt(nonce),
        sender,
        frames: [self(), transfer()],
        signatures: [secp256k1Placeholder()],
        fees,
        blobVersionedHashes: [],
      })
    }
  }
  if (hexToBigInt(await rpc<Hex>(client, 'eth_getBalance', [SPONSOR, 'latest'])) !== 0n) throw new Error(`${SPONSOR} holds a balance`)

  console.log(`## Admission probes\n\nBlock ${block.number}, ${new Date(Number(now) * 1000).toISOString()}, base fee ${block.baseFeePerGas} wei. Priced probes offer \`maxFeePerGas\` ${priced.maxFeePerGas} and a tip of ${priced.maxPriorityFeePerGas}; free probes offer zero. Every sender, and the sponsor \`${SPONSOR}\`, is unfunded.\n`)
  const results: { pass: string; probe: Probe; hash: Hex; answers: Record<ClientName, Answer> }[] = []
  for (const [pass] of passes) {
    for (const probe of probes) {
      const raw = await probe.raw(bases.get(`${pass} ${probe.name}`) as Base)
      if (dry) {
        console.log(`- ${pass} ${probe.name}: ${raw.slice(0, 60)}... (${(raw.length - 2) / 2} bytes)`)
        continue
      }
      const answers = {} as Record<ClientName, Answer>
      for (const c of CLIENTS) answers[c] = await send(c, raw)
      results.push({ pass, probe, hash: keccak256(raw), answers })
    }
  }
  if (dry) return

  console.log('`✓`: the refusal names the rule the probe breaks. Otherwise, what it named instead; the messages are below.\n')
  console.log(`| Probe | Rule broken | ${passes.flatMap(([p]) => CLIENTS.map((c) => `${c} (${p})`)).join(' | ')} |`)
  console.log(`|---|---|${passes.flatMap(() => CLIENTS.map(() => '---')).join('|')}|`)
  for (const probe of probes) {
    const cells = passes.flatMap(([p]) => {
      const r = results.find((x) => x.pass === p && x.probe === probe)
      return CLIENTS.map((c) => (r ? classify(probe, r.answers[c]) : ''))
    })
    console.log(`| \`${probe.name}\` | ${probe.rule} | ${cells.join(' | ')} |`)
  }
  for (const [pass] of passes) {
    console.log(`\n### Verbatim, ${pass}\n`)
    for (const { probe, hash, answers } of results.filter((r) => r.pass === pass)) {
      console.log(`#### \`${probe.name}\` (${pass})\n\n${probe.rule}. \`keccak256(raw)\` = \`${hash}\`.\n`)
      for (const c of CLIENTS) console.log(`- ${c}: ${answers[c].message.replace(/\|/g, '\\|').slice(0, 300)}`)
      console.log('')
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
