#!/bin/bash
# Liga o eccö RADAR no seu computador (Mac). Clique duas vezes neste arquivo.
# Na primeira vez ele cria as configurações, monta o app e pede uma senha para o seu login.
# Nada aqui publica nada em lugar nenhum; o RADAR fica só em http://localhost:8787.
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$1"; read -r -p "Aperte Enter para fechar." _; exit 1; }

say "eccö RADAR: ligando…"

if ! command -v docker >/dev/null 2>&1; then
  open "https://www.docker.com/products/docker-desktop/" || true
  fail "O Docker Desktop não está instalado. Abri a página de download: instale, abra o Docker uma vez e clique de novo neste arquivo."
fi

if ! docker info >/dev/null 2>&1; then
  say "Abrindo o Docker Desktop (pode levar um minuto)…"
  open -a Docker || true
  for _ in $(seq 1 90); do docker info >/dev/null 2>&1 && break; sleep 2; done
  docker info >/dev/null 2>&1 || fail "O Docker não respondeu. Abra o Docker Desktop, espere ele dizer que está rodando e clique de novo neste arquivo."
fi

if [ ! -f .env ]; then
  say "Primeira vez: criando as configurações."
  read -r -p "Seu e-mail (vai ser o seu login no RADAR): " EMAIL
  [ -n "$EMAIL" ] || fail "Preciso de um e-mail. Clique de novo no arquivo para recomeçar."
  umask 077
  cat > .env <<ENV
# Criado pelo "Iniciar RADAR.command". Guarde este arquivo só no seu computador.
SESSION_SECRET=$(openssl rand -hex 32)
APP_ORIGIN=http://localhost:8787
PORT=8787
POSTGRES_PASSWORD=$(openssl rand -hex 16)
SOURCE_CONTACT=$EMAIL
RADAR_LOGIN=$EMAIL
FLICKR_API_KEY=
TUMBLR_API_KEY=
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-opus-5-5
ENV
fi

say "Montando e ligando o RADAR. Na primeira vez isso leva alguns minutos…"
docker compose up -d --build --wait || fail "Algo deu errado ao ligar. Copie as mensagens acima e mande para a Claude."

USERS=$(docker compose exec -T db psql -U radar -d radar -Atc "SELECT count(*) FROM users" 2>/dev/null || echo 0)
if [ "${USERS:-0}" = "0" ]; then
  LOGIN=$(grep -E '^RADAR_LOGIN=' .env | cut -d= -f2-)
  [ -n "$LOGIN" ] || read -r -p "Seu e-mail para o login: " LOGIN
  say "Crie a senha do seu login ($LOGIN). Mínimo de 12 caracteres; ela não aparece enquanto você digita."
  while true; do
    read -r -s -p "Senha: " P1; echo
    read -r -s -p "Repita a senha: " P2; echo
    if [ "$P1" != "$P2" ]; then echo "As senhas não são iguais. Tente de novo."; continue; fi
    if [ ${#P1} -lt 12 ]; then echo "A senha precisa ter pelo menos 12 caracteres."; continue; fi
    break
  done
  RADAR_PASSWORD="$P1" docker compose exec -T -e RADAR_PASSWORD app node dist/auth/create-user-cli.js "$LOGIN" "Arthur" \
    || fail "Não consegui criar o login. Copie as mensagens acima e mande para a Claude."
fi

# RADAR switches itself off when you are done: once every RADAR tab in the browser has been closed
# (checked every few seconds), or when this window is closed or Enter is pressed. Data is kept.
trap 'docker compose down >/dev/null 2>&1' EXIT HUP INT TERM
MAIN_PID=$$
(
  SAW_TAB=0
  while sleep 5; do
    kill -0 "$MAIN_PID" 2>/dev/null || exit 0
    STATE=$(curl -fsS --max-time 5 http://localhost:8787/api/presence 2>/dev/null || true)
    echo "$STATE" | grep -q '"openTabs":[1-9]' && SAW_TAB=1
    # Only a tab opened during this run counts, so a stale state never stops a fresh start.
    if [ "$SAW_TAB" = 1 ] && echo "$STATE" | grep -q '"closed":true'; then
      kill -TERM "$MAIN_PID" 2>/dev/null
      exit 0
    fi
  done
) &

say "Pronto! Abrindo http://localhost:8787 no navegador."
open "http://localhost:8787" || true
echo "Use o Chrome ou o Firefox."
echo
echo "Quando terminar, feche a aba do RADAR no navegador: o RADAR desliga sozinho em meio minuto."
echo "Fechar esta janela (ou apertar Enter) também desliga o RADAR."
read -r _ || true
