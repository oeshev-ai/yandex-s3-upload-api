# Signed Upload URL API for Yandex Object Storage

API-сервис для безопасной загрузки файлов в Yandex Object Storage (S3-совместимый API) через signed URL. После успешной загрузки умеет проверить объект в бакете и уведомить преподавателя в Telegram.

## Что делает сервис

- `GET /health` — проверка, что сервис жив
- `POST /api/get-upload-url` — выдаёт signed URL для `putObject`
- `POST /api/upload-complete` — проверяет, что файл реально лежит в бакете, и опционально шлёт уведомление в Telegram
- Генерирует `objectKey` в формате `uploads/{userId}_{userName}/{timestamp}-{fileName}`
- Если передан `userText`, дополнительно выдаёт signed URL для комментария (`…-comment.txt`)
- Время жизни signed URL ограничено (по умолчанию 300 секунд)

## Технологии

- Node.js 18+ + Express
- AWS SDK v3 (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`)
- Yandex Object Storage endpoint: `https://storage.yandexcloud.net`
- Telegram Bot API (уведомления преподавателю)

## API

### GET `/health`

```json
{ "ok": true }
```

### POST `/api/get-upload-url`

#### Входной JSON

```json
{
  "fileName": "example.pdf",
  "fileType": "application/pdf",
  "userId": "12345",
  "userName": "Иван Иванов",
  "userEmail": "user@example.com",
  "userText": "Вопрос по ДЗ"
}
```

| Поле | Обязательно | Описание |
|------|-------------|----------|
| `fileName` | да | Имя файла |
| `fileType` | да | MIME-тип из whitelist |
| `userId` | да | ID пользователя |
| `userName` | да | Имя пользователя (попадает в путь объекта) |
| `userEmail` | нет | Пишется в metadata объекта |
| `userText` | нет | Текст комментария; если есть — вернётся `textSignedUrl` |

#### Успешный ответ

```json
{
  "signedUrl": "https://storage.yandexcloud.net/bucket/path/to/file?...",
  "objectKey": "uploads/12345_Ivan_Ivanov/1623456789-example.pdf",
  "textSignedUrl": "https://storage.yandexcloud.net/bucket/path/to/comment?...",
  "textObjectKey": "uploads/12345_Ivan_Ivanov/1623456789-comment.txt",
  "expiresIn": 300
}
```

Если `userText` не передан, `textSignedUrl` и `textObjectKey` будут `null`.

#### Ошибка валидации (400)

```json
{
  "error": "Validation failed",
  "details": [
    "fileType is not allowed. Allowed: image/jpeg, image/png, application/pdf"
  ]
}
```

### POST `/api/upload-complete`

Проверяет наличие объекта в бакете (`HeadObject`) и при настроенном Telegram отправляет уведомление преподавателю.

#### Входной JSON

```json
{
  "userId": "12345",
  "userName": "Иван Иванов",
  "userEmail": "user@example.com",
  "objectKey": "uploads/12345_Ivan_Ivanov/1623456789-example.pdf",
  "textObjectKey": "uploads/12345_Ivan_Ivanov/1623456789-comment.txt",
  "fileName": "example.pdf",
  "fileSize": 123456,
  "uploadedAt": "2026-11-03T10:00:00.000Z"
}
```

| Поле | Обязательно | Описание |
|------|-------------|----------|
| `userId` | да | ID пользователя |
| `userName` | да | Имя пользователя |
| `objectKey` | да | Ключ загруженного файла (должен начинаться с `uploads/{userId}_`) |
| `fileName` | да | Имя файла для уведомления |
| `userEmail` | нет | Email в тексте уведомления |
| `textObjectKey` | нет | Ключ комментария; проверяется отдельно |
| `fileSize` | нет | Размер файла (иначе берётся из S3) |
| `uploadedAt` | нет | Время загрузки (иначе текущее UTC) |

#### Успешный ответ

```json
{
  "ok": true,
  "objectExists": true,
  "commentExists": true,
  "notified": true,
  "notifyReason": null
}
```

Если Telegram не настроен, `notified` будет `false`, а `notifyReason` — например `"telegram env is not configured"`.

## Локальный запуск

1. Установить Node.js 18+
2. Установить зависимости:

```bash
npm install
```

3. Создать `.env` из примера:

```bash
cp .env.example .env
```

На Windows (PowerShell):

```powershell
Copy-Item .env.example .env
```

4. Заполнить переменные окружения в `.env`
5. Запустить:

```bash
npm run dev
```

Или production-режим:

```bash
npm start
```

## Переменные окружения

Обязательные:

- `YC_ACCESS_KEY_ID`
- `YC_SECRET_ACCESS_KEY`
- `YC_BUCKET_NAME`

Рекомендуемые:

- `PORT=3000`
- `NODE_ENV=development`
- `YC_REGION=ru-central1`
- `YC_S3_ENDPOINT=https://storage.yandexcloud.net`
- `SIGNED_URL_EXPIRES_IN=300`
- `ALLOWED_MIME_TYPES=image/jpeg,image/png,application/pdf`
- `CORS_ORIGINS=*` (для dev; в production указать конкретные домены)
- `JSON_BODY_LIMIT=1mb`

Уведомления преподавателю (опционально):

- `TELEGRAM_BOT_TOKEN` — токен бота от [@BotFather](https://t.me/BotFather)
- `TELEGRAM_TEACHER_CHAT_ID` — chat id преподавателя (или группы)

Без этих двух переменных API работает, но `/api/upload-complete` не шлёт сообщения в Telegram.

## CORS

Для production укажите точные origin:

```env
CORS_ORIGINS=https://school.example.com,https://youraccount.getcourse.ru
```

Для разработки можно оставить:

```env
CORS_ORIGINS=*
```

Разрешённые методы: `POST`, `OPTIONS`. Заголовок: `Content-Type`, `Authorization`.

## Типичный клиентский сценарий

1. `POST /api/get-upload-url` с метаданными файла
2. `PUT` файла на `signedUrl` (тот же `Content-Type`, что в `fileType`)
3. Если есть комментарий — `PUT` текста на `textSignedUrl` с `Content-Type: text/plain; charset=utf-8`
4. `POST /api/upload-complete` с `objectKey` (и `textObjectKey`, если был комментарий)

## Примеры curl

Получение signed URL:

```bash
curl -X POST "http://localhost:3000/api/get-upload-url" \
  -H "Content-Type: application/json" \
  -d '{
    "fileName":"example.pdf",
    "fileType":"application/pdf",
    "userId":"12345",
    "userName":"Иван Иванов",
    "userEmail":"user@example.com",
    "userText":"Вопрос по ДЗ"
  }'
```

Загрузка файла по signed URL:

```bash
curl -X PUT "SIGNED_URL_FROM_API" \
  -H "Content-Type: application/pdf" \
  --data-binary "@example.pdf"
```

Загрузка комментария (если вернули `textSignedUrl`):

```bash
curl -X PUT "TEXT_SIGNED_URL_FROM_API" \
  -H "Content-Type: text/plain; charset=utf-8" \
  --data-binary "Вопрос по ДЗ"
```

Завершение загрузки:

```bash
curl -X POST "http://localhost:3000/api/upload-complete" \
  -H "Content-Type: application/json" \
  -d '{
    "userId":"12345",
    "userName":"Иван Иванов",
    "userEmail":"user@example.com",
    "objectKey":"uploads/12345_Ivan_Ivanov/1623456789-example.pdf",
    "textObjectKey":"uploads/12345_Ivan_Ivanov/1623456789-comment.txt",
    "fileName":"example.pdf",
    "fileSize":123456
  }'
```

Важно: `Content-Type` при `PUT` должен совпадать с типом, который использовался при генерации подписи.

## Деплой на VPS (Ubuntu) + PM2 + Nginx + HTTPS

### 1) Подготовка сервера

```bash
sudo apt update
sudo apt install -y nginx curl
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

### 2) Развертывание приложения

```bash
mkdir -p /var/www/yc-upload-url-api
cd /var/www/yc-upload-url-api
# Скопируйте сюда файлы проекта (git clone/scp)
npm install --omit=dev
cp .env.example .env
nano .env
```

Проверьте запуск:

```bash
npm start
```

### 3) Запуск как демон через PM2

В репозитории есть `ecosystem.config.js`:

```bash
cd /var/www/yc-upload-url-api
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

Альтернатива без ecosystem-файла:

```bash
pm2 start src/index.js --name yc-upload-url-api
```

### 4) Nginx reverse proxy

Создайте конфиг:

```bash
sudo nano /etc/nginx/sites-available/yc-upload-url-api
```

Содержимое:

```nginx
server {
    listen 80;
    server_name api.school.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Включить сайт и перезапустить nginx:

```bash
sudo ln -s /etc/nginx/sites-available/yc-upload-url-api /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 5) HTTPS (Let’s Encrypt)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.school.example.com
```

Проверка автообновления:

```bash
sudo certbot renew --dry-run
```

После этого API будет доступен по HTTPS.

## Критерии приемки

- `GET /health` возвращает `{ "ok": true }`
- Корректный `POST /api/get-upload-url` возвращает рабочий `signedUrl`, `objectKey`, `expiresIn` (и при `userText` — `textSignedUrl` / `textObjectKey`)
- При невалидных данных API возвращает `400`
- `POST /api/upload-complete` проверяет объект в бакете и при настроенном Telegram шлёт уведомление
- Секретные ключи берутся только из переменных окружения
- API доступен по HTTPS (через Nginx + Certbot)
