#!/usr/bin/env bash
# Redeploy an exact older Trovara OS Git object without reversing the database.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

usage() {
  cat <<'EOF'
Usage: ./rollback.sh <commit-or-tag> [options]

Required safety acknowledgement for a real rollback:
  --confirm-rollback          Confirm that the selected application release should go live

Compatibility overrides (only after reviewing the listed differences):
  --allow-forward-database    Permit old code to run against migrations added after the target
  --allow-non-ancestor        Permit a target outside the current release's history
  --allow-unverified-current  Continue when live RELEASE.json cannot be read

Other options:
  --dry-run                   Show the resolved rollback without deploying
  --pull-backups              Pull the new pre-rollback backup after success (default)
  --skip-pull-backups         Leave the verified backup on the server
  -h, --help                  Show this help

This rolls back application code only. It always calls deploy.sh with
--skip-migrate and still creates the normal encrypted pre-release backup.
EOF
}

TARGET_REF=""
CONFIRMED=0
ALLOW_FORWARD_DATABASE=0
ALLOW_NON_ANCESTOR=0
ALLOW_UNVERIFIED_CURRENT=0
DRY_RUN=0
DEPLOY_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --confirm-rollback) CONFIRMED=1 ;;
    --allow-forward-database) ALLOW_FORWARD_DATABASE=1 ;;
    --allow-non-ancestor) ALLOW_NON_ANCESTOR=1 ;;
    --allow-unverified-current) ALLOW_UNVERIFIED_CURRENT=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --pull-backups|--skip-pull-backups) DEPLOY_ARGS+=("$1") ;;
    -h|--help) usage; exit 0 ;;
    --*) echo "ERROR: unknown rollback option: $1" >&2; usage >&2; exit 1 ;;
    *)
      if [[ -n "$TARGET_REF" ]]; then
        echo "ERROR: provide exactly one commit or tag" >&2
        exit 1
      fi
      TARGET_REF="$1"
      ;;
  esac
  shift
done

if [[ -z "$TARGET_REF" ]]; then
  echo "ERROR: a rollback commit or tag is required" >&2
  usage >&2
  exit 1
fi

TARGET_SHA="$(git rev-parse --verify "${TARGET_REF}^{commit}" 2>/dev/null)" || {
  echo "ERROR: rollback target is not a local commit or tag: $TARGET_REF" >&2
  exit 1
}
TARGET_SUMMARY="$(git show -s --format='%h %cI %s' "$TARGET_SHA")"

if [[ -f "$ROOT_DIR/.env.deploy" ]]; then
  # shellcheck disable=SC1091
  set -a; source "$ROOT_DIR/.env.deploy"; set +a
fi
OS_RELEASE_URL="${OS_RELEASE_URL:-${VITE_PUBLIC_APP_URL:-https://os.trovara.farm}}"
OS_RELEASE_URL="${OS_RELEASE_URL%/}"

CURRENT_SHA="${CURRENT_RELEASE_SHA:-}"
if [[ -z "$CURRENT_SHA" ]]; then
  CURRENT_SHA="$(
    { curl -fsS --max-time 15 "$OS_RELEASE_URL/RELEASE.json" 2>/dev/null || true; } |
      node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{let s=JSON.parse(d).sha||'';if(/^[a-f0-9]{7,40}$/i.test(s))process.stdout.write(s)}catch{}})"
  )"
fi

if [[ -z "$CURRENT_SHA" ]]; then
  if [[ "$ALLOW_UNVERIFIED_CURRENT" -ne 1 ]]; then
    echo "ERROR: cannot verify the current release at $OS_RELEASE_URL/RELEASE.json" >&2
    echo "Use --allow-unverified-current only after checking production manually." >&2
    exit 1
  fi
  echo "WARNING: current production SHA is unverified."
fi

if [[ -n "$CURRENT_SHA" ]] && git cat-file -e "${CURRENT_SHA}^{commit}" 2>/dev/null; then
  CURRENT_SHA="$(git rev-parse "${CURRENT_SHA}^{commit}")"
  if [[ "$CURRENT_SHA" == "$TARGET_SHA" ]]; then
    echo "ERROR: target $TARGET_SHA is already the live release" >&2
    exit 1
  fi
  if ! git merge-base --is-ancestor "$TARGET_SHA" "$CURRENT_SHA"; then
    if [[ "$ALLOW_NON_ANCESTOR" -ne 1 ]]; then
      echo "ERROR: target is not an ancestor of the live release $CURRENT_SHA" >&2
      echo "Use --allow-non-ancestor only after reviewing the branch difference." >&2
      exit 1
    fi
    echo "WARNING: target is outside the live release's direct history."
  fi
else
  if [[ -n "$CURRENT_SHA" && "$ALLOW_UNVERIFIED_CURRENT" -ne 1 ]]; then
    echo "ERROR: live SHA $CURRENT_SHA is not available in this clone" >&2
    echo "Fetch it first, or use --allow-unverified-current after manual verification." >&2
    exit 1
  fi
fi

COMPARE_SHA="$CURRENT_SHA"
if [[ -z "$COMPARE_SHA" ]] || ! git cat-file -e "${COMPARE_SHA}^{commit}" 2>/dev/null; then
  COMPARE_SHA="$(git rev-parse HEAD)"
fi
TEMP_DIR="$(mktemp -d -t trovara-rollback.XXXXXX)"
cleanup() { rm -rf "$TEMP_DIR"; }
trap cleanup EXIT
git ls-tree -r --name-only "$TARGET_SHA" -- api/drizzle |
  awk '/\/migration\.sql$/' | LC_ALL=C sort >"$TEMP_DIR/target-migrations"
git ls-tree -r --name-only "$COMPARE_SHA" -- api/drizzle |
  awk '/\/migration\.sql$/' | LC_ALL=C sort >"$TEMP_DIR/current-migrations"
comm -13 "$TEMP_DIR/target-migrations" "$TEMP_DIR/current-migrations" >"$TEMP_DIR/forward-migrations"

if [[ -s "$TEMP_DIR/forward-migrations" ]]; then
  echo "Database migrations newer than the rollback target:"
  sed 's/^/  - /' "$TEMP_DIR/forward-migrations"
  if [[ "$ALLOW_FORWARD_DATABASE" -ne 1 ]]; then
    echo "ERROR: application rollback cannot reverse these migrations." >&2
    echo "Review expand-contract compatibility, then rerun with --allow-forward-database." >&2
    exit 1
  fi
  echo "WARNING: the database will stay at its current forward-only schema."
fi

echo "Current release: ${CURRENT_SHA:-unverified}"
echo "Rollback target: $TARGET_SUMMARY"
echo "Database: unchanged (--skip-migrate)"

COMMAND=(env "RELEASE_REF=$TARGET_SHA" "RELEASE_OPERATION=rollback" "RELEASE_ROLLBACK_FROM=${CURRENT_SHA:-unknown}" ./deploy.sh --skip-migrate)
if [[ ${#DEPLOY_ARGS[@]} -gt 0 ]]; then
  COMMAND+=("${DEPLOY_ARGS[@]}")
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  printf 'Dry run command:'
  printf ' %q' "${COMMAND[@]}"
  printf '\n'
  exit 0
fi

if [[ "$CONFIRMED" -ne 1 ]]; then
  echo "ERROR: rerun with --confirm-rollback after reviewing the target above." >&2
  exit 1
fi

"${COMMAND[@]}"

DEPLOYED_SHA="$(
  curl -fsS --max-time 15 "$OS_RELEASE_URL/RELEASE.json" |
    node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(JSON.parse(d).sha||''))"
)"
if [[ "$DEPLOYED_SHA" != "$TARGET_SHA" ]]; then
  echo "ERROR: rollback verification returned $DEPLOYED_SHA; expected $TARGET_SHA" >&2
  exit 1
fi
echo "Rollback verified: $TARGET_SHA"
