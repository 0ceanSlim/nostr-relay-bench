# ORLY built at the resolved tag the way upstream's Dockerfile does (golang:1.25-bookworm, CGO off,
# ./cmd/orly, Debian runtime with libsecp256k1). Ours only because a git build context pulls in
# submodules and next/tinygo is SSH-only (git@mleku.dev); the relay build doesn't use either.
FROM golang:1.25-bookworm AS builder
RUN apt-get update && apt-get install -y --no-install-recommends git make && rm -rf /var/lib/apt/lists/*
ARG REF
WORKDIR /build
RUN git clone -q --depth 1 --branch "$REF" https://git.smesh.lol/orly.git .
# The committed vendor/ tree is incomplete (protobuf's editions_defaults.binpb is missing), so a
# vendor build fails; build from the module cache against go.sum instead (-mod=mod).
RUN go mod download && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -mod=mod -o orly -ldflags="-w -s" ./cmd/orly

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl libsecp256k1-1 \
 && rm -rf /var/lib/apt/lists/*
RUN groupadd -g 1000 orly && useradd -m -u 1000 -g orly orly
WORKDIR /app
COPY --from=builder /build/orly /app/orly
RUN mkdir -p /data /dkim && chown -R orly:orly /data /dkim /app
USER orly
EXPOSE 3334
ENV ORLY_LISTEN=0.0.0.0 ORLY_PORT=3334 ORLY_DATA_DIR=/data ORLY_LOG_LEVEL=info
ENTRYPOINT ["/app/orly"]
