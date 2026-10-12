# Совместимость S3

27g-StoregeS3 реализует базовый S3 API для загрузки, скачивания и просмотра объектов. Этот документ описывает фактические возможности текущей версии; полная совместимость с Amazon S3 или MinIO пока не заявляется.

## Подключение

Создайте ключ доступа в веб-панели. Для приложения нужны **Access Key**, **Secret Key**, адрес сервиса и регион. Пароль администратора и cookie веб-панели для S3 не используются.

| Параметр | Значение |
| --- | --- |
| Локальный endpoint | `http://127.0.0.1:9000` |
| Endpoint при внешнем доступе | HTTPS-адрес вашего reverse proxy |
| Регион по умолчанию | `us-east-1` |
| Подпись | AWS Signature Version 4, `AWS4-HMAC-SHA256`, сервис `s3` |
| Адресация | **Path-style**: `https://host/bucket/object-key` |
| Максимальный объект | До **5 GiB = 5 368 709 120 байт** одним `PUT`; администратор может уменьшить `MAX_OBJECT_BYTES` |
| Публичный анонимный доступ | Бакеты приватные; доступны SigV4 presigned URL и отдельные временные ссылки панели `/share/...` |

Адрес endpoint указывается без `/console`, `/api` и имени бакета. Клиент должен использовать тот же регион, что и сервер. Сервер поддерживает переменную `S3_REGION`; если меняете её, передайте её в окружение контейнера координатора и настройте клиентов соответственно. В стандартном Compose используется `us-east-1`.

Virtual-hosted-style (`bucket.host/object`), AWS Signature V2, SigV4a, AWS STS и временные AWS session tokens не поддерживаются. Имена бакетов `api`, `console`, `healthz` и `share` зарезервированы для нового создания. Подписанные S3-запросы к бакету `share`, созданному прежней версией, продолжают работать.

Ключ с ролью `readonly` разрешает чтение и просмотр списков. `readwrite` также разрешает создание, перезапись и удаление. Ограничение по бакетам действует и для временных ссылок; пустой список бакетов означает доступ ко всем бакетам. Отзыв ключа прекращает работу подписанных им ссылок.

## Временные ссылки из панели

Кнопка «Поделиться» создаёт короткую ссылку приложения `/share/...`, отдельную от AWS SigV4. Получателю не нужны дополнительные заголовки, пароль или ключи; право чтения заключено в самой ссылке. В панели срок задаётся в днях и часах от 1 часа до 7 дней (API принимает от 60 до 604800 секунд). Администратор может отозвать отдельную ссылку. После истечения срока, отзыва, удаления или замены объекта новый запрос получает 404. Ссылки привязаны к конкретной записи объекта и сохраняются после перезапуска; отзыв S3-ключа не влияет на ссылки, созданные панелью.

Маршрут поддерживает GET/HEAD без Range и условных запросов. Для JPEG/PNG/GIF/WebP/AVIF с соответствующим Content-Type используется inline; другие типы скачиваются как `application/octet-stream`. Ответ содержит `Cache-Control: no-store`, `nosniff` и ограничивающую CSP. Проверка срока выполняется перед началом выдачи, начатая перед истечением срока передача может завершиться. Скачанный ранее файл остаётся у получателя.

## Поддерживаемые операции

| Операция | Поддержка и ограничения |
| --- | --- |
| `ListBuckets` | Возвращает бакеты, доступные ключу; пагинация списка бакетов отсутствует |
| `CreateBucket` | Создание бакета; пустое тело или базовый XML с `LocationConstraint`, совпадающим с регионом сервера |
| `HeadBucket`, `DeleteBucket` | Проверка существования и удаление пустого бакета |
| `GetBucketLocation` | Возвращает регион; для `us-east-1` XML-значение пустое |
| `ListObjects`, `ListObjectsV2` | `prefix`, `delimiter`, `max-keys` до 1000, `encoding-type=url`; V1: `marker`; V2: `continuation-token`, `start-after`, `fetch-owner` |
| `PutObject` | Одна загрузка целого объекта; существующий объект заменяется после успешной записи |
| `GetObject`, `HeadObject` | Размер, `Content-Type`, `ETag`, `Last-Modified`; один диапазон `Range: bytes=...`; `If-Match` и `If-None-Match` при чтении |
| `DeleteObject` | Удаление одного объекта; повторное удаление отсутствующего ключа возвращает успех, если бакет существует |
| Presigned GET/PUT | Временные ссылки SigV4, включая `UNSIGNED-PAYLOAD` и поддерживаемые checksum-параметры в подписанной query string |

В списках `Owner` имеет локальное значение `local`, `StorageClass` — `STANDARD`. Это служебные значения; отдельных владельцев AWS и классов хранения нет. Токены продолжения нужно передавать без изменения и с теми же параметрами списка. Списки не являются снимком: одновременные записи могут менять содержимое между страницами.

Ключи объектов сохраняют Unicode, повторные `/` и сегменты `.`/`..`. Максимальная длина ключа — 1024 байта UTF-8; NUL запрещён. Клиент или proxy не должен нормализовать путь. Для имён с управляющими символами используйте `encoding-type=url` при просмотре списка.

`ETag` содержит MD5 полного объекта в кавычках. Сервер проверяет подписанный SHA256 тела и переданные `Content-MD5`, `x-amz-checksum-sha256`, `x-amz-checksum-sha1`, `x-amz-checksum-md5`, `x-amz-checksum-crc32`, `x-amz-checksum-crc32c`. Значения отдельных checksum-заголовков передаются в Base64, `x-amz-content-sha256` — в lowercase hex. Проверка завершается до фиксации объекта. При `ChecksumMode="ENABLED"` в GET/HEAD возвращается сохранённый SHA256; исходный алгоритм дополнительной checksum отдельно не сохраняется.

Обычный подписанный запрос допускает расхождение часов до 15 минут. Срок временной ссылки — от 1 до 604800 секунд, то есть до 7 дней; истёкшая ссылка отклоняется. Базовые правила формирования подписи описаны в документации AWS: [SigV4 с Authorization](https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html) и [SigV4 в query string](https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sigv4-query-string-auth.html).

## Что пока не поддерживается

Поддержка отсутствует для следующих возможностей; соответствующие запросы возвращают ошибку, обычно `501 NotImplemented`:

- Multipart: создание загрузки, части, завершение, отмена, просмотр частей; возобновление загрузки отсутствует.
- AWS streaming signatures, `aws-chunked`, checksum trailers и CRC64NVME. Обычная потоковая передача HTTP без AWS chunk-подписей поддерживается.
- `CopyObject`, пакетное удаление `DeleteObjects`, versioning, `versionId`, object lock, retention и legal hold.
- ACL, bucket policies, IAM, STS, теги, lifecycle, CORS, notifications, S3 Select, website hosting и access points.
- SSE-S3, SSE-KMS, SSE-C и другие S3-заголовки шифрования; передача таких заголовков не включает шифрование автоматически.
- Пользовательские `x-amz-meta-*`, классы хранения, сохранение `Cache-Control`, `Content-Disposition`, `Content-Encoding`, `Content-Language` и `Expires` при загрузке.
- Условные записи и удаления; `If-Match`/`If-None-Match` реализованы только для GET/HEAD. Условия по датам, `If-Range` и несколько ranges не поддерживаются.
- Переопределение заголовков скачивания через `response-content-*` в query string.

Объекты выдаются с `Content-Disposition: attachment`, чтобы загруженный HTML/SVG не исполнялся в origin веб-панели. Это хранилище файлов; размещение исполняемых веб-страниц через S3 endpoint не предусмотрено.

Режимы RAID управляются через веб-панель и не меняют набор S3-команд. Метаданные обслуживает один координатор; автоматического переключения координатора нет. При чтении большого объекта с удалённого узла сервер сначала получает и проверяет целую реплику, поэтому даже небольшой `Range` при холодном кеше может потребовать чтения полного объекта.

## Настройка клиентов

Для текущей версии используйте **низкоуровневый `put_object` / `s3api put-object`**, который отправляет один PUT. Высокоуровневые `upload_file`, `upload_fileobj`, `aws s3 cp` и `aws s3 sync` могут автоматически перейти к multipart. Не используйте их для загрузок, пока multipart не реализован.

Настройте `request_checksum_calculation="when_required"` и `response_checksum_validation="when_required"`, чтобы SDK не добавлял необязательные автоматические checksum/trailers. Для целостности загрузки примеры включают SHA256-подпись тела через `payload_signing_enabled=true`. Дополнительную checksum можно передать заранее рассчитанным заголовком; не включайте автоматический trailer-режим. Значения и поведение параметров описаны в [справочнике Botocore Config](https://docs.aws.amazon.com/botocore/latest/reference/config.html) и [AWS Data Integrity Protections](https://docs.aws.amazon.com/sdkref/latest/guide/feature-dataintegrity.html).

### Общие переменные окружения

Откройте отдельный Bash-терминал и введите ключи, созданные в веб-панели. `read -s` скрывает Secret Key при вводе; реальные значения не нужно вставлять в код примеров.

```bash
read -r -p 'Access Key: ' AWS_ACCESS_KEY_ID
read -r -s -p 'Secret Key: ' AWS_SECRET_ACCESS_KEY
printf '\n'
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
unset AWS_SESSION_TOKEN AWS_SECURITY_TOKEN
export AWS_DEFAULT_REGION=us-east-1
export S3_ENDPOINT=http://127.0.0.1:9000
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
export AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
export AWS_PAGER=''
```

Для внешнего сервера замените `S3_ENDPOINT` на HTTPS-адрес. Если сертификат выдан вашей CA, настройте доверие клиента через `AWS_CA_BUNDLE`; проверка сертификата должна оставаться включённой.

### Python / boto3

Пример рассчитан на актуальные boto3/botocore, поддерживающие указанные checksum-параметры. Установите boto3 в своё виртуальное окружение. Скрипт создаёт тестовый бакет при необходимости, загружает небольшой файл, выводит список, скачивает объект и создаёт временную ссылку. Он использует API [Boto3 `put_object`](https://docs.aws.amazon.com/boto3/latest/reference/services/s3/client/put_object.html).

```python
import os
import shutil
from pathlib import Path

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

region = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
client = boto3.client(
    "s3",
    endpoint_url=os.environ.get("S3_ENDPOINT", "http://127.0.0.1:9000"),
    region_name=region,
    aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
    aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
    config=Config(
        signature_version="s3v4",
        s3={"addressing_style": "path", "payload_signing_enabled": True},
        request_checksum_calculation="when_required",
        response_checksum_validation="when_required",
        retries={"mode": "standard", "max_attempts": 3},
    ),
)

bucket = "example-files"
create_args = {"Bucket": bucket}
if region != "us-east-1":
    create_args["CreateBucketConfiguration"] = {"LocationConstraint": region}
try:
    client.create_bucket(**create_args)
except ClientError as error:
    if error.response["Error"]["Code"] != "BucketAlreadyOwnedByYou":
        raise

source = Path("s3-example.txt")
source.write_text("Привет, S3!\n", encoding="utf-8")
size = source.stat().st_size
if size > 5 * 1024**3:
    raise ValueError("Файл превышает предел одного PUT; учитывайте также лимит сервера")
with source.open("rb") as body:
    result = client.put_object(
        Bucket=bucket,
        Key="examples/hello.txt",
        Body=body,
        ContentLength=size,
        ContentType="text/plain; charset=utf-8",
    )
print("ETag:", result["ETag"])

for page in client.get_paginator("list_objects_v2").paginate(
    Bucket=bucket, Prefix="examples/"
):
    for item in page.get("Contents", []):
        print(item["Key"], item["Size"])

response = client.get_object(Bucket=bucket, Key="examples/hello.txt")
with response["Body"] as body, open("s3-downloaded.txt", "wb") as output:
    shutil.copyfileobj(body, output)

print(client.generate_presigned_url(
    "get_object",
    Params={"Bucket": bucket, "Key": "examples/hello.txt"},
    ExpiresIn=900,
))
```

На создание тестового бакета нужен ключ `readwrite`. Для ключа, ограниченного конкретным бакетом, замените `example-files` на разрешённое имя. Ссылку, напечатанную скриптом, можно открыть без S3-ключей в течение 15 минут; обращайтесь с ней как с временным доступом к объекту.

### AWS CLI v2

В том же терминале создайте отдельный файл настроек без секретов. Он задаёт path-style и SHA256-подпись тела, не меняя ваш обычный `~/.aws/config`.

```bash
cat > s3-client.config <<'EOF'
[default]
region = us-east-1
request_checksum_calculation = when_required
response_checksum_validation = when_required
s3 =
    addressing_style = path
    payload_signing_enabled = true
EOF
export AWS_CONFIG_FILE="$PWD/s3-client.config"
export AWS_PROFILE=default

aws --endpoint-url "$S3_ENDPOINT" s3api list-buckets
aws --endpoint-url "$S3_ENDPOINT" s3api create-bucket --bucket cli-example-files
printf 'Hello, S3!\n' > cli-example.txt
aws --endpoint-url "$S3_ENDPOINT" s3api put-object \
  --bucket cli-example-files --key examples/hello.txt \
  --body cli-example.txt --content-type text/plain
aws --endpoint-url "$S3_ENDPOINT" s3api list-objects-v2 \
  --bucket cli-example-files --prefix examples/
aws --endpoint-url "$S3_ENDPOINT" s3api get-object \
  --bucket cli-example-files --key examples/hello.txt cli-downloaded.txt
```

Здесь `--body` получает путь к локальному файлу, без `file://`. При повторном запуске `create-bucket` уже существующий бакет возвращает `BucketAlreadyOwnedByYou`; остальные команды можно выполнить отдельно. Синтаксис загрузки соответствует официальной [справке `aws s3api put-object`](https://docs.aws.amazon.com/cli/latest/reference/s3api/put-object.html).

Для удаления тестовых данных выполните:

```bash
aws --endpoint-url "$S3_ENDPOINT" s3api delete-object \
  --bucket cli-example-files --key examples/hello.txt
aws --endpoint-url "$S3_ENDPOINT" s3api delete-bucket --bucket cli-example-files
```

## Диагностика

| Ошибка | Что проверить |
| --- | --- |
| `SignatureDoesNotMatch` | Пару Access/Secret Key, path-style, неизменность `Host`, пути и query string на proxy |
| `AuthorizationHeaderMalformed` | Регион клиента, формат SigV4, наличие подписанных заголовков |
| `RequestTimeTooSkewed` | Синхронизацию часов клиента и сервера |
| `AccessDenied` | Роль, ограничения по бакетам, отзыв ключа или срок временной ссылки |
| `XAmzContentSHA256Mismatch`, `BadDigest` | Совпадение переданного тела с рассчитанным checksum; изменение файла во время загрузки |
| `NotImplemented` | Multipart, автоматические AWS trailers или параметры из списка неподдерживаемых возможностей |
| `EntityTooLarge` | `MAX_OBJECT_BYTES` на сервере и размер файла |
| `SlowDown` | Заполненную очередь загрузок; повторите запрос с задержкой |
| `ServiceUnavailable` | Доступность назначенных узлов и здоровых реплик в веб-панели |

В S3-ответах возвращается `x-amz-request-id`; сохраните его вместе с временем запроса при разборе ошибки. У запросов HEAD тело ответа пустое, поэтому код ошибки виден по HTTP-статусу.

Автоматические тесты проекта проверяют опубликованный AWS пример подписи и HTTP-сценарии с подписанными запросами. Это не сертификация совместимости со всеми SDK и версиями сторонних приложений; полная матрица клиентов и нагрузок пока не проверена.
