#!/usr/bin/env bash
# Package only committed, allowlisted project files; never the local data directory.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"
version=${1:?Usage: build-release.sh vX.Y.Z OUTPUT_DIRECTORY [GIT_REF]}
out=${2:?An output directory is required}
ref=${3:-HEAD}
[[ "$version" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || { echo 'Expected a stable vX.Y.Z tag.' >&2; exit 1; }
commit=$(git rev-parse --verify --end-of-options "${ref}^{commit}")
package_version=$(git show "$commit:package.json" | node --input-type=module -e 'let s="";for await(const p of process.stdin)s+=p;process.stdout.write(JSON.parse(s).version)')
[[ "$version" == "v$package_version" ]] || { echo 'Tag and committed package.json version must match.' >&2; exit 1; }
paths=(package.json Dockerfile Dockerfile.disk-agent src web scripts README.md AGENTS.md docs .dockerignore .env.example Caddyfile Caddyfile.ha compose.yaml compose.node.yaml compose.https.yaml compose.ha.yaml compose.disks.yaml)
for path in LICENSE LICENSE.md; do
  if git cat-file -e "$commit:$path" 2>/dev/null; then paths+=("$path"); fi
done
mkdir -p -- "$out"
out=$(cd -- "$out" && pwd)
name="27g-storage-s3-$version"
# git archive does not include ignored/untracked files, .git, volumes or runtime secrets.
git archive --format=tar --prefix="$name/" "$commit" -- "${paths[@]}" | gzip -n > "$out/$name.tar.gz"
git show "$commit:scripts/install.sh" > "$out/install.sh"
chmod 755 "$out/install.sh"
(cd -- "$out" && sha256sum install.sh "$name.tar.gz" > SHA256SUMS && sha256sum --check SHA256SUMS)
printf 'Release assets: %s\n' "$out"
