# nak (fiatjaf/nak), used only to sign and send the weekly note. The release binary, checked
# against the digest GitHub publishes for it.
FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
ARG VERSION=v0.22.2
ARG SHA256=d69b957649b17477618295c7d141c1016c84fe4c51681059a0f171a7b12904dc
RUN curl -fsSL -o /usr/local/bin/nak "https://github.com/fiatjaf/nak/releases/download/${VERSION}/nak-nodb-${VERSION}-linux-amd64" \
 && echo "${SHA256}  /usr/local/bin/nak" | sha256sum -c - && chmod +x /usr/local/bin/nak
ENTRYPOINT ["nak"]
