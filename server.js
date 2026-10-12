"use strict";
// Snake World - Online Server (Node.js + WebSocket)
// Godot गेम इससे wss:// पर जुड़ेगा। यह हर सांप की चाल खुद तय करता है (server-authoritative)।
//
// Godot -> Server: {"t":"join","name":"Hello"}   खेल में आना
//                  {"t":"in","a":1.57}           जॉयस्टिक की दिशा (radian)
//                  {"t":"revive"}                विज्ञापन देखकर दोबारा जीवित होना
// Server -> Godot: {"t":"welcome","id":1,...}    जुड़ने या Revive होने पर
//                  {"t":"s", ...}                हर सेकंड 20 बार: आसपास का नज़ारा
//                  {"t":"dead","reason":"...","score":12}   मरने पर
//                  {"t":"revive_fail"}           Revive नहीं हो सका
//                  {"t":"full"}                  सर्वर भरा हो तो
const http = require("http");
const { WebSocketServer } = require("ws");
const { Game, C, FRUIT_TYPES } = require("./game");

const PORT = process.env.PORT || 8080;
const MAX_PLAYERS = 25;
const SEND_EVERY = 3;            // 60 / 3 = 20 बार प्रति सेकंड संदेश भेजना
const REVIVE_WINDOW_MS = 120000; // मरने के बाद इतनी देर तक Revive हो सकता है

const game = new Game();

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  if (req.url === "/health") {
    res.end("ok\n");
    return;
  }
  res.end("Snake World server chal raha hai. Players: " + game.players.size + "\n");
});

const wss = new WebSocketServer({ server: server, maxPayload: 1024 });

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function sendWelcome(ws, p) {
  send(ws, {
    t: "welcome",
    id: p.id,
    world: C.WORLD,
    speed: C.SNAKE_SPEED,
    boost_mult: C.BOOST_MULT,
    fruit_types: FRUIT_TYPES,
  });
}

game.onDeath = function (p, reason, killer) {
  send(p.ws, { t: "dead", reason: reason, score: p.score, by: killer ? killer.name : "" });
  if (p.ws) {
    // Revive के लिए मरते समय की जानकारी सँभालकर रखो
    p.ws.lastDeath = { name: p.name, col: p.col, score: p.score, len: p.body.length, at: Date.now(), used: false };
    p.ws.player = null;
  }
};

wss.on("connection", function (ws) {
  ws.player = null;
  ws.lastDeath = null;
  ws.isAlive = true;
  ws.on("pong", function () { ws.isAlive = true; });

  ws.on("message", function (data) {
    let m;
    try { m = JSON.parse(data.toString()); } catch (e) { return; }
    if (!m || typeof m.t !== "string") return;

    if (m.t === "join") {
      if (ws.player) return;
      if (game.players.size >= MAX_PLAYERS) { send(ws, { t: "full" }); return; }
      ws.lastDeath = null;
      const p = game.addPlayer(m.name);
      p.ws = ws;
      ws.player = p;
      sendWelcome(ws, p);
    } else if (m.t === "in") {
      if (ws.player) game.setTarget(ws.player, m.a);
    } else if (m.t === "revive") {
      if (ws.player) return;
      const d = ws.lastDeath;
      if (!d || d.used || Date.now() - d.at > REVIVE_WINDOW_MS || game.players.size >= MAX_PLAYERS) {
        send(ws, { t: "revive_fail" });
        return;
      }
      d.used = true; // एक मौत पर एक ही Revive
      const p = game.revivePlayer(d);
      p.ws = ws;
      ws.player = p;
      sendWelcome(ws, p);
    }
  });

  ws.on("close", function () {
    if (ws.player) game.removePlayer(ws.player);
    ws.player = null;
  });
  ws.on("error", function () {});
});

// जो खिलाड़ी जवाब न दें (कनेक्शन टूट गया हो) उन्हें हटाना
// समय ज़्यादा रखा है ताकि विज्ञापन देखते समय कनेक्शन न कटे
setInterval(function () {
  wss.clients.forEach(function (ws) {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 90000);

function broadcast() {
  for (const p of game.players.values()) {
    if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(game.snapshotFor(p)));
  }
}

// एक जैसी चाल: असली समय के हिसाब से ठीक 60 tick प्रति सेकंड चलाना
const STEP_MS = 1000 / C.TICK_RATE;
let last = Date.now();
let acc = 0;
setInterval(function () {
  const now = Date.now();
  acc += Math.min(now - last, 250);
  last = now;
  let n = 0;
  while (acc >= STEP_MS && n < 10) {
    game.tick();
    acc -= STEP_MS;
    n++;
    if (game.tickCount % SEND_EVERY === 0) broadcast();
  }
}, 8);

server.listen(PORT, function () {
  console.log("Snake server port " + PORT + " par chal raha hai");
});

// ---- अपने आप जागता रहे (Render का Free server 15 मिनट शांत रहे तो सो जाता है) ----
// Render अपना Link RENDER_EXTERNAL_URL में अपने आप दे देता है। Server हर 5 मिनट में
// खुद को /health पर एक छोटा संदेश भेजता है, इसलिए कभी सोता नहीं। आपको कुछ नहीं करना।
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
if (SELF_URL) {
  setInterval(function () {
    fetch(SELF_URL + "/health").catch(function () {});
  }, 5 * 60 * 1000);
  console.log("Self keep-alive chalu: " + SELF_URL);
  }
