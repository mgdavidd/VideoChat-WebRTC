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
  console.log("📞 Creando/obteniendo sala:", req.body);
  
  const { 
    course_id, 
    session_date, 
    start_utc, 
    end_utc, 
    room_id: existingRoomId 
  } = req.body;

  if (!start_utc || !end_utc) {
    console.log("❌ Faltan campos requeridos");
    return res.status(400).json({ error: "Faltan campos requeridos" });
  }

  const startUTC = DateTime.fromISO(start_utc, { zone: "utc" });
  const endUTC = DateTime.fromISO(end_utc, { zone: "utc" });
  
  if (!startUTC.isValid || !endUTC.isValid) {
    console.log("❌ Fechas UTC inválidas:", { start_utc, end_utc });
    return res.status(400).json({ error: "Formato de fecha UTC inválido" });
  }

  if (endUTC <= startUTC) {
    console.log("❌ Hora final menor o igual a inicial");
    return res.status(400).json({ error: "La hora final debe ser mayor a la hora inicial" });
  }

  try {
    let room_id = existingRoomId || uuidv4();
    let link;

    console.log("🔍 Buscando sala existente para:", { course_id, session_date, room_id });

    if (!existingRoomId) {
      // buscar por fecha y curso
      const existing = await db.execute(
        `SELECT room_id, link FROM llamadas_mot 
         WHERE course_id = ? AND DATE(start_time) = ?`,
        [course_id, session_date]
      );
      
      console.log("🔍 Búsqueda por fecha encontró:", existing.rows.length, "resultados");
      
      if (existing.rows.length > 0) {
        room_id = existing.rows[0].room_id;
        link = existing.rows[0].link;

        console.log("🔄 Actualizando horarios existentes");
        // 🔄 actualizar a las nuevas horas
        const updateResult = await db.execute(
          `UPDATE llamadas_mot 
           SET start_time = ?, end_time = ? 
           WHERE room_id = ?`,
          [startUTC.toISO(), endUTC.toISO(), room_id]
        );
        
        console.log("✅ Actualización completada, filas afectadas:", updateResult.changes || 'N/A');

        return res.json({
          room_id,
          link,
          is_new: false,
          utc_timestamps: { start: startUTC.toISO(), end: endUTC.toISO() }
        });
      }
    } else {
      // verificar si existe por room_id
      const existing = await db.execute(
        `SELECT room_id, link FROM llamadas_mot WHERE room_id = ?`,
        [room_id]
      );
      
      console.log("🔍 Búsqueda por room_id encontró:", existing.rows.length, "resultados");
      
      if (existing.rows.length > 0) {
        link = existing.rows[0].link;

        console.log("🔄 Actualizando horarios por room_id");
        // 🔄 actualizar a las nuevas horas
        const updateResult = await db.execute(
          `UPDATE llamadas_mot 
           SET start_time = ?, end_time = ? 
           WHERE room_id = ?`,
          [startUTC.toISO(), endUTC.toISO(), room_id]
        );
        
        console.log("✅ Actualización completada, filas afectadas:", updateResult.changes || 'N/A');

        return res.json({
          room_id,
          link,
          is_new: false,
          utc_timestamps: { start: startUTC.toISO(), end: endUTC.toISO() }
        });
      }
    }

    // 🚀 crear nueva sala
    console.log("🚀 Creando nueva sala");
    const token = jwt.sign({ room_id, course_id }, JWT_SECRET);
    link = `/join?token=${token}`;

    const insertResult = await db.execute(
      `INSERT INTO llamadas_mot (course_id, room_id, link, start_time, end_time)
       VALUES (?, ?, ?, ?, ?)`,
      [course_id, room_id, link, startUTC.toISO(), endUTC.toISO()]
    );
    
    console.log("✅ Nueva sala creada, ID:", insertResult.lastInsertRowid || 'N/A');

    return res.json({
      room_id,
      link,
      is_new: true,
      utc_timestamps: { start: startUTC.toISO(), end: endUTC.toISO() }
    });

  } catch (err) {
    console.error("💥 Error crítico en /api/calls:", err);
    return res.status(500).json({ error: "Error al procesar la sala" });
  }
});


// ========================
// Ingreso a la sala
// ========================
router.get("/join", async (req, res) => {
  console.log("🚪 Intento de ingreso a sala con token:", req.query.token?.substring(0, 20) + "...");
  
  const { token } = req.query;
  if (!token) {
    console.log("❌ Token faltante");
    return res.render("inactive", { error: "Token faltante" });
  }

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
    console.log("✅ Token decodificado:", { room_id: payload.room_id, course_id: payload.course_id });
  } catch (err) {
    console.log("❌ Token inválido:", err.message);
    return res.render("inactive", { error: "Token inválido o expirado" });
  }

  // Obtener datos de usuario
  const userJwt = req.cookies.token || req.headers.authorization?.split(" ")[1];
  console.log("🔍 Buscando token de usuario en:", userJwt ? "encontrado" : "no encontrado");
  
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
      console.log("✅ Usuario autenticado:", { id: userData.id, role: userData.role, name: userData.name });
    } catch (err) {
      console.warn("⚠️ Token de usuario inválido:", err.message);
    }
  } else {
    console.log("⚠️ No se encontró token de usuario");
  }

  // TEMPORAL: Si no hay usuario autenticado, permitir acceso para debug
  if (!userData.id) {
    console.log("⚠️ MODO DEBUG: Permitiendo acceso sin autenticación");
    userData = { 
      role: "estudiante", 
      name: "Usuario Debug", 
      email: "debug@test.com", 
      id: 999 
    };
  }

  try {
    // Obtener datos de la sala
    console.log("🔍 Buscando sala con room_id:", payload.room_id);
    const roomResult = await db.execute(
      `SELECT * FROM llamadas_mot WHERE room_id = ?`,
      [payload.room_id]
    );
    const room = roomResult.rows[0];

    if (!room) {
      console.log("❌ Sala no encontrada en DB");
      return res.render("inactive", { error: "Sala no encontrada" });
    }
    
    console.log("✅ Sala encontrada:", { 
      course_id: room.course_id, 
      start_time: room.start_time, 
      end_time: room.end_time 
    });

    const nowUTC = DateTime.utc();
    const startUTC = DateTime.fromISO(room.start_time, { zone: "utc" });
    const endUTC = DateTime.fromISO(room.end_time, { zone: "utc" });

    console.log("⏰ Verificación de horarios:", {
      now: nowUTC.toISO(),
      start: startUTC.toISO(),
      end: endUTC.toISO(),
      canJoin: nowUTC >= startUTC && nowUTC <= endUTC
    });

    if (nowUTC < startUTC) {
      const remaining = startUTC.diff(nowUTC, ["hours", "minutes"]).toObject();
      console.log("❌ Muy temprano para acceder");
      return res.render("inactive", {
        error: `La sala estará disponible en ${Math.floor(remaining.hours)}h ${Math.floor(remaining.minutes)}m`
      });
    }

    if (nowUTC > endUTC) {
      console.log("❌ Sesión finalizada");
      return res.render("inactive", { error: "La sesión ha finalizado" });
    }

    // Validar acceso al curso usando la API interna
    const MOT_API_URL = process.env.MOT_API_URL;
    console.log("🔗 Validando acceso con MOT API:", MOT_API_URL);
    
    if (MOT_API_URL && userData.id && room.course_id) {
      try {
        const validationUrl = `${MOT_API_URL}/api/validate-course-access/${userData.id}/${room.course_id}`;
        console.log("📡 Llamando a:", validationUrl);
        
        const { data } = await axios.get(validationUrl, { 
          headers: { 
            Authorization: `Bearer ${process.env.INTERNAL_API_KEY}` 
          }, 
          timeout: 5000 
        });

        console.log("✅ Respuesta de validación:", data);

        if (!data.allowed) {
          console.log("❌ Acceso denegado por MOT API");
          return res.render("inactive", { error: "No estás autorizado para ingresar" });
        }
      } catch (err) {
        console.error("💥 Error al validar permisos:", err.message);
        // TEMPORAL: En producción, considera si permitir o denegar acceso
        console.log("⚠️ Permitiendo acceso debido a error en validación");
      }
    } else {
      console.log("⚠️ Saltando validación - configuración incompleta:", {
        hasAPI: !!MOT_API_URL,
        hasUserId: !!userData.id,
        hasCourseId: !!room.course_id
      });
    }

    let modules = [];
    if (userData.role === "profesor" && MOT_API_URL) {
      try {
        const modulesUrl = `${MOT_API_URL}/courses/${room.course_id}/modules/${userData.id}`;
        console.log("📚 Obteniendo módulos de:", modulesUrl);
        
        const response = await axios.get(modulesUrl, { 
          headers: { 
            Authorization: `Bearer ${process.env.INTERNAL_API_KEY}` 
          }, 
          timeout: 5000 
        });
        modules = response.data || [];
        console.log("✅ Módulos obtenidos:", modules.length);
      } catch (err) {
        console.error("💥 Error obteniendo módulos:", err.message);
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

    console.log("🎉 Acceso permitido, renderizando sala");

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
    console.error("💥 Error en /join:", err);
    return res.render("inactive", {
      error: "Error interno del servidor. Por favor intente nuevamente."
    });
  }
});

module.exports = router;