// FrostAccount: an account whose single key is held by a threshold group (FROST, see frost.ts).
// No member knows the key; any t of them produce one Schnorr signature over the sig hash, and the
// chain sees one 52-byte signature whichever t signed.
//
// The protocol has no Schnorr scheme, so the signature travels in an ARBITRARY entry (elided from
// the sig hash) and is checked here with the ecrecover precompile:
//
//   entry 0: ARBITRARY, msg ∅, exactly 52 bytes = address(R) (20) ‖ z (32), 0 < z < n
//   c = keccak256(Px ‖ parity ‖ sig hash ‖ address(R)) mod n
//   ecrecover(−z·Px, 27 + parity, Px, c·Px) == address(R)
//
// Exact length and z < n make the encoding canonical: ARBITRARY bytes are outside the sig hash, so
// any second encoding would be a second transaction hash for the same authorisation.
//
// initcode = <this object> ‖ Px (32) ‖ parity (32)
object "FrostAccount" {
    code {
        let n := datasize("runtime")
        datacopy(0, dataoffset("runtime"), n)
        codecopy(n, sub(codesize(), 64), 64)
        return(0, add(n, 64))
    }
    object "runtime" {
        code {
            if eq(caller(), 0xaa) {
                let frame := txparam(0x0a)
                if eq(frameparam(0x02, frame), 1) { validate(frame) } // mode == VERIFY
            }
            stop()

            function validate(frame) {
                let N := 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141
                if iszero(txparam(0x0b)) { fail() }
                if sigparam(0x01, 0) { fail() }                   // ARBITRARY
                if sigparam(0x02, 0) { fail() }                   // msg empty: signs the sig hash
                if iszero(eq(sigparam(0x03, 0), 52)) { fail() }   // exactly address(R) ‖ z
                sigdatacopy(0, 0, 52, 0)
                let rAddress := shr(96, mload(0))
                let z := mload(20)
                if or(iszero(z), iszero(lt(z, N))) { fail() }
                if iszero(rAddress) { fail() }

                codecopy(0x80, sub(codesize(), 64), 64)
                let px := mload(0x80)
                let parity := mload(0xa0)

                // c = keccak256(Px (32) ‖ parity (1) ‖ sig hash (32) ‖ address(R) (20)) mod n
                mstore(0x100, px)
                mstore8(0x120, parity)
                mstore(0x121, txparam(0x08))
                mstore(0x141, shl(96, rAddress))
                let c := mod(keccak256(0x100, 85), N)

                // ecrecover(h, v, r, s) at 0x200
                mstore(0x200, sub(N, mulmod(z, px, N)))
                mstore(0x220, add(27, parity))
                mstore(0x240, px)
                mstore(0x260, mulmod(c, px, N))
                mstore(0, 0)
                if iszero(staticcall(gas(), 0x01, 0x200, 128, 0, 32)) { fail() }
                if iszero(eq(mload(0), rAddress)) { fail() }

                approve(frameparam(0x06, frame))
            }

            function fail() { revert(0, 0) }

            function txparam(param) -> v { v := verbatim_1i_1o(hex"b0", param) }
            function frameparam(param, frame) -> v { v := verbatim_2i_1o(hex"b3", frame, param) }
            function sigparam(param, index) -> v { v := verbatim_2i_1o(hex"b4", index, param) }
            function sigdatacopy(memOffset, dataOffset, length, index) {
                verbatim_4i_0o(hex"b5", memOffset, dataOffset, length, index)
            }
            function approve(scope) { verbatim_3i_0o(hex"aa", 0, 0, scope) }
        }
    }
}
