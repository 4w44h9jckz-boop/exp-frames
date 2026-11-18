// PostTxAccount: the outcome check in an EIP-7906 mode-3 frame (POST_TX on the Hegota devnet,
// ASSERT in EIP-7906's master text), for amendment 2 of experiment 54.
//
// VERIFY (caller ENTRY_POINT, mode 1): entry 0 must be the owner's SECP256K1 signature over the
// canonical signature hash, and the last frame must be a mode-3 frame aimed at this account whose
// data starts with one of the three check selectors. The account then approves scope 3.
//
// Mode 3 (caller ENTRY_POINT, static): the frame's data selects the check.
//
//   assertWrites   0x25c8701e  the strong rule: every write must be listed
//     data = sel || nSlots || (address, slot, after)*nSlots || nBalances || (address, after)*nBalances
//            || payer
//     Each storage change in TXTRACE's diff must match a listed (address, slot) with that value
//     after. Each balance change must be listed with its value after, unless its address is the
//     payer, whose balance moves by the gas charged. No code may change.
//
//   assertNamed    0x6c29904d  the baseline: named reads, and an approval cap on one spender
//     data = sel || token || spender || cap || entry*
//     entry = target || expected || len || call (len, zero-padded to a multiple of 32)
//     Each entry's STATICCALL must return `expected` as its first word. Each Approval event the
//     token emitted with this account as owner and `spender` as spender must carry a value no
//     larger than `cap`. Approvals to anyone else are not looked at.
//
//   assertStorageCount 0x3c812280  the probe: the diff's storage count must equal the argument.
//
// A failed check reverts with one word: (kind << 128) | index.
//   kind 1 an unlisted or mismatched storage write, 2 an unlisted balance change, 3 a code change,
//   4 a named read that differs, 5 an approval over the cap, 6 the probe's count differs.
//
// TXTRACE (0xb6) and EVENTDATACOPY (0xb7) as the devnet runs them, read from forshtat/hegota-demo
// at 8095b894 (contracts/shared/TxTraceLib.sol): TXTRACE takes the index on top and the param
// beneath; EVENTDATACOPY takes, from the top, the event index, the memory offset, the data offset
// and the length.
//
// initcode = <this object> || owner (32)
object "PostTxAccount" {
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
                let mode := frameparam(0x02, frame)
                if eq(mode, 1) { validate(frame) }
                if eq(mode, 3) {
                    switch shr(224, calldataload(0))
                    case 0x25c8701e { assertWrites() }
                    case 0x6c29904d { assertNamed() }
                    case 0x3c812280 { if iszero(eq(txtrace(0x01, 0), calldataload(4))) { failAt(6, txtrace(0x01, 0)) } }
                    default { revert(0, 0) }
                }
            }
            stop()

            function validate(frame) {
                codecopy(0, sub(codesize(), 32), 32)
                let owner := mload(0)
                if iszero(txparam(0x0b)) { revert(0, 0) }
                if iszero(eq(sigparam(0x01, 0), 1)) { revert(0, 0) }      // SECP256K1
                if iszero(eq(sigparam(0x00, 0), owner)) { revert(0, 0) }  // the owner
                if sigparam(0x02, 0) { revert(0, 0) }                     // over the canonical hash
                let last := sub(txparam(0x09), 1)
                if iszero(eq(frameparam(0x02, last), 3)) { revert(0, 0) }  // a mode-3 frame last
                if iszero(eq(frameparam(0x00, last), address())) { revert(0, 0) }
                if lt(frameparam(0x04, last), 4) { revert(0, 0) }
                let sel := shr(224, framedataload(0, last))
                if iszero(or(or(eq(sel, 0x25c8701e), eq(sel, 0x6c29904d)), eq(sel, 0x3c812280))) { revert(0, 0) }
                approve(3)
            }

            function assertWrites() {
                let nSlots := calldataload(4)
                let slots := 36
                let balAt := add(slots, mul(nSlots, 96))
                let nBal := calldataload(balAt)
                let bals := add(balAt, 32)
                let payer := calldataload(add(bals, mul(nBal, 64)))

                let sc := txtrace(0x01, 0)
                for { let i := 0 } lt(i, sc) { i := add(i, 1) } {
                    let a := txtrace(0x06, i)
                    let k := txtrace(0x07, i)
                    let v := txtrace(0x09, i)
                    let ok := 0
                    for { let j := 0 } lt(j, nSlots) { j := add(j, 1) } {
                        let e := add(slots, mul(j, 96))
                        if and(eq(calldataload(e), a), eq(calldataload(add(e, 32)), k)) {
                            ok := eq(calldataload(add(e, 64)), v)
                        }
                    }
                    if iszero(ok) { failAt(1, i) }
                }

                let bc := txtrace(0x00, 0)
                for { let i := 0 } lt(i, bc) { i := add(i, 1) } {
                    let a := txtrace(0x03, i)
                    if iszero(eq(a, payer)) {
                        let v := txtrace(0x05, i)
                        let ok := 0
                        for { let j := 0 } lt(j, nBal) { j := add(j, 1) } {
                            let e := add(bals, mul(j, 64))
                            if eq(calldataload(e), a) { ok := eq(calldataload(add(e, 32)), v) }
                        }
                        if iszero(ok) { failAt(2, i) }
                    }
                }

                if txtrace(0x02, 0) { failAt(3, 0) }
                stop()
            }

            function assertNamed() {
                let token := calldataload(4)
                let spender := calldataload(36)
                let cap := calldataload(68)
                let end := calldatasize()
                let p := 100
                for { let k := 0 } lt(p, end) { k := add(k, 1) } {
                    if gt(add(p, 96), end) { failAt(4, k) }
                    let target := calldataload(p)
                    let expected := calldataload(add(p, 32))
                    let len := calldataload(add(p, 64))
                    if gt(len, 0xffff) { failAt(4, k) }
                    calldatacopy(0, add(p, 96), len)
                    if iszero(staticcall(gas(), target, 0, len, 0, 32)) { failAt(4, k) }
                    if lt(returndatasize(), 32) { failAt(4, k) }
                    if iszero(eq(mload(0), expected)) { failAt(4, k) }
                    p := add(add(p, 96), and(add(len, 31), not(31)))
                }

                let ec := txtrace(0x0c, 0)
                for { let i := 0 } lt(i, ec) { i := add(i, 1) } {
                    if eq(txtrace(0x0d, i), token) {
                        if gt(txtrace(0x0e, i), 2) {
                            if eq(txtrace(0x0f, i), 0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925) {
                                if and(eq(txtrace(0x10, i), address()), eq(txtrace(0x11, i), spender)) {
                                    mstore(0, 0)
                                    eventdatacopy(i, 0, 0, 32)
                                    if gt(mload(0), cap) { failAt(5, i) }
                                }
                            }
                        }
                    }
                }
                stop()
            }

            function failAt(kind, i) {
                mstore(0, or(shl(128, kind), i))
                revert(0, 32)
            }

            function txparam(param) -> v { v := verbatim_1i_1o(hex"b0", param) }
            function frameparam(param, frame) -> v { v := verbatim_2i_1o(hex"b3", frame, param) }
            function sigparam(param, index) -> v { v := verbatim_2i_1o(hex"b4", index, param) }
            function framedataload(offset, frame) -> v { v := verbatim_2i_1o(hex"b1", offset, frame) }
            function approve(scope) { verbatim_3i_0o(hex"aa", 0, 0, scope) }
            function txtrace(param, index) -> v { v := verbatim_2i_1o(hex"b6", index, param) }
            function eventdatacopy(eventIndex, memOffset, dataOffset, length) {
                verbatim_4i_0o(hex"b7", eventIndex, memOffset, dataOffset, length)
            }
        }
    }
}
