pragma circom 2.1.0;

// The kernel of a registry for private owned state (experiment 32).
//
// One tree holds the notes of every application. A note is a leaf
//
//     leaf = H(tag, inner, state),   inner = H(nullifierSecret, secret)
//
// where `tag` is the application (its address), and `state` a 64-bit value. Spending it reveals
//
//     nullifier = H(tag, nullifierSecret)
//
// so the same secrets give unrelated nullifiers in two applications. The proof shows that a leaf
// of `tag` is in the tree under `root`, that `nullifier` is its nullifier, and that the spend takes
// `withdrawn` out of `state` and leaves the rest in `newCommitment`, a note of the same `tag` for
// whoever `newInner` belongs to. `newCommitment` = 0 means no change note, and is allowed only when
// nothing is left. `binding` is what the registry binds to the proof (recipient, fee, link).
//
// H is circomlib's MiMCSponge with 220 rounds and key 0, as in Tornado Cash, so the tree is
// Tornado's height-20 MiMC tree and the deployed hasher computes the same function.

include "circomlib/circuits/mimcsponge.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";

template Hash(n) {
    signal input in[n];
    signal output out;
    component h = MiMCSponge(n, 220, 1);
    for (var i = 0; i < n; i++) { h.ins[i] <== in[i]; }
    h.k <== 0;
    out <== h.outs[0];
}

// Tornado Cash's MerkleTreeChecker, with the root as an output.
template DualMux() {
    signal input in[2];
    signal input s;
    signal output out[2];
    s * (1 - s) === 0;
    out[0] <== (in[1] - in[0]) * s + in[0];
    out[1] <== (in[0] - in[1]) * s + in[1];
}

template MerkleRoot(levels) {
    signal input leaf;
    signal input pathElements[levels];
    signal input pathIndices[levels];
    signal output root;
    component selectors[levels];
    component hashers[levels];
    for (var i = 0; i < levels; i++) {
        selectors[i] = DualMux();
        if (i == 0) {
            selectors[i].in[0] <== leaf;
        } else {
            selectors[i].in[0] <== hashers[i - 1].out;
        }
        selectors[i].in[1] <== pathElements[i];
        selectors[i].s <== pathIndices[i];
        hashers[i] = Hash(2);
        hashers[i].in[0] <== selectors[i].out[0];
        hashers[i].in[1] <== selectors[i].out[1];
    }
    root <== hashers[levels - 1].out;
}

template Kernel(levels) {
    signal input root;
    signal input nullifier;
    signal input newCommitment;
    signal input tag;
    signal input withdrawn;
    signal input binding;

    signal input nullifierSecret;
    signal input secret;
    signal input state;
    signal input newInner;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    // The note, and its place in the tree.
    component inner = Hash(2);
    inner.in[0] <== nullifierSecret;
    inner.in[1] <== secret;
    component leaf = Hash(3);
    leaf.in[0] <== tag;
    leaf.in[1] <== inner.out;
    leaf.in[2] <== state;
    component tree = MerkleRoot(levels);
    tree.leaf <== leaf.out;
    for (var i = 0; i < levels; i++) {
        tree.pathElements[i] <== pathElements[i];
        tree.pathIndices[i] <== pathIndices[i];
    }
    root === tree.root;

    // The application's nullifier.
    component n = Hash(2);
    n.in[0] <== tag;
    n.in[1] <== nullifierSecret;
    nullifier === n.out;

    // The spend: 64-bit values throughout, so the subtraction cannot wrap.
    component stateBits = Num2Bits(64);
    stateBits.in <== state;
    component withdrawnBits = Num2Bits(64);
    withdrawnBits.in <== withdrawn;
    signal newState <== state - withdrawn;
    component newStateBits = Num2Bits(64);
    newStateBits.in <== newState;

    // The change note, of the same application; none only if nothing is left.
    component change = Hash(3);
    change.in[0] <== tag;
    change.in[1] <== newInner;
    change.in[2] <== newState;
    component none = IsZero();
    none.in <== newCommitment;
    (newCommitment - change.out) * (1 - none.out) === 0;
    newState * none.out === 0;

    // Bound without being used, as Tornado Cash binds its recipient and fee.
    signal bindingSquare <== binding * binding;
}

component main {public [root, nullifier, newCommitment, tag, withdrawn, binding]} = Kernel(20);
