// SPDX-License-Identifier: CC0-1.0, pending the copyright waiver
//
//! The execution-scope digest E of a frame transaction (EIP-8141, with EIP-8250 keyed nonces), as
//! EIP-712 typed data. A reference implementation with no dependency but alloy (`alloy-primitives`
//! and `alloy-sol-types`, or the `alloy` crate), through its EIP-712 derive.
//!
//! ```text
//! domain  = EIP712Domain("FrameExecution", "1", chain_id, verifyingContract = sender)
//! message = FrameExecution(nonceKeysHash, nonceSeq, Frame[] frames, bytes32[] blobVersionedHashes)
//! Frame   = (mode, flags, resolved target, execution limit, state limit, value, data)
//! ```
//!
//! A pay frame is a `VERIFY` frame (mode 1) whose allowed scope (`flags & 3`) is `PAYMENT` (1)
//! alone. Its target, both limits and data are the payer's, and are zeroed; its mode, flags and
//! value stay. A missing target resolves to the sender. A plain EIP-8141 envelope's nonce is the
//! legacy nonce, so it digests as the legacy selection of EIP-8250: `nonce_keys == []` at master,
//! `[0]` before commit `56b645be`.
//!
//! The tests check every vector of `vectors.json`, which sits beside this file.

use alloy::{
    primitives::{Address, B256, Bytes, U256, keccak256},
    sol_types::{Eip712Domain, SolStruct, eip712_domain},
};

mod typed {
    alloy::sol! {
        struct Frame {
            uint8 mode;
            uint8 flags;
            address target;
            uint64 executionLimit;
            uint64 stateLimit;
            uint256 value;
            bytes data;
        }

        struct FrameExecution {
            bytes32 nonceKeysHash;
            uint64 nonceSeq;
            Frame[] frames;
            bytes32[] blobVersionedHashes;
        }
    }
}

const VERIFY: u8 = 1;
const PAYMENT: u8 = 1;
const SCOPE_MASK: u8 = 3;

/// A frame, as E needs it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DigestFrame {
    pub mode: u8,
    pub flags: u8,
    /// `None` resolves to the sender.
    pub target: Option<Address>,
    pub execution_limit: u64,
    pub state_limit: u64,
    pub value: U256,
    pub data: Bytes,
}

/// A transaction, as E needs it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DigestTx {
    pub chain_id: u64,
    pub sender: Address,
    pub nonce_keys: Vec<U256>,
    pub nonce_seq: u64,
    pub frames: Vec<DigestFrame>,
    pub blob_versioned_hashes: Vec<B256>,
}

/// A `VERIFY` frame whose allowed scope is `PAYMENT` alone.
#[must_use]
pub fn is_pay_frame(frame: &DigestFrame) -> bool {
    frame.mode == VERIFY && frame.flags & SCOPE_MASK == PAYMENT
}

/// EIP-8250's `nonce_keys_hash`: keccak256 of the key count and the keys, as 32-byte words.
#[must_use]
pub fn nonce_keys_hash(keys: &[U256]) -> B256 {
    let mut words = U256::from(keys.len()).to_be_bytes::<32>().to_vec();
    for key in keys {
        words.extend_from_slice(&key.to_be_bytes::<32>());
    }
    keccak256(words)
}

/// The EIP-712 domain: the chain and the account.
#[must_use]
pub fn execution_domain(tx: &DigestTx) -> Eip712Domain {
    eip712_domain! {
        name: "FrameExecution",
        version: "1",
        chain_id: tx.chain_id,
        verifying_contract: tx.sender,
    }
}

fn typed_message(tx: &DigestTx) -> typed::FrameExecution {
    let frame = |f: &DigestFrame| {
        let pay = is_pay_frame(f);
        typed::Frame {
            mode: f.mode,
            flags: f.flags,
            target: if pay { Address::ZERO } else { f.target.unwrap_or(tx.sender) },
            executionLimit: if pay { 0 } else { f.execution_limit },
            stateLimit: if pay { 0 } else { f.state_limit },
            value: f.value,
            data: if pay { Bytes::new() } else { f.data.clone() },
        }
    };
    typed::FrameExecution {
        nonceKeysHash: nonce_keys_hash(&tx.nonce_keys),
        nonceSeq: tx.nonce_seq,
        frames: tx.frames.iter().map(frame).collect(),
        blobVersionedHashes: tx.blob_versioned_hashes.clone(),
    }
}

/// `hashStruct(FrameExecution)`.
#[must_use]
pub fn execution_struct_hash(tx: &DigestTx) -> B256 {
    typed_message(tx).eip712_hash_struct()
}

/// E = keccak256(0x1901 || domain separator || struct hash).
#[must_use]
pub fn execution_digest(tx: &DigestTx) -> B256 {
    typed_message(tx).eip712_signing_hash(&execution_domain(tx))
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::*;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Frame {
        mode: u8,
        flags: u8,
        target: Option<Address>,
        execution_limit: u64,
        state_limit: u64,
        value: U256,
        data: Bytes,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Tx {
        chain_id: u64,
        sender: Address,
        nonce_keys: Vec<U256>,
        nonce_seq: u64,
        frames: Vec<Frame>,
        blob_versioned_hashes: Vec<B256>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Case {
        name: String,
        tx: Tx,
        domain_separator: B256,
        struct_hash: B256,
        execution_digest: B256,
        pay_frames: Vec<usize>,
    }

    #[derive(Deserialize)]
    struct Vectors {
        cases: Vec<Case>,
    }

    #[test]
    fn every_vector() {
        let v: Vectors = serde_json::from_str(include_str!("vectors.json")).unwrap();
        for c in &v.cases {
            let tx = DigestTx {
                chain_id: c.tx.chain_id,
                sender: c.tx.sender,
                nonce_keys: c.tx.nonce_keys.clone(),
                nonce_seq: c.tx.nonce_seq,
                frames: c
                    .tx
                    .frames
                    .iter()
                    .map(|f| DigestFrame {
                        mode: f.mode,
                        flags: f.flags,
                        target: f.target,
                        execution_limit: f.execution_limit,
                        state_limit: f.state_limit,
                        value: f.value,
                        data: f.data.clone(),
                    })
                    .collect(),
                blob_versioned_hashes: c.tx.blob_versioned_hashes.clone(),
            };
            let pay: Vec<usize> = (0..tx.frames.len()).filter(|&i| is_pay_frame(&tx.frames[i])).collect();
            assert_eq!(pay, c.pay_frames, "{}", c.name);
            assert_eq!(execution_domain(&tx).separator(), c.domain_separator, "{}", c.name);
            assert_eq!(execution_struct_hash(&tx), c.struct_hash, "{}", c.name);
            assert_eq!(execution_digest(&tx), c.execution_digest, "{}", c.name);
        }
    }
}
