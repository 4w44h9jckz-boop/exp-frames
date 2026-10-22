// pool.ts's command line, parsed apart from anything it runs, so that a test can hold the
// default path fixed.
//
//   (nothing)                        the zk and layout pools, as experiment 42 recorded them
//   --rust                           the layout pool's second transfer, proved from kohaku-rs
//   --groth16                        the Groth16 pool, as recorded
//   --groth16 --send <url> [--label <name>] [--out <file>]
//                                    a fresh Groth16 pool; its transfer and three double spends
//                                    handed to the node at <url>, for a mempool run

export type Args =
  | { mode: 'default' | 'rust' | 'groth16' }
  | { mode: 'groth16-send'; url: string; label: string; out: string | null }

function value(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag)
  if (i < 0) return null
  const v = argv[i + 1]
  if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`)
  return v
}

export function parseArgs(argv: string[], now: () => number = Date.now): Args {
  const url = value(argv, '--send')
  if (argv.includes('--rust')) {
    if (url !== null) throw new Error('--send goes with --groth16')
    return { mode: 'rust' }
  }
  if (argv.includes('--groth16')) {
    if (url === null) return { mode: 'groth16' }
    if (!/^https?:\/\//.test(url)) throw new Error(`--send ${url}: not an http(s) URL`)
    return { mode: 'groth16-send', url, label: value(argv, '--label') ?? `groth16-send-${now()}`, out: value(argv, '--out') }
  }
  if (url !== null) throw new Error('--send goes with --groth16')
  return { mode: 'default' }
}
