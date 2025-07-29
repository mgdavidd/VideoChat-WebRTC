const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const { DateTime } = require("luxon");

const JWT_SECRET = process.env.JWT_SECRET || "clave_super_segura";

router.post("/api/calls", async (req, res) => {
  try {
    const { course_id, session_date, start_time, end_time, title } = req.body;

    const startUTC = DateTime.fromISO(`${session_date}T${start_time}`, { zone: "utc" }).toISO();
    const endUTC = DateTime.fromISO(`${session_date}T${end_time}`, { zone: "utc" }).toISO();

    const existing = await db.execute(
      `SELECT * FROM llamadas_mot WHERE course_id = ? AND DATE(start_time) = ?`,
      [course_id, session_date]
    );

    if (existing.rows.length > 0) {
      const room_id = existing.rows[0].room_id;

      await db.execute(
        `UPDATE llamadas_mot SET start_time = ?, end_time = ?, title = ? WHERE room_id = ?`,
        [startUTC, endUTC, title || "Clase", room_id]
      );

      const token = jwt.sign({ room_id, course_id }, JWT_SECRET);
      const link = `/join?token=${token}`;

      return res.json({
        room_id,
        link,
        message: "Sala actualizada exitosamente",
      });
    }

    const room_id = uuidv4();
    const token = jwt.sign({ room_id, course_id }, JWT_SECRET);
    const link = `/join?token=${token}`;

    await db.execute(
      `INSERT INTO llamadas_mot (course_id, room_id, link, start_time, end_time)
       VALUES (?, ?, ?, ?, ?)`,
      [course_id, room_id, link, startUTC, endUTC]
    );

    res.json({
      room_id,
      link,
      message: "Sala creada exitosamente",
    });
  } catch (err) {
    console.error("Error en /api/calls:", err);
    res.status(500).json({ error: "Error al crear/actualizar la sala" });
  }
});


// Ingresar a sala con validación horaria con margen de ±2 minutos
router.get("/join", async (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.render("inactive", { error: "Token faltante" });
  }

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.render("inactive", { error: "Token inválido o expirado" });
  }

  const userJwt = req.cookies.token || req.headers.authorization?.split(" ")[1];
  let userPayload = null;
  let userRole = null;
  let userName = null;

  if (userJwt) {
    try {
      userPayload = jwt.verify(userJwt, JWT_SECRET);
      userRole = userPayload.role;
      userName = userPayload.nombre;
    } catch (err) {
      console.warn("Token de usuario inválido:", err.message);
    }
  }

  try {
    const result = await db.execute(
      `SELECT * FROM llamadas_mot WHERE room_id = ?`,
      [payload.room_id]
    );
    const row = result.rows[0];

    if (!row) {
      return res.render("inactive", { error: "Sala no encontrada" });
    }

    const now = DateTime.utc();
    const start = DateTime.fromISO(row.start_time, { zone: "utc" }).minus({ minutes: 2 });
    const end = DateTime.fromISO(row.end_time, { zone: "utc" }).plus({ minutes: 2 });


    if (now < start || now > end) {
      return res.render("inactive", { error: "Sala fuera de horario" });
    }

    // Obtener nombre si no viene en el token
    if (!userName && userPayload?.id) {
      const userResult = await db.execute(
        "SELECT nombre FROM usuarios WHERE id = ?",
        [userPayload.id]
      );
      if (userResult.rows.length > 0) {
        userName = userResult.rows[0].nombre;
      }
    }

    return res.render("room", {
      roomId: payload.room_id,
      fromMot: true,
      userRole,
      isAdmin: userRole === "profesor",
      userName: userName || userPayload?.email || "Usuario",
    });
  } catch (err) {
    console.error("Error en /join:", err.message);
    return res.render("inactive", { error: "Error en el servidor" });
  }
});

module.exports = router;
