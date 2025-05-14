import { createRemoteVideoElement, updateMediaStatus } from "./dom_elements.js";

const socket = io();
let users = {};

const localVideo = document.getElementById("localVideo");

const configuration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};
const peerConnections = {};
const iceCandidateQueue = {};
const pendingOffers = [];

let localStream = null;
let camera = true;

async function addIceCandidates(userId, peerConnection) {
  if (iceCandidateQueue[userId]?.length > 0) {
    while (iceCandidateQueue[userId].length > 0) {
      const candidate = iceCandidateQueue[userId].shift();
      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (error) {
        console.error("❌ Error agregando candidato ICE:", error);
      }
    }
  }
}

// Evento para el usuario nuevo (solo crea conexiones y envía offer)
socket.on("users-in-room", (usersArray) => {
  usersArray.forEach(({ userId, userName }) => {
    users[userId] = userName;
    createPeerConnection(userId, users[userId]); // El nuevo crea la conexión y envía offer
  });
});

// Evento para los usuarios viejos (NO crean conexión aquí, solo esperan offer)
socket.on("new-user", ({ userId, roomId: remoteRoomId, userName}) => {
  users[userId] = userName;
});

socket.on("user-disconnected", (userId) => {
  if (peerConnections[userId]) {
    peerConnections[userId].close();
    delete peerConnections[userId];
    document.getElementById(userId)?.remove();
    document.getElementById(`user-container-${userId}`)?.remove()
  }
});

// Función para actualizar el stream local
function updateLocalStream(newStream) {
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop()); // Detener las pistas actuales
  }
  localStream = newStream;
  localVideo.srcObject = localStream;
  localVideo.muted = true;

  // Actualizar las pistas en las conexiones existentes
  Object.values(peerConnections).forEach((pc) => {
    const senders = pc.getSenders();
    senders.forEach((sender) => {
      const newTrack = localStream
        .getTracks()
        .find((track) => track.kind === sender.track.kind);
      if (newTrack) {
        sender.replaceTrack(newTrack);
      }
    });
  });
}

async function changeMedia() {
  const buttonMedia = document.getElementById("buttonScreen")
  try {
    let stream;


    if (camera) {
      // Obtener stream de la cámara con audio y video
      stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      //cambiar la imagen del boton de la camara
      buttonMedia.src = "./img/compartir-pantalla.png"
    } else {
      // Obtener stream de la pantalla compartida (video y audio del sistema, si está disponible)
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      buttonMedia.src = "./img/no-pantalla.png"

      // Obtener stream del micrófono (solo audio)
      const audioStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });

      // Combinar el audio del micrófono y el audio de la pantalla compartida
      const mixedAudioStream = await mixAudioStreams(screenStream, audioStream);

      // Combinar el video de la pantalla compartida con el audio mezclado
      const videoTrack = screenStream.getVideoTracks()[0];
      const mixedStream = new MediaStream([
        videoTrack,
        ...mixedAudioStream.getAudioTracks(),
      ]);

      stream = mixedStream;
    }

    console.log(`🎥 Cambiando a ${camera ? "cámara" : "pantalla compartida"}`);
    updateLocalStream(stream);
    camera = !camera;

    // Actualizar estado de cámara y micrófono después de cambiar el stream
    const videoTrack = localStream.getVideoTracks()[0];
    const audioTrack = localStream.getAudioTracks()[0];
    const isCameraOn = videoTrack ? videoTrack.enabled : false;
    const isMicOn = audioTrack ? audioTrack.enabled : false;

    socket.emit("update-media-status", {
      camera: isCameraOn,
      microphone: isMicOn,
      userId: socket.id,
      screenSharing: camera,
    });

    // Procesar ofertas pendientes
    pendingOffers.forEach(handleOffer);
    pendingOffers.length = 0; // Limpiar la cola de ofertas pendientes

  } catch (error) {
    console.error("❌ Error accediendo a dispositivos multimedia:", error);
    alert(
      `No se pudo acceder a ${
        camera ? "la cámara" : "la pantalla compartida"
      }. Asegúrate de permitir el acceso. Error: ${error.message}`
    );
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

function toggleCamera() {
  const videoTrack = localStream.getVideoTracks()[0];
  const audioTrack = localStream.getAudioTracks()[0];

  if (videoTrack) {
    videoTrack.enabled = !videoTrack.enabled;
    const isCameraOn = videoTrack.enabled;
    const isMicOn = audioTrack ? audioTrack.enabled : false;

    // Cambiar el ícono del botón
    const iconoCamara = document.getElementById("iconoCamara");
    iconoCamara.src = isCameraOn
      ? "./img/camara.png"
      : "./img/no-camara.png";

    // Log correcto
    console.log(`🎥 Cámara ${isCameraOn ? "encendida" : "apagada"}`, {
      isCameraOn,
      isMicOn,
      screenSharing: !camera,
      userId: socket.id,
    });

    socket.emit("update-media-status", {
      camera: isCameraOn,
      microphone: isMicOn,
      userId: socket.id,
      screenSharing: camera, // true si está compartiendo pantalla
    });
  }
}

function toggleAudio() {
  const audioTrack = localStream.getAudioTracks()[0];
  const videoTrack = localStream.getVideoTracks()[0];

  if (audioTrack) {
    audioTrack.enabled = !audioTrack.enabled;
    const isMicOn = audioTrack.enabled;
    const isCameraOn = videoTrack ? videoTrack.enabled : false;

    // Cambiar el ícono del botón
    const iconoAudio = document.getElementById("iconoAudio");
    iconoAudio.src = isMicOn ? "./img/audio.png" : "./img/mute.png";

    // Log correcto
    console.log(`🎙️ Micrófono ${isMicOn ? "encendido" : "apagado"}`, {
      isCameraOn,
      isMicOn,
      screenSharing: !camera,
      userId: socket.id,
    });

    socket.emit("update-media-status", {
      camera: isCameraOn,
      microphone: isMicOn,
      userId: socket.id,
      screenSharing: camera,
    });
  }
}

// Función para crear una conexión peer-to-peer
function createPeerConnection(userId, userName) {
  if (peerConnections[userId]) {
    console.log(`🔗 Conexión ya existente con ${userId}`);
    return;
  }

  console.log(`🔗 Creando conexión con ${userId}`);
  const peerConnection = new RTCPeerConnection(configuration);
  peerConnections[userId] = peerConnection;

  // Agregar pistas locales
  localStream
    .getTracks()
    .forEach((track) => peerConnection.addTrack(track, localStream));

  // Manejar candidatos ICE
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("candidate", { target: userId, candidate: event.candidate });
    }
  };

  // Manejar transmisión remota
  peerConnection.ontrack = (event) => {
    //si no puede obtener el elemento, lo crea
    const remoteVideo =
      document.getElementById(userId) || createRemoteVideoElement(userId, userName);
    remoteVideo.srcObject = event.streams[0];
    console.log(users)
  };

  // Crear oferta y enviarla al otro usuario
  peerConnection
    .createOffer()
    .then((offer) => peerConnection.setLocalDescription(offer))
    .then(() => {
      console.log(`📨 Enviando oferta a ${userId}`);
      socket.emit("offer", {
        target: userId,
        offer: peerConnection.localDescription,
      });
    })
    .catch((error) => console.error("❌ Error creando oferta:", error));
}

// Función para manejar ofertas recibidas
async function handleOffer(data) {
  const peerConnection = new RTCPeerConnection(configuration);
  peerConnections[data.sender] = peerConnection;

  // Agregar pistas locales
  localStream
    .getTracks()
    .forEach((track) => peerConnection.addTrack(track, localStream));

  // Manejar candidatos ICE del otro usuario
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("candidate", {
        target: data.sender,
        candidate: event.candidate,
      });
    }
  };

  // Manejar transmisión remota
  peerConnection.ontrack = (event) => {
    const remoteVideo =
      document.getElementById(data.sender) ||
      createRemoteVideoElement(data.sender, users[data.sender]);
    remoteVideo.srcObject = event.streams[0];
  };

  await peerConnection.setRemoteDescription(
    new RTCSessionDescription(data.offer)
  );
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  socket.emit("answer", { target: data.sender, answer: answer });

  addIceCandidates(data.sender, peerConnection);
}

async function start() {
  await changeMedia(); // Esto inicializa localStream
  socket.emit("join-room", { roomId, userName: userNameLocal });
}
start();

socket.on("update-media-status", (data) => {
  const { userId, camera, microphone, screenSharing } = data;
  document.getElementById(userId) || createRemoteVideoElement(userId, users[userId]);

  updateMediaStatus(userId, camera, microphone, screenSharing);
});

socket.on("offer", (data) => {
  if (localStream) {
    handleOffer(data); // Aquí sí creas la conexión si no existe
  } else {
    pendingOffers.push(data);
  }
});

socket.on("answer", async (data) => {
  const pc = peerConnections[data.sender];
  if (!pc) return;
  if (pc.signalingState !== "stable") {
    await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
    addIceCandidates(data.sender, pc);
  } else {
    return;
  }
});

socket.on("candidate", async (data) => {
  if (peerConnections[data.sender]) {
    if (peerConnections[data.sender].remoteDescription) {
      await peerConnections[data.sender].addIceCandidate(
        new RTCIceCandidate(data.candidate)
      );
    } else {
      // Almacenar candidatos ICE en la cola
      if (!iceCandidateQueue[data.sender]) {
        iceCandidateQueue[data.sender] = [];
      }
      iceCandidateQueue[data.sender].push(data.candidate);
    }
  }
});

window.toggleAudio = toggleAudio;
window.toggleCamera = toggleCamera;
window.changeMedia = changeMedia;

// link diagrama: https://excalidraw.com/#json=QY3qZ_DeMLhAC4DeMhUlz,0oRz92miFTRE5PR-DVFQiw