# ClickHouse for Hexclave Deployments (type "server", one volume at /data).
# Build context = the assembled deploy dir (scripts/hexclave-deploy.sh copies everything in).
FROM clickhouse/clickhouse-server:26.8.20.9
COPY clickhouse/config.d/10-hexclave-server.xml clickhouse/config.d/20-hexclave-storage.xml clickhouse/config.d/20-hexclave-storage-local.xml /etc/clickhouse-server/config.d/
COPY hexclave/clickhouse/05-hexclave-paths.xml hexclave/clickhouse/30-hexclave-8gb.xml /etc/clickhouse-server/config.d/
COPY clickhouse/users.d/90-hexclave-users.xml hexclave/clickhouse/95-hexclave-8gb-users.xml /etc/clickhouse-server/users.d/
COPY sql/otel-schema.sql sql/replay-schema.sql /etc/hexclave-obs/sql/
COPY hexclave/clickhouse/initdb/10-hexclave-schema.sh /docker-entrypoint-initdb.d/
COPY scripts/set-retention.sh /usr/local/bin/set-retention.sh
COPY hexclave/clickhouse/entrypoint.sh /usr/local/bin/hexclave-entrypoint.sh
# S3 disk metadata + filesystem cache live on the volume too.
RUN sed -i 's#/var/lib/clickhouse/#/data/clickhouse/#g' /etc/clickhouse-server/config.d/20-hexclave-storage.xml \
 && chmod +x /docker-entrypoint-initdb.d/10-hexclave-schema.sh /usr/local/bin/set-retention.sh /usr/local/bin/hexclave-entrypoint.sh \
 && mkdir -p /data && chown clickhouse:clickhouse /data
# The official entrypoint starts as root, creates every configured dir (data, tmp, disk
# metadata, cache) with the right owner, runs initdb, then drops to the clickhouse user.
ENV CLICKHOUSE_ALWAYS_RUN_INITDB_SCRIPTS=1 \
    CLICKHOUSE_SKIP_USER_SETUP=1
EXPOSE 8123 9000
ENTRYPOINT ["/usr/local/bin/hexclave-entrypoint.sh"]
