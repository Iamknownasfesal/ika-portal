#!/usr/bin/env bash
# Starts a local validator with the Ika Portal programs preloaded at their fixed ids.
set -euo pipefail
P=/programs
for f in ika_account mock_dwallet test_cpi_owner; do
  [[ -f $P/$f.so ]] || { echo "missing $P/$f.so: run 'anchor build' (pnpm build:programs) on the host first" >&2; exit 1; }
done
# Agave 4.x rejects 0.0.0.0: bind to this container's address (port mappings and
# other containers reach it there).
IP=$(hostname -i | awk '{print $1}')
echo "$IP" > /tmp/validator-ip
exec solana-test-validator \
  --reset --quiet --ledger /ledger \
  --bind-address "$IP" --rpc-port 8899 --faucet-port 9900 \
  --bpf-program Dx7P74pmeMqgPG4iF3VpL5aZ6TZTMiPzcMULnpu2hyje $P/ika_account.so \
  --bpf-program 6sewJoZnLJN1hMzaYLySG61VSLiPoFzbA8Cyd7KJkwv $P/mock_dwallet.so \
  --bpf-program C86ZbaTdqH5dHZ5sBRrNrpMUYJxjubk8Adt4fNT9RnLA $P/test_cpi_owner.so \
  "$@"
