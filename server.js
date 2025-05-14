const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cookieParser = require('cookie-parser')

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Configuración del motor de vistas (por ejemplo, EJS o Handlebars)
app.set('view engine', 'ejs')

app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));

//login del usuario para video chat
app.get('/', (req, res) => {
    res.render('login'); // Renderizar la vista de inicio de sesión
});

app.post('/join', (req, res) => {
    const { roomId, userName } = req.body;
    if (!roomId || !userName) {
        // Puedes pasar un mensaje de error a la vista si lo deseas
        return res.redirect('/');
    } else {
        res.cookie('userName', userName, { maxAge: 900000 });
        res.redirect(`/${roomId}`);
    }
});

// Ruta para renderizar la sala
app.get('/:id', (req, res) => {
    const userName = req.cookies.userName;
    if (!userName) {
        return res.redirect('/'); // Redirigir al inicio de sesión si no hay nombre de usuario
    }
    res.render('room', { roomId: req.params.id, userName }); // Pasar roomId y userName a la vista
});

app.use(express.static('public'));

// Evento join-room en el servidor
const rooms = {}; // { roomId: { socketId: userName, ... } }

io.on('connection', (socket) => {
  socket.on('join-room', ({ roomId, userName }) => {
    // Inicializa la sala si no existe
    if (!rooms[roomId]) rooms[roomId] = {};
    rooms[roomId][socket.id] = userName;

    // 1. Enviar al usuario nuevo la lista de usuarios ya conectados
    const usersInRoom = Object.entries(rooms[roomId])
      .filter(([id]) => id !== socket.id)
      .map(([id, name]) => ({ userId: id, userName: name }));

    socket.emit('users-in-room', usersInRoom);

    // 2. Notificar a los demás usuarios del nuevo usuario
    socket.to(roomId).emit('new-user', { userId: socket.id, userName, roomId });

    socket.join(roomId);
    socket.roomId = roomId;

    // Limpieza al desconectar
    socket.on('disconnect', () => {
      if (rooms[roomId]) {
        delete rooms[roomId][socket.id];
        socket.to(roomId).emit('user-disconnected', socket.id);
        if (Object.keys(rooms[roomId]).length === 0) {
          delete rooms[roomId];
        }
      }
    });
  });

  socket.on('update-media-status', (data) => {
    if (socket.roomId) {
      socket.to(socket.roomId).emit('update-media-status', data);
    }
  });

  // Manejar ofertas, respuestas y candidatos ICE dentro de la sala
  socket.on('offer', (data) => {
    socket.to(data.target).emit('offer', { offer: data.offer, sender: socket.id });
  });

  socket.on('answer', (data) => {
    socket.to(data.target).emit('answer', { answer: data.answer, sender: socket.id });
  });

  socket.on('candidate', (data) => {
    socket.to(data.target).emit('candidate', { candidate: data.candidate, sender: socket.id });
  });
});

// Iniciar el servidor
server.listen(3000, () => {
    console.log('🚀 Servidor en ejecución en http://localhost:3000');
});