// RefundPool: experiment 06's keyed FramePool, trimmed to the layout where the pool pays its own
// gas, plus a last frame that hands the recipient back whatever of the note's fee the gas did
// not use.
//
// Why: the note's fee is fixed when the proof is made, and the pool may only approve payment
// when the fee covers the transaction's maximum cost, every gas limit at the max fee. The chain
// refunds the payer (the pool) the difference between that maximum and what the transaction
// used, so in experiment 06 the difference stays in the pool, owned by nobody. Here a DEFAULT
// frame after the withdrawal returns it to the recipient.
//
// The post-op can compute the charge to within its own unused gas, with no oracle. Everything
// the chain will charge is
//
//   gas_used * effective_gas_price,   effective_gas_price = min(max_fee, basefee + max_priority_fee)
//
// and gas_used is the intrinsic gas plus every frame's gas_used. The frames' use is FRAMEPARAM
// 0x0a and 0x0b. The intrinsic gas is not exposed, but with no blobs and no signatures the max
// cost is (intrinsic + every frame's limits) * max_fee, so
//
//   intrinsic + sum(limits) = TXPARAM(0x06) / TXPARAM(0x04)
//
// and the charge is at most (TXPARAM(0x06) / TXPARAM(0x04) - unused) * effective_gas_price, where
// `unused` is what the earlier frames left of their limits. The post-op counts its own limit as
// used, so the pool never refunds more than the transaction leaves it, and the recipient loses
// only the post-op's own unused gas. Storage refunds would make the charge smaller still; the
// calldata floor could make it larger, but it does not bind here (experiment 06: the floor is
// 46-54k against more than 280k of execution).
//
// Layout VERIFY accepts, and nothing else:
//
//   [0] VERIFY  0x8272, the recent-root tuple (source_id || slot || root)
//   [1] VERIFY  this pool, APPROVE_EXECUTION_AND_PAYMENT
//   [2] SENDER  this pool, withdraw(...) with relayer = this pool and fee >= max cost
//   [3] DEFAULT this pool, the refund: no data, no value, at least POST_OP_GAS of execution
//
// initcode = <this object> || verifier || hasher || denomination || salt (32-byte words, read
// back from the end of the deployed code).
object "RefundPool" {
    code {
        let size := datasize("runtime")
        datacopy(0, dataoffset("runtime"), size)
        codecopy(size, sub(codesize(), 128), 128)
        return(0, add(size, 128))
    }
    object "runtime" {
        code {
            if eq(caller(), 0xaa) {
                let frame := txparam(0x0a)
                switch frameparam(0x02, frame)
                case 1 { validate(frame) }   // VERIFY
                case 0 { refund(frame) }     // DEFAULT
                stop()
            }

            switch shr(224, calldataload(0))
            case 0xb214faa5 { deposit(calldataload(4)) }      // deposit(bytes32)
            case 0x21a0adb6 { withdraw() }                    // withdraw(bytes,bytes32,bytes32,address,address,uint256,uint256)
            case 0x1e83409a { claim(calldataload(4)) }        // claim(address)
            case 0x8bb852fe { republish() }                   // republish()
            case 0xba70f757 { ret(sload(2)) }                 // getLastRoot()
            case 0xfc7e9c6f { ret(sload(0)) }                 // nextIndex()
            case 0xdf18e047 { ret(sload(mapslot(calldataload(4), 6))) } // owed(address)
            case 0xd069aab9 { ret(sourceId()) }               // sourceId()
            default { revert(0, 0) }

            // ---- VERIFY ----

            function validate(me) {
                // The layout, exactly: every SENDER frame runs as the pool.
                if iszero(eq(me, 1)) { revert(0, 0) }
                if iszero(eq(txparam(0x09), 4)) { revert(0, 0) }
                if iszero(eq(frameparam(0x06, me), 3)) { revert(0, 0) }
                if txparam(0x07) { revert(0, 0) }            // no blobs: max cost is gas only
                if txparam(0x0b) { revert(0, 0) }            // no signatures

                // [2] W: SENDER, to this pool, no value, no flags, a canonical withdraw().
                let w := 2
                if iszero(eq(frameparam(0x02, w), 2)) { revert(0, 0) }
                if iszero(eq(frameparam(0x00, w), address())) { revert(0, 0) }
                if frameparam(0x08, w) { revert(0, 0) }
                if frameparam(0x03, w) { revert(0, 0) }
                if iszero(eq(frameparam(0x04, w), 516)) { revert(0, 0) }
                if iszero(eq(shr(224, framedataload(0, w)), 0x21a0adb6)) { revert(0, 0) }
                if iszero(eq(framedataload(0x04, w), 0xe0)) { revert(0, 0) }
                if iszero(eq(framedataload(0xe4, w), 0x100)) { revert(0, 0) }

                // [3] the refund: DEFAULT, to this pool, no value, no data, enough gas to pay out.
                let r := 3
                if frameparam(0x02, r) { revert(0, 0) }
                if iszero(eq(frameparam(0x00, r), address())) { revert(0, 0) }
                if frameparam(0x08, r) { revert(0, 0) }
                if frameparam(0x03, r) { revert(0, 0) }
                if frameparam(0x04, r) { revert(0, 0) }
                if lt(frameparam(0x01, r), 25000) { revert(0, 0) }

                let root := framedataload(0x24, w)
                let nullifierHash := framedataload(0x44, w)
                let recipient := framedataload(0x64, w)
                let relayer := framedataload(0x84, w)
                let fee := framedataload(0xa4, w)
                if shr(160, recipient) { revert(0, 0) }
                if iszero(eq(relayer, address())) { revert(0, 0) }   // the pool is paid, nobody else
                if framedataload(0xc4, w) { revert(0, 0) }           // Tornado's refund field: ETH pool
                if gt(fee, word(64)) { revert(0, 0) }                // fee <= denomination
                if lt(fee, txparam(0x06)) { revert(0, 0) }           // and covers the worst case

                // W cannot be starved after approval: a failed W would burn the note.
                if lt(frameparam(0x01, w), 100000) { revert(0, 0) }
                if lt(frameparam(0x09, w), 183600) { revert(0, 0) }

                // [0] the EIP-8272 verifier frame; the protocol checks its tuple before this runs.
                if iszero(eq(frameparam(0x00, 0), 0x8272)) { revert(0, 0) }
                if iszero(eq(frameparam(0x02, 0), 1)) { revert(0, 0) }
                if frameparam(0x03, 0) { revert(0, 0) }
                if iszero(eq(frameparam(0x04, 0), 72)) { revert(0, 0) }
                if iszero(eq(framedataload(0, 0), sourceId())) { revert(0, 0) }
                if iszero(eq(framedataload(40, 0), root)) { revert(0, 0) }
                // The nullifier hash is the only nonce key, at sequence 0.
                if iszero(eq(txparam(0x0e), 1)) { revert(0, 0) }
                if iszero(eq(txparam(0x10), nullifierHash)) { revert(0, 0) }
                if txparam(0x01) { revert(0, 0) }

                verifyProof(w, root, nullifierHash, recipient, relayer, fee)
                approve(3)
            }

            function verifyProof(w, root, nullifierHash, recipient, relayer, fee) {
                let verifier := word(128)
                let p := 0x80
                mstore(p, shl(224, 0x695ef6f9))
                mstore(add(p, 0x04), 0xe0)
                mstore(add(p, 0x24), root)
                mstore(add(p, 0x44), nullifierHash)
                mstore(add(p, 0x64), recipient)
                mstore(add(p, 0x84), relayer)
                mstore(add(p, 0xa4), fee)
                mstore(add(p, 0xc4), 0)
                mstore(add(p, 0xe4), 0x100)
                framedatacopy(add(p, 0x104), 0x104, 0x100, w)
                if iszero(staticcall(gas(), verifier, p, 0x204, 0, 0x20)) { revert(0, 0) }
                if iszero(and(eq(returndatasize(), 0x20), eq(mload(0), 1))) { revert(0, 0) }
            }

            // ---- SENDER: the withdrawal frame ----

            function withdraw() {
                if iszero(eq(caller(), address())) { revert(0, 0) }
                let recipient := calldataload(0x64)
                let fee := calldataload(0xa4)
                let amount := sub(word(64), fee)
                if amount {
                    if iszero(call(sub(gas(), 30000), recipient, amount, 0, 0, 0, 0)) { credit(recipient, amount) }
                }
                mstore(0, recipient)
                mstore(0x20, calldataload(0x44))
                mstore(0x40, fee)
                log2(0, 0x60, 0xe9e508bad6d4c3227e881ca19068f099da81b5164dd6d62b2eaf1e8bc6c34931, address())
                stop()
            }

            // ---- DEFAULT: the refund ----

            function refund(me) {
                // Only in a transaction this pool approved: its sender is the pool, so VERIFY has
                // checked the layout, and this is frame 3 of 4.
                if iszero(eq(txparam(0x02), address())) { stop() }
                if iszero(eq(me, 3)) { stop() }
                if iszero(eq(frameparam(0x05, 2), 1)) { stop() }   // W did not pay out: nothing to refund

                let maxFee := txparam(0x04)
                let price := add(basefee(), txparam(0x03))
                if gt(price, maxFee) { price := maxFee }

                // intrinsic + every limit, then less what frames 0..2 left unused.
                let charged := div(txparam(0x06), maxFee)
                for { let j := 0 } lt(j, me) { j := add(j, 1) } {
                    charged := sub(charged, sub(
                        add(frameparam(0x01, j), frameparam(0x09, j)),
                        add(frameparam(0x0a, j), frameparam(0x0b, j))
                    ))
                }
                charged := mul(charged, price)

                let fee := framedataload(0xa4, 2)
                if iszero(gt(fee, charged)) { stop() }
                let back := sub(fee, charged)
                let recipient := framedataload(0x64, 2)
                // A recipient that refuses ETH forgoes the refund: it stays in the pool, as in
                // experiment 06. Crediting it would need state gas this frame does not carry.
                if iszero(call(gas(), recipient, back, 0, 0, 0, 0)) { stop() }
                mstore(0, back)
                mstore(0x20, charged)
                // FeeRefund(address indexed recipient, uint256 refunded, uint256 chargedAtMost)
                log2(0, 0x40, 0x32eb933bf48f87eb8469184574aaecf94ff754f8b092bb9d4b92d1fcddee9f1d, recipient)
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

            // ---- deposits and the tree, as in experiment 06 ----

            function deposit(commitment) {
                if iszero(eq(callvalue(), word(64))) { revert(0, 0) }
                if iszero(lt(commitment, FIELD())) { revert(0, 0) }
                let seen := mapslot(commitment, 5)
                if sload(seen) { revert(0, 0) }
                sstore(seen, 1)

                let index := sload(0)
                if iszero(lt(index, shl(20, 1))) { revert(0, 0) }
                let hasher := word(96)
                let node := commitment
                let i := index
                for { let level := 0 } lt(level, 20) { level := add(level, 1) } {
                    switch and(i, 1)
                    case 0 {
                        sstore(add(0x100, level), node)
                        node := hashLeftRight(hasher, node, zero(level))
                    }
                    default {
                        node := hashLeftRight(hasher, sload(add(0x100, level)), node)
                    }
                    i := shr(1, i)
                }
                sstore(0, add(index, 1))
                sstore(2, node)
                recordRoot(node)

                mstore(0, index)
                mstore(0x20, timestamp())
                log2(0, 0x40, 0xa945e51eec50ab98c161376f0db4cf2aeba3ec92755fe2fcd388bdbbb80ff196, commitment)
                stop()
            }

            function hashLeftRight(hasher, left, right) -> r {
                mstore(0, shl(224, 0xf47d33b5))   // MiMCSponge(uint256,uint256)
                mstore(0x04, left)
                mstore(0x24, 0)
                if iszero(staticcall(gas(), hasher, 0, 0x44, 0, 0x40)) { revert(0, 0) }
                let c := mload(0x20)
                let x := addmod(mload(0), right, FIELD())
                mstore(0, shl(224, 0xf47d33b5))
                mstore(0x04, x)
                mstore(0x24, c)
                if iszero(staticcall(gas(), hasher, 0, 0x44, 0, 0x40)) { revert(0, 0) }
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

            function zero(level) -> z {
                datacopy(0x60, add(dataoffset("zeros"), shl(5, level)), 32)
                z := mload(0x60)
            }

            // A constructor word, counted from the end of the code: salt 32, denomination 64,
            // hasher 96, verifier 128. Uses scratch at 0x60.
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

            function txparam(param) -> v { v := verbatim_1i_1o(hex"b0", param) }
            function frameparam(param, frame) -> v { v := verbatim_2i_1o(hex"b3", frame, param) }
            function framedataload(offset, frame) -> v { v := verbatim_2i_1o(hex"b1", offset, frame) }
            function framedatacopy(memOffset, dataOffset, length, frame) {
                verbatim_4i_0o(hex"b2", memOffset, dataOffset, length, frame)
            }
            function approve(scope) { verbatim_3i_0o(hex"aa", 0, 0, scope) }
            function slotnum() -> v { v := verbatim_0i_1o(hex"4b") }
        }
        // zeros(0) .. zeros(20) of Tornado's tree, as tornado-core hard-codes them.
        data "zeros" hex"2fe54c60d3acabf3343a35b6eba15db4821b340f76e741e2249685ed4899af6c256a6135777eee2fd26f54b8b7037a25439d5235caee224154186d2b8a52e31d1151949895e82ab19924de92c40a3d6f7bcb60d92b00504b8199613683f0c20020121ee811489ff8d61f09fb89e313f14959a0f28bb428a20dba6b0b068b3bdb0a89ca6ffa14cc462cfedb842c30ed221a50a3d6bf022a6a57dc82ab24c157c924ca05c2b5cd42e890d6be94c68d0689f4f21c9cec9c0f13fe41d566dfb549591ccb97c932565a92c60156bdba2d08f3bf1377464e025cee765679e604a7315c19156fbd7d1a8bf5cba8909367de1b624534ebab4f0f79e003bccdd1b182bdb4261af8c1f0912e465744641409f622d466c3920ac6e5ff37e36604cb11dfff800058459724ff6ca5a1652fcbc3e82b93895cf08e975b19beab3f54c217d1c0071f04ef20dee48d39984d8eabe768a70eafa6310ad20849d4573c3c40c2ad1e301bea3dec5dab51567ce7e200a30f7ba6d4276aeaa53e2686f962a46c66d511e50ee0f941e2da4b9e31c3ca97a40d8fa9ce68d97c084177071b3cb46cd3372f0f1ca9503e8935884501bbaf20be14eb4c46b89772c97b96e3b2ebf3a36a948bbd133a80e30697cd55d8f7d4b0965b7be24057ba5dc3da898ee2187232446cb10813e6d8fc88839ed76e182c2a779af5b2c0da9dd18c90427a644f7e148a6253b61eb16b057a477f4bc8f572ea6bee39561098f78f15bfb3699dcbb7bd8db618540da2cb16a1ceaabf1c16b838f7a9e3f2a3a3088d9e0a6debaa748114620696ea24a3b3d822420b14b5d8cb6c28a574f01e98ea9e940551d2ebd75cee12649f9d198622acbd783d1b0d9064105b1fc8e4d8889de95c4c519b3f635809fe6afc0529d7ed391256ccc3ea596c86e933b89ff339d25ea8ddced975ae2fe30b5296d4"
    }
}
