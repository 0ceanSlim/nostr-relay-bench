# Hubstr Relay has no upstream Dockerfile or image. This follows the README's install: PHP 8.4 CLI
# with the extensions it lists (ffi + libsecp256k1 for signature verification), a clone at the
# resolved tag, `composer install` (no dev packages). The entrypoint writes config/relay.php for MODE.
FROM php:8.4-cli-trixie
RUN apt-get update && apt-get install -y --no-install-recommends git unzip libffi-dev libgmp-dev libicu-dev \
      libsecp256k1-dev sqlite3 \
 && docker-php-ext-install -j"$(nproc)" ffi pcntl gmp intl \
 && pecl install ev && docker-php-ext-enable ev \
 && rm -rf /var/lib/apt/lists/* /tmp/pear
# ext-ev: without one of the event-loop extensions revolt names, the loop falls back to
# stream_select() and the relay dies at 1024 open sockets (FD_SETSIZE). The README does not list
# it; revolt's docs recommend one for anything with many connections.
COPY --from=composer:2.8.12 /usr/bin/composer /usr/bin/composer
ARG REF
WORKDIR /app
RUN git clone https://github.com/johninnis/hubstr-relay.git . && git checkout "$REF" \
 && composer install --no-dev --no-interaction --no-progress --optimize-autoloader
# Production php.ini, as the official image recommends (the bare image runs with assertions on),
# with the CLI's memory_limit unlimited as distro CLI packages ship it (Debian's cli/php.ini sets -1;
# the README's systemd unit runs /usr/bin/php). At 128M the event loop died under the fanout test.
RUN cp "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini" \
 && sed -i 's/^memory_limit = .*/memory_limit = -1/' "$PHP_INI_DIR/php.ini" && mkdir -p /app/data /app/var
COPY entrypoint.sh /entrypoint.sh
ENV MODE=default
EXPOSE 8080
ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
