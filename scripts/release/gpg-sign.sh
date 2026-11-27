#!/usr/bin/env bash
# Detached GPG signatures for a release folder (docs/SIGNING.md, "Linux: GPG").
#
#   GPG_PRIVATE_KEY="$(gpg --armor --export-secret-keys <fpr>)" bash scripts/release/gpg-sign.sh <dir>
#
# Creates SHA256SUMS.txt.asc, one .asc per AppImage/deb/rpm, and exports the
# public key as hopline-release-key.asc. Without GPG_PRIVATE_KEY it does nothing.
# The key goes into a throwaway GNUPGHOME that is removed on exit; it is never
# echoed and never touches the caller's keyring. GPG_PASSPHRASE is optional.
set -euo pipefail

dir="${1:?usage: gpg-sign.sh <dir>}"
[ -d "$dir" ] || { echo "not a directory: $dir" >&2; exit 1; }

if [ -z "${GPG_PRIVATE_KEY:-}" ]; then
  echo "GPG_PRIVATE_KEY is not set: release is not GPG-signed (SHA-256 sums only)"
  exit 0
fi
[ -f "$dir/SHA256SUMS.txt" ] || { echo "$dir/SHA256SUMS.txt missing: run 'node scripts/release/cli.mjs sums $dir' first" >&2; exit 1; }

GNUPGHOME="$(mktemp -d)"
export GNUPGHOME
chmod 700 "$GNUPGHOME"
cleanup() {
  gpgconf --kill all >/dev/null 2>&1 || true
  rm -rf "$GNUPGHOME"
}
trap cleanup EXIT

# Key and passphrase reach gpg through stdin / a private file, never the command line.
printf '%s\n' "$GPG_PRIVATE_KEY" | gpg --batch --quiet --import 2>/dev/null
passfile="$GNUPGHOME/passphrase"
( umask 077; printf '%s' "${GPG_PASSPHRASE:-}" >"$passfile" )

fpr="$(gpg --batch --with-colons --list-secret-keys | awk -F: '$1 == "fpr" { print $10; exit }')"
[ -n "$fpr" ] || { echo "GPG_PRIVATE_KEY holds no secret key" >&2; exit 1; }

sign() {
  gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-file "$passfile" \
    --local-user "$fpr" --armor --detach-sign --output "$1.asc" "$1"
  echo "signed $(basename "$1")"
}

sign "$dir/SHA256SUMS.txt"
shopt -s nullglob
for f in "$dir"/*.AppImage "$dir"/*.deb "$dir"/*.rpm; do
  sign "$f"
done

gpg --batch --armor --export "$fpr" >"$dir/hopline-release-key.asc"
echo "exported hopline-release-key.asc (fingerprint $fpr)"
