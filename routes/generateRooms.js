const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const { DateTime } = require("luxon");
const axios = require("axios");

const JWT_SECRET = process.env.JWT_SECRET || "clave_super_segura";
const CALLS_TABLE = process.env.CALLS_TABLE || "llamadas_mot";

const toUTC = (iso, tz = "America/Bogota") =>
  DateTime.fromISO(iso, { zone: tz }).toUTC();

const parseDate = (iso, tz = "America/Bogota") =>
  DateTime.fromISO(iso, { zone: tz }).toISODate();

const buildLink = (room_id, course_id) => {
  const token = jwt.sign({ room_id, course_id }, JWT_SECRET);
  return `/join?token=${token}`;
};

// ==========================
// 📌 POST /api/calls
// ==========================
router.post("/api/calls", async (req, res) => {
  const { course_id, sessions = [] } = req.body;
  if (!course_id || sessions.length === 0)
    return res.status(400).json({ error: "Faltan datos" });

  try {
    const dates = [...new Set(sessions.map((s) => parseDate(s.inicio, s.timezone)))];
    const placeholders = dates.map(() => "?").join(",");
    const { rows } = await db.execute(
      `SELECT room_id, DATE(start_time) as session_date 
       FROM ${CALLS_TABLE} 
       WHERE course_id = ? AND DATE(start_time) IN (${placeholders})`,
      [course_id, ...dates]
    );

    const existing = new Map(rows.map((r) => [r.session_date, r.room_id]));
    const results = [];

    for (const s of sessions) {
      const tz = s.timezone || "America/Bogota";
      const startUTC = toUTC(s.inicio, tz);
      const endUTC = toUTC(s.final, tz);
      const session_date = parseDate(s.inicio, tz);

      if (!startUTC.isValid || !endUTC.isValid || endUTC <= startUTC) {
        results.push({ ...s, status: "failed", reason: "Rango inválido" });
        continue;
      }

      const room_id = s.room_id || existing.get(session_date) || uuidv4();
      const link = buildLink(room_id, course_id);
      const isNew = !existing.has(session_date) && !s.room_id;

      if (isNew) {
        await db.execute(
          `INSERT INTO ${CALLS_TABLE} (course_id, room_id, link, start_time, end_time)
           VALUES (?, ?, ?, ?, ?)`,
          [course_id, room_id, link, startUTC.toISO(), endUTC.toISO()]
        );
        existing.set(session_date, room_id);
      } else {
        await db.execute(
          `UPDATE ${CALLS_TABLE}
           SET start_time = ?, end_time = ?, link = ?
           WHERE room_id = ?`,
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
        action: isNew ? "created" : "updated",
      });
    }

    res.json({ results });
  } catch (err) {
    console.error("Error crítico en /api/calls:", err);
    res.status(500).json({ error: "Error al procesar las salas" });
  }
});

// ==========================
// 📌 GET /join
// ==========================
router.get("/join", async (req, res) => {
  const { token, user_token } = req.query;
  if (!token) return res.render("inactive", { error: "Token de sala faltante" });

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.render("inactive", { error: "Token inválido o expirado" });
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
    } catch {}
  }

  try {
    const { rows } = await db.execute(
      `SELECT * FROM ${CALLS_TABLE} WHERE room_id = ?`,
      [payload.room_id]
    );
    const room = rows[0];
    if (!room) return res.render("inactive", { error: "Sala no encontrada" });

    const now = DateTime.utc();
    const start = DateTime.fromISO(room.start_time, { zone: "utc" });
    const end = DateTime.fromISO(room.end_time, { zone: "utc" });

    if (now < start) return res.render("inactive", { error: "Sala aún no disponible" });
    if (now > end) return res.render("inactive", { error: "Sesión finalizada" });

    // Validación de acceso (solo si hay usuario logueado)
    if (userData.id) {
      try {
        const { data } = await axios.get(
          `${process.env.MOT_API_URL}/api/validate-course-access/${userData.id}/${room.course_id}`,
          { headers: { Authorization: `Bearer ${process.env.INTERNAL_API_KEY}` }, timeout: 10000 }
        );
        if (!data.allowed)
          return res.render("inactive", { error: "No autorizado para esta sala" });
      } catch {
        return res.render("inactive", { error: "Error validando acceso" });
      }
    }

    // Módulos solo si es profesor
    let modules = [];
    if (userData.rol === "profesor") {
      try {
        const { data } = await axios.get(
          `${process.env.MOT_API_URL}/courses/${room.course_id}/modules/${userData.id}`,
          { headers: { Authorization: `Bearer ${process.env.INTERNAL_API_KEY}` }, timeout: 10000 }
        );
        modules = data || [];
      } catch (err) {
        console.error("Error obteniendo módulos:", err.message);
      }
    }

    const schedule = {
      start: start.setZone("America/Bogota").toFormat("h:mm a"),
      end: end.setZone("America/Bogota").toFormat("h:mm a"),
      date: start.setZone("America/Bogota").toFormat("d 'de' LLLL 'de' y"),
    };

    return res.render("room", {
      roomId: payload.room_id,
      fromMot: true,
      userRole: userData.rol,
      isAdmin: userData.rol === "profesor",
      userName: userData.nombre || userData.email || "Usuario",
      listModulesCourse: modules,
      schedule,
      currentTime: now.setZone("America/Bogota").toFormat("d 'de' LLLL 'de' y 'a las' h:mm a"),
    });
  } catch (err) {
    console.error("Error crítico en /join:", err);
    res.render("inactive", { error: "Error interno del servidor" });
  }
});

module.exports = router;
