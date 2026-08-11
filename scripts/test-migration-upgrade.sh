#!/usr/bin/env bash
# Prove a database one migration behind can upgrade through the repository tip.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_DIR="$ROOT_DIR/api"
MIGRATIONS_DIR="$API_DIR/drizzle"
if [[ -z "${DATABASE_URL:-}" && -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi
: "${DATABASE_URL:?DATABASE_URL is required}"

migrations=()
while IFS= read -r migration; do
  migrations+=("$migration")
done < <(for path in "$MIGRATIONS_DIR"/*/migration.sql; do dirname "$path"; done | sort)
if ((${#migrations[@]} < 2)); then
  echo "ERROR: at least two migrations are required for an upgrade test" >&2
  exit 1
fi

fixture="$(mktemp -d "${TMPDIR:-/tmp}/trovara-migration-fixture.XXXXXX")"
cleanup() { rm -rf "$fixture"; }
trap cleanup EXIT

last_index=$((${#migrations[@]} - 1))
previous_index=$((last_index - 1))
for ((i = 0; i < last_index; i++)); do
  cp -R "${migrations[$i]}" "$fixture/"
done

run_migrations() {
  local folder="$1"
  (
    cd "$API_DIR"
    MIGRATIONS_FOLDER="$folder" node --input-type=module <<'NODE'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
const client = postgres(process.env.DATABASE_URL, { max: 1 })
try {
  await migrate(drizzle({ client }), { migrationsFolder: process.env.MIGRATIONS_FOLDER })
} finally {
  await client.end()
}
NODE
  )
}

echo "Applying upgrade fixture through $(basename "${migrations[$previous_index]}")"
run_migrations "$fixture"
echo "Upgrading fixture through current tip $(basename "${migrations[$last_index]}")"
run_migrations "$MIGRATIONS_DIR"

expected="${#migrations[@]}"
actual="$(
  node --input-type=module - "$DATABASE_URL" <<'NODE'
import postgres from 'postgres'
const sql = postgres(process.argv[2], { max: 1 })
try {
  const [row] = await sql`select count(*)::int as count from drizzle.__drizzle_migrations`
  process.stdout.write(String(row.count))
} finally {
  await sql.end()
}
NODE
)"
if [[ "$actual" != "$expected" ]]; then
  echo "ERROR: migration journal has $actual entries; expected $expected" >&2
  exit 1
fi
echo "Migration upgrade test passed: $actual migrations at $(basename "${migrations[$last_index]}")"
