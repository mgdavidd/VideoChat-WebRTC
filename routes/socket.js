const { DateTime } = require("luxon");
const db = require("../db");

module.exports = function (io) {
  const rooms = {};

  io.on("connection", (socket) => {
    socket.on("join-room", ({ roomId, userName }) => {
      rooms[roomId] = rooms[roomId] || {};
      rooms[roomId][socket.id] = userName;
      socket.join(roomId);
      socket.roomId = roomId;

      const usersInRoom = Object.entries(rooms[roomId])
        .filter(([id]) => id !== socket.id)
        .map(([id, name]) => ({ userId: id, userName: name }));

      socket.emit("users-in-room", usersInRoom);
      socket.to(roomId).emit("new-user", { userId: socket.id, userName });
    });

    socket.on("update-media-status", (data) => {
      if (socket.roomId)
        socket.to(socket.roomId).emit("update-media-status", data);
    });

    const forwardEvent = (event) => (data) => {
      if (socket.roomId)
        socket.to(data.target).emit(event, { ...data, sender: socket.id });
    };

    socket.on("offer", forwardEvent("offer"));
    socket.on("answer", forwardEvent("answer"));
    socket.on("candidate", forwardEvent("candidate"));

    // Manejador de mensajes de chat (nuevo)
    socket.on("chat message", (data) => {
      // Verificar que el socket tiene una roomId asignada
      if (socket.roomId) {
        // Transmitir el mensaje a todos en la misma sala
        io.to(socket.roomId).emit("chat message", {
          msg: data.msg,
          user: data.user
        });
      }
    });

    socket.on("disconnect", () => {
      if (!socket.roomId || !rooms[socket.roomId]) return;

      delete rooms[socket.roomId][socket.id];
      socket.to(socket.roomId).emit("user-disconnected", socket.id);

      if (Object.keys(rooms[socket.roomId]).length === 0) {
        delete rooms[socket.roomId];
      }
    });

    // Revisión periódica de salas expiradas (originales)
    setInterval(async () => {
      try {
        const nowUTC = DateTime.utc().toISO();
        const result = await db.execute(
          `SELECT roomId FROM fechas GROUP BY roomId
           HAVING COUNT(CASE WHEN ? BETWEEN fecha_inicial_utc AND fecha_final_utc THEN 1 END) = 0`,
          [nowUTC]
        );

        for (const { roomId } of result.rows) {
          if (rooms[roomId]) {
            io.to(roomId).emit("force-close-room");
            for (const socketId in rooms[roomId]) {
              io.sockets.sockets.get(socketId)?.disconnect();
            }
            delete rooms[roomId];
          }
        }
      } catch (err) {
        console.error("Error al cerrar salas expiradas:", err);
      }
    }, 60000);

    // Nueva verificación para salas MOT (usando la tabla llamadas_mot)
    setInterval(async () => {
      try {
        const nowUTC = DateTime.utc().toISO();
        const expiredRooms = await db.execute(
          `SELECT room_id FROM llamadas_mot 
           WHERE end_time < ?`,
          [nowUTC]
        );

        for (const { room_id } of expiredRooms.rows) {
          if (rooms[room_id]) {
            io.to(room_id).emit("force-close-room");
            for (const socketId in rooms[room_id]) {
              io.sockets.sockets.get(socketId)?.disconnect();
            }
            delete rooms[room_id];
          }
        }
      } catch (err) {
        console.error("Error al cerrar salas MOT expiradas:", err);
      }
    }, 60000);
  });
};