const multer = require("multer");
const fs = require("fs");
const path = require("path");

const uploadDir = path.join(__dirname, "temp_uploads");

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true, mode: 0o777 });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `recording-${Date.now()}.webm`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 1024 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    file.mimetype === "video/webm"
      ? cb(null, true)
      : cb(new Error("Formato no soportado"), false);
  },
});

module.exports = { upload, uploadDir };
