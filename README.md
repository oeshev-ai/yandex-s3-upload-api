# Signed Upload URL API for Yandex Object Storage

Простой API-сервис, который выдает подписанный URL для безопасной загрузки файла напрямую в Yandex Object Storage (S3-совместимый API).

## Что делает сервис

- Принимает `POST /api/get-upload-url`
- Проверяет входные данные (`fileName`, `fileType`, `userId`)
- Генерирует `objectKey` в формате `uploads/{userId}/{timestamp}-{random}-{fileName}`
- Возвращает signed URL для `putObject` c ограниченным временем жизни (по умолчанию 300 секунд)
- Опционально принимает `POST /api/upload-complete` для логирования завершенной загрузки

## Технологии

- Node.js + Express
- AWS SDK v3 (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`)
- Yandex Object Storage endpoint: `https://storage.yandexcloud.net`

## API

### POST `/api/get-upload-url`

#### Входной JSON

```json
{
  "fileName": "example.pdf",
  "fileType": "application/pdf",
  "userId": "12345",
  "userEmail": "user@example.com"
}
```

#### Успешный ответ

```json
{
  "signedUrl": "https://storage.yandexcloud.net/bucket/path/to/file?...",
  "objectKey": "uploads/12345/1623456789-ab12cd34-example.pdf",
  "expiresIn": 300
}
```

#### Ошибка валидации (400)

```json
{
  "error": "Validation failed",
  "details": [
    "fileType is not allowed. Allowed: image/jpeg, image/png, application/pdf"
  ]
}
```

### POST `/api/upload-complete` (опционально)

Принимает:

```json
{
  "userId": "12345",
  "objectKey": "uploads/12345/1623456789-ab12cd34-example.pdf",
  "fileName": "example.pdf",
  "fileSize": 123456
}
```

Ответ:

```json
{
  "ok": true
}
```

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
- `YC_REGION=ru-central1`
- `YC_S3_ENDPOINT=https://storage.yandexcloud.net`
- `SIGNED_URL_EXPIRES_IN=300`
- `ALLOWED_MIME_TYPES=image/jpeg,image/png,application/pdf`
- `CORS_ORIGINS=*` (для dev; в production указать конкретные домены)
- `JSON_BODY_LIMIT=1mb`

## CORS

Для production укажите точные origin:

```env
CORS_ORIGINS=https://school.example.com,https://youraccount.getcourse.ru
```

Для разработки можно оставить:

```env
CORS_ORIGINS=*
```

## Примеры curl

Получение signed URL:

```bash
curl -X POST "http://localhost:3000/api/get-upload-url" \
  -H "Content-Type: application/json" \
  -d '{
    "fileName":"example.pdf",
    "fileType":"application/pdf",
    "userId":"12345",
    "userEmail":"user@example.com"
  }'
```

Загрузка файла по signed URL:

```bash
curl -X PUT "SIGNED_URL_FROM_API" \
  -H "Content-Type: application/pdf" \
  --data-binary "@example.pdf"
```

Важно: `Content-Type` при `PUT` должен совпадать с `fileType`, который использовался при генерации подписи.

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

```bash
cd /var/www/yc-upload-url-api
pm2 start src/index.js --name yc-upload-url-api
pm2 save
pm2 startup
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

- Корректный `POST /api/get-upload-url` возвращает рабочий signed URL, `objectKey`, `expiresIn`
- При невалидных данных API возвращает `400`
- Секретные ключи берутся только из переменных окружения
- API доступен по HTTPS (через Nginx + Certbot)
