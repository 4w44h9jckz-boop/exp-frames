// OutcomeAccount: experiment 27's ExecutionScopeAccount, with an outcome check required at the end
// of the transaction's one atomic batch.
//
// VERIFY approves as experiment 27's account does (scope 3 over the canonical sig hash, the owner
// paying; scope 2 over the execution digest E, someone else paying), and first requires:
//
// - the last frame is a SENDER frame whose resolved target is this account and whose data starts
//   with assert's selector, 0x682c9c89 = keccak256("assert(bytes)")[0:4];
// - every frame before it that is not a VERIFY frame carries ATOMIC_BATCH_FLAG (0x4), so the body
//   and the check are one batch: if the check reverts, the whole body reverts with it.
//
// assert(Q), reached when the account calls itself (a SENDER frame targeting the sender):
//
//   data = 0x682c9c89 || entry*
//   entry = target (32) || expected (32) || len (32) || call (len, zero-padded to a multiple of 32)
//
// Each entry's call is made as a STATICCALL to target, and its first returned word must equal
// expected. The first entry that fails reverts with its index. The check reads named state only:
// it cannot see a write that no entry names.
//
// initcode = <this object> || owner (32)
object "OutcomeAccount" {
    code {
        let n := datasize("runtime")
        datacopy(0, dataoffset("runtime"), n)
        codecopy(n, sub(codesize(), 32), 32)
        return(0, add(n, 32))
    }
    object "runtime" {
        code {
            if eq(caller(), 0xaa) {
                let frame := txparam(0x0a)
                if eq(frameparam(0x02, frame), 1) { validate(frame) } // mode == VERIFY
            }
            if eq(caller(), address()) {
                if eq(shr(224, calldataload(0)), 0x682c9c89) { check() }
            }
            stop()

            // The last frame is SENDER -> this account -> assert(...), and the body before it is one
            // atomic batch ending in it.
            function requireCheckFrame() {
                let n := txparam(0x09)
                if iszero(n) { fail() }
                let last := sub(n, 1)
                if iszero(eq(frameparam(0x02, last), 2)) { fail() }            // mode == SENDER
                if iszero(eq(frameparam(0x00, last), address())) { fail() }    // resolved target
                if lt(frameparam(0x04, last), 4) { fail() }
                if iszero(eq(shr(224, framedataload(0, last)), 0x682c9c89)) { fail() }
                for { let i := 0 } lt(i, last) { i := add(i, 1) } {
                    if iszero(eq(frameparam(0x02, i), 1)) {                    // not VERIFY
                        if iszero(and(frameparam(0x03, i), 4)) { fail() }      // ATOMIC_BATCH_FLAG
                    }
                }
            }

            function check() {
                let end := calldatasize()
                let p := 4
                for { let k := 0 } lt(p, end) { k := add(k, 1) } {
                    if gt(add(p, 96), end) { failAt(k) }
                    let target := calldataload(p)
                    let expected := calldataload(add(p, 32))
                    let len := calldataload(add(p, 64))
                    if gt(len, 0xffff) { failAt(k) }
                    calldatacopy(0, add(p, 96), len)
                    mstore(len, 0)
                    let ok := staticcall(gas(), target, 0, len, 0, 32)
                    if iszero(ok) { failAt(k) }
                    if lt(returndatasize(), 32) { failAt(k) }
                    if iszero(eq(mload(0), expected)) { failAt(k) }
                    p := add(add(p, 96), and(add(len, 31), not(31)))
                }
                stop()
            }

            function failAt(k) {
                mstore(0, k)
                revert(0, 32)
            }

            function validate(frame) {
                codecopy(0, sub(codesize(), 32), 32)
                let owner := mload(0)
                if iszero(txparam(0x0b)) { fail() }
                if iszero(eq(sigparam(0x01, 0), 1)) { fail() }       // SECP256K1
                if iszero(eq(sigparam(0x00, 0), owner)) { fail() }   // signed by the owner
                requireCheckFrame()
                let scope := frameparam(0x06, frame)
                let msg := sigparam(0x02, 0)
                switch scope
                case 2 { if iszero(eq(msg, executionDigest())) { fail() } }
                case 3 { if msg { fail() } }                          // the canonical sig hash
                default { fail() }
                approve(scope)
            }

            // Memory: 0x80..0x180 one struct being hashed; 0x180.. the frame hashes; after them, a
            // buffer for frame data and then the blob hashes.
            function executionDigest() -> e {
                let n := txparam(0x09)
                let hashes := 0x180
                let buf := add(hashes, shl(5, n))
                for { let i := 0 } lt(i, n) { i := add(i, 1) } {
                    let mode := frameparam(0x02, i)
                    mstore(0x80, 0x153657d0defdb699b20d15235303822ac8328ea5b959850ed64308f21e4d0e71) // FRAME_TYPEHASH
                    mstore(0xa0, mode)
                    mstore(0xc0, frameparam(0x03, i))                 // flags
                    mstore(0x140, frameparam(0x08, i))                // value
                    switch and(eq(mode, 1), eq(frameparam(0x06, i), 1))
                    case 1 {                                          // a pay frame: open fields
                        mstore(0xe0, 0)
                        mstore(0x100, 0)
                        mstore(0x120, 0)
                        mstore(0x160, 0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470)
                    }
                    default {
                        mstore(0xe0, frameparam(0x00, i))             // resolved target
                        mstore(0x100, frameparam(0x01, i))            // limits.execution
                        mstore(0x120, frameparam(0x09, i))            // limits.state
                        let len := frameparam(0x04, i)
                        framedatacopy(buf, 0, len, i)
                        mstore(0x160, keccak256(buf, len))
                    }
                    mstore(add(hashes, shl(5, i)), keccak256(0x80, 0x100))
                }
                let framesHash := keccak256(hashes, shl(5, n))
                let blobs := txparam(0x07)
                for { let i := 0 } lt(i, blobs) { i := add(i, 1) } { mstore(add(buf, shl(5, i)), blobhash(i)) }
                let blobsHash := keccak256(buf, shl(5, blobs))

                mstore(0x80, 0x9e04fddb63511807adea6b265addd8aca0b240734ae0679e5241e62183a8a7af) // FRAME_EXECUTION_TYPEHASH
                mstore(0xa0, txparam(0x0f))                           // nonce_keys_hash (EIP-8250)
                mstore(0xc0, txparam(0x01))                           // nonce_seq
                mstore(0xe0, framesHash)
                mstore(0x100, blobsHash)
                let structHash := keccak256(0x80, 0xa0)

                mstore(0x80, 0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f) // EIP712Domain typehash
                mstore(0xa0, 0xb681c0993d3a9224df2addc41b6636f54e3dc511dac797153275ffcde9bc90b1) // keccak256("FrameExecution")
                mstore(0xc0, 0xc89efdaa54c0f20c7adf612882df0950f5a951637e0307cdcb4c672f298b8bc6) // keccak256("1")
                mstore(0xe0, chainid())
                mstore(0x100, address())                              // the sender: APPROVE(EXECUTION) runs only there
                let domainSeparator := keccak256(0x80, 0xa0)

                mstore(0x00, shl(240, 0x1901))
                mstore(0x02, domainSeparator)
                mstore(0x22, structHash)
                e := keccak256(0x00, 0x42)
            }

            function fail() { revert(0, 0) }

            function txparam(param) -> v { v := verbatim_1i_1o(hex"b0", param) }
            function frameparam(param, frame) -> v { v := verbatim_2i_1o(hex"b3", frame, param) }
            function sigparam(param, index) -> v { v := verbatim_2i_1o(hex"b4", index, param) }
            function framedataload(offset, frame) -> v { v := verbatim_2i_1o(hex"b1", offset, frame) }
            function framedatacopy(memOffset, dataOffset, length, frame) {
                verbatim_4i_0o(hex"b2", memOffset, dataOffset, length, frame)
            }
            function approve(scope) { verbatim_3i_0o(hex"aa", 0, 0, scope) }
        }
    }
}
