# Security

Ika Portal is **pre-alpha software for testnets and devnet only**. It runs on the Ika Solana pre-alpha, which uses a single mock signer rather than real MPC, and neither the Solana program nor the EVM contract has been audited. Don't use it with real funds.

## Reporting a vulnerability

Please report suspected vulnerabilities privately. **Don't open a public issue.** Use GitHub's "Report a vulnerability" (private security advisory) on this repository, and include:

- the affected component (`programs/ika_account`, `contracts/evm`, `packages/*`, `services/relayer`);
- steps or a proof of concept;
- the impact you expect.

We'll acknowledge reports as soon as we can and coordinate a fix and disclosure.

## Scope and trust model

See [docs/security.md](docs/security.md) for what the design guarantees, what each party can do, and the known pre-alpha limitations.
