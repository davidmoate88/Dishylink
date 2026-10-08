#!/usr/bin/env bash
# Build on this machine and ship the runtime to the self-hosted CT, the same
# file set the Dockerfile's runtime stage copies. Run from the repo root.
#   deploy/selfhost/deploy.sh            build + push + restart
# Env: CT (default 139), HOP (command that runs a shell on the CT's Proxmox node).
set -euo pipefail
CT="${CT:-139}"
HOP="${HOP:-$HOME/.ssh/pve3-hop.sh}"
cd "$(dirname "$0")/../.."

npm run build
stage="$(mktemp -d)"
bundle="$(mktemp --suffix=.tgz)"
trap 'rm -rf "$stage" "$bundle"' EXIT
tar -cf - --exclude='collector/data' --exclude='*.test.*' \
  dist public/dish.protoset collector core cloud docker dev/starlinkCloudProxy.ts |
  tar -xf - -C "$stage"
# A stub package.json keeps the .mts tree ESM; the runtime needs only these
# three packages, not the monorepo's Electron and renderer dependencies.
cat > "$stage/package.json" <<'JSON'
{
  "name": "dishylink-browser",
  "private": true,
  "type": "module",
  "dependencies": { "@bufbuild/protobuf": "2.6.0", "tsx": "4.23.1", "undici": "7.29.0" }
}
JSON
tar -czf "$bundle" -C "$stage" .

# pct push needs the file on the node, so stream it there first.
"$HOP" "cat > /tmp/dishylink.tgz" < "$bundle"
"$HOP" "pct push $CT /tmp/dishylink.tgz /tmp/dishylink.tgz && rm /tmp/dishylink.tgz"
"$HOP" "pct exec $CT -- /usr/local/sbin/dishylink-install"
