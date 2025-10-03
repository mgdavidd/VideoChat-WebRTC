const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const { DateTime } = require("luxon");
const axios = require("axios");

const JWT_SECRET = process.env.JWT_SECRET || "clave_super_segura";

/**
 * POST /api/calls
 * - Ahora optimizado para recibir múltiples sesiones en un solo request.
 * - Hacemos una sola consulta a DB para saber si ya existen salas en las fechas solicitadas.
 */
router.post("/api/calls", async (req, res) => {
  const { course_id, sessions = [] } = req.body;

  if (!course_id || !Array.isArray(sessions) || sessions.length === 0) {
    return res.status(400).json({ error: "Faltan datos requeridos" });
  }

  try {
    const results = [];

    // Calcula las fechas únicas (local) que se van a procesar
    const sessionDates = [];
    for (const s of sessions) {
      const tz = s.timezone || "America/Bogota";
      const localDate = DateTime.fromISO(s.inicio, { zone: tz }).toISODate();
      sessionDates.push(localDate);
    }
    const distinctDates = [...new Set(sessionDates)];

    // Consulta única: obtener llamadas_mot existentes para esas fechas y course_id
    const placeholders = distinctDates.map(() => "?").join(",");
    const existingRows = await db.execute(
      `SELECT room_id, DATE(start_time) as session_date FROM llamadas_mot WHERE course_id = ? AND DATE(start_time) IN (${placeholders})`,
      [course_id, ...distinctDates]
    );

    const existingMap = new Map();
    for (const row of existingRows.rows) {
      existingMap.set(row.session_date, row.room_id);
    }

    // Procesamiento en lote: cada session se crea/actualiza según exista room o no.
    for (const s of sessions) {
      const tz = s.timezone || "America/Bogota";
      const startUTC = DateTime.fromISO(s.inicio, { zone: tz }).toUTC();
      const endUTC = DateTime.fromISO(s.final, { zone: tz }).toUTC();
      if (!startUTC.isValid || !endUTC.isValid || endUTC <= startUTC) {
        results.push({ ...s, status: "failed", reason: "Rango inválido" });
        continue;
      }

      const session_date = DateTime.fromISO(s.inicio, { zone: tz }).toISODate();

      // Reusar si ya existe
      let room_id = s.room_id || existingMap.get(session_date) || uuidv4();
      let isNewRoom = !existingMap.has(session_date) && !s.room_id;

      const token = jwt.sign({ room_id, course_id }, JWT_SECRET);
      const link = `/join?token=${token}`;

      if (isNewRoom) {
        await db.execute(
          `INSERT INTO llamadas_mot (course_id, room_id, link, start_time, end_time)
           VALUES (?, ?, ?, ?, ?)`,
          [course_id, room_id, link, startUTC.toISO(), endUTC.toISO()]
        );
        // registrar para evitar duplicados si hay varias sessions con la misma fecha en este batch
        existingMap.set(session_date, room_id);
      } else {
        // Si ya existe, actualizamos (puede ser que cambien horas)
        await db.execute(
          `UPDATE llamadas_mot SET start_time = ?, end_time = ?, link = ? WHERE room_id = ?`,
          [startUTC.toISO(), endUTC.toISO(), link, room_id]
        );
      }

      results.push({
        inicio: s.inicio,
        final: s.final,
        titulo: s.titulo || "Clase",
        type: s.type || "Clase en vivo",
        timezone: tz,
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

// /join (igual funcionalmente; mantengo la lógica)
router.get("/join", async (req, res) => {
  const { token, user_token } = req.query;

  if (!token) {
    return res.render("inactive", { error: "Token de sala faltante" });
  }

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return res.render("inactive", { error: "Token de sala inválido o expirado" });
  }

  const userJwt =
    user_token ||
    req.cookies.mot_user_token ||
    req.cookies.token ||
    req.headers.authorization?.split(" ")[1];

  let userData = {};
  if (userJwt) {
    try {
      userData = jwt.verify(userJwt, JWT_SECRET);
    } catch (_) {
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

    const nowUTC = DateTime.utc();
    const startUTC = DateTime.fromISO(room.start_time, { zone: "utc" });
    const endUTC = DateTime.fromISO(room.end_time, { zone: "utc" });

    if (nowUTC < startUTC) {
      return res.render("inactive", { error: "La sala aún no está disponible" });
    }
    if (nowUTC > endUTC) {
      return res.render("inactive", { error: "La sesión ha finalizado" });
    }

    if (userData.id) {
      try {
        const apiUrl = `${process.env.MOT_API_URL}/api/validate-course-access/${userData.id}/${room.course_id}`;
        const { data } = await axios.get(apiUrl, {
          headers: { Authorization: `Bearer ${process.env.INTERNAL_API_KEY}` },
          timeout: 10000,
        });
        if (!data.allowed) {
          return res.render("inactive", { error: "No estás autorizado para esta sala" });
        }
      } catch {
        return res.render("inactive", { error: "Error verificando acceso al curso" });
      }
    }

    let modules = [];
    if (userData.rol === "profesor") {
      try {
        const response = await axios.get(
          `${process.env.MOT_API_URL}/courses/${room.course_id}/modules/${userData.id}`,
          {
            headers: { Authorization: `Bearer ${process.env.INTERNAL_API_KEY}` },
            timeout: 10000,
          }
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
