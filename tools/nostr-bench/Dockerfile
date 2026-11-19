# nostr-bench from privkeyio. Used for its one-at-a-time write test: each worker sends an
# event and waits for the OK before the next, so it measures the durable write round trip.
FROM debian:trixie-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends curl xz-utils ca-certificates git libsecp256k1-dev libssl-dev && rm -rf /var/lib/apt/lists/*
ARG ZIG_VERSION=0.16.0
ARG ZIG_SHA256=70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00
RUN curl -fsSL -o /tmp/zig.tar.xz https://ziglang.org/download/${ZIG_VERSION}/zig-x86_64-linux-${ZIG_VERSION}.tar.xz \
 && echo "${ZIG_SHA256}  /tmp/zig.tar.xz" | sha256sum -c - \
 && tar -xJf /tmp/zig.tar.xz -C /opt && rm /tmp/zig.tar.xz
ENV PATH="/opt/zig-x86_64-linux-${ZIG_VERSION}:$PATH"
ARG REF=b495067aee71f570a202166a5bc11f9fb0837287
WORKDIR /src
RUN git clone https://github.com/privkeyio/nostr-bench.git . && git checkout "$REF"
RUN zig build -Doptimize=ReleaseFast

FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libsecp256k1-2 && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/zig-out/bin/nostr-bench /usr/local/bin/nostr-bench
ENTRYPOINT ["nostr-bench"]
