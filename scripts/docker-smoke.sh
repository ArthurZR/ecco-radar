#!/usr/bin/env bash
# Builds the production image with docker compose, starts it with Postgres, and checks that the app
# migrates, serves the web app, signs a user in, refuses anonymous access and survives a database
# restart. Uses a throwaway compose project and env file and removes both, including the database
# volume, at the end. Set SMOKE_NO_BUILD=1 to reuse an image already tagged radar-smoke-app.
set -euo pipefail

project=radar-smoke
port=8787
base=http://localhost:$port
work=$(mktemp -d)
export RADAR_ENV_FILE="$work/app.env"
compose() { docker compose -p "$project" --env-file "$RADAR_ENV_FILE" "$@"; }
trap 'compose down -v >/dev/null 2>&1 || true; rm -rf "$work"' EXIT

cat > "$RADAR_ENV_FILE" <<ENV
POSTGRES_PASSWORD=$(openssl rand -hex 16)
SESSION_SECRET=$(openssl rand -hex 32)
APP_ORIGIN=$base
SOURCE_CONTACT=smoke-test@example.com
ENV

if [ "${SMOKE_NO_BUILD:-}" = 1 ]; then compose up -d --no-build --wait; else compose up -d --build --wait; fi

expect() { # expect <status> <description> <curl args...>
  local want=$1 what=$2; shift 2
  local got; got=$(curl -s -o /dev/null -w '%{http_code}' "$@")
  if [ "$got" != "$want" ]; then echo "FAIL: $what (HTTP $got, expected $want)"; exit 1; fi
  echo "ok: $what"
}

expect 200 'health check passes with the database reachable' "$base/api/health"
expect 200 'the built web app is served, including client-side routes' "$base/archive"
expect 401 'the archive API refuses anonymous requests' "$base/api/references"

printf 'smoke-test-password-1\n' | compose exec -T app node dist/auth/create-user-cli.js smoke@example.com 'Smoke test' >/dev/null
expect 200 'a user created with the CLI can sign in' -c "$work/jar" -H "Origin: $base" -H 'content-type: application/json' \
  -d '{"email":"smoke@example.com","password":"smoke-test-password-1"}' "$base/api/auth/login"
expect 200 'the signed-in user can read the archive' -b "$work/jar" "$base/api/references"

compose exec -T app node -e "import('sharp').then((s) => s.default({ create: { width: 2, height: 2, channels: 3, background: '#3cc04c' } }).png().toBuffer())" >/dev/null
echo 'ok: the image analysis library loads in the production image'

compose restart db >/dev/null
sleep 5
expect 200 'health check passes again after a database restart' "$base/api/health"
restarts=$(docker inspect "$(compose ps -q app)" --format '{{.RestartCount}}')
if [ "$restarts" != 0 ]; then echo "FAIL: the app restarted $restarts time(s) when the database restarted"; exit 1; fi
echo 'ok: the app kept running through the database restart'

echo 'Docker smoke test passed.'
