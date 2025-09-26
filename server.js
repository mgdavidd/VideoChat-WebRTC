require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const path = require('path');
const cors = require('cors');
const axios = require('axios');
const { uploadDir } = require("./uploadConfig");
const fs = require("fs");


const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: ['http://localhost:3000', 'http://localhost:5173'],
    methods: ['GET', 'POST'],
    credentials: true
  }
});

const MOT_API = process.env.MOT_API_URL || 'https://tu-dominio-mot.com/api';
console.log(MOT_API)

async function verifyScheduledCall(token, jwt) {
  const res = await axios.get(`${MOT_API}/video-links/${token}`, {
    headers: { Authorization: `Bearer ${jwt}` }
  });
  const { startTime, endTime, allowedEmails, userEmail } = res.data;

  const now = new Date();
  if (now < new Date(startTime) || now > new Date(endTime)) {
    throw new Error('Fuera de horario permitido');
  }
  if (allowedEmails && !allowedEmails.includes(userEmail)) {
    throw new Error('Usuario no autorizado');
  }

  return true;
}

process.on("SIGINT", () => {
  if (fs.existsSync(uploadDir)) {
    fs.rmSync(uploadDir, { recursive: true, force: true });
  }
  process.exit();
});

// Middlewares
app.use(cookieParser());
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'secretoseguro',
  resave: false,
  saveUninitialized: true
}));
const routes = require('./routes');
app.use(routes);


app.use(cors({
  origin: 'http://localhost:3000',
  credentials: true
}));

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));


// Rutas
const restRoutes = require('./routes/generateRooms');
app.use(restRoutes);

require('./routes/socket')(io, verifyScheduledCall);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});
