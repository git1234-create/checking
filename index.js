
const express = require("express");
const WebSocket = require("ws");

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Petrolimex price checker is running!");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/prices", async (req, res) => {
  res.status(501).json({
    status: "not_ready",
    message: "WebSocket connection is not configured yet."
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
