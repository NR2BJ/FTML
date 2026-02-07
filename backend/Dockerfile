# Build stage
FROM golang:1.25-alpine AS builder

RUN apk add --no-cache gcc musl-dev

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
    tzdata \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /build/server /app/server

RUN mkdir -p /data

EXPOSE 8080

CMD ["/app/server"]
