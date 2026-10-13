# First-start configuration

**English · [Русский](INITIALIZATION.ru.md)**

Create the initial administrator, users, S3 keys and buckets from container parameters before serving requests. This is a one-time initialization step for a new instance, not a way to change an existing installation. Without initialization parameters, the usual `admin` / `admin!123` setup-token flow remains available.

## Easiest way: one Docker command

For a **new single-server installation**, Docker Engine is enough. No repository checkout, build, JSON file or separate init container is required. Run:

```sh
docker run -d --name 27g-storage-s3 --restart unless-stopped --init \
  --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --tmpfs /tmp:size=64m,mode=1777 --stop-timeout 35 \
  -p 127.0.0.1:9000:9000 \
  --mount type=volume,src=27g-storage-s3-data,dst=/data \
  -e INIT_BUCKET=app-data \
  ghcr.io/gadmin2151/27g-storage-s3:0.3.4
```

Docker creates the persistent `27g-storage-s3-data` volume. The application validates its startup parameters, creates `admin` with a random password, a private `app-data` bucket and a bucket-scoped S3 key, saves the initial credentials, then starts the server. This all happens in the same container, before it accepts requests.

Open [http://127.0.0.1:9000/console/](http://127.0.0.1:9000/console/), then read the credentials on the server:

```sh
docker exec 27g-storage-s3 cat /data/init-credentials.json
```

Use the generated administrator password to sign in; no setup token is required for this initialized account. The **access key and secret key** are for your S3 application, with endpoint `http://127.0.0.1:9000`, region `us-east-1` and path-style requests. Change `app-data` in the startup command to choose a different bucket name. Add `sudo` before Docker commands if your account requires it.

The credentials file has mode `0600`; secrets are not printed to container logs. Store them in a password manager and keep this file out of Git. Later password or key changes in the console do not update this initial file.

To restart this container:

```sh
docker restart 27g-storage-s3
```

Initialization is recorded on the volume and runs once. Restarting does not reset passwords, recreate keys or overwrite bucket settings; objects and SQLite databases are not copied. Keep the same volume when maintaining this deployment. This command creates a manual deployment; the installation wizard's managed-update command applies only to installations created by that wizard. If you already have an installation, continue its update procedure rather than creating another server with this command.

The port is bound only to the server's loopback address. For a remote server, connect with `ssh -L 9000:127.0.0.1:9000 user@server`, then open the console address on your computer. Configure HTTPS and the public service address separately when exposing the service.

## Repeatable bucket initialization with `27g`

Available in **0.3.4 / the current source build**. The image includes the `27g` client, so a startup script can create several buckets on an already running server:

```sh
27g create-bucket "my-bucket" --if-not-exists
27g create-bucket "my-bucket-2" --if-not-exists
27g create-bucket "my-bucket-3" --if-not-exists
```

`--if-no-exists` is an accepted alias. Use two ordinary ASCII hyphens (`--`), not a typographic dash. Each command accepts one bucket; the flag can precede or follow its name. `27g --help` and `27g create-bucket --help` show the built-in reference. From source, use `node src/cli.mjs create-bucket "my-bucket" --if-not-exists` instead.

This client sends signed S3 requests to the running server and never opens its data volume or SQLite files. It creates a missing private bucket. With the flag, the server's `409 BucketAlreadyOwnedByYou` response counts as success; other errors, including access denied or an unavailable server, still fail. Existing objects, policies and quotas are unchanged. The [example script](examples/init-buckets.sh) uses `set -eu`: it stops on the first error and leaves earlier successful creations in place. Running it again safely continues the same list.

### Prepare the S3 key

In **Access keys → Create key**, select only **Create buckets** (`createBucket`), enable **All existing and future buckets**, and leave prefixes empty. Save the access/secret pair. This dedicated key can create any valid bucket name but cannot list, read, write or delete objects. Revoke it after initialization if later reruns are not needed.

For a new installation that must restrict this key to the three names, use this `INIT_CONFIG_FILE` document instead of the simple `INIT_BUCKET` option, following the JSON mounting instructions below:

```json
{
  "version": 1,
  "users": [{ "username": "admin", "role": "admin" }],
  "keys": [{
    "label": "Bucket initialization",
    "owner": "admin",
    "buckets": ["my-bucket", "my-bucket-2", "my-bucket-3"],
    "permissions": ["createBucket"]
  }]
}
```

This provisions the account and a generated key; the subsequent commands create the buckets. The default key generated by `INIT_BUCKET=app-data` is restricted to `app-data` and **cannot create these other buckets**. Do not replace its scope merely to reuse an application key.

### Run against the existing Docker container

Use a container built from 0.3.4 or current source. In a Bash terminal, enter the dedicated S3 credentials without putting the secret in command history:

```bash
read -r -p 'Access Key: ' AWS_ACCESS_KEY_ID
read -r -s -p 'Secret Key: ' AWS_SECRET_ACCESS_KEY
printf '\n'
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
export S3_ENDPOINT=http://127.0.0.1:9000
export AWS_REGION=us-east-1
unset AWS_SESSION_TOKEN AWS_SECURITY_TOKEN

docker exec -i -e S3_ENDPOINT -e AWS_REGION \
  -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY \
  27g-storage-s3 sh <<'SH'
set -eu
27g create-bucket "my-bucket" --if-not-exists
27g create-bucket "my-bucket-2" --if-not-exists
27g create-bucket "my-bucket-3" --if-not-exists
SH
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
```

Here the endpoint is loopback **inside the running server container**. For Compose-managed `app`, replace `docker exec -i ... 27g-storage-s3` with `docker compose exec -T ... app`, retaining the environment flags and script. Direct environment values remain visible to someone with Docker/process inspection access; mounted secret files are preferable for unattended use.

### Run as a separate Compose init job

From the source root, edit `docs/examples/init-buckets.sh` to choose the names. Create a local secret file; do not commit it:

```bash
install -d -m 700 secrets
read -r -p 'Access Key: ' AWS_ACCESS_KEY_ID
read -r -s -p 'Secret Key: ' bucket_init_secret
printf '\n'
(umask 077; printf '%s' "$bucket_init_secret" > secrets/bucket-init-secret)
unset bucket_init_secret
export AWS_ACCESS_KEY_ID
export AWS_REGION=us-east-1
sudo chown 1000:1000 secrets/bucket-init-secret
sudo chmod 600 secrets/bucket-init-secret

docker compose -f compose.yaml -f compose.buckets-init.yaml up -d --build app
docker compose -f compose.yaml -f compose.buckets-init.yaml run --rm bucket-init
unset AWS_ACCESS_KEY_ID
```

The `bucket-init` job waits for `app` to be healthy, runs the three commands against `http://app:9000`, and exits. It mounts the script read-only and receives the secret through `/run/secrets/bucket_init_secret`; it has no storage data volume. Set `BUCKET_INIT_SECRET_FILE` to use another host secret-file path. The file must be readable by the container's UID 1000. Rerun the job with the same credentials when needed; no account or bucket configuration is reset. This overlay is for the source-based standalone Compose deployment. For HA, use the CLI against the active service endpoint with the appropriate network and secret mounts.

### Client parameters

| Variable | Purpose |
|---|---|
| `S3_ENDPOINT` | Server origin, default `http://127.0.0.1:9000`; omit `/console`, `/api` and bucket names |
| `AWS_ACCESS_KEY_ID` or `AWS_ACCESS_KEY_ID_FILE` | S3 access key, or readable file containing it |
| `AWS_SECRET_ACCESS_KEY` or `AWS_SECRET_ACCESS_KEY_FILE` | S3 secret, or readable file containing it |
| `AWS_REGION` / `AWS_DEFAULT_REGION` | Signing region; `AWS_REGION` takes precedence, default `us-east-1` |

Set either the direct value or its `_FILE` variant, not both. File paths refer to the filesystem where the CLI runs; mount them when using a separate container. A final line ending in the credential file is stripped. Match the signing region to the server. The CLI does not accept credentials as command-line arguments, AWS session tokens, or a switch that disables HTTPS certificate checks. For a remote endpoint, configure HTTPS and normal certificate trust.

Exit status is `0` for success, `1` for server/network failure and `2` for invalid arguments or configuration. Each request has a 15-second deadline. Redirects are not followed; set the final service origin in `S3_ENDPOINT`.

`INIT_*` and `--init-only` below are the one-time **account/bootstrap** mechanism. The `27g create-bucket` commands above are a separate, repeatable **post-start** step and require a working S3 key each time.

## From source: a separate init container

Run from the repository or extracted release source on a server with Docker Compose:

```sh
INIT_BUCKET=app-data docker compose -f compose.yaml -f compose.init.yaml up -d --build
docker compose exec -T app cat /data/init-credentials.json
```

The optional overlay runs a short-lived `init` container with `node src/server.mjs --init-only`. It uses the same image and `coordinator` volume as `app`, has no network access and opens no HTTP port. The application starts only after initialization succeeds.

This example creates `admin` with a generated password, the private `app-data` bucket and a generated S3 key scoped to that bucket. Read the generated credentials on the server using the second command; the file is mode `0600` and secrets are not printed to container logs. Use the administrator password for the console at `http://127.0.0.1:9000/console/`. An S3 client needs the separate **access key and secret key**, endpoint `http://127.0.0.1:9000`, path-style requests and region `us-east-1`. An S3 secret key is not the console setup token.

Store the credentials in your password manager. The output file contains both generated and explicitly supplied initial passwords and S3 secrets, with a flag identifying which were generated. Treat `init-credentials.json` as a secret: do not commit it or include it in diagnostics. Later changes in the console do not turn this file into a live credentials directory.

For subsequent starts and source-based updates, use the regular Compose file and retain the same project and volume:

```sh
docker compose -f compose.yaml up -d --build
```

The init overlay is intended for the first start. Do not start its one-shot process while `app` is running on the same volume. If retrying an interrupted initialization, first stop `app` and repeat the original initialization configuration. Do not delete the volume to retry.

The installation wizard has its own managed Compose file and update checks. This optional source-based deployment does not modify the wizard or introduce new installer flags.

## Simple environment parameters

To initialize without starting the application, run the init service explicitly:

```sh
INIT_BUCKET=app-data docker compose -f compose.yaml -f compose.init.yaml run --rm --build init
docker compose run --rm --no-deps app cat /data/init-credentials.json
docker compose -f compose.yaml up -d
```

For direct Node.js deployment, the server’s one-time initialization flag is `--init-only`:

```sh
INIT_ENABLED=true INIT_BUCKET=app-data DATA_DIR=./data node src/server.mjs --init-only
```

Omit `--init-only` to initialize and then serve requests. Do not run a second process over a data directory already owned by a running coordinator.

The normal server also reads these parameters itself; a separate init container is optional. In your own Compose deployment, pass them to `app` directly:

```yaml
services:
  app:
    environment:
      INIT_ENABLED: "true"
      INIT_ADMIN_USERNAME: admin
      INIT_BUCKET: app-data
```

Keep the regular persistent `/data` volume. The server completes initialization before accepting application requests. The repository's base `compose.yaml` does not forward host `INIT_*` variables automatically; use this environment mapping or the provided init overlay.

`compose.init.yaml` passes these variables to `init`; the regular `app` container receives no initialization secrets. An empty value is treated as absent. Setting a parameter opts into initialization; `INIT_ENABLED=true` is enough to create an administrator with a generated password.

| Variable | Purpose |
|---|---|
| `INIT_ENABLED` | Explicit opt-in; the optional init overlay defaults to `true` |
| `INIT_ADMIN_USERNAME` | Initial administrator username; defaults to `admin` |
| `INIT_ADMIN_PASSWORD` or `INIT_ADMIN_PASSWORD_FILE` | Supplied password or path to a readable file inside the container; omitted means generate a password |
| `INIT_BUCKET` | Optional initial bucket name; also creates a bucket-scoped S3 key |
| `INIT_BUCKET_ACCESS` | `private` by default, or `public-read` |
| `INIT_BUCKET_READ_PREFIXES` | JSON array of allowed public-read prefixes, for example `["images/"]` |
| `INIT_BUCKET_QUOTA_BYTES` / `INIT_BUCKET_QUOTA_OBJECTS` | Optional non-negative integer quota limits |
| `INIT_S3_ACCESS_KEY` | Optional supplied S3 access key |
| `INIT_S3_SECRET_KEY` or `INIT_S3_SECRET_KEY_FILE` | Optional supplied S3 secret or path to its file; otherwise generated |
| `INIT_CONFIG_FILE` | JSON configuration file inside the container, for multiple users/buckets/keys |

For public reads limited to a prefix:

```sh
INIT_BUCKET=public-media INIT_BUCKET_ACCESS=public-read \
INIT_BUCKET_READ_PREFIXES='["images/"]' \
docker compose -f compose.yaml -f compose.init.yaml up -d --build
```

Anonymous bucket listing remains forbidden. `public-read` permits reads of matching object paths, not discovery of all files. An empty prefix list permits reads throughout the bucket. These links do not expire; temporary sharing links remain a separate feature.

Prefer mounted files for supplied passwords and S3 secrets: direct environment values are visible to someone with Docker inspection access. Do not set both a value and its `_FILE` variant. Paths always refer to the container filesystem. Use JSON instead of the simple user/bucket/key variables when configuring multiple resources; do not combine those two input formats.

## Multiple users, keys and buckets with JSON

The [example JSON](examples/init.example.json) contains no passwords or S3 secrets. It creates an administrator, an operator, two buckets and a restricted application key; missing secrets are generated. Edit its public-read example if all buckets should remain private.

Prepare a dedicated directory for this new installation:

```sh
install -d -m 700 secrets secrets/initialization
cp docs/examples/init.example.json secrets/initialization/config.json
# Edit secrets/initialization/config.json before continuing.
cat > secrets/init.override.yaml <<'YAML'
services:
  init:
    environment:
      INIT_CONFIG_FILE: /run/secrets/config.json
    volumes:
      - type: bind
        source: ./secrets/initialization
        target: /run/secrets
        read_only: true
        bind:
          create_host_path: false
YAML
sudo chown 1000:1000 secrets/initialization secrets/initialization/config.json
sudo chmod 700 secrets/initialization
sudo chmod 600 secrets/initialization/config.json
docker compose -f compose.yaml -f compose.init.yaml -f secrets/init.override.yaml up -d --build
docker compose exec -T app cat /data/init-credentials.json
```

Add `sudo` to Docker commands if your account requires it. Compose resolves the relative bind source against the first Compose file, so these commands run from the project root. The `secrets/` directory is excluded from Git and the Docker build context. For generated-only configuration, the example file itself contains no secrets, but keep supplied credential files private.

The image runs as UID/GID **1000:1000**. Any mounted directory must be traversable, and any file readable, by that identity. Apply the same ownership and mode `0600` to additional password/secret files. A root-owned `0600` bind-mounted file cannot be read by this container; Compose secret declarations alone do not change the host file's ownership.

The JSON document uses `version: 1` and these lists:

| List | Fields |
|---|---|
| `users` | `username`, `role` (`admin`, `operator`, `viewer`); optional `password` or `passwordFile`, `quotaBytes`, `quotaObjects`, `language` (`en`, `ru`) |
| `keys` | `label`, `owner`; optional `role` (`readwrite`, `readonly`), `buckets`, `prefixes`, `permissions`, `accessKey`, `secretKey` or `secretKeyFile` |
| `buckets` | `name`; optional `quotaBytes`, `quotaObjects`, `access: {"mode":"private"\|"public-read","readPrefixes":[]}` |

The JSON file is limited to 256 KiB. Include an administrator in a custom user list. An omitted password or key secret is generated. File fields are paths inside the container, for example `"passwordFile": "/run/secrets/admin-password"`; relative JSON file references resolve from the configuration file's directory. A trailing line ending in a secret file is removed. Key owners must refer to users in the initialized system. Bucket names follow the existing S3 naming rules; passwords, roles, quotas and key permissions use the application's validation.

Supplied passwords need at least 12 characters and at most 1024 UTF-8 bytes. Access keys accept 3–128 ASCII letters, digits, dots, underscores and hyphens, starting with a letter or digit. S3 secret keys accept 32–512 printable ASCII characters without spaces. Either half of the S3 pair can be supplied independently; the omitted half is generated.

Supported key permissions are `read`, `list`, `write`, `delete`, `createBucket`, `deleteBucket`. Give application keys only the required bucket/prefix scopes and operations. Console roles apply across storage; assigning an operator a bucket-scoped S3 key does not restrict that user's web console to that bucket.

## Existing data, retries and HA

Initialization validates its inputs and records completion. A successful instance ignores later changes to initialization values, including references to secret files that are no longer available to the application. It does not reset accounts, recreate revoked keys or replace policies. Use the web console or authenticated API for subsequent administration.

An interrupted first initialization resumes its recorded operation rather than creating another set of credentials. If initialization fails, the HTTP server does not begin serving requests. Correct the reported configuration or file access problem and retry without removing data. Removing a secret bind source while it is still referenced by Compose can prevent Docker from creating the container before the application runs; remove the optional overlay after setup as shown above.

This mechanism does not copy objects or SQLite databases and does not migrate existing data. The compatible-update contract remains unchanged.

In HA, initialization belongs to creation of the **first authoritative snapshot by the elected master**. A slave imports that snapshot; it must not provision an independent set of accounts. Existing HA metadata takes precedence over initialization inputs. The one-shot init overlay and `--init-only` command are for standalone deployment; use the normal coordinated HA startup described in [HA.md](HA.md), not this overlay on both coordinators.

For `compose.ha.yaml`, add the initialization `environment` mapping to the `master` service, and mount any configuration/secret files there with UID 1000 read access. Prepare shared HA secrets as described in the HA guide first. The credentials output is stored on the initial master's volume; it is not copied to the slave. Check that the cluster has an active master before using the generated credentials.
