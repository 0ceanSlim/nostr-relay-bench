# zooid at the resolved tag, built as upstream's Dockerfile does (golang:1.26, CGO off,
# distroless runtime as nonroot). Two binaries; compose.perf.yaml switches the entrypoint:
#   /bin/zooid       the tag as is (default profile).
#   /bin/zooid-perf  the tag with two edits in zooid/instance.go:
#     - onEvent takes the event's author as the authenticated pubkey. zooid requires NIP-42
#       AUTH as the author for every write, even with public_write, and the bench tools don't
#       AUTH, so this is the least invasive way to let them write. Bans, kind checks and
#       public_write still apply.
#     - QueryStored's hard cap of 1000 events per filter raised to 5000.
# The upstream image has no /app; it is created here owned by nonroot so the named volumes
# for DATA and MEDIA are writable.
FROM golang:1.26 AS build
ARG REF
WORKDIR /app
RUN git clone https://gitea.coracle.social/coracle/zooid.git . && git checkout "$REF" && go mod download
RUN CGO_ENABLED=0 go build -o bin/zooid cmd/relay/main.go \
 && sed -i -e 's/pubkey, isAuthenticated := khatru.GetAuthed(ctx)/pubkey, isAuthenticated := event.PubKey, true \/\/ rb perf: author counts as authenticated/' \
           -e 's/instance.Events.QueryRequestEvents(filter, 1000)/instance.Events.QueryRequestEvents(filter, 5000)/' zooid/instance.go \
 && grep -q 'event.PubKey, true // rb perf' zooid/instance.go && grep -q 'QueryRequestEvents(filter, 5000)' zooid/instance.go \
 && CGO_ENABLED=0 go build -o bin/zooid-perf cmd/relay/main.go \
 && mkdir -p /out/app/data /out/app/media /out/app/config

FROM gcr.io/distroless/base-debian12
WORKDIR /
COPY --from=build /app/bin/zooid /app/bin/zooid-perf /bin/
COPY --from=build /app/templates /templates
COPY --from=build /app/static /static
COPY --from=build --chown=65532:65532 /out/app /app
USER nonroot:nonroot
EXPOSE 3334
ENV CONFIG=/app/config MEDIA=/app/media DATA=/app/data
ENTRYPOINT ["/bin/zooid"]
