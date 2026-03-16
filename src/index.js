const crypto = require("crypto");
const path = require("path");

const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
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

function validateGetUploadUrlPayload(payload) {
  const errors = [];
  const { fileName, fileType, userId } = payload || {};

  if (!fileName || typeof fileName !== "string") {
    errors.push("fileName is required and must be a string");
  }
  if (!fileType || typeof fileType !== "string") {
    errors.push("fileType is required and must be a string");
  }
  if (!userId || typeof userId !== "string") {
    errors.push("userId is required and must be a string");
  }
  if (fileType && !effectiveMimeTypes.includes(fileType)) {
    errors.push(`fileType is not allowed. Allowed: ${effectiveMimeTypes.join(", ")}`);
  }

  return errors;
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

    const { fileName, fileType, userId, userEmail } = req.body;
    const safeFileName = sanitizeFileName(fileName);
    const timestamp = Date.now();
    const randomSuffix = crypto.randomBytes(4).toString("hex");
    const objectKey = `uploads/${userId}/${timestamp}-${randomSuffix}-${safeFileName}`;

    const putCommand = new PutObjectCommand({
      Bucket: bucketName,
      Key: objectKey,
      ContentType: fileType,
      Metadata: userEmail ? { "user-email": String(userEmail) } : undefined
    });

    const signedUrl = await getSignedUrl(s3Client, putCommand, { expiresIn });

    return res.json({
      signedUrl,
      objectKey,
      expiresIn
    });
  } catch (error) {
    console.error("[get-upload-url] error:", error);
    return res.status(500).json({
      error: "Internal server error"
    });
  }
});

app.post("/api/upload-complete", (req, res) => {
  const { userId, objectKey, fileName, fileSize } = req.body || {};
  if (!userId || !objectKey || !fileName) {
    return res.status(400).json({
      error: "Validation failed",
      details: ["userId, objectKey, fileName are required"]
    });
  }

  // Placeholder hook: here you can call GetCourse API or store logs.
  console.log("[upload-complete]", {
    userId,
    objectKey,
    fileName,
    fileSize: fileSize ?? null,
    at: new Date().toISOString()
  });

  return res.json({ ok: true });
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
