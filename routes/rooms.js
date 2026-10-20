// routes/rooms.js
const express = require("express");
const router = express.Router();
const db = require("../db");
const { DateTime } = require("luxon");

async function checkRoomAvailability(roomId) {
  const nowUTC = DateTime.utc().toISO();
  const result = await db.execute(
    `SELECT 1 FROM fechas 
     WHERE roomId = ? AND ? BETWEEN fecha_inicial_utc AND fecha_final_utc`,
    [roomId, nowUTC]
  );
  return result.rows.length > 0;
}

router.get("/rooms-form", async (req, res) => {
  const rooms = await db.execute("SELECT id FROM rooms");
  const userName = req.session.userName;
  const activesRooms = (
    await Promise.all(
      rooms.rows.map(async (room) => {
        const isActive = await checkRoomAvailability(room.id);
        return isActive ? { id: room.id } : null;
      })
    )
  ).filter(Boolean);

  const myRooms = await db.execute(
    "SELECT r.id FROM rooms r JOIN users u ON r.admin = u.id WHERE u.nombre = ?",
    [userName]
  );
  const ownersRooms = myRooms.rows.map((row) => row.id);

  res.render("room-form", {
    userName,
    isAdmin: req.isAdmin || false,
    activesRooms,
    allRooms: rooms,
    ownersRooms,
  });
});

router.get("/choose-username", (req, res) =>
  res.render("choose-username", {
    error: req.query.error || null,
  })
);

router.post("/create-room", async (req, res) => {
  const { newRoomId } = req.body;
  const userName = req.session.userName;

  if (!newRoomId || !userName) {
    return res.redirect("/rooms-form?error=missing_data");
  }

  try {
    const userResult = await db.execute(
      "SELECT id FROM users WHERE nombre = ?",
      [userName]
    );
    const adminId = userResult.rows[0]?.id;
    if (!adminId) {
      return res.redirect("/rooms-form?error=user_not_found");
    }

    await db.execute("INSERT INTO rooms (id, admin) VALUES (?, ?)", [
      newRoomId,
      adminId,
    ]);

    res.redirect("/rooms-form?success=room_created");
  } catch (err) {
    console.error("Error creando sala:", err);
    res.redirect("/rooms-form?error=room_creation_failed");
  }
});

router.post("/join", (req, res) => {
  const { roomId } = req.body;
  if (roomId) {
    return res.redirect(`/room/${roomId}`);
  }
  res.redirect("/");
});

router.get("/room/:id", async (req, res) => {
  const roomId = req.params.id;
  const userName = req.session.userName;

  try {
    const isAdminRoom = await db.execute(
      "SELECT 1 FROM rooms r JOIN users u ON r.admin = u.id WHERE r.id = ? AND u.nombre = ?",
      [roomId, userName]
    );
    const isOpen = await checkRoomAvailability(roomId);
    if (!isOpen) {
      return res.render("room-closed");
    }
    res.render("room", {
      roomId,
      userName,
      isAdmin: isAdminRoom.rows.length > 0,
    });
  } catch (error) {
    console.error("Error verificando sala:", error);
    res.render("room-closed");
  }
});

router.get("/instrucciones-admin", (req, res) => {
  if (!req.session.userName) return res.redirect("/login");
  if (!req.isAdmin) return res.redirect("/rooms-form");
  res.render("instructions");
});

module.exports = router;
