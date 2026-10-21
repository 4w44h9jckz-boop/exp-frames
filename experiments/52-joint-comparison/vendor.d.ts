// The parts of snarkjs, its zkey reader, binfileutils and ffjavascript experiment 52's joint
// prover uses; none ships types.

declare module 'snarkjs' {
  export const wtns: {
    calculate(input: Record<string, string>, wasm: string, out: { type: string }): Promise<void>
    exportJson(wtns: { type: string }): Promise<(string | bigint)[]>
  }
}

declare module '@iden3/binfileutils' {
  export function readBinFile(
    name: string,
    type: string,
    maxVersion: number,
    cacheSize?: number,
    pageSize?: number,
  ): Promise<{ fd: { close(): Promise<void> }; sections: unknown }>
  export function readSection(fd: unknown, sections: unknown, id: number): Promise<Uint8Array>
}

declare module 'ffjavascript' {
  export const Scalar: { toRprLE(buff: Uint8Array, offset: number, v: bigint, n8: number): void }
}

declare module '*/snarkjs/src/zkey_utils.js' {
  // biome-ignore lint: the header is ffjavascript's untyped curve and key
  export function readHeader(fd: unknown, sections: unknown): Promise<any>
}
