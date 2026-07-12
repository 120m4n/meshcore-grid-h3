#!/usr/bin/env bash
# Build + push de las imágenes api/web a GHCR, tagueadas con el commit
# corto y "latest". No toca docker-compose.prod.yml ni hace deploy
# remoto — solo produce las imágenes que ese compose consume vía "image:".
#
# Uso:
#   PUBLIC_API_URL=https://map.meshcore.example.com ./infra/deploy.sh
#
# Variables:
#   REGISTRY        default: ghcr.io
#   IMAGE_OWNER     default: owner/org de "git remote origin" (GitHub)
#   PUBLIC_API_URL  obligatoria — origen público donde se sirve el
#                   frontend (NO un subdominio api.* aparte). Astro la
#                   hornea en el build del bundle JS; en runtime el
#                   nginx del contenedor web proxea /api/ al contenedor
#                   api (ver apps/web/nginx.conf), así que el navegador
#                   nunca sale de ese origen.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ -n "$(git status --porcelain)" ]]; then
  echo "⚠️  Hay cambios sin commitear — la imagen se tagueará con el" >&2
  echo "   commit HEAD pero su contenido no va a coincidir exactamente." >&2
fi

REGISTRY="${REGISTRY:-ghcr.io}"
IMAGE_OWNER="${IMAGE_OWNER:-$(git remote get-url origin | sed -E 's#.*[:/]([^/]+)/[^/]+(\.git)?$#\1#' | tr '[:upper:]' '[:lower:]')}"
: "${PUBLIC_API_URL:?Falta PUBLIC_API_URL (origen público del frontend, ej. https://map.meshcore.example.com)}"

COMMIT_SHA="$(git rev-parse --short HEAD)"
API_IMAGE="${REGISTRY}/${IMAGE_OWNER}/meshcore-api"
WEB_IMAGE="${REGISTRY}/${IMAGE_OWNER}/meshcore-web"

echo "==> api: ${API_IMAGE}:${COMMIT_SHA} (+ :latest)"
docker build \
  -t "${API_IMAGE}:${COMMIT_SHA}" -t "${API_IMAGE}:latest" \
  ./apps/api

echo "==> web: ${WEB_IMAGE}:${COMMIT_SHA} (+ :latest) — PUBLIC_API_URL=${PUBLIC_API_URL}"
docker build \
  --build-arg PUBLIC_API_URL="${PUBLIC_API_URL}" \
  -t "${WEB_IMAGE}:${COMMIT_SHA}" -t "${WEB_IMAGE}:latest" \
  ./apps/web

echo "==> push (requiere 'docker login ${REGISTRY}' previo, con permiso write:packages)"
docker push "${API_IMAGE}:${COMMIT_SHA}"
docker push "${API_IMAGE}:latest"
docker push "${WEB_IMAGE}:${COMMIT_SHA}"
docker push "${WEB_IMAGE}:latest"

cat <<EOF

Listo. Para probar las imágenes recién pusheadas:

  cd infra
  cp .env.prod.example .env.prod
  IMAGE_OWNER=${IMAGE_OWNER} IMAGE_TAG=${COMMIT_SHA} \\
    docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --pull always
EOF
