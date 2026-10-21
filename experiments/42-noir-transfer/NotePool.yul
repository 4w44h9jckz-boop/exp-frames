// NotePool: notes on Aztec's model, with no rollup. The pool keeps the note tree on L1, is its own
// frame-transaction sender, and takes a Noir proof from transfer.nr as the only authorisation of a
// transfer.
//
// A note is a leaf H(NOTE, owner, value, randomness) of a depth-32 Poseidon2 tree, where
// owner = H(OWNER, nsk), and spending it reveals H(NULLIFIER, note, nsk). H is the sponge
// Poseidon2.yul computes, the same one the circuit computes.
//
// Deposits are ordinary calls: `deposit(bytes32 owner, bytes32 randomness)` with the note's value,
// below 2^64 wei. The pool computes the leaf, so a note's value is the ether that came in with it.
//
// A transfer is an EIP-8141 frame transaction with `tx.sender` = this pool and no signature. It
// spends two notes and creates two, and pays `fee` of their value to the pool, which pays the gas.
// Its layout, exactly:
//
//   frame 0  VERIFY  0x8272, (source_id || slot || root): the EIP-8272 verifier frame
//   frame 1  VERIFY  this pool, scope 3: it approves execution and pays
//   frame 2  SENDER  this pool -> itself,
//                    transfer(bytes32 root, bytes32 n0, bytes32 n1, bytes32 out0, bytes32 out1,
//                             uint256 fee, bytes proof)
//
// with the two nullifiers as the transaction's EIP-8250 nonce keys, n0 < n1, at sequence 0, so
// the protocol refuses a second spend. The proof's public inputs are, in the circuit's order,
// root, n0, n1, out0, out1, fee and context = this pool's address.
//
// VERIFY reads no storage. It checks the layout, the root through frame 0, the nonce keys and the
// proof (a call to Barretenberg's verifier), then approves.
//
// initcode = <this object> || verifier (32) || hasher (32) || salt (32). The constructor appends
// the tree's empty subtrees, zero(0) to zero(32), computed with the hasher, ahead of those words:
// deployed code = runtime || zeros (33 words) || verifier || hasher || salt.
object "NotePool" {
    code {
        let size := datasize("runtime")
        datacopy(0, dataoffset("runtime"), size)
        codecopy(add(size, 1056), sub(codesize(), 96), 96)
        let hasher := mload(add(size, 1088))
        let z := 0
        mstore(add(size, 0), z)
        for { let level := 1 } lt(level, 33) { level := add(level, 1) } {
            // H(NODE, z, z), with scratch above the code being returned.
            let p := add(size, 2048)
            mstore(p, 4)
            mstore(add(p, 0x20), z)
            mstore(add(p, 0x40), z)
            if iszero(staticcall(gas(), hasher, p, 0x60, p, 0x20)) { revert(0, 0) }
            z := mload(p)
            mstore(add(size, shl(5, level)), z)
        }
        return(0, add(size, 1152))
    }
    object "runtime" {
        code {
            // ENTRY_POINT (0xaa) calls in DEFAULT and VERIFY frames. Only VERIFY does anything.
            if eq(caller(), 0xaa) {
                let frame := txparam(0x0a)
                if eq(frameparam(0x02, frame), 1) { validate(frame) }
                stop()
            }

            switch shr(224, calldataload(0))
            case 0xe9ceb85f { deposit(calldataload(4), calldataload(0x24)) } // deposit(bytes32,bytes32)
            case 0xb4b15d56 { transfer() }                    // transfer(bytes32,bytes32,bytes32,bytes32,bytes32,uint256,bytes)
            case 0x8bb852fe { republish() }                   // republish()
            case 0xba70f757 { ret(sload(2)) }                 // getLastRoot()
            case 0xfc7e9c6f { ret(sload(0)) }                 // nextIndex()
            case 0xd069aab9 { ret(sourceId()) }               // sourceId()
            default { revert(0, 0) }

            // ---- VERIFY ----

            function validate(me) {
                if iszero(eq(me, 1)) { revert(0, 0) }
                if iszero(eq(txparam(0x09), 3)) { revert(0, 0) }
                if iszero(eq(frameparam(0x06, me), 3)) { revert(0, 0) }

                // Frame 2: SENDER, to this pool, no value, no flags, a canonical transfer()
                // encoding. Every SENDER frame runs as the pool, so its shape is fixed.
                if iszero(eq(frameparam(0x02, 2), 2)) { revert(0, 0) }
                if iszero(eq(frameparam(0x00, 2), address())) { revert(0, 0) }
                if frameparam(0x08, 2) { revert(0, 0) }
                if frameparam(0x03, 2) { revert(0, 0) }
                if iszero(eq(shr(224, framedataload(0, 2)), 0xb4b15d56)) { revert(0, 0) }
                if iszero(eq(framedataload(0xc4, 2), 0xe0)) { revert(0, 0) }
                let proofLength := framedataload(0xe4, 2)
                if or(gt(proofLength, 0x4000), and(proofLength, 31)) { revert(0, 0) }
                if iszero(eq(frameparam(0x04, 2), add(0x104, proofLength))) { revert(0, 0) }

                let root := framedataload(0x04, 2)
                let n0 := framedataload(0x24, 2)
                let n1 := framedataload(0x44, 2)
                let fee := framedataload(0xa4, 2)
                if iszero(lt(n0, n1)) { revert(0, 0) }

                // Frame 0 is the EIP-8272 verifier frame; the protocol checks its tuple
                // (source_id || slot || root) against the predeploy before this runs.
                if iszero(eq(frameparam(0x00, 0), 0x8272)) { revert(0, 0) }
                if iszero(eq(frameparam(0x02, 0), 1)) { revert(0, 0) }
                if frameparam(0x03, 0) { revert(0, 0) }
                if iszero(eq(frameparam(0x04, 0), 72)) { revert(0, 0) }
                if iszero(eq(framedataload(0, 0), sourceId())) { revert(0, 0) }
                if iszero(eq(framedataload(40, 0), root)) { revert(0, 0) }

                // The nullifiers are the nonce keys, ascending, at sequence 0: EIP-8250's
                // nonce_keys_hash = keccak256(len || keys).
                if iszero(eq(txparam(0x0e), 2)) { revert(0, 0) }
                if txparam(0x01) { revert(0, 0) }
                mstore(0, 2)
                mstore(0x20, n0)
                mstore(0x40, n1)
                if iszero(eq(keccak256(0, 0x60), txparam(0x0f))) { revert(0, 0) }

                // Nobody can make frame 2 fail after approval by starving it, which would burn
                // both notes: the nonce keys are consumed when payment is approved.
                if lt(frameparam(0x01, 2), INSERT_EXECUTION()) { revert(0, 0) }
                if lt(frameparam(0x09, 2), INSERT_STATE()) { revert(0, 0) }

                // The pool pays, from the fee, which the proof binds and which covers the worst case.
                if lt(fee, txparam(0x06)) { revert(0, 0) }

                verifyProof(proofLength)
                approve(3)
            }

            // Barretenberg's HonkVerifier.verify(bytes proof, bytes32[] publicInputs), the proof
            // and five inputs copied out of frame 2's calldata, the context appended.
            function verifyProof(proofLength) {
                let p := 0x400
                mstore(p, shl(224, 0xea50d0e4))
                mstore(add(p, 0x04), 0x40)
                mstore(add(p, 0x24), add(0x60, proofLength))
                mstore(add(p, 0x44), proofLength)
                framedatacopy(add(p, 0x64), 0x104, proofLength, 2)
                let inputs := add(add(p, 0x64), proofLength)
                mstore(inputs, 7)
                framedatacopy(add(inputs, 0x20), 0x04, 0xc0, 2)    // root, n0, n1, out0, out1, fee
                mstore(add(inputs, 0xe0), address())               // context
                if iszero(staticcall(gas(), word(96), p, sub(add(inputs, 0x100), p), 0, 0x20)) { revert(0, 0) }
                if iszero(and(eq(returndatasize(), 0x20), eq(mload(0), 1))) { revert(0, 0) }
            }

            // Frame 2's floors: two insertions of 32 hashes each, and the state they may set.
            // Measured on the testnet; see the README.
            function INSERT_EXECUTION() -> g { g := 2500000 }
            function INSERT_STATE() -> g { g := 391680 }

            // ---- SENDER: the transfer frame ----

            function transfer() {
                // Only a SENDER frame of a transaction this pool approved has the pool as caller.
                if iszero(eq(caller(), address())) { revert(0, 0) }
                pop(insert(calldataload(0x64)))
                pop(insert(calldataload(0x84)))
                recordRoot(sload(2))
                mstore(0, calldataload(0x24))
                mstore(0x20, calldataload(0x44))
                mstore(0x40, calldataload(0xa4))
                log1(0, 0x60, 0xbc7a322f72742a0c810e1f76615f57ed3a5bbfcbd956d3d451b3158968faace9)
                stop()
            }

            // ---- deposits and the tree ----

            function deposit(owner, randomness) {
                let value := callvalue()
                if or(iszero(value), shr(64, value)) { revert(0, 0) }
                if iszero(and(lt(owner, FIELD()), lt(randomness, FIELD()))) { revert(0, 0) }
                let p := 0x400
                mstore(p, 2)                // NOTE
                mstore(add(p, 0x20), owner)
                mstore(add(p, 0x40), value)
                mstore(add(p, 0x60), randomness)
                if iszero(staticcall(gas(), word(64), p, 0x80, p, 0x20)) { revert(0, 0) }
                pop(insert(mload(p)))
                recordRoot(sload(2))
                stop()
            }

            // Tornado's MerkleTreeWithHistory._insert, at depth 32 with H(NODE, left, right).
            // filledSubtrees[level] is read only where an earlier insertion wrote it.
            function insert(leaf) -> index {
                if iszero(lt(leaf, FIELD())) { revert(0, 0) }
                index := sload(0)
                if shr(32, index) { revert(0, 0) }
                let node := leaf
                let i := index
                for { let level := 0 } lt(level, 32) { level := add(level, 1) } {
                    switch and(i, 1)
                    case 0 {
                        sstore(add(0x100, level), node)
                        node := hashNode(node, zero(level))
                    }
                    default {
                        node := hashNode(sload(add(0x100, level)), node)
                    }
                    i := shr(1, i)
                }
                sstore(0, add(index, 1))
                sstore(2, node)
                mstore(0, index)
                log2(0, 0x20, 0xcc529b4c6e5f2920440d630bcbcaf9df7e89d2c5e69fd19c66cd0e565d7f98ba, leaf)
            }

            function hashNode(left, right) -> r {
                mstore(0, 4)                // NODE
                mstore(0x20, left)
                mstore(0x40, right)
                if iszero(staticcall(gas(), word(64), 0, 0x60, 0, 0x20)) { revert(0, 0) }
                r := mload(0)
            }

            // EIP-8272 write: calldata salt || root, source_id = keccak256(pool || salt).
            function recordRoot(root) {
                mstore(0, word(32))
                mstore(0x20, root)
                if iszero(call(gas(), 0x8272, 0, 0, 0x40, 0, 0)) { revert(0, 0) }
                mstore(0, root)
                mstore(0x20, slotnum())
                log1(0, 0x40, 0x2fd31368794d8179a2869e743a7fb1d8819c4b52d4154ba95ddbba7cf39a8552)
            }

            // Anyone may publish the current root again, so that a pool with no recent note
            // still has a root inside the EIP-8272 window (8191 slots).
            function republish() {
                let root := sload(2)
                if iszero(root) { revert(0, 0) }
                recordRoot(root)
                stop()
            }

            function sourceId() -> id {
                mstore(0, address())
                mstore(0x20, word(32))
                id := keccak256(12, 52)
            }

            // ---- helpers ----

            function FIELD() -> f { f := 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001 }

            // The constructor's zero(level), stored 33 words ahead of the three words at the end.
            function zero(level) -> z {
                codecopy(0x60, add(sub(codesize(), 1152), shl(5, level)), 32)
                z := mload(0x60)
            }

            // A constructor word, counted from the end of the code: salt 32, hasher 64,
            // verifier 96. Uses scratch at 0x60.
            function word(fromEnd) -> v {
                codecopy(0x60, sub(codesize(), fromEnd), 32)
                v := mload(0x60)
            }

            function ret(v) {
                mstore(0, v)
                return(0, 0x20)
            }

            // EIP-8141 opcodes, and EIP-7843 SLOTNUM. verbatim puts its first argument on top.
            function txparam(param) -> v { v := verbatim_1i_1o(hex"b0", param) }
            function frameparam(param, frame) -> v { v := verbatim_2i_1o(hex"b3", frame, param) }
            function framedataload(offset, frame) -> v { v := verbatim_2i_1o(hex"b1", offset, frame) }
            function framedatacopy(memOffset, dataOffset, length, frame) {
                verbatim_4i_0o(hex"b2", memOffset, dataOffset, length, frame)
            }
            function approve(scope) { verbatim_3i_0o(hex"aa", 0, 0, scope) }
            function slotnum() -> v { v := verbatim_0i_1o(hex"4b") }
        }
    }
}
