#!/usr/bin/env bash
set -euo pipefail

# Ubuntu restricts the user namespaces Chromium needs for its renderer sandbox.
# Grant that permission to this checkout's Electron binary on the disposable runner.
if [[ -r /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]] &&
   [[ $(< /proc/sys/kernel/apparmor_restrict_unprivileged_userns) == 1 ]]; then
  sudo apparmor_parser --replace <<PROFILE
abi <abi/4.0>,
include <tunables/global>
profile hopline-ci-electron "$PWD/node_modules/electron/dist/electron" flags=(unconfined) {
  userns,
}
PROFILE
fi

exec xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24" npm run e2e -w @hopline/desktop
