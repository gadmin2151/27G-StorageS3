# Совместимость S3

27G-StorageS3 0.3 реализует базовый S3 API, multipart и ограниченные версии объектов. Этот документ описывает фактические возможности текущей версии; полная совместимость с Amazon S3 или MinIO пока не заявляется.

## Подключение

Создайте ключ доступа в веб-панели. Для приложения нужны **Access Key**, **Secret Key**, адрес сервиса и регион. Пароль администратора и cookie веб-панели для S3 не используются.

| Параметр | Значение |
| --- | --- |
| Локальный endpoint | `http://127.0.0.1:9000` |
| Endpoint при внешнем доступе | HTTPS-адрес вашего reverse proxy |
| Регион по умолчанию | `us-east-1` |
| Подпись | AWS Signature Version 4, `AWS4-HMAC-SHA256`, сервис `s3` |
| Адресация | **Path-style**: `https://host/bucket/object-key` |
| Максимальный объект | До **5 GiB = 5 368 709 120 байт**, как одним `PUT`, так и суммарно через multipart; администратор может уменьшить `MAX_OBJECT_BYTES` |
| Публичный анонимный доступ | По умолчанию закрыт. Администратор может открыть чтение текущих объектов по точному пути для выбранного бакета/префиксов; анонимные списки запрещены. Также доступны SigV4 presigned URL и отдельные временные ссылки `/share/...` |

Адрес endpoint указывается без `/console`, `/api` и имени бакета. Клиент должен использовать тот же регион, что и сервер. Сервер поддерживает переменную `S3_REGION`; если меняете её, передайте её в окружение контейнера координатора и настройте клиентов соответственно. В стандартном Compose используется `us-east-1`.

Virtual-hosted-style (`bucket.host/object`), AWS Signature V2, SigV4a, AWS STS и временные AWS session tokens не поддерживаются. Имена бакетов `api`, `console`, `healthz` и `share` зарезервированы для нового создания. Подписанные S3-запросы к бакету `share`, созданному прежней версией, продолжают работать.

Ключ с ролью `readonly` разрешает чтение и просмотр списков. `readwrite` также разрешает создание, перезапись и удаление, если операция входит в выданные permissions. Дополнительно задаются бакеты, префиксы, срок и владелец. Отключение владельца или истечение срока прекращает действие ключа. Пустой список бакетов означает доступ ко всем бакетам; ограниченный префиксом ключ должен передавать разрешённый prefix в запросах списков. Ограничения действуют также для presigned URL. Отзыв ключа прекращает работу подписанных им ссылок.

## Закрытые и открытые бакеты

Все существующие и новые бакеты по умолчанию **закрытые** (`private`). Администратор может выбрать **открытый** режим (`public-read`) в панели. Это разрешает анонимные `GET` и `HEAD` только текущего объекта по полному пути вида `https://storage.example.com/photos/images/example.jpg`. Загрузка, удаление, перечисление бакетов/объектов, `HEAD` бакета, версии и multipart требуют подходящего S3-ключа. Знание одного имени бакета не даёт получить список файлов.

Открытый путь доступен **любому, кто его знает или угадает**; пароль и токен не требуются. Отсутствие списка не делает имя файла секретом. Для ограниченного срока или индивидуального отзыва используйте временную ссылку. Обычный открытый URL не истекает и после перезаписи указывает на новое текущее содержимое.

Можно ограничить чтение префиксами ключа: например, `images/` открывает `images/photo.jpg`, но не `images-old/photo.jpg`. Префиксы сравниваются буквально, с учётом регистра; `*` не является wildcard, сегменты `.`/`..` не нормализуются. Пустой список префиксов или пустая строка означает весь текущий контент бакета. Допускается до 32 префиксов по 1024 байта UTF-8, без NUL. Это упрощённая политика приложения, **не AWS IAM JSON и не S3 PutBucketPolicy**.

Настройка доступна администраторам через `GET/PUT /api/bucket-access?bucket=photos`; PUT принимает `{"mode":"public-read","readPrefixes":["images/"]}`. Политика хранится в общих метаданных HA и сохраняется после перезапуска. Удаление бакета удаляет его политику, повторное создание такого же имени снова закрытое. Системные имена бакетов нельзя открыть.

Переключение на закрытый режим прекращает новые анонимные чтения по обычным путям; перед выдачей результата медленного чтения политика проверяется повторно. Уже скачанные файлы и начатые передачи нельзя отозвать. Ответы используют `Cache-Control: no-store`, `Content-Disposition: attachment`, `nosniff` и ограничивающую CSP. Range и условные GET/HEAD работают как у обычного S3; запрос `versionId` без подписи запрещён. CORS по-прежнему требует разрешённого origin для браузерного JavaScript.

Переданная неверная/истёкшая подпись никогда не заменяется анонимным доступом: запрос должен пройти обычную проверку SigV4. Временные ссылки `/share/...` имеют отдельный срок и отзыв; закрытие бакета само по себе их не отзывает.

## Временные ссылки из панели

Кнопка «Поделиться» создаёт короткую ссылку приложения `/share/...`, отдельную от AWS SigV4. Получателю не нужны дополнительные заголовки, пароль или ключи; право чтения заключено в самой ссылке. В панели срок задаётся в днях и часах от 1 часа до 7 дней (API принимает от 60 до 604800 секунд). Администратор может отозвать отдельную ссылку. После истечения срока, отзыва, удаления или замены объекта новый запрос получает 404. Ссылки привязаны к конкретной записи объекта и сохраняются после перезапуска; отзыв S3-ключа не влияет на ссылки, созданные панелью.

Маршрут поддерживает GET/HEAD без Range и условных запросов. Для JPEG/PNG/GIF/WebP/AVIF с соответствующим Content-Type используется inline; другие типы скачиваются как `application/octet-stream`. Ответ содержит `Cache-Control: no-store`, `nosniff` и ограничивающую CSP. Проверка срока выполняется перед началом выдачи, начатая перед истечением срока передача может завершиться. Скачанный ранее файл остаётся у получателя.

## Поддерживаемые операции

| Операция | Поддержка и ограничения |
| --- | --- |
| `ListBuckets` | Возвращает бакеты, доступные ключу; пагинация списка бакетов отсутствует |
| `CreateBucket` | Создание бакета; пустое тело или базовый XML с `LocationConstraint`, совпадающим с регионом сервера. Повтор возвращает `409 BucketAlreadyOwnedByYou` после проверки прав; клиент может явно считать этот ответ успешным |
| `HeadBucket`, `DeleteBucket` | Проверка существования и удаление пустого бакета |
| `GetBucketLocation` | Возвращает регион; для `us-east-1` XML-значение пустое |
| `ListObjects`, `ListObjectsV2` | `prefix`, `delimiter`, `max-keys` до 1000, `encoding-type=url`; V1: `marker`; V2: `continuation-token`, `start-after`, `fetch-owner` |
| `PutObject` | Одна загрузка целого объекта; успешная перезапись создаёт версию, сохраняются последние пять версий содержимого |
| `GetObject`, `HeadObject` | Размер, `Content-Type`, `ETag`, `Last-Modified`; один диапазон `Range: bytes=...`; `If-Match` и `If-None-Match` при чтении |
| `DeleteObject` | Без versionId создаёт маркер удаления; с versionId окончательно удаляет указанную версию/маркер |
| `GetBucketVersioning`, `ListObjectVersions` | Версии всегда включены; список с markers, prefix/delimiter, пагинацией; изменение режима versioning не поддерживается |
| Версионный `GetObject`/`HeadObject` | Параметр versionId возвращает сохранённое содержимое; x-amz-version-id в ответах |
| Multipart | CreateMultipartUpload, UploadPart, ListParts, ListMultipartUploads, CompleteMultipartUpload, AbortMultipartUpload; части сохраняются после перезапуска |
| Presigned GET/PUT | Временные ссылки SigV4, включая `UNSIGNED-PAYLOAD` и поддерживаемые checksum-параметры в подписанной query string |

`Owner` содержит локальный идентификатор, `StorageClass` — `STANDARD`. Это служебные значения; отдельных владельцев AWS и классов хранения нет. Токены продолжения нужно передавать без изменения и с теми же параметрами списка. Списки не являются снимком: одновременные записи могут менять содержимое между страницами.

Ключи объектов сохраняют Unicode, повторные `/` и сегменты `.`/`..`. Максимальная длина ключа — 1024 байта UTF-8; NUL запрещён. Клиент или proxy не должен нормализовать путь. Для имён с управляющими символами используйте `encoding-type=url` при просмотре списка.

`ETag` одиночного PUT содержит MD5 полного объекта в кавычках. У multipart это MD5 объединённых бинарных MD5 частей с суффиксом `-числоЧастей`; он не равен MD5 целого файла. Сервер проверяет подписанный SHA256 тела и переданные `Content-MD5`, `x-amz-checksum-sha256`, `x-amz-checksum-sha1`, `x-amz-checksum-md5`, `x-amz-checksum-crc32`, `x-amz-checksum-crc32c`. Значения отдельных checksum-заголовков передаются в Base64, `x-amz-content-sha256` — в lowercase hex. Проверка завершается до фиксации объекта. При `ChecksumMode="ENABLED"` в GET/HEAD возвращается сохранённый SHA256; исходный алгоритм дополнительной checksum отдельно не сохраняется.

Обычный подписанный запрос допускает расхождение часов до 15 минут. Срок временной ссылки — от 1 до 604800 секунд, то есть до 7 дней; истёкшая ссылка отклоняется. Базовые правила формирования подписи описаны в документации AWS: [SigV4 с Authorization](https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html) и [SigV4 в query string](https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sigv4-query-string-auth.html).

## Пять версий и корзина

По требованию владельца хранится **всего пять версий содержимого: текущая и четыре предыдущие**. Удаление без versionId создаёт маркер; объект исчезает из обычного списка, но остаётся в корзине. Маркеры удаления не занимают место версии содержимого. Удаление маркера может снова сделать прежнее содержимое текущим; восстановление через панель создаёт новую версию. Ссылка панели на ранее удалённое/заменённое состояние не должна возобновлять доступ при восстановлении.

Старейшее содержимое сверх пяти версий удаляется автоматически. Это существенное отличие от стандартного неограниченного S3 versioning. `PutBucketVersioning` не поддерживается; отключить заданную политику через S3 нельзя. Для удаления бакета сначала удалите версии, маркеры и незавершённые multipart.

## Multipart и квоты

PartNumber — 1–10000; части в CompleteMultipartUpload должны идти по возрастанию и соответствовать сохранённым ETag. Все части, кроме последней, должны иметь размер не меньше 5 MiB. Общий размер объекта ограничен MAX_OBJECT_BYTES. Части записываются на узлы по текущей топологии до подтверждения; завершение публикует объект только после сборки, проверки и записи копий. Multipart принадлежит создавшему пользователю; ключи другого пользователя не получают управление его частями.

Квоты пользователя и бакета учитывают содержимое сохранённых версий, multipart и резерв активной передачи. Превышение возвращает `QuotaExceeded` с HTTP 403. Для перезаписи части нужен временный запас квоты до фиксации замены. Остатки незавершённых загрузок сохраняются после перезапуска; продолжите или отмените их.

## Что пока не поддерживается

Поддержка отсутствует для следующих возможностей; соответствующие запросы возвращают ошибку, обычно `501 NotImplemented`:

- UploadPartCopy и автоматическая очистка заброшенных multipart по расписанию; ненужную загрузку нужно отменить в панели/API.
- AWS streaming signatures, `aws-chunked`, checksum trailers и CRC64NVME. Обычная потоковая передача HTTP без AWS chunk-подписей поддерживается.
- `CopyObject`, пакетное удаление `DeleteObjects`, переключение/приостановка versioning, object lock, retention и legal hold.
- ACL, bucket policies, AWS IAM, STS, теги, lifecycle, S3 bucket CORS API, notifications, S3 Select, website hosting и access points. Глобальные CORS origins можно настроить через веб-панель; это отдельный API приложения.
- SSE-S3, SSE-KMS, SSE-C и другие S3-заголовки шифрования; передача таких заголовков не включает шифрование автоматически.
- Пользовательские `x-amz-meta-*`, классы хранения, сохранение `Cache-Control`, `Content-Disposition`, `Content-Encoding`, `Content-Language` и `Expires` при загрузке.
- Условные записи и удаления; `If-Match`/`If-None-Match` реализованы только для GET/HEAD. Условия по датам, `If-Range` и несколько ranges не поддерживаются.
- Переопределение заголовков скачивания через `response-content-*` в query string.

Объекты выдаются с `Content-Disposition: attachment`, чтобы загруженный HTML/SVG не исполнялся в origin веб-панели. Это хранилище файлов; размещение исполняемых веб-страниц через S3 endpoint не предусмотрено.

Режимы RAID управляются через веб-панель и не меняют набор S3-команд. По умолчанию метаданные обслуживает один координатор. Дополнительный режим [HA master/slave](HA.md) реплицирует метаданные через etcd и автоматически переключает активный координатор при наличии кворума. При чтении большого объекта с удалённого узла сервер сначала получает и проверяет целую реплику, поэтому даже небольшой `Range` при холодном кеше может потребовать чтения полного объекта.

## Настройка клиентов

Низкоуровневый `put_object` / `s3api put-object` отправляет один PUT. Основные multipart-операции также реализованы, однако высокоуровневые `upload_file`, `aws s3 cp` и другие клиенты нужно проверять с конкретной версией SDK и её checksum-настройками: автоматические AWS trailers пока не поддерживаются. Наличие multipart не означает проверенную совместимость со всеми клиентами.

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

### Встроенный клиент `27g`

Образ 0.3.4 / текущая сборка из исходников включает команду для повторяемой инициализации бакетов:

```sh
27g create-bucket "my-bucket" --if-not-exists
27g create-bucket "my-bucket-2" --if-not-exists
27g create-bucket "my-bucket-3" --if-not-exists
```

Это собственный клиент проекта, не MinIO `mc`. Он использует `S3_ENDPOINT`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` и `AWS_REGION` / `AWS_DEFAULT_REGION` (по умолчанию `us-east-1`). Пару ключей можно передать через `AWS_ACCESS_KEY_ID_FILE` / `AWS_SECRET_ACCESS_KEY_FILE`. Клиент подписывает обычный `CreateBucket` через SigV4; постоянные S3-ключи обязательны. Нужны разрешение `createBucket`, роль `readwrite`, допустимое имя в ограничениях ключа и отсутствие ограничений по префиксам.

Флаг `--if-not-exists` (также `--if-no-exists`) принимает только `409 BucketAlreadyOwnedByYou` как успешный повтор. Он не скрывает `AccessDenied`, сбой связи или другие ошибки и не меняет политику, квоты или содержимое существующего бакета. Без флага повтор возвращает ненулевой код. В исходниках команда вызывается как `node src/cli.mjs create-bucket ...`; справка — `27g --help`. [Полные примеры Docker и Compose, параметры и выдача ключа](INITIALIZATION.ru.md#повторяемая-инициализация-бакетов-через-27g).

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
