const express = require("express");
const router = express.Router();
const fs = require("fs");
const db = require("../db");
const { upload } = require("../uploadConfig");
const { DateTime } = require("luxon");
const { getAdminDriveClient } = require("../driveUtils");
const { google } = require("googleapis");

router.get("/my-recordings", async (req, res) => {
  const { userName } = req.cookies;
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

    const { roomId, adminUserName, fromMot, selectedModuleId } = req.body;
    if (!roomId || !adminUserName) throw new Error("Datos incompletos");

    if (fromMot === "true") {
      const FormData = require("form-data");

      await new Promise((resolve, reject) => {
        const form = new FormData();
        form.append("recording", fs.createReadStream(req.file.path));
        form.append("roomId", roomId);
        form.append("adminUserName", adminUserName);

        if (selectedModuleId) {
          form.append("selectedModuleId", selectedModuleId);
        }

        form.submit(`${process.env.MOT_API_URL}/api/upload-recording`, (err, motRes) => {
          if (err) return reject(err);

          let body = "";
          motRes.on("data", chunk => body += chunk);
          motRes.on("end", () => {
            try {
              const motJson = JSON.parse(body);
              console.log("Respuesta de MOT:", motJson);
              resolve();
              return
            } catch (e) {
              reject(new Error("Respuesta de MOT inválida"));
            }
          });
        });
      });
      return res.json({ success: true, message: "Grabación enviada a MOT" });
    }

    const { auth, folderId } = await getAdminDriveClient(adminUserName);
    const drive = google.drive({ version: "v3", auth });

    const { data } = await drive.files.create({
      requestBody: {
        name: `Grabacion-${roomId}-${Date.now()}.webm`,
        mimeType: "video/webm",
        parents: [folderId],
      },
      media: {
        mimeType: "video/webm",
        body: fs.createReadStream(req.file.path),
      },
      fields: "id,webViewLink",
    });

    const { userTimeZone } = req.body;
    const nowUTC = DateTime.utc();

    const fechaLocal = userTimeZone
      ? nowUTC.setZone(userTimeZone).toISODate()
      : nowUTC.toISODate();

    const fechaResult = await db.execute(
      "SELECT id FROM fechas WHERE roomId = ? AND fecha_local = ?",
      [roomId, fechaLocal]
    );
    const fechaId = fechaResult.rows[0]?.id || null;

    await db.execute(
      "INSERT INTO grabaciones (fecha_id, titulo, direccion, es_publico) VALUES (?, ?, ?, ?)",
      [
        fechaId,
        `Grabacion-${roomId}-${nowUTC.toFormat("yyyyLLdd-HHmmss")}`,
        data.webViewLink,
        0,
      ]
    );

    fs.unlink(req.file.path, () => { });
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
  try {
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
