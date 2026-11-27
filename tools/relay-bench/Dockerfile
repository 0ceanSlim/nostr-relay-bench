# relay-bench, the load generator and validating tester from VectorPrivacy/magnitude-relay.
#
# One change from upstream: its live tests (fanout, idle) subscribe only to gift wraps, Vector's
# traffic. A relay that keeps gift wraps to their recipient (NIP-17) refuses every one of those
# subscriptions without AUTH, so the tests measured privacy policy instead of delivery. Here the
# same subscription shapes use public kinds: the "DM" subscriber holds {kinds:[1],#p:[own key]}
# (a mentions feed) and the "Concord" subscriber {kinds:[1,20001],authors:[200 keys]} (a home
# feed, half of it ephemeral). Gift-wrap reads are still measured by the query and neg tests.
#
# And one fix: gen --nip44 writes random bytes as the payload, so the version byte is random and
# a relay that checks for NIP-44 v2 refuses ~255 of every 256 wraps. The first byte is set to 2.
#
# auth.patch adds NIP-42 to query: with --auth-seed (the dataset's gen seed), each inbox read and
# COUNT goes out on a connection AUTHed as the mailbox's recipient, whose key the generator derives
# from the seed. One connection per mailbox, opened and AUTHed before the clock starts, so a relay
# that keeps gift wraps to their recipient (NIP-17) is measured instead of refused. COUNT now picks
# mailboxes with at least two wraps, like the inbox reads: one-wrap keys are Concord events' random
# p tags, nobody's inbox. Concord reads stay unauthenticated; no key can AUTH for a random p.
FROM rust:1.91-slim-trixie AS build
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
ARG REF=b710dc5f7882478d87ff26a466b5cf3b9decbb15
WORKDIR /src
RUN git clone https://github.com/VectorPrivacy/magnitude-relay.git . && git checkout "$REF"
COPY auth.patch /tmp/auth.patch
RUN git apply /tmp/auth.patch
RUN sed -i -e 's/21059/20001/g' -e 's/1059/1/g' crates/relay-bench/src/fanout.rs crates/relay-bench/src/idle.rs \
 && ! grep -n 1059 crates/relay-bench/src/fanout.rs crates/relay-bench/src/idle.rs \
 && sed -i 's/^        rng.fill(&mut bytes);$/        rng.fill(\&mut bytes);\n        bytes[0] = 2;/' crates/relay-bench/src/generate.rs \
 && grep -q '^        bytes\[0\] = 2;$' crates/relay-bench/src/generate.rs
RUN cargo build --release --locked -p relay-bench && cp target/release/relay-bench /usr/local/bin/

FROM debian:trixie-slim
COPY --from=build /usr/local/bin/relay-bench /usr/local/bin/relay-bench
ENTRYPOINT ["relay-bench"]
