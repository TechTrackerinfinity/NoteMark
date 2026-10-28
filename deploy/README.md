# Internet HTTPS deployment

Use a small Linux server that stays online and a DNS name you control. Point the DNS `A` record (and `AAAA` only if IPv6 works) to that server. Install Docker Engine and the Compose plugin. Permit inbound TCP ports 80 and 443; UDP 443 is optional for HTTP/3. The compose configuration publishes only the HTTPS proxy. Port 47821 stays inside the Docker network.

Copy this NoteMark project to the server. From the project root:

```sh
cp deploy/.env.example deploy/.env
nano deploy/.env
```

Replace `notes.example.com` with the actual DNS name and `you@example.com` with an email address for certificate notices. Keep `ALLOW_VAULT_CREATION=true` while creating the first vault. Then:

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build
docker compose --env-file deploy/.env -f deploy/compose.yaml ps
curl --fail https://notes.example.com/api/health
```

The health response should be `{"ok":true,"protocol":1}`. Caddy obtains and renews a public TLS certificate using the supplied DNS name. DNS must resolve correctly and ports 80 and 443 must reach this server for certificate provisioning.

Set the sync URL in the Windows and Android apps to `https://notes.example.com`. Create an encrypted vault on one device, and use that device's pairing information to connect the other. Both devices must use the same vault, credential and encryption key. A note created or changed on one device then appears on the other after synchronization, whether the devices use the same Wi-Fi or different internet connections. The server must remain online for devices to exchange changes. It does not directly connect devices while it is offline.

After creating the vault, edit `deploy/.env` to set `ALLOW_VAULT_CREATION=false` and apply:

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d
```

This blocks new vault creation while existing vaults keep syncing and pairing. There is no public vault list or admin API. Pairing information grants access to the encrypted vault and includes client secrets; store it privately. Losing all client encryption keys cannot be repaired from the server database.

## Storage and backups

Notes use the persistent Docker volume `mira-notes-data`. Certificates use `mira-notes-caddy-data` and `mira-notes-caddy-config`. Ordinary container rebuilds preserve these volumes. Do not run `docker compose down -v` unless you intend to remove their contents.

For a consistent ciphertext backup, briefly stop the sync service and copy its data directory:

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml stop sync
docker compose --env-file deploy/.env -f deploy/compose.yaml cp sync:/data ./mira-notes-backup
docker compose --env-file deploy/.env -f deploy/compose.yaml start sync
```

Keep this backup private; it contains ciphertext, metadata, and bearer token digests. Keep client recovery information in a separate safe place. Restore a complete snapshot into an empty data directory with the server stopped, using ownership writable by the container's `node` user (UID 1000). Do not merge old snapshots into a running server or run multiple sync processes against one volume.

## Operation

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml logs --tail=100 sync caddy
```

The API does not log credentials or request bodies. The supplied Caddy configuration has no access log. Keep the sync service's raw HTTP port unpublished when `TRUST_PROXY=true`, as in this configuration, so arbitrary clients cannot spoof the IP address used for rate limiting. The default limits suit a private service; raise limits deliberately for additional users. This recipe has been supplied as files and does not provision infrastructure or deploy anything automatically.
