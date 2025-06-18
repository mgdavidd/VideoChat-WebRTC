const remoteVideos = document.getElementById("remoteVideos");

const noCameraImg = document.createElement("img");
noCameraImg.src = "/img/no-camara.png";
noCameraImg.classList.add("no-camera");

export function createRemoteVideoElement(userId, userName, socket, isAdmin) {
    // Crear un contenedor para el video y los íconos
    const container = document.createElement("div");
    container.id = `user-container-${userId}`;

        if(isAdmin) {
        const expellable = document.createElement("button");
        expellable.id = `expellable-${userId}`;
        expellable.classList.add("expel-button");
        const image = document.createElement("img");
        image.src = "/img/expulsar.png";
        expellable.appendChild(image);
        expellable.addEventListener("click", () => {
            socket.emit("kick-user", { targetId: userId });
        });
        container.appendChild(expellable);
    }
  
    // Crear el elemento de video
    const remoteVideo = document.createElement("video");
    remoteVideo.id = userId;
    remoteVideo.autoplay = true;
  
    // Crear el ícono de la cámara
    const cameraIcon = document.createElement("img");
    cameraIcon.id = `cameraIcon-${userId}`;
    cameraIcon.src = "/img/camara.png"; // Ícono inicial de cámara encendida
    cameraIcon.alt = "Estado de la cámara";
    cameraIcon.classList.add("camera-icon");
  
    // Crear el ícono del micrófono
    const microphoneIcon = document.createElement("img");
    microphoneIcon.id = `microphone-icon-${userId}`;
    microphoneIcon.src = "/img/audio.png";
    microphoneIcon.alt = "Estado del micrófono";
    microphoneIcon.classList.add("microphone-icon");
  
    const noCameraImg = document.createElement("img");
    noCameraImg.id = `noCameraImg-${userId}`;
    noCameraImg.src = "/img/no-camara.png";
    noCameraImg.classList.add("no-camera");
    noCameraImg.style.display = "none"; // Ocultar por defecto

    //crear el ícono de pantalla compartida
    const screenShareIcon = document.createElement("img");
    screenShareIcon.id = `screen-share-icon-${userId}`;
    screenShareIcon.src = "/img/no-pantalla.png";
    screenShareIcon.alt = "Estado de la pantalla compartida";
    screenShareIcon.classList.add("screen-share-icon");

    //boton de pantalla completa
    const fullScreenButton = document.createElement("button")
    fullScreenButton.id = `fullscreen-button-${userId}`;
    fullScreenButton.classList.add("fullscreen-remote-button")
    fullScreenButton.innerHTML = `<img src="/img/pantalla-completa.png" alt="Pantalla completa">`;
    fullScreenButton.addEventListener("click", () => {
        const videoElement = document.getElementById(userId);
        (videoElement.requestFullscreen?.() ||
        videoElement.mozRequestFullScreen?.() ||
        videoElement.webkitRequestFullscreen?.() ||
        videoElement.msRequestFullscreen?.());
    })

    const userNameElement = document.createElement("p");
    userNameElement.textContent = userName;
    userNameElement.classList.add("user-name");

    // Agregar el video, la imagen de "no cámara" y los íconos al contenedor
    container.appendChild(remoteVideo);
    container.appendChild(noCameraImg);
    container.appendChild(cameraIcon);
    container.appendChild(microphoneIcon);
    container.appendChild(screenShareIcon);
    container.appendChild(fullScreenButton);
    container.appendChild(userNameElement);

    // Agregar el contenedor al elemento de videos remotos
    remoteVideos.appendChild(container);
  
    return remoteVideo;
}

export function updateMediaStatus(userId, cameraStatus, microphoneStatus, screenShareStatus) {
    console.log('estados', userId, cameraStatus, microphoneStatus, screenShareStatus)
    const remoteVideo = document.getElementById(userId)
    const cameraIcon = document.getElementById(`cameraIcon-${userId}`);
    const microphoneIcon = document.getElementById(`microphone-icon-${userId}`);
    const screenShareIcon = document.getElementById(`screen-share-icon-${userId}`);
    const noCameraImg = document.getElementById(`noCameraImg-${userId}`);
    const fullScreenButton = document.getElementById(`fullscreen-button-${userId}`);

    // Cámara
    if (cameraStatus) {
        cameraIcon.src = "/img/camara.png";
        noCameraImg.style.display = "none";
        remoteVideo.style.display = "block";
    } else {
        cameraIcon.src = "/img/no-camara.png";
        noCameraImg.style.display = "block";
        noCameraImg.style.backgroundColor = "transparent";
        remoteVideo.style.display = "none";
    }

    // Micrófono
    if (microphoneIcon) {
        microphoneIcon.src = microphoneStatus ? "/img/audio.png" : "/img/mute.png";
    }

    // Pantalla compartida
    if (screenShareIcon) {
        screenShareIcon.src = screenShareStatus
            ? "/img/compartir-pantalla.png"
            : "/img/no-pantalla.png";
    }

    if (fullScreenButton) {
        fullScreenButton.style.filter = screenShareStatus ? "invert(0)" : "invert(100%)";
    }
}

document.getElementById("btnFullScreen").addEventListener("click", () => {
    const videoElement = document.getElementById("localVideo");
        if (videoElement.requestFullscreen) {
            videoElement.requestFullscreen();
        } else if (videoElement.mozRequestFullScreen) { // Firefox
            videoElement.mozRequestFullScreen();
        } else if (videoElement.webkitRequestFullscreen) { // Chrome, Safari y Opera
            videoElement.webkitRequestFullscreen();
        } else if (videoElement.msRequestFullscreen) { // IE/Edge
            videoElement.msRequestFullscreen();
        }
})