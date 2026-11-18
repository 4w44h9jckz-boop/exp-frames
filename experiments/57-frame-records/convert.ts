// A frame transaction (EIP-8141) as the records that rule-based pre-signing checks read.
//
// Each record holds only what the transaction itself determines. A field that needs outside
// knowledge (a scam list, an explorer's verification, a price, the user's history, the user's
// intent) is left out and named in `underivable`, so whoever runs a check decides what to put
// there and says so. Beside the records, `frameFacts` lists what a frame-aware rule would read and
// no record has a field for.
import { type Address, type Hex, getAddress, hexToBigInt, keccak256, slice, toHex } from 'viem'
import { Approve, type Frame, type FrameTx, Mode, frameSigHash, frameTxHash } from '../../src/frametx/index.js'
import { type Eip8250, executionDigest, executionTypedData, isPayFrame } from '../27-execution-digest/digest.js'

/** The fields of each record type the converter fills, in the checks' own names and order. */
export const RECORD_FIELDS = {
  approval: [
    'tx_hash', 'user_address', 'spender_address', 'token_address', 'function_selector', 'approval_amount', 'is_permit',
    'permit_expiry_seconds', 'spender_verified', 'spender_creation_timestamp', 'spender_in_scam_db', 'spender_in_protocol_registry',
    'spender_bytecode_match_scam', 'is_multicall_with_approval', 'nested_calls', 'last_interaction_with_spender_days',
    'exposed_value_usd', 'current_timestamp',
  ],
  typed_signature: [
    'request_id', 'user_address', 'dapp_origin', 'signature_type', 'primary_type', 'typed_data', 'eip712_domain_separator',
    'spender_address', 'approval_amount', 'expiry_seconds', 'spender_in_protocol_registry', 'token_address', 'batch_tokens',
    'nft_collection_address', 'operator_address', 'operator_in_marketplace_registry', 'operator_creation_timestamp',
    'seaport_offer_assets', 'seaport_consideration_eth', 'seaport_collection_floor_eth', 'seaport_total_offer_value_usd',
    'ui_description', 'payload_semantic', 'domain_in_protocol_registry', 'domain_age_days', 'is_homoglyph_of_known', 'current_timestamp',
  ],
  transfer_destination: [
    'tx_hash', 'user_address', 'recipient_address', 'intended_target_chain_id', 'intended_target_chain_name', 'signing_chain_id',
    'recipient_tx_count_on_target_chain', 'recipient_tx_count_on_other_chains', 'recipient_is_contract', 'recipient_implements_receive',
    'recipient_implements_erc20_receiver', 'user_expects_eoa', 'recipient_lookalike_in_history', 'recipient_address_distance',
    'recent_dust_from_lookalike', 'ens_name_resolved', 'ens_typed_address', 'recipient_paused', 'recipient_migrated_to',
    'recipient_last_activity_age_days', 'token_being_sent', 'amount_value_usd', 'current_timestamp',
  ],
  swap: [
    'tx_id', 'user_address', 'tx_type', 'submission_method', 'dex_address', 'dex_name', 'pool_address', 'pool_reserves_usd',
    'swap_amount_usd', 'slippage_pct', 'estimated_gas_cost_usd', 'pool_recent_sandwich_rate', 'wallet_uses_private_relay',
    'lending_protocol', 'health_factor', 'collateral_price_volatility_30d', 'bot_monitoring_detected', 'liquidation_amount_usd',
  ],
  inclusion: [
    'tx_hash', 'user_address', 'to_address', 'selected_relays', 'has_private_mempool_configured', 'destination_chain',
    'interacts_with_sanctioned_addresses', 'recent_block_builder_count', 'dominant_builder_share', 'wallet_exposes_l1_inbox_path',
    'mev_boost_enabled',
  ],
  account_readiness: [
    'address', 'has_stealth_meta_address', 'meta_address_has_mlkem', 'stealth_protocol_version', 'is_smart_account',
    'smart_account_has_pq_module', 'smart_account_upgradeable', 'smart_account_validation', 'interacted_with_protocols',
    'recent_ecdh_ephemeral_keys_seen', 'encrypted_blobs_without_pq_kem', 'bls_deposit_count', 'bls_committee_memberships',
    'bls_attestations_count', 'first_tx_timestamp', 'latest_tx_timestamp', 'tx_count', 'total_value_usd', 'has_rotated_key',
    'current_timestamp',
  ],
  pool_withdrawal: [
    'tx_hash', 'user_address', 'withdrawal_address', 'pool_id', 'pool_denomination', 'deposit_timestamp', 'withdrawal_timestamp',
    'pool_deposit_count_in_24h_window', 'pool_concurrent_deposits_in_window', 'deposit_amount', 'pool_amount_distribution',
    'is_variable_denom_pool', 'user_recent_deposits_across_pools', 'user_recent_withdrawals_across_pools',
    'withdrawal_address_prior_defi_interactions', 'expected_post_withdrawal_action', 'expected_post_withdrawal_delay_blocks',
    'withdrawal_address_known_cluster_match', 'selected_relayer', 'relayer_market_share_pct', 'withdrawal_address_prior_mixer_uses',
    'withdrawal_tx_gas_price_gwei', 'block_gas_median_gwei', 'block_gas_stddev_gwei', 'user_typical_gas_price_gwei',
  ],
} as const

/** The nine record types no frame transaction alone can fill, and why. */
export const NOT_APPLICABLE: Record<string, string> = {
  backup: 'a wallet backup configuration, not a transaction',
  behaviour: 'weeks of one user\'s activity, not one transaction',
  lending_portfolio: 'a portfolio of lending positions, read from protocol state',
  governance: 'a DAO proposal, not a transaction',
  l2_anonymity: 'a layer-2 action with its batch and sequencer; the cases here are layer-1 frame transactions',
  bridge: 'a sequence of bridge transfers across chains',
  sequencer: 'a submission to a layer-2 sequencer',
  stealth: 'a stealth-address deposit and spend pair',
  rpc: 'a session of RPC queries, not a transaction',
}

type Fields = Record<string, unknown>
export type Record_ = { type: keyof typeof RECORD_FIELDS; frame?: number; fields: Fields; underivable: string[] }


const SEL = {
  approve: '0x095ea7b3',
  increaseAllowance: '0x39509351',
  setApprovalForAll: '0xa22cb465',
  permit: '0xd505accf',
  transfer: '0xa9059cbb',
  transferFrom: '0x23b872dd',
  /** ToyDex.swap(uint256,uint256), experiment 03. */
  toyDexSwap: '0xd96073cf',
  /** FramePool.withdraw, experiment 06. */
  poolWithdraw: '0x21a0adb6',
} as const

const word = (data: Hex, i: number): Hex => slice(data, 4 + 32 * i, 4 + 32 * (i + 1))
const addressAt = (data: Hex, i: number): Address => getAddress(slice(word(data, i), 12))
const selectorOf = (data: Hex): Hex | null => (data.length >= 10 ? (data.slice(0, 10).toLowerCase() as Hex) : null)
const resolved = (tx: FrameTx, f: Frame): Address => getAddress(f.target ?? tx.sender)

function record(type: keyof typeof RECORD_FIELDS, fields: Fields, frame?: number): Record_ {
  const known = new Set(Object.keys(fields))
  for (const k of known) if (!(RECORD_FIELDS[type] as readonly string[]).includes(k)) throw new Error(`${type}: no field ${k}`)
  return { type, ...(frame === undefined ? {} : { frame }), fields, underivable: RECORD_FIELDS[type].filter((k) => !known.has(k)) }
}

/** The frames that execute calls: SENDER and DEFAULT. */
const executing = (tx: FrameTx) => tx.frames.map((f, i) => ({ f, i })).filter(({ f }) => f.mode === Mode.SENDER || f.mode === Mode.DEFAULT)

export type Options = {
  /** The transaction's hash when it was mined, else its computed hash. */
  hash?: Hex
  /** Which EIP-8250 revision's nonce rules E is computed under. */
  rules?: Eip8250
  /** Whether the sender has code, when known from outside the transaction. */
  senderHasCode?: boolean
  /** A label for request ids. */
  label?: string
}

export function recordsFor(tx: FrameTx, opts: Options = {}) {
  const hash = opts.hash ?? frameTxHash(tx)
  const user = getAddress(tx.sender)
  const calls = executing(tx)
  const nestedSelectors = calls.map(({ f }) => selectorOf(f.data) ?? '0x')
  const records: Record_[] = []

  for (const { f, i } of calls) {
    const sel = selectorOf(f.data)
    const target = resolved(tx, f)
    // The caller of a DEFAULT frame is the entry point, not the sender: an approval there is not the user's.
    const asSender = f.mode === Mode.SENDER
    if (asSender && (sel === SEL.approve || sel === SEL.increaseAllowance) && f.data.length >= 2 + 2 * 68) {
      records.push(
        record('approval', {
          tx_hash: hash,
          user_address: user,
          spender_address: addressAt(f.data, 0),
          token_address: target,
          function_selector: sel,
          approval_amount: hexToBigInt(word(f.data, 1)).toString(),
          is_permit: false,
          is_multicall_with_approval: calls.length > 1,
          nested_calls: nestedSelectors,
        }, i),
      )
    }
    if (asSender && sel === SEL.setApprovalForAll && f.data.length >= 2 + 2 * 68) {
      records.push(
        record('approval', {
          tx_hash: hash,
          user_address: user,
          spender_address: addressAt(f.data, 0),
          token_address: target,
          function_selector: sel,
          approval_amount: hexToBigInt(word(f.data, 1)).toString(),
          is_permit: false,
          is_multicall_with_approval: calls.length > 1,
          nested_calls: nestedSelectors,
        }, i),
      )
    }
    if (asSender && sel === SEL.transfer && f.data.length >= 2 + 2 * 68) {
      records.push(
        record('transfer_destination', {
          tx_hash: hash,
          user_address: user,
          recipient_address: addressAt(f.data, 0),
          signing_chain_id: Number(tx.chainId),
          token_being_sent: target,
        }, i),
      )
    }
    if (asSender && f.value > 0n) {
      records.push(
        record('transfer_destination', {
          tx_hash: hash,
          user_address: user,
          recipient_address: target,
          signing_chain_id: Number(tx.chainId),
          token_being_sent: 'ETH',
        }, i),
      )
    }
    if (asSender && sel === SEL.toyDexSwap) {
      records.push(record('swap', { tx_id: hash, user_address: user, tx_type: 'swap', dex_address: target }, i))
    }
    if (sel === SEL.poolWithdraw && target === user && f.data.length >= 2 + 2 * (4 + 32 * 6)) {
      // The pool is its own sender: experiment 06's layout, nullifier hash, recipient, relayer, fee.
      const relayer = addressAt(f.data, 4)
      records.push(
        record('pool_withdrawal', {
          tx_hash: hash,
          withdrawal_address: addressAt(f.data, 3),
          pool_id: target,
          selected_relayer: relayer === target ? 'none (the pool is its own sender)' : relayer,
          // The fee cap, not the price paid: a frame transaction names no single gas price.
          withdrawal_tx_gas_price_gwei: Number(tx.fees.maxFeePerGas) / 1e9,
        }, i),
      )
    }
  }

  // The sender's signature is entry 0, as in every account here: the canonical hash, or an explicit
  // digest, which for an account that follows experiment 27 is E.
  const senderEntry = tx.signatures[0]
  const rules = opts.rules ?? 'master'
  const e = executionDigest(tx, rules)
  const typed = executionTypedData(tx, rules)
  // A typed-data request is what a wallet shows before signing. The transaction carries only the
  // digest, so its typed data is known only when the digest is this transaction's own E: a relay's
  // copy that kept the user's signature over another E carries none.
  for (const [k, s] of tx.signatures.entries()) {
    if (s.msg === '0x') continue
    const isE = s.msg.toLowerCase() === e.toLowerCase()
    records.push(
      record('typed_signature', {
        request_id: `${opts.label ?? hash}#sig${k}`,
        user_address: s.signer ? getAddress(s.signer) : user,
        signature_type: 'eip712',
        ...(isE
          ? {
              primary_type: 'FrameExecution',
              typed_data: JSON.parse(JSON.stringify(typed, (_, v) => (typeof v === 'bigint' ? v.toString() : v))),
              eip712_domain_separator: domainSeparatorOf(tx),
            }
          : {}),
      }),
    )
  }

  const first = calls[0]
  records.push(
    record('inclusion', {
      tx_hash: hash,
      user_address: user,
      to_address: first ? resolved(tx, first.f) : user,
    }),
  )

  const schemes = [...new Set(tx.signatures.map((s) => s.scheme))]
  records.push(
    record('account_readiness', {
      address: user,
      ...(opts.senderHasCode === undefined ? {} : { is_smart_account: opts.senderHasCode }),
      smart_account_validation: schemes.map(schemeName).join('+') || 'none',
    }),
  )

  const verifyFrames = tx.frames.map((f, i) => ({ f, i })).filter(({ f }) => f.mode === Mode.VERIFY)
  const payFrame = verifyFrames.find(({ f }) => isPayFrame(f))
  const frameFacts = {
    hash,
    sigHash: frameSigHash(tx),
    chainId: Number(tx.chainId),
    sender: user,
    nonceKeys: tx.nonceKeys.map((k) => toHex(k)),
    nonceSeq: tx.nonceSeq.toString(),
    frames: tx.frames.map((f, i) => ({
      i,
      mode: ['DEFAULT', 'VERIFY', 'SENDER'][f.mode] ?? `mode ${f.mode}`,
      flags: f.flags,
      scope: f.mode === Mode.VERIFY ? f.flags & 0x3 : null,
      atomic: (f.flags & 0x4) !== 0,
      target: resolved(tx, f),
      targetNull: f.target === null,
      execution: f.limits.execution.toString(),
      state: f.limits.state.toString(),
      value: f.value.toString(),
      selector: selectorOf(f.data),
      dataBytes: (f.data.length - 2) / 2,
    })),
    payer: payFrame ? resolved(tx, payFrame.f) : verifyFrames.some(({ f }) => (f.flags & 0x3) === Approve.EXECUTION_AND_PAYMENT) ? user : null,
    payerIsSender: payFrame ? resolved(tx, payFrame.f) === user : null,
    signatures: tx.signatures.map((s) => ({
      scheme: schemeName(s.scheme),
      signer: s.signer ? getAddress(s.signer) : null,
      signs: s.msg === '0x' ? 'canonical signature hash' : s.msg.toLowerCase() === e.toLowerCase() ? `E (EIP-8250 ${rules})` : 'another explicit digest',
    })),
    senderSignsE: senderEntry ? senderEntry.msg.toLowerCase() === e.toLowerCase() : false,
    eUnder: rules,
    e,
    blobVersionedHashes: tx.blobVersionedHashes,
    feeCaps: { maxFeePerGas: tx.fees.maxFeePerGas.toString(), maxPriorityFeePerGas: tx.fees.maxPriorityFeePerGas.toString() },
  }
  return { records, frameFacts }
}

const schemeName = (s: number) => ({ 0: 'ARBITRARY', 1: 'SECP256K1', 2: 'P256' })[s] ?? `scheme ${s}`

function domainSeparatorOf(tx: FrameTx): Hex {
  // keccak256(abi.encode(EIP712Domain typehash, keccak("FrameExecution"), keccak("1"), chainId, sender))
  const enc = (x: Hex) => x.slice(2).padStart(64, '0')
  return keccak256(
    `0x${[
      '0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f',
      '0xb681c0993d3a9224df2addc41b6636f54e3dc511dac797153275ffcde9bc90b1',
      '0xc89efdaa54c0f20c7adf612882df0950f5a951637e0307cdcb4c672f298b8bc6',
      toHex(tx.chainId),
      tx.sender.toLowerCase() as Hex,
    ]
      .map((x) => enc(x as Hex))
      .join('')}`,
  )
}

