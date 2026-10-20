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

const authMiddleware = (req, res, next) => {
  const userName = req.session?.userName;

  const isPublic = allowedPaths.includes(req.path);

  if (!userName && !isPublic) return res.redirect("/");

  if (userName) {
    req.isAdmin = !!req.session.isAdmin;
    req.userName = userName;
  }
  next();
};

module.exports = { authMiddleware };
