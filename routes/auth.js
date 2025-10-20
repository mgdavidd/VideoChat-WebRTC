const express = require("express");
const router = express.Router();
const db = require("../db");
const { OAuth2Client } = require("google-auth-library");
const { google } = require("googleapis");

const oAuth2Client = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

router.get("/", (req, res) => res.render("login"));

router.post("/login", async (req, res) => {
  const { userName, password } = req.body;
  if (!userName || !password || userName.trim() === "" || password.trim() === "") return res.redirect("/");
  try {
    const result = await db.execute(
      "SELECT * FROM users WHERE nombre = ? AND contraseña = ?",
      [userName, password]
    );
    if (result.rows.length > 0) {
      res.cookie("userName", userName, { maxAge: 900000 });
      return res.redirect("/rooms-form");
    }
  } catch (err) {
    console.error("Error en login:", err);
  }
  res.redirect("/");
});

router.get("/signup", (req, res) => {
  res.render("signup",{ errorName: null, errorEmail: null} );
});

router.post("/signup", async (req, res) => {
  const { userName, email, password, isAdmin } = req.body;
  if (!userName || !email || !password || userName.trim() === "" || email.trim() === "" || password.trim() === "") return res.redirect("/signup");

  try {
    const nameExist = await db.execute(
      "SELECT 1 FROM users WHERE nombre = ?",
      [userName]
    )
    if(nameExist.rows.length > 0) return res.render("signup", { errorName: "!Este nombre de usuario ya esta registrado¡", errorEmail: null})

    const emailExist = await db.execute(
      "SELECT 1 FROM users WHERE correo = ?",
      [email]
    )
    if(emailExist.rows.length > 0) return res.render("signup", { errorName: null ,errorEmail: "!Este correo ya esta registrado¡" })

    await db.execute(
      "INSERT INTO users (nombre, correo, contraseña, is_admin) VALUES (?, ?, ?, ?)",
      [userName, email, password, isAdmin === "on" ? 1 : 0]
    );
    res.cookie("userName", userName, { maxAge: 900000 });
    return res.redirect(isAdmin === "on" ? "/instrucciones-admin" : "/rooms-form");
  } catch (err) {
    console.error("Error en registro:", err);
    res.redirect("/signup");
  }
});

router.get("/auth/google", (req, res) => {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: [
      "https://www.googleapis.com/auth/drive.file",
      "https://www.googleapis.com/auth/drive.metadata",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
    ],
    prompt: "consent",
  });
  res.redirect(authUrl);
});

router.get("/auth/google/callback", async (req, res) => {
  try {
    const { tokens } = await oAuth2Client.getToken(req.query.code);
    oAuth2Client.setCredentials(tokens);
    const people = google.people({ version: "v1", auth: oAuth2Client });
    const { data } = await people.people.get({
      resourceName: "people/me",
      personFields: "emailAddresses",
    });

    const userEmail = data.emailAddresses?.[0]?.value?.toLowerCase();
    if (!userEmail) throw new Error("Email no disponible");

    const userResult = await db.execute(
      "SELECT * FROM users WHERE LOWER(correo) = ?",
      [userEmail]
    );

    if (userResult.rows.length) {
      await db.execute("UPDATE users SET google_token = ? WHERE correo = ?", [
        JSON.stringify(tokens),
        userEmail,
      ]);
      res.cookie("userName", userResult.rows[0].nombre);
      return res.redirect("/rooms-form");
    }

    req.session.googleToken = tokens;
    req.session.googleEmail = userEmail;
    res.redirect("/choose-username");
  } catch (err) {
    console.error("Error en Google Auth:", err);
    res.redirect("/?error=auth_failed");
  }
});

router.post("/choose-username", async (req, res) => {
  const { userName, password } = req.body;

  if (!req.session?.googleEmail || !userName || !password || userName.trim() === "" || password.trim() === "") {
    return res.redirect("/choose-username?error=missing_data");
  }

  try {
    const exists = await db.execute("SELECT 1 FROM users WHERE nombre = ?", [
      userName,
    ]);
    if (exists.rows.length) {
      return res.redirect("/choose-username?error=username_taken");
    }

    await db.execute(
      "INSERT INTO users (nombre, contraseña, correo, google_token) VALUES (?, ?, ?, ?)",
      [
        userName,
        password,
        req.session.googleEmail,
        JSON.stringify(req.session.googleToken),
      ]
    );

    res.cookie("userName", userName);
    delete req.session.googleEmail;
    delete req.session.googleToken;
    res.redirect("/rooms-form");
  } catch (err) {
    console.error("Error creando usuario:", err);
    res.redirect("/choose-username?error=server");
  }
});

module.exports = router;
