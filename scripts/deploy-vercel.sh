#!/usr/bin/env bash
# Build and deploy the docs site and the demo wallet to Vercel as static sites.
#   ./scripts/deploy-vercel.sh [docs|wallet|all]   (default: all; requires `vercel login`)
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
STAGE=$ROOT/.vercel-deploy
what=${1:-all}

deploy() { # <project-name> <dist-dir> <vercel.json>
  local dir=$STAGE/$1
  mkdir -p "$dir"
  find "$dir" -mindepth 1 -maxdepth 1 ! -name .vercel -exec rm -rf {} +
  cp -R "$2"/. "$dir"/
  printf '%s\n' "$3" > "$dir/vercel.json"
  (cd "$dir" && vercel deploy --prod --yes)
}

if [[ $what == wallet || $what == all ]]; then
  pnpm --filter @ika-portal/example-wallet build
  deploy ika-portal-wallet apps/example-wallet/dist \
    '{"rewrites":[{"source":"/(.*)","destination":"/index.html"}],"headers":[{"source":"/assets/(.*)","headers":[{"key":"Cache-Control","value":"public, max-age=31536000, immutable"}]}]}'
fi

if [[ $what == docs || $what == all ]]; then
  pnpm docs:build
  deploy ika-portal-docs docs/.vitepress/dist '{"cleanUrls":true,"trailingSlash":false}'
fi
