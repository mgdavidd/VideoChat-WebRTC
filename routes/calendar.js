const express = require("express");
const router = express.Router();
const db = require("../db");
const { DateTime } = require("luxon");

router.get("/calendar-form/:roomId", async (req, res) => {
  const { roomId } = req.params;
  const userName = req.session.userName;

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
  const { fechas = [], selectedDates = [], roomId = "1" } = req.body;
  const userName = req.session.userName;

  if (!Array.isArray(fechas)) return res.status(400).json({ error: "Formato inválido" });

  // Solo admin de la sala puede editar.
  try {
    const owner = await db.execute(
      "SELECT 1 FROM rooms r JOIN users u ON r.admin = u.id WHERE u.nombre = ? AND r.id = ?",
      [userName, roomId]
    );
    if (!owner.rows.length) return res.status(403).json({ error: "No eres admin de esta sala" });
  } catch (err) {
    console.error("Error verificando dueño de sala:", err);
    return res.status(500).json({ error: "Error del servidor" });
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
        .toUTC()
        .toISO();
      const endUTC = DateTime.fromISO(`${date}T${end}`, { zone: timeZone })
        .toUTC()
        .toISO();

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

router.get("/fechas/:roomId", async (req, res) => {
  try {
    const limiteInferior = DateTime.utc().minus({ weeks: 2 }).toISO();

    const fechasResult = await db.execute(
      `SELECT id, fecha_inicial_utc, fecha_final_utc, tipo, fecha_local
       FROM fechas
       WHERE roomId = ? AND fecha_final_utc >= ?
       ORDER BY fecha_inicial_utc ASC`,
      [req.params.roomId, limiteInferior]
    );

    const grabacionesResult = await db.execute(
      `SELECT g.fecha_id, g.titulo, g.direccion, g.es_publico
       FROM grabaciones g
       JOIN fechas f ON g.fecha_id = f.id
       WHERE f.roomId = ? AND f.fecha_final_utc >= ?`,
      [req.params.roomId, limiteInferior]
    );

    // Agrupar grabaciones por fecha_id (una fecha puede tener varias)
    const porFecha = {};
    for (const g of grabacionesResult.rows) {
      (porFecha[g.fecha_id] ||= []).push({
        titulo: g.titulo,
        direccion: g.direccion,
        es_publico: g.es_publico,
      });
    }

    const fechas = fechasResult.rows.map((f) => ({
      ...f,
      grabaciones: porFecha[f.id] || [],
    }));

    res.json(fechas);
  } catch (err) {
    console.error("Error obteniendo fechas:", err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
