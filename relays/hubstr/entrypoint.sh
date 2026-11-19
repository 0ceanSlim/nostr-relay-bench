#!/bin/sh
# Writes config/relay.php for $MODE, then starts the relay.
# Default profile: config/relay.example.php with host 0.0.0.0, relay_url ws://relay:8080, the data
# path in the volume, and a fixed throwaway admin_pubkey (the relay refuses to start without one).
set -e
cd /app
ADMIN=79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798
sed -e "s|'YOUR_NPUB_OR_HEX_PUBKEY_HERE'|'$ADMIN'|" \
    -e "s|'host' => '127.0.0.1'|'host' => '0.0.0.0'|" \
    -e "s|'relay_url' => 'wss://relay.example.com'|'relay_url' => 'ws://relay:8080'|" \
    -e "s|dirname(__DIR__).'/data/hubstr-relay.sqlite'|'/app/data/hubstr-relay.sqlite'|" \
    config/relay.example.php > config/relay.php
if [ "$MODE" = perf ]; then
  php /bench/perf.php
fi
exec php bin/hubstr-relay.php
