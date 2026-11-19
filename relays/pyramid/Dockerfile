# pyramid at the resolved tag, built the way upstream's Dockerfile does it (tailwind, templ,
# static musl build with -tags=libsecp256k1, Ubuntu runtime with git for grasp). Two binaries,
# picked by MODE in the entrypoint:
#   default: the tag as is.
#   perf:    the tag with one change in core.go basicRejectionLogic: the closing
#            "require being a member" check accepts everyone, so the bench's random keys can
#            write to the main relay. pyramid has no setting for open writes (only members of the
#            invite tree may publish), and the dataset has ~40k-800k distinct authors, so a
#            source edit is the least invasive way. Every other check in that function stays.
FROM node:25 AS src
ARG REF
WORKDIR /app
RUN git clone https://github.com/fiatjaf/pyramid.git . && git checkout "$REF"
RUN npm install && npx tailwindcss -i base.css -o static/styles.css

FROM golang:1.26 AS builder
RUN apt-get update && apt-get install -y musl-tools git curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=src /app /app
RUN go mod download && go install github.com/a-h/templ/cmd/templ@$(grep 'github.com/a-h/templ' go.mod | awk '{print $2}')
RUN templ generate && VERSION=$(git describe --tags --exact-match) \
 && CC=musl-gcc go build -tags=libsecp256k1 -ldflags="-X main.currentVersion=$VERSION -linkmode external -extldflags \"-static\"" -o /out/pyramid-default \
 && sed -i '/\/\/ require being a member/{n;s/if pyramid.IsMember(event.PubKey) {/if true { \/\/ rb perf: admit all writers/}' core.go \
 && grep -A1 '// require being a member' core.go | grep -q 'if true {' \
 && CC=musl-gcc go build -tags=libsecp256k1 -ldflags="-X main.currentVersion=$VERSION -linkmode external -extldflags \"-static\"" -o /out/pyramid-perf

FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates tzdata && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /out/ /app/
# upstream image env
ENV HOST="0.0.0.0" PORT="3334" DATA_PATH="./data" NO_AUTO_UPDATES="true" MODE=default
EXPOSE 3334
# pyramid redirects every request to /setup/ until it has a domain and a root member, so the
# first start seeds both (see settings.*.json, management.jsonl).
ENTRYPOINT ["/bin/sh", "-c", "mkdir -p data && [ -f data/settings.json ] || { cp /bench/settings.$MODE.json data/settings.json && cp /bench/management.jsonl data/management.jsonl; }; exec ./pyramid-$MODE"]
