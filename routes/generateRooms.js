const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const { DateTime } = require("luxon");
const axios = require("axios");

const JWT_SECRET = process.env.JWT_SECRET || "clave_super_segura";

router.post("/api/calls", async (req, res) => {
  const { 
    course_id, 
    session_date, 
    start_utc, 
    end_utc, 
    room_id: existingRoomId 
  } = req.body;

  if (!start_utc || !end_utc) {
    return res.status(400).json({ error: "Faltan campos requeridos" });
  }

  // Validar formatos UTC
  const startUTC = DateTime.fromISO(start_utc, { zone: "utc" });
  const endUTC = DateTime.fromISO(end_utc, { zone: "utc" });
  
  if (!startUTC.isValid || !endUTC.isValid) {
    return res.status(400).json({ error: "Formato de fecha UTC inválido" });
  }

  if (endUTC <= startUTC) {
    return res.status(400).json({ error: "La hora final debe ser mayor a la hora inicial" });
  }

  try {
    let room_id = existingRoomId || uuidv4();
    let isNewRoom = true;

    // Buscar sala existente si no se proporcionó un ID
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
      // Verificar si la sala ya existe
      const existing = await db.execute(
        `SELECT room_id FROM llamadas_mot WHERE room_id = ?`,
        [room_id]
      );
      isNewRoom = existing.rows.length === 0;
    }

    const token = jwt.sign({ room_id, course_id }, JWT_SECRET);
    const link = `/join?token=${token}`;

    // Insertar o actualizar la sala
    if (isNewRoom) {
      await db.execute(
        `INSERT INTO llamadas_mot (course_id, room_id, link, start_time, end_time)
         VALUES (?, ?, ?, ?, ?)`,
        [course_id, room_id, link, startUTC.toISO(), endUTC.toISO()]
      );
    } else {
      await db.execute(
        `UPDATE llamadas_mot SET 
          start_time = ?, 
          end_time = ?,
          link = ?
         WHERE room_id = ?`,
        [startUTC.toISO(), endUTC.toISO(), link, room_id]
      );
    }

    return res.json({
      room_id,
      link,
      is_new: isNewRoom,
      utc_timestamps: { 
        start: startUTC.toISO(), 
        end: endUTC.toISO() 
      }
    });

  } catch (err) {
    console.error("Error crítico en /api/calls:", err);
    return res.status(500).json({ error: "Error al procesar la sala" });
  }
});

router.get("/join", async (req, res) => {
  const { token, user_token } = req.query;
  
  console.log("🚀 [JOIN] Iniciando proceso de join");
  console.log("📋 [JOIN] Token de sala recibido:", token ? `${token.substring(0, 20)}...` : "NO TOKEN");
  console.log("📋 [JOIN] Token de usuario recibido:", user_token ? `${user_token.substring(0, 20)}...` : "NO TOKEN");
  console.log("📋 [JOIN] Query parameters completos:", req.query);
  
  if (!token) {
    console.log("❌ [JOIN] Error: Token de sala faltante");
    return res.render("inactive", { error: "Token de sala faltante" });
  }

  // Verificación del token de sala
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
    console.log("✅ [JOIN] Token de sala válido");
    console.log("📋 [JOIN] Payload del token:", { room_id: payload.room_id, course_id: payload.course_id });
  } catch (err) {
    console.log("❌ [JOIN] Token de sala inválido:", err.message);
    return res.render("inactive", { error: "Token de sala inválido o expirado" });
  }

  // Obtener información del usuario - ENFOQUE MEJORADO
  console.log("🔍 [JOIN] Buscando token de usuario...");
  
  // Prioridad: 1. Query parameter (user_token), 2. Cookies, 3. Headers
  const userJwt = 
    user_token || // Primero el parámetro de query (más confiable para redirects)
    req.cookies.mot_user_token || 
    req.cookies.token ||
    req.headers.authorization?.split(" ")[1];

  console.log("📋 [JOIN] Token de usuario final obtenido:", userJwt ? `${userJwt.substring(0, 20)}...` : "NO TOKEN");
  console.log("📋 [JOIN] Cookies recibidas:", req.cookies);
  console.log("📋 [JOIN] Headers authorization:", req.headers.authorization ? "EXISTE" : "NO EXISTE");

  let userData = {
    payload: null,
    role: null,
    name: null,
    email: null,
    id: null
  };

  if (userJwt) {
    try {
      userData.payload = jwt.verify(userJwt, JWT_SECRET);
      userData.role = userData.payload.rol;
      userData.name = userData.payload.nombre;
      userData.email = userData.payload.email;
      userData.id = userData.payload.id;
      console.log("✅ [JOIN] Token de usuario válido");
      console.log("📋 [JOIN] Datos del usuario:", {
        id: userData.id,
        role: userData.role,
        name: userData.name,
        email: userData.email
      });
    } catch (err) {
      console.log("❌ [JOIN] Token de usuario inválido:", err.message);
      // No retornamos error aquí, continuamos sin usuario autenticado
    }
  } else {
    console.log("⚠️ [JOIN] No se encontró token de usuario");
  }

  try {
    // Obtener datos de la sala
    console.log("🔍 [JOIN] Buscando sala en DB...");
    const roomResult = await db.execute(
      `SELECT * FROM llamadas_mot WHERE room_id = ?`,
      [payload.room_id]
    );
    const room = roomResult.rows[0];

    console.log("📋 [JOIN] Resultado de búsqueda de sala:", room ? "ENCONTRADA" : "NO ENCONTRADA");
    if (room) {
      console.log("📋 [JOIN] Datos de la sala:", {
        room_id: room.room_id,
        course_id: room.course_id,
        start_time: room.start_time,
        end_time: room.end_time
      });
    }

    if (!room) {
      console.log("❌ [JOIN] Error: Sala no encontrada en DB");
      return res.render("inactive", { error: "Sala no encontrada" });
    }

    // Manejo de horarios
    const nowUTC = DateTime.utc();
    const startUTC = DateTime.fromISO(room.start_time, { zone: "utc" });
    const endUTC = DateTime.fromISO(room.end_time, { zone: "utc" });

    console.log("🕐 [JOIN] Validación de horarios:");
    console.log("📋 [JOIN] Hora actual UTC:", nowUTC.toISO());
    console.log("📋 [JOIN] Inicio sala UTC:", startUTC.toISO());
    console.log("📋 [JOIN] Final sala UTC:", endUTC.toISO());

    // Validación de horario
    if (nowUTC < startUTC) {
      const remaining = startUTC.diff(nowUTC, ["hours", "minutes"]).toObject();
      console.log("❌ [JOIN] Error: Sala no disponible aún");
      console.log("📋 [JOIN] Tiempo restante:", remaining);
      return res.render("inactive", {
        error: `La sala estará disponible en ${Math.floor(remaining.hours)}h ${Math.floor(remaining.minutes)}m`
      });
    }

    if (nowUTC > endUTC) {
      console.log("❌ [JOIN] Error: Sesión finalizada");
      return res.render("inactive", { error: "La sesión ha finalizado" });
    }

    console.log("✅ [JOIN] Horario válido, procediendo con validación de acceso...");

    // Validar acceso al curso usando la API interna - SOLO SI HAY USUARIO AUTENTICADO
    if (userData.id) {
      const MOT_API = process.env.MOT_API_URL;
      console.log("🔍 [JOIN] Validando acceso al curso...");
      console.log("📋 [JOIN] MOT_API_URL:", MOT_API);
      console.log("📋 [JOIN] User ID:", userData.id);
      console.log("📋 [JOIN] Course ID:", room.course_id);
      
      try {
        const apiUrl = `${MOT_API}/api/validate-course-access/${userData.id}/${room.course_id}`;
        console.log("📋 [JOIN] URL de validación:", apiUrl);
        
        const { data } = await axios.get(apiUrl, {
          headers: { 
            Authorization: `Bearer ${process.env.INTERNAL_API_KEY}`,
            'User-Agent': 'VideoChat-Server/1.0'
          },
          timeout: 10000 // Aumentar timeout
        });

        console.log("📋 [JOIN] Respuesta de validación:", data);
        
        if (!data.allowed) {
          console.log("❌ [JOIN] Error: Acceso no autorizado por API");
          return res.render("inactive", { error: "No estás autorizado para ingresar a esta sala" });
        }
        
        console.log("✅ [JOIN] Acceso autorizado por API");
      } catch (err) {
        console.error("❌ [JOIN] Error al validar permisos:", err.message);
        console.log("📋 [JOIN] Detalles del error:", {
          status: err.response?.status,
          statusText: err.response?.statusText,
          data: err.response?.data
        });
        
        // Si falla la validación pero tenemos usuario, mostramos error
        if (userData.id) {
          return res.render("inactive", { 
            error: "Error al verificar tu acceso al curso. Por favor, intenta nuevamente." 
          });
        }
        // Si no hay usuario, continuamos sin validación
      }
    } else {
      console.log("⚠️ [JOIN] Usuario no autenticado, omitiendo validación de acceso");
      // Podrías decidir si permitir acceso sin autenticación o no
      // return res.render("inactive", { error: "Debes iniciar sesión para acceder" });
    }

    // Obtener módulos para profesores
    let modules = [];
    if (userData.role === "profesor") {
      console.log("🔍 [JOIN] Obteniendo módulos para profesor...");
      try {
        const response = await axios.get(
          `${process.env.MOT_API_URL}/courses/${room.course_id}/modules/${userData.id}`,
          { 
            headers: { 
              Authorization: `Bearer ${process.env.INTERNAL_API_KEY}`,
              'User-Agent': 'VideoChat-Server/1.0'
            },
            timeout: 10000 
          }
        );
        modules = response.data || [];
        console.log("✅ [JOIN] Módulos obtenidos:", modules.length);
      } catch (err) {
        console.error("⚠️ [JOIN] Error obteniendo módulos (continuando sin módulos):", err.message);
      }
    }

    // Convertir a hora local para Colombia
    const localStart = startUTC.setZone("America/Bogota");
    const localEnd = endUTC.setZone("America/Bogota");
    const localNow = nowUTC.setZone("America/Bogota");

    // Preparar objeto de horarios
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

    console.log("✅ [JOIN] Preparando render de sala...");
    console.log("📋 [JOIN] Datos para render:", {
      roomId: payload.room_id,
      userRole: userData.role,
      isAdmin: userData.role === "profesor",
      userName: userData.name || userData.email || "Usuario",
      modulesCount: modules.length,
      schedule: schedule.start + " - " + schedule.end
    });

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
    console.error("❌ [JOIN] Error crítico:", err);
    console.log("📋 [JOIN] Stack trace:", err.stack);
    return res.render("inactive", {
      error: "Error interno del servidor. Por favor intente nuevamente."
    });
  }
});

module.exports = router;