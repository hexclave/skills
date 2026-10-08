# OTel Collector (contrib) gateway for Hexclave Deployments.
# The upstream image is distroless (no shell), so the binary is copied onto Alpine to get an
# entrypoint that can turn secret env vars into the bearer token file.
FROM otel/opentelemetry-collector-contrib:0.162.0 AS otel
FROM alpine:3.22
RUN apk add --no-cache ca-certificates tzdata
COPY --from=otel /otelcol-contrib /otelcol-contrib
COPY gateway/otel-collector.yaml /etc/otelcol-contrib/config.yaml
COPY hexclave/gateway/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh && mkdir -p /var/lib/otelcol/queue
EXPOSE 4318
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
