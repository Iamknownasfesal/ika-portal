#!/usr/bin/env bash
# Copy the Anchor IDL + TS types into the SDK after `anchor build`.
set -euo pipefail
cd "$(dirname "$0")/.."
cp target/idl/ika_account.json packages/core/src/idl/ika_account.json
sed 's/^export type IkaAccount = {/export type IkaAccountIdl = {/' target/types/ika_account.ts > packages/core/src/idl/ika_account.ts
echo "IDL synced"
