#!/usr/bin/env bash
# Generated from scripts/installer.template and installer-translations.json. Run node scripts/generate-installers.mjs after editing either source.
# 27G-StorageS3 standalone installer (Русский). Pipe-safe prompts always use /dev/tty.
set +x
set -Eeuo pipefail
umask 077

fail() { printf '\nОшибка: %s\n' "$*" >&2; exit 1; }
note() { printf '%s\n' "$*" >&2; }
usage() {
  cat <<'HELP'
Установка и обновление одиночного сервера 27G-StorageS3 (Linux amd64/arm64).
  curl -fsSL https://github.com/gadmin2151/27G-StorageS3/releases/latest/download/install-ru.sh | bash

Параметры:
  --version vX.Y.Z|latest   Релиз GitHub (по умолчанию latest).
  --directory PATH         Новый каталог (по умолчанию /opt/27g-storage-s3).
  --port NUMBER            Внешний порт (по умолчанию 9000).
  --bind IPv4              Адрес публикации (по умолчанию 127.0.0.1).
  --public-origin URL      Готовый внешний http(s) origin без пути; TLS не настраивается.
  --update                 Обновить существующую управляемую установку (нужно с --yes).
  --build                  Собрать образ из проверенного архива релиза вместо GHCR.
  --install-docker         Разрешить установку отсутствующего Docker через официальный
                           apt-репозиторий на Debian/Ubuntu. Существующий Docker не меняется.
  --yes                    Принять указанные параметры без вопросов (для автоматизации).
  --help                   Эта справка.

Нужны curl, python3, sha256sum, Docker Engine и Compose >= 2.20.
В интерактивном режиме используется whiptail либо текстовый диалог /dev/tty.
Обновление сохраняет тот же volume: данные не копируются и не удаляются.
Автообновление разрешено только для релизов без миграций того же формата данных.
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
      (( $# >= 2 )) || fail "Для $1 нужно значение."
      case $1 in
        --version) version=$2;; --directory) directory=$2;; --port) port=$2; network_flags=true;;
        --bind) bind=$2; network_flags=true;; --public-origin) public_origin=$2; network_flags=true;;
      esac
      shift 2 ;;
    *) fail "Неизвестный параметр: $1. Используйте --help." ;;
  esac
done
cleanup() {
  local code=$?
  trap - EXIT INT TERM
  if $preflight_created && [[ -n $preflight_container ]]; then "${docker_cmd[@]}" rm -f "$preflight_container" >/dev/null 2>&1 || true; fi
  if $updating && $old_stopped && ! $finished; then
    set +e
    note 'Обновление не завершено. Возвращаем прежний образ с тем же volume, без копирования и удаления данных…'
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
      note 'Прежний образ запущен. Volume и файлы данных не заменялись.'
      "${root[@]}" rm -f -- "$directory/update-state.json"
    else
      note "Автоматический запуск прежнего образа не удался. Сохранены $backup_dir и $directory/update-state.json. Volume НЕ удалён."
    fi
  fi
  if $lock_owned; then "${root[@]}" rmdir -- "$install_lock" 2>/dev/null || true; fi
  [[ -z $work ]] || rm -rf -- "$work"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
[[ $(uname -s) == Linux ]] || fail 'Поддерживается только Linux.'
case $(uname -m) in x86_64|aarch64|arm64) ;; *) fail 'Поддерживаются только amd64 и arm64.';; esac
for utility in curl python3 sha256sum mktemp cp chmod mkdir date cut mv; do
  command -v "$utility" >/dev/null || fail "Не найдена команда $utility. Установите её системным пакетным менеджером и повторите запуск."
done
if ! $yes; then
  if { exec 9<>/dev/tty; } 2>/dev/null; then tty=true; else fail 'Нет терминала для диалога. Передайте --yes и нужные параметры либо запустите из терминала.'; fi
fi
ask() {
  local name=$1 label=$2 current=$3 answer
  if command -v whiptail >/dev/null && [[ ${TERM:-dumb} != dumb ]]; then
    answer=$(whiptail --title '27G-StorageS3 · установка' --ok-button 'Продолжить' --cancel-button 'Отмена' --inputbox "$label" 11 76 "$current" 3>&1 1>&9 2>&3 0<&9) || fail 'Установка отменена.'
  else
    printf '%s [%s]: ' "$label" "$current" >&9
    IFS= read -r answer <&9 || fail 'Установка отменена.'
    [[ -n $answer ]] || answer=$current
  fi
  printf -v "$name" '%s' "$answer"
}
confirm() {
  local label=$1 answer
  $tty || return 1
  if command -v whiptail >/dev/null && [[ ${TERM:-dumb} != dumb ]]; then
    whiptail --title '27G-StorageS3 · подтверждение' --yes-button 'Да' --no-button 'Нет' --defaultno --yesno "$label" 16 78 0<&9 1>&9 2>&9
  else
    printf '%s\nПродолжить? [да/нет]: ' "$label" >&9
    IFS= read -r answer <&9 || return 1
    [[ $answer == да || $answer == ДА || $answer == yes || $answer == y ]]
  fi
}
if ! $yes; then
  ask directory 'Каталог установки (родитель должен существовать)' "$directory"
fi
# Values enter YAML, filenames, and privileged operations: reject ambiguous syntax up front.
validate_config() {
python3 - "$directory" "$port" "$bind" "$public_origin" <<'PY' || fail 'Исправьте параметры установки.'
import ipaddress, os, pathlib, re, sys, urllib.parse
path, port, bind, origin = sys.argv[1:]
def reject(message): raise SystemExit(message)
if not re.fullmatch(r'/[A-Za-z0-9_./-]+', path) or path.endswith('/') or any(p in ('.','..','') for p in path.split('/')[1:]):
    reject('Нужен абсолютный путь без пробелов, точек-сегментов и завершающего /.')
p = pathlib.Path(path)
if len(p.parts) < 3 or p.parts[1] in ('bin','sbin','lib','lib64','dev','proc','sys','etc','boot','run','usr'):
    reject('Нужен отдельный каталог в /opt, /srv, /var/lib, /home или другом каталоге данных.')
for parent in [p, *p.parents]:
    if parent.is_symlink(): reject('Символические ссылки в пути установки запрещены.')
if not p.parent.is_dir(): reject('Родительский каталог установки должен уже существовать.')
if not re.fullmatch(r'[1-9][0-9]{0,4}', port) or not 1 <= int(port) <= 65535: reject('Порт должен быть 1–65535.')
try: ipaddress.IPv4Address(bind)
except ValueError: reject('Адрес публикации должен быть IPv4, например 127.0.0.1 или 0.0.0.0.')
if origin:
    try:
        u = urllib.parse.urlsplit(origin)
        if u.scheme not in ('http','https') or not u.hostname or u.username or u.password or u.path or u.query or u.fragment or not re.fullmatch(r'https?://[A-Za-z0-9.\[\]:-]+', origin): raise ValueError()
        if u.port is not None and not 1 <= u.port <= 65535: raise ValueError()
        try: ipaddress.ip_address(u.hostname)
        except ValueError:
            if len(u.hostname) > 253 or not all(re.fullmatch(r'[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?', part) for part in u.hostname.split('.')): raise ValueError()
    except ValueError: reject('Внешний origin должен быть http(s)://host[:port] без пути и учётных данных.')
PY
}
validate_config
elevate() {
  if [[ $(id -u) != 0 ]]; then
    command -v sudo >/dev/null || fail 'Для установки нужны root или sudo.'
    sudo -v || fail 'Не получены права sudo.'
    root=(sudo)
  fi
}
acquire_lock() {
  install_lock="${directory}.installer-lock"
  "${root[@]}" mkdir -m 0700 -- "$install_lock" 2>/dev/null || fail "Установка/обновление уже выполняется либо осталась блокировка: $install_lock. Не удаляйте её, пока другой установщик работает."
  lock_owned=true
}
work=$(mktemp -d)
if [[ -e $directory || -L $directory ]]; then
  elevate
  "${root[@]}" test ! -e "$directory/update-state.json" || fail "Обнаружено прерванное обновление: $directory/update-state.json. Проверьте состояние и инструкции восстановления; повторный запуск ничего не перезаписывает."
  if ! "${root[@]}" python3 - "$directory" > "$work/existing.json" <<'PY'
import hashlib, json, pathlib, re, sys
p = pathlib.Path(sys.argv[1])
try:
    data = json.loads((p / 'INSTALLATION.json').read_text())
    content = (p / 'compose.yaml').read_bytes()
    assert data['installerFormat'] == 1 and data['product'] == '27G-StorageS3' and data['directory'] == str(p)
    assert data['composeSha256'] == hashlib.sha256(content).hexdigest(), 'compose.yaml изменён вручную'
    assert data['storageFormatVersion'] == 1 and data['storageUpgradeMode'] == 'none', 'нет совместимого контракта данных'
    assert re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+', data['version'])
    assert re.fullmatch(r'27g-storage-s3-[a-f0-9]{12}', data['project'])
    assert data['volume'] == data['project'] + '_data'
    assert re.fullmatch(r'(?:ghcr.io/gadmin2151/27g-storage-s3@sha256:[a-f0-9]{64}|27g-storage-s3:[0-9]+\.[0-9]+\.[0-9]+-[a-f0-9]{12})', data['image'])
    print(json.dumps(data))
except (OSError, ValueError, KeyError, AssertionError, TypeError) as e:
    raise SystemExit('Установка не принадлежит этому установщику либо изменена: ' + str(e))
PY
  then fail 'Существующая установка не будет изменена.'; fi
  acquire_lock
  "${root[@]}" python3 - "$directory" "$work/existing.json" <<'PY' || fail 'Установка изменилась до захвата блокировки. Повторите запуск.'
import hashlib, json, pathlib, sys
p = pathlib.Path(sys.argv[1]); current = json.loads((p / 'INSTALLATION.json').read_text())
if current != json.load(open(sys.argv[2])) or current['composeSha256'] != hashlib.sha256((p / 'compose.yaml').read_bytes()).hexdigest() or (p / 'update-state.json').exists(): raise SystemExit(1)
PY
  $network_flags && fail 'При обновлении --port/--bind/--public-origin не используются: сохраняются параметры установленного сервера.'
  if $yes && ! $update; then fail 'Для обновления без диалога добавьте --update. Существующие файлы не изменены.'; fi
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
  $update && fail '--update требует существующую управляемую установку.'
  if ! $yes; then
    ask port 'Порт веб-панели и S3' "$port"
    ask bind 'Адрес: 127.0.0.1 только локально, 0.0.0.0 все сетевые интерфейсы' "$bind"
    ask public_origin 'Готовый внешний origin, например https://s3.example.com; пусто без прокси' "$public_origin"
  fi
fi
validate_config
[[ $version == latest || $version =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'Версия должна иметь вид vX.Y.Z либо latest.'
fetch() { curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 180 --retry 2 --max-filesize "$3" "$1" --output "$2"; }
repo=https://github.com/gadmin2151/27G-StorageS3
if [[ $version == latest ]]; then
  fetch https://api.github.com/repos/gadmin2151/27G-StorageS3/releases/latest "$work/release.json" 1048576 || fail 'Не удалось найти последний релиз GitHub. Попробуйте --version vX.Y.Z.'
  version=$(python3 - "$work/release.json" <<'PY'
import json, sys
with open(sys.argv[1]) as f: data = json.load(f)
if data.get('draft') or data.get('prerelease'): raise SystemExit('Нужен опубликованный стабильный релиз.')
print(data.get('tag_name', ''))
PY
  ) || fail 'Ответ GitHub не содержит подходящего релиза.'
fi
[[ $version =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'Релиз имеет неподдерживаемый номер версии.'
if $updating; then
  comparison=$(python3 - "$old_version" "$version" <<'PY'
import sys
old, new = [tuple(map(int, value[1:].split('.'))) for value in sys.argv[1:]]
print('same' if old == new else 'newer' if old < new else 'older')
PY
  )
  [[ $comparison != older ]] || fail 'Понижение версии запрещено. Для восстановления используйте сохранённую конфигурацию совместимого образа.'
  if [[ $comparison == same ]]; then note "Уже установлена версия $version. Ничего не изменено."; finished=true; exit 0; fi
fi
artifact="27g-storage-s3-$version.tar.gz"
note "Получение 27G-StorageS3 $version и проверка SHA-256…"
fetch "$repo/releases/download/$version/SHA256SUMS" "$work/SHA256SUMS" 1048576 || fail 'Не удалось скачать контрольные суммы релиза.'
fetch "$repo/releases/download/$version/$artifact" "$work/$artifact" 67108864 || fail 'Не удалось скачать архив релиза.'
expected=$(python3 - "$work/SHA256SUMS" "$artifact" <<'PY'
import re, sys
lines = open(sys.argv[1], encoding='utf8').read().splitlines()
values = []
for line in lines:
    m = re.fullmatch(r'([a-fA-F0-9]{64}) [ *](\S+)', line)
    if m and m[2] == sys.argv[2]: values.append(m[1].lower())
if len(values) != 1: raise SystemExit('Нет единственной контрольной суммы архива.')
print(values[0])
PY
) || fail 'Некорректный SHA256SUMS.'
printf '%s  %s\n' "$expected" "$work/$artifact" | sha256sum --check --status - || fail 'SHA-256 архива не совпал. Изменения системы не выполнялись.'
mkdir "$work/source"
python3 - "$work/$artifact" "$work/source" "$version" <<'PY' || fail 'Архив релиза отклонён. Изменения системы не выполнялись.'
import json, os, pathlib, re, shutil, sys, tarfile
archive, target, version = sys.argv[1:]
prefix = '27g-storage-s3-' + version
root_files = {'package.json', 'Dockerfile', 'Dockerfile.disk-agent', '.dockerignore', '.env.example', 'README.md', 'README.ru.md', 'AGENTS.md', 'LICENSE', 'LICENSE.md', 'Caddyfile', 'Caddyfile.ha'}
seen = set(); total = 0
with tarfile.open(archive, 'r:gz') as tar:
    members = []
    for entry in tar:
        members.append(entry)
        if len(members) > 4096: raise ValueError('Слишком много файлов в архиве.')
        name = entry.name.rstrip('/')
        pieces = name.split('/')
        if pieces[0] != prefix or any(p in ('', '.', '..') for p in pieces) or '\\' in name or any(ord(c) < 32 or ord(c) == 127 for c in name): raise ValueError('Недопустимый путь в архиве.')
        if name in seen or not (entry.isdir() or entry.isreg()): raise ValueError('Дубликат, ссылка или специальный файл в архиве.')
        seen.add(name)
        if len(pieces) == 1:
            if not entry.isdir(): raise ValueError('Корень архива должен быть каталогом.')
            continue
        relative = '/'.join(pieces[1:])
        if not (pieces[1] in ('src', 'web', 'scripts', 'docs') or len(pieces) == 2 and (relative in root_files or re.fullmatch(r'compose(?:\.[a-z-]+)?\.ya?ml', relative))): raise ValueError('Файл вне списка разрешённых: ' + relative)
        if entry.size < 0 or entry.size > 67108864: raise ValueError('Слишком большой файл.')
        total += entry.size
        if total > 268435456: raise ValueError('Распакованный архив слишком большой.')
    if not members: raise ValueError('Пустой архив.')
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
    if not pathlib.Path(target, required).is_file(): raise ValueError('Отсутствует обязательный файл: ' + required)
with open(pathlib.Path(target, 'package.json')) as f:
    package = json.load(f)
    if package.get('version') != version[1:]: raise ValueError('Версия package.json отличается от релиза.')
    if package.get('storageFormatVersion') != 1 or package.get('storageUpgradeMode') != 'none': raise ValueError('Автоустановка требует формат данных 1 и отсутствие миграций.')
PY
if ! $updating; then
project="27g-storage-s3-$(printf '%s' "$directory" | sha256sum | cut -c1-12)"
volume="${project}_data"
fi
mode='готовый образ GHCR'; $build && mode='локальная сборка проверенного релиза'
summary="Версия: $version
Каталог: $directory
Порт: $bind:$port → 9000
Внешний адрес: ${public_origin:-не задан}
Образ: $mode
Данные: Docker volume $volume
Одиночный координатор; HA настраивается отдельно."
if $updating; then summary+=$'\nПрежняя версия: '"$old_version"$'\nОбновление: краткая остановка сервера. Тот же volume; файлы данных не копируются и не удаляются. Сохраняется только прежняя конфигурация.'; fi
if [[ $bind != 127.* ]]; then summary+=$'\nПорт будет доступен из сети. Настройте firewall Docker и HTTPS-прокси перед доступом из Интернета.'; fi
if [[ -n $public_origin ]]; then summary+=$'\nДомен/прокси/сертификат должны быть уже настроены. Установщик не выпускает TLS-сертификат.'; fi
if $yes; then note "$summary"; else confirm "$summary" || fail 'Установка отменена.'; fi
elevate
$lock_owned || acquire_lock
install_engine() {
  local os_id codename architecture package status
  command -v apt-get >/dev/null && command -v dpkg-query >/dev/null || fail 'Автоустановка Docker поддерживает только Debian/Ubuntu с apt. Установите Docker вручную.'
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
  [[ $os_id == debian || $os_id == ubuntu ]] && [[ $codename =~ ^[a-z][a-z0-9-]*$ ]] || fail 'Автоустановка Docker поддерживает только официальные Debian/Ubuntu с VERSION_CODENAME.'
  architecture=$(dpkg --print-architecture)
  [[ $architecture == amd64 || $architecture == arm64 ]] || fail 'Неподдерживаемая архитектура apt.'
  for package in docker.io docker-compose docker-compose-v2 docker-doc docker-buildx podman-docker containerd runc docker-ce docker-ce-cli; do
    status=$(dpkg-query -W -f='${db:Status-Status}' "$package" 2>/dev/null || true)
    [[ $status != installed ]] || fail "Пакет $package уже установлен. Настройте Docker вручную: существующие пакеты не удаляются и не заменяются."
  done
  [[ ! -e /etc/apt/keyrings/27g-docker.asc && ! -e /etc/apt/sources.list.d/27g-docker.sources ]] || fail 'Конфигурация apt для Docker уже существует. Проверьте её вручную.'
  python3 - <<'PY' || fail 'В apt уже настроен Docker. Завершите его установку вручную.'
from pathlib import Path
paths = list(Path('/etc/apt/sources.list.d').glob('*')) + [Path('/etc/apt/sources.list')]
for p in paths:
    if p.is_file() and 'download.docker.com' in p.read_text(errors='ignore'): raise SystemExit(1)
PY
  fetch "https://download.docker.com/linux/$os_id/gpg" "$work/docker.asc" 1048576 || fail 'Не удалось получить ключ официального apt-репозитория Docker.'
  printf 'Types: deb\nURIs: https://download.docker.com/linux/%s\nSuites: %s\nComponents: stable\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/27g-docker.asc\n' "$os_id" "$codename" "$architecture" > "$work/docker.sources"
  "${root[@]}" install -d -m 0755 /etc/apt/keyrings
  "${root[@]}" install -m 0644 "$work/docker.asc" /etc/apt/keyrings/27g-docker.asc
  "${root[@]}" install -m 0644 "$work/docker.sources" /etc/apt/sources.list.d/27g-docker.sources
  "${root[@]}" apt-get update
  "${root[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  note 'Docker установлен через официальный apt-репозиторий. Существующие сетевые настройки хоста не менялись установщиком.'
}
if ! command -v docker >/dev/null; then
  if ! $install_docker; then
    confirm 'Docker отсутствует. Установить Docker Engine и Compose из официального apt-репозитория (только Debian/Ubuntu)? Будут добавлены apt-репозиторий и системные пакеты Docker.' || fail 'Установите Docker Engine и Compose либо разрешите --install-docker.'
  fi
  install_engine
fi
docker_cmd=("${root[@]}" docker)
endpoint=${DOCKER_HOST:-}
if [[ -z $endpoint ]]; then
  endpoint=$("${docker_cmd[@]}" context inspect --format '{{(index .Endpoints "docker").Host}}') || fail 'Не удалось проверить Docker context.'
fi
# A named context overrides DOCKER_HOST; inspect it independently if explicitly selected.
if [[ -n ${DOCKER_CONTEXT:-} ]]; then
  endpoint=$("${docker_cmd[@]}" context inspect "$DOCKER_CONTEXT" --format '{{(index .Endpoints "docker").Host}}') || fail 'Не удалось проверить выбранный Docker context.'
fi
[[ $endpoint == unix:///* && $endpoint != *$'\n'* ]] || fail 'Поддерживается только локальный Docker Engine через Unix socket. Удалённые TCP/SSH contexts запрещены.'
"${docker_cmd[@]}" info >/dev/null 2>&1 || fail 'Docker Engine недоступен. Запустите системный Docker и повторите установку. Конфигурация существующего Docker не менялась.'
compose_version=$("${docker_cmd[@]}" compose version --short 2>/dev/null) || fail 'Нужен Docker Compose plugin >= 2.20. Установите его вручную для существующего Docker.'
python3 - "$compose_version" <<'PY' || fail 'Нужен Docker Compose >= 2.20.'
import re, sys
m = re.match(r'v?(\d+)\.(\d+)', sys.argv[1])
if not m or tuple(map(int, m.groups())) < (2, 20): raise SystemExit(1)
PY
if ! $updating; then
[[ ! -e $directory && ! -L $directory ]] || fail 'Каталог появился во время установки. Ничего не перезаписано.'
[[ -z $("${docker_cmd[@]}" ps -aq --filter "label=com.docker.compose.project=$project") ]] || fail 'Контейнеры этого Compose-проекта уже существуют. Восстановите их конфигурацию; новая установка запрещена.'
if "${docker_cmd[@]}" volume inspect "$volume" >/dev/null 2>&1; then fail 'Volume этой установки уже существует. Восстановите конфигурацию; существующие данные не используются автоматически.'; fi
if "${docker_cmd[@]}" network inspect "${project}_default" >/dev/null 2>&1; then fail 'Сеть этого Compose-проекта уже существует. Сначала проверьте существующую установку.'; fi
fi
image="ghcr.io/gadmin2151/27g-storage-s3:${version#v}"
if ! $build; then
  if ! "${docker_cmd[@]}" pull "$image"; then
    confirm 'Не удалось получить публичный образ GHCR. Собрать локально из уже проверенного архива релиза? Для сборки нужен доступ к официальному node:22-alpine.' || fail 'Образ недоступен. Проверьте сеть/доступ GHCR или повторите с --build. Данные установки не создавались.'
    build=true
  fi
fi
if $build; then
  image="27g-storage-s3:${version#v}-${expected:0:12}"
  "${docker_cmd[@]}" build --pull --tag "$image" --file "$work/source/Dockerfile" "$work/source" || fail 'Сборка не удалась. Данные установки не создавались.'
else
  digest=$("${docker_cmd[@]}" image inspect --format '{{index .RepoDigests 0}}' "$image")
  [[ $digest =~ ^ghcr.io/gadmin2151/27g-storage-s3@sha256:[a-f0-9]{64}$ ]] || fail 'Docker не вернул ожидаемый digest образа GHCR.'
  image=$digest
fi
# Verify the actual image, not just the independently downloaded source bundle.
"${docker_cmd[@]}" run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --entrypoint node "$image" -e 'process.stdout.write(JSON.stringify(require("/app/package.json")))' > "$work/image-package.json" || fail 'Не удалось проверить метаданные Docker-образа.'
python3 - "$work/image-package.json" "$version" <<'PY' || fail 'Образ не соответствует релизу или контракту обновления без миграций.'
import json, sys
p = json.load(open(sys.argv[1]))
if p.get('version') != sys.argv[2][1:] or p.get('storageFormatVersion') != 1 or p.get('storageUpgradeMode') != 'none': raise SystemExit(1)
PY
if $updating; then
  "${docker_cmd[@]}" volume inspect "$volume" >/dev/null || fail 'Volume установленного сервера отсутствует. Новая пустая база не будет создана.'
  old_container=$("${docker_cmd[@]}" compose -f "$directory/compose.yaml" ps -a -q app)
  [[ $old_container =~ ^[a-f0-9]{12,64}$ ]] || fail 'Не найден единственный контейнер установленного сервера. Проверьте существующую установку.'
  "${docker_cmd[@]}" inspect "$old_container" > "$work/old-container.json"
  old_image_id=$(python3 - "$work/old-container.json" "$work/existing.json" <<'PY'
import json, re, sys
items = json.load(open(sys.argv[1])); m = json.load(open(sys.argv[2]))
if len(items) != 1: raise SystemExit('Ожидался один контейнер.')
c = items[0]; labels = c.get('Config', {}).get('Labels', {})
if labels.get('com.docker.compose.project') != m['project'] or labels.get('com.docker.compose.service') != 'app' or c['Config']['Image'] != m['image']: raise SystemExit('Контейнер не соответствует сохранённой конфигурации.')
mounts = [v for v in c.get('Mounts', []) if v.get('Destination') == '/data']
if len(mounts) != 1 or mounts[0].get('Type') != 'volume' or mounts[0].get('Name') != m['volume'] or not mounts[0].get('RW'): raise SystemExit('Контейнер использует другой volume.')
if not re.fullmatch(r'sha256:[a-f0-9]{64}', c.get('Image','')): raise SystemExit('Не удалось зафиксировать старый образ.')
print(c['Image'])
PY
  ) || fail 'Проверка существующего контейнера не прошла.'
  old_image_ref=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["image"])' "$work/existing.json")
  current_image_id=$("${docker_cmd[@]}" image inspect --format '{{.Id}}' "$old_image_ref")
  [[ $current_image_id == "$old_image_id" ]] || fail 'Ссылка на прежний образ изменилась. Автоматический откат нельзя гарантировать.'
fi
note 'Проверка запуска нового образа на пустом временном RAM-диске, без сетевых портов…'
preflight_container="${project}-check-$(date -u +%s)-$$"
"${docker_cmd[@]}" run -d --name "$preflight_container" --network none --init --read-only --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 128 --memory 768m --tmpfs /data:rw,size=128m,uid=1000,gid=1000,mode=0700 --tmpfs /tmp:rw,size=64m,mode=1777 --env HOST=0.0.0.0 --env PORT=9000 --env DATA_DIR=/data --health-cmd "node -e \"fetch('http://127.0.0.1:9000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"" --health-interval 2s --health-timeout 3s --health-start-period 5s --health-retries 10 "$image" >/dev/null || fail 'Проверочный контейнер не запустился.'
preflight_created=true
ready=false
for attempt in {1..60}; do
  health=$("${docker_cmd[@]}" inspect --format '{{.State.Health.Status}}' "$preflight_container")
  if [[ $health == healthy ]]; then ready=true; break; fi
  [[ $health != unhealthy ]] || break
  sleep 1
done
$ready || fail 'Новый образ не прошёл healthcheck. Действующий сервер не останавливался.'
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
if count != 1: raise SystemExit('Не удалось заменить только image в Compose.')
pathlib.Path(sys.argv[2]).write_text(content)
PY
fi
"${docker_cmd[@]}" compose -f "$work/compose.yaml" config --quiet || fail 'Проверка Compose не прошла.'
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
  "${docker_cmd[@]}" compose -f "$directory/compose.yaml" stop -t 35 || fail 'Не удалось остановить прежний контейнер.'
  state checking-data
  "${docker_cmd[@]}" run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --mount "type=volume,source=$volume,target=/data,readonly" --entrypoint node "$image" /app/scripts/check-storage.mjs /data || fail 'Read-only проверка существующего формата не прошла; обновление отменено.'
  state promoting
  # Mark promotion before replacing files so a signal cannot leave an untracked new config.
  promoted=true
  "${root[@]}" cp -- "$work/compose.yaml" "$directory/compose.yaml.next"
  "${root[@]}" mv -- "$directory/compose.yaml.next" "$directory/compose.yaml"
  "${root[@]}" cp -- "$work/INSTALLATION.json" "$directory/INSTALLATION.json.next"
  "${root[@]}" mv -- "$directory/INSTALLATION.json.next" "$directory/INSTALLATION.json"
else
  # Recheck privileged path immediately before exclusive creation; never replace an installation.
  "${root[@]}" python3 - "$directory" <<'PY' || fail 'Каталог установки уже существует либо изменился. Ничего не перезаписано.'
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
  note 'Контейнер не стал healthy за 120 секунд. Конфигурация и данные сохранены; удаление не выполнялось.'
  printf 'Проверить: sudo docker compose -f %q ps\nПовторить запуск: sudo docker compose -f %q up -d --wait\n' "$directory/compose.yaml" "$directory/compose.yaml" >&2
  fail 'Установка требует проверки Docker. Журналы могут содержать Initial setup token: не публикуйте их.'
fi
finished=true
if $updating; then
  "${root[@]}" rm -f -- "$directory/update-state.json"
  # This source is a convenience copy, not the data directory. Keep the previous copy intact.
  "${root[@]}" mkdir -p -- "$directory/releases"
  "${root[@]}" cp -R -- "$work/source" "$directory/releases/$version"
  note "Обновление завершено: $old_version → $version. Тот же volume $volume; данные не копировались."
  note "Прежняя конфигурация: $backup_dir (это не резервная копия данных)."
fi
address="http://$bind:$port"; [[ $bind == 0.0.0.0 ]] && address="http://<IP-сервера>:$port"
[[ -z $public_origin ]] || address=$public_origin
note "Готово. Веб-панель: $address/console/"
if $updating; then note 'Существующие пользователи, пароли, ключи и настройки сохранены.'; else note 'Первый вход: admin / admin!123. Сетевой вход требует Initial setup token.'; fi
note 'Получить токен после успешного запуска (только на своём сервере):'
printf '  sudo docker compose -f %q exec -T app cat /data/setup.token\n' "$directory/compose.yaml" >&2
if ! $updating; then note 'Смените начальный пароль в веб-панели.'; fi
note 'Дополнительные узлы подключаются в разделе «Кластер».'
printf 'Статус: sudo docker compose -f %q ps\n' "$directory/compose.yaml" >&2
note "Сохраните $directory/INSTALLATION.json и резервную копию Docker volume $volume. Не используйте down -v для обновления."

}
# Keep this call last: a truncated curl download cannot run a partial installer.
main "$@"
