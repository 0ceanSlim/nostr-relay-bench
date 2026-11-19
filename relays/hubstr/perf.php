<?php
// hubstr perf profile, applied on top of the default config/relay.php by the entrypoint.
// Changed:
//   connection_limits.max_connections 100 -> 20000 (all load comes from one IP; idle test holds 10k)
//   limits: max_subscriptions 20 -> 1000, max_limit 1000 -> 5000 (max_filters, content and
//           filter-value limits as shipped)
//   rate_limits setting 240 events/min, 60 subscriptions/min -> 1e9 each
//   guest_policy setting: guests (anyone not AUTHed as a tenant) may write and read every kind the
//           load tools send (0, 1, 7, 1059, 10050, 20001, 30023, 30078) without p-tagging a tenant,
//           from any author. Policy lives in the settings table (NIP-86 setguestpolicy), so it is
//           seeded here after running the relay's own schema migrations. The kind lists have no
//           wildcard. Kind 1059 is writable but not readable: the relay library serves a gift wrap
//           only to a connection AUTHed as the key it names, whatever the policy says.
declare(strict_types=1);
require '/app/vendor/autoload.php';

$file = '/app/config/relay.php';
$c = require $file;
$c['connection_limits']['max_connections'] = 20000;
$c['limits']['max_subscriptions'] = 1000;
$c['limits']['max_limit'] = 5000;
file_put_contents($file, "<?php\n\nreturn ".var_export($c, true).";\n");

$kinds = [0, 1, 7, 1059, 10050, 20001, 30023, 30078];
$read = array_values(array_diff($kinds, [1059])); // README: never list 1059 as guest-readable
$pdo = new PDO('sqlite:'.$c['database_path'], null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
new Innis\Hubstr\Core\Infrastructure\Persistence\SchemaMigrator($pdo)->migrate('/app/resources/migrations');
$put = $pdo->prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)');
$put->execute(['rate_limits', json_encode(['events_per_minute' => 1000000000, 'subscriptions_per_minute' => 1000000000]), time()]);
$put->execute(['guest_policy', json_encode([
    'read' => ['kinds' => $read, 'global_kinds' => $read, 'from_tenants_only' => false],
    'write' => ['kinds' => $kinds, 'tagged_to_tenant' => false, 'tag_prefixes' => []],
]), time()]);
