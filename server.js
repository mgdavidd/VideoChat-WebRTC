const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Configuración del motor de vistas (por ejemplo, EJS o Handlebars)
app.set('view engine', 'ejs')

// Ruta para renderizar la sala
app.get('/:id', (req, res) => {
    res.render('room', { roomId: req.params.id }); // Pasar roomId a la vista
});

app.use(express.static('public'));

// Almacenar roomId asociado a cada socket.id(id del usuario: id sala)
const rooms = {};

// Lógica de Socket.io
io.on('connection', (socket) => {
    console.log('✅ Usuario conectado:', socket.id);

    // Unir al usuario a una sala basada en roomId
    socket.on('join-room', (roomId) => {
        socket.join(roomId);
        rooms[socket.id] = roomId; // Registrar el roomId del usuario
        console.log(`🚪 Usuario ${socket.id} se unió a la sala ${roomId}`);

        // Notificar a los demás usuarios en la sala sobre el nuevo usuario
        socket.to(roomId).emit('new-user', { userId: socket.id, roomId });

    });

    socket.on('update-media-status', (data) => {
        socket.to(rooms[socket.id]).emit('update-media-status', data)
    })

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


    // Manejar desconexiones
    socket.on('disconnect', () => {
        console.log('❌ Usuario desconectado:', socket.id);
        const roomId = rooms[socket.id];
        if (roomId) {
            socket.to(roomId).emit('user-disconnected', socket.id);
            delete rooms[socket.id]; // Eliminar el registro del usuario
        }
    });
});

// Iniciar el servidor
server.listen(3000, () => {
    console.log('🚀 Servidor en ejecución en http://localhost:3000');
});