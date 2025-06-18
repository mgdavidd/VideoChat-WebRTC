const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cookieParser = require("cookie-parser");
const { createClient } = require("@libsql/client");
const dotenv = require("dotenv");
const { OAuth2Client } = require("google-auth-library");
const { google } = require("googleapis");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { DateTime } = require("luxon");
const session = require("express-session");

// Configuración inicial
dotenv.config();
const uploadDir = path.join(__dirname, "temp_uploads");
const db = createClient({
  url: process.env.DB_URL,
  authToken: process.env.DB_AUTH_TOKEN,
});
const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const oAuth2Client = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// Configuración de Multer
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

// Middlewares
app.set("view engine", "ejs");
app.use(cookieParser());
app.use(express.json({ limit: "500mb" }));
app.use(express.urlencoded({ extended: true, limit: "500mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use(session({
  secret: process.env.SESSION_SECRET || "secretoseguro",
  resave: false,
  saveUninitialized: true,
}));

server.headersTimeout = 600000;
server.keepAliveTimeout = 600000;

// Middleware de autenticación
const allowedPaths = [
  "/", "/signup", "/login", "/join", "/fechas",
  "/auth/google", "/auth/google/callback", "/choose-username"
];

app.use(async (req, res, next) => {
  if (!req.cookies.userName && !allowedPaths.includes(req.path)) {
    return res.redirect("/");
  }

  if (req.cookies.userName) {
    try {
      const result = await db.execute(
        "SELECT is_admin FROM users WHERE nombre = ?", 
        [req.cookies.userName]
      );
      req.isAdmin = result.rows[0]?.is_admin === 1;
    } catch (err) {
      console.error("Error verificando admin:", err);
      return res.status(500).send("Error interno");
    }
  }
  next();
});

async function createDriveFolder(drive, userName) {
  const folderResponse = await drive.files.create({
    requestBody: {
      name: `Grabaciones VideoLlamadas - ${userName}`,
      mimeType: "application/vnd.google-apps.folder",
    },
  });
  return folderResponse.data.id;
}

async function getAdminDriveClient(adminUserName) {
  try {
    const userResult = await db.execute(
      `SELECT google_token, google_drive_folder_id 
       FROM users WHERE nombre = ? AND is_admin = 1`,
      [adminUserName]
    );

    if (!userResult.rows[0]) {
      throw new Error("Usuario administrador no encontrado");
    }

    const admin = userResult.rows[0];
    
    // intentar con OAuth del usuario
    if (admin.google_token) {
      try {
        const auth = new OAuth2Client(
          process.env.GOOGLE_CLIENT_ID,
          process.env.GOOGLE_CLIENT_SECRET
        );
        auth.setCredentials(JSON.parse(admin.google_token));
        const drive = google.drive({ version: "v3", auth });

        let folderId = admin.google_drive_folder_id;
        if (!folderId) {
          folderId = await createDriveFolder(drive, adminUserName);
          await db.execute(
            "UPDATE users SET google_drive_folder_id = ? WHERE nombre = ?",
            [folderId, adminUserName]
          );
        }
        return { auth, folderId };
      } catch (oauthError) {
        console.error("Error con OAuth:", oauthError);
      }
    }
  } catch (error) {
    console.error("Error obteniendo Drive:", error);
    throw error;
  }
}

// Funciones de fecha/hora (optimizadas)
async function checkRoomAvailability(roomId) {
  const nowUTC = DateTime.utc().toISO();
  const result = await db.execute(
    `SELECT 1 FROM fechas 
     WHERE roomId = ? AND ? BETWEEN fecha_inicial_utc AND fecha_final_utc`,
    [roomId, nowUTC]
  );
  return result.rows.length > 0;
}

// Rutas
app.get("/", (req, res) => res.render("login"));
app.get("/signup", (req, res) => res.render("signup"));
app.get("/rooms-form", (req, res) => res.render("room-form", { 
  userName: req.cookies.userName 
}));
app.get("/calendar-form", (req, res) => res.render("calendar-form"));
app.get("/choose-username", (req, res) => res.render("choose-username", {
  error: req.query.error || null
}));

app.post("/login", async (req, res) => {
  const { userName, password } = req.body;
  try {
    const result = await db.execute(
      "SELECT * FROM users WHERE nombre = ? AND contraseña = ?",
      [userName, password]
    );
    
    if (result.rows.length > 0) {
      res.cookie("userName", userName, { maxAge: 900000 });
      return res.redirect("/rooms-form");
    }
  } catch (error) {
    console.error("Error en login:", error);
  }
  res.redirect("/");
});

app.post("/signup", async (req, res) => {
  const { userName, email, password, isAdmin } = req.body;
  if (!userName || !email || !password) {
    return res.redirect("/signup");
  }

  try {
    await db.execute(
      "INSERT INTO users (nombre, correo, contraseña, is_admin) VALUES (?, ?, ?, ?)",
      [userName, email, password, isAdmin === "on" ? 1 : 0]
    );

    res.cookie("userName", userName, { maxAge: 900000 });
    return isAdmin === "on" 
      ? res.redirect("/instrucciones-admin") 
      : res.redirect("/rooms-form");
  } catch (err) {
    console.error("Error en registro:", err);
    res.redirect("/signup");
  }
});

app.get("/instrucciones-admin", async (req, res) => {
  const userName = req.cookies.userName;
  if (!userName) return res.redirect("/login");
  const userResult = await db.execute(
    "SELECT is_admin FROM users WHERE nombre = ?",
    [userName]
  );
  if (!userResult.rows.length || !userResult.rows[0].is_admin) {
    return res.redirect("/rooms-form");
  }
  res.render("instructions");
});

app.post("/join", async (req, res) => {
  const { roomId } = req.body;
  try {
    const isOpen = await checkRoomAvailability(roomId);
    return isOpen 
      ? res.redirect(`/room/${roomId}`)
      : res.render("room-closed");
  } catch (error) {
    console.error("Error verificando sala:", error);
    res.render("room-closed");
  }
});

app.post("/calendar-form", (req, res) => {
  const { roomId } = req.body;
  roomId 
    ? res.render("calendar", { roomId }) 
    : res.redirect("/");
});

// Rutas de fechas (optimizadas)
app.get("/fechas/:roomId", async (req, res) => {
  try {
    const result = await db.execute(
      "SELECT fecha_inicial_utc, fecha_final_utc, tipo FROM fechas WHERE roomId = ?",
      [req.params.roomId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error obteniendo fechas:", err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

app.post("/fechas", async (req, res) => {
  const { fechas = [], selectedDates = [], roomId = "1" } = req.body;
  
  if (!Array.isArray(fechas)) {
    return res.status(400).json({ error: "Formato inválido" });
  }

  try {
    // Eliminar fechas no seleccionadas
    if (selectedDates.length > 0) {
      await db.execute(
        `DELETE FROM fechas 
         WHERE roomId = ? AND fecha_local NOT IN (${selectedDates.map(() => "?").join(",")})`,
        [roomId, ...selectedDates]
      );
    }

    // Procesar cada fecha
    for (const f of fechas) {
      const { date, start, end, type, timeZone } = f;
      
      if (!date || !start || !end || !timeZone) {
        return res.status(400).json({ error: "Datos incompletos" });
      }
      
      // Convertir a UTC
      const startUTC = DateTime.fromISO(`${date}T${start}`, { zone: timeZone }).toUTC().toISO();
      const endUTC = DateTime.fromISO(`${date}T${end}`, { zone: timeZone }).toUTC().toISO();

      // Insertar o actualizar
      await db.execute(
        `INSERT INTO fechas (
          fecha_inicial_utc, fecha_final_utc, tipo, roomId, fecha_local
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(roomId, fecha_local) DO UPDATE SET
          fecha_inicial_utc = excluded.fecha_inicial_utc,
          fecha_final_utc = excluded.fecha_final_utc,
          tipo = excluded.tipo`,
        [startUTC, endUTC, type, roomId, date]
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error("Error guardando fechas:", err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// Rutas de Google
app.get("/auth/google", (req, res) => {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: [
      "https://www.googleapis.com/auth/drive.file",
      "https://www.googleapis.com/auth/drive.metadata",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile"
    ],
    prompt: "consent",
  });
  res.redirect(authUrl);
});

app.get("/auth/google/callback", async (req, res) => { 
  try {
    const { tokens } = await oAuth2Client.getToken(req.query.code);
    oAuth2Client.setCredentials(tokens);
    
    const people = google.people({ version: "v1", auth: oAuth2Client });
    const { data } = await people.people.get({
      resourceName: "people/me",
      personFields: "emailAddresses",
    });
    
    const userEmail = data.emailAddresses?.[0]?.value?.toLowerCase();
    if (!userEmail) throw new Error("Email no disponible");

    // Buscar usuario existente
    const userResult = await db.execute(
      "SELECT * FROM users WHERE LOWER(correo) = ?",
      [userEmail]
    );

    if (userResult.rows.length) {
      await db.execute(
        "UPDATE users SET google_token = ? WHERE correo = ?",
        [JSON.stringify(tokens), userEmail]
      );
      res.cookie("userName", userResult.rows[0].nombre);
      return res.redirect("/rooms-form");
    }

    // Nuevo usuario
    req.session.googleToken = tokens;
    req.session.googleEmail = userEmail;
    res.redirect("/choose-username");
  } catch (err) {
    console.error("Error en Google Auth:", err);
    res.redirect("/?error=auth_failed");
  }
});

app.post("/choose-username", async (req, res) => {
  const { userName, password } = req.body;
  
  if (!req.session?.googleEmail || !userName || !password) {
    return res.redirect("/choose-username?error=missing_data");
  }

  try {
    // Verificar nombre de usuario único
    const exists = await db.execute(
      "SELECT 1 FROM users WHERE nombre = ?",
      [userName]
    );
    
    if (exists.rows.length) {
      return res.redirect("/choose-username?error=username_taken");
    }

    // Crear nuevo usuario
    await db.execute(
      "INSERT INTO users (nombre, contraseña, correo, google_token) VALUES (?, ?, ?, ?)",
      [userName, password, req.session.googleEmail, JSON.stringify(req.session.googleToken)]
    );

    res.cookie("userName", userName);
    delete req.session.googleEmail;
    delete req.session.googleToken;
    res.redirect("/rooms-form");
  } catch (err) {
    console.error("Error creando usuario:", err);
    res.redirect("/choose-username?error=server");
  }
});

// Rutas de sala y grabaciones
app.get("/room/:id", (req, res) => res.render("room", {
  roomId: req.params.id,
  userName: req.cookies.userName,
  isAdmin: req.isAdmin,
}));

app.post("/api/upload-recording", upload.single("recording"), async (req, res) => {
  try {
    if (!req.file) throw new Error("Archivo no recibido");
    
    const { roomId, adminUserName } = req.body;
    if (!roomId || !adminUserName) throw new Error("Datos incompletos");

    const { auth, folderId } = await getAdminDriveClient(adminUserName);
    const drive = google.drive({ version: "v3", auth });

    const { data } = await drive.files.create({
      requestBody: {
        name: `Grabacion-${roomId}-${Date.now()}.webm`,
        mimeType: "video/webm",
        parents: [folderId],
      },
      media: {
        mimeType: "video/webm",
        body: fs.createReadStream(req.file.path),
      },
      fields: "id,webViewLink",
    });

    // Limpieza
    fs.unlink(req.file.path, () => {});
    
    res.json({ 
      success: true,
      fileId: data.id,
      fileLink: data.webViewLink,
    });
  } catch (error) {
    console.error("Error subiendo grabación:", error);
    
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    res.status(500).json({ 
      error: "Error al subir", 
      details: error.message 
    });
  }
});

// Socket.io (optimizado)
const rooms = {};

io.on("connection", (socket) => {
  socket.on("join-room", ({ roomId, userName }) => {
    // Inicializar sala
    rooms[roomId] = rooms[roomId] || {};
    rooms[roomId][socket.id] = userName;
    socket.join(roomId);
    socket.roomId = roomId;

    // Notificar usuarios
    const usersInRoom = Object.entries(rooms[roomId])
      .filter(([id]) => id !== socket.id)
      .map(([id, name]) => ({ userId: id, userName: name }));
    
    socket.emit("users-in-room", usersInRoom);
    socket.to(roomId).emit("new-user", { userId: socket.id, userName });
  });

  // Manejo de eventos básicos
  const handleEvent = (event) => (data) => {
    if (socket.roomId) socket.to(data.target).emit(event, { ...data, sender: socket.id });
  };

  socket.on("update-media-status", (data) => {
    if (socket.roomId) socket.to(socket.roomId).emit("update-media-status", data);
  });

  socket.on("offer", handleEvent("offer"));
  socket.on("answer", handleEvent("answer"));
  socket.on("candidate", handleEvent("candidate"));

  socket.on("kick-user", ({ targetId }) => {
    if (rooms[socket.roomId]?.[socket.id] === "David") {
      io.to(targetId).emit("kicked");
      delete rooms[socket.roomId][targetId];
    }
  });

  socket.on("disconnect", () => {
    if (!socket.roomId || !rooms[socket.roomId]) return;
    
    delete rooms[socket.roomId][socket.id];
    socket.to(socket.roomId).emit("user-disconnected", socket.id);
    
    if (Object.keys(rooms[socket.roomId]).length === 0) {
      delete rooms[socket.roomId];
    }
  });

  // Verificación periódica de salas expiradas
  setInterval(async () => {
    try {
      const nowUTC = DateTime.utc().toISO();
      const expiredRoomsResult = await db.execute(
        `SELECT roomId FROM fechas
         GROUP BY roomId
         HAVING COUNT(CASE WHEN ? BETWEEN fecha_inicial_utc AND fecha_final_utc THEN 1 END) = 0`,
        [nowUTC]
      );

      for (const { roomId } of expiredRoomsResult.rows) {
        if (rooms[roomId]) {
          io.to(roomId).emit("force-close-room");
          for (const socketId in rooms[roomId]) {
            io.sockets.sockets.get(socketId)?.disconnect();
          }
          delete rooms[roomId];
        }
      }
    } catch (error) {
      console.error("Error verificando salas expiradas:", error);
    }
  }, 60000);
});

// Manejo de cierre
process.on("SIGINT", () => {
  if (fs.existsSync(uploadDir)) {
    fs.rmSync(uploadDir, { recursive: true, force: true });
  }
  process.exit();
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor en ejecución en http://localhost:${PORT}`);
});