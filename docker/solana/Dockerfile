# solana-test-validator (Agave) with the Ika Portal programs preloaded.
#
# amd64: Anza's prebuilt Linux binaries.
# arm64: built from source. The prebuilt binaries are x86_64-only, and under
#        Rosetta/QEMU Agave 4.x aborts because io_uring syscalls aren't emulated.
ARG AGAVE_VERSION=v4.3.0

FROM debian:bookworm-slim AS bin-amd64
ARG AGAVE_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates bzip2 \
 && curl -sSfL "https://github.com/anza-xyz/agave/releases/download/${AGAVE_VERSION}/solana-release-x86_64-unknown-linux-gnu.tar.bz2" | tar xj -C /opt \
 && mkdir -p /out && cp /opt/solana-release/bin/solana-test-validator /out/

FROM rust:1-bookworm AS bin-arm64
ARG AGAVE_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends \
      clang libclang-dev cmake libudev-dev libssl-dev pkg-config protobuf-compiler llvm git \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "${AGAVE_VERSION}" https://github.com/anza-xyz/agave /agave
WORKDIR /agave
# agave pins its toolchain in rust-toolchain.toml; rustup installs it on first use.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/agave/target \
    cargo build --release --bin solana-test-validator \
 && mkdir -p /out && cp target/release/solana-test-validator /out/

ARG TARGETARCH
FROM bin-${TARGETARCH} AS bin

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates libssl3 libudev1 bzip2 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=bin /out/solana-test-validator /usr/local/bin/
# Program binaries are baked in (no host mounts needed). Build them first: pnpm build:programs
COPY target/deploy/ika_account.so target/deploy/mock_dwallet.so target/deploy/test_cpi_owner.so /programs/
COPY docker/solana/start.sh /usr/local/bin/start-validator
RUN chmod +x /usr/local/bin/start-validator
EXPOSE 8899 8900 9900
HEALTHCHECK --interval=3s --timeout=3s --retries=100 \
  CMD curl -sf -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' "http://$(cat /tmp/validator-ip):8899" | grep -q '"ok"'
ENTRYPOINT ["start-validator"]
