# Build stage - use Debian-based image so binary links against glibc (matching Ubuntu runtime)
FROM golang:1.25 AS builder

RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=1 go build -o /build/server .

# Runtime stage - Ubuntu for VAAPI/Intel GPU support
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    vainfo \
    intel-media-va-driver-non-free \
    libva-drm2 \
    libva2 \
    ca-certificates \
    curl \
    tzdata \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /build/server /app/server

RUN mkdir -p /data

EXPOSE 8080

CMD ["/app/server"]
