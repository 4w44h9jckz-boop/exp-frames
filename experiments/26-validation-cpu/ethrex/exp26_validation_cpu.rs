//! exp-frames experiment 26: what a validation prefix costs a node in time, per unit of gas.
//!
//! Each workload in `workloads.txt` is an account whose code is the work, run as a self-paying
//! VERIFY frame. The harness builds an in-memory Hegota chain whose genesis holds every account,
//! then, for each workload:
//!
//! 1. runs `Evm::simulate_frame_validation_prefix` once with a cap of zero, which executes the
//!    whole prefix and reports the gas it used in its rejection ("validation prefix gas N exceeds
//!    MAX_VERIFY_GAS 0"), or the violation that stopped it;
//! 2. times `Blockchain::validate_transaction`, the admission check a transaction arriving from a
//!    peer goes through, with `max_verify_gas` raised so every workload passes.
//!
//! State is in memory and stays cached across iterations, so every state read here is a lower
//! bound on a node whose state is on disk. Compute is what this measures.
//!
//! Copy into `crates/blockchain/tests/` of lambdaclass/ethrex at c94964843d (branch
//! `hegota-testnet`) and run:
//!
//!   EXP26_WORKLOADS=/abs/path/workloads.txt \
//!     cargo test --release -p ethrex-blockchain --features ethrex-crypto/default \
//!       --test exp26_validation_cpu -- --nocapture --test-threads 1
//!
//! `--features ethrex-crypto/default` matters. The workspace takes ethrex-crypto without default
//! features; the node binary turns them back on (`cmd/ethrex/Cargo.toml`), and without them the
//! BLS12-381 precompiles are absent and P256 takes the portable path.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Instant;

use bytes::Bytes;
use ethrex_blockchain::vm::StoreVmDatabase;
use ethrex_blockchain::{Blockchain, BlockchainOptions};
use ethrex_common::types::{BlockHeader, ChainConfig, Genesis, GenesisAccount, Transaction};
use ethrex_common::{Address, U256};
use ethrex_crypto::NativeCrypto;
use ethrex_storage::{EngineType, Store};
use ethrex_vm::Evm;

struct Workload {
    name: String,
    group: String,
    sender: Address,
    note: String,
    tx: Transaction,
}

fn unhex(s: &str) -> Vec<u8> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex")).collect()
}

fn address(s: &str) -> Address {
    Address::from_slice(&unhex(s))
}

fn u256(s: &str) -> U256 {
    U256::from_big_endian(&unhex(&format!("{:0>64}", s.strip_prefix("0x").unwrap_or(s))))
}

fn load(path: &str) -> (BTreeMap<Address, GenesisAccount>, Vec<Workload>) {
    let text = std::fs::read_to_string(path).expect("read workloads");
    let mut alloc: BTreeMap<Address, GenesisAccount> = BTreeMap::new();
    let mut workloads = Vec::new();
    let mut pending: Option<(String, String, Address, String)> = None;
    for line in text.lines() {
        if line.starts_with('#') || line.trim().is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.splitn(5, ' ').collect();
        match parts[0] {
            "account" => {
                let account = GenesisAccount {
                    code: Bytes::from(unhex(parts[4])),
                    storage: BTreeMap::new(),
                    balance: u256(parts[2]),
                    nonce: parts[3].parse().expect("nonce"),
                };
                alloc.insert(address(parts[1]), account);
            }
            "slot" => {
                alloc.get_mut(&address(parts[1])).expect("slot before its account").storage.insert(u256(parts[2]), u256(parts[3]));
            }
            "filler" => {
                let first = U256::from_big_endian(&unhex(parts[1]));
                let count: u64 = parts[2].parse().expect("count");
                let size: usize = parts[3].parse().expect("size");
                let mut code = vec![0x5bu8; size];
                code[0] = 0x00;
                let code = Bytes::from(code);
                for i in 0..count {
                    let a = (first + U256::from(i)).to_big_endian();
                    alloc.insert(
                        Address::from_slice(&a[12..]),
                        GenesisAccount { code: code.clone(), storage: BTreeMap::new(), balance: U256::zero(), nonce: 1 },
                    );
                }
            }
            "workload" => {
                let rest: Vec<&str> = line.splitn(5, ' ').collect();
                pending = Some((rest[1].to_string(), rest[2].to_string(), address(rest[3]), rest.get(4).unwrap_or(&"").to_string()));
            }
            "tx" => {
                let (name, group, sender, note) = pending.take().expect("tx after its workload");
                let tx = Transaction::decode_canonical(&unhex(parts[1])).expect("ethrex decodes the envelope");
                workloads.push(Workload { name, group, sender, note, tx });
            }
            other => panic!("unknown line kind {other}"),
        }
    }
    (alloc, workloads)
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

/// The gas the prefix used, from the zero-cap rejection, or the reason it did not get that far.
fn prefix_gas(store: &Store, header: &BlockHeader, w: &Workload) -> Result<u64, String> {
    let Transaction::FrameTransaction(frame_tx) = &w.tx else { return Err("not a frame transaction".into()) };
    let prefix = frame_tx.validation_prefix().map_err(|e| format!("{e:?}"))?;
    let db = StoreVmDatabase::new(store.clone(), header.clone()).map_err(|e| e.to_string())?;
    let mut evm = Evm::new_for_l1(db, Arc::new(NativeCrypto));
    let outcome = evm.simulate_frame_validation_prefix(&w.tx, header, &prefix, None, 0).map_err(|e| e.to_string())?;
    let violation = outcome.violation.unwrap_or_default();
    let used = violation
        .strip_prefix("validation prefix gas ")
        .and_then(|rest| rest.split(' ').next())
        .and_then(|n| n.parse().ok());
    used.ok_or(violation)
}

#[test]
fn exp26_validation_cpu() {
    let path = std::env::var("EXP26_WORKLOADS").expect("set EXP26_WORKLOADS");
    let (alloc, workloads) = load(&path);
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
        let options = BlockchainOptions { max_verify_gas: 50_000_000, precompile_cache_enabled: false, ..Default::default() };
        let blockchain = Blockchain::new(store.clone(), options);
        let head = store.get_latest_block_number().await.expect("head");
        let header = store.get_block_header(head).expect("header").expect("genesis header");

        const ROUNDS: usize = 7;
        println!("admission check per transaction, release build, median of {ROUNDS} rounds of at least 200 ms");
        println!("{:<18} {:<9} {:>9} {:>11} {:>9}  note", "workload", "group", "gas", "us/check", "ns/gas");
        let mut baseline: Option<(u64, f64)> = None;
        for w in &workloads {
            let gas = match prefix_gas(&store, &header, w) {
                Ok(g) => g,
                Err(why) => {
                    println!("{:<18} {:<9} not run: {why}", w.name, w.group);
                    continue;
                }
            };
            if let Err(e) = blockchain.validate_transaction(&w.tx, w.sender).await {
                println!("{:<18} {:<9} {:>9} rejected by validate_transaction: {e}", w.name, w.group, gas);
                continue;
            }
            // Calibrate the iteration count to about 200 ms a round.
            let start = Instant::now();
            let mut probe = 0u32;
            while start.elapsed().as_millis() < 50 {
                blockchain.validate_transaction(&w.tx, w.sender).await.expect("valid");
                probe += 1;
            }
            let iters = (probe * 4).max(5);
            let mut rounds = Vec::with_capacity(ROUNDS);
            for _ in 0..ROUNDS {
                let start = Instant::now();
                for _ in 0..iters {
                    std::hint::black_box(blockchain.validate_transaction(std::hint::black_box(&w.tx), w.sender).await.expect("valid"));
                }
                rounds.push(start.elapsed().as_nanos() as f64 / iters as f64);
            }
            rounds.sort_by(|a, b| a.partial_cmp(b).expect("finite"));
            let ns = rounds[ROUNDS / 2];
            if w.name == "empty" {
                baseline = Some((gas, ns));
            }
            let per_gas = match baseline {
                Some((g0, t0)) if gas > g0 => format!("{:.1}", (ns - t0) / (gas - g0) as f64),
                _ => "-".into(),
            };
            println!("{:<18} {:<9} {:>9} {:>11.1} {:>9}  {}", w.name, w.group, gas, ns / 1000.0, per_gas, w.note);
        }
        println!("\nns/gas is marginal: (time - time of `empty`) / (gas - gas of `empty`).");
    });
}
