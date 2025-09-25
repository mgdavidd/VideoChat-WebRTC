const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const { DateTime } = require("luxon");
const axios = require("axios");

const JWT_SECRET = process.env.JWT_SECRET || "clave_super_segura";

// ========================
// Crear/obtener sala
// ========================
router.post("/api/calls", async (req, res) => {
  const { 
    course_id, 
    session_date, 
    start_utc, 
    end_utc, 
    room_id: existingRoomId 
  } = req.body;

  if (!start_utc || !end_utc) {
    return res.status(400).json({ error: "Faltan campos requeridos" });
  }

  const startUTC = DateTime.fromISO(start_utc, { zone: "utc" });
  const endUTC = DateTime.fromISO(end_utc, { zone: "utc" });
  
  if (!startUTC.isValid || !endUTC.isValid) {
    return res.status(400).json({ error: "Formato de fecha UTC inválido" });
  }

  if (endUTC <= startUTC) {
    return res.status(400).json({ error: "La hora final debe ser mayor a la hora inicial" });
  }

  try {
    let room_id = existingRoomId || uuidv4();
    let isNewRoom = true;

    // Buscar sala existente por fecha
    if (!existingRoomId) {
      const existing = await db.execute(
        `SELECT room_id, link FROM llamadas_mot 
         WHERE course_id = ? AND DATE(start_time) = ?`,
        [course_id, session_date]
      );
      
      if (existing.rows.length > 0) {
        room_id = existing.rows[0].room_id;
        const link = existing.rows[0].link;
        return res.json({
          room_id,
          link,
          is_new: false,
          utc_timestamps: { start: startUTC.toISO(), end: endUTC.toISO() }
        });
      }
    } else {
      // Verificar si existe por room_id
      const existing = await db.execute(
        `SELECT room_id, link FROM llamadas_mot WHERE room_id = ?`,
        [room_id]
      );
      if (existing.rows.length > 0) {
        return res.json({
          room_id,
          link: existing.rows[0].link,
          is_new: false,
          utc_timestamps: { start: startUTC.toISO(), end: endUTC.toISO() }
        });
      }
    }

    // Si llegamos aquí, sí creamos una nueva sala
    const token = jwt.sign({ room_id, course_id }, JWT_SECRET);
    const link = `/join?token=${token}`;

    await db.execute(
      `INSERT INTO llamadas_mot (course_id, room_id, link, start_time, end_time)
       VALUES (?, ?, ?, ?, ?)`,
      [course_id, room_id, link, startUTC.toISO(), endUTC.toISO()]
    );

    return res.json({
      room_id,
      link,
      is_new: true,
      utc_timestamps: { start: startUTC.toISO(), end: endUTC.toISO() }
    });

  } catch (err) {
    console.error("Error crítico en /api/calls:", err);
    return res.status(500).json({ error: "Error al procesar la sala" });
  }
});

// ========================
// Ingreso a la sala
// ========================
router.get("/join", async (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.render("inactive", { error: "Token faltante" });
  }

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return res.render("inactive", { error: "Token inválido o expirado" });
  }

  // Obtener datos de usuario
  const userJwt = req.cookies.token || req.headers.authorization?.split(" ")[1];
  let userData = { role: null, name: null, email: null, id: null };

  if (userJwt) {
    try {
      const decoded = jwt.verify(userJwt, JWT_SECRET);
      userData = {
        role: decoded.rol,
        name: decoded.nombre,
        email: decoded.email,
        id: decoded.id,
      };
    } catch (err) {
      console.warn("Token de usuario inválido:", err.message);
    }
  }

  try {
    // Obtener datos de la sala
    const roomResult = await db.execute(
      `SELECT * FROM llamadas_mot WHERE room_id = ?`,
      [payload.room_id]
    );
    const room = roomResult.rows[0];

    if (!room) {
      return res.render("inactive", { error: "Sala no encontrada" });
    }

    const nowUTC = DateTime.utc();
    const startUTC = DateTime.fromISO(room.start_time, { zone: "utc" });
    const endUTC = DateTime.fromISO(room.end_time, { zone: "utc" });

    if (nowUTC < startUTC) {
      const remaining = startUTC.diff(nowUTC, ["hours", "minutes"]).toObject();
      return res.render("inactive", {
        error: `La sala estará disponible en ${Math.floor(remaining.hours)}h ${Math.floor(remaining.minutes)}m`
      });
    }

    if (nowUTC > endUTC) {
      return res.render("inactive", { error: "La sesión ha finalizado" });
    }

    // Validar acceso al curso usando la API interna
    const MOT_API = process.env.MOT_API_URL;
    try {
      const { data } = await axios.get(
        `${MOT_API}/api/validate-course-access/${userData.id}/${room.course_id}`,
        { headers: { Authorization: `Bearer ${process.env.INTERNAL_API_KEY}` }, timeout: 5000 }
      );

      if (!data.allowed) {
        return res.render("inactive", { error: "No estás autorizado para ingresar" });
      }
    } catch (err) {
      console.error("Error al validar permisos:", err.message);
      return res.render("inactive", { error: "Error al verificar tu acceso al curso" });
    }

    let modules = [];
    if (userData.role === "profesor") {
      try {
        const response = await axios.get(
          `http://localhost:3000/courses/${room.course_id}/modules/${userData.id}`,
          { headers: { Authorization: `Bearer ${process.env.INTERNAL_API_KEY}` }, timeout: 5000 }
        );
        modules = response.data || [];
      } catch (err) {
        console.error("Error obteniendo módulos:", err.message);
      }
    }

    const localStart = startUTC.setZone("America/Bogota");
    const localEnd = endUTC.setZone("America/Bogota");
    const localNow = nowUTC.setZone("America/Bogota");

    const schedule = {
      start: localStart.toFormat("h:mm a"),
      end: localEnd.toFormat("h:mm a"),
      date: localStart.toFormat("d 'de' LLLL 'de' y"),
      utcStart: startUTC.toFormat("HH:mm"),
      utcEnd: endUTC.toFormat("HH:mm"),
      fullStart: localStart.toFormat("d 'de' LLLL 'de' y 'a las' h:mm a"),
      fullEnd: localEnd.toFormat("d 'de' LLLL 'de' y 'a las' h:mm a"),
      timeLeft: localEnd.diff(localNow, ["hours", "minutes"]).toObject()
    };

    return res.render("room", {
      roomId: payload.room_id,
      fromMot: true,
      userRole: userData.role,
      isAdmin: userData.role === "profesor",
      userName: userData.name || userData.email || "Usuario",
      listModulesCourse: modules || [],
      schedule,
      currentTime: localNow.toFormat("d 'de' LLLL 'de' y 'a las' h:mm a")
    });

  } catch (err) {
    console.error("Error en /join:", err);
    return res.render("inactive", {
      error: "Error interno del servidor. Por favor intente nuevamente."
    });
  }
});

module.exports = router;
