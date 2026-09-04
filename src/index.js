const dns = require("node:dns");
dns.setServers(["8.8.8.8", "1.1.1.1"]);
require("dotenv").config();
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { MongoClient } = require("mongodb");

const port = Number(process.env.PORT) || 3000;
const publicDirectory = path.join(__dirname, "..", "public");
const publicFiles = { "/styles.css": ["styles.css", "text/css; charset=utf-8"], "/assets/image.png": ["assets/image.png", "image/png"] };
const pageRoutes = { "/": "index.html", "/events": "events.html", "/faculty": "faculty.html", "/exams": "exams.html", "/courses": "courses.html", "/fees": "fees.html", "/placements": "placements.html", "/login": "login.html", "/signup": "signup.html", "/ai-assistant": "ai-assistant.html" };

// --- MongoDB ---
const mongoClient = new MongoClient(process.env.MONGO_URI);
let usersCollection;
let sessionsCollection;

async function connectMongo() {
  await mongoClient.connect();
  const db = mongoClient.db();
  usersCollection = db.collection("users");
  sessionsCollection = db.collection("sessions");
  await usersCollection.createIndex({ email: 1 }, { unique: true });
  await sessionsCollection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // auto-cleans expired sessions
  console.log("MongoDB connected");
}

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  response.end(JSON.stringify(body));
}

async function sendFile(response, name, type) {
  try {
    response.writeHead(200, { "Content-Type": type, "X-Content-Type-Options": "nosniff" });
    response.end(await fs.readFile(path.join(publicDirectory, name)));
  } catch {
    sendJson(response, 404, { error: "File not found." });
  }
}

function cookies(request) {
  return Object.fromEntries((request.headers.cookie || "").split(";").map((item) => {
    const [key, ...value] = item.trim().split("=");
    return [key, decodeURIComponent(value.join("="))];
  }).filter(([key]) => key));
}

function body(request) {
  return new Promise((resolve, reject) => {
    let data = "";
    request.on("data", (chunk) => {
      data += chunk;
      if (Buffer.byteLength(data) > 16_000) reject(new Error("Request too large."));
    });
    request.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); } catch { reject(new Error("Invalid request data.")); }
    });
    request.on("error", reject);
  });
}

function hash(password, salt = crypto.randomBytes(16).toString("hex")) {
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString("hex")}`;
}

function matches(password, stored) {
  const [salt, value] = stored.split(":");
  const attempt = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(value, "hex"), Buffer.from(attempt, "hex"));
}

function safeUser(user) { return { id: user.id, name: user.name, email: user.email }; }
function isValidEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }

async function createSession(userId) {
  const id = crypto.randomBytes(32).toString("hex");
  await sessionsCollection.insertOne({ id, userId, expiresAt: new Date(Date.now() + 86_400_000) });
  return id;
}

function sessionCookie(id) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `sessionId=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400${secure}`;
}

async function currentUser(request) {
  const sessionId = cookies(request).sessionId || "";
  if (!sessionId) return null;
  const session = await sessionsCollection.findOne({ id: sessionId, expiresAt: { $gte: new Date() } });
  if (!session) return null;
  return (await usersCollection.findOne({ id: session.userId })) || null;
}

async function api(request, response, pathname) {
  if (pathname === "/api/auth/signup" && request.method === "POST") {
    const { name = "", email = "", password = "" } = await body(request);
    const cleanName = name.trim();
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanName || !isValidEmail(cleanEmail) || password.length < 8) return sendJson(response, 400, { error: "Enter a name, valid email, and password of at least 8 characters." });
    const user = { id: crypto.randomUUID(), name: cleanName, email: cleanEmail, passwordHash: hash(password), createdAt: new Date().toISOString() };
    try {
      await usersCollection.insertOne(user);
    } catch (error) {
      if (error.code === 11000) return sendJson(response, 409, { error: "An account already exists for this email." });
      throw error;
    }
    return sendJson(response, 201, { user: safeUser(user) }, { "Set-Cookie": sessionCookie(await createSession(user.id)) });
  }

  if (pathname === "/api/auth/login" && request.method === "POST") {
    const { email = "", password = "" } = await body(request);
    const user = await usersCollection.findOne({ email: email.trim().toLowerCase() });
    if (!user || !password || !matches(password, user.passwordHash)) return sendJson(response, 401, { error: "Incorrect email address or password." });
    return sendJson(response, 200, { user: safeUser(user) }, { "Set-Cookie": sessionCookie(await createSession(user.id)) });
  }

  if (pathname === "/api/auth/me" && request.method === "GET") {
    const user = await currentUser(request);
    return user ? sendJson(response, 200, { user: safeUser(user) }) : sendJson(response, 401, { error: "Not logged in." });
  }

  if (pathname === "/api/auth/logout" && request.method === "POST") {
    await sessionsCollection.deleteOne({ id: cookies(request).sessionId || "" });
    return sendJson(response, 200, { message: "Logged out." }, { "Set-Cookie": "sessionId=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" });
  }

  return sendJson(response, 404, { error: "API route not found." });
}

http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    const pathname = url.pathname;
    if (pathname.startsWith("/api/")) return await api(request, response, pathname);
    if (pathname === "/health") return sendJson(response, 200, { status: "ok" });
    if (pathname === "/ai-assistant" && !(await currentUser(request))) {
      response.writeHead(302, { Location: "/login?next=%2Fai-assistant", "Cache-Control": "no-store" });
      return response.end();
    }
    if (pageRoutes[pathname]) return await sendFile(response, pageRoutes[pathname], "text/html; charset=utf-8");
    if (publicFiles[pathname]) return await sendFile(response, ...publicFiles[pathname]);
    return sendJson(response, 404, { error: "Not found." });
  } catch (error) {
    console.error(error);
    return sendJson(response, 500, { error: "Something went wrong. Please try again." });
  }
}).listen(port, async () => {
  try {
    await connectMongo();
  } catch (error) {
    console.error("MongoDB connection failed; the site will run, but login and signup are unavailable.", error.message);
  }
  console.log(`Server listening at http://localhost:${port}`);
});
