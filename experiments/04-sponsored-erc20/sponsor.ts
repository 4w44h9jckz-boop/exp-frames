import { type Address, type Hex, type PublicClient, concatHex, encodeAbiParameters, encodeFunctionData, formatEther, parseEther } from 'viem'
import { compileSolidity, compileYul } from '../../src/contracts.js'
import { deployFrame, saltOf, sendFrames } from '../../src/deploy.js'
import {
  Approve,
  type Frame,
  type FrameSignature,
  type FrameTx,
  STORAGE_SET_STATE_GAS,
  defaultFrame,
  maxCost,
  prepareFrameTx,
  secp256k1Placeholder,
  senderFrame,
  verifyFrame,
} from '../../src/frametx/index.js'

/** Token base units per wei: 2,000 tUSD per ETH (both 18 decimals). */
export const RATE = 2000n
export const SPONSOR_FUNDING = parseEther('0.05')

export const token = compileSolidity('contracts/TestToken.sol', 'TestToken')
const SPONSOR_CODE = compileYul('experiments/04-sponsored-erc20/TokenSponsor.yul')

const TUSD = deployFrame(
  concatHex([token.bytecode, encodeAbiParameters([{ type: 'string' }, { type: 'string' }], ['Test USD', 'tUSD'])]),
  saltOf('exp-frames/04/tusd/v1'),
  2n * STORAGE_SET_STATE_GAS,
)
export const TOKEN: Address = TUSD.address

/** The sponsor for a given owner: initcode = code ‖ abi.encode(token, rate, owner). */
export function tokenSponsor(owner: Address) {
  const args = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'address' }], [TOKEN, RATE, owner])
  return deployFrame(concatHex([SPONSOR_CODE, args]), saltOf('exp-frames/04/token-sponsor/v1'))
}

export const call = (functionName: string, args: unknown[]): Hex =>
  encodeFunctionData({ abi: token.abi, functionName, args } as Parameters<typeof encodeFunctionData>[0])

export async function tokenBalance(client: PublicClient, who: Address): Promise<bigint> {
  return client.readContract({ address: TOKEN, abi: token.abi, functionName: 'balanceOf', args: [who] } as Parameters<
    typeof client.readContract
  >[0]) as Promise<bigint>
}

/** Deploy tUSD and the owner's sponsor, then top the sponsor up to SPONSOR_FUNDING. One tx each time it is needed. */
export async function ensureSetup(client: PublicClient, ownerKey: Hex, owner: Address) {
  const sponsor = tokenSponsor(owner)
  const frames: Frame[] = []
  const [tokenCode, sponsorCode, balance] = await Promise.all([
    client.getCode({ address: TOKEN }),
    client.getCode({ address: sponsor.address }),
    client.getBalance({ address: sponsor.address }),
  ])
  if (!tokenCode) frames.push(TUSD.frame)
  if (!sponsorCode) frames.push(sponsor.frame)
  if (balance < SPONSOR_FUNDING / 2n) {
    frames.push(
      // The account exists by then: deployed earlier, or by the frame just before.
      senderFrame({ target: sponsor.address, value: SPONSOR_FUNDING - balance, execution: 30_000n }),
    )
  }
  if (frames.length) {
    await sendFrames(client, ownerKey, frames, { label: `setup: tUSD ${TOKEN}, TokenSponsor ${sponsor.address} (${formatEther(SPONSOR_FUNDING)} ETH)` })
  } else {
    console.log(`setup: already done (tUSD ${TOKEN}, TokenSponsor ${sponsor.address}, ${formatEther(balance)} ETH)`)
  }
  return sponsor.address
}

// ---- Example 3 frames ----

export type SponsoredOpts = {
  user: Address
  sponsor: Address
  /** The user's own calls (frame 3 onwards). */
  calls: Frame[]
  /** Fee transfer amount; `quoteFee` finds the smallest one the sponsor accepts. */
  fee: bigint
  /** State budget for the pay frame: 183,600 if APPROVE will create the sender account. */
  payState?: bigint
  postOp?: boolean
}

export const sponsorVerify = (sponsor: Address, state = 0n) =>
  verifyFrame({ scope: Approve.PAYMENT, target: sponsor, execution: 30_000n, state })
// The sponsor's tUSD balance slot is fresh only the first time; the post-op refunds what is not used.
export const feeTransfer = (sponsor: Address, amount: bigint) =>
  senderFrame({ target: TOKEN, data: call('transfer', [sponsor, amount]), execution: 50_000n, state: STORAGE_SET_STATE_GAS })
export const postOp = (sponsor: Address) => defaultFrame({ target: sponsor, execution: 60_000n })

export function sponsoredFrames(o: SponsoredOpts): Frame[] {
  return [
    verifyFrame({ scope: Approve.EXECUTION, execution: 10_000n }),
    sponsorVerify(o.sponsor, o.payState),
    feeTransfer(o.sponsor, o.fee),
    ...o.calls,
    ...(o.postOp === false ? [] : [postOp(o.sponsor)]),
  ]
}

/**
 * Prepare an Example 3 transaction paying the smallest fee the sponsor accepts. The fee is part
 * of the calldata it pays for, so iterate until amount >= max_cost * RATE.
 */
export async function prepareSponsored(
  client: PublicClient,
  o: Omit<SponsoredOpts, 'fee'>,
  signatures: FrameSignature[] = [secp256k1Placeholder()],
): Promise<{ tx: FrameTx; fee: bigint }> {
  let fee = 0n
  let tx = await prepareFrameTx(client, { sender: o.user, frames: sponsoredFrames({ ...o, fee }), signatures })
  // Price the signed transaction: a 65-byte secp256k1 signature adds up to 1,040 gas of calldata.
  const signed = (t: FrameTx): FrameTx => ({
    ...t,
    signatures: t.signatures.map((s) => (s.signature === '0x' ? { ...s, signature: `0x${'ff'.repeat(65)}` } : s)),
  })
  for (let i = 0; i < 8; i++) {
    const need = maxCost(signed(tx)) * RATE
    if (fee >= need) return { tx, fee }
    fee = need
    tx = { ...tx, frames: sponsoredFrames({ ...o, fee }) }
  }
  throw new Error('fee quote did not converge')
}
