const fs = require("fs");
const { google } = require("googleapis");
const { OAuth2Client } = require("google-auth-library");
const db = require("./db");

const createDriveFolder = async (drive, userName) => {
  const folderResponse = await drive.files.create({
    requestBody: {
      name: `Grabaciones VideoLlamadas - ${userName}`,
      mimeType: "application/vnd.google-apps.folder",
    },
    fields: "id",
  });
  return folderResponse.data.id;
};

// Verifica que el folder exista y no esté en la papelera.
const folderIsUsable = async (drive, folderId) => {
  if (!folderId) return false;
  try {
    const { data } = await drive.files.get({
      fileId: folderId,
      fields: "id,trashed",
    });
    return !data.trashed;
  } catch (err) {
    const status = err.code || err.response?.status;
    if (status === 404) return false; // eliminado
    throw err; // otros errores (permisos, red) no los ocultamos
  }
};

const getAdminDriveClient = async (adminUserName) => {
  const result = await db.execute(
    "SELECT google_token, google_drive_folder_id FROM users WHERE nombre = ? AND is_admin = 1",
    [adminUserName]
  );

  const admin = result.rows[0];
  if (!admin) throw new Error("Usuario administrador no encontrado");
  if (!admin.google_token)
    throw new Error("El administrador no ha vinculado su cuenta de Google Drive");

  const auth = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  auth.setCredentials(JSON.parse(admin.google_token));
  const drive = google.drive({ version: "v3", auth });

  let folderId = admin.google_drive_folder_id;

  if (!(await folderIsUsable(drive, folderId))) {
    folderId = await createDriveFolder(drive, adminUserName);
    await db.execute(
      "UPDATE users SET google_drive_folder_id = ? WHERE nombre = ?",
      [folderId, adminUserName]
    );
  }

  return { auth, folderId };
};

// Si el folder se borra justo entre la verificación y la subida, reintenta
// una vez con un folder nuevo.
const uploadRecording = async (adminUserName, roomId, filePath) => {
  const attempt = async () => {
    const { auth, folderId } = await getAdminDriveClient(adminUserName);
    const drive = google.drive({ version: "v3", auth });

    return drive.files.create({
      requestBody: {
        name: `Grabacion-${roomId}-${Date.now()}.webm`,
        mimeType: "video/webm",
        parents: [folderId],
      },
      media: {
        mimeType: "video/webm",
        body: fs.createReadStream(filePath),
      },
      fields: "id,webViewLink",
    });
  };

  try {
    return await attempt();
  } catch (err) {
    const status = err.code || err.response?.status;
    if (status === 404) {
      console.warn(
        `Folder de ${adminUserName} inválido al subir, recreando y reintentando...`
      );
      await db.execute(
        "UPDATE users SET google_drive_folder_id = NULL WHERE nombre = ?",
        [adminUserName]
      );
      return await attempt();
    }
    throw err;
  }
};

module.exports = { getAdminDriveClient, uploadRecording };