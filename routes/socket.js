const { DateTime } = require("luxon");
const db = require("./db");

module.exports = function (io, verifyScheduledCall) {
  const rooms = {};

  io.use(async (socket, next) => {
    try {
      const { token, auth: jwt } = socket.handshake.query;

      if (token && jwt) {
        await verifyScheduledCall(token, jwt);
        socket.roomToken = token;
      }

      return next();
    } catch (err) {
      console.error("Socket auth error:", err.message);
      return next(new Error("No autorizado para esta sala"));
    }
  });

  io.on("connection", (socket) => {
    console.log(`Nuevo cliente conectado: ${socket.id}`);

    socket.on("join-room", ({ roomId, userName }) => {
      const id = socket.id;
      rooms[roomId] = rooms[roomId] || {};
      rooms[roomId][id] = userName;
      rooms[roomId]._lastActivity = new Date();
      socket.join(roomId);
      socket.roomId = roomId;

      const users = Object.entries(rooms[roomId])
        .filter(([id]) => id !== socket.id && id !== "_lastActivity")
        .map(([id, name]) => ({ userId: id, userName: name }));

      socket.emit("users-in-room", users);

      socket.to(roomId).emit("new-user", {
        userId: id,
        userName,
        roomId,
      });

      console.log(`${userName} (${id}) se unió a la sala ${roomId}`);
    });

    const forward = (evt) => (data) => {
      if (socket.roomId) {
        rooms[socket.roomId]._lastActivity = new Date();
        socket.to(data.target).emit(evt, { ...data, sender: socket.id });
      }
    };

    socket.on("offer", forward("offer"));
    socket.on("answer", forward("answer"));
    socket.on("candidate", forward("candidate"));

    socket.on("update-media-status", (data) => {
      if (socket.roomId) {
        rooms[socket.roomId]._lastActivity = new Date();
        socket.to(socket.roomId).emit("update-media-status", {
          ...data,
          userId: socket.id,
        });
      }
    });

    socket.on("chat message", ({ msg, user }) => {
      if (socket.roomId) {
        rooms[socket.roomId]._lastActivity = new Date();
        const timestamp = new Date().toISOString();

        socket.to(socket.roomId).emit("chat message", {
          msg,
          user,
          timestamp,
        });

        socket.emit("chat message", {
          msg,
          user: "Tú",
          timestamp,
        });

        console.log(`Chat [${socket.roomId}]: ${user}: ${msg}`);
      }
    });

    socket.on("kick-user", ({ targetId }) => {
      const rid = socket.roomId;
      if (rooms[rid] && rooms[rid][targetId]) {
        const ts = io.sockets.sockets.get(targetId);
        if (ts) {
          ts.emit("kicked");
          ts.disconnect(true);
          console.log(`Usuario ${targetId} expulsado por ${socket.id}`);
        }
        delete rooms[rid][targetId];
      }
    });

    socket.on("force-close-room", () => {
      if (socket.roomId) {
        io.to(socket.roomId).emit("force-close-room");
        console.log(`Sala ${socket.roomId} cerrada por ${socket.id}`);

        if (rooms[socket.roomId]) {
          Object.keys(rooms[socket.roomId]).forEach((id) => {
            if (id !== "_lastActivity") {
              const s = io.sockets.sockets.get(id);
              if (s) s.disconnect(true);
            }
          });
          delete rooms[socket.roomId];
        }
      }
    });

    socket.on("disconnect", () => {
      const rid = socket.roomId;
      if (rid && rooms[rid]) {
        const userName = rooms[rid][socket.id];
        delete rooms[rid][socket.id];
        socket.to(rid).emit("user-disconnected", socket.id);
        console.log(`${userName || socket.id} abandonó la sala ${rid}`);
        if (
          Object.keys(rooms[rid]).filter((k) => k !== "_lastActivity").length ===
          0
        ) {
          delete rooms[rid];
          console.log(`Sala ${rid} eliminada por estar vacía`);
        }
      }
    });

    // Verificación periódica de inactividad o expiración (MOT y normales)
    setInterval(async () => {
      try {
        const now = DateTime.utc();
        for (const roomId of Object.keys(rooms)) {
          const lastActivity = rooms[roomId]._lastActivity || new Date();
          const minutesInactive = (new Date() - lastActivity) / 60000;

          // Verificar si la sala es de MOT (llamadas_mot)
          const result = await db.execute(
            `SELECT * FROM llamadas_mot WHERE room_id = ?`,
            [roomId]
          );

          const motRoom = result.rows[0];
          let shouldClose = false;

          if (motRoom) {
            const start = DateTime.fromISO(motRoom.start_time, {
              zone: "utc",
            });
            const end = DateTime.fromISO(motRoom.end_time, { zone: "utc" });

            if (now < start || now > end) {
              shouldClose = true;
              console.log(`Sala MOT ${roomId} fuera de horario`);
            }
          } else if (minutesInactive > 30) {
            shouldClose = true;
            console.log(`Sala ${roomId} cerrada por inactividad`);
          }

          if (shouldClose) {
            io.to(roomId).emit("force-close-room");
            Object.keys(rooms[roomId]).forEach((id) => {
              if (id !== "_lastActivity") {
                const s = io.sockets.sockets.get(id);
                if (s) s.disconnect(true);
              }
            });
            delete rooms[roomId];
          }
        }
      } catch (err) {
        console.error("Error en limpieza periódica:", err);
      }
    }, 60000);
  });
};
