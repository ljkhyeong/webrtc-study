# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:22.23.0-alpine3.24
ARG CADDY_IMAGE=caddy:2.10.2-alpine
ARG JAVA_BUILD_IMAGE=eclipse-temurin:21.0.11_10-jdk-alpine-3.23
ARG JAVA_RUNTIME_IMAGE=eclipse-temurin:21.0.11_10-jre-alpine-3.23
ARG COTURN_IMAGE=coturn/coturn:4.14.0-r0-alpine

FROM ${NODE_IMAGE} AS web-build
WORKDIR /workspace

COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/rtc-core/package.json packages/rtc-core/package.json

RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

COPY tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY packages/rtc-core packages/rtc-core
COPY apps/web apps/web

ARG VITE_STUN_URLS=stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302
ARG VITE_ICE_TRANSPORT_POLICY=all
RUN VITE_STUN_URLS="${VITE_STUN_URLS}" \
    VITE_ICE_TRANSPORT_POLICY="${VITE_ICE_TRANSPORT_POLICY}" \
    npm run build:packages \
    && VITE_STUN_URLS="${VITE_STUN_URLS}" \
       VITE_ICE_TRANSPORT_POLICY="${VITE_ICE_TRANSPORT_POLICY}" \
       npm run build -w @round/web

FROM ${CADDY_IMAGE} AS web-runtime
COPY ops/caddy/Caddyfile /etc/caddy/Caddyfile
COPY --from=web-build /workspace/apps/web/dist /srv

EXPOSE 80 443 443/udp
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=5 \
    CMD wget -q -T 2 -O /dev/null http://127.0.0.1:8080/healthz || exit 1

FROM ${JAVA_BUILD_IMAGE} AS signaling-build
WORKDIR /workspace

COPY gradlew settings.gradle ./
COPY gradle gradle
COPY apps/signaling/build.gradle apps/signaling/build.gradle
COPY apps/signaling/src apps/signaling/src

RUN chmod 0755 gradlew
RUN --mount=type=cache,target=/root/.gradle \
    ./gradlew --no-daemon :apps:signaling:bootJar \
    && cp apps/signaling/build/libs/signaling-*.jar /workspace/signaling.jar

FROM ${JAVA_RUNTIME_IMAGE} AS signaling-runtime
RUN addgroup -S -g 10001 round \
    && adduser -S -D -H -u 10001 -G round round

WORKDIR /opt/round
COPY --from=signaling-build --chown=10001:10001 /workspace/signaling.jar ./signaling.jar

ENV JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=75.0 -XX:+ExitOnOutOfMemoryError -Djava.io.tmpdir=/tmp"
USER 10001:10001
EXPOSE 8787
STOPSIGNAL SIGTERM
ENTRYPOINT ["java", "-jar", "/opt/round/signaling.jar"]
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
    CMD wget -q -T 2 -O /dev/null http://127.0.0.1:8787/healthz || exit 1

FROM ${COTURN_IMAGE} AS turn-runtime
COPY --chmod=0444 ops/turn/turnserver.conf /etc/coturn/round-turnserver.conf
COPY --chmod=0555 ops/turn/entrypoint.sh /usr/local/bin/round-turn-entrypoint

USER root:root
ENTRYPOINT ["/usr/local/bin/round-turn-entrypoint"]
CMD []
HEALTHCHECK --interval=20s --timeout=5s --start-period=10s --retries=5 \
    CMD turnutils_stunclient -p 3478 127.0.0.1 >/dev/null 2>&1 || exit 1
