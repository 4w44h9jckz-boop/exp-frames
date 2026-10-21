pragma circom 2.1.0;

// Experiment 51: what the simulated enclave proves about its output.
//
// The enclave's encryption key is a Baby Jubjub key pk = sk * B8. An owner encrypts a 64-bit
// bid x with a fresh r as (E, c): E = r * B8 and c = x + H(S.x, S.y), where S = r * pk = sk * E
// and H is circomlib's MiMCSponge(2, 220, 1) with key 0.
//
// Public: pk, both ciphertexts, and the output. Private: sk. The proof shows that pk is sk's,
// that both ciphertexts decrypt under sk to 64-bit bids a and b, and that out = (a > b). It does
// not show who ran it, or that nobody else read a and b: the prover holds sk.

include "circomlib/circuits/babyjub.circom";
include "circomlib/circuits/escalarmulany.circom";
include "circomlib/circuits/mimcsponge.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";

// x = c - H(sk * E), checked to be below 2^64.
template Decrypt() {
    signal input skBits[253];
    signal input E[2];
    signal input c;
    signal output x;

    component onCurve = BabyCheck();
    onCurve.x <== E[0];
    onCurve.y <== E[1];

    component mul = EscalarMulAny(253);
    for (var i = 0; i < 253; i++) { mul.e[i] <== skBits[i]; }
    mul.p[0] <== E[0];
    mul.p[1] <== E[1];

    component pad = MiMCSponge(2, 220, 1);
    pad.ins[0] <== mul.out[0];
    pad.ins[1] <== mul.out[1];
    pad.k <== 0;

    x <== c - pad.outs[0];
    component range = Num2Bits(64);
    range.in <== x;
}

template Enclave() {
    signal input pk[2];
    signal input Ea[2];
    signal input ca;
    signal input Eb[2];
    signal input cb;
    signal input out;

    signal input sk;

    component pub = BabyPbk();
    pub.in <== sk;
    pk[0] === pub.Ax;
    pk[1] === pub.Ay;

    component skBits = Num2Bits(253);
    skBits.in <== sk;

    component a = Decrypt();
    component b = Decrypt();
    for (var i = 0; i < 253; i++) {
        a.skBits[i] <== skBits.out[i];
        b.skBits[i] <== skBits.out[i];
    }
    a.E[0] <== Ea[0];
    a.E[1] <== Ea[1];
    a.c <== ca;
    b.E[0] <== Eb[0];
    b.E[1] <== Eb[1];
    b.c <== cb;

    // out = (a > b), that is b < a.
    component lt = LessThan(64);
    lt.in[0] <== b.x;
    lt.in[1] <== a.x;
    out === lt.out;
}

component main {public [pk, Ea, ca, Eb, cb, out]} = Enclave();
