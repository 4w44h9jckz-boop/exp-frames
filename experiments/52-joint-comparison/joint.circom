pragma circom 2.1.0;

// Experiment 52: out = (a > b) over two committed 64-bit bids, written so that a joint prover
// can tell which wires are whose.
//
//   Alice's wires: a, ra, Poseidon(a, ra), a's bits      (component names ha, abits)
//   Bob's wires:   b, rb, Poseidon(b, rb), b's bits      (hb, bbits)
//   shared wires:  the comparison tree's products p, t, e, and out
//
// The tree: at bit i, gt_i = a_i (1 - b_i) and eq_i = 1 - a_i - b_i + 2 a_i b_i, with
// p_i = a_i b_i. A pair (hi, lo) merges to gt = gt_hi + eq_hi gt_lo and eq = eq_hi eq_lo, one
// level at a time, from 64 leaves to the root, whose gt is out. `session` is bound, not used.

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";

template Joint() {
    signal input Ca;
    signal input Cb;
    signal input session;
    signal input out;

    signal input a;
    signal input ra;
    signal input b;
    signal input rb;

    component ha = Poseidon(2);
    ha.inputs[0] <== a;
    ha.inputs[1] <== ra;
    Ca === ha.out;
    component hb = Poseidon(2);
    hb.inputs[0] <== b;
    hb.inputs[1] <== rb;
    Cb === hb.out;

    component abits = Num2Bits(64);
    abits.in <== a;
    component bbits = Num2Bits(64);
    bbits.in <== b;

    // Leaves.
    signal p[64];
    signal gt0[64];
    signal eq0[64];
    for (var i = 0; i < 64; i++) {
        p[i] <== abits.out[i] * bbits.out[i];
        gt0[i] <== abits.out[i] - p[i];
        eq0[i] <== 1 - abits.out[i] - bbits.out[i] + 2 * p[i];
    }

    // Levels 1 to 6: 32, 16, 8, 4, 2, 1 pairs; t = eq_hi * gt_lo, e = eq_hi * eq_lo.
    signal t[6][32];
    signal e[6][32];
    signal gt[6][32];
    signal eq[6][32];
    var n = 64;
    for (var l = 0; l < 6; l++) {
        n = n \ 2;
        for (var k = 0; k < n; k++) {
            var hiGt = l == 0 ? gt0[2 * k + 1] : gt[l - 1][2 * k + 1];
            var hiEq = l == 0 ? eq0[2 * k + 1] : eq[l - 1][2 * k + 1];
            var loGt = l == 0 ? gt0[2 * k] : gt[l - 1][2 * k];
            var loEq = l == 0 ? eq0[2 * k] : eq[l - 1][2 * k];
            t[l][k] <== hiEq * loGt;
            gt[l][k] <== hiGt + t[l][k];
            if (l < 5) {
                e[l][k] <== hiEq * loEq;
                eq[l][k] <== e[l][k];
            }
        }
    }
    out === gt[5][0];

    signal sessionSquare <== session * session;
}

component main {public [Ca, Cb, session, out]} = Joint();
