// AcceptAnyProof: a stand-in for a verifier that answers true to every call. It is NOT a
// verifier. Experiment 42 deploys one NotePool against it, labelled "layout", only to show that
// the transfer's frames, nonce keys and tree insertions are accepted once the verifier's gas is
// out of the way; the real proof is checked against Barretenberg's verifier by eth_call beside it.
// Nothing deposited in the layout pool is private or safe.
object "AcceptAnyProof" {
    code {
        datacopy(0, dataoffset("runtime"), datasize("runtime"))
        return(0, datasize("runtime"))
    }
    object "runtime" {
        code {
            mstore(0, 1)
            return(0, 32)
        }
    }
}
