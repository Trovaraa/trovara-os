#!/usr/bin/env bash
# Release Trovara OS first, verify the immutable release, then optionally invoke
# a separately configured marketing deployment command.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OS_URL="${OS_RELEASE_URL:-https://os.trovara.farm}"
MARKETING_URL="${MARKETING_RELEASE_URL:-https://www.trovara.farm}"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[[ -s "$NVM_DIR/nvm.sh" ]] || {
  echo "ERROR: nvm is required to select Node 22" >&2
  exit 1
}
# shellcheck disable=SC1091
source "$NVM_DIR/nvm.sh"
nvm use 22 >/dev/null

cd "$ROOT_DIR"
expected_sha="$(git rev-parse HEAD)"
./deploy.sh "$@"

echo "==> Verifying OS release $expected_sha"
curl -fsS "$OS_URL/health" >/dev/null
curl -fsS "$OS_URL/ready" >/dev/null
actual_sha="$(curl -fsS "$OS_URL/RELEASE.json" | node -e \
  "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(JSON.parse(d).sha||''))")"
if [[ "$actual_sha" != "$expected_sha" ]]; then
  echo "ERROR: deployed OS SHA $actual_sha does not match $expected_sha" >&2
  exit 1
fi

if [[ -z "${MARKETING_DEPLOY_COMMAND:-}" ]]; then
  echo "OS release verified. Marketing deploy intentionally not run."
  echo "Set MARKETING_DEPLOY_COMMAND to the provider CLI/hook command after reviewing docs/RELEASE-CHECKLIST.md."
  exit 0
fi

echo "==> Releasing marketing after OS verification"
bash -lc "$MARKETING_DEPLOY_COMMAND"
curl -fsS "$MARKETING_URL/" >/dev/null
echo "Coordinated release complete: OS first, then marketing"
