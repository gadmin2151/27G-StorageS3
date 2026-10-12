#!/usr/bin/env bash
# Downloaded installers are executed only after the console command checks SHA-256.
set +x
set -euo pipefail
umask 077
fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ $# -eq 6 ]] || fail 'Запускайте команду подключения, созданную в панели 27G-StorageS3.'
coordinator=$1; bundle_sha=$2; port=$3; directory=$4; mode=$5; advertised=$6
IFS= read -r bootstrap || fail 'Не получен одноразовый код подключения.'
[[ $bootstrap =~ ^[a-f0-9]{64}$ && $bundle_sha =~ ^[a-f0-9]{64}$ ]] || fail 'Некорректный код подключения или версия установщика.'
origin_pattern='^https?://([a-zA-Z0-9._-]+|\[[a-fA-F0-9:]+\])(:[0-9]+)?$'
[[ $coordinator =~ $origin_pattern ]] || fail 'Некорректный адрес координатора.'
[[ -z $advertised || $advertised =~ $origin_pattern ]] || fail 'Некорректный адрес агента.'
[[ $port =~ ^[0-9]+$ && $port -ge 1024 && $port -le 65535 ]] || fail 'Порт должен быть в пределах 1024–65535.'
[[ $directory =~ ^/[a-zA-Z0-9_./-]+$ && ! $directory =~ (^|/)\.\.(/|$) ]] || fail 'Нужен отдельный абсолютный каталог данных.'
case ${directory%/} in /|/dev|/proc|/sys|/etc|/var|/usr|/bin|/sbin|/root|/home|'') fail 'Нужен отдельный каталог данных, не системный корень.';; esac
[[ $mode == folders || $mode == mounts ]] || fail 'Неизвестный режим агента.'
[[ $(uname -s) == Linux ]] || fail 'Установщик поддерживает Linux.'
[[ $(id -u) == 0 ]] || fail 'Выполните команду с sudo, как показано в панели.'
for utility in docker curl tar sha256sum mktemp od tr cmp; do command -v "$utility" >/dev/null || fail "Нужна команда $utility. Установите её и повторите подключение."; done
docker info >/dev/null 2>&1 || fail 'Docker недоступен. Установите/запустите Docker и повторите команду из панели.'
work=$(mktemp -d)
trap 'rm -rf -- "$work"; unset bootstrap agent_token' EXIT
printf 'header = "Authorization: Bearer %s"\n' "$bootstrap" > "$work/curl.conf"
unset bootstrap
printf '%s\n' 'Получение проверенной версии агента…'
curl --fail --silent --show-error --proto '=http,https' --max-time 90 --config "$work/curl.conf" --request POST "$coordinator/api/agent-install/bundle/$bundle_sha" -o "$work/source.tar.gz"
printf '%s  %s\n' "$bundle_sha" "$work/source.tar.gz" | sha256sum -c - >/dev/null || fail 'Контрольная сумма исходников не совпала. Установка остановлена.'
mkdir "$work/source"
tar --extract --gzip --file "$work/source.tar.gz" --directory "$work/source" --no-same-owner --no-same-permissions
# The source archive is an exact server-generated allowlist, never an arbitrary upload.
image="27g-storeges3-disk-agent:$bundle_sha"
container=27g-storeges3-disk-agent
agent_home=/var/lib/27g-storeges3-agent
[[ ! -L $agent_home && ! -L $directory ]] || fail 'Каталоги агента не должны быть символическими ссылками.'
printf '%s\n%s\n%s\n%s\n' "$bundle_sha" "$port" "$directory" "$mode" > "$work/install.conf"
if docker container inspect "$container" >/dev/null 2>&1; then
  [[ -f $agent_home/install.conf && -f $agent_home/agent.token ]] || fail 'Контейнер с этим именем уже существует и не принадлежит этой установке.'
  cmp -s "$work/install.conf" "$agent_home/install.conf" || fail 'Этот агент установлен с другими параметрами. Сохраните его конфигурацию; для переноса или обновления используйте ручную процедуру.'
  [[ $(docker inspect --format '{{index .Config.Labels "org.27g.agent"}}' "$container") == "$bundle_sha" ]] || fail 'Контейнер не соответствует сохранённой установке.'
  docker start "$container" >/dev/null
else
  if [[ -f $agent_home/install.conf ]]; then cmp -s "$work/install.conf" "$agent_home/install.conf" || fail 'Сохранено состояние агента другой конфигурации. Оно не будет перезаписано.'; fi
  mkdir -p "$agent_home/state" "$directory"
  chmod 700 "$agent_home" "$agent_home/state"
  if [[ ! -e $agent_home/agent.token ]]; then od -An -N32 -tx1 /dev/urandom | tr -d ' \n' > "$agent_home/agent.token"; fi
  chmod 600 "$agent_home/agent.token"
  cp "$work/install.conf" "$agent_home/install.conf"
  printf '%s\n' 'Сборка Docker-образа агента…'
  docker build --tag "$image" --file "$work/source/Dockerfile.disk-agent" "$work/source"
  extra=()
  if [[ $mode == mounts ]]; then
    printf '%s\n' 'Режим дисков/SMB/NFS: контейнер получает SYS_ADMIN и доступ к /dev. Диски сейчас не монтируются и не форматируются.'
    extra+=(--cap-add SYS_ADMIN --cap-add DAC_OVERRIDE --cap-add CHOWN --cap-add FOWNER --security-opt apparmor:unconfined --device-cgroup-rule 'b *:* rwm' --mount type=bind,source=/dev,target=/dev --mount type=bind,source=/proc/1/mountinfo,target=/run/host-mountinfo,readonly --env DISK_HOST_MOUNTINFO_FILE=/run/host-mountinfo --env DISK_ALLOW_BLOCK_DEVICES=true)
  fi
  docker run --detach --name "$container" --label "org.27g.agent=$bundle_sha" --restart unless-stopped --init --read-only --cap-drop ALL "${extra[@]}" --publish "$port:9200" --env HOST=0.0.0.0 --env DISK_TOKEN_FILE=/run/secrets/disk_token --env DISK_ALLOWED_ROOTS=/external --mount "type=bind,source=$agent_home/state,target=/var/lib/storeges3-disks" --mount "type=bind,source=$agent_home/agent.token,target=/run/secrets/disk_token,readonly" --mount "type=bind,source=$directory,target=/external,bind-propagation=rslave" --tmpfs /tmp:size=32m,mode=1777 --tmpfs /run:size=16m,mode=0755 "$image" >/dev/null
fi
agent_token=$(cat "$agent_home/agent.token")
[[ $agent_token =~ ^[a-f0-9]{64}$ ]] || fail 'Сохранённый токен агента повреждён. Файл не изменён.'
printf 'header = "Authorization: Bearer %s"\n' "$agent_token" > "$work/health.conf"
ready=false
for attempt in {1..30}; do
  if curl --fail --silent --proto '=http' --max-time 2 --config "$work/health.conf" "http://127.0.0.1:$port/disks" -o /dev/null; then ready=true; break; fi
  sleep 1
done
[[ $ready == true ]] || fail 'Агент не запустился. Проверьте docker logs 27g-storeges3-disk-agent. Состояние сохранено.'
printf '{"agentToken":"%s","sourceSha256":"%s"}' "$agent_token" "$bundle_sha" > "$work/registration.json"
unset agent_token
printf '%s\n' 'Проверка доступности и подключение к панели…'
if ! curl --fail-with-body --silent --show-error --proto '=http,https' --max-time 30 --config "$work/curl.conf" --header 'Content-Type: application/json' --data-binary "@$work/registration.json" "$coordinator/api/agent-install/complete" -o "$work/result.json"; then
  cat "$work/result.json" >&2 2>/dev/null || true
  printf '\n' >&2
  fail 'Контейнер сохранён. Проверьте доступ координатора к порту агента; повторите команду, пока она действует, либо создайте новую с нужным адресом. Если агент уже появился в панели, повторять не нужно.'
fi
printf '%s\n' 'Готово. Агент появился в разделе «Кластер → Диски». Добавьте источник /external либо выберите диск/SMB/NFS в панели.'
printf '%s\n' 'Состояние и секрет: /var/lib/27g-storeges3-agent. Сохраняйте этот каталог вместе с данными при резервном копировании.'
