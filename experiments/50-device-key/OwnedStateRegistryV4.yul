// OwnedStateRegistry, version 4: version 3 (OwnedStateRegistry.yul, experiment 50) with the
// owner check replaced by a WebAuthn passkey's assertion, for the addendum's passkey arm. The
// note, the kernel, the update's 15 words, the layout and the deadline-free single update are
// version 3's; only `ownerSigned` differs, and the `keyed` word is always 1.
//
// initcode = <this object> || hasher (32) || verifier (32) || salt (32) || keyed (32)
object "OwnedStateRegistry" {
    code {
        let size := datasize("runtime")
        datacopy(0, dataoffset("runtime"), size)
        codecopy(size, sub(codesize(), 128), 128)
        return(0, add(size, 128))
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
            case 0xb9e1aa03 { deposit(calldataload(4), calldataload(0x24)) } // deposit(address,bytes32)
            case 0x7f81305f { update() }                      // update(bytes32,uint256[15][])
            case 0x1e83409a { claim(calldataload(4)) }        // claim(address)
            case 0x8bb852fe { republish() }                   // republish()
            case 0xba70f757 { ret(sload(2)) }                 // getLastRoot()
            case 0xfc7e9c6f { ret(sload(0)) }                 // nextIndex()
            case 0xdf18e047 { ret(sload(mapslot(calldataload(4), 6))) } // owed(address)
            case 0xd069aab9 { ret(sourceId()) }               // sourceId()
            default { revert(0, 0) }

            // ---- VERIFY ----

            function validate(me) {
                // [8272 verifier, this VERIFY scope 3, SENDER update]. Every SENDER frame runs as
                // the registry, so one extra frame could move every application's ether.
                if iszero(eq(me, 1)) { revert(0, 0) }
                if iszero(eq(txparam(0x09), 3)) { revert(0, 0) }
                if iszero(eq(frameparam(0x06, me), 3)) { revert(0, 0) }

                // Frame 2: SENDER, to this registry, no value, no flags, a canonical encoding.
                if iszero(eq(frameparam(0x02, 2), 2)) { revert(0, 0) }
                if iszero(eq(frameparam(0x00, 2), address())) { revert(0, 0) }
                if frameparam(0x08, 2) { revert(0, 0) }
                if frameparam(0x03, 2) { revert(0, 0) }
                if iszero(eq(shr(224, framedataload(0, 2)), 0x7f81305f)) { revert(0, 0) }
                if iszero(eq(framedataload(0x24, 2), 0x40)) { revert(0, 0) }
                let k := framedataload(0x44, 2)
                if iszero(eq(k, 1)) { revert(0, 0) }
                if iszero(eq(frameparam(0x04, 2), add(0x64, mul(k, 480)))) { revert(0, 0) }
                let root := framedataload(0x04, 2)

                // Frame 0 is the EIP-8272 verifier frame; the protocol checks its tuple
                // (source_id || slot || root) against the predeploy before this runs.
                if iszero(eq(frameparam(0x00, 0), 0x8272)) { revert(0, 0) }
                if iszero(eq(frameparam(0x02, 0), 1)) { revert(0, 0) }
                if frameparam(0x03, 0) { revert(0, 0) }
                if iszero(eq(frameparam(0x04, 0), 72)) { revert(0, 0) }
                if iszero(eq(framedataload(0, 0), sourceId())) { revert(0, 0) }
                if iszero(eq(framedataload(40, 0), root)) { revert(0, 0) }

                // The nullifiers are the nonce keys, ascending, at sequence 0: EIP-8250's
                // nonce_keys_hash = keccak256(len || keys), built at 0x400.
                if iszero(eq(txparam(0x0e), k)) { revert(0, 0) }
                if txparam(0x01) { revert(0, 0) }
                mstore(0x400, k)
                mstore(0x420, field(2, 0))
                if iszero(eq(keccak256(0x400, shl(5, add(k, 1))), txparam(0x0f))) { revert(0, 0) }

                let fees := 0
                let inserts := 0
                let payouts := 0
                for { let i := 0 } lt(i, k) { i := add(i, 1) } {
                    let at := add(0x64, mul(i, 480))
                    let newCommitment := field(2, add(mul(i, 480), 32))
                    let tag := framedataload(add(at, 64), 2)
                    let withdrawn := framedataload(add(at, 96), 2)
                    let recipient := framedataload(add(at, 128), 2)
                    let fee := framedataload(add(at, 160), 2)
                    if or(shr(160, tag), shr(160, recipient)) { revert(0, 0) }
                    if shr(64, withdrawn) { revert(0, 0) }
                    if gt(fee, withdrawn) { revert(0, 0) }
                    fees := add(fees, fee)
                    if newCommitment { inserts := add(inserts, 1) }
                    if gt(withdrawn, fee) { payouts := add(payouts, 1) }
                    let owner := framedataload(add(at, 192), 2)
                    if shr(160, owner) { revert(0, 0) }
                    allows(tag, withdrawn, newCommitment)
                    verifyProof(at, root)
                    if word(32) { ownerSigned(owner) }
                }

                // The fees are the registry's and cover the worst case.
                if lt(fees, txparam(0x06)) { revert(0, 0) }

                // Nobody can make frame 2 fail after approval by starving it: once the nonce
                // keys are consumed, a failed update would burn the notes.
                if lt(frameparam(0x01, 2), add(mul(k, UPDATE_EXECUTION()), mul(inserts, INSERT_EXECUTION()))) { revert(0, 0) }
                if lt(frameparam(0x09, 2), add(mul(payouts, 183600), mul(inserts, INSERT_STATE()))) { revert(0, 0) }

                approve(3)
            }

            // The application's rule: allows(withdrawn, change), answered from its code alone.
            function allows(tag, withdrawn, newCommitment) {
                mstore(0, shl(224, 0x396faf6a))
                mstore(0x04, withdrawn)
                mstore(0x24, iszero(iszero(newCommitment)))
                if iszero(staticcall(gas(), tag, 0, 0x44, 0, 0x20)) { revert(0, 0) }
                if iszero(and(eq(returndatasize(), 0x20), eq(mload(0), 1))) { revert(0, 0) }
            }

            // The owner's passkey: one ARBITRARY entry carrying a WebAuthn assertion whose
            // challenge is TXPARAM(0x08), the signature hash. Layout:
            //   authLen (2) || clientLen (2) || challengeIndex (2) || typeIndex (2)
            //   || authenticatorData || clientDataJSON || r || s || qx || qy
            // and nothing more. Memory from 0x600 up; the proof's is below.
            function ownerSigned(owner) {
                if iszero(eq(txparam(0x0b), 1)) { revert(0, 0) }   // exactly one entry
                if sigparam(0x01, 0) { revert(0, 0) }               // ARBITRARY
                if sigparam(0x02, 0) { revert(0, 0) }               // msg empty
                let len := sigparam(0x03, 0)
                sigdatacopy(0x800, 0, 8, 0)
                let head := mload(0x800)
                let authLen := shr(240, head)
                let clientLen := and(shr(224, head), 0xffff)
                let ci := and(shr(208, head), 0xffff)
                let ti := and(shr(192, head), 0xffff)
                // Exactly the declared parts: no trailing bytes.
                if iszero(eq(len, add(136, add(authLen, clientLen)))) { revert(0, 0) }
                if lt(authLen, 37) { revert(0, 0) }
                let auth := 0x900
                let client := add(auth, authLen)
                let tail := add(client, clientLen)                  // r s qx qy
                sigdatacopy(auth, 8, sub(len, 8), 0)

                // The relying party, and the user-presence flag.
                if iszero(eq(mload(auth), RP_ID_HASH())) { revert(0, 0) }
                if iszero(and(byte(0, mload(add(auth, 32))), 0x01)) { revert(0, 0) }

                // "type":"webauthn.get" (21 bytes) at typeIndex.
                if gt(add(ti, 21), clientLen) { revert(0, 0) }
                if iszero(eq(shr(88, mload(add(client, ti))), shr(88, "\"type\":\"webauthn.get\""))) { revert(0, 0) }
                // "challenge":"<43 characters of base64url(sig hash)>" at challengeIndex.
                if gt(add(ci, 57), clientLen) { revert(0, 0) }
                let c := add(client, ci)
                if iszero(eq(shr(152, mload(c)), shr(152, "\"challenge\":\""))) { revert(0, 0) }
                base64url(txparam(0x08), 0x700)
                if iszero(eq(mload(add(c, 13)), mload(0x700))) { revert(0, 0) }
                if iszero(eq(shr(168, mload(add(c, 45))), shr(168, mload(0x720)))) { revert(0, 0) }
                if iszero(eq(byte(0, mload(add(c, 56))), 0x22)) { revert(0, 0) }

                // The key is the note's owner; low s.
                if iszero(eq(and(keccak256(add(tail, 64), 64), 0xffffffffffffffffffffffffffffffffffffffff), owner)) { revert(0, 0) }
                if gt(mload(add(tail, 32)), 0x7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8) { revert(0, 0) }

                // message = SHA-256(authenticatorData || SHA-256(clientDataJSON))
                if iszero(staticcall(gas(), 0x02, client, clientLen, 0x700, 32)) { revert(0, 0) }
                mstore(client, mload(0x700))
                if iszero(staticcall(gas(), 0x02, auth, add(authLen, 32), 0x700, 32)) { revert(0, 0) }
                mstore(0x600, mload(0x700))
                mstore(0x620, mload(tail))
                mstore(0x640, mload(add(tail, 32)))
                mstore(0x660, mload(add(tail, 64)))
                mstore(0x680, mload(add(tail, 96)))
                mstore(0, 0)
                if iszero(staticcall(gas(), 0x100, 0x600, 160, 0, 32)) { revert(0, 0) }
                if iszero(eq(mload(0), 1)) { revert(0, 0) }
            }

            // SHA-256("exp-frames.test"), the relying party.
            function RP_ID_HASH() -> h { h := 0xe3d05b23c7d36a4c8e9a003e1f841e5c781c23247fab56ea2ba6bc748c06b9de }

            // 32 bytes as 43 base64url characters, no padding, at `out` (experiment 11's).
            function base64url(value, out) {
                let lo := "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef"
                let hi := "ghijklmnopqrstuvwxyz0123456789-_"
                for { let i := 0 } lt(i, 42) { i := add(i, 1) } {
                    mstore8(add(out, i), char(and(shr(sub(250, mul(6, i)), value), 63), lo, hi))
                }
                mstore8(add(out, 42), char(and(shl(2, value), 63), lo, hi))
            }

            function char(index, lo, hi) -> c {
                switch lt(index, 32)
                case 1 { c := byte(index, lo) }
                default { c := byte(sub(index, 32), hi) }
            }

            // The kernel proof, copied out of frame 2, against its seven public inputs.
            // `gas()` is evaluated last, so GAS sits immediately before STATICCALL.
            function verifyProof(at, root) {
                let p := 0x80
                framedatacopy(p, add(at, 224), 256, 2)
                mstore(add(p, 0x100), root)
                framedatacopy(add(p, 0x120), at, 128, 2)       // nullifier, newCommitment, tag, withdrawn
                // binding = keccak256(recipient || fee || owner) >> 8
                framedatacopy(0x300, add(at, 128), 96, 2)
                mstore(add(p, 0x1a0), shr(8, keccak256(0x300, 96)))
                mstore(add(p, 0x1c0), framedataload(add(at, 192), 2))   // owner
                if iszero(staticcall(gas(), word(96), p, 0x1e0, 0, 0x20)) { revert(0, 0) }
                if iszero(and(eq(returndatasize(), 0x20), eq(mload(0), 1))) { revert(0, 0) }
            }

            // A field element of frame `frame`'s update data, at `offset` past the updates' start.
            function field(frame, offset) -> v {
                v := framedataload(add(0x64, offset), frame)
                if iszero(lt(v, FIELD())) { revert(0, 0) }
            }

            // ---- SENDER: the update frame ----

            function update() {
                // Only a SENDER frame of a transaction this registry approved has it as caller.
                if iszero(eq(caller(), address())) { revert(0, 0) }
                let k := calldataload(0x44)
                let inserted := 0
                for { let i := 0 } lt(i, k) { i := add(i, 1) } {
                    let at := add(0x64, mul(i, 480))
                    let nullifier := calldataload(at)
                    let newCommitment := calldataload(add(at, 32))
                    let tag := calldataload(add(at, 64))
                    let withdrawn := calldataload(add(at, 96))
                    let recipient := calldataload(add(at, 128))
                    let fee := calldataload(add(at, 160))
                    if newCommitment {
                        insert(tag, newCommitment)
                        inserted := 1
                    }
                    // Nothing below can revert: a reverting recipient is credited instead. The
                    // fee stays here, for the gas the registry paid. The recipient gets a fixed
                    // stipend, so in a pair one recipient cannot starve the other's update.
                    let amount := sub(withdrawn, fee)
                    if amount {
                        if iszero(call(PAYOUT_STIPEND(), recipient, amount, 0, 0, 0, 0)) {
                            credit(recipient, amount)
                        }
                    }
                    mstore(0, nullifier)
                    mstore(0x20, recipient)
                    mstore(0x40, withdrawn)
                    mstore(0x60, fee)
                    log2(0, 0x80, 0xfb15c1793eb288efe330f5c4867944badf5c105ad045a32b19a289fdefd0f7ca, tag)
                }
                if inserted { recordRoot(sload(2)) }
                stop()
            }

            function credit(who, amount) {
                let s := mapslot(who, 6)
                sstore(s, add(sload(s), amount))
            }

            function claim(who) {
                let s := mapslot(who, 6)
                let amount := sload(s)
                sstore(s, 0)
                if iszero(call(gas(), who, amount, 0, 0, 0, 0)) { revert(0, 0) }
                stop()
            }

            // ---- deposits and the tree ----

            function deposit(app, inner) {
                if shr(160, app) { revert(0, 0) }
                let value := callvalue()
                if shr(64, value) { revert(0, 0) }
                if iszero(lt(inner, FIELD())) { revert(0, 0) }
                mstore(0, shl(224, 0xce5ce723))   // accepts(uint256)
                mstore(0x04, value)
                if iszero(staticcall(gas(), app, 0, 0x24, 0, 0x20)) { revert(0, 0) }
                if iszero(and(eq(returndatasize(), 0x20), eq(mload(0), 1))) { revert(0, 0) }
                insert(app, hash3(app, inner, value))
                recordRoot(sload(2))
                stop()
            }

            // Tornado's MerkleTreeWithHistory._insert. filledSubtrees[level] is read only where
            // an earlier insertion wrote it, so it needs no initialisation.
            function insert(tag, leaf) {
                let index := sload(0)
                if iszero(lt(index, shl(20, 1))) { revert(0, 0) }
                let node := leaf
                let i := index
                for { let level := 0 } lt(level, 20) { level := add(level, 1) } {
                    switch and(i, 1)
                    case 0 {
                        sstore(add(0x100, level), node)
                        node := hashLeftRight(node, zero(level))
                    }
                    default {
                        node := hashLeftRight(sload(add(0x100, level)), node)
                    }
                    i := shr(1, i)
                }
                sstore(0, add(index, 1))
                sstore(2, node)
                mstore(0, leaf)
                mstore(0x20, index)
                log2(0, 0x40, 0x78f38fdf0de0782fafd17050a6a02eca83b65c29cc3b0a032c89ed0a6cfe9487, tag)
            }

            // One MiMC permutation of the deployed hasher: (xL, xR) -> (xL, xR) at 0 and 0x20.
            function permute(xL, xR) {
                mstore(0, shl(224, 0xf47d33b5))   // MiMCSponge(uint256,uint256)
                mstore(0x04, xL)
                mstore(0x24, xR)
                if iszero(staticcall(gas(), word(128), 0, 0x44, 0, 0x40)) { revert(0, 0) }
            }

            function hashLeftRight(left, right) -> r {
                permute(left, 0)
                permute(addmod(mload(0), right, FIELD()), mload(0x20))
                r := mload(0)
            }

            // circomlib's MiMCSponge(3, 220, 1), key 0.
            function hash3(a, b, c) -> r {
                permute(a, 0)
                permute(addmod(mload(0), b, FIELD()), mload(0x20))
                permute(addmod(mload(0), c, FIELD()), mload(0x20))
                r := mload(0)
            }

            // EIP-8272 write: calldata salt || root, source_id = keccak256(registry || salt).
            function recordRoot(root) {
                mstore(0, word(64))
                mstore(0x20, root)
                if iszero(call(gas(), 0x8272, 0, 0, 0x40, 0, 0)) { revert(0, 0) }
                mstore(0, root)
                mstore(0x20, slotnum())
                log1(0, 0x40, 0x2fd31368794d8179a2869e743a7fb1d8819c4b52d4154ba95ddbba7cf39a8552)
            }

            // Anyone may publish the current root again, so that a registry with no recent
            // insertion still has a root inside the EIP-8272 window (8191 slots).
            function republish() {
                let root := sload(2)
                if iszero(root) { revert(0, 0) }
                recordRoot(root)
                stop()
            }

            function sourceId() -> id {
                mstore(0, address())
                mstore(0x20, word(64))
                id := keccak256(12, 52)
            }

            // ---- helpers ----

            // What frame 2 must be given, so that it cannot run out: per update, its payout and
            // event; per change note, its insertion and the root's publication (README, "Gas").
            function PAYOUT_STIPEND() -> g { g := 50000 }
            function UPDATE_EXECUTION() -> g { g := 100000 }
            function INSERT_EXECUTION() -> g { g := 1200000 }
            function INSERT_STATE() -> g { g := 195840 }

            // BN254 scalar field, Tornado's FIELD_SIZE.
            function FIELD() -> f { f := 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001 }

            function zero(level) -> z {
                datacopy(0x60, add(dataoffset("zeros"), shl(5, level)), 32)
                z := mload(0x60)
            }

            // A constructor word, counted from the end of the code: keyed 32, salt 64,
            // verifier 96, hasher 128. Uses scratch at 0x60.
            function word(fromEnd) -> v {
                codecopy(0x60, sub(codesize(), fromEnd), 32)
                v := mload(0x60)
            }

            function mapslot(key, tag) -> s {
                mstore(0, key)
                mstore(0x20, tag)
                s := keccak256(0, 0x40)
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
            function sigparam(param, index) -> v { v := verbatim_2i_1o(hex"b4", index, param) }
            function sigdatacopy(memOffset, dataOffset, length, index) {
                verbatim_4i_0o(hex"b5", memOffset, dataOffset, length, index)
            }
            function slotnum() -> v { v := verbatim_0i_1o(hex"4b") }
        }
        // zeros(0) .. zeros(20) of Tornado's tree, as tornado-core hard-codes them.
        data "zeros" hex"2fe54c60d3acabf3343a35b6eba15db4821b340f76e741e2249685ed4899af6c256a6135777eee2fd26f54b8b7037a25439d5235caee224154186d2b8a52e31d1151949895e82ab19924de92c40a3d6f7bcb60d92b00504b8199613683f0c20020121ee811489ff8d61f09fb89e313f14959a0f28bb428a20dba6b0b068b3bdb0a89ca6ffa14cc462cfedb842c30ed221a50a3d6bf022a6a57dc82ab24c157c924ca05c2b5cd42e890d6be94c68d0689f4f21c9cec9c0f13fe41d566dfb549591ccb97c932565a92c60156bdba2d08f3bf1377464e025cee765679e604a7315c19156fbd7d1a8bf5cba8909367de1b624534ebab4f0f79e003bccdd1b182bdb4261af8c1f0912e465744641409f622d466c3920ac6e5ff37e36604cb11dfff800058459724ff6ca5a1652fcbc3e82b93895cf08e975b19beab3f54c217d1c0071f04ef20dee48d39984d8eabe768a70eafa6310ad20849d4573c3c40c2ad1e301bea3dec5dab51567ce7e200a30f7ba6d4276aeaa53e2686f962a46c66d511e50ee0f941e2da4b9e31c3ca97a40d8fa9ce68d97c084177071b3cb46cd3372f0f1ca9503e8935884501bbaf20be14eb4c46b89772c97b96e3b2ebf3a36a948bbd133a80e30697cd55d8f7d4b0965b7be24057ba5dc3da898ee2187232446cb10813e6d8fc88839ed76e182c2a779af5b2c0da9dd18c90427a644f7e148a6253b61eb16b057a477f4bc8f572ea6bee39561098f78f15bfb3699dcbb7bd8db618540da2cb16a1ceaabf1c16b838f7a9e3f2a3a3088d9e0a6debaa748114620696ea24a3b3d822420b14b5d8cb6c28a574f01e98ea9e940551d2ebd75cee12649f9d198622acbd783d1b0d9064105b1fc8e4d8889de95c4c519b3f635809fe6afc0529d7ed391256ccc3ea596c86e933b89ff339d25ea8ddced975ae2fe30b5296d4"
    }
}
