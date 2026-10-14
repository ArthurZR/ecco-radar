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

# Text detection must work offline from the packaged model. The image is a 646-byte PNG of the
# words "RADAR 2001", embedded here because the slim image has no fonts to render text with.
compose exec -T app node --input-type=module -e "
  const { detectText, stopOcr } = await import('./dist/lib/ocr.js');
  const r = await detectText(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAaQAAABaAQMAAADNbbCrAAAABlBMVEUODg7////APDf/AAAACXBIWXMAAAsTAAALEwEAmpwYAAACJklEQVRYw+3W3Y3cIBAH8EGcwlsogRZSQCRSUgqIznR2lOISkPIQHpAn/2Egd1GwN4nyFHlXyOzYP9t8DUv8F59Ct7rVrW51q/9HvSzVTg4Vy43kFilogIvp0X7cw0JRPwcVhsKFnGlD0WNaqm0oPIOCBjihlij2QksVee8KL0ReA0yoydNRjrWS+4syfKgKqJCfpa6VH4qm8qhkh4iX9y4rFbOXdjdbaTvQth7AL1dtcc2UE1Uc509bs0xbe3IaaK47fJstH1aqTpWiKgSqO2z1IqE+r1RznLKoHNs7O5Q/bBElx3KqItQealdtql7M11O1iyqhvjcaYIYIhxH17UzRr6qpCmy4nPSG2YMoX7zRAJTbH6oyFU1VofhCFXeoqr4E0vGC8pcqpNHL/cIElbycm4qWSuboG7X1eSh3E7Wfq6BzQFTsSq7K8cGz4lDF55g3XV8MftUuLN3mXlXUtXwQXyvDFetYFZ6jeaNh4K7GC4txqpC6kmRV5efVKP+sggRwyvGch2uVtoKc0ee8qoR27V6U/Q2VI/1QOfBcX2uV41vlJYCOj6p6365UnwUkeQMtKkOh92feuFaVnk2fH7vkQ+nG0nPOyZzH4ELh7dByLBBRkolnPrxQ6QvaNlTxXc3ce7Yqh5Ixa1bzoaqe588UulqUG6qqYhp7yjrbWKj8sa+YrppVpXvY9kChUXyYV9X3Synhj/blOMr9L+VWt7rVrf6h+g7gkx3I8dTJ6AAAAABJRU5ErkJggg==', 'base64'));
  await stopOcr();
  if (!/RADAR/.test(r.text)) { console.error('OCR read: ' + JSON.stringify(r.text)); process.exit(1); }
" >/dev/null
echo 'ok: text detection runs offline in the production image'

compose restart db >/dev/null
sleep 5
expect 200 'health check passes again after a database restart' "$base/api/health"
restarts=$(docker inspect "$(compose ps -q app)" --format '{{.RestartCount}}')
if [ "$restarts" != 0 ]; then echo "FAIL: the app restarted $restarts time(s) when the database restarted"; exit 1; fi
echo 'ok: the app kept running through the database restart'

echo 'Docker smoke test passed.'
