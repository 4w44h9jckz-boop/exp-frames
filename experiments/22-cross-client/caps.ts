// Experiment 22, part C: where each client draws the validation prefix's two gas caps.
//
// The EIP's public mempool caps the validation prefix at MAX_VERIFY_GAS = 100,000 execution gas,
// counting the signatures' verification cost with the frames' limits, and at MAX_VERIFY_STATE_GAS
// = 500,000 state gas. Part B found a 150,000 prefix refused by two clients and not by a third.
// This bisects each client's boundary: the smallest limit it refuses by naming the cap, with
// every other variable held still. The probes are unfunded, as in part B, so a limit inside the
// cap is refused too, for funds, which is how "inside" is told apart from "over".
//
// The boundary is only meaningful for a client that checks the cap before the balance; a client
// that checks the balance first refuses everything for funds, and the search says so.
//
// usage: npx tsx experiments/22-cross-client/caps.ts
import { type Hex, hexToBigInt, keccak256, toHex } from 'viem'
import { privateKeyToAddress } from 'viem/accounts'
import {
  Approve,
  FRAMES_DEVNET_0_RPC_URL,
  type FrameTx,
  NEW_ACCOUNT_STATE_GAS,
  SIGNATURE_GAS,
  Scheme,
  makeClient,
  rpc,
  secp256k1Placeholder,
  senderFrame,
  serializeFrameTx,
  signAll,
  suggestFees,
  verifyFrame,
} from '../../src/frametx/index.js'
import { CLIENTS, type ClientName } from './observe.js'

const KEY = keccak256(toHex('exp-frames/22 caps probe'))
const SENDER = privateKeyToAddress(KEY)

async function send(client: ClientName, raw: Hex): Promise<string> {
  const response = await fetch(FRAMES_DEVNET_0_RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-ERPC-Use-Upstream': `*${client}*`, 'X-ERPC-Skip-Cache-Read': 'true' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] }),
  })
  const body = (await response.json()) as { result?: Hex; error?: { message: string } }
  return body.error?.message ?? `accepted ${body.result}`
}

type Cap = { name: string; over: RegExp; tx: (limit: bigint) => Promise<Hex>; lo: bigint; hi: bigint; spec: string }

async function main() {
  const client = makeClient(FRAMES_DEVNET_0_RPC_URL)
  if (hexToBigInt(await rpc<Hex>(client, 'eth_getBalance', [SENDER, 'latest'])) !== 0n) throw new Error(`${SENDER} holds a balance`)
  const fees = await suggestFees(client)
  const base: FrameTx = {
    chainId: 7_034_189_865n,
    envelope: 'plain',
    nonceKeys: [0n],
    nonceSeq: 0n,
    sender: SENDER,
    frames: [],
    signatures: [secp256k1Placeholder()],
    fees,
    blobVersionedHashes: [],
  }
  const build = async (execution: bigint, state: bigint) =>
    serializeFrameTx(await signAll({ ...base, frames: [verifyFrame({ scope: Approve.EXECUTION_AND_PAYMENT, execution, state }), senderFrame({ target: SENDER, execution: 10_000n })] }, [KEY]))
  const sigGas = SIGNATURE_GAS[Scheme.SECP256K1]
  const caps: Cap[] = [
    {
      name: 'MAX_VERIFY_GAS',
      spec: `100,000, so a VERIFY limit of ${100_000n - sigGas} with one SECP256K1 entry (${sigGas}) is the largest admitted`,
      over: /max_verify_gas|verification gas|gas budget/i,
      tx: (limit) => build(limit, NEW_ACCOUNT_STATE_GAS),
      lo: 1_000n,
      hi: 2_000_000n,
    },
    {
      name: 'MAX_VERIFY_STATE_GAS',
      spec: '500,000, so a VERIFY state limit of 500,000 is the largest admitted',
      over: /state/i,
      tx: (limit) => build(10_000n, limit),
      lo: NEW_ACCOUNT_STATE_GAS,
      hi: 16_000_000n,
    },
  ]
  console.log(`## Validation-prefix caps\n\nSender \`${SENDER}\` (unfunded). One VERIFY frame approving execution and payment, one SENDER frame, one SECP256K1 entry. "Largest inside" is the largest limit refused for anything but the cap; "smallest over" the smallest refused by naming it.\n`)
  console.log('| Cap | EIP value | Client | Largest inside | Smallest over | Refusal at the boundary |\n|---|---|---|---|---|---|')
  for (const cap of caps) {
    for (const c of CLIENTS) {
      const over = async (limit: bigint) => {
        const message = await send(c, await cap.tx(limit))
        return { over: cap.over.test(message), message }
      }
      const top = await over(cap.hi)
      if (!top.over) {
        console.log(`| ${cap.name} | ${cap.spec} | ${c} | at least ${cap.hi} | none found | ${top.message.slice(0, 120)} |`)
        continue
      }
      let [lo, hi] = [cap.lo, cap.hi]
      let message = top.message
      while (hi - lo > 1n) {
        const mid = (lo + hi) / 2n
        const r = await over(mid)
        if (r.over) [hi, message] = [mid, r.message]
        else lo = mid
      }
      const inside = await send(c, await cap.tx(lo))
      console.log(`| ${cap.name} | ${cap.spec} | ${c} | ${lo} (${inside.slice(0, 60)}) | ${hi} | ${message.slice(0, 120)} |`)
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
