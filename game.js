"use strict";
// Snake World - खेल का दिमाग (Server पर चलता है)
// नंबर Godot वाले गेम से बिल्कुल एक जैसे हैं, ताकि हर जगह चाल एक जैसी रहे।
const C = {
  WORLD: 6000,          // नक्शा बहुत बड़ा (पहले 2400)
  HEAD_R: 17,
  TAIL_R: 7,
  SEG_DIST: 14,
  START_LEN: 14,
  FOOD_R: 16,
  TURN_RATE: 0.13,
  SNAKE_SPEED: 4.0,     // सबकी एक जैसी रफ़्तार (Godot में SNAKE_SPEED)
  BOOST_MULT: 1.6,      // Bolt खाने पर गुणा (Godot में BOOST_MULT)
  BOOST_TIME: 4.0,      // Boost कितने सेकंड (Godot में BOOST_TIME)
  BOLT_CHANCE: 0.07,    // कितने फल Bolt होंगे (Godot में BOLT_CHANCE)
  TICK_RATE: 60,        // सर्वर हर सेकंड 60 बार चलता है
  FRUIT_COUNT: 700,     // बड़े नक्शे के लिए ज़्यादा फल (पहले 120)
  MAX_FRUITS: 1200,     // (पहले 300)
  MAX_LEN: 400,         // सांप की अधिकतम लंबाई (डेटा कम रखने के लिए)
  KILL_BONUS: 3,
  BODY_HIT: 24,         // दूसरे सांप के शरीर से टकराने की दूरी
  SELF_HIT_KILLS: false, // false = ONLINE में सांप खुद से टकराए तो नहीं मरता; true करने पर मरेगा
  REVIVE_INVULN: 150,   // Revive के बाद करीब 2.5 सेकंड कोई नहीं मार सकता
};

// फल: नाम की जगह नंबर भेजते हैं (डेटा कम रहे)। क्रम Godot की FRUITS सूची जैसा
const FRUIT_TYPES = ["apple", "orange", "strawberry", "cherry", "banana", "grapes", "mango", "watermelon", "bolt"];
const FRUIT_INFO = [[1, 2], [1, 2], [1, 2], [1, 2], [2, 3], [2, 3], [2, 3], [3, 5], [1, 1]]; // [अंक, बढ़ना]
const BOLT = 8;
const NORMAL_COUNT = 8;
const BOOST_TICKS = C.BOOST_TIME * C.TICK_RATE;
const COLOR_COUNT = 8;
const VIEW = 520; // खिलाड़ी के आसपास इतनी दूरी तक की चीज़ें भेजी जाती हैं

function angleDiff(from, to) {
  // Godot के angle_difference जैसा: सबसे छोटा घुमाव (-PI से PI)
  const d = (to - from) % (Math.PI * 2);
  return ((d + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
}

function rnd(a, b) {
  return a + Math.random() * (b - a);
}

class Game {
  constructor() {
    this.players = new Map();
    this.fruits = [];
    this.nextId = 1;
    this.colorIdx = 0;
    this.tickCount = 0;
    this.onDeath = null; // function(player, reason, killer)
    for (let i = 0; i < C.FRUIT_COUNT; i++) this.fruits.push(this.newFruit());
  }

  newFruit() {
    const t = Math.random() < C.BOLT_CHANCE ? BOLT : Math.floor(Math.random() * NORMAL_COUNT);
    return { x: rnd(60, C.WORLD - 60), y: rnd(60, C.WORLD - 60), t: t, temp: false };
  }

  addPlayer(name) {
    let x = C.WORLD / 2;
    let y = C.WORLD / 2;
    for (let k = 0; k < 20; k++) {
      x = rnd(300, C.WORLD - 300);
      y = rnd(300, C.WORLD - 300);
      let ok = true;
      for (const o of this.players.values()) {
        const h = o.body[0];
        if ((h.x - x) ** 2 + (h.y - y) ** 2 < 500 * 500) { ok = false; break; }
      }
      if (ok) break;
    }
    const angle = rnd(0, Math.PI * 2);
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const body = [];
    for (let i = 0; i < C.START_LEN; i++) body.push({ x: x - dx * i * C.SEG_DIST, y: y - dy * i * C.SEG_DIST });
    const p = {
      id: this.nextId++,
      name: String(name || "Player").replace(/[^\p{L}\p{N} _.-]/gu, "").slice(0, 12) || "Player",
      col: this.colorIdx++ % COLOR_COUNT,
      body: body,
      angle: angle,
      target: angle,
      boost: 0,
      score: 0,
      invuln: 0,
      alive: true,
      ws: null,
    };
    this.players.set(p.id, p);
    return p;
  }

  // मरने के बाद विज्ञापन देखकर वापसी: वही नाम, रंग, स्कोर और लंबाई, नई सुरक्षित जगह पर
  revivePlayer(info) {
    const p = this.addPlayer(info.name);
    if (typeof info.col === "number") p.col = info.col;
    p.score = info.score | 0;
    const want = Math.min(C.MAX_LEN, Math.max(C.START_LEN, info.len | 0));
    const tail = p.body[p.body.length - 1];
    while (p.body.length < want) p.body.push({ x: tail.x, y: tail.y });
    p.invuln = C.REVIVE_INVULN;
    return p;
  }

  removePlayer(p) {
    this.players.delete(p.id);
  }

  setTarget(p, a) {
    if (typeof a === "number" && isFinite(a)) p.target = a;
  }

  // ---- एक tick (1/60 सेकंड) ----
  tick() {
    this.tickCount++;
    const list = [];
    for (const p of this.players.values()) if (p.alive) list.push(p);
    const dying = new Map(); // player -> {reason, killer}

    // 1) चलना (सबकी रफ़्तार एक जैसी, Boost में 1.6 गुना)
    for (const p of list) {
      if (p.invuln > 0) p.invuln--;
      p.angle += Math.max(-C.TURN_RATE, Math.min(C.TURN_RATE, angleDiff(p.angle, p.target)));
      const mult = p.boost > 0 ? C.BOOST_MULT : 1.0;
      if (p.boost > 0) p.boost--;
      const sp = C.SNAKE_SPEED * mult;
      const b = p.body;
      b[0].x += Math.cos(p.angle) * sp;
      b[0].y += Math.sin(p.angle) * sp;
      for (let i = 1; i < b.length; i++) {
        const dx = b[i - 1].x - b[i].x;
        const dy = b[i - 1].y - b[i].y;
        const dist = Math.hypot(dx, dy);
        if (dist > C.SEG_DIST) {
          const k = (dist - C.SEG_DIST) / dist;
          b[i].x += dx * k;
          b[i].y += dy * k;
        }
      }
      const h = b[0];
      if (h.x < C.HEAD_R || h.x > C.WORLD - C.HEAD_R || h.y < C.HEAD_R || h.y > C.WORLD - C.HEAD_R) {
        dying.set(p, { reason: "Wall se takra gaye!", killer: null });
      }
    }

    // 2) फल खाना
    for (const p of list) {
      if (dying.has(p)) continue;
      const h = p.body[0];
      const lim = (C.HEAD_R + C.FOOD_R) ** 2;
      for (let idx = 0; idx < this.fruits.length; idx++) {
        const f = this.fruits[idx];
        const dx = h.x - f.x;
        const dy = h.y - f.y;
        if (dx * dx + dy * dy < lim) {
          const info = FRUIT_INFO[f.t];
          p.score += info[0];
          if (p.body.length < C.MAX_LEN) {
            const tail = p.body[p.body.length - 1];
            for (let k = 0; k < info[1]; k++) p.body.push({ x: tail.x, y: tail.y });
          }
          if (f.t === BOLT) p.boost = BOOST_TICKS;
          if (f.temp) this.fruits.splice(idx, 1);
          else this.fruits[idx] = this.newFruit();
          break;
        }
      }
    }

    // 3) टकराव (सब चलने के बाद जाँचते हैं, ताकि सबके साथ बराबरी हो)
    for (const p of list) {
      if (dying.has(p)) continue;
      if (p.invuln > 0) continue; // Revive के बाद कुछ पल सुरक्षित
      const h = p.body[0];

      // खुद से टकराना (SELF_HIT_KILLS false हो तो जाँच ही नहीं होती)
      if (C.SELF_HIT_KILLS) {
        for (let i = 10; i < p.body.length; i++) {
          const dx = h.x - p.body[i].x;
          const dy = h.y - p.body[i].y;
          if (dx * dx + dy * dy < (C.HEAD_R * 0.8) ** 2) {
            dying.set(p, { reason: "Khud se takra gaye!", killer: null });
            break;
          }
        }
        if (dying.has(p)) continue;
      }

      const lim = C.BODY_HIT * C.BODY_HIT;
      for (const q of list) {
        if (q === p) continue;
        if (q.invuln > 0) continue; // सुरक्षित सांप के शरीर से कोई नहीं मरता
        const reach = q.body.length * C.SEG_DIST + 60;
        const qh = q.body[0];
        if (Math.abs(qh.x - h.x) > reach || Math.abs(qh.y - h.y) > reach) continue;
        let hit = false;
        for (let i = 0; i < q.body.length; i++) {
          const dx = h.x - q.body[i].x;
          const dy = h.y - q.body[i].y;
          if (dx * dx + dy * dy < lim) { hit = true; break; }
        }
        if (hit) {
          dying.set(p, { reason: "Dusre saanp se takra gaye!", killer: q });
          break;
        }
      }
    }

    // 4) मरने वालों को हटाना: शरीर से फल गिरते हैं, मारने वाले को बोनस
    for (const [p, info] of dying) {
      if (info.killer && info.killer.alive && !dying.has(info.killer)) info.killer.score += C.KILL_BONUS;
      this.kill(p, info.reason, info.killer);
    }
  }

  kill(p, reason, killer) {
    p.alive = false;
    for (let i = 0; i < p.body.length; i += 3) {
      if (this.fruits.length >= C.MAX_FRUITS) break;
      this.fruits.push({
        x: p.body[i].x,
        y: p.body[i].y,
        t: Math.floor(Math.random() * NORMAL_COUNT),
        temp: true,
      });
    }
    this.players.delete(p.id);
    if (this.onDeath) this.onDeath(p, reason, killer);
  }

  // ---- हर खिलाड़ी को भेजने वाला संदेश (सिर्फ़ उसके आसपास का हिस्सा) ----
  snapshotFor(p) {
    const h = p.body[0];
    const ps = [];
    for (const q of this.players.values()) {
      let near = false;
      for (let i = 0; i < q.body.length; i += 2) {
        if (Math.abs(q.body[i].x - h.x) < VIEW && Math.abs(q.body[i].y - h.y) < VIEW) { near = true; break; }
      }
      if (!near) continue;
      const flat = new Array(q.body.length * 2);
      for (let i = 0; i < q.body.length; i++) {
        flat[i * 2] = Math.round(q.body[i].x);
        flat[i * 2 + 1] = Math.round(q.body[i].y);
      }
      ps.push({ i: q.id, c: q.col, n: q.name, b: q.boost > 0 ? 1 : 0, a: Math.round(q.angle * 100) / 100, p: flat });
    }
    const f = [];
    for (const fr of this.fruits) {
      if (Math.abs(fr.x - h.x) < VIEW && Math.abs(fr.y - h.y) < VIEW) f.push([Math.round(fr.x), Math.round(fr.y), fr.t]);
    }
    const lb = [...this.players.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((q) => [q.name, q.score]);
    return {
      t: "s",
      tk: this.tickCount,
      you: { id: p.id, score: p.score, boost: Math.round((p.boost / C.TICK_RATE) * 10) / 10, len: p.body.length },
      ps: ps,
      f: f,
      lb: lb,
    };
  }
}

module.exports = { Game, C, FRUIT_TYPES };
                                              
