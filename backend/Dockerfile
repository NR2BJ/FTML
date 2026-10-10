# Build stage - use Debian-based image so binary links against glibc (matching Ubuntu runtime)
FROM golang:1.25-bookworm AS builder

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
    fonts-noto-cjk \
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

# 마운트된 기존 볼륨의 소유권은 빌드로 바뀌지 않는다. 배포 전 별도 이전이 필요하다.
ENV HOME=/home/ftml
ENV XDG_CACHE_HOME=/home/ftml/.cache
RUN mkdir -p /data /home/ftml/.cache \
  && chown -R 1000:1000 /data /home/ftml

USER 1000:1000

EXPOSE 8080

CMD ["/app/server"]
