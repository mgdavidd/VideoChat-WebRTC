const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const { DateTime } = require("luxon");
const axios = require("axios");

const JWT_SECRET = process.env.JWT_SECRET || "clave_super_segura";

// ================================
// 📌 Crear/actualizar múltiples salas
// ================================
router.post("/api/calls", async (req, res) => {
  const { course_id, sessions = [] } = req.body;

  if (!course_id || !Array.isArray(sessions) || sessions.length === 0) {
    return res.status(400).json({ error: "Faltan datos requeridos" });
  }

  try {
    const results = [];

    for (const s of sessions) {
      const { 
        inicio, 
        final, 
        titulo = "Clase", 
        type = "Clase en vivo", 
        timezone = "America/Bogota" 
      } = s;

      const startUTC = DateTime.fromISO(inicio, { zone: timezone }).toUTC();
      const endUTC = DateTime.fromISO(final, { zone: timezone }).toUTC();

      if (!startUTC.isValid || !endUTC.isValid || endUTC <= startUTC) {
        results.push({ ...s, status: "failed", reason: "Rango inválido" });
        continue;
      }

      const session_date = DateTime.fromISO(inicio, { zone: timezone }).toISODate();

      // Buscar si ya hay sala en ese día
      let room_id = s.room_id || uuidv4();
      let isNewRoom = true;

      const existing = await db.execute(
        `SELECT room_id FROM llamadas_mot 
         WHERE course_id = ? AND DATE(start_time) = ?`,
        [course_id, session_date]
      );

      if (existing.rows.length > 0) {
        room_id = existing.rows[0].room_id;
        isNewRoom = false;
      }

      // Token para acceso a la sala
      const token = jwt.sign({ room_id, course_id }, JWT_SECRET);
      const link = `/join?token=${token}`;

      if (isNewRoom) {
        await db.execute(
          `INSERT INTO llamadas_mot (course_id, room_id, link, start_time, end_time)
           VALUES (?, ?, ?, ?, ?)`,
          [course_id, room_id, link, startUTC.toISO(), endUTC.toISO()]
        );
      } else {
        await db.execute(
          `UPDATE llamadas_mot 
           SET start_time = ?, end_time = ?, link = ? 
           WHERE room_id = ?`,
          [startUTC.toISO(), endUTC.toISO(), link, room_id]
        );
      }

      results.push({
        inicio,
        final,
        titulo,
        type,
        timezone,
        room_id,
        link,
        status: "success",
        action: isNewRoom ? "created" : "updated",
      });
    }

    return res.json({ results });
  } catch (err) {
    console.error("Error crítico en /api/calls:", err);
    return res.status(500).json({ error: "Error al procesar las salas" });
  }
});

// ================================
// 📌 Acceso a la sala (/join)
// ================================
router.get("/join", async (req, res) => {
  const { token, user_token } = req.query;

  if (!token) {
    return res.render("inactive", { error: "Token de sala faltante" });
  }

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.render("inactive", { error: "Token de sala inválido o expirado" });
  }

  // Token del usuario (proxy MOT lo pasa en ?auth=...)
  const userJwt =
    user_token ||
    req.cookies.mot_user_token ||
    req.cookies.token ||
    req.headers.authorization?.split(" ")[1];

  let userData = {};
  if (userJwt) {
    try {
      userData = jwt.verify(userJwt, JWT_SECRET);
    } catch {
      userData = {};
    }
  }

  try {
    const roomResult = await db.execute(
      `SELECT * FROM llamadas_mot WHERE room_id = ?`,
      [payload.room_id]
    );
    const room = roomResult.rows[0];
    if (!room) {
      return res.render("inactive", { error: "Sala no encontrada" });
    }

    // Validar horario
    const nowUTC = DateTime.utc();
    const startUTC = DateTime.fromISO(room.start_time, { zone: "utc" });
    const endUTC = DateTime.fromISO(room.end_time, { zone: "utc" });

    if (nowUTC < startUTC) {
      return res.render("inactive", { error: "La sala aún no está disponible" });
    }
    if (nowUTC > endUTC) {
      return res.render("inactive", { error: "La sesión ha finalizado" });
    }

    // Validar acceso al curso vía MOT
    if (userData.id) {
      try {
        const apiUrl = `${process.env.MOT_API_URL}/api/validate-course-access/${userData.id}/${room.course_id}`;
        const { data } = await axios.get(apiUrl, {
          headers: { Authorization: `Bearer ${process.env.INTERNAL_API_KEY}` },
          timeout: 8000,
        });
        if (!data.allowed) {
          return res.render("inactive", { error: "No estás autorizado para esta sala" });
        }
      } catch {
        return res.render("inactive", { error: "Error verificando acceso al curso" });
      }
    }

    // Si es profesor, cargar módulos
    let modules = [];
    if (userData.rol === "profesor") {
      try {
        const response = await axios.get(
          `${process.env.MOT_API_URL}/courses/${room.course_id}/modules/${userData.id}`,
          {
            headers: { Authorization: `Bearer ${process.env.INTERNAL_API_KEY}` },
            timeout: 8000,
          }
        );
        modules = response.data || [];
      } catch (err) {
        console.error("Error obteniendo módulos:", err.message);
      }
    }

    // Horario en local (Bogotá)
    const localStart = startUTC.setZone("America/Bogota");
    const localEnd = endUTC.setZone("America/Bogota");
    const localNow = nowUTC.setZone("America/Bogota");

    const schedule = {
      start: localStart.toFormat("h:mm a"),
      end: localEnd.toFormat("h:mm a"),
      date: localStart.toFormat("d 'de' LLLL 'de' y"),
    };

    return res.render("room", {
      roomId: payload.room_id,
      fromMot: true,
      userRole: userData.rol,
      isAdmin: userData.rol === "profesor",
      userName: userData.nombre || userData.email || "Usuario",
      listModulesCourse: modules,
      schedule,
      currentTime: localNow.toFormat("d 'de' LLLL 'de' y 'a las' h:mm a"),
    });
  } catch (err) {
    console.error("Error crítico en /join:", err);
    return res.render("inactive", {
      error: "Error interno del servidor. Por favor intente nuevamente.",
    });
  }
});

module.exports = router;
