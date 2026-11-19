# HAVEN at the resolved tag. Two binaries, picked by MODE in the entrypoint:
#   default: the published release binary (haven_Linux_x86_64.tar.gz), unmodified.
#   perf:    the same tag built from source with one change: the outbox relay's
#            MustBeWhitelistedToPost policy is dropped, so the bench's random keys can write.
#            HAVEN has no setting for this (the outbox only takes the owner and whitelisted
#            npubs, and the bench tools don't AUTH), so a source edit is the least invasive way.
FROM golang:1.24-bookworm AS perf
ARG REF
WORKDIR /src
RUN git clone https://github.com/barrydeen/haven.git . && git checkout "$REF"
RUN sed -i '/outboxRelay.RejectEvent = append(outboxRelay.RejectEvent,/,/^\t)$/{/MustBeWhitelistedToPost,/d}' init.go \
 && sed -n '/outboxRelay.RejectEvent = append/,/^\t)$/p' init.go | (! grep -q MustBeWhitelistedToPost) \
 && grep -c MustBeWhitelistedToPost init.go
RUN CGO_ENABLED=1 go build -trimpath -ldflags "-s -w" -o /haven-perf .

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
ARG REF
WORKDIR /app
RUN curl -fsSL "https://github.com/barrydeen/haven/releases/download/${REF}/haven_Linux_x86_64.tar.gz" | tar -xz -C /app \
 && mv /app/haven /app/haven-default && cp .env.example .env \
 && echo '[]' > /app/no-relays.json
COPY --from=perf /haven-perf /app/haven-perf
ENV MODE=default
EXPOSE 3355
ENTRYPOINT ["/bin/sh", "-c", "exec /app/haven-$MODE"]
