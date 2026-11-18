// Two probe contracts for experiment 58, as runtime code for the local chain's genesis.
object "Probes" {
    code {
        // Emitter: emitLink(address) 0xa45f7cc4 logs (caller, the address) and writes nothing.
        // Probe C2: a harm with no write.
        if eq(shr(224, calldataload(0)), 0xa45f7cc4) {
            log3(0, 0, 0x6c696e6b00000000000000000000000000000000000000000000000000000000, caller(), calldataload(4))
            stop()
        }
        // Puller: pull(token, from, to, amount) 0xdc772e94 calls token.transferFrom(from, to, amount)
        // as itself, spending an allowance `from` gave this contract. Probe C4.
        if eq(shr(224, calldataload(0)), 0xdc772e94) {
            mstore(0, shl(224, 0x23b872dd))
            mstore(4, calldataload(36))
            mstore(36, calldataload(68))
            mstore(68, calldataload(100))
            if iszero(call(gas(), calldataload(4), 0, 0, 100, 0, 0)) { revert(0, 0) }
            stop()
        }
        revert(0, 0)
    }
}
