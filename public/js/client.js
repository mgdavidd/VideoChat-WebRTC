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

let isUploading = false;

async function stopRecordingAndUpload() {
  return new Promise((resolve) => {
    if (isUploading) return resolve();

    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      isUploading = true;
      mediaRecorder.onstop = async function () {
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

        try {
          const res = await fetch("/api/upload-recording", {
            method: "POST",
            body: formData,
          });

          const result = await res.json();
        } catch (err) {
          console.error("Error al subir grabación:", err);
        } finally {
          isUploading = false;
          resolve();
        }
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

async function exitButton() {
  if (isAdmin) {
    await stopRecordingAndUpload();
  }

  Object.values(peerConnections).forEach((pc) => pc.close());
  peerConnections = {};

  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }

  if (fromMot && userRole === 'profesor') {
    return window.location.href = "https://front-mot.onrender.com/InstructorNav";
  }

  document.cookie = "userName=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
  window.location.href = "/";
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
        audio: true // Pedir audio pero puede ser rechazado
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
        // Mezclar ambos audios si ambos existen
        const mixedAudio = await mixAudioStreams(screenStream, micStream);
        const videoTrack = screenStream.getVideoTracks()[0];
        recordingStream = new MediaStream([videoTrack, ...mixedAudio.getAudioTracks()]);
      } else if (screenStream.getAudioTracks().length > 0) {
        // Usar solo audio de pantalla si existe
        recordingStream = screenStream;
      } else if (micStream) {
        // Usar solo micrófono si existe (con video de pantalla)
        const videoTrack = screenStream.getVideoTracks()[0];
        recordingStream = new MediaStream([videoTrack, ...micStream.getAudioTracks()]);
      } else {
        // Solo video si no hay audio
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

socket.on("force-close-room", async () => {
  if (isAdmin && mediaRecorder && mediaRecorder.state !== "inactive") {
    await stopRecordingAndUpload();
  }

  setTimeout(() => {
    alert("La videollamada ha finalizado automáticamente.");

    if (fromMot && userRole === 'profesor') {
      window.location.href = "https://front-mot.onrender.com/InstructorNav";
    } else if (fromMot) {
      window.location.href = "https://front-mot.onrender.com/studentsNav";
    } else {
      window.location.href = "/rooms-form";
    }
  }, 5000);
});

window.addEventListener("beforeunload", (e) => {
  if (isAdmin && mediaRecorder && mediaRecorder.state !== "inactive") {
    stopRecordingAndUpload();
  }
});

window.toggleAudio = toggleAudio;
window.toggleCamera = toggleCamera;
window.changeMedia = changeMedia;
window.exitButton = exitButton;

// link diagrama: https://excalidraw.com/#json=QY3qZ_DeMLhAC4DeMhUlz,0oRz92miFTRE5PR-DVFQiw
