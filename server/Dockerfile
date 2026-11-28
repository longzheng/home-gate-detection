# syntax=docker/dockerfile:1
FROM rust:1.95-trixie AS build

WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/app/target \
    cargo build --release --locked && \
    install -Dm755 target/release/home-gate-detection /out/home-gate-detection

FROM debian:trixie-slim

WORKDIR /app
RUN groupadd --gid 1000 gate && useradd --uid 1000 --gid 1000 gate
COPY --from=build /out/home-gate-detection /usr/local/bin/home-gate-detection

USER gate
CMD ["home-gate-detection"]
