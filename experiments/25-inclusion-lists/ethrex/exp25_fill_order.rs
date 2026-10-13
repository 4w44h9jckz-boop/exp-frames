//! exp-frames experiment 25: ethrex's FOCIL Profile 2 budget fill over one set of listed
//! transactions, delivered in different orders.
//!
//! The consensus specification (consensus-specs, specs/heze/inclusion-list.md,
//! `get_inclusion_list_transactions`) hands the execution layer a deduplicated list and says
//! "Order does not need to be preserved". `budget_fill` debits in list order. This test asks
//! whether the admitted set, and with it the omission verdict, depends on that order.
//!
//! Copy into `crates/blockchain/tests/` of lambdaclass/ethrex at c94964843d (branch
//! `hegota-testnet`) and run:
//!
//!   EXP25_SCENARIOS=/abs/path/scenarios.txt:/abs/path/delivered.txt \
//!     cargo test --release -p ethrex-blockchain --test exp25_fill_order -- --nocapture
//!
//! A scenario named `as-delivered ...` is run once, in the order given (the consensus layer's
//! output, from `cl_order.py`); any other is run in every order, or in 5,040 sampled ones.
//!
//! It also runs the same sets in one canonical order, ascending VERIFY budget cost and then
//! transaction hash, and, where the scenario gives committee members' lists separately, fills
//! each list on its own as EIP-8369 specifies.

use std::collections::{BTreeMap, BTreeSet};

use ethrex_blockchain::focil_profile2::{MAX_VERIFY_GAS_PER_IL, budget_fill, verify_budget_cost};
use ethrex_common::H256;
use ethrex_common::types::{Fork, Transaction};
use ethrex_crypto::NativeCrypto;

struct Listed {
    label: String,
    tx: Transaction,
    hash: H256,
    cost: u64,
}

fn unhex(s: &str) -> Vec<u8> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex"))
        .collect()
}

/// A scenario: its name, every listed transaction once (the consensus layer's deduplicated
/// array), and, when the file separates committee members' lists with `-- list`, each list in
/// its includer's order as indices into the first.
struct Scenario {
    name: String,
    txs: Vec<Listed>,
    lists: Vec<Vec<usize>>,
}

fn load(path: &str) -> Vec<Scenario> {
    let text = std::fs::read_to_string(path).expect("read scenarios");
    let mut out: Vec<Scenario> = Vec::new();
    for line in text.lines() {
        if line.starts_with('#') || line.trim().is_empty() {
            continue;
        }
        if let Some(name) = line.strip_prefix("scenario ") {
            out.push(Scenario { name: name.to_string(), txs: Vec::new(), lists: vec![Vec::new()] });
            continue;
        }
        let sc = out.last_mut().expect("scenario header first");
        if line == "-- list" {
            sc.lists.push(Vec::new());
            continue;
        }
        let mut parts = line.splitn(3, ' ');
        let label = parts.next().expect("label").to_string();
        let raw = unhex(parts.next().expect("envelope"));
        let tx = Transaction::decode_canonical(&raw).expect("ethrex decodes the envelope");
        let hash = tx.hash(&NativeCrypto);
        let cost = match &tx {
            Transaction::FrameTransaction(f) => verify_budget_cost(f).unwrap_or(u64::MAX),
            _ => 0,
        };
        let at = match sc.txs.iter().position(|l| l.hash == hash) {
            Some(i) => i,
            None => {
                sc.txs.push(Listed { label, tx, hash, cost });
                sc.txs.len() - 1
            }
        };
        sc.lists.last_mut().expect("a list").push(at);
    }
    out
}

/// Every order of `n` items (Heap's algorithm).
fn permutations(n: usize) -> Vec<Vec<usize>> {
    let mut a: Vec<usize> = (0..n).collect();
    let mut c = vec![0usize; n];
    let mut out = vec![a.clone()];
    let mut i = 0;
    while i < n {
        if c[i] < i {
            if i % 2 == 0 { a.swap(0, i) } else { a.swap(c[i], i) }
            out.push(a.clone());
            c[i] += 1;
            i = 0;
        } else {
            c[i] = 0;
            i += 1;
        }
    }
    out
}

/// A fixed-seed sample of orders, for sets too large to enumerate.
fn sampled(n: usize, count: usize, mut seed: u64) -> Vec<Vec<usize>> {
    let mut next = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    (0..count)
        .map(|_| {
            let mut a: Vec<usize> = (0..n).collect();
            for i in (1..n).rev() {
                a.swap(i, (next() % (i as u64 + 1)) as usize);
            }
            a
        })
        .collect()
}

fn admitted(list: &[&Listed]) -> BTreeSet<String> {
    let txs: Vec<Transaction> = list.iter().map(|l| l.tx.clone()).collect();
    let fill = budget_fill(&txs, Fork::Hegota, &NativeCrypto);
    list.iter()
        .filter(|l| fill.admitted.contains(&l.hash))
        .map(|l| l.label.clone())
        .collect()
}

/// EIP-8369's fill: each committee member's list on its own, in its own order; a transaction is
/// admitted if any of its occurrences is.
fn admitted_per_list(sc: &Scenario) -> BTreeSet<String> {
    sc.lists
        .iter()
        .flat_map(|list| admitted(&list.iter().map(|&i| &sc.txs[i]).collect::<Vec<_>>()))
        .collect()
}

/// The flood's thirty attacker transactions are counted rather than named.
fn show(set: &BTreeSet<String>) -> String {
    let flood = set.iter().filter(|l| l.starts_with('F')).count();
    let mut named: Vec<String> = set.iter().filter(|l| !l.starts_with('F')).cloned().collect();
    if flood > 0 {
        named.push(format!("{flood} x F"));
    }
    format!("{{{}}}", named.join(", "))
}

fn order(list: &[&Listed]) -> String {
    let flood = list.iter().filter(|l| l.label.starts_with('F')).count();
    if flood > 6 {
        return format!("{} listed, {flood} of them F", list.len());
    }
    list.iter().map(|l| l.label.as_str()).collect::<Vec<_>>().join(" ")
}

#[test]
fn exp25_fill_order() {
    let paths = std::env::var("EXP25_SCENARIOS").expect("set EXP25_SCENARIOS");
    println!("MAX_VERIFY_GAS_PER_IL = {MAX_VERIFY_GAS_PER_IL}");
    for sc in paths.split(':').flat_map(load) {
        let (name, list) = (&sc.name, &sc.txs);
        if name == "timing" {
            continue;
        }
        let n = list.len();
        if name.starts_with("as-delivered") {
            // One order: the one the consensus layer's reference function produced.
            let listed: Vec<&Listed> = list.iter().collect();
            println!("\nscenario {name}: {} -> admits {}", order(&listed), show(&admitted(&listed)));
            continue;
        }
        let orders = if n <= 8 { permutations(n) } else { sampled(n, 5040, 0x25) };
        let mut outcomes: BTreeMap<BTreeSet<String>, usize> = BTreeMap::new();
        let mut rate: BTreeMap<String, usize> = BTreeMap::new();
        for order in &orders {
            let listed: Vec<&Listed> = order.iter().map(|&i| &list[i]).collect();
            let set = admitted(&listed);
            for l in &set {
                *rate.entry(l.clone()).or_default() += 1;
            }
            *outcomes.entry(set).or_default() += 1;
        }
        println!("\nscenario {name}: {n} transactions, {} orders{}", orders.len(), if n <= 8 { " (all)" } else { " (sampled, seed 0x25)" });
        let mut flood = (0usize, 0usize, 0u64);
        for l in list {
            let r = rate.get(&l.label).copied().unwrap_or(0);
            if l.label.starts_with('F') {
                flood = (flood.0 + 1, flood.1 + r, l.cost);
                continue;
            }
            println!("  {:<3} cost {:>9}  admitted in {:>5} of {} orders ({:.1}%)", l.label, l.cost, r, orders.len(), 100.0 * r as f64 / orders.len() as f64);
        }
        if flood.0 > 0 {
            let mean = flood.1 as f64 / flood.0 as f64;
            println!("  F1-F{} cost {:>9} each, admitted in {:.0} of {} orders on average ({:.1}%)", flood.0, flood.2, mean, orders.len(), 100.0 * mean / orders.len() as f64);
        }
        println!("  distinct admitted sets: {}", outcomes.len());
        let mut by_count: Vec<_> = outcomes.iter().collect();
        by_count.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
        if by_count[0].1 > &1 {
            for (set, count) in by_count.iter().take(8) {
                println!("    {:>5} orders admit {}", count, show(set));
            }
        }
        let mut canonical: Vec<&Listed> = list.iter().collect();
        canonical.sort_by(|a, b| a.cost.cmp(&b.cost).then(a.hash.cmp(&b.hash)));
        println!("  canonical order (cost, hash): {} -> admits {}", order(&canonical), show(&admitted(&canonical)));
        if sc.lists.len() > 1 {
            let lists: Vec<String> = sc
                .lists
                .iter()
                .map(|l| format!("[{}]", order(&l.iter().map(|&i| &sc.txs[i]).collect::<Vec<_>>())))
                .collect();
            println!("  per list (EIP-8369), {} -> admits {}", lists.join(" "), show(&admitted_per_list(&sc)));
        }
    }
}

/// The stateless half of each profile, timed with ethrex's own functions: decoding, and then
/// either recovering a type-2 sender (Profile 1 today) or checking every protocol signature of a
/// frame transaction over its signature hash (what Profile 2's fill does before replay, and all
/// that the proposed Profile 1 for directly evaluable frames adds to account reads).
///
/// `Transaction::sender` answers a type-2 transaction from a process-level cache keyed by its hash
/// after the first recovery, and frame signatures have no such cache, so the type-2 loop empties
/// that cache each iteration: both columns then time a transaction seen for the first time.
#[test]
fn exp25_stateless_cost() {
    use ethrex_common::types::GLOBAL_SIGNER_CACHE;
    use ethrex_vm::validate_frame_signatures;
    use std::time::Instant;
    let paths = std::env::var("EXP25_SCENARIOS").expect("set EXP25_SCENARIOS");
    let list = paths
        .split(':')
        .flat_map(load)
        .find(|sc| sc.name == "timing")
        .expect("a timing scenario")
        .txs;
    let path = paths.split(':').next().expect("path");
    let text = std::fs::read_to_string(path).expect("read");
    let raw_of = |label: &str| -> Vec<u8> {
        let mut in_timing = false;
        for line in text.lines() {
            if let Some(n) = line.strip_prefix("scenario ") {
                in_timing = n == "timing";
                continue;
            }
            if in_timing && line.starts_with(&format!("{label} ")) {
                return unhex(line.split(' ').nth(1).expect("hex"));
            }
        }
        panic!("{label} not found")
    };
    const ROUNDS: usize = 5;
    const ITERS: usize = 4000;
    println!("\nstateless check per transaction, release build, {ITERS} iterations x {ROUNDS} rounds, median round");
    for l in &list {
        let raw = raw_of(&l.label);
        let mut rounds = Vec::new();
        for _ in 0..ROUNDS {
            let start = Instant::now();
            for _ in 0..ITERS {
                let tx = Transaction::decode_canonical(std::hint::black_box(&raw)).expect("decode");
                let ok = match &tx {
                    Transaction::FrameTransaction(f) => validate_frame_signatures(
                        &f.signatures,
                        f.compute_sig_hash(),
                        f.sender,
                        Fork::Hegota,
                        &NativeCrypto,
                    ),
                    other => {
                        GLOBAL_SIGNER_CACHE.lock().unwrap_or_else(|e| e.into_inner()).clear();
                        other.sender(&NativeCrypto).is_ok()
                    }
                };
                assert!(ok);
            }
            rounds.push(start.elapsed().as_nanos() as f64 / ITERS as f64);
        }
        rounds.sort_by(|a, b| a.partial_cmp(b).expect("finite"));
        let per_tx = rounds[ROUNDS / 2];
        let per_list = 8192 / raw.len();
        println!(
            "  {:<3} {:>5} bytes  {:>8.1} us/tx  {:>3} per 8 KiB list  {:>6.2} ms per list  {:>6.1} ms per slot (16 lists)",
            l.label,
            raw.len(),
            per_tx / 1000.0,
            per_list,
            per_tx * per_list as f64 / 1e6,
            per_tx * per_list as f64 * 16.0 / 1e6
        );
    }
}
