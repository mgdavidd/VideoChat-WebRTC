const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const db = require("../db");
const { OAuth2Client } = require("google-auth-library");
const { google } = require("googleapis");

const oAuth2Client = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

const USERNAME_RE = /^[a-zA-Z0-9_-]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BCRYPT_ROUNDS = 12;

// Evita fuerza bruta en login/signup. Ajusta max/windowMs a tu gusto.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Demasiados intentos. Espera unos minutos e intenta de nuevo." },
});

const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

router.get("/", (req, res) => res.render("login", { error: req.query.error || null }));

router.post("/login", loginLimiter, async (req, res) => {
  const { userName, password } = req.body;
  if (!userName || !password) return res.redirect("/?error=missing_data");

  try {
    const result = await db.execute(
      "SELECT id, nombre, contraseña, is_admin FROM users WHERE nombre = ?",
      [userName]
    );
    const user = result.rows[0];

    // Mismo mensaje para user inexistente o contraseña mala (no filtrar).
    if (!user) return res.redirect("/?error=invalid_credentials");

    const validPassword = await bcrypt.compare(password, user.contraseña);
    if (!validPassword) return res.redirect("/?error=invalid_credentials");

    // Regenerar sesión: evita session fixation.
    req.session.regenerate((err) => {
      if (err) {
        console.error("Error regenerando sesión:", err);
        return res.redirect("/?error=server");
      }
      req.session.userName = user.nombre;
      req.session.isAdmin = user.is_admin === 1;
      res.redirect("/rooms-form");
    });
  } catch (err) {
    console.error("Error en login:", err);
    res.redirect("/?error=server");
  }
});

router.get("/signup", (req, res) => {
  res.render("signup", { errorName: null, errorEmail: null });
});

router.post("/signup", signupLimiter, async (req, res) => {
  // Cualquiera puede marcarse admin: cada uno gestiona su propias salas/llamadas.
  const { userName, email, password, isAdmin } = req.body;
  const wantsAdmin = isAdmin === "on";

  if (!userName || !email || !password)
    return res.render("signup", { errorName: null, errorEmail: null });
  if (!USERNAME_RE.test(userName))
    return res.render("signup", {
      errorName: "Usuario: 3-20 caracteres (letras, números, _ o -)",
      errorEmail: null,
    });
  if (!EMAIL_RE.test(email))
    return res.render("signup", { errorName: null, errorEmail: "Correo inválido" });
  if (password.length < 8)
    return res.render("signup", {
      errorName: "Contraseña: mínimo 8 caracteres",
      errorEmail: null,
    });

  const normalizedEmail = email.toLowerCase();

  try {
    const nameExist = await db.execute("SELECT 1 FROM users WHERE nombre = ?", [
      userName,
    ]);
    if (nameExist.rows.length > 0)
      return res.render("signup", {
        errorName: "Usuario ya registrado",
        errorEmail: null,
      });

    const emailExist = await db.execute("SELECT 1 FROM users WHERE correo = ?", [
      normalizedEmail,
    ]);
    if (emailExist.rows.length > 0)
      return res.render("signup", {
        errorName: null,
        errorEmail: "Correo ya registrado",
      });

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await db.execute(
      "INSERT INTO users (nombre, correo, contraseña, is_admin) VALUES (?, ?, ?, ?)",
      [userName, normalizedEmail, passwordHash, wantsAdmin ? 1 : 0]
    );

    req.session.regenerate((err) => {
      if (err) return res.redirect("/signup");
      req.session.userName = userName;
      req.session.isAdmin = wantsAdmin;
      res.redirect(wantsAdmin ? "/instrucciones-admin" : "/rooms-form");
    });
  } catch (err) {
    console.error("Error en registro:", err);
    res.redirect("/signup");
  }
});

router.get("/auth/google", (req, res) => {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [
      "https://www.googleapis.com/auth/drive.file",
      "https://www.googleapis.com/auth/drive.metadata",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
    ],
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

      return req.session.regenerate((err) => {
        if (err) {
          console.error("Error regenerando sesión:", err);
          return res.redirect("/?error=auth_failed");
        }
        req.session.userName = userResult.rows[0].nombre;
        req.session.isAdmin = userResult.rows[0].is_admin === 1;
        res.redirect("/rooms-form");
      });
    }

    // Usuario nuevo vía Google: guardamos el token temporalmente en la sesión
    // (que ya es segura, no una cookie legible) mientras elige username/password.
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

  if (!req.session?.googleEmail || !userName || !password)
    return res.redirect("/choose-username?error=missing_data");
  if (!USERNAME_RE.test(userName))
    return res.redirect("/choose-username?error=invalid_username");
  if (password.length < 8)
    return res.redirect("/choose-username?error=weak_password");

  try {
    const exists = await db.execute("SELECT 1 FROM users WHERE nombre = ?", [
      userName,
    ]);
    if (exists.rows.length) return res.redirect("/choose-username?error=username_taken");

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await db.execute(
      "INSERT INTO users (nombre, contraseña, correo, google_token, is_admin) VALUES (?, ?, ?, ?, 0)",
      [userName, passwordHash, req.session.googleEmail, JSON.stringify(req.session.googleToken)]
    );

    delete req.session.googleEmail;
    delete req.session.googleToken;
    req.session.userName = userName;
    req.session.isAdmin = false; // nace sin admin en este flujo
    res.redirect("/rooms-form");
  } catch (err) {
    console.error("Error creando usuario:", err);
    res.redirect("/choose-username?error=server");
  }
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.redirect("/");
  });
});

module.exports = router;
