//! exp-frames experiment 27: the execution-scope account against the vectors, inside ethrex.
//!
//! `cases.txt` (written by `vectors.ts`) holds the account's runtime code at two addresses with the
//! same owner, two code-less sponsors, and signed transactions with the verdict each should get.
//! The harness builds an in-memory Hegota chain from those accounts and runs each transaction's
//! validation prefix through `Evm::simulate_frame_validation_prefix`, which verifies the signature
//! list (so the protocol's `ecrecover` over the explicit `msg` is checked too) and then executes the
//! account's `VERIFY` frame, where the account recomputes the digest by introspection.
//!
//! A case passes when the verdict matches: `valid` must pay, `refused` must not.
//!
//! Copy into `crates/blockchain/tests/` of lambdaclass/ethrex at c94964843d (branch
//! `hegota-testnet`) and run:
//!
//!   EXP27_CASES=/abs/path/cases.txt \
//!     cargo test --release -p ethrex-blockchain --test exp27_execution_digest -- --nocapture

use std::collections::BTreeMap;
use std::sync::Arc;

use bytes::Bytes;
use ethrex_blockchain::vm::StoreVmDatabase;
use ethrex_common::types::{BlockHeader, ChainConfig, Genesis, GenesisAccount, Transaction};
use ethrex_common::{Address, U256};
use ethrex_crypto::NativeCrypto;
use ethrex_storage::{EngineType, Store};
use ethrex_vm::Evm;

fn unhex(s: &str) -> Vec<u8> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex")).collect()
}

fn u256(s: &str) -> U256 {
    U256::from_big_endian(&unhex(&format!("{:0>64}", s.strip_prefix("0x").unwrap_or(s))))
}

fn chain_config() -> ChainConfig {
    ChainConfig {
        chain_id: 8141,
        homestead_block: Some(0),
        eip150_block: Some(0),
        eip155_block: Some(0),
        eip158_block: Some(0),
        byzantium_block: Some(0),
        constantinople_block: Some(0),
        petersburg_block: Some(0),
        istanbul_block: Some(0),
        berlin_block: Some(0),
        london_block: Some(0),
        merge_netsplit_block: Some(0),
        terminal_total_difficulty: Some(0),
        terminal_total_difficulty_passed: true,
        shanghai_time: Some(0),
        cancun_time: Some(0),
        prague_time: Some(0),
        osaka_time: Some(0),
        amsterdam_time: Some(0),
        hegota_time: Some(0),
        ..Default::default()
    }
}

/// Run the prefix twice: with no gas cap, for the verdict; with a cap of zero, for the gas it used
/// (reported in the rejection, "validation prefix gas N exceeds MAX_VERIFY_GAS 0").
fn run(store: &Store, header: &BlockHeader, tx: &Transaction) -> (Result<(), String>, Option<u64>) {
    let Transaction::FrameTransaction(frame_tx) = tx else { return (Err("not a frame transaction".into()), None) };
    let prefix = match frame_tx.validation_prefix() {
        Ok(p) => p,
        Err(e) => return (Err(format!("{e:?}")), None),
    };
    let simulate = |cap: u64| {
        let db = StoreVmDatabase::new(store.clone(), header.clone()).expect("db");
        let mut evm = Evm::new_for_l1(db, Arc::new(NativeCrypto));
        evm.simulate_frame_validation_prefix(tx, header, &prefix, None, cap)
    };
    let verdict = match simulate(u64::MAX / 4) {
        Ok(o) if o.passed => Ok(()),
        Ok(o) => Err(o.violation.unwrap_or_else(|| "did not pass".into())),
        Err(e) => Err(e.to_string()),
    };
    let gas = simulate(0).ok().and_then(|o| o.violation).and_then(|v| {
        v.strip_prefix("validation prefix gas ").and_then(|rest| rest.split(' ').next()).and_then(|n| n.parse().ok())
    });
    (verdict, gas)
}

#[test]
fn exp27_execution_digest() {
    let path = std::env::var("EXP27_CASES").expect("set EXP27_CASES");
    let text = std::fs::read_to_string(path).expect("read cases");
    let mut alloc: BTreeMap<Address, GenesisAccount> = BTreeMap::new();
    let mut cases = Vec::new();
    for line in text.lines() {
        if line.starts_with('#') || line.trim().is_empty() {
            continue;
        }
        let (body, note) = line.split_once(" # ").unwrap_or((line, ""));
        let p: Vec<&str> = body.split(' ').collect();
        match p[0] {
            "account" => {
                let account = GenesisAccount {
                    code: Bytes::from(unhex(p[4])),
                    storage: BTreeMap::new(),
                    balance: u256(p[2]),
                    nonce: p[3].parse().expect("nonce"),
                };
                alloc.insert(Address::from_slice(&unhex(p[1])), account);
            }
            "case" => {
                let tx = Transaction::decode_canonical(&unhex(p[3])).expect("ethrex decodes the envelope");
                cases.push((p[1].to_string(), p[2].to_string(), note.to_string(), tx));
            }
            other => panic!("unknown line kind {other}"),
        }
    }

    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime");
    rt.block_on(async {
        let mut store = Store::new("", EngineType::InMemory).expect("in-memory store");
        let genesis = Genesis {
            config: chain_config(),
            alloc,
            gas_limit: 60_000_000,
            base_fee_per_gas: Some(1_000_000_000),
            ..Default::default()
        };
        store.add_initial_state(genesis).await.expect("genesis");
        let head = store.get_latest_block_number().await.expect("head");
        let header = store.get_block_header(head).expect("header").expect("genesis header");

        let mut mismatches = 0;
        println!("{:<20} {:<8} {:<8} {:>7}  why / note", "case", "expect", "got", "gas");
        for (name, expect, note, tx) in &cases {
            let (verdict, gas) = run(&store, &header, tx);
            let got = if verdict.is_ok() { "valid" } else { "refused" };
            if got != expect {
                mismatches += 1;
            }
            let gas = gas.map(|g| g.to_string()).unwrap_or_else(|| "-".into());
            let why = verdict.err().unwrap_or_default();
            let flag = if got == expect { "" } else { "  <-- MISMATCH" };
            println!("{name:<20} {expect:<8} {got:<8} {gas:>7}  {why}{}{flag}", if why.is_empty() { note.clone() } else { String::new() });
        }
        println!("\n{} cases, {} mismatches", cases.len(), mismatches);
        assert_eq!(mismatches, 0);
    });
}
