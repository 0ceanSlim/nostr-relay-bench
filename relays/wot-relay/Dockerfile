# wot-relay at the resolved tag, built as upstream's Dockerfile does (golang:bookworm, go build,
# run from the source dir with DB_PATH/INDEX_PATH/STATIC_PATH set). Two binaries, picked by MODE:
#   default: the tag as is.
#   perf:    the tag with its hard-coded per-IP limits removed from main.go (no setting exists):
#              EventIPRateLimiter(5/min, burst 30), FilterIPRateLimiter(5/min, burst 30),
#              ConnectionRateLimiter(10 per 2 min, burst 30),
#            and relay.UseEventstore(db, 500) raised to 5000 (the per-filter limit cap).
#            NoEmptyFilters / NoComplexFilters and the WoT check are left as they are.
# The image's .env is the shipped .env.example (ARCHIVAL_SYNC=FALSE, MINIMUM_FOLLOWERS=5, ...);
# variables set in compose take precedence over it.
FROM golang:bookworm
ARG REF
WORKDIR /app
RUN git clone https://github.com/barrydeen/wot-relay.git . && git checkout "$REF" && go mod download
ENV DB_PATH="db" INDEX_PATH="templates/index.html" STATIC_PATH="templates/static"
RUN cp .env.example .env && go build -o main-default . \
 && sed -i -e '/policies.EventIPRateLimiter(5, time.Minute\*1, 30),/d' \
           -e '/policies.FilterIPRateLimiter(5, time.Minute\*1, 30),/d' \
           -e '/relay.RejectConnection = policies.ConnectionRateLimiter(10, time.Minute\*2, 30)/d' \
           -e 's/relay.UseEventstore(db, 500)/relay.UseEventstore(db, 5000)/' main.go \
 && ! grep -n RateLimiter main.go && grep -q 'UseEventstore(db, 5000)' main.go \
 && go build -o main-perf . && git checkout main.go
ENV MODE=default
EXPOSE 3334
ENTRYPOINT ["/bin/sh", "-c", "exec ./main-$MODE"]
