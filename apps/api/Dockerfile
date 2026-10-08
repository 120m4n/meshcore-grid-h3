# La etapa de build corre en la arquitectura del host (BUILDPLATFORM) y
# cross-compila a TARGETARCH: así no se emula gcc bajo QEMU/Rosetta (que
# falla con "cc1: Exec format error" en Apple Silicon).
FROM --platform=$BUILDPLATFORM golang:1.22-bookworm AS build
ARG BUILDARCH
ARG TARGETARCH
WORKDIR /src
# mattn/go-sqlite3 compila su propio SQLite vía cgo (amalgamation vendorizada):
# solo necesita un compilador C; si host y destino difieren, el cross-gcc.
RUN set -e; \
    case "${TARGETARCH}" in amd64) triple=x86_64-linux-gnu; pkg=x86-64-linux-gnu ;; arm64) triple=aarch64-linux-gnu; pkg=aarch64-linux-gnu ;; esac; \
    if [ "${BUILDARCH}" != "${TARGETARCH}" ]; then \
      apt-get update && apt-get install -y --no-install-recommends gcc-${pkg} libc6-dev-${TARGETARCH}-cross; rm -rf /var/lib/apt/lists/*; \
      echo "export CC=${triple}-gcc" > /cc.env; \
    else echo "export CC=gcc" > /cc.env; fi
ENV CGO_ENABLED=1 GOOS=linux GOARCH=${TARGETARCH}
COPY go.mod ./
RUN go mod download || true
COPY . .
RUN . /cc.env && go mod tidy && go build -o /out/api ./cmd/api

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/api /usr/local/bin/api
VOLUME ["/data"]
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/api"]
