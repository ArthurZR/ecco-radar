#!/bin/bash
# Desliga o eccö RADAR. Seus dados ficam guardados para a próxima vez.
cd "$(dirname "$0")"
docker compose down && echo "RADAR desligado. Seus dados continuam guardados."
read -r -p "Pode fechar esta janela (ou aperte Enter)." _
