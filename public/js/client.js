const socket = io();
socket.emit("join-room", roomId);

const localVideo = document.getElementById("localVideo");
const remoteVideos = document.getElementById("remoteVideos");

noCameraImg = document.createElement("img");
noCameraImg.src = "./img/no-camara.png";
noCameraImg.classList.add("no-camera");

const configuration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};
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
        console.error("❌ Error agregando candidato ICE:", error);
      }
    }
  }
}

// Configurar eventos de socket
socket.on("new-user", ({ userId, roomId: remoteRoomId }) => {
  if (localStream && roomId === remoteRoomId) {
    createPeerConnection(userId);
  }

  const remoteVideo = document.getElementById(userId) || createRemoteVideoElement(userId); 
  //enviamos los medios
  socket.emit("update-media-status", {
    camera: localStream.getVideoTracks()[0].enabled,
    microphone: localStream.getAudioTracks()[0].enabled,
    userId: socket.id
  })
  console.log('new-user', localStream.getVideoTracks()[0].enabled,localStream.getAudioTracks()[0].enabled, socket.id)
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

    // Procesar ofertas pendientes
    pendingOffers.forEach(handleOffer);
    pendingOffers.length = 0; // Limpiar la cola de ofertas pendientes

    // Notificar a los demás usuarios que el stream ha cambiado
    Object.keys(peerConnections).forEach((userId) => {
      createPeerConnection(userId);
    });
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

changeMedia();

function toggleCamera() {
  const videoTrack = localStream.getVideoTracks()[0];
  const audioTrack = localStream.getAudioTracks()[0]; // Obtener el estado actual del micrófono

  if (videoTrack) {
    videoTrack.enabled = !videoTrack.enabled;
    console.log(`🎥 Cámara ${videoTrack.enabled ? "encendida" : "apagada"}`);

    // Cambiar el ícono del botón
    const iconoCamara = document.getElementById("iconoCamara");
    iconoCamara.src = videoTrack.enabled
      ? "./img/camara.png"
      : "./img/no-camara.png";    

    socket.emit("update-media-status", {
      camera: videoTrack.enabled,
      microphone: audioTrack ? audioTrack.enabled : false, // Incluir el estado del micrófono
      userId: socket.id,
    });
  }
}

function toggleAudio() {
  const audioTrack = localStream.getAudioTracks()[0];
  const videoTrack = localStream.getVideoTracks()[0]; // Obtener el estado actual de la cámara

  if (audioTrack) {
    audioTrack.enabled = !audioTrack.enabled;
    console.log(`🎙️ Micrófono ${audioTrack.enabled ? "encendido" : "apagado"}`);

    // Cambiar el ícono del botón
    const iconoAudio = document.getElementById("iconoAudio");
    iconoAudio.src = audioTrack.enabled ? "./img/audio.png" : "./img/mute.png";

    // Emitir el estado de ambos medios
    socket.emit("update-media-status", {
      camera: videoTrack ? videoTrack.enabled : false, // Incluir el estado de la cámara
      microphone: audioTrack.enabled,
      userId: socket.id,
    });
  }
}

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
      document.getElementById(userId) || createRemoteVideoElement(userId);
    remoteVideo.srcObject = event.streams[0];
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
      createRemoteVideoElement(data.sender);
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

// Función para crear un elemento de video remoto
function createRemoteVideoElement(userId) {
  // Crear un contenedor para el video y los íconos
  const container = document.createElement("div");
  container.id = `user-container-${userId}`;

  // Crear el elemento de video
  const remoteVideo = document.createElement("video");
  remoteVideo.id = userId;
  remoteVideo.autoplay = true;

  // Crear el ícono de la cámara
  const cameraIcon = document.createElement("img");
  cameraIcon.id = `cameraIcon-${userId}`;
  cameraIcon.src = "./img/camara.png"; // Ícono inicial de cámara encendida
  cameraIcon.alt = "Estado de la cámara";
  cameraIcon.classList.add("camera-icon");

  // Crear el ícono del micrófono
  const microphoneIcon = document.createElement("img");
  microphoneIcon.id = `microphone-icon-${userId}`;
  microphoneIcon.src = "./img/audio.png";
  microphoneIcon.alt = "Estado del micrófono";
  microphoneIcon.classList.add("microphone-icon");

  const noCameraImg = document.createElement("img");
  noCameraImg.id = `noCameraImg-${userId}`;
  noCameraImg.src = "./img/no-camara.png";
  noCameraImg.classList.add("no-camera");
  noCameraImg.style.display = "none"; // Ocultar por defecto

  // Agregar el video, la imagen de "no cámara" y los íconos al contenedor
  container.appendChild(remoteVideo);
  container.appendChild(noCameraImg);
  container.appendChild(cameraIcon);
  container.appendChild(microphoneIcon);

  // Agregar el contenedor al elemento de videos remotos
  remoteVideos.appendChild(container);

  return remoteVideo;
}

socket.on("update-media-status", (data) => {
  const { userId, camera, microphone } = data;
  const div = document.getElementById(`user-container-${userId}`);
  const remoteVideo = document.getElementById(userId) || createRemoteVideoElement(userId);

  const remoteCameraIcon = document.getElementById(`cameraIcon-${userId}`);
  if (remoteCameraIcon) {
    remoteCameraIcon.src = camera
      ? "./img/camara.png"
      : "./img/no-camara.png";

    // Manejar la visibilidad de la imagen de "no cámara" específica del usuario
    const noCameraImg = document.getElementById(`noCameraImg-${userId}`);
    if (noCameraImg) {
      noCameraImg.style.display = camera ? "none" : "block";
    }
    remoteVideo.style.display = camera ? "block" : "none"; // Mostrar/ocultar el video
  }

  const remoteMicrophoneIcon = document.getElementById(`microphone-icon-${userId}`);
  if (remoteMicrophoneIcon) {
    remoteMicrophoneIcon.src = microphone
      ? "./img/audio.png"
      : "./img/mute.png";
  }
});

socket.on("offer", (data) => {
  if (localStream) {
    console.log("handleOffer");
    handleOffer(data);
  } else {
    console.log("pendingoffers");
    pendingOffers.push(data);
  }
});

socket.on("answer", async (data) => {
  await peerConnections[data.sender].setRemoteDescription(
    new RTCSessionDescription(data.answer)
  );
  addIceCandidates(data.sender, peerConnections[data.sender]);
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
// link diagrama: https://excalidraw.com/#json=QY3qZ_DeMLhAC4DeMhUlz,0oRz92miFTRE5PR-DVFQiw