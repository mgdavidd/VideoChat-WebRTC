const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const { DateTime } = require("luxon");
const axios = require("axios");

const JWT_SECRET = process.env.JWT_SECRET || "clave_super_segura";

router.post("/api/calls", async (req, res) => {
  const { course_id, session_date, start_utc, end_utc, room_id: existingRoomId } = req.body;

  if (!start_utc || !end_utc) {
    return res.status(400).json({ error: "Faltan campos requeridos" });
  }

  const startUTC = DateTime.fromISO(start_utc, { zone: "utc" });
  const endUTC = DateTime.fromISO(end_utc, { zone: "utc" });
  if (!startUTC.isValid || !endUTC.isValid || endUTC <= startUTC) {
    return res.status(400).json({ error: "Rango de horas inválido" });
  }

  try {
    let room_id = existingRoomId || uuidv4();
    let isNewRoom = true;

    if (!existingRoomId) {
      const existing = await db.execute(
        `SELECT room_id FROM llamadas_mot 
         WHERE course_id = ? AND DATE(start_time) = ?`,
        [course_id, session_date]
      );
      if (existing.rows.length > 0) {
        room_id = existing.rows[0].room_id;
        isNewRoom = false;
      }
    } else {
      const existing = await db.execute(
        `SELECT room_id FROM llamadas_mot WHERE room_id = ?`,
        [room_id]
      );
      isNewRoom = existing.rows.length === 0;
    }

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
        `UPDATE llamadas_mot SET start_time = ?, end_time = ?, link = ? WHERE room_id = ?`,
        [startUTC.toISO(), endUTC.toISO(), link, room_id]
      );
    }

    return res.json({
      room_id,
      link,
      is_new: isNewRoom,
      utc_timestamps: { start: startUTC.toISO(), end: endUTC.toISO() },
    });
  } catch (err) {
    console.error("Error crítico en /api/calls:", err);
    return res.status(500).json({ error: "Error al procesar la sala" });
  }
});

router.get("/join", async (req, res) => {
  const { token, user_token } = req.query;
  if (!token) {
    return res.render("inactive", { error: "Token de sala faltante" });
  }

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.render("inactive", { error: "Token de sala inválido" });
  }

  let userJwt =
    user_token ||
    req.cookies.mot_user_token ||
    req.cookies.token ||
    req.headers.authorization?.split(" ")[1];

  let userData = {};
  if (userJwt) {
    try {
      userData = jwt.verify(userJwt, JWT_SECRET);
    } catch (_) {}
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

    const nowUTC = DateTime.utc();
    const startUTC = DateTime.fromISO(room.start_time, { zone: "utc" });
    const endUTC = DateTime.fromISO(room.end_time, { zone: "utc" });

    if (nowUTC < startUTC) {
      return res.render("inactive", { error: "La sala aún no está disponible" });
    }
    if (nowUTC > endUTC) {
      return res.render("inactive", { error: "La sesión ha finalizado" });
    }

    // Validación de acceso al curso solo si hay usuario
    if (userData.id) {
      try {
        const { data } = await axios.get(
          `${process.env.MOT_API_URL}/api/validate-course-access/${userData.id}/${room.course_id}`,
          { headers: { Authorization: `Bearer ${process.env.INTERNAL_API_KEY}` }, timeout: 10000 }
        );
        if (!data.allowed) {
          return res.render("inactive", { error: "No autorizado para esta sala" });
        }
      } catch (_) {
        return res.render("inactive", { error: "Error verificando acceso al curso" });
      }
    }

    return res.render("room", {
      roomId: payload.room_id,
      fromMot: true,
      userRole: userData.rol,
      isAdmin: userData.rol === "profesor",
      userName: userData.nombre || userData.email || "Usuario",
      listModulesCourse: [],
      schedule: {},
      currentTime: DateTime.utc().toISO(),
    });
  } catch (err) {
    console.error("Error crítico en /join:", err);
    return res.render("inactive", { error: "Error interno del servidor" });
  }
});

module.exports = router;
