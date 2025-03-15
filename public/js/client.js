const socket = io();
socket.emit('join-room', roomId);

const localVideo = document.getElementById('localVideo');
const remoteVideos = document.getElementById('remoteVideos');

const configuration = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
const peerConnections = {};
const iceCandidateQueue = {};
const pendingOffers = [];

let localStream = null;
let audioTrack = null;
let camera = true;

async function addIceCandidates(userId, peerConnection) {
    if (iceCandidateQueue[userId]?.length > 0) {
        while (iceCandidateQueue[userId].length > 0) {
            const candidate = iceCandidateQueue[userId].shift();
            try {
                await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (error) {
                console.error('❌ Error agregando candidato ICE:', error);
            }
        }
    }
}

// Configurar eventos de socket
socket.on('new-user', ({ userId, roomId: remoteRoomId }) => {
    if (localStream && roomId === remoteRoomId) {
        createPeerConnection(userId);
    }
});

socket.on('user-disconnected', (userId) => {
    if (peerConnections[userId]) {
        peerConnections[userId].close();
        delete peerConnections[userId];
        document.getElementById(userId)?.remove(); // Eliminar el video remoto
    }
});

// Función para actualizar el stream local
function updateLocalStream(newStream) {
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop()); // Detener las pistas actuales
    }
    localStream = newStream;
    localVideo.srcObject = localStream;
    localVideo.muted = true;

    // Actualizar las pistas en las conexiones existentes
    Object.values(peerConnections).forEach(pc => {
        const senders = pc.getSenders();
        senders.forEach(sender => {
            const newTrack = localStream.getTracks().find(track => track.kind === sender.track.kind);
            if (newTrack) {
                sender.replaceTrack(newTrack);
            }
        });
    });
}

async function changeMedia() {
    try {
        let stream;

        if (camera) {
            // Obtener stream de la cámara con audio y video
            stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        } else {
            // Obtener stream de la pantalla compartida (video y audio del sistema, si está disponible)
            const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });

            // Obtener stream del micrófono (solo audio)
            const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });

            // Combinar el audio del micrófono y el audio de la pantalla compartida
            const mixedAudioStream = await mixAudioStreams(screenStream, audioStream);

            // Combinar el video de la pantalla compartida con el audio mezclado
            const videoTrack = screenStream.getVideoTracks()[0];
            const mixedStream = new MediaStream([videoTrack, ...mixedAudioStream.getAudioTracks()]);

            stream = mixedStream;
        }

        console.log(`🎥 Cambiando a ${camera ? 'cámara' : 'pantalla compartida'}`);
        updateLocalStream(stream);
        camera = !camera;

        // Procesar ofertas pendientes
        pendingOffers.forEach(handleOffer);
        pendingOffers.length = 0; // Limpiar la cola de ofertas pendientes

        // Notificar a los demás usuarios que el stream ha cambiado
        Object.keys(peerConnections).forEach(userId => {
            createPeerConnection(userId);
        });
    } catch (error) {
        console.error('❌ Error accediendo a dispositivos multimedia:', error);
        alert(`No se pudo acceder a ${camera ? 'la cámara' : 'la pantalla compartida'}. Asegúrate de permitir el acceso. Error: ${error.message}`);
    }
}

// Función para mezclar dos streams de audio
async function mixAudioStreams(stream1, stream2) {
    const audioContext = new AudioContext();

    // Crear nodos de origen para cada stream de audio
    const source1 = audioContext.createMediaStreamSource(stream1);
    const source2 = audioContext.createMediaStreamSource(stream2);

    // Crear un nodo de destino para el stream mezclado
    const destination = audioContext.createMediaStreamDestination();

    // Conectar los nodos de origen al nodo de destino
    source1.connect(destination);
    source2.connect(destination);

    // Devolver el stream mezclado
    return destination.stream;
}

// Inicializar localStream al inicio
changeMedia();

// Función para crear una conexión peer-to-peer
function createPeerConnection(userId) {
    if (peerConnections[userId]) {
        console.log(`🔗 Conexión ya existente con ${userId}`);
        return;
    }

    console.log(`🔗 Creando conexión con ${userId}`);
    const peerConnection = new RTCPeerConnection(configuration);
    peerConnections[userId] = peerConnection;

    // Agregar pistas locales
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    // Manejar candidatos ICE
    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('candidate', { target: userId, candidate: event.candidate });
        }
    };

    // Manejar transmisión remota
    peerConnection.ontrack = (event) => {
        const remoteVideo = document.getElementById(userId) || createRemoteVideoElement(userId);
        remoteVideo.srcObject = event.streams[0];
    };

    // Crear oferta y enviarla al otro usuario
    peerConnection.createOffer()
        .then(offer => peerConnection.setLocalDescription(offer))
        .then(() => {
            console.log(`📨 Enviando oferta a ${userId}`);
            socket.emit('offer', { target: userId, offer: peerConnection.localDescription });
        })
        .catch(error => console.error('❌ Error creando oferta:', error));
}

// Función para manejar ofertas recibidas
async function handleOffer(data) {
    const peerConnection = new RTCPeerConnection(configuration);
    peerConnections[data.sender] = peerConnection;

    // Agregar pistas locales
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    // Manejar candidatos ICE del otro usuario
    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('candidate', { target: data.sender, candidate: event.candidate });
        }
    };

    // Manejar transmisión remota
    peerConnection.ontrack = (event) => {
        const remoteVideo = document.getElementById(data.sender) || createRemoteVideoElement(data.sender);
        remoteVideo.srcObject = event.streams[0];
    };

    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    socket.emit('answer', { target: data.sender, answer: answer });

    addIceCandidates(data.sender, peerConnection);
}

// Función para crear un elemento de video remoto
function createRemoteVideoElement(userId) {
    const remoteVideo = document.createElement('video');
    remoteVideo.id = userId;
    remoteVideo.autoplay = true;
    remoteVideos.appendChild(remoteVideo);
    return remoteVideo;
}

socket.on('offer', (data) => {
    if (localStream) {
        handleOffer(data);
    } else {
        pendingOffers.push(data);
    }
});

socket.on('answer', async (data) => {
    await peerConnections[data.sender].setRemoteDescription(new RTCSessionDescription(data.answer))
    addIceCandidates(data.sender, peerConnections[data.sender])
});

socket.on('candidate', async (data) => {
    if (peerConnections[data.sender]) {
        if (peerConnections[data.sender].remoteDescription) {
            await peerConnections[data.sender].addIceCandidate(new RTCIceCandidate(data.candidate));
        } else {
            // Almacenar candidatos ICE en la cola
            if (!iceCandidateQueue[data.sender]) {
                iceCandidateQueue[data.sender] = [];
            }
            iceCandidateQueue[data.sender].push(data.candidate);
        }
    }
})
// link diagrama: https://excalidraw.com/#json=QY3qZ_DeMLhAC4DeMhUlz,0oRz92miFTRE5PR-DVFQiw