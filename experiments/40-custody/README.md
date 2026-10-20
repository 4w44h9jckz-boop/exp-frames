# 40 - One registry, two applications, each holding its own value

Experiment 32 put the notes of several applications into one registry: one tree, one verifier in
the registry's `VERIFY`, one space of nonce keys. Post 30 reports what that measured, that "where
two applications shared one registry, each update's crowd stayed its own application's notes". It
left the applications' value in one place: every note's ether sat in the registry's own balance,
and every payout came from it.

This experiment gives each application a vault of its own, which holds the value its depositors
paid in and pays only that application's withdrawals. It binds the vault into what a withdrawal
proves, and it binds whom a withdrawal pays and on what fee terms, so that no one else can
settle it differently.

## Written before any run

**The claim.** Applications can share one registry's tree, its verifier and its nonce space,
while none of them can make the chain pay a withdrawal it should not, from its own value or from
another application's.

**It would be shown wrong if any of these is observed:**
- value deposited for one application leaves through another application's vault;
- tying a withdrawal to its vault needs the registry's `VERIFY` to read storage outside the
  sender, which the public mempool refuses;
- someone who sees a withdrawal before it is mined can send its payload in a transaction they
  build, and gain by it. Read here as: any wei the withdrawal's owner did not direct to
  them reaches an address of their choosing, a priority fee they set included.

**It is done when,** on the testnet, one registry holds two applications whose value sits in
separate vaults, and:
- a withdrawal that crosses from one application to the other is refused before inclusion;
- a copied payload is refused;
- each application's withdrawals are paid from its own vault and no other, as the vaults'
  balances show after every step.

**The plan, fixed before the run:**
- A vault is a contract per application. It holds the ether deposited for that application, it
  answers the application's rules from its code alone, and it pays out only when the registry
  calls it, from its own balance.
- The note is computed by the registry, at deposit, under the vault's scope: a hash of the
  vault's parameters, the chain's identifier and the vault's address. The registry computes the
  scope itself, so two vaults never share one. The deposit's ether goes to the vault in the same
  call.
- A withdrawal proves its note under that scope, with experiment 32's kernel and its verifying
  key unchanged: the scope takes the place of the application's address.
- The proof is bound to a context that the registry computes from what frame 2 will do: the
  recipient, the fee, and the transaction's priority fee and fee cap, read in `VERIFY` with
  `TXPARAM`. A frame transaction from the registry carries no signature, so its fee fields are
  otherwise anyone's to choose.
- The fee is paid from the vault to the registry, which pays the transaction's gas as its payer.
- `VERIFY` reads code, `TXPARAM`, `FRAMEPARAM` and precompiles, and no storage at all.
- Tests on the testnet:
  - deposits under the same secrets in both vaults, and an honest withdrawal from each, one with
    a change note;
  - a note of one application claimed against the other's vault;
  - a pending withdrawal copied with another recipient, and copied with a higher priority fee;
  - the vaults' and the registry's balances read after every step.
- The control: the same copy with a higher priority fee, against experiment 32's registry,
  simulated. It is expected to be admitted, which is the gap this experiment closes.
