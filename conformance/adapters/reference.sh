#!/bin/sh
# Conformance adapter for the legacy reference node (reference/rc-knoten.php, v1.3).
#
#   node conformance/run.js --impl=reference -- sh conformance/adapters/reference.sh
#
# Converts the CONTRACT.md JSON config (English keys) into a legacy
# rc-knoten.conf.php (German keys), applies the env overrides and kind aliases
# the reference does not know yet, maps the mode flags
# (--once -> none, --one -> --einer, --daemon -> --dauer, --probe -> --probe)
# and then exec's the reference, so signals reach the PHP process directly.
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
cfg=""
mode=""
for a in "$@"; do
    case "$a" in
        --config=*) cfg="${a#--config=}" ;;
        --probe)    mode="--probe" ;;
        --once)     mode="" ;;
        --one)      mode="--einer" ;;
        --daemon)   mode="--dauer" ;;
        *) echo "reference adapter: unknown argument $a" >&2; exit 2 ;;
    esac
done
[ -n "$cfg" ] || cfg="${RC_NODE_CONFIG:-rc-node.json}"
konf="$cfg.legacy.conf.php"
# RC_REFERENCE_PHP: only for mutation tests of the suite itself (a deliberately broken copy)
ref="${RC_REFERENCE_PHP:-$root/reference/rc-knoten.php}"
php "$here/reference-config.php" "$cfg" > "$konf" || exit 2
if [ -n "$mode" ]; then
    exec php "$ref" --konf="$konf" "$mode"
fi
exec php "$ref" --konf="$konf"
