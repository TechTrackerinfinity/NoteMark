# NoteMark encrypted sync server

Version 1.1.0 advertises `capabilities.permanentDelete: true` in `/api/health`. A record with `deleted: true` is terminal: subsequent PUTs return 409 with that tombstone even when they supply its current revision. Keep these records across restarts; removing them can allow offline devices to resurrect notes. Update both apps along with this server before using permanent deletion.

This Node.js 24 service stores encrypted note records for the Windows and Android clients. It works on a LAN or behind an HTTPS reverse proxy on an internet server. It has no npm dependencies. It does not connect to Xiaomi Cloud or read the original MIUI Notes database.

Run from the project root:

```powershell
node server/cli.mjs
```

The CLI listens on all interfaces at port `47821` and prints available LAN addresses. The library defaults to loopback. On a private LAN, configure both clients with the same server address, for example `http://192.168.1.50:47821`; Windows Firewall may require allowing this port on the private network profile. HTTP is useful for local development, but it exposes the bearer credential in transit. Use HTTPS for real connections, especially over the internet. The deployment recipe is in `deploy/README.md`.

```js
import { startServer } from './server/index.mjs';
const app = await startServer({ host: '127.0.0.1', port: 47821, dataDir: './data' });
console.log(app.port, app.urls);
await app.close();
```

## Protocol 1

All request and response bodies use JSON. `POST` and `PUT` require `Content-Type: application/json`. UUIDs are normalized to lowercase. Binary fields use canonical base64url without padding.

| Request | Result |
| --- | --- |
| `GET /api/health` | `200 {"ok":true,"protocol":1}` |
| `POST /api/vaults` with `{id,token}` | `201 {id}`; token must encode 32 random bytes |
| `GET /api/vaults/:id/notes` | `200 {notes:[record,...]}` |
| `PUT /api/vaults/:id/notes/:noteId` with `{baseRevision,iv,ciphertext,deleted}` | `200 record`; `baseRevision:0` creates the record |

All note requests require `Authorization: Bearer <token>`. Unknown vaults and incorrect credentials both return `401 {"error":"unauthorized"}`. Tokens in query parameters are rejected. A duplicate vault creation returns `409 {"error":"vault_exists"}` and never resets its credentials. A client recovering from a lost creation response can authenticate to the existing vault with its original token.

A record is `{id,revision,iv,ciphertext,deleted,updatedAt}`. Revision is a positive integer and `updatedAt` is the server's ISO timestamp. The IV encodes exactly 12 bytes. Ciphertext contains AES-GCM ciphertext followed by its 16-byte authentication tag, with a maximum of 1 MiB plus the tag. The server checks shape and size; it cannot verify the GCM tag because it has no encryption key. The client must authenticate decrypted content and bind records to their expected note IDs.

Each successful write increases revision by one. Stale writes return `409 {"error":"conflict","current":record}`; a missing record is represented by `current:null`. Clients must resolve or preserve conflicting edits before retrying against the returned revision. Deletion uses a new encrypted record with `deleted:true`; tombstones remain in listings and survive restarts. There is no destructive DELETE endpoint.

Only the documented request fields are accepted. Titles, note text, checklists, tags, folders and encryption keys belong inside client encryption, never in server request metadata. The server sees vault IDs, note IDs, revisions, ciphertext lengths, deletion flags and modification times. Its data files contain SHA-256 token digests rather than bearer tokens. There is no account service, password reset, vault enumeration, or server-side decryption. Keep the client pairing/recovery information separately from server backups.

Browser and WebView clients may send CORS requests from arbitrary origins; authorization uses an explicit bearer header and cookies are not used. An origin that does not possess the credential has no access to notes. No request body, Authorization header, token, or note content is logged by this service.

## Configuration

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | CLI bind address |
| `PORT` | `47821` | HTTP listener port |
| `DATA_DIR` | `./data` | Persistent JSON storage directory |
| `ALLOW_VAULT_CREATION` | `true` | Set to `false` after creating your vault to block new vaults; pairing existing vaults still works |
| `TRUST_PROXY` | `false` | Set to `true` only when all connections come through a trusted reverse proxy; use forwarded client IP for rate limits |
| `MAX_VAULTS` | `100` | Total vault count |
| `MAX_NOTES_PER_VAULT` | `5000` | Includes deletion tombstones |
| `MAX_VAULT_BYTES` | `67108864` | 64 MiB serialized vault limit |
| `MAX_TOTAL_BYTES` | `536870912` | 512 MiB serialized server storage limit |
| `CREATION_RATE_LIMIT` | `10` | Vault creation attempts per client IP per hour |
| `AUTH_RATE_LIMIT` | `120` | Note requests, including failed auth, per client IP per minute |

`startServer` additionally accepts `maxBodyBytes` (2 MiB), `maxCiphertextBytes` (1 MiB + 16), `creationWindowMs`, `authWindowMs`, and `onError`. `onError` receives a generic diagnostic with no request data. Request failures use `{error:string}`; quota failures return `507`, rate limits `429` with `Retry-After`, malformed input `400`, and oversized bodies `413`.

Changes are serialized per vault and persistent writes are globally serialized for total quota accounting. Each write flushes a temporary file and atomically renames it over the previous version; directory flush is attempted where supported. A failed quota check does not replace stored records. Temporary files from interrupted writes are ignored. Run exactly one server process per storage directory; horizontal replicas and shared-directory concurrent processes are not supported. Storage is loaded and cached by vault, and listing returns the entire vault, so this service is intended for personal notes rather than a large public SaaS. Back up the complete data directory together with client-held recovery information.

Run tests:

```powershell
node --test test/server.test.mjs
```
