// A private transfer on Aztec's note and nullifier model: two notes spent, two created.
//
//   owner     = H(OWNER, nsk)                    the nullifier key's public commitment
//   note hash = H(NOTE, owner, value, randomness)
//   nullifier = H(NULLIFIER, note hash, nsk)     one per note, computable only by its owner
//
// Note hashes sit in an append-only Merkle tree of depth DEPTH; the proof opens both inputs
// against `root`. Value is conserved: the inputs pay the outputs and the public fee. `context`
// is a public input the circuit does not constrain: the transaction binds what it must (who
// pays, on what terms) by checking it in VERIFY, as experiment 40's registry did.
//
// H is a sponge over Noir's Poseidon2 permutation (width 4, rate 3), with the input's length in
// the capacity element, as Noir's own Poseidon2 hash does.

global DEPTH: u32 = 32;
global OWNER: Field = 1;
global NOTE: Field = 2;
global NULLIFIER: Field = 3;
global NODE: Field = 4;

fn hash<let N: u32>(inputs: [Field; N]) -> Field {
    let mut state: [Field; 4] = [0, 0, 0, (N as Field) * 18446744073709551616];
    for chunk in 0..(N + 2) / 3 {
        for j in 0..3 {
            let k = chunk * 3 + j;
            if k < N {
                state[j] += inputs[k];
            }
        }
        state = std::hash::poseidon2_permutation(state);
    }
    state[0]
}

fn root_of(leaf: Field, index: Field, path: [Field; DEPTH]) -> Field {
    let bits: [bool; DEPTH] = index.to_le_bits();
    let mut node = leaf;
    for i in 0..DEPTH {
        node = if bits[i] {
            hash([NODE, path[i], node])
        } else {
            hash([NODE, node, path[i]])
        };
    }
    node
}

fn main(
    root: pub Field,
    nullifiers: pub [Field; 2],
    out_hashes: pub [Field; 2],
    fee: pub u64,
    context: pub Field,
    nsk: Field,
    in_values: [u64; 2],
    in_randomness: [Field; 2],
    in_index: [Field; 2],
    in_paths: [[Field; DEPTH]; 2],
    out_owners: [Field; 2],
    out_values: [u64; 2],
    out_randomness: [Field; 2],
) {
    let _ = context;
    let owner = hash([OWNER, nsk]);
    let mut total_in: u128 = 0;
    for i in 0..2 {
        let note = hash([NOTE, owner, in_values[i] as Field, in_randomness[i]]);
        assert(root_of(note, in_index[i], in_paths[i]) == root);
        assert(hash([NULLIFIER, note, nsk]) == nullifiers[i]);
        total_in += in_values[i] as u128;
    }
    assert(nullifiers[0] != nullifiers[1]);
    let mut total_out: u128 = fee as u128;
    for i in 0..2 {
        assert(hash([NOTE, out_owners[i], out_values[i] as Field, out_randomness[i]]) == out_hashes[i]);
        total_out += out_values[i] as u128;
    }
    assert(total_in == total_out);
}
