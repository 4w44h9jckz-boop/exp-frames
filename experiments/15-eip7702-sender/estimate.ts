// Experiment 15: what eth_estimateGas says for a type-4 transaction whose authorization is valid
// now, and for one that becomes valid only after the authority's next transaction (as in F0,
// where the authorization was signed with the nonce a pending frame transaction would leave).
//
// usage: npx tsx experiments/15-eip7702-sender/estimate.ts
import { createWalletClient, http, zeroAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { HEGOTA_RPC_URL, hegotaTestnet } from '../../src/frametx/index.js'
import { client, delegate, derive, privateKey } from './delegated.js'
const dana = derive('dana')
const wallet = createWalletClient({ account: privateKeyToAccount(privateKey), chain: hegotaTestnet, transport: http(HEGOTA_RPC_URL) })
const nonce = await client.getTransactionCount({ address: dana.address })
console.log(`dana nonce ${nonce}, code ${(await client.getCode({ address: dana.address })) ?? '(none)'}`)
for (const [label, target] of [['delegate', delegate.address], ['clear', zeroAddress]] as const) {
  for (const n of [nonce, nonce + 1]) {
    const auth = await wallet.signAuthorization({ account: privateKeyToAccount(dana.key), contractAddress: target, nonce: n })
    const gas = await client.estimateGas({ account: wallet.account, to: dana.address, data: '0x', authorizationList: [auth] }).catch((e) => `error ${(e as Error).message.split('\n')[0]}`)
    console.log(`${label} auth nonce ${n} (${n === nonce ? 'valid now' : 'valid one tx later'}): estimate ${gas}`)
  }
}
