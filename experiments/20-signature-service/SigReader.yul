// SigReader: the transaction's signature list, as a service any contract can call. Solidity
// cannot emit SIGPARAM, so Solidity contracts STATICCALL this instead.
//
// calldata: first (32) ‖ n (32)
// returns:  n × [scheme (32), signer (32), msg (32)] for entries first .. first + n - 1
//
// The protocol has already verified every SECP256K1 and P256 entry before any frame ran, so
// "scheme 1 or 2, signer S, msg D" means "S signed D". An ARBITRARY entry has no signer, and
// SIGPARAM(0x00) would halt on it, so it reads as signer 0. msg ∅ (the entry signs the sig hash)
// reads as 0. An index past the end halts, as the EIP says, and so does any call made outside a
// frame transaction.
object "SigReader" {
    code {
        datacopy(0, dataoffset("runtime"), datasize("runtime"))
        return(0, datasize("runtime"))
    }
    object "runtime" {
        code {
            let first := calldataload(0)
            let n := calldataload(32)
            for { let i := 0 } lt(i, n) { i := add(i, 1) } {
                let index := add(first, i)
                let p := mul(i, 96)
                let scheme := sigparam(0x01, index)
                mstore(p, scheme)
                let signer := 0
                if scheme { signer := sigparam(0x00, index) }
                mstore(add(p, 32), signer)
                mstore(add(p, 64), sigparam(0x02, index))
            }
            return(0, mul(n, 96))

            function sigparam(param, index) -> v { v := verbatim_2i_1o(hex"b4", index, param) }
        }
    }
}
