const express = require("express");
const router = express.Router();
const db = require("../db");
const { DateTime } = require("luxon");
const axios = require("axios");
const jwt = require("jsonwebtoken");

const VIDEOCHAT_URL = process.env.VIDEOCHAT_URL;
const JWT_SECRET = process.env.JWT_SECRET || "clave_super_segura";

router.get("/calendar-form/:roomId", async (req, res) => {
  const { roomId } = req.params;
  const { userName } = req.cookies;

  const result = await db.execute("SELECT 1 FROM rooms WHERE id = ?", [roomId]);
  const owner = await db.execute(
    "SELECT 1 FROM rooms r JOIN users u ON r.admin = u.id WHERE u.nombre = ? AND r.id = ?",
    [userName, roomId]
  );

  const isOwner = owner.rows.length > 0;
  if (result.rows.length > 0) {
    return res.render("calendar", { roomId, isOwner });
  } else {
    return res.status(404).render("error-calendar", { message: "La sala no existe" });
  }
});

router.post("/fechas", async (req, res) => {
  const { fechas = [], selectedDates = [], roomId = "1", selectedCourseId } = req.body;

  if (!Array.isArray(fechas)) {
    return res.status(400).json({ error: "Formato inválido" });
  }

  try {
    if (selectedDates.length > 0) {
      await db.execute(
        `DELETE FROM fechas 
         WHERE roomId = ? AND fecha_local NOT IN (${selectedDates
          .map(() => "?")
          .join(",")})`,
        [roomId, ...selectedDates]
      );
    }

    for (const f of fechas) {
      const { date, start, end, type, timeZone } = f;

      if (!date || !start || !end || !timeZone) {
        return res.status(400).json({ error: "Datos incompletos" });
      }

      const startUTC = DateTime.fromISO(`${date}T${start}`, { zone: timeZone })
        .toUTC();
      const endUTC = DateTime.fromISO(`${date}T${end}`, { zone: timeZone })
        .toUTC();

      const fechaLocal = startUTC.setZone(timeZone).toISODate();

      // Verificar si ya existe la sala en la DB
      const existingRoom = await db.execute(
        `SELECT id as room_id, link_mot FROM rooms WHERE id = ?`,
        [roomId]
      );

      if (existingRoom.rows.length > 0 && existingRoom.rows[0].room_id) {
        let room_id = existingRoom.rows[0].room_id;
        let link_mot = existingRoom.rows[0].link_mot;
        console.log("✅ Sala existente encontrada:", { room_id, link_mot });

        // 🔄 IMPORTANTE: Actualizar horarios en VideoChat aunque ya exista
        console.log("🔄 Actualizando horarios en VideoChat para sala existente");
        console.log("🌐 VIDEOCHAT_URL configurada:", VIDEOCHAT_URL);

        if (VIDEOCHAT_URL) {
          try {
            const updatePayload = {
              course_id: selectedCourseId,
              start_utc: startUTC.toISO(),
              end_utc: endUTC.toISO(),
              session_date: fechaLocal,
              room_id: room_id // ← IMPORTANTE: Pasar el room_id existente
            };

            console.log("📡 Payload actualización para VideoChat:", updatePayload);

            const authToken = jwt.sign(updatePayload, JWT_SECRET);

            const { data } = await axios.post(
              `${VIDEOCHAT_URL}/api/calls`,
              updatePayload,
              { 
                headers: { 
                  Authorization: `Bearer ${authToken}`,
                  'Content-Type': 'application/json'
                },
                timeout: 10000
              }
            );

            console.log("✅ VideoChat actualizado exitosamente:", data);

            // Verificar que el link no haya cambiado
            if (data.link && data.link !== link_mot) {
              console.log("🔄 Link actualizado:", { old: link_mot, new: data.link });
              link_mot = data.link;
            }

          } catch (err) {
            console.error("💥 Error actualizando en VideoChat:", {
              message: err.message,
              status: err.response?.status,
              data: err.response?.data
            });
            // Continúa con el proceso aunque falle la actualización
          }
        } else {
          console.log("⚠️ VIDEOCHAT_URL no configurada, saltando actualización");
        }
      }

      // Guardar/actualizar fecha en DB
      await db.execute(
        `INSERT INTO fechas (
          fecha_inicial_utc, fecha_final_utc, tipo, roomId, fecha_local
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(roomId, fecha_local) DO UPDATE SET
          fecha_inicial_utc = excluded.fecha_inicial_utc,
          fecha_final_utc = excluded.fecha_final_utc,
          tipo = excluded.tipo`,
        [startUTC.toISO(), endUTC.toISO(), type, roomId, fechaLocal]
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error("Error guardando fechas:", err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

router.get("/fechas/:roomId", async (req, res) => {
  try {
    const limiteInferior = DateTime.utc().minus({ weeks: 2 }).toISO();
    const result = await db.execute(
      `SELECT f.fecha_inicial_utc, f.fecha_final_utc, f.tipo, f.fecha_local, 
              g.direccion AS grabacion_url, g.titulo AS grabacion_titulo, g.es_publico
       FROM fechas f
       LEFT JOIN grabaciones g ON g.fecha_id = f.id
       WHERE f.roomId = ? AND f.fecha_final_utc >= ?
       ORDER BY f.fecha_inicial_utc ASC`,
      [req.params.roomId, limiteInferior]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error obteniendo fechas:", err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
