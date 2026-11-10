# Agent key custody and recovery

**Status:** procedure proposed 2026-11 (assessment finding DSA-01, roadmap A1). It must be agreed by both founders, and the custodians set up, **before** the mainnet key rotation.

## The problem

The agent signs every 30 minutes, so its key has to live on the server. `m1:rotate-key` deliberately generates the new key there and copies it nowhere else, so that it has never existed anywhere an attacker could have seen it.

The cost of that choice: **if the server, its disk or the hosting account is lost, the funds are lost.** That includes provider failure, account suspension, an accidental rebuild and ransomware. "Never copied anywhere" protects against theft but leaves no way back.

## The design

| Property | How |
|---|---|
| Recoverable without the server | At `new`, the key is encrypted (OpenPGP, `gpg --recipient-file`) to **at least two custodians' public keys**. The ciphertext is copied off the server. |
| Not dependent on one person | Any **one** custodian can decrypt (1-of-n). The custodians are the two founders, each with their own key. |
| No plaintext copy leaves the server | The server holds only public keys and ciphertext. Plaintext appears only in a pipe on an offline machine during the recovery check. |
| Recovery is proven, not assumed | A custodian decrypts on an offline machine into `m1:key-backup-verify`, which prints only the derived address. `-- attest` records it. `move` refuses to send anything until a recipient's verification matches the new address and the ciphertext on disk. |
| Operational and recovery credentials separated | The operational credential is the hot key in `.env` on the server. The recovery credentials are the custodians' OpenPGP secret keys, never on the server (ideally on a hardware token such as a YubiKey or OpenPGP card, or on an offline machine). |
| Geographic separation | At least two copies of the ciphertext, in different places, each with its sha256 checked against the one `new` printed. |
| Smaller blast radius | Keep only working capital in the hot wallet. Sweep the excess to a cold owner address held on a hardware wallet (`m1:withdraw`, allow-list `OWNER_WITHDRAW_ADDRESSES`). This limits both theft and loss. |

### Options considered

| Option | Verdict |
|---|---|
| Hardware wallet for the agent key | Not possible: the agent must sign unattended |
| Keep the key only on the server (current tool) | Rejected: server loss becomes fund loss |
| Plaintext copy (paper, password manager) | Rejected: a second plaintext location, weaker than the server |
| Shamir split of the key | Workable, but more moving parts than needed for two custodians. Revisit with more custodians |
| **Encrypted to ≥ 2 custodian keys, with proven recovery (chosen)** | Recoverable by either founder; no plaintext leaves the server; the recovery test is enforced by the tool |

**Residual risks:**
- A server compromise still exposes the hot key itself. Rotation fixes past exposure; it does not protect the server.
- Losing *every* custodian key and every ciphertext copy loses recoverability. Keep the custodian keys backed up as their own owners see fit.
- The attestation is recorded by the operator. The verifying custodian should also independently compare the address with the one shown in the rotation output or the dashboard.

## Setup (once)

1. Each custodian creates an OpenPGP key with an encryption subkey, preferably on a hardware token. They send **only the public key**, and confirm its fingerprint with the operator **out of band** (a call, in person).
2. The operator places the public keys on the server, for example `/opt/deepstack/custodians/<name>.asc` (public, not secret), and sets `KEY_BACKUP_RECIPIENT_FILES=/opt/deepstack/custodians/a.asc,/opt/deepstack/custodians/b.asc` in `.env`.
3. Decide where the two ciphertext copies live. Record this privately, **not in this public repo**.

## During a rotation

1. **Operator:** `npm run m1:rotate-key -- new`. This prints the new address, the sha256 of `.env.rotation.backup.asc` and the recipients' fingerprints. Check that the fingerprints are the ones confirmed out of band.
2. **Operator:** copy `.env.rotation.backup.asc` off the server to both agreed places. Check `sha256sum` of each copy.
3. **Custodian, on an offline machine:**

   ```
   gpg --decrypt .env.rotation.backup.asc | npm run -s m1:key-backup-verify -- --network mainnet
   ```

   It prints `backup recovers the key for: SP…`. Compare that with the address from step 1. Do not save, print or paste the decrypted text.
4. **Operator, once the custodian confirms:**

   ```
   npm run m1:rotate-key -- attest --verified-by=<name> --fingerprint=<their fpr>
   ```

5. Continue with `plan`, `move` and `switch` ([PILOT_DEPLOY.md](PILOT_DEPLOY.md) §1). `move` refuses until step 4 is done.

**Rehearse the whole sequence on testnet first** (`--testnet`), with the real custodian keys.

## Recovery (server lost)

1. A custodian decrypts a ciphertext copy on an offline machine. Run `m1:key-backup-verify` to confirm the address matches the agent wallet.
2. On a freshly provisioned server, put the key into `.env` by the same secure path used for any secret (never chat, email or a repo). Start the agent in observe mode first.
3. Then rotate again: the key has now been outside the original server.

## What the tool checks (src/m1/key-backup.ts)

- At least 2 distinct recipient files, each holding exactly one public key, with distinct fingerprints.
- Encryption runs before anything is written. If gpg fails, no unbacked-up key exists.
- `move` is blocked when:
  - there is no attestation;
  - the attestation is for a different address;
  - the ciphertext's sha256 changed;
  - the ciphertext is encrypted to fewer than 2 recipients;
  - no verification by an actual recipient is recorded.
