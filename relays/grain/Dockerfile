# grain from its published release tarball for the resolved tag: the binary operators install.
# The release binary links glibc (nostrdb is cgo), so the base is Debian, not Alpine.
FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
ARG REF
RUN curl -fsSL "https://github.com/0ceanSlim/grain/releases/download/${REF}/grain-linux-amd64.tar.gz" -o /tmp/g.tgz \
 && mkdir -p /app && tar -xzf /tmp/g.tgz -C /tmp && mv /tmp/$(tar -tzf /tmp/g.tgz | head -1 | cut -d/ -f1)/* /app/ \
 && chmod +x /app/grain && rm -rf /tmp/*
RUN mkdir -p /home/grain/.grain/data
WORKDIR /app
ENV HOME=/home/grain MODE=default
EXPOSE 8181
# Default profile: no config file, so grain writes its own defaults on first start.
ENTRYPOINT ["/bin/sh", "-c", "[ \"$MODE\" = perf ] && cp /bench/perf.yml /home/grain/.grain/config.yml; exec ./grain"]
