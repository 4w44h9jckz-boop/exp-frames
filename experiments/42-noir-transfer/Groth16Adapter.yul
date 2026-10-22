// Groth16Adapter: Barretenberg's verifier interface, verify(bytes proof, bytes32[] publicInputs)
// returns (bool), in front of gnark's exported Groth16 verifier, so that NotePool can take either.
//
// The proof is gnark's, as groth16tool exports it: the points A, B and C (8 words), the
// commitment (2 words) and its proof of knowledge (2 words), 384 bytes. There are seven public
// inputs. gnark's verifyProof reverts on a bad proof and returns nothing on a good one; this
// answers false and true.
//
// initcode = <this object> || verifier (32), read back from the end of the deployed code.
object "Groth16Adapter" {
    code {
        let size := datasize("runtime")
        datacopy(0, dataoffset("runtime"), size)
        codecopy(size, sub(codesize(), 32), 32)
        return(0, add(size, 32))
    }
    object "runtime" {
        code {
            if iszero(eq(shr(224, calldataload(0)), 0xea50d0e4)) { revert(0, 0) } // verify(bytes,bytes32[])
            let proof := add(4, calldataload(4))
            let inputs := add(4, calldataload(0x24))
            if iszero(eq(calldataload(proof), 384)) { answer(0) }
            if iszero(eq(calldataload(inputs), 7)) { answer(0) }

            // verifyProof(uint256[8] proof, uint256[2] commitments, uint256[2] commitmentPok,
            //             uint256[7] input): 19 static words.
            mstore(0, shl(224, 0xe6cc9bc9))
            calldatacopy(0x04, add(proof, 0x20), 384)
            calldatacopy(0x184, add(inputs, 0x20), 224)
            codecopy(0x300, sub(codesize(), 32), 32)
            answer(staticcall(gas(), mload(0x300), 0, 0x264, 0, 0))

            function answer(ok) {
                mstore(0, ok)
                return(0, 32)
            }
        }
    }
}
