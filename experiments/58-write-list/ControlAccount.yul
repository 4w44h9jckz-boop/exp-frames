// ControlAccount: experiment 54's OutcomeAccount with its control state in storage, for experiment
// 58's control-state family. Its runtime code is placed in the local chain's genesis, with slot 0
// set to the owner, so this object has no constructor.
//
// Storage:
//   slot 0                     the owner
//   the EIP-1967 slot          the implementation, a delegate the account names
//     0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc
//
// VERIFY (caller ENTRY_POINT, mode 1): entry 0 is the owner's SECP256K1 signature over the canonical
// signature hash; the last frame is a SENDER frame to this account calling assert(Q) (0x682c9c89);
// every non-VERIFY frame before it carries ATOMIC_BATCH_FLAG. Then APPROVE(3).
//
// From itself (a SENDER frame to the sender):
//   assert(Q)               0x682c9c89  experiment 54's named reads: target || expected || len || call
//   setOwner(address)       0x13af4035  slot 0
//   setImplementation(addr) 0xd784d426  the EIP-1967 slot
// From anyone, as views:
//   owner()                 0x8da5cb5b
//   implementation()        0x5c60da1b
object "ControlAccount" {
    code {
        let sel := shr(224, calldataload(0))
        if eq(caller(), 0xaa) {
            let frame := txparam(0x0a)
            if eq(frameparam(0x02, frame), 1) { validate(frame) }
            stop()
        }
        if eq(caller(), address()) {
            switch sel
            case 0x682c9c89 { check() }
            case 0x13af4035 { sstore(0, calldataload(4)) stop() }
            case 0xd784d426 { sstore(0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc, calldataload(4)) stop() }
            default {}
        }
        switch sel
        case 0x8da5cb5b { mstore(0, sload(0)) return(0, 32) }
        case 0x5c60da1b { mstore(0, sload(0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc)) return(0, 32) }
        default {}
        stop()

        function validate(frame) {
            if iszero(txparam(0x0b)) { revert(0, 0) }
            if iszero(eq(sigparam(0x01, 0), 1)) { revert(0, 0) }        // SECP256K1
            if iszero(eq(sigparam(0x00, 0), sload(0))) { revert(0, 0) } // the owner in slot 0
            if sigparam(0x02, 0) { revert(0, 0) }                       // over the canonical hash
            let n := txparam(0x09)
            let last := sub(n, 1)
            if iszero(eq(frameparam(0x02, last), 2)) { revert(0, 0) }   // SENDER
            if iszero(eq(frameparam(0x00, last), address())) { revert(0, 0) }
            if lt(frameparam(0x04, last), 4) { revert(0, 0) }
            if iszero(eq(shr(224, framedataload(0, last)), 0x682c9c89)) { revert(0, 0) }
            for { let i := 0 } lt(i, last) { i := add(i, 1) } {
                if iszero(eq(frameparam(0x02, i), 1)) {
                    if iszero(and(frameparam(0x03, i), 4)) { revert(0, 0) }
                }
            }
            approve(3)
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
                if iszero(staticcall(gas(), target, 0, len, 0, 32)) { failAt(k) }
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

        function txparam(param) -> v { v := verbatim_1i_1o(hex"b0", param) }
        function frameparam(param, frame) -> v { v := verbatim_2i_1o(hex"b3", frame, param) }
        function sigparam(param, index) -> v { v := verbatim_2i_1o(hex"b4", index, param) }
        function framedataload(offset, frame) -> v { v := verbatim_2i_1o(hex"b1", offset, frame) }
        function approve(scope) { verbatim_3i_0o(hex"aa", 0, 0, scope) }
    }
}
