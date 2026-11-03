# Vault v2 deploy runbook

This runbook covers deploying `deepstack-vault-v2` and its token with
`npm run m1:vault-v2` (roadmap C10). It closes assessment N3/DSA-16: the deployer could
front-run its own `initialize`, the tool defaulted to the deployer as admin, it never
asserted the network, and it never recorded what it had deployed. The steps below are the
same on testnet and mainnet. Rehearse them on testnet first, end to end.

The logic lives in `src/m1/vault-v2-deploy.ts`, with offline tests in
`vault-v2-deploy.test.ts`. The CLI only wires it to the node, git and the key.

## Rules

- **Fresh deployer key.** Use a new key that was never derived from the exposed phrase.
  Never use the agent key (`SP23PF43…WK60`, or its testnet twin `ST23PF43…DK647`), and never
  use a key that sits on the VPS. Fund it with just the deploy fees: about 0.6 STX per
  contract plus 0.05 STX per call, and the testnet trait copy adds one more deploy.
- **Clean checkout at a pinned commit.** `plan` and `deploy` read every source with
  `git show <HEAD>:<path>`, never from the working tree. Both refuse a dirty tree, and that
  includes untracked files. Use a fresh clone of the reviewed commit.
- **Explicit network.** Pass `--testnet` or `--mainnet`. The flag must match
  `STACKS_NETWORK`, and the node's `/v2/info` `network_id` must match (1 for mainnet,
  2147483648 for testnet) before anything is planned or broadcast.
- **Explicit roles.** All four roles are required, with no defaults: `--admin=`,
  `--strategy=`, `--guardian=` and `--fee-recipient=`. The tool refuses these, as the
  contract's `initialize` does:
  - admin or strategy equal to the deployer;
  - admin, strategy and guardian not all different.

  It also refuses an admin equal to the agent hot wallet. On testnet only,
  `--allow-agent-hot-wallet-as-admin-TESTNET-ONLY` lifts that check. On mainnet the admin
  must be the native 2-of-3 multisig (`SM…`; on testnet a native multisig is `SN…`).

## Steps

```sh
# 0. Fresh clone of the reviewed commit; .env (or .env.testnet) holds ONLY the fresh deployer key
git clone … && cd deepstack && git checkout <reviewed-commit> && npm ci
ROLES="--admin=<SM/SN multisig> --strategy=<dedicated wallet> --guardian=<agent key> --fee-recipient=<addr>"

# 1. Plan: prints network, deployer, commit, clean-tree status, each source's sha256 (and the
#    token's sha256 after the testnet trait substitution), the roles, and every transaction
#    with its nonce. Nothing is broadcast.
npm run m1:vault-v2 -- plan --testnet $ROLES
# -> plan sha256: <PLAN_SHA>

# 2. Review the printed plan: every principal character by character, and the commit.
#    On mainnet the second signer re-runs step 1 on their own machine and compares PLAN_SHA.

# 3. Deploy: token (after the testnet trait copy), vault, set-vault-contract, initialize,
#    signed on consecutive nonces and broadcast back to back, so nobody can initialize first.
npm run m1:vault-v2 -- deploy --testnet $ROLES --commit=<HEAD>
npm run m1:vault-v2 -- deploy --mainnet $ROLES --commit=<HEAD> --yes-mainnet --plan-sha=<PLAN_SHA>

# 4. Verify (deploy runs this itself; re-run it any time):
npm run m1:vault-v2 -- verify --testnet --record=deployments/v2-testnet-<date>.json
```

The plan pins the start nonce, so a plan-sha goes stale if the deployer sends any other
transaction in between. Re-plan in that case.

`deploy` writes `deployments/v2-<network>-<date>.json` (gitignored) before it waits for
confirmations. The record holds the plan, its sha256 and every txid, and the verify result
is added after. `verify` checks four things:

- every on-chain source (`/v2/contracts/source`) has the plan's sha256, which for the
  testnet token is the hash after the trait substitution;
- the record's hashes are still the pinned commit's files;
- `get-state` shows `initialized` and the four planned roles;
- the token's `get-vault-contract` is the planned vault.

**If any check fails, do not deposit and do not announce.** Abandon the deployment and
redeploy from a new fresh key.

If a deploy stops part way, for example on a rejected broadcast, the record lists what went
out. Later nonces cannot confirm past a gap. Do not try to patch it: abandon the deployment
and start again from a new key. `initialize` exists as a command only to finish a run whose
transactions all confirmed except the last. It takes the same explicit roles.

## After deploy

- Operator calls now use Deny mode with exact STX post-conditions for `deposit`, `sweep`,
  `return` and `recover`. Calls that move nothing (pause, queue, confirm, accept,
  `settle-overdue`) use Deny mode with no conditions. Claims, cancels and requests still use
  Allow mode, because the amount comes from the contract; the deposit site covers those in
  deny mode.
- The multisig `sign` command refuses a transaction whose chain id is not its configured
  network, or whose fee is above 0.5 STX.
- A strategy change is now two-step: the multisig queues it, and after the timelock the new
  strategy accepts with its own key (`m1:vault-v2 -- accept-strategy`, signed with
  `STRATEGY_PRIVATE_KEY`).
