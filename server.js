const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const session = require("express-session");
const cookieParser = require("cookie-parser");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.set("view engine", "ejs");
app.use(cookieParser());
app.use(express.json({ limit: "500mb" }));
app.use(express.urlencoded({ extended: true, limit: "500mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "secretoseguro",
    resave: false,
    saveUninitialized: true,
  })
);

// Middleware global
const { authMiddleware } = require("./authMiddleware");
app.use(authMiddleware);

// Rutas
const routes = require("./routes");
app.use(routes);

// WebSocket
require("./routes/socket")(io);

// Cierre limpio (opcional)
const { uploadDir } = require("./uploadConfig");
const fs = require("fs");

process.on("SIGINT", () => {
  if (fs.existsSync(uploadDir)) {
    fs.rmSync(uploadDir, { recursive: true, force: true });
  }
  process.exit();
});

// Start
const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`)
);
