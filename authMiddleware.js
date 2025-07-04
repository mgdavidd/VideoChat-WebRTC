// authMiddleware.js
const db = require("./db");

const allowedPaths = [
  "/",
  "/signup",
  "/login",
  "/join",
  "/fechas",
  "/auth/google",
  "/auth/google/callback",
  "/choose-username",
  "/google0fa380567cbd463e.html",
  "/privacidad",
];

const authMiddleware = async (req, res, next) => {
  if (!req.cookies.userName && !allowedPaths.includes(req.path)) {
    return res.redirect("/");
  }

  if (req.cookies.userName) {
    try {
      const result = await db.execute(
        "SELECT is_admin FROM users WHERE nombre = ?",
        [req.cookies.userName]
      );
      req.isAdmin = result.rows[0]?.is_admin === 1;
    } catch (err) {
      console.error("Error verificando admin:", err);
      return res.status(500).send("Error interno");
    }
  }
  next();
};

module.exports = { authMiddleware };
