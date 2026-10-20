const { createClient } = require("@libsql/client");
const dotenv = require("dotenv");

dotenv.config();

// Bun reutiliza sockets keep-alive aunque el servidor remoto ya los cerró
// por inactividad -> ECONNRESET. Forzamos que cada request abra conexión nueva.
const fetchSinKeepAlive = (url, init = {}) =>
  fetch(url, { ...init, keepalive: false });

const client = createClient({
  url: process.env.DB_URL,
  authToken: process.env.DB_AUTH_TOKEN,
  fetch: fetchSinKeepAlive,
});

const isTransient = (err) =>
  err?.code === "ECONNRESET" || /socket connection was closed/i.test(err?.message || "");

async function execute(...args) {
  try {
    return await client.execute(...args);
  } catch (err) {
    if (!isTransient(err)) throw err;
    return await client.execute(...args);
  }
}

module.exports = { execute, client };