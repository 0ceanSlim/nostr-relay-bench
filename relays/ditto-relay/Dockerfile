# ditto-relay has no Dockerfile upstream, and its release binaries are published only as a
# NIP-82 release on Nostr. This builds the resolved tag from source the way the README's
# "Running from source" does (cargo build --release, locked deps), on the Rust that
# rust-toolchain.toml pins: rustup installs that toolchain on the first cargo call.
FROM rust:1.99-bookworm AS build
ARG REF
WORKDIR /src
RUN git clone https://relay.ngit.dev/npub10qdp2fc9ta6vraczxrcs8prqnv69fru2k6s2dj48gqjcylulmtjsg9arpj/ditto-relay.git . \
 && git checkout "$REF"
RUN cargo build --release --locked && cp target/release/ditto-relay /usr/local/bin/ditto-relay

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/ditto-relay /usr/local/bin/ditto-relay
ENV MODE=default
EXPOSE 13131
ENTRYPOINT ["/bin/sh", "-c", "exec ditto-relay --config /etc/ditto-relay/$MODE.toml"]
