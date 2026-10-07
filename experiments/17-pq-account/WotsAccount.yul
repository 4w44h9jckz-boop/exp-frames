// WotsAccount: an account whose only key is a Merkle tree of one-time Winternitz (WOTS) keys. It
// uses nothing but keccak256, so a quantum computer that breaks secp256k1 does not break it.
//
// Signature: one ARBITRARY entry with msg ∅ (so its bytes are outside the sig hash it signs),
// read with SIGDATACOPY. Values are n bytes; a hash output is cut to its first n bytes.
//
//   leaf (2) ‖ R (n) ‖ chain values (L × n) ‖ authentication path (H × n)
//
//   digest  = keccak256(R ‖ TXPARAM(0x08))[0:n]           R is the signer's randomizer
//   digits  = digest in base w = 2^B, most significant first (L1 = 8n/B of them), then the
//             checksum sum(w - 1 - digit) in L2 more digits
//   chain   F(leaf, i, j, x) = keccak256(leaf << 32 | i << 16 | j ‖ x)[0:n]; the public end of
//             chain i is F applied from step digit_i to step w - 1
//   leaf    = keccak256(public ends, packed)[0:n]
//   node    = keccak256(1 << 255 | level << 32 | parent index ‖ left ‖ right)[0:n]
//
// The leaf must belong to the transaction's nonce: leaf / K == nonce_seq on nonce key 0. A
// one-time key can therefore only ever sign for one nonce, and K keys per nonce leave room for
// K - 1 fee-bump replacements without signing two messages with one key.
//
// The parameters are the five functions below; account.ts rewrites them per variant. As
// written: n = 32, w = 16, 2^10 leaves, 4 per nonce.
//
// initcode = <this object> ‖ root (32, the first n bytes significant)
object "WotsAccount" {
    code {
        let size := datasize("runtime")
        datacopy(0, dataoffset("runtime"), size)
        codecopy(size, sub(codesize(), 32), 32)
        return(0, add(size, 32))
    }
    object "runtime" {
        code {
            if eq(caller(), 0xaa) {
                let frame := txparam(0x0a)
                if eq(frameparam(0x02, frame), 1) { validate(frame) } // mode == VERIFY
            }
            stop()

            function N() -> v { v := 32 }  // bytes per hash value
            function B() -> v { v := 4 }   // bits per digit, w = 2^B
            function L2() -> v { v := 3 }  // checksum digits
            function H() -> v { v := 10 }  // tree height
            function K() -> v { v := 4 }   // one-time keys per nonce

            function W1() -> v { v := sub(shl(B(), 1), 1) }
            function L1() -> v { v := div(mul(8, N()), B()) }
            function SIGLEN() -> v { v := add(2, mul(N(), add(add(1, add(L1(), L2())), H()))) }
            function MASK() -> v { v := not(sub(shl(sub(256, mul(8, N())), 1), 1)) }

            // memory: 0x00-0x7f hash input, 0x80 the signature, then the public ends
            function SIG() -> v { v := 0x80 }
            function PK() -> v { v := and(add(add(SIG(), SIGLEN()), 31), not(31)) }

            function validate(frame) {
                if iszero(txparam(0x0b)) { fail() }
                if sigparam(0x01, 0) { fail() }                           // ARBITRARY
                if sigparam(0x02, 0) { fail() }                           // msg empty
                if iszero(eq(sigparam(0x03, 0), SIGLEN())) { fail() }     // exact: no spare bytes
                if iszero(eq(txparam(0x0e), 1)) { fail() }
                if txparam(0x10) { fail() }                               // nonce key 0
                sigdatacopy(SIG(), 0, SIGLEN(), 0)

                let leaf := shr(240, mload(SIG()))
                if iszero(lt(leaf, shl(H(), 1))) { fail() }
                if iszero(eq(div(leaf, K()), txparam(0x01))) { fail() }   // the nonce's own keys

                mstore(0, and(mload(add(SIG(), 2)), MASK()))
                mstore(N(), txparam(0x08))
                let digest := and(keccak256(0, add(N(), 32)), MASK())

                let checksum := 0
                for { let i := 0 } lt(i, L1()) { i := add(i, 1) } {
                    let d := and(shr(sub(256, mul(B(), add(i, 1))), digest), W1())
                    checksum := add(checksum, sub(W1(), d))
                    chain(leaf, i, d)
                }
                for { let k := 0 } lt(k, L2()) { k := add(k, 1) } {
                    chain(leaf, add(L1(), k), and(shr(mul(B(), sub(sub(L2(), 1), k)), checksum), W1()))
                }
                if iszero(eq(climb(leaf, and(keccak256(PK(), mul(add(L1(), L2()), N())), MASK())), root())) { fail() }
                approve(frameparam(0x06, frame))
            }

            // From the signed value at step d to the public end at step w - 1. The value lives at
            // 0x20 and is never masked on the way: keccak reads only its first n bytes. The tweak
            // word at 0 is written once; each step rewrites only its last byte, j (j < 256).
            // Unrolled by two, which takes the loop's own cost from about 40 gas a step to 20.
            function chain(leaf, i, d) {
                mstore(0x20, mload(add(add(SIG(), add(2, N())), mul(i, N()))))
                mstore(0, or(shl(32, leaf), shl(16, i)))
                let j := d
                if and(sub(W1(), d), 1) {
                    mstore8(31, j)
                    mstore(0x20, keccak256(0, add(0x20, N())))
                    j := add(j, 1)
                }
                for { } lt(j, W1()) { j := add(j, 2) } {
                    mstore8(31, j)
                    mstore(0x20, keccak256(0, add(0x20, N())))
                    mstore8(31, add(j, 1))
                    mstore(0x20, keccak256(0, add(0x20, N())))
                }
                mstore(add(PK(), mul(i, N())), and(mload(0x20), MASK()))
            }

            // From the leaf to the root along the authentication path.
            function climb(leaf, start) -> node {
                node := start
                let path := add(add(SIG(), add(2, N())), mul(add(L1(), L2()), N()))
                for { let level := 0 } lt(level, H()) { level := add(level, 1) } {
                    let sibling := and(mload(add(path, mul(level, N()))), MASK())
                    mstore(0, or(shl(255, 1), or(shl(32, level), shr(add(level, 1), leaf))))
                    switch and(shr(level, leaf), 1)
                    case 0 { mstore(0x20, node) mstore(add(0x20, N()), sibling) }
                    default { mstore(0x20, sibling) mstore(add(0x20, N()), node) }
                    node := and(keccak256(0, add(0x20, mul(2, N()))), MASK())
                }
            }

            function root() -> r {
                codecopy(0, sub(codesize(), 32), 32)
                r := mload(0)
            }
            function fail() { revert(0, 0) }

            function txparam(param) -> v { v := verbatim_1i_1o(hex"b0", param) }
            function frameparam(param, frame) -> v { v := verbatim_2i_1o(hex"b3", frame, param) }
            function sigparam(param, index) -> v { v := verbatim_2i_1o(hex"b4", index, param) }
            function sigdatacopy(mem, offset, length, index) { verbatim_4i_0o(hex"b5", mem, offset, length, index) }
            function approve(scope) { verbatim_3i_0o(hex"aa", 0, 0, scope) }
        }
    }
}
