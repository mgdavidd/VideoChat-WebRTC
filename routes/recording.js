const express = require("express");
const router = express.Router();
const fs = require("fs");
const db = require("../db");
const { upload, uploadDir } = require("../uploadConfig");
const { DateTime } = require("luxon");
const { uploadRecording } = require("../driveUtils");

router.get("/my-recordings", async (req, res) => {
  const userName = req.session.userName;
  try {
    const result = await db.execute(
      `SELECT g.id, g.fecha_id, g.titulo, g.direccion, g.es_publico, 
              f.fecha_local, f.roomId, f.tipo
       FROM grabaciones g
       JOIN fechas f ON g.fecha_id = f.id 
       JOIN rooms r ON f.roomId = r.id
       JOIN users u ON r.admin = u.id
       WHERE u.nombre = ?
       ORDER BY f.fecha_inicial_utc DESC`,
      [userName]
    );
    res.render("my-recordings", { recordings: result.rows, userName });
  } catch (err) {
    console.error("Error obteniendo grabaciones:", err);
    res.render("my-recordings", {
      recordings: [],
      userName,
      error: "No se pudieron obtener las grabaciones",
    });
  }
});

router.post("/api/upload-recording", upload.single("recording"), async (req, res) => {
  try {
    if (!req.file) throw new Error("Archivo no recibido");

    const { roomId, adminUserName } = req.body;
    if (!roomId || !adminUserName) throw new Error("Datos incompletos");

    const { data } = await uploadRecording(adminUserName, roomId, req.file.path);

    const now = DateTime.utc();


    const fechaResult = await db.execute(
      "SELECT id FROM fechas WHERE roomId = ? AND ? BETWEEN fecha_inicial_utc AND fecha_final_utc",
      [roomId, now.toISO()]
    );
    const fechaId = fechaResult.rows[0]?.id;

    if (!fechaId) {
      throw new Error("No hay una fecha programada activa para esta sala ahora mismo");
    }

    await db.execute(
      "INSERT INTO grabaciones (fecha_id, titulo, direccion, es_publico) VALUES (?, ?, ?, ?)",
      [
        fechaId,
        `Grabacion-${roomId}-${now.toFormat("yyyyLLdd-HHmmss")}`,
        data.webViewLink,
        0,
      ]
    );

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
      details: error.message,
    });
  }
});

router.post("/update-recording/:recordingId", async (req, res) => {
  const { recordingId } = req.params;
  const { title, es_publico } = req.body;
  const userName = req.session.userName;

  try {
    // Solo el admin de la sala que contiene la grabación puede editarla.
    const owns = await db.execute(
      `SELECT 1 FROM grabaciones g
       JOIN fechas f ON g.fecha_id = f.id
       JOIN rooms r ON f.roomId = r.id
       JOIN users u ON r.admin = u.id
       WHERE g.id = ? AND u.nombre = ?`,
      [recordingId, userName]
    );
    if (!owns.rows.length) return res.status(403).json({ error: "No puedes editar esta grabación" });

    await db.execute(
      "UPDATE grabaciones SET titulo = ?, es_publico = ? WHERE id = ?",
      [title, es_publico ? 1 : 0, recordingId]
    );
    res.redirect("/my-recordings");
  } catch (error) {
    console.error("Error actualizando grabación:", error);
    res.status(500).json({
      success: false,
      error: "Error al actualizar grabación",
    });
  }
});

module.exports = router;
