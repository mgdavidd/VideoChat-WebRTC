const remoteVideos = document.getElementById("remoteVideos");

const noCameraImg = document.createElement("img");
noCameraImg.src = "./img/no-camara.png";
noCameraImg.classList.add("no-camera");

export function createRemoteVideoElement(userId) {
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

    //crear el ícono de pantalla compartida
    const screenShareIcon = document.createElement("img");
    screenShareIcon.id = `screen-share-icon-${userId}`;
    screenShareIcon.src = "./img/compartir-pantalla.png";
    screenShareIcon.alt = "Estado de la pantalla compartida";
    screenShareIcon.classList.add("screen-share-icon");

    //boton de pantalla completa
    const fullScreenButton = document.createElement("button")
    fullScreenButton.id = `fullscreen-button-${userId}`;
    fullScreenButton.classList.add("fullscreen-remote-button")
    fullScreenButton.innerHTML = `<img src="./img/pantalla-completa.png" alt="Pantalla completa">`;
    fullScreenButton.addEventListener("click", () => {
        const videoElement = document.getElementById(userId);
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
  
    // Agregar el video, la imagen de "no cámara" y los íconos al contenedor
    container.appendChild(remoteVideo);
    container.appendChild(noCameraImg);
    container.appendChild(cameraIcon);
    container.appendChild(microphoneIcon);
    container.appendChild(screenShareIcon);
    container.appendChild(fullScreenButton);

    // Agregar el contenedor al elemento de videos remotos
    remoteVideos.appendChild(container);
  
    return remoteVideo;
}

export function updateMediaStatus(userId, cameraStatus, microphoneStatus, screenShareStatus) {
    const remoteVideo = document.getElementById(userId)
    const cameraIcon = document.getElementById(`cameraIcon-${userId}`);
    const microphoneIcon = document.getElementById(`microphone-icon-${userId}`);
    const screenShareIcon = document.getElementById(`screen-share-icon-${userId}`);
    const noCameraImg = document.getElementById(`noCameraImg-${userId}`);

    if (cameraStatus) {
        cameraIcon.src = "./img/camara.png"; // Ícono de cámara encendida
        noCameraImg.style.display = "none"; // Ocultar imagen de "no cámara"
        remoteVideo.style.display = "block"
    } else {
        cameraIcon.src = "./img/no-camara.png"; // Ícono de cámara apagada
        noCameraImg.style.display = "block"; // Mostrar imagen de "no cámara"
        noCameraImg.style.backgroundColor = "transparent"; // Mostrar imagen de "no cámara"
        remoteVideo.style.display = "none"
    }

    // Actualizar el estado del micrófono
    microphoneIcon.src = microphoneStatus ? "./img/audio.png" : "./img/mute.png";

    // Actualizar el estado de la pantalla compartida
    screenShareIcon.src = screenShareStatus ? "./img/compartir-pantalla.png" : "./img/no-pantalla.png";
    if(screenShareStatus) {
        document.getElementById(`fullscreen-button-${userId}`).style.filter = "invert(0)"
    }else{
        document.getElementById(`fullscreen-button-${userId}`).style.filter = "invert(100%)"
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