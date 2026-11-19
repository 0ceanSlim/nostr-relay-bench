# strfry built from source at the resolved tag, as upstream's Dockerfile does (same Alpine 3.18:
# strfry links libressl, whose ABI changes in later Alpine releases).
FROM alpine:3.18 AS build
RUN apk --no-cache add linux-headers git g++ make perl pkgconfig libtool ca-certificates \
      libressl-dev zlib-dev lmdb-dev flatbuffers-dev libsecp256k1-dev zstd-dev
ARG REF
WORKDIR /build
RUN git clone https://github.com/hoytech/strfry.git . && git checkout "$REF" \
 && git submodule update --init && make setup-golpe && make -j"$(nproc)"
# Default profile: the shipped strfry.conf, with only the bind address and db path changed
# so it listens inside the container and writes to the data volume.
RUN sed -e 's|^db = .*|db = "/data/strfry-db/"|' -e 's|bind = "127.0.0.1"|bind = "0.0.0.0"|' strfry.conf > strfry.default.conf

FROM alpine:3.18
RUN apk --no-cache add lmdb flatbuffers libsecp256k1 libb2 zstd libressl
COPY --from=build /build/strfry /app/strfry
COPY --from=build /build/strfry.default.conf /etc/strfry.default.conf
ENV MODE=default
EXPOSE 7777
ENTRYPOINT ["/bin/sh", "-c", "mkdir -p /data/strfry-db && exec /app/strfry --config /etc/strfry.$MODE.conf relay"]
