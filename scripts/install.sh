#!/usr/bin/env bash
# Generated from scripts/installer.template and installer-translations.json. Run node scripts/generate-installers.mjs after editing either source.
# 27G-StorageS3 standalone installer (English). Pipe-safe prompts always use /dev/tty.
set +x
set -Eeuo pipefail
umask 077

fail() { printf '\nError: %s\n' "$*" >&2; exit 1; }
note() { printf '%s\n' "$*" >&2; }
usage() {
  cat <<'HELP'
Install or update a standalone 27G-StorageS3 server (Linux amd64/arm64).
  curl -fsSL https://github.com/gadmin2151/27G-StorageS3/releases/latest/download/install.sh | bash

Options:
  --version vX.Y.Z|latest   GitHub release (default: latest).
  --directory PATH         Installation directory (default: /opt/27g-storage-s3).
  --port NUMBER            Published port (default: 9000).
  --bind IPv4              Bind address (default: 127.0.0.1).
  --public-origin URL      Existing public http(s) origin without a path; TLS is not configured.
  --update                 Update a managed installation (required with --yes).
  --build                  Build the verified release source instead of pulling from GHCR.
  --install-docker         Allow installing missing Docker using the official
                           apt repository on Debian/Ubuntu. Existing Docker is not changed.
  --yes                    Accept the supplied settings without questions (automation).
  --help                   Show this help.

Requires curl, python3, sha256sum, Docker Engine and Compose >= 2.20.
Interactive mode uses whiptail or text prompts through /dev/tty.
Updates keep the same volume: data is never copied or deleted.
Automatic updates require the same data format and no migrations.
HELP
}
main() {
version=latest; directory=/opt/27g-storage-s3; port=9000; bind=127.0.0.1; public_origin=''
yes=false; build=false; install_docker=false; update=false; updating=false; tty=false; work=''; root=(); docker_cmd=(docker)
network_flags=false; old_stopped=false; promoted=false; finished=false; preflight_container=''; backup_dir=''; rollback_ready=false; install_lock=''; lock_owned=false; preflight_created=false
while (( $# )); do
  case $1 in
    --help|-h) usage; exit 0 ;;
    --yes) yes=true; shift ;;
    --update) update=true; shift ;;
    --build) build=true; shift ;;
    --install-docker) install_docker=true; shift ;;
    --version|--directory|--port|--bind|--public-origin)
      (( $# >= 2 )) || fail "A value is required for $1."
      case $1 in
        --version) version=$2;; --directory) directory=$2;; --port) port=$2; network_flags=true;;
        --bind) bind=$2; network_flags=true;; --public-origin) public_origin=$2; network_flags=true;;
      esac
      shift 2 ;;
    *) fail "Unknown option: $1. Use --help." ;;
  esac
done
cleanup() {
  local code=$?
  trap - EXIT INT TERM
  if $preflight_created && [[ -n $preflight_container ]]; then "${docker_cmd[@]}" rm -f "$preflight_container" >/dev/null 2>&1 || true; fi
  if $updating && $old_stopped && ! $finished; then
    set +e
    note 'Update did not finish. Restoring the previous image on the same volume, without copying or deleting data…'
    rollback_safe=true
    if $promoted; then
      "${docker_cmd[@]}" compose -f "$directory/compose.yaml" stop -t 35 >/dev/null 2>&1 || rollback_safe=false
      if $rollback_safe && $rollback_ready; then
        "${root[@]}" cp -- "$backup_dir/compose.yaml" "$directory/compose.yaml.rollback" &&
        "${root[@]}" mv -- "$directory/compose.yaml.rollback" "$directory/compose.yaml" &&
        "${root[@]}" cp -- "$backup_dir/INSTALLATION.json" "$directory/INSTALLATION.json.rollback" &&
        "${root[@]}" mv -- "$directory/INSTALLATION.json.rollback" "$directory/INSTALLATION.json" || rollback_safe=false
      else
        rollback_safe=false
      fi
    fi
    image_restored=true
    if [[ $old_image_ref == 27g-storage-s3:* ]]; then
      "${docker_cmd[@]}" image tag "$old_image_id" "$old_image_ref" >/dev/null 2>&1 || image_restored=false
    fi
    [[ $("${docker_cmd[@]}" image inspect --format '{{.Id}}' "$old_image_ref" 2>/dev/null) == "$old_image_id" ]] || image_restored=false
    if $rollback_safe && $image_restored && "${docker_cmd[@]}" compose -f "$directory/compose.yaml" up -d --wait --wait-timeout 120 >/dev/null 2>&1; then
      note 'The previous image is running. The volume and data files were not replaced.'
      "${root[@]}" rm -f -- "$directory/update-state.json"
    else
      note "Automatic restart of the previous image failed. Saved $backup_dir and $directory/update-state.json. The volume was NOT deleted."
    fi
  fi
  if $lock_owned; then "${root[@]}" rmdir -- "$install_lock" 2>/dev/null || true; fi
  [[ -z $work ]] || rm -rf -- "$work"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
[[ $(uname -s) == Linux ]] || fail 'Only Linux is supported.'
case $(uname -m) in x86_64|aarch64|arm64) ;; *) fail 'Only amd64 and arm64 are supported.';; esac
for utility in curl python3 sha256sum mktemp cp chmod mkdir date cut mv; do
  command -v "$utility" >/dev/null || fail "Command $utility was not found. Install it using your system package manager and try again."
done
if ! $yes; then
  if { exec 9<>/dev/tty; } 2>/dev/null; then tty=true; else fail 'No terminal is available for prompts. Supply --yes with the required options, or run from a terminal.'; fi
fi
ask() {
  local name=$1 label=$2 current=$3 answer
  if command -v whiptail >/dev/null && [[ ${TERM:-dumb} != dumb ]]; then
    answer=$(whiptail --title '27G-StorageS3 · installation' --ok-button 'Continue' --cancel-button 'Cancel' --inputbox "$label" 11 76 "$current" 3>&1 1>&9 2>&3 0<&9) || fail 'Installation cancelled.'
  else
    printf '%s [%s]: ' "$label" "$current" >&9
    IFS= read -r answer <&9 || fail 'Installation cancelled.'
    [[ -n $answer ]] || answer=$current
  fi
  printf -v "$name" '%s' "$answer"
}
confirm() {
  local label=$1 answer
  $tty || return 1
  if command -v whiptail >/dev/null && [[ ${TERM:-dumb} != dumb ]]; then
    whiptail --title '27G-StorageS3 · confirmation' --yes-button 'Yes' --no-button 'No' --defaultno --yesno "$label" 16 78 0<&9 1>&9 2>&9
  else
    printf '%s\nContinue? [yes/no]: ' "$label" >&9
    IFS= read -r answer <&9 || return 1
    [[ $answer == yes || $answer == YES || $answer == y || $answer == Y ]]
  fi
}
if ! $yes; then
  ask directory 'Installation directory (parent directory must exist)' "$directory"
fi
# Values enter YAML, filenames, and privileged operations: reject ambiguous syntax up front.
validate_config() {
python3 - "$directory" "$port" "$bind" "$public_origin" <<'PY' || fail 'Correct the installation settings.'
import ipaddress, os, pathlib, re, sys, urllib.parse
path, port, bind, origin = sys.argv[1:]
def reject(message): raise SystemExit(message)
if not re.fullmatch(r'/[A-Za-z0-9_./-]+', path) or path.endswith('/') or any(p in ('.','..','') for p in path.split('/')[1:]):
    reject('Use an absolute path without spaces, dot segments or a trailing slash.')
p = pathlib.Path(path)
if len(p.parts) < 3 or p.parts[1] in ('bin','sbin','lib','lib64','dev','proc','sys','etc','boot','run','usr'):
    reject('Use a dedicated directory under /opt, /srv, /var/lib, /home or another data directory.')
for parent in [p, *p.parents]:
    if parent.is_symlink(): reject('Symbolic links are not allowed in the installation path.')
if not p.parent.is_dir(): reject('The parent installation directory must already exist.')
if not re.fullmatch(r'[1-9][0-9]{0,4}', port) or not 1 <= int(port) <= 65535: reject('The port must be between 1 and 65535.')
try: ipaddress.IPv4Address(bind)
except ValueError: reject('The bind address must be IPv4, such as 127.0.0.1 or 0.0.0.0.')
if origin:
    try:
        u = urllib.parse.urlsplit(origin)
        if u.scheme not in ('http','https') or not u.hostname or u.username or u.password or u.path or u.query or u.fragment or not re.fullmatch(r'https?://[A-Za-z0-9.\[\]:-]+', origin): raise ValueError()
        if u.port is not None and not 1 <= u.port <= 65535: raise ValueError()
        try: ipaddress.ip_address(u.hostname)
        except ValueError:
            if len(u.hostname) > 253 or not all(re.fullmatch(r'[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?', part) for part in u.hostname.split('.')): raise ValueError()
    except ValueError: reject('The public origin must be http(s)://host[:port] without a path or credentials.')
PY
}
validate_config
elevate() {
  if [[ $(id -u) != 0 ]]; then
    command -v sudo >/dev/null || fail 'Installation requires root or sudo.'
    sudo -v || fail 'Could not obtain sudo privileges.'
    root=(sudo)
  fi
}
acquire_lock() {
  install_lock="${directory}.installer-lock"
  "${root[@]}" mkdir -m 0700 -- "$install_lock" 2>/dev/null || fail "Another installation/update is running or a lock remains: $install_lock. Do not remove it while another installer is running."
  lock_owned=true
}
work=$(mktemp -d)
if [[ -e $directory || -L $directory ]]; then
  elevate
  "${root[@]}" test ! -e "$directory/update-state.json" || fail "An interrupted update was found: $directory/update-state.json. Check its state and recovery instructions; this run will not overwrite anything."
  if ! "${root[@]}" python3 - "$directory" > "$work/existing.json" <<'PY'
import hashlib, json, pathlib, re, sys
p = pathlib.Path(sys.argv[1])
try:
    data = json.loads((p / 'INSTALLATION.json').read_text())
    content = (p / 'compose.yaml').read_bytes()
    assert data['installerFormat'] == 1 and data['product'] == '27G-StorageS3' and data['directory'] == str(p)
    assert data['composeSha256'] == hashlib.sha256(content).hexdigest(), 'compose.yaml was edited manually'
    assert data['storageFormatVersion'] == 1 and data['storageUpgradeMode'] == 'none', 'no compatible data format contract'
    assert re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+', data['version'])
    assert re.fullmatch(r'27g-storage-s3-[a-f0-9]{12}', data['project'])
    assert data['volume'] == data['project'] + '_data'
    assert re.fullmatch(r'(?:ghcr.io/gadmin2151/27g-storage-s3@sha256:[a-f0-9]{64}|27g-storage-s3:[0-9]+\.[0-9]+\.[0-9]+-[a-f0-9]{12})', data['image'])
    print(json.dumps(data))
except (OSError, ValueError, KeyError, AssertionError, TypeError) as e:
    raise SystemExit('The installation is unmanaged or has been modified: ' + str(e))
PY
  then fail 'The existing installation will not be changed.'; fi
  acquire_lock
  "${root[@]}" python3 - "$directory" "$work/existing.json" <<'PY' || fail 'The installation changed before the lock was acquired. Try again.'
import hashlib, json, pathlib, sys
p = pathlib.Path(sys.argv[1]); current = json.loads((p / 'INSTALLATION.json').read_text())
if current != json.load(open(sys.argv[2])) or current['composeSha256'] != hashlib.sha256((p / 'compose.yaml').read_bytes()).hexdigest() or (p / 'update-state.json').exists(): raise SystemExit(1)
PY
  $network_flags && fail 'Do not use --port/--bind/--public-origin during an update: existing server settings are preserved.'
  if $yes && ! $update; then fail 'Add --update to update without prompts. Existing files have not been changed.'; fi
  updating=true
  read -r old_version project volume port bind < <(python3 - "$work/existing.json" <<'PY'
import json, sys
m = json.load(open(sys.argv[1])); print(m['version'], m['project'], m['volume'], m['port'], m['bind'])
PY
  )
  public_origin=$(python3 - "$work/existing.json" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))['publicOrigin'])
PY
  )
else
  $update && fail '--update requires an existing managed installation.'
  if ! $yes; then
    ask port 'Web console and S3 port' "$port"
    ask bind 'Address: 127.0.0.1 for local access, 0.0.0.0 for all network interfaces' "$bind"
    ask public_origin 'Existing public origin, such as https://s3.example.com; leave empty without a proxy' "$public_origin"
  fi
fi
validate_config
[[ $version == latest || $version =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'The version must be vX.Y.Z or latest.'
fetch() { curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 180 --retry 2 --max-filesize "$3" "$1" --output "$2"; }
repo=https://github.com/gadmin2151/27G-StorageS3
if [[ $version == latest ]]; then
  fetch https://api.github.com/repos/gadmin2151/27G-StorageS3/releases/latest "$work/release.json" 1048576 || fail 'Could not find the latest GitHub release. Try --version vX.Y.Z.'
  version=$(python3 - "$work/release.json" <<'PY'
import json, sys
with open(sys.argv[1]) as f: data = json.load(f)
if data.get('draft') or data.get('prerelease'): raise SystemExit('A published stable release is required.')
print(data.get('tag_name', ''))
PY
  ) || fail 'The GitHub response does not contain a suitable release.'
fi
[[ $version =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'The release has an unsupported version number.'
if $updating; then
  comparison=$(python3 - "$old_version" "$version" <<'PY'
import sys
old, new = [tuple(map(int, value[1:].split('.'))) for value in sys.argv[1:]]
print('same' if old == new else 'newer' if old < new else 'older')
PY
  )
  [[ $comparison != older ]] || fail 'Downgrades are not allowed. To recover, use the saved configuration of a compatible image.'
  if [[ $comparison == same ]]; then note "Version $version is already installed. Nothing changed."; finished=true; exit 0; fi
fi
artifact="27g-storage-s3-$version.tar.gz"
note "Downloading 27G-StorageS3 $version and verifying SHA-256…"
fetch "$repo/releases/download/$version/SHA256SUMS" "$work/SHA256SUMS" 1048576 || fail 'Could not download the release checksums.'
fetch "$repo/releases/download/$version/$artifact" "$work/$artifact" 67108864 || fail 'Could not download the release archive.'
expected=$(python3 - "$work/SHA256SUMS" "$artifact" <<'PY'
import re, sys
lines = open(sys.argv[1], encoding='utf8').read().splitlines()
values = []
for line in lines:
    m = re.fullmatch(r'([a-fA-F0-9]{64}) [ *](\S+)', line)
    if m and m[2] == sys.argv[2]: values.append(m[1].lower())
if len(values) != 1: raise SystemExit('Expected exactly one checksum for the archive.')
print(values[0])
PY
) || fail 'Invalid SHA256SUMS.'
printf '%s  %s\n' "$expected" "$work/$artifact" | sha256sum --check --status - || fail 'The archive SHA-256 does not match. No system changes were made.'
mkdir "$work/source"
python3 - "$work/$artifact" "$work/source" "$version" <<'PY' || fail 'The release archive was rejected. No system changes were made.'
import json, os, pathlib, re, shutil, sys, tarfile
archive, target, version = sys.argv[1:]
prefix = '27g-storage-s3-' + version
root_files = {'package.json', 'Dockerfile', 'Dockerfile.disk-agent', '.dockerignore', '.env.example', 'README.md', 'README.ru.md', 'AGENTS.md', 'LICENSE', 'LICENSE.md', 'Caddyfile', 'Caddyfile.ha'}
seen = set(); total = 0
with tarfile.open(archive, 'r:gz') as tar:
    members = []
    for entry in tar:
        members.append(entry)
        if len(members) > 4096: raise ValueError('Too many files in the archive.')
        name = entry.name.rstrip('/')
        pieces = name.split('/')
        if pieces[0] != prefix or any(p in ('', '.', '..') for p in pieces) or '\\' in name or any(ord(c) < 32 or ord(c) == 127 for c in name): raise ValueError('Invalid path in the archive.')
        if name in seen or not (entry.isdir() or entry.isreg()): raise ValueError('Duplicate entry, link or special file in the archive.')
        seen.add(name)
        if len(pieces) == 1:
            if not entry.isdir(): raise ValueError('The archive root must be a directory.')
            continue
        relative = '/'.join(pieces[1:])
        if not (pieces[1] in ('src', 'web', 'scripts', 'docs') or len(pieces) == 2 and (relative in root_files or re.fullmatch(r'compose(?:\.[a-z-]+)?\.ya?ml', relative))): raise ValueError('File outside the allowlist: ' + relative)
        if entry.size < 0 or entry.size > 67108864: raise ValueError('File is too large.')
        total += entry.size
        if total > 268435456: raise ValueError('The extracted archive is too large.')
    if not members: raise ValueError('Empty archive.')
    # Validate all headers before writing even into the private temporary directory.
    for entry in members:
        parts = entry.name.rstrip('/').split('/')[1:]
        if not parts: continue
        out = pathlib.Path(target).joinpath(*parts)
        if entry.isdir(): out.mkdir(parents=True, exist_ok=True)
        else:
            out.parent.mkdir(parents=True, exist_ok=True)
            with tar.extractfile(entry) as source, open(out, 'xb') as dest: shutil.copyfileobj(source, dest)
            os.chmod(out, 0o755 if out.suffix == '.sh' else 0o644)
for required in ['package.json','Dockerfile','Dockerfile.disk-agent','src/server.mjs','web/index.html','scripts/install-agent.sh','scripts/check-storage.mjs']:
    if not pathlib.Path(target, required).is_file(): raise ValueError('Required file is missing: ' + required)
with open(pathlib.Path(target, 'package.json')) as f:
    package = json.load(f)
    if package.get('version') != version[1:]: raise ValueError('The package.json version does not match the release.')
    if package.get('storageFormatVersion') != 1 or package.get('storageUpgradeMode') != 'none': raise ValueError('Automatic installation requires data format 1 and no migrations.')
PY
if ! $updating; then
project="27g-storage-s3-$(printf '%s' "$directory" | sha256sum | cut -c1-12)"
volume="${project}_data"
fi
mode='prebuilt GHCR image'; $build && mode='local build of the verified release'
summary="Version: $version
Directory: $directory
Port: $bind:$port → 9000
Public origin: ${public_origin:-not set}
Image: $mode
Data: Docker volume $volume
Standalone coordinator; HA is configured separately."
if $updating; then summary+=$'\nInstalled version: '"$old_version"$'\nUpdate: a brief service interruption. The same volume is kept; data files are not copied or deleted. Only the previous configuration is backed up.'; fi
if [[ $bind != 127.* ]]; then summary+=$'\nThe port will be accessible from the network. Configure Docker firewall rules and an HTTPS proxy before exposing it to the Internet.'; fi
if [[ -n $public_origin ]]; then summary+=$'\nThe domain, proxy and certificate must already be configured. This installer does not issue TLS certificates.'; fi
if $yes; then note "$summary"; else confirm "$summary" || fail 'Installation cancelled.'; fi
elevate
$lock_owned || acquire_lock
install_engine() {
  local os_id codename architecture package status
  command -v apt-get >/dev/null && command -v dpkg-query >/dev/null || fail 'Automatic Docker installation supports only Debian/Ubuntu with apt. Install Docker manually.'
  read -r os_id codename < <(python3 - <<'PY'
import shlex
values = {}
with open('/etc/os-release') as f:
    for line in f:
        if '=' in line:
            k, v = line.rstrip().split('=', 1)
            parts = shlex.split(v)
            values[k] = parts[0] if parts else ''
print(values.get('ID',''), values.get('VERSION_CODENAME',''))
PY
  )
  [[ $os_id == debian || $os_id == ubuntu ]] && [[ $codename =~ ^[a-z][a-z0-9-]*$ ]] || fail 'Automatic Docker installation supports only official Debian/Ubuntu systems with VERSION_CODENAME.'
  architecture=$(dpkg --print-architecture)
  [[ $architecture == amd64 || $architecture == arm64 ]] || fail 'Unsupported apt architecture.'
  for package in docker.io docker-compose docker-compose-v2 docker-doc docker-buildx podman-docker containerd runc docker-ce docker-ce-cli; do
    status=$(dpkg-query -W -f='${db:Status-Status}' "$package" 2>/dev/null || true)
    [[ $status != installed ]] || fail "Package $package is already installed. Configure Docker manually: existing packages are not removed or replaced."
  done
  [[ ! -e /etc/apt/keyrings/27g-docker.asc && ! -e /etc/apt/sources.list.d/27g-docker.sources ]] || fail 'Docker apt configuration already exists. Check it manually.'
  python3 - <<'PY' || fail 'Docker is already configured in apt. Complete its installation manually.'
from pathlib import Path
paths = list(Path('/etc/apt/sources.list.d').glob('*')) + [Path('/etc/apt/sources.list')]
for p in paths:
    if p.is_file() and 'download.docker.com' in p.read_text(errors='ignore'): raise SystemExit(1)
PY
  fetch "https://download.docker.com/linux/$os_id/gpg" "$work/docker.asc" 1048576 || fail 'Could not obtain the key for the official Docker apt repository.'
  printf 'Types: deb\nURIs: https://download.docker.com/linux/%s\nSuites: %s\nComponents: stable\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/27g-docker.asc\n' "$os_id" "$codename" "$architecture" > "$work/docker.sources"
  "${root[@]}" install -d -m 0755 /etc/apt/keyrings
  "${root[@]}" install -m 0644 "$work/docker.asc" /etc/apt/keyrings/27g-docker.asc
  "${root[@]}" install -m 0644 "$work/docker.sources" /etc/apt/sources.list.d/27g-docker.sources
  "${root[@]}" apt-get update
  "${root[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  note 'Docker was installed using the official apt repository. The installer did not change existing host network settings.'
}
if ! command -v docker >/dev/null; then
  if ! $install_docker; then
    confirm 'Docker is missing. Install Docker Engine and Compose from the official apt repository (Debian/Ubuntu only)? This adds the apt repository and Docker system packages.' || fail 'Install Docker Engine and Compose or allow --install-docker.'
  fi
  install_engine
fi
docker_cmd=("${root[@]}" docker)
endpoint=${DOCKER_HOST:-}
if [[ -z $endpoint ]]; then
  endpoint=$("${docker_cmd[@]}" context inspect --format '{{(index .Endpoints "docker").Host}}') || fail 'Could not check the Docker context.'
fi
# A named context overrides DOCKER_HOST; inspect it independently if explicitly selected.
if [[ -n ${DOCKER_CONTEXT:-} ]]; then
  endpoint=$("${docker_cmd[@]}" context inspect "$DOCKER_CONTEXT" --format '{{(index .Endpoints "docker").Host}}') || fail 'Could not check the selected Docker context.'
fi
[[ $endpoint == unix:///* && $endpoint != *$'\n'* ]] || fail 'Only a local Docker Engine using a Unix socket is supported. Remote TCP/SSH contexts are not allowed.'
"${docker_cmd[@]}" info >/dev/null 2>&1 || fail 'Docker Engine is unavailable. Start the local Docker service and try again. Existing Docker configuration was not changed.'
compose_version=$("${docker_cmd[@]}" compose version --short 2>/dev/null) || fail 'Docker Compose plugin >= 2.20 is required. Install it manually for an existing Docker installation.'
python3 - "$compose_version" <<'PY' || fail 'Docker Compose >= 2.20 is required.'
import re, sys
m = re.match(r'v?(\d+)\.(\d+)', sys.argv[1])
if not m or tuple(map(int, m.groups())) < (2, 20): raise SystemExit(1)
PY
if ! $updating; then
[[ ! -e $directory && ! -L $directory ]] || fail 'The directory appeared during installation. Nothing was overwritten.'
[[ -z $("${docker_cmd[@]}" ps -aq --filter "label=com.docker.compose.project=$project") ]] || fail 'Containers for this Compose project already exist. Restore their configuration; a new installation is not allowed.'
if "${docker_cmd[@]}" volume inspect "$volume" >/dev/null 2>&1; then fail 'The installation volume already exists. Restore its configuration; existing data is not adopted automatically.'; fi
if "${docker_cmd[@]}" network inspect "${project}_default" >/dev/null 2>&1; then fail 'The Compose project network already exists. Check the existing installation first.'; fi
fi
image="ghcr.io/gadmin2151/27g-storage-s3:${version#v}"
if ! $build; then
  if ! "${docker_cmd[@]}" pull "$image"; then
    confirm 'Could not pull the public GHCR image. Build locally from the verified release archive? This requires access to the official node:22-alpine image.' || fail 'The image is unavailable. Check the network and GHCR access, or try --build. Installation data was not created.'
    build=true
  fi
fi
if $build; then
  image="27g-storage-s3:${version#v}-${expected:0:12}"
  "${docker_cmd[@]}" build --pull --tag "$image" --file "$work/source/Dockerfile" "$work/source" || fail 'The build failed. Installation data was not created.'
else
  digest=$("${docker_cmd[@]}" image inspect --format '{{index .RepoDigests 0}}' "$image")
  [[ $digest =~ ^ghcr.io/gadmin2151/27g-storage-s3@sha256:[a-f0-9]{64}$ ]] || fail 'Docker did not return the expected GHCR image digest.'
  image=$digest
fi
# Verify the actual image, not just the independently downloaded source bundle.
"${docker_cmd[@]}" run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --entrypoint node "$image" -e 'process.stdout.write(JSON.stringify(require("/app/package.json")))' > "$work/image-package.json" || fail 'Could not verify Docker image metadata.'
python3 - "$work/image-package.json" "$version" <<'PY' || fail 'The image does not match the release or its migration-free update contract.'
import json, sys
p = json.load(open(sys.argv[1]))
if p.get('version') != sys.argv[2][1:] or p.get('storageFormatVersion') != 1 or p.get('storageUpgradeMode') != 'none': raise SystemExit(1)
PY
if $updating; then
  "${docker_cmd[@]}" volume inspect "$volume" >/dev/null || fail 'The installed server volume is missing. A new empty database will not be created.'
  old_container=$("${docker_cmd[@]}" compose -f "$directory/compose.yaml" ps -a -q app)
  [[ $old_container =~ ^[a-f0-9]{12,64}$ ]] || fail 'Could not find exactly one installed server container. Check the existing installation.'
  "${docker_cmd[@]}" inspect "$old_container" > "$work/old-container.json"
  old_image_id=$(python3 - "$work/old-container.json" "$work/existing.json" <<'PY'
import json, re, sys
items = json.load(open(sys.argv[1])); m = json.load(open(sys.argv[2]))
if len(items) != 1: raise SystemExit('Expected one container.')
c = items[0]; labels = c.get('Config', {}).get('Labels', {})
if labels.get('com.docker.compose.project') != m['project'] or labels.get('com.docker.compose.service') != 'app' or c['Config']['Image'] != m['image']: raise SystemExit('The container does not match the saved configuration.')
mounts = [v for v in c.get('Mounts', []) if v.get('Destination') == '/data']
if len(mounts) != 1 or mounts[0].get('Type') != 'volume' or mounts[0].get('Name') != m['volume'] or not mounts[0].get('RW'): raise SystemExit('The container uses a different volume.')
if not re.fullmatch(r'sha256:[a-f0-9]{64}', c.get('Image','')): raise SystemExit('Could not pin the previous image.')
print(c['Image'])
PY
  ) || fail 'The existing container check failed.'
  old_image_ref=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["image"])' "$work/existing.json")
  current_image_id=$("${docker_cmd[@]}" image inspect --format '{{.Id}}' "$old_image_ref")
  [[ $current_image_id == "$old_image_id" ]] || fail 'The previous image reference changed. Automatic rollback cannot be guaranteed.'
fi
note 'Checking the new image on an empty temporary RAM disk, without published ports…'
preflight_container="${project}-check-$(date -u +%s)-$$"
"${docker_cmd[@]}" run -d --name "$preflight_container" --network none --init --read-only --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 128 --memory 768m --tmpfs /data:rw,size=128m,uid=1000,gid=1000,mode=0700 --tmpfs /tmp:rw,size=64m,mode=1777 --env HOST=0.0.0.0 --env PORT=9000 --env DATA_DIR=/data --health-cmd "node -e \"fetch('http://127.0.0.1:9000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"" --health-interval 2s --health-timeout 3s --health-start-period 5s --health-retries 10 "$image" >/dev/null || fail 'The preflight container failed to start.'
preflight_created=true
ready=false
for attempt in {1..60}; do
  health=$("${docker_cmd[@]}" inspect --format '{{.State.Health.Status}}' "$preflight_container")
  if [[ $health == healthy ]]; then ready=true; break; fi
  [[ $health != unhealthy ]] || break
  sleep 1
done
$ready || fail 'The new image failed its health check. The existing server was not stopped.'
"${docker_cmd[@]}" stop -t 35 "$preflight_container" >/dev/null
"${docker_cmd[@]}" rm "$preflight_container" >/dev/null
preflight_container=''; preflight_created=false
cat > "$work/compose.yaml" <<YAML
name: $project
services:
  app:
    image: '$image'
    init: true
    restart: unless-stopped
    pull_policy: never
    read_only: true
    cap_drop: [ALL]
    security_opt: ['no-new-privileges:true']
    tmpfs: ['/tmp:size=64m,mode=1777']
    pids_limit: 128
    mem_limit: 768m
    stop_grace_period: 35s
    ports: ['$bind:$port:9000']
    environment:
      HOST: '0.0.0.0'
      PORT: '9000'
      DATA_DIR: '/data'
      PUBLIC_ORIGIN: '$public_origin'
    volumes: ['data:/data']
    healthcheck:
      test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:9000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 6
      start_period: 15s
volumes:
  data:
    name: $volume
YAML
if $updating; then
  "${root[@]}" cat "$directory/compose.yaml" > "$work/current-compose.yaml"
  python3 - "$work/current-compose.yaml" "$work/compose.yaml" "$image" <<'PY'
import pathlib, re, sys
content = pathlib.Path(sys.argv[1]).read_text()
content, count = re.subn(r"^    image: '[^'\n]+'$", "    image: '" + sys.argv[3] + "'", content, flags=re.M)
if count != 1: raise SystemExit('Could not replace only the image in Compose.')
pathlib.Path(sys.argv[2]).write_text(content)
PY
fi
"${docker_cmd[@]}" compose -f "$work/compose.yaml" config --quiet || fail 'Compose validation failed.'
python3 - "$work/INSTALLATION.json" "$directory" "$version" "$image" "$expected" "$project" "$volume" "$bind" "$port" "$public_origin" "$work/compose.yaml" <<'PY'
import datetime, hashlib, json, sys
file, path, version, image, checksum, project, volume, bind, port, origin, compose_file = sys.argv[1:]
with open(file, 'w') as f:
    json.dump(dict(product='27G-StorageS3', installerFormat=1, storageFormatVersion=1, storageUpgradeMode='none', composeSha256=hashlib.sha256(open(compose_file,'rb').read()).hexdigest(), directory=path, version=version, image=image, sourceSha256=checksum, project=project, volume=volume, bind=bind, port=int(port), publicOrigin=origin, createdAt=datetime.datetime.now(datetime.timezone.utc).isoformat()), f, indent=2)
    f.write('\n')
PY
if $updating; then
  # Back up configuration ONLY. The named volume remains in place; its files are never copied.
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  backup_dir="$directory/backups/${stamp}-${old_version}-$$"
  "${root[@]}" mkdir -p -- "$backup_dir"
  "${root[@]}" chmod 0700 "$directory/backups" "$backup_dir"
  "${root[@]}" cp -- "$directory/compose.yaml" "$directory/INSTALLATION.json" "$backup_dir/"
  printf '%s\n' "$old_image_id" > "$work/old-image-id"
  "${root[@]}" cp -- "$work/old-image-id" "$backup_dir/old-image-id"
  rollback_ready=true
  state() {
    python3 - "$work/update-state.json" "$1" "$old_version" "$version" "$volume" "$old_image_id" "$backup_dir" <<'PY'
import json, sys
file, phase, old, new, volume, image, backup = sys.argv[1:]
with open(file, 'w') as f: json.dump(dict(phase=phase, oldVersion=old, newVersion=new, volume=volume, oldImageId=image, configurationBackup=backup), f, indent=2)
PY
    "${root[@]}" cp -- "$work/update-state.json" "$directory/update-state.json.next"
    "${root[@]}" mv -- "$directory/update-state.json.next" "$directory/update-state.json"
  }
  state stopping
  old_stopped=true
  "${docker_cmd[@]}" compose -f "$directory/compose.yaml" stop -t 35 || fail 'Could not stop the previous container.'
  state checking-data
  "${docker_cmd[@]}" run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --mount "type=volume,source=$volume,target=/data,readonly" --entrypoint node "$image" /app/scripts/check-storage.mjs /data || fail 'The read-only check of the existing data format failed; the update was cancelled.'
  state promoting
  # Mark promotion before replacing files so a signal cannot leave an untracked new config.
  promoted=true
  "${root[@]}" cp -- "$work/compose.yaml" "$directory/compose.yaml.next"
  "${root[@]}" mv -- "$directory/compose.yaml.next" "$directory/compose.yaml"
  "${root[@]}" cp -- "$work/INSTALLATION.json" "$directory/INSTALLATION.json.next"
  "${root[@]}" mv -- "$directory/INSTALLATION.json.next" "$directory/INSTALLATION.json"
else
  # Recheck privileged path immediately before exclusive creation; never replace an installation.
  "${root[@]}" python3 - "$directory" <<'PY' || fail 'The installation directory already exists or has changed. Nothing was overwritten.'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
if any(q.is_symlink() for q in [p, *p.parents]): raise SystemExit(1)
p.mkdir(mode=0o750)
PY
  "${root[@]}" cp -R -- "$work/source" "$work/compose.yaml" "$work/INSTALLATION.json" "$directory/"
  "${root[@]}" chmod 0750 "$directory"
fi
"${root[@]}" chmod 0640 "$directory/compose.yaml" "$directory/INSTALLATION.json"
# Config files are root-owned, so Compose must be able to read them as well as access the daemon.
compose=("${docker_cmd[@]}" compose -f "$directory/compose.yaml")
if ! "${compose[@]}" up -d --wait --wait-timeout 120; then
  note 'The container did not become healthy within 120 seconds. Configuration and data were retained; nothing was deleted.'
  printf 'Check: sudo docker compose -f %q ps\nRetry startup: sudo docker compose -f %q up -d --wait\n' "$directory/compose.yaml" "$directory/compose.yaml" >&2
  fail 'Check Docker to continue. Logs may contain the Initial setup token: do not publish them.'
fi
finished=true
if $updating; then
  "${root[@]}" rm -f -- "$directory/update-state.json"
  # This source is a convenience copy, not the data directory. Keep the previous copy intact.
  "${root[@]}" mkdir -p -- "$directory/releases"
  "${root[@]}" cp -R -- "$work/source" "$directory/releases/$version"
  note "Update complete: $old_version → $version. The same volume $volume was kept; data was not copied."
  note "Previous configuration: $backup_dir (this is not a data backup)."
fi
address="http://$bind:$port"; [[ $bind == 0.0.0.0 ]] && address="http://<server-IP>:$port"
[[ -z $public_origin ]] || address=$public_origin
note "Ready. Web console: $address/console/"
if $updating; then note 'Existing users, passwords, keys and settings were preserved.'; else note 'First login: admin / admin!123. Network login requires the Initial setup token.'; fi
note 'Get the token after successful startup (only on your own server):'
printf '  sudo docker compose -f %q exec -T app cat /data/setup.token\n' "$directory/compose.yaml" >&2
if ! $updating; then note 'Change the initial password in the web console.'; fi
note 'Connect additional nodes in the Cluster section.'
printf 'Status: sudo docker compose -f %q ps\n' "$directory/compose.yaml" >&2
note "Keep $directory/INSTALLATION.json and a backup of Docker volume $volume. Do not use down -v to update."

}
# Keep this call last: a truncated curl download cannot run a partial installer.
main "$@"
