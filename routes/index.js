const express = require("express");
const router = express.Router();

router.use("/", require("./auth"));
router.use("/", require("./rooms"));
router.use("/", require("./calendar"));
router.use("/", require("./recording"));
router.use("/", require("./generateRooms"));

module.exports = router;

