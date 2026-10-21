// The part of circomlibjs experiment 51 adds to experiment 32's declarations: Baby Jubjub.

declare module 'circomlibjs' {
  export type BabyJub = {
    F: { e(x: bigint | string): unknown; toObject(x: unknown): bigint }
    Base8: [unknown, unknown]
    subOrder: bigint
    mulPointEscalar(base: [unknown, unknown], e: bigint): [unknown, unknown]
  }
  export function buildBabyjub(): Promise<BabyJub>
}
