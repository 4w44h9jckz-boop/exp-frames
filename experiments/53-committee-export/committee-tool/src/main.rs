//! `committee-tool`, for experiment 53: what co-withdraw's library offers and its command line
//! does not.
//!
//!   committee-tool note <62 bytes hex: nullifier || secret>
//!       the note's commitment and nullifier hash, as JSON
//!   committee-tool inputs <note hex> <leaves.json> <recipient> <relayer> <fee> <out.json>
//!       the circuit's inputs for that note in the pool's tree (`co_withdraw::circuit_inputs`)
//!   committee-tool witness <inputs.json> <out.json> [wire]
//!       the extended witness as decimal strings, the constant first, as `co-withdraw split
//!       --witness` reads it; with `wire`, that one value changed by one
//!   committee-tool reconstruct <shares dir> <inputs.json>
//!       for each pair of members, and each member alone, whether their share files give the
//!       owner's witness; and where the nullifier and the secret sit in it, as JSON

use std::{fs, path::Path};

use anyhow::{Context, Result, bail};
use ark_bn254::Fr;
use ark_ff::{BigInteger, PrimeField};
use kohaku_tornadocash::{Field, Note};
use ruint::aliases::U256;

fn note(hex_note: &str) -> Result<Note> {
    let b = hex::decode(hex_note.trim_start_matches("0x"))?;
    if b.len() != 62 {
        bail!("a note is 62 bytes: 31 of nullifier, 31 of secret");
    }
    let (nullifier, secret): ([u8; 31], [u8; 31]) = (b[..31].try_into()?, b[31..].try_into()?);
    Ok(Note::new(nullifier, secret))
}

fn word(f: Field) -> String {
    let u: U256 = f.into();
    format!("{u:#066x}")
}

fn u256(s: &str) -> Result<U256> {
    Ok(U256::from_str_radix(s.trim_start_matches("0x"), 16)?)
}

fn fr_u256(x: &Fr) -> U256 {
    U256::from_be_slice(&x.into_bigint().to_bytes_be())
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("note") => {
            let n = note(&args[2])?;
            println!(
                "{}",
                serde_json::json!({ "commitment": word(n.commitment()), "nullifierHash": word(n.nullifier_hash()) })
            );
        }
        Some("inputs") => {
            let n = note(&args[2])?;
            let leaves: Vec<String> = serde_json::from_slice(&fs::read(&args[3])?)?;
            let leaves = leaves
                .iter()
                .map(|l| Field::try_from(u256(l)?).map_err(|e| anyhow::anyhow!("{e:?}")))
                .collect::<Result<Vec<_>>>()?;
            let inputs = co_withdraw::circuit_inputs(&n, &leaves, u256(&args[4])?, u256(&args[5])?, u256(&args[6])?, U256::ZERO)?;
            fs::write(&args[7], serde_json::to_vec_pretty(&inputs)?)?;
        }
        Some("witness") => {
            let inputs: kohaku_tornadocash_circuit::CircuitInputs = serde_json::from_slice(&fs::read(&args[2])?)?;
            let mut witness = co_withdraw::extend_witness(&inputs)?;
            if let Some(wire) = args.get(4) {
                witness[wire.parse::<usize>()?] += Fr::from(1u64);
            }
            let out: Vec<String> = witness.iter().map(|w| fr_u256(w).to_string()).collect();
            fs::write(&args[3], serde_json::to_vec(&out)?)?;
        }
        Some("reconstruct") => {
            let dir = Path::new(&args[2]);
            let inputs: kohaku_tornadocash_circuit::CircuitInputs = serde_json::from_slice(&fs::read(&args[3])?)?;
            let witness = co_withdraw::extend_witness(&inputs)?;
            let shares = (0..co_withdraw::MEMBERS)
                .map(|i| co_withdraw::read_share(&fs::read(dir.join(format!("share-{i}.bin")))?))
                .collect::<Result<Vec<_>>>()
                .context("reading the share files")?;
            let public = shares[0].public_inputs.len();
            let private = &witness[public..];
            // Member i holds (x_i, x_{i-1}); with member i + 1's x_{i+1}, that is all three.
            let pair = |i: usize| -> Vec<Fr> {
                let j = (i + 1) % co_withdraw::MEMBERS;
                shares[i].witness.iter().zip(&shares[j].witness).map(|(s, t)| s.a + s.b + t.a).collect()
            };
            let pairs: Vec<_> = (0..co_withdraw::MEMBERS)
                .map(|i| {
                    let w = pair(i);
                    serde_json::json!({ "members": [i, (i + 1) % co_withdraw::MEMBERS], "equalsWitness": w == private })
                })
                .collect();
            // Alone, a member's two values are uniformly random: neither is the witness.
            let alone: Vec<_> = shares
                .iter()
                .enumerate()
                .map(|(i, s)| {
                    let same = s.witness.iter().zip(private).filter(|(v, w)| v.a == **w || v.b == **w).count();
                    serde_json::json!({ "member": i, "privateValues": private.len(), "valuesEqualToTheWitness": same })
                })
                .collect();
            let find = |v: U256| private.iter().position(|w| fr_u256(w) == v).map(|p| p + public);
            let (nullifier, secret) = (inputs_value(&inputs, "nullifier")?, inputs_value(&inputs, "secret")?);
            let w = pair(0);
            let read = |idx: Option<usize>| idx.map(|i| format!("{:#066x}", fr_u256(&w[i - public])));
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "publicInClear": public,
                    "privateShared": private.len(),
                    "pairs": pairs,
                    "alone": alone,
                    "nullifierWire": find(nullifier),
                    "secretWire": find(secret),
                    "nullifierReadByMembers01": read(find(nullifier)),
                    "secretReadByMembers01": read(find(secret)),
                }))?
            );
        }
        _ => bail!("usage: committee-tool note|inputs|reconstruct ..."),
    }
    Ok(())
}

/// A field of the inputs, by its JSON name.
fn inputs_value(inputs: &kohaku_tornadocash_circuit::CircuitInputs, name: &str) -> Result<U256> {
    let v = serde_json::to_value(inputs)?;
    let s = v.get(name).and_then(|x| x.as_str()).context(name.to_string())?;
    u256(s)
}
