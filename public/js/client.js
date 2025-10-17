import { createRemoteVideoElement, updateMediaStatus } from "./dom_elements.js";

const socket = window.socket;
let users = {};

let mediaRecorder;
let recordedChunks = [];

const localVideo = document.getElementById("localVideo");

const configuration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};
let peerConnections = {};
const iceCandidateQueue = {};
const pendingOffers = [];

let localStream = null;
let camera = true;

// 🔥 NUEVO: Estado para controlar la subida y bloqueo de salida
let isUploading = false;
let isExiting = false;

socket.on("users-in-room", (usersArray) => {
  usersArray.forEach(({ userId, userName }) => {
    users[userId] = userName;
    createPeerConnection(userId, users[userId]);
  });
});

socket.on("new-user", ({ userId, roomId: remoteRoomId, userName }) => {
  users[userId] = userName;
});

socket.on("user-disconnected", (userId) => {
  if (peerConnections[userId]) {
    peerConnections[userId].close();
    delete peerConnections[userId];
    document.getElementById(userId)?.remove();
    document.getElementById(`user-container-${userId}`)?.remove();
  }
});

// Actualizar stream local
function updateLocalStream(newStream) {
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
  }
  localStream = newStream;
  localVideo.srcObject = localStream;
  localVideo.muted = true;

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

// 🔥 MEJORADO: Deshabilitar botón durante la subida
function disableExitButton() {
  const exitBtn = document.getElementById("exitBtn");
  if (exitBtn) {
    exitBtn.disabled = true;
    exitBtn.style.opacity = "0.5";
    exitBtn.style.cursor = "not-allowed";
    exitBtn.title = "Guardando grabación, por favor espera...";
  }
}

function enableExitButton() {
  const exitBtn = document.getElementById("exitBtn");
  if (exitBtn) {
    exitBtn.disabled = false;
    exitBtn.style.opacity = "1";
    exitBtn.style.cursor = "pointer";
    exitBtn.title = "Salir de la videollamada";
  }
}

// 🔥 MEJORADO: Mostrar indicador de progreso
function showUploadProgress() {
  let progressDiv = document.getElementById("upload-progress");
  if (!progressDiv) {
    progressDiv = document.createElement("div");
    progressDiv.id = "upload-progress";
    progressDiv.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: rgba(0, 0, 0, 0.9);
      color: white;
      padding: 15px 25px;
      border-radius: 8px;
      z-index: 10000;
      font-family: Arial, sans-serif;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    `;
    document.body.appendChild(progressDiv);
  }
  progressDiv.innerHTML = `
    <div style="display: flex; align-items: center; gap: 10px;">
      <div style="
        border: 3px solid #f3f3f3;
        border-top: 3px solid #3498db;
        border-radius: 50%;
        width: 20px;
        height: 20px;
        animation: spin 1s linear infinite;
      "></div>
      <span>Guardando grabación...</span>
    </div>
    <style>
      @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
    </style>
  `;
  progressDiv.style.display = "block";
}

function hideUploadProgress() {
  const progressDiv = document.getElementById("upload-progress");
  if (progressDiv) {
    progressDiv.style.display = "none";
  }
}

async function stopRecordingAndUpload() {
  return new Promise((resolve, reject) => {
    // Evitar múltiples llamadas simultáneas
    if (isUploading) {
      console.log("Ya hay una subida en progreso");
      return resolve();
    }

    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      isUploading = true;
      disableExitButton();
      showUploadProgress();

      mediaRecorder.onstop = async function () {
        try {
          const blob = new Blob(recordedChunks, { type: "video/webm" });
          const formData = new FormData();
          formData.append("recording", blob, "grabacion.webm");
          formData.append("roomId", roomId);
          formData.append("adminUserName", userNameLocal);
          formData.append("fromMot", fromMot ? "true" : "false");

          const userTimeZone = luxon.DateTime.local().zoneName;
          formData.append("userTimeZone", userTimeZone);

          if (window.selectedModuleId) {
            formData.append("selectedModuleId", window.selectedModuleId);
          }

          console.log("Iniciando subida de grabación...");
          const res = await fetch("/api/upload-recording", {
            method: "POST",
            body: formData,
          });

          const result = await res.json();
          
          if (result.success) {
            console.log("✅ Grabación subida exitosamente");
          } else {
            console.error("❌ Error en respuesta del servidor:", result);
          }

          resolve();
        } catch (err) {
          console.error("❌ Error al subir grabación:", err);
          reject(err);
        } finally {
          isUploading = false;
          hideUploadProgress();
          enableExitButton();
          recordedChunks = []; // Limpiar chunks
        }
      };

      mediaRecorder.onerror = function(error) {
        console.error("Error en MediaRecorder:", error);
        isUploading = false;
        hideUploadProgress();
        enableExitButton();
        reject(error);
      };

      mediaRecorder.stop();
    } else {
      resolve();
    }
  });
}

async function changeMedia() {
  const buttonMedia = document.getElementById("buttonScreen");
  try {
    let stream;

    if (camera) {
      stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      buttonMedia.src = "/img/compartir-pantalla.png";
    } else {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });

      const audioStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });

      const mixedAudio = await mixAudioStreams(screenStream, audioStream);
      const videoTrack = screenStream.getVideoTracks()[0];
      stream = new MediaStream([videoTrack, ...mixedAudio.getAudioTracks()]);
      buttonMedia.src = "/img/no-pantalla.png";
    }

    updateLocalStream(stream);
    camera = !camera;

    const videoTrack = localStream.getVideoTracks()[0];
    const audioTrack = localStream.getAudioTracks()[0];
    socket.emit("update-media-status", {
      camera: videoTrack?.enabled || false,
      microphone: audioTrack?.enabled || false,
      userId: socket.id,
      screenSharing: !camera,
    });
  } catch (error) {
    console.error("Error en changeMedia:", error);
  }
}

async function mixAudioStreams(stream1, stream2) {
  const audioContext = new AudioContext();
  const source1 = audioContext.createMediaStreamSource(stream1);
  const source2 = audioContext.createMediaStreamSource(stream2);
  const destination = audioContext.createMediaStreamDestination();

  source1.connect(destination);
  source2.connect(destination);

  return destination.stream;
}

function toggleCamera() {
  const videoTrack = localStream.getVideoTracks()[0];
  const audioTrack = localStream.getAudioTracks()[0];

  if (videoTrack) {
    videoTrack.enabled = !videoTrack.enabled;
    const isCameraOn = videoTrack.enabled;
    const isMicOn = audioTrack ? audioTrack.enabled : false;

    const iconoCamara = document.getElementById("iconoCamara");
    iconoCamara.src = isCameraOn ? "/img/camara.png" : "/img/no-camara.png";

    socket.emit("update-media-status", {
      camera: isCameraOn,
      microphone: isMicOn,
      userId: socket.id,
      screenSharing: camera,
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

    const iconoAudio = document.getElementById("iconoAudio");
    iconoAudio.src = isMicOn ? "/img/audio.png" : "/img/mute.png";

    socket.emit("update-media-status", {
      camera: isCameraOn,
      microphone: isMicOn,
      userId: socket.id,
      screenSharing: camera,
    });
  }
}

// 🔥 MEJORADO: Prevenir salida múltiple y asegurar subida
async function exitButton() {
  // Prevenir múltiples clics
  if (isExiting) {
    console.log("Ya se está procesando la salida");
    return;
  }

  // Prevenir salida durante subida
  if (isUploading) {
    alert("Por favor espera a que termine de guardarse la grabación");
    return;
  }

  isExiting = true;
  disableExitButton();

  try {
    // Si es admin, esperar a que termine la subida
    if (isAdmin) {
      await stopRecordingAndUpload();
    }

    // Cerrar conexiones
    Object.values(peerConnections).forEach((pc) => pc.close());
    peerConnections = {};

    // Detener stream local
    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
      localStream = null;
    }

    // Redirigir según el tipo de usuario
    if (fromMot && userRole === 'profesor') {
      return window.location.href = "https://front-mot.onrender.com/InstructorNav";
    }

    document.cookie = "userName=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
    window.location.href = "/";
  } catch (error) {
    console.error("Error durante la salida:", error);
    alert("Hubo un problema al guardar la grabación. Reintentando...");
    isExiting = false;
    enableExitButton();
  }
}

function createPeerConnection(userId, userName) {
  if (peerConnections[userId]) return;

  const peerConnection = new RTCPeerConnection(configuration);
  peerConnections[userId] = peerConnection;

  localStream
    .getTracks()
    .forEach((track) => peerConnection.addTrack(track, localStream));

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("candidate", { target: userId, candidate: event.candidate });
    }
  };

  peerConnection.ontrack = (event) => {
    const remoteVideo =
      document.getElementById(userId) ||
      createRemoteVideoElement(userId, userName, socket, isAdmin);
    remoteVideo.srcObject = event.streams[0];
  };

  peerConnection
    .createOffer()
    .then((offer) => peerConnection.setLocalDescription(offer))
    .then(() => {
      socket.emit("offer", {
        target: userId,
        offer: peerConnection.localDescription,
      });
    })
    .catch((error) => console.error("❌ Error creando oferta:", error));
}

async function handleOffer(data) {
  const peerConnection = new RTCPeerConnection(configuration);
  peerConnections[data.sender] = peerConnection;

  localStream
    .getTracks()
    .forEach((track) => peerConnection.addTrack(track, localStream));

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("candidate", {
        target: data.sender,
        candidate: event.candidate,
      });
    }
  };

  peerConnection.ontrack = (event) => {
    const remoteVideo =
      document.getElementById(data.sender) ||
      createRemoteVideoElement(
        data.sender,
        users[data.sender],
        socket,
        isAdmin
      );
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

async function start() {
  if (isAdmin || (fromMot && userRole === 'profesor')) {
    try {
      // 1. Capturar pantalla (con o sin audio)
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true
      });

      // 2. Intentar capturar micrófono
      let micStream;
      try {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: true
        });
      } catch (micError) {
        console.warn("No se pudo acceder al micrófono:", micError);
      }

      // 3. Determinar qué streams usar para la grabación
      let recordingStream;
      if (screenStream.getAudioTracks().length > 0 && micStream) {
        const mixedAudio = await mixAudioStreams(screenStream, micStream);
        const videoTrack = screenStream.getVideoTracks()[0];
        recordingStream = new MediaStream([videoTrack, ...mixedAudio.getAudioTracks()]);
      } else if (screenStream.getAudioTracks().length > 0) {
        recordingStream = screenStream;
      } else if (micStream) {
        const videoTrack = screenStream.getVideoTracks()[0];
        recordingStream = new MediaStream([videoTrack, ...micStream.getAudioTracks()]);
      } else {
        recordingStream = new MediaStream([screenStream.getVideoTracks()[0]]);
      }

      // Configurar el MediaRecorder
      recordedChunks = [];
      mediaRecorder = new MediaRecorder(recordingStream, {
        mimeType: "video/webm; codecs=vp9",
      });

      mediaRecorder.ondataavailable = function (event) {
        if (event.data.size > 0) {
          recordedChunks.push(event.data);
        }
      };

      // Manejar cuando el usuario deja de compartir pantalla
      screenStream.getVideoTracks()[0].onended = () => {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
          mediaRecorder.stop();
        }
      };

      mediaRecorder.start();
    } catch (err) {
      console.error("Error al iniciar grabación:", err);
      if (err.name !== 'NotAllowedError') {
        alert("Error al configurar la grabación: " + err.message);
      }
    }
  }

  await changeMedia();
  socket.emit("join-room", { roomId, userName: userNameLocal });
}

start();

socket.on("update-media-status", (data) => {
  const { userId, camera, microphone, screenSharing } = data;
  document.getElementById(userId) ||
    createRemoteVideoElement(userId, users[userId], socket, isAdmin);

  updateMediaStatus(userId, camera, microphone, screenSharing);
});

socket.on("offer", (data) => {
  if (localStream) {
    handleOffer(data);
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
  }
});

socket.on("candidate", async (data) => {
  if (peerConnections[data.sender]) {
    if (peerConnections[data.sender].remoteDescription) {
      await peerConnections[data.sender].addIceCandidate(
        new RTCIceCandidate(data.candidate)
      );
    } else {
      if (!iceCandidateQueue[data.sender]) {
        iceCandidateQueue[data.sender] = [];
      }
      iceCandidateQueue[data.sender].push(data.candidate);
    }
  }
});

socket.on("kicked", () => {
  alert("Has sido expulsado de la sala por el administrador.");
  document.cookie = "userName=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
  window.location.href = "/";
});

// 🔥 MEJORADO: Deshabilitar botón durante cierre automático
socket.on("force-close-room", async () => {
  disableExitButton();
  
  if (isAdmin && mediaRecorder && mediaRecorder.state !== "inactive") {
    try {
      await stopRecordingAndUpload();
      console.log("✅ Grabación guardada antes del cierre automático");
    } catch (error) {
      console.error("❌ Error guardando grabación:", error);
    }
  }

  setTimeout(() => {
    alert("La videollamada ha finalizado automáticamente.");

    if (fromMot && userRole === 'profesor') {
      window.location.href = "https://front-mot.onrender.com/InstructorNav";
    } else if (fromMot) {
      window.location.href = "https://front-mot.onrender.com/studentNav";
    } else {
      window.location.href = "/rooms-form";
    }
  }, 2000); // Reducido de 5000 a 2000ms
});

// 🔥 MEJORADO: Prevenir cierre de ventana durante subida
window.addEventListener("beforeunload", (e) => {
  if (isUploading) {
    e.preventDefault();
    e.returnValue = "La grabación se está guardando. ¿Estás seguro de salir?";
    return e.returnValue;
  }
  
  if (isAdmin && mediaRecorder && mediaRecorder.state !== "inactive") {
    stopRecordingAndUpload();
  }
});

window.toggleAudio = toggleAudio;
window.toggleCamera = toggleCamera;
window.changeMedia = changeMedia;
window.exitButton = exitButton;

// link diagrama: https://excalidraw.com/#json=QY3qZ_DeMLhAC4DeMhUlz,0oRz92miFTRE5PR-DVFQiw