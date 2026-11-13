# Cluster storage

One drive, many machines' disks.

```
                    browser / mdrive CLI
                            |
                 +----------+-----------+
                 |  Coordinator :4400   |   metadata, refcounts, placement
                 |  data/drive.db       |
                 +----------+-----------+
                            |
        +-------------------+-------------------+
        |                   |                   |
  +-----+------+     +------+------+     +------+------+
  | node-1     |     | node-2      |     | node-3      |
  | :4501      |     | :4501       |     | :4501       |
  | blobs only |     | blobs only  |     | blobs only  |
  +------------+     +-------------+     +-------------+
```

The coordinator keeps every row that describes *what* exists; each node keeps
bytes and nothing else. A node has no database, no users, no concept of a folder —
which is what makes it safe to run one on a machine you do not fully trust.

## Why this shape

| Alternative | Why not |
| --- | --- |
| One big disk | The problem being solved. |
| NFS/SMB mount of each box | One flaky link stalls every write; POSIX locking over the network is its own class of bug. |
| S3/MinIO | A valid answer already supported (`DRIVE_STORAGE=s3`). Use it if you would rather run a real object store than this. |
| Full distributed store (Cassandra, Ceph) | Enormous operational surface for a handful of machines. The coordinator is a single source of truth for placement, and that is a feature: fewer states to reason about. |

## Coordinator setup

```sh
DRIVE_STORAGE=cluster \
DRIVE_CLUSTER_WRITES=2 \
node apps/server/src/index.js
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `DRIVE_STORAGE` | `local` | Set to `cluster` |
| `DRIVE_CLUSTER_WRITES` | `1` | Replicas that must acknowledge before an upload is accepted |
| `DRIVE_CLUSTER_RESERVE_BYTES` | `524288000` | Headroom kept free on every node (500 MiB) |
| `DRIVE_CLUSTER_TIMEOUT_MS` | `120000` | Per-request timeout to a node |

**`DRIVE_CLUSTER_WRITES=1` is a warning, not a default to keep.** With one
replica, losing that machine loses the files it held, and the API already answered
`201`. Set it to 2 as soon as you have two nodes; the coordinator refuses an
upload it cannot place on that many rather than accepting a weaker guarantee.

## Node setup

On each machine that contributes disk:

```sh
# 1. start the node with a secret you choose (16+ characters)
DRIVE_NODE_DIR=/srv/drive-blobs \
DRIVE_NODE_TOKEN='a-long-secret-you-keep' \
DRIVE_NODE_CAPACITY_BYTES=500000000000 \
PORT=4501 HOST=0.0.0.0 \
node apps/server/bin/storage-node.js

# 2. enrol it from the coordinator
mdrive node add nas-1 --endpoint http://10.0.0.5:4501 --node-token 'a-long-secret-you-keep'
```

The coordinator **proves the pair immediately** — it asks the node for `/health`
with that token and refuses the enrolment if the node does not answer. A typo
fails here, not during an upload at 2 a.m.

| Node variable | Default | Meaning |
| --- | --- | --- |
| `DRIVE_NODE_DIR` | — | Required. Where blobs live. Same `<root>/<xx>/<sha256>` layout as the local backend. |
| `DRIVE_NODE_TOKEN` | — | Required. The shared secret. Without it the node refuses to start, because an open node is a public write endpoint. |
| `DRIVE_NODE_NAME` | `storage-node` | Reported in `/health` and the coordinator's table. |
| `DRIVE_NODE_CAPACITY_BYTES` | `0` | Advertised ceiling. `0` means "report only what is used" — the coordinator then treats capacity as unknown, so declare it if you want placement to avoid filling the disk. |
| `PORT` / `HOST` | `4501` / `127.0.0.1` | Bind address. A node on another machine needs `HOST=0.0.0.0`. |

## What a node accepts

Every route needs `Authorization: Bearer <token>` except `/health`.

| Method | Path | Behaviour |
| --- | --- | --- |
| GET | `/node/v1/health` | `{ ok, name, capacityBytes, usedBytes, blobs, uptimeSeconds }` |
| PUT | `/node/v1/blobs/:sha256` | Raw body; **verifies the digest** and answers `409 CHECKSUM_MISMATCH` with the actual hash on mismatch, deleting what it wrote |
| HEAD | `/node/v1/blobs/:sha256` | `200` with `content-length`, or `404` |
| GET | `/node/v1/blobs/:sha256` | Bytes, with `Range`/`206` support so a download can resume |
| DELETE | `/node/v1/blobs/:sha256` | `200`; deleting a missing blob is not an error |

## Capacity

`usedBytes` always comes from the node — only it knows. `capacityBytes` is
different: a node started without `DRIVE_NODE_CAPACITY_BYTES` reports `0`, which
means *not declared*, not *no space*. The coordinator lets a declared ceiling win
and never erases one by reading a `0`.

Placement picks the node with the most free space (capacity − used − reserve),
with `priority` as a tie-break so an operator can still say "prefer this box".

## Durability

- **Uploads are acknowledged only when `writes` replicas have the bytes.** If
  fewer nodes have room, the upload fails with `INSUFFICIENT_REPLICAS` instead of
  succeeding with a weaker guarantee.
- **A blob that already exists is topped up, not skipped.** Raising `writes` from
  1 to 2 repairs the drive on the next write of those bytes; nothing stays
  single-replica by accident.
- **Reads fall through.** Any replica answers; a dead node is skipped, not fatal.
- **Deletion removes every known replica** the placement table lists.

```sh
mdrive cluster status      # which blobs are short, and what that costs in bytes
mdrive cluster replicate   # copy until each blob meets the target; bounded per run
```

## Operating

```sh
# add a box
mdrive node add nas-1 --endpoint http://10.0.0.5:4501 --node-token "$T" --capacity 500GiB

# retire a box: stop new writes, move the bytes, then remove it
mdrive node update nas-1 --state draining
mdrive cluster replicate --limit 500      # repeat until "still under-replicated 0"
mdrive node remove nas-1

# one node got replaced
mdrive node add nas-2 --endpoint http://10.0.0.6:4501 --node-token "$T2"
mdrive cluster replicate
```

`node remove` **refuses while the node holds blobs** with `409 NODE_NOT_EMPTY`.
Deleting the row would forget where those bytes are — draining is the supported
path, not force-deleting.

### Rotating the coordinator key

Node tokens are sealed with the coordinator's own key (`JWT_SECRET`, or the
generated `data/.jwt-secret`). Changing that key invalidates every sealed token
at once, and every node becomes unusable until re-adopted:

```sh
mdrive node verify <id> --node-token "$T"    # seals it again with the new key
```

Or via the API: `POST /api/v1/storage/nodes/:id/verify { token }`. It proves the
token against the node itself before storing it, so a wrong value cannot lock out
a working node.

## What is deliberately missing

| Missing | Why, and what to do instead |
| --- | --- |
| Automatic rebalancing | Moving a blob is a real copy of real bytes. `cluster replicate` is deliberate and bounded; a background mover would compete with user downloads for bandwidth with no way to say "not now". |
| Erasure coding | Replication is simple to reason about and to audit. For a handful of machines the storage overhead is the cheaper cost. |
| Multi-coordinator / HA | The coordinator is a single process with SQLite. Two of them pointing at one database is SQLite's problem, not this feature's. Back up `data/` and accept a restart. |
| Encrypted node disks | A node stores whatever it is given, in the clear. Use full-disk encryption on the node if the machine is not physically trusted. |
| Automatic failover detection | A node is skipped when a request fails; there is no heartbeat daemon flipping states in the background. `mdrive node --probe` is the on-demand check. |
