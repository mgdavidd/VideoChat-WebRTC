const socket = window.socket;

const form = document.getElementById("form-chat");
const input = document.getElementById("input-chat");
const messages = document.getElementById("messages");

socket.on("chat message", ({ msg, user }) => {
    if(user === userNameLocal) {
        const item = `<li class="my-message">${msg}</li>`;
        messages.insertAdjacentHTML("beforeend", item);
    } else {
        const item = `<li><strong>${user}:</strong> ${msg}</li>`;
        messages.insertAdjacentHTML("beforeend", item);
    }
    messages.scrollTop = messages.scrollHeight;
});

form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (input.value) {

    socket.emit("chat message", {
      msg: input.value,
      user: userNameLocal,
      roomId: window.roomId
    });
    input.value = "";
  }
});