const path = require("path");

const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { S3Client, PutObjectCommand, HeadObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

dotenv.config();

const app = express();

const port = Number(process.env.PORT || 3000);
const endpoint = process.env.YC_S3_ENDPOINT || "https://storage.yandexcloud.net";
const region = process.env.YC_REGION || "ru-central1";
const bucketName = process.env.YC_BUCKET_NAME;
const accessKeyId = process.env.YC_ACCESS_KEY_ID;
const secretAccessKey = process.env.YC_SECRET_ACCESS_KEY;
const expiresIn = Number(process.env.SIGNED_URL_EXPIRES_IN || 300);
const jsonBodyLimit = process.env.JSON_BODY_LIMIT || "1mb";
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || "";
const telegramTeacherChatId = process.env.TELEGRAM_TEACHER_CHAT_ID || "";

const defaultMimeTypes = ["image/jpeg", "image/png", "application/pdf"];
const allowedMimeTypes = (process.env.ALLOWED_MIME_TYPES || "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);
const effectiveMimeTypes = allowedMimeTypes.length ? allowedMimeTypes : defaultMimeTypes;

const corsOrigins = (process.env.CORS_ORIGINS || "*")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

const corsOptions = {
  origin(origin, callback) {
    if (!origin) {
      callback(null, true);
      return;
    }
    if (corsOrigins.includes("*") || corsOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error("CORS policy: origin is not allowed"));
  },
  methods: ["POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json({ limit: jsonBodyLimit }));

if (!bucketName || !accessKeyId || !secretAccessKey) {
  // Keep process up but block API usage with clear startup warning.
  // This helps on first run before .env is configured.
  console.warn(
    "[startup] Missing required env vars: YC_BUCKET_NAME, YC_ACCESS_KEY_ID, YC_SECRET_ACCESS_KEY"
  );
}

const s3Client = new S3Client({
  endpoint,
  region,
  credentials: {
    accessKeyId: accessKeyId || "",
    secretAccessKey: secretAccessKey || ""
  }
});

function sanitizeFileName(fileName) {
  const baseName = path.basename(fileName || "").trim();
  return baseName.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function sanitizeUserName(userName) {
  const normalized = String(userName || "").trim().normalize("NFKC");
  const cleaned = normalized
    .replace(/\s+/g, "_")
    .replace(/[^\p{L}\p{N}._-]/gu, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  return cleaned || "unknown_user";
}

function validateGetUploadUrlPayload(payload) {
  const errors = [];
  const { fileName, fileType, userId, userName } = payload || {};

  if (!fileName || typeof fileName !== "string") {
    errors.push("fileName is required and must be a string");
  }
  if (!fileType || typeof fileType !== "string") {
    errors.push("fileType is required and must be a string");
  }
  if (!userId || typeof userId !== "string") {
    errors.push("userId is required and must be a string");
  }
  if (!userName || typeof userName !== "string") {
    errors.push("userName is required and must be a string");
  }
  if (fileType && !effectiveMimeTypes.includes(fileType)) {
    errors.push(`fileType is not allowed. Allowed: ${effectiveMimeTypes.join(", ")}`);
  }

  return errors;
}

async function sendTeacherNotification(text) {
  if (!telegramBotToken || !telegramTeacherChatId) {
    return { sent: false, reason: "telegram env is not configured" };
  }

  const response = await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: telegramTeacherChatId,
      text,
      disable_web_page_preview: true
    })
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Telegram send failed (${response.status}): ${details}`);
  }

  return { sent: true };
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/get-upload-url", async (req, res) => {
  try {
    if (!bucketName || !accessKeyId || !secretAccessKey) {
      return res.status(500).json({
        error: "Server is not configured. Missing storage credentials or bucket settings."
      });
    }

    const errors = validateGetUploadUrlPayload(req.body);
    if (errors.length > 0) {
      return res.status(400).json({ error: "Validation failed", details: errors });
    }

    const { fileName, fileType, userId, userName, userEmail, userText } = req.body;
    const safeFileName = sanitizeFileName(fileName);
    const safeUserName = sanitizeUserName(userName);
    const timestamp = Date.now();
    const objectKey = `uploads/${userId}_${safeUserName}/${timestamp}-${safeFileName}`;
    const hasUserText = typeof userText === "string" && userText.trim().length > 0;
    const textObjectKey = hasUserText
      ? `uploads/${userId}_${safeUserName}/${timestamp}-comment.txt`
      : null;

    const putCommand = new PutObjectCommand({
      Bucket: bucketName,
      Key: objectKey,
      ContentType: fileType,
      Metadata: userEmail ? { "user-email": String(userEmail) } : undefined
    });

    const signedUrl = await getSignedUrl(s3Client, putCommand, { expiresIn });
    const textSignedUrl = hasUserText
      ? await getSignedUrl(
          s3Client,
          new PutObjectCommand({
            Bucket: bucketName,
            Key: textObjectKey,
            ContentType: "text/plain; charset=utf-8",
            Metadata: userEmail ? { "user-email": String(userEmail) } : undefined
          }),
          { expiresIn }
        )
      : null;

    return res.json({
      signedUrl,
      objectKey,
      textSignedUrl,
      textObjectKey,
      expiresIn
    });
  } catch (error) {
    console.error("[get-upload-url] error:", error);
    return res.status(500).json({
      error: "Internal server error"
    });
  }
});

app.post("/api/upload-complete", async (req, res) => {
  try {
    if (!bucketName || !accessKeyId || !secretAccessKey) {
      return res.status(500).json({
        error: "Server is not configured. Missing storage credentials or bucket settings."
      });
    }

    const {
      userId,
      userName,
      userEmail,
      objectKey,
      textObjectKey,
      fileName,
      fileSize,
      uploadedAt
    } = req.body || {};

    const errors = [];
    if (!userId || typeof userId !== "string") errors.push("userId is required and must be a string");
    if (!userName || typeof userName !== "string")
      errors.push("userName is required and must be a string");
    if (!objectKey || typeof objectKey !== "string")
      errors.push("objectKey is required and must be a string");
    if (!fileName || typeof fileName !== "string")
      errors.push("fileName is required and must be a string");
    if (errors.length > 0) {
      return res.status(400).json({ error: "Validation failed", details: errors });
    }

    const expectedPrefix = `uploads/${userId}_`;
    if (!objectKey.startsWith(expectedPrefix)) {
      return res.status(400).json({
        error: "Validation failed",
        details: ["objectKey does not match userId prefix"]
      });
    }

    const headMainObject = await s3Client.send(
      new HeadObjectCommand({
        Bucket: bucketName,
        Key: objectKey
      })
    );

    let commentExists = false;
    if (textObjectKey && typeof textObjectKey === "string") {
      try {
        await s3Client.send(
          new HeadObjectCommand({
            Bucket: bucketName,
            Key: textObjectKey
          })
        );
        commentExists = true;
      } catch (_error) {
        commentExists = false;
      }
    }

    const notificationLines = [
      `Поступил вопрос эксперту от: ${userName} (ID: ${userId})`,
      `Email: ${userEmail || "-"}`,
      `Файл: ${fileName}`,
      `Размер: ${fileSize ?? headMainObject.ContentLength ?? "-"} байт`,
      `Комментарий: ${commentExists ? "есть" : "нет"}`,
      `Время: ${uploadedAt || new Date().toISOString()}`
    ];

    let notifyResult = { sent: false, reason: "not attempted" };
    try {
      notifyResult = await sendTeacherNotification(notificationLines.join("\n"));
    } catch (notificationError) {
      console.error("[upload-complete] telegram error:", notificationError);
      notifyResult = { sent: false, reason: notificationError.message };
    }

    return res.json({
      ok: true,
      objectExists: true,
      commentExists,
      notified: notifyResult.sent,
      notifyReason: notifyResult.reason || null
    });
  } catch (error) {
    console.error("[upload-complete] error:", error);
    return res.status(500).json({
      error: "Internal server error"
    });
  }
});

app.use((err, _req, res, _next) => {
  if (err?.message?.startsWith("CORS policy")) {
    return res.status(403).json({ error: err.message });
  }
  return res.status(500).json({ error: "Internal server error" });
});

app.listen(port, () => {
  console.log(`API is running on http://localhost:${port}`);
});
