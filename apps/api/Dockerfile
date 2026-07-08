FROM golang:1.22-bookworm AS build
WORKDIR /src
ENV CGO_ENABLED=1
# mattn/go-sqlite3 compila su propio SQLite vía cgo (amalgamation vendorizada):
# solo necesita un compilador C, que la imagen golang:bookworm ya trae.
COPY go.mod ./
RUN go mod download || true
COPY . .
RUN go mod tidy && go build -o /out/api ./cmd/api

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/api /usr/local/bin/api
VOLUME ["/data"]
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/api"]
