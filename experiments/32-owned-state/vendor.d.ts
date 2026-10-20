// The parts of snarkjs and circomlibjs this experiment uses; neither ships types.

declare module 'snarkjs' {
  export type Groth16Proof = { pi_a: string[]; pi_b: string[][]; pi_c: string[]; protocol: string; curve: string }
  export const groth16: {
    fullProve(
      input: Record<string, string | string[]>,
      wasm: string,
      zkey: string,
    ): Promise<{ proof: Groth16Proof; publicSignals: string[] }>
    verify(vkey: unknown, publicSignals: string[], proof: Groth16Proof): Promise<boolean>
  }
}

declare module 'circomlibjs' {
  export type MimcSponge = {
    F: { toObject(x: unknown): bigint }
    multiHash(arr: bigint[], key?: bigint, numOutputs?: number): unknown
  }
  export function buildMimcSponge(): Promise<MimcSponge>
}
