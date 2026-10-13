**English · [Русский](README.ru.md)**

<p align="center">
  <img src="web/brand-mark.png" width="100" height="100" alt="27G-StorageS3 cyan cube logo">
</p>
<h1 align="center">27G-StorageS3</h1>
<p align="center"><strong>Your data. Your servers. One clear console.</strong></p>
<p align="center">Object storage with an S3 API, an English and Russian web console, and clustered storage nodes.</p>
<p align="center">
  <a href="https://github.com/gadmin2151/27G-StorageS3/releases/latest"><img src="https://img.shields.io/github/v/release/gadmin2151/27G-StorageS3?color=28D7EF&amp;label=release" alt="Latest release"></a>
  <a href="https://github.com/gadmin2151/27G-StorageS3/actions/workflows/ci.yml"><img src="https://github.com/gadmin2151/27G-StorageS3/actions/workflows/ci.yml/badge.svg" alt="CI and release"></a>
  <a href="docs/INSTALLATION.md"><img src="https://img.shields.io/badge/Docker-amd64%20%7C%20arm64-28D7EF" alt="Docker: amd64 and arm64"></a>
</p>
<p align="center">
  <a href="#quick-install">Install</a> ·
  <a href="#why-27g-storages3">Advantages</a> ·
  <a href="#comparison-with-other-storage-systems">Compare</a> ·
  <a href="#documentation">Documentation</a>
</p>

---

27G-StorageS3 brings everyday file operations and storage administration into one web console. Upload a photo, create an expiring link, restore an earlier version, or connect another server. Designed for home labs, development and pilot deployments on your own infrastructure.

> **Status: experimental version 0.3.3.** The S3 API is partially implemented. Read the [limitations](#current-limitations) and [compatibility matrix](docs/S3-COMPATIBILITY.md) before using it for critical data.

The console starts in **English**. After signing in, open **Settings → Language**, select **Русский**, and save to use Russian. Your choice is stored in your account and follows you when you sign in on another device. Other users keep their own preferences.

## Quick install

**Linux amd64 / arm64 · Docker Engine + Compose 2.20+ · root or sudo**

Requires `bash`, `curl`, `python3` and `sha256sum`. On Debian/Ubuntu, the wizard can offer to install Docker if it is missing. You do not need Node.js on the host.

```sh
curl -fsSL https://github.com/gadmin2151/27G-StorageS3/releases/latest/download/install.sh | bash
```

Prefer Russian installation dialogs? Use `install-ru.sh` instead:

```sh
curl -fsSL https://github.com/gadmin2151/27G-StorageS3/releases/latest/download/install-ru.sh | bash
```

Both installers support the same options and update process. The installer language does not change the default console language or anyone's account preference.

The wizard asks for the directory, port, network interface and optional public address. It uses dialog boxes when `whiptail` is available, or text prompts otherwise. The release archive is verified with SHA-256; prebuilt images are available in GHCR.

**1. Open the console:** [http://127.0.0.1:9000/console/](http://127.0.0.1:9000/console/) with the default configuration.

**2. Read the initial setup token** on the server:

```sh
sudo docker compose -f /opt/27g-storage-s3/compose.yaml exec -T app cat /data/setup.token
```

**3. Sign in:** username `admin`, password `admin!123`, and the token above. Set your own password of at least 12 characters in Settings, create a bucket and upload your first file. If you selected a different installation directory, adjust the path to `compose.yaml`.

<details>
<summary><strong>Installing on a remote server?</strong></summary>

By default, the port is only accessible on the server itself. Create an SSH tunnel from your computer:

```sh
ssh -L 9000:127.0.0.1:9000 user@server
```

Then open the local console address above. For public access, configure DNS, HTTPS and the service address using the [operations guide](docs/OPERATIONS.md#https) (Russian).

</details>

### Update with the same command

Run either installation command again. The wizard detects an installation it created and offers a compatible update: **the same Docker volume is retained; objects and databases are not copied**. Terabytes of stored files do not need to be duplicated during an update.

The container is briefly stopped. Releases with an incompatible storage contract are rejected before shutdown; a failed startup can revert to the previous image. This process supports single-server installations created by the wizard. Manual and HA deployments are maintained separately. [Options and update procedure →](docs/INSTALLATION.md) (Russian)

### Automatic init in one command

For a **new single-server installation** with Docker Engine already installed, the prebuilt image initializes itself before starting. No source checkout or separate init container is needed:

```sh
docker run -d --name 27g-storage-s3 --restart unless-stopped --init \
  --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --tmpfs /tmp:size=64m,mode=1777 --stop-timeout 35 \
  -p 127.0.0.1:9000:9000 \
  --mount type=volume,src=27g-storage-s3-data,dst=/data \
  -e INIT_BUCKET=app-data \
  ghcr.io/gadmin2151/27g-storage-s3:0.3.3
```

Open [http://127.0.0.1:9000/console/](http://127.0.0.1:9000/console/), then read your generated credentials:

```sh
docker exec 27g-storage-s3 cat /data/init-credentials.json
```

This creates `admin` with a random password, a private `app-data` bucket and a bucket-scoped S3 access key + secret key. The administrator signs in with that password without a setup token. Initialization is recorded on the persistent volume; restarting does not reset credentials or settings. Objects and databases are not copied.

For several users, buckets, quotas, public-read policies or supplied secret files, see [first-start configuration](docs/INITIALIZATION.md), including the source-based Compose/init-container option. This manual deployment is separate from the installation wizard and its managed-update procedure. Keep the same volume during maintenance; use the wizard's update process for an existing wizard installation.

## The console in action

A graphite interface with cyan accents and actions beside each object: preview, history, sharing and downloading.

![Buckets and objects: uploads, access policies, history and temporary links](docs/images/objects-v03.jpg)

<details>
<summary><strong>View the image preview screenshot</strong></summary>

![Image preview inside the web console](docs/images/preview-v03.jpg)

</details>

<details>
<summary><strong>View the storage overview screenshot</strong></summary>

![Overview: objects, capacity, RAM cache and node status](docs/images/overview-v02.jpg)

</details>

<sub>Actual console screenshots with demonstration data, in Russian: objects and preview from v0.3, overview from v0.2. Test environment figures are not benchmark results.</sub>

## Why 27G-StorageS3

| Advantage | What it means in practice |
|:---|:---|
| **Web console first** | Buckets, files, S3 keys, users, cluster and settings in English or Russian. Built-in Wiki keeps guidance close at hand. |
| **Straightforward installation and updates** | One command, an interactive wizard and prebuilt Docker images. Compatible updates use the existing volume without copying its contents. |
| **Easy sharing with people** | Image and text previews, expiring links with configurable lifetime and revocation. Recipients do not need an account. |
| **Recovery from everyday mistakes** | The current file and four earlier versions, a trash bin, and restoration from the console. Backups remain a separate task. |
| **Grow on your own servers** | Object-level RAID0 / RAID1 / RAID10, a one-command agent setup, data migration and replica checks through a wizard. |
| **Control resources and access** | Bounded queues, streamed uploads, configurable RAM cache, MFA, roles, quotas and monitoring in one system. |

A single instance needs no external database server or Redis: the catalog uses SQLite. The application uses standard Node.js modules without external npm dependencies. Docker, networking and disks are prepared on the hosts; HA requires a separate arbiter.

## Comparison with other storage systems

27G-StorageS3 focuses on everyday administration of your own S3 service through its integrated console. The comparison explains where this is useful; it is not a performance or reliability ranking.

| System | When the 27G-StorageS3 approach is useful |
|:---|:---|
| **MinIO Community** | When you want users, access controls and storage in one bilingual console. After the upstream Community Console was simplified, Users / Policy / Config operations moved to `mc`. [MinIO team response](https://github.com/minio/minio/issues/21407). |
| **Garage** | When you want the console, file previews and Wiki included with the server. Garage documents TOML and CLI setup; [Garage Web UI](https://github.com/khairul169/garage-webui) is a separate project. [Garage guide](https://garagehq.deuxfleurs.fr/documentation/quick-start/). |
| **Ceph Object Gateway** | When a standalone S3 server with additional nodes later is sufficient. A single 27G-StorageS3 instance uses the application and SQLite; RGW runs on a [Ceph Storage Cluster](https://docs.ceph.com/en/squid/radosgw/). Ceph also provides its own [Dashboard](https://docs.ceph.com/en/squid/mgr/dashboard/). |
| **Amazon S3** | When data should live on your Linux servers and disks, including a local network, without an AWS account. [Amazon S3](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html) is a managed service; [S3 on Outposts](https://docs.aws.amazon.com/AmazonS3/latest/s3-outposts/S3onOutposts.html) uses AWS infrastructure. |

<sub>Sources checked on October 12, 2026. The MinIO row refers to upstream Community, not AIStor or independent forks. 27G-StorageS3 currently has less API coverage and operational testing than mature systems.</sub>

## Available features

| Area | Capabilities |
|:---|:---|
| **S3 for applications** | AWS Signature V4, path-style, presigned GET/PUT, resumable multipart, Range GET, checksum and pagination. Objects up to **5 GiB**, including multipart. |
| **Files in the browser** | Drag-and-drop, upload progress and queue, PNG/JPEG/GIF/WebP/AVIF and text previews, five versions, trash, temporary links lasting **1 hour to 7 days**. |
| **Bucket policy** | Private by default; allow public reads by exact path or selected prefixes. Anonymous object listings remain disabled. |
| **Users** | Admin / operator / viewer, personal language preference, TOTP MFA, user and bucket quotas. S3 keys can be scoped to buckets, prefixes, actions and expiration. |
| **Cluster and disks** | Storage nodes, migration, replica verification and repair. A separate agent connects directories, existing ext4/XFS/Btrfs filesystems, SMB 3 and NFSv4 without formatting. |
| **Monitoring** | Node state, queue, memory, p50/p95/p99 latency, console alerts and protected Prometheus metrics. Audit pages of 10 / 25 / 50 events. |
| **Addresses and releases** | Service domain for new links, separate CORS origins and an HTTPS configuration. GitHub Actions builds and releases, amd64 / arm64 images in GHCR. |

### Choose a storage layout

| Mode | Nodes | Object placement | Use case |
|:---|:---:|:---|:---|
| **RAID0** | 1 or more | One copy of each object on one node | Pooling capacity without mirroring |
| **RAID1** | 2 or more | Every object copied to every selected node | Mirroring data |
| **RAID10** | Even number, at least 4 | Objects distributed across mirrored pairs | Combining distribution with duplication |

These are **object-level RAID equivalents**: entire files are placed on nodes. RAID0 does not protect against node loss; mirrored writes require all mandatory copies to be confirmed. Independent servers and disks are needed for independent failure domains. Coordinator failover is configured separately: [master/slave with an etcd arbiter](docs/HA.md).

Connect another server through **Cluster → Connect server**: generate a command, run it on a Linux server with Docker, and check that the agent appears. [Disks and agents →](docs/DISKS.md)

## Current limitations

- **Partial S3 API.** Full IAM, STS, lifecycle, CopyObject, Object Lock, S3 SSE and several other operations are not implemented. See the [compatibility matrix](docs/S3-COMPATIBILITY.md).
- **HA is evolving.** Master/slave uses a separate etcd quorum and full metadata snapshots. Physical cleanup of old blobs is disabled in HA; they continue to occupy space. [HA limitations](docs/HA.md).
- **No proven speed advantage.** Comparative benchmarks, independent auditing and extended failure testing have not been completed. Real SMB/NFS mounts and physical devices need additional testing.
- **Console roles apply across storage.** Roles do not isolate tenants by bucket. Alerts are currently shown in the console, without email/webhooks. The application does not encrypt stored object data at rest.

Before exposing the service to the internet, configure HTTPS, change the initial password and restrict console access. [Security](docs/OPERATIONS.md#защита) · [Backup and recovery](docs/OPERATIONS.md#резервное-копирование-и-восстановление)

## Documentation

The console includes an English and Russian Wiki. Detailed repository guides below are currently in Russian; both README editions cover installation and first login.

| Task | Guide |
|:---|:---|
| Install, configure or update | [Installation and updates](docs/INSTALLATION.md) |
| Create users, S3 keys and buckets at first start | [First-start configuration](docs/INITIALIZATION.md) |
| Work with files, clusters, domains and HTTPS | [Operations](docs/OPERATIONS.md) |
| Connect an SDK or S3 client | [S3 compatibility and examples](docs/S3-COMPATIBILITY.md) |
| Connect a disk, SMB/CIFS, NFS or another server | [Disks and agent](docs/DISKS.md) |
| Configure master/slave | [HA and recovery](docs/HA.md) |
| Build and release a version | [CI/CD](docs/CI-CD.md) |
| Review plans and research on alternatives | [Roadmap](docs/FEATURE-ROADMAP.md) |
| Continue development on another device | [Project context](docs/PROJECT_MEMORY.md) and [agent instructions](AGENTS.md) |

<details>
<summary><strong>Development and running from source</strong></summary>

Local execution requires Node.js **22.13+**; `npm install` is not required.

```sh
git clone https://github.com/gadmin2151/27G-StorageS3.git
cd 27G-StorageS3
node src/server.mjs
```

For Docker, use `docker compose up -d --build`. The console is at `http://127.0.0.1:9000/console/`; initial credentials are `admin` / `admin!123`. For this Docker setup, read the token with `docker compose exec -T app cat /data/setup.token`. Direct Node execution on loopback without a public origin or trusted proxies allows initial login without a token.

```sh
node --test tests/*.test.mjs
docker compose config --quiet
```

Version 0.3.2 passed **135/135 local tests without skips**. HA tests need real etcd: set `ETCD_BINARY=/path/to/etcd`; without it some checks are skipped. The [0.3.2 release workflow](https://github.com/gadmin2151/27G-StorageS3/actions/runs/38253509576) verified containers, installation and updates using real Docker, and published images for both architectures. Functional checks do not replace load testing and auditing. Subsequent verification is recorded in [project context](docs/PROJECT_MEMORY.md).

To continue on another device, open the repository and start with `AGENTS.md` and `docs/PROJECT_MEMORY.md`. Git carries source code and project context; storage data and secrets are transferred separately.

</details>

---

<p align="center"><strong>27G-StorageS3</strong><br>Your own storage, managed in the browser.</p>
