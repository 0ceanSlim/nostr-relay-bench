# relay-tester from mikedilger: protocol conformance checks, one JSON line per test with --script.
FROM rust:1.91-slim-trixie AS build
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
ARG REF=a8483f82f4965841faa92fae02105d4fd67d9117
WORKDIR /src
RUN git clone https://github.com/mikedilger/relay-tester.git . && git checkout "$REF"
RUN cargo build --release

FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3t64 && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/relay-tester /src/target/release/generate-keypair /usr/local/bin/
