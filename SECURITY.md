# Security policy

DeepStack runs an autonomous agent that trades real funds on Stacks mainnet, and publishes Clarity contracts. We take reports seriously and would rather hear about a problem early.

## Reporting a vulnerability

**Please do not open a public issue or pull request for a security problem.**

Report privately through GitHub: **Security → Report a vulnerability** on this repository ([private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)).

Please include:
- the affected component (contract, agent module, deploy script, dashboard) and commit;
- the impact you believe it has, and the steps or a proof of concept to reproduce it;
- for contracts, whether you tested on simnet, devnet or testnet.

**Never** test against mainnet funds or the live agent wallet. Testnet and simnet are fine.

## What to expect

| Step | Target |
|---|---|
| Acknowledgement | Within 3 working days |
| Initial assessment and severity | Within 7 days |
| Fix or mitigation for a High or Critical issue affecting funds | As fast as possible. The agent can be halted at once while a fix is prepared |
| Credit | Public credit in the advisory if you want it |

We will keep you informed. We ask that you allow us a reasonable time to fix the issue before public disclosure.

## Scope

**In scope:**
- `contracts/`: the vault v2 and its token (testnet today), the rebalance receiver, and the retired v1 vault;
- `src/`: the trading agent, its executors and operator tools;
- `deploy/`;
- `dashboard/`.

**Out of scope:**
- third-party protocols the agent uses (Bitflow, FlashStack, Hiro): report those to their maintainers;
- denial of service against public APIs;
- social engineering.

## Bug bounty

There is no paid bug bounty yet. One is planned after the vault's independent audit.
