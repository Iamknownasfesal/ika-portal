# Workspace image: runs the e2e suites and the EVM relayer against the compose stack.
FROM ghcr.io/foundry-rs/foundry:latest AS contracts
USER root
WORKDIR /evm
COPY contracts/evm/ ./
RUN forge build

FROM node:24-bookworm-slim
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY . .
COPY --from=contracts /evm/out contracts/evm/out
RUN pnpm install --frozen-lockfile
ENV E2E_EXTERNAL=1
CMD ["pnpm", "test:e2e"]
