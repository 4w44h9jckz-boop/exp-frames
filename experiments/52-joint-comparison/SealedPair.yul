// SealedPair: two owners' sealed comparison, settled by a joint proof, with bonds that a valid
// result consumes or that a deadline returns (experiment 52).
//
//   open(bytes32 session, uint256 Ca, address bob, uint64 deadline)  payable: Alice, her bond
//   join(bytes32 session, uint256 Cb)                                payable: Bob, the same bond
//   reveal(bytes32 session, uint256 x, uint256 y)                    Alice: her share of pi_c
//   reclaim(bytes32 session)                                         anyone, at or after the deadline
//
// The settlement is a frame transaction with this contract as sender and payer, exactly:
//
//   frame 0  VERIFY  0x8141, the transaction's deadline (8 bytes), at most the session's
//   frame 1  VERIFY  this contract, scope 3: the session joined, the proof valid for
//                    (Ca, Cb, session, out); approves and pays
//   frame 2  SENDER  this contract -> itself, settle(bytes32 session, uint256 out, uint256[8] proof)
//
// with the session as its only EIP-8250 nonce key, at sequence 0. settle returns both bonds and
// records out. An unsettled session, at or after its deadline, pays out by how far it got:
// opened only, Alice's bond to Alice; joined, each its own; Alice's share posted, both to Alice.
//
// VERIFY reads only this contract's own storage. Storage of a session at keccak256(session || 0):
// +0 alice +1 bob +2 Ca +3 Cb +4 bond +5 deadline +6 state +7 out
// state: 0 none, 1 opened, 2 joined, 3 revealed, 4 settled, 5 reclaimed.
//
// initcode = <this object> || verifier (32)
object "SealedPair" {
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
                if eq(frameparam(0x02, frame), 1) { validate(frame) }
                stop()
            }
            switch shr(224, calldataload(0))
            case 0xeb3d0906 { open(calldataload(4), calldataload(0x24), calldataload(0x44), calldataload(0x64)) }
            case 0xe5009bb6 { join(calldataload(4), calldataload(0x24)) }
            case 0x2cf5d279 { reveal(calldataload(4), calldataload(0x24), calldataload(0x44)) }
            case 0x96afb365 { reclaim(calldataload(4)) }
            case 0x7314ecea { settle() }
            default {
                if calldatasize() { revert(0, 0) }
                stop()   // plain ether: gas money for settlements
            }

            // ---- VERIFY ----

            function validate(me) {
                if iszero(eq(me, 1)) { revert(0, 0) }
                if iszero(eq(txparam(0x09), 3)) { revert(0, 0) }
                if iszero(eq(frameparam(0x06, me), 3)) { revert(0, 0) }

                // Frame 2: settle(...), to this contract, no value, no flags.
                if iszero(eq(frameparam(0x02, 2), 2)) { revert(0, 0) }
                if iszero(eq(frameparam(0x00, 2), address())) { revert(0, 0) }
                if frameparam(0x08, 2) { revert(0, 0) }
                if frameparam(0x03, 2) { revert(0, 0) }
                if iszero(eq(frameparam(0x04, 2), 324)) { revert(0, 0) }
                if iszero(eq(shr(224, framedataload(0, 2)), 0x7314ecea)) { revert(0, 0) }
                let session := framedataload(4, 2)
                let out := framedataload(0x24, 2)
                if gt(out, 1) { revert(0, 0) }

                // The session's only nonce key, at sequence 0: one settlement.
                if iszero(eq(txparam(0x0e), 1)) { revert(0, 0) }
                if txparam(0x01) { revert(0, 0) }
                mstore(0, 1)
                mstore(0x20, session)
                if iszero(eq(keccak256(0, 0x40), txparam(0x0f))) { revert(0, 0) }

                // Joined (with or without Alice's share), and the transaction expires by the
                // session's deadline: frame 0 is the expiry verifier, which the protocol runs.
                let base := slotOf(session)
                let state := sload(add(base, 6))
                if iszero(or(eq(state, 2), eq(state, 3))) { revert(0, 0) }
                if iszero(eq(frameparam(0x00, 0), 0x8141)) { revert(0, 0) }
                if iszero(eq(frameparam(0x02, 0), 1)) { revert(0, 0) }
                if iszero(eq(frameparam(0x04, 0), 8)) { revert(0, 0) }
                if gt(shr(192, framedataload(0, 0)), sload(add(base, 5))) { revert(0, 0) }

                // A bound on what a settlement can cost this contract.
                if gt(txparam(0x06), MAX_COST()) { revert(0, 0) }
                if lt(frameparam(0x01, 2), 120000) { revert(0, 0) }

                // The proof, for (Ca, Cb, session, out). GAS sits right before STATICCALL.
                framedatacopy(0x80, 0x44, 256, 2)
                mstore(0x180, sload(add(base, 2)))
                mstore(0x1a0, sload(add(base, 3)))
                mstore(0x1c0, session)
                mstore(0x1e0, out)
                if iszero(staticcall(gas(), word(32), 0x80, 0x180, 0, 0x20)) { revert(0, 0) }
                if iszero(and(eq(returndatasize(), 0x20), eq(mload(0), 1))) { revert(0, 0) }

                approve(3)
            }

            // ---- the session ----

            function open(session, Ca, bob, deadline) {
                let base := slotOf(session)
                if sload(add(base, 6)) { revert(0, 0) }
                if iszero(lt(session, FIELD())) { revert(0, 0) }
                if iszero(lt(Ca, FIELD())) { revert(0, 0) }
                if or(shr(160, bob), iszero(bob)) { revert(0, 0) }
                if iszero(gt(deadline, timestamp())) { revert(0, 0) }
                if shr(64, deadline) { revert(0, 0) }
                if iszero(callvalue()) { revert(0, 0) }
                sstore(base, caller())
                sstore(add(base, 1), bob)
                sstore(add(base, 2), Ca)
                sstore(add(base, 4), callvalue())
                sstore(add(base, 5), deadline)
                sstore(add(base, 6), 1)
                emit(session, 1, Ca, deadline)
                stop()
            }

            function join(session, Cb) {
                let base := slotOf(session)
                if iszero(eq(sload(add(base, 6)), 1)) { revert(0, 0) }
                if iszero(eq(caller(), sload(add(base, 1)))) { revert(0, 0) }
                if iszero(eq(callvalue(), sload(add(base, 4)))) { revert(0, 0) }
                if iszero(lt(timestamp(), sload(add(base, 5)))) { revert(0, 0) }
                if iszero(lt(Cb, FIELD())) { revert(0, 0) }
                sstore(add(base, 3), Cb)
                sstore(add(base, 6), 2)
                emit(session, 2, Cb, 0)
                stop()
            }

            // Alice's share of pi_c, in public: from now on Bob alone can complete the proof.
            function reveal(session, x, y) {
                let base := slotOf(session)
                if iszero(eq(sload(add(base, 6)), 2)) { revert(0, 0) }
                if iszero(eq(caller(), sload(base))) { revert(0, 0) }
                if iszero(lt(timestamp(), sload(add(base, 5)))) { revert(0, 0) }
                sstore(add(base, 6), 3)
                emit(session, 3, x, y)
                stop()
            }

            function reclaim(session) {
                let base := slotOf(session)
                let state := sload(add(base, 6))
                if lt(timestamp(), sload(add(base, 5))) { revert(0, 0) }
                let bond := sload(add(base, 4))
                let alice := sload(base)
                let bob := sload(add(base, 1))
                switch state
                case 1 { pay(alice, bond) }
                case 2 {
                    pay(alice, bond)
                    pay(bob, bond)
                }
                case 3 { pay(alice, add(bond, bond)) }
                default { revert(0, 0) }
                sstore(add(base, 6), 5)
                emit(session, 5, state, 0)
                stop()
            }

            // SENDER, after VERIFY checked the proof.
            function settle() {
                if iszero(eq(caller(), address())) { revert(0, 0) }
                let session := calldataload(4)
                let out := calldataload(0x24)
                let base := slotOf(session)
                let bond := sload(add(base, 4))
                sstore(add(base, 6), 4)
                sstore(add(base, 7), out)
                pay(sload(base), bond)
                pay(sload(add(base, 1)), bond)
                emit(session, 4, out, 0)
                stop()
            }

            // A payout cannot revert the session: a fixed stipend, and a failed call keeps the
            // ether here.
            function pay(who, amount) { pop(call(10000, who, amount, 0, 0, 0, 0)) }

            // Step(bytes32 indexed session, uint256 state, uint256 x, uint256 y)
            function emit(session, state, x, y) {
                mstore(0, state)
                mstore(0x20, x)
                mstore(0x40, y)
                log2(0, 0x60, 0xbbaad9b50e82e035000d4ed0b1555a6c8d897f0c8aec53729898ba93384a9fed, session)
            }

            function slotOf(session) -> s {
                mstore(0, session)
                mstore(0x20, 0)
                s := keccak256(0, 0x40)
            }

            function MAX_COST() -> c { c := 10000000000000000 } // 0.01 ETH
            function FIELD() -> f { f := 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001 }

            function word(fromEnd) -> v {
                codecopy(0x60, sub(codesize(), fromEnd), 32)
                v := mload(0x60)
            }

            function txparam(param) -> v { v := verbatim_1i_1o(hex"b0", param) }
            function frameparam(param, frame) -> v { v := verbatim_2i_1o(hex"b3", frame, param) }
            function framedataload(offset, frame) -> v { v := verbatim_2i_1o(hex"b1", offset, frame) }
            function framedatacopy(memOffset, dataOffset, length, frame) {
                verbatim_4i_0o(hex"b2", memOffset, dataOffset, length, frame)
            }
            function approve(scope) { verbatim_3i_0o(hex"aa", 0, 0, scope) }
        }
    }
}
