const dns = require("node:dns");
dns.setServers(["8.8.8.8", "1.1.1.1"]);
require("dotenv").config();
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { MongoClient } = require("mongodb");
const { answerQuestion } = require("./ai-service");

const port = Number(process.env.PORT) || 3000;
const publicDirectory = path.join(__dirname, "..", "public");
const publicFiles = {
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
  "/app.js": ["app.js", "application/javascript; charset=utf-8"],
  "/assets/image.png": ["assets/image.png", "image/png"]
};

const pageRoutes = {
  "/": "index.html",
  "/events": "events.html",
  "/faculty": "faculty.html",
  "/exams": "exams.html",
  "/courses": "courses.html",
  "/fees": "fees.html",
  "/placements": "placements.html",
  "/feedback": "feedback.html",
  "/infrastructure": "infrastructure.html",
  "/downloads": "downloads.html",
  "/login": "login.html",
  "/signup": "signup.html",
  "/apply": "apply.html",
  "/admin": "admin-login.html",
  "/admin/register": "admin-register.html",
  "/admin/dashboard": "admin-dashboard.html",
  "/admin/users": "admin-users.html",
  "/ai-assistant": "ai-assistant.html"
};

// --- MongoDB ---
const mongoClient = new MongoClient(process.env.MONGO_URI || "mongodb://localhost:27017/campusconnect");
let usersCollection;
let sessionsCollection;
let applicationsCollection;
let adminsCollection;
let feedbackCollection;

async function connectMongo() {
  await mongoClient.connect();
  const db = mongoClient.db();
  usersCollection = db.collection("users");
  sessionsCollection = db.collection("sessions");
  applicationsCollection = db.collection("applications");
  adminsCollection = db.collection("admins");
  feedbackCollection = db.collection("feedback");
  await usersCollection.createIndex({ email: 1 }, { unique: true });
  await sessionsCollection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await applicationsCollection.createIndex({ createdAt: -1 });
  await adminsCollection.createIndex({ email: 1 }, { unique: true });
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

function adminSessionCookie(id) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `adminSessionId=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure}`;
}

function sameSecret(input, expected) {
  const inputBuffer = Buffer.from(input);
  const expectedBuffer = Buffer.from(expected);
  return inputBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(inputBuffer, expectedBuffer);
}

async function currentUser(request) {
  const sessionId = cookies(request).sessionId || "";
  if (!sessionId) return null;
  const session = await sessionsCollection.findOne({ id: sessionId, expiresAt: { $gte: new Date() } });
  if (!session) return null;
  return (await usersCollection.findOne({ id: session.userId })) || null;
}

async function currentAdmin(request) {
  const sessionId = cookies(request).adminSessionId || "";
  if (!sessionId) return false;
  const session = await sessionsCollection.findOne({ id: sessionId, role: "admin", expiresAt: { $gte: new Date() } });
  return Boolean(session);
}

async function api(request, response, pathname) {
  if (pathname === "/api/feedback" && request.method === "POST") {
    const { name = "", profession = "", feedback = "" } = await body(request);
    const cleanName = name.trim() || "Anonymous";
    const cleanProf = profession.trim() || "Student";
    const cleanFeedback = feedback.trim();
    if (!cleanFeedback) return sendJson(response, 400, { error: "Please enter your feedback or college information." });

    const entry = { id: crypto.randomUUID(), name: cleanName, profession: cleanProf, feedback: cleanFeedback, createdAt: new Date().toISOString() };
    if (feedbackCollection) {
      await feedbackCollection.insertOne(entry);
    }
    console.log(`[FEEDBACK RECEIVED] From: ${cleanName} (${cleanProf}) - Feedback: ${cleanFeedback}`);
    return sendJson(response, 201, { message: "Thank you for your contribution!" });
  }

  if (pathname === "/api/ai/chat" && request.method === "POST") {
    if (!(await currentUser(request))) return sendJson(response, 401, { error: "Please log in to use Campus AI." });
    const result = await answerQuestion((await body(request)).question);
    return result.error ? sendJson(response, result.status, { error: result.error }) : sendJson(response, 200, { answer: result.answer, sources: result.sources });
  }

  if (pathname === "/api/admin/register" && request.method === "POST") {
    const { email = "", password = "", credentialId = "" } = await body(request);
    const registrationId = process.env.ADMIN_REGISTRATION_ID || "";
    const cleanEmail = email.trim().toLowerCase();
    if (!registrationId) return sendJson(response, 503, { error: "Admin registration has not been configured." });
    if (!sameSecret(credentialId, registrationId)) return sendJson(response, 401, { error: "The administrator credential ID is not valid." });
    if (!isValidEmail(cleanEmail) || password.length < 12) return sendJson(response, 400, { error: "Enter a valid email and a password of at least 12 characters." });
    try { await adminsCollection.insertOne({ id: crypto.randomUUID(), email: cleanEmail, passwordHash: hash(password), createdAt: new Date().toISOString() }); }
    catch (error) { if (error.code === 11000) return sendJson(response, 409, { error: "An administrator account already exists for this email." }); throw error; }
    return sendJson(response, 201, { message: "Administrator account created. You can now sign in." });
  }

  if (pathname === "/api/admin/login" && request.method === "POST") {
    const { email = "", password = "", credentialId = "" } = await body(request);
    const registrationId = process.env.ADMIN_REGISTRATION_ID || "";
    if (!registrationId) return sendJson(response, 503, { error: "Admin login has not been configured." });
    const admin = await adminsCollection.findOne({ email: email.trim().toLowerCase() });
    if (!sameSecret(credentialId, registrationId) || !admin || !password || !matches(password, admin.passwordHash)) return sendJson(response, 401, { error: "Incorrect email, password, or credential ID." });
    const id = crypto.randomBytes(32).toString("hex");
    await sessionsCollection.insertOne({ id, role: "admin", adminId: admin.id, expiresAt: new Date(Date.now() + 28_800_000) });
    return sendJson(response, 200, { message: "Admin login successful." }, { "Set-Cookie": adminSessionCookie(id) });
  }

  if (pathname === "/api/admin/applications" && request.method === "GET") {
    if (!(await currentAdmin(request))) return sendJson(response, 401, { error: "Administrator login required." });
    const applications = await applicationsCollection.find({}, { projection: { _id: 0 } }).sort({ createdAt: -1 }).toArray();
    return sendJson(response, 200, { applications });
  }

  if (pathname === "/api/admin/users" && request.method === "GET") {
    if (!(await currentAdmin(request))) return sendJson(response, 401, { error: "Administrator login required." });
    const users = await usersCollection.find({}, { projection: { _id: 0, id: 1, name: 1, email: 1, createdAt: 1 } }).sort({ createdAt: -1 }).toArray();
    return sendJson(response, 200, { users });
  }

  if (pathname === "/api/admin/logout" && request.method === "POST") {
    await sessionsCollection.deleteOne({ id: cookies(request).adminSessionId || "", role: "admin" });
    return sendJson(response, 200, { message: "Logged out." }, { "Set-Cookie": "adminSessionId=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });
  }

  if (pathname === "/api/applications" && request.method === "POST") {
    const { name = "", email = "", phone = "", course = "", message = "" } = await body(request);
    const application = { id: crypto.randomUUID(), name: name.trim(), email: email.trim().toLowerCase(), phone: phone.trim(), course: course.trim(), message: message.trim(), status: "submitted", createdAt: new Date().toISOString() };
    if (!application.name || !isValidEmail(application.email) || !application.phone || !application.course) {
      return sendJson(response, 400, { error: "Please enter your name, email, phone number, and preferred course." });
    }
    await applicationsCollection.insertOne(application);
    return sendJson(response, 201, { message: "Application submitted successfully.", applicationId: application.id });
  }

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

async function requestHandler(request, response) {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    const pathname = url.pathname;
    if (pathname.startsWith("/api/")) return await api(request, response, pathname);
    if (pathname === "/health") return sendJson(response, 200, { status: "ok" });
    if ((pathname === "/admin/dashboard" || pathname === "/admin/users") && !(await currentAdmin(request))) {
      response.writeHead(302, { Location: "/admin", "Cache-Control": "no-store" });
      return response.end();
    }
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
}

const server = http.createServer(requestHandler);

if (require.main === module) {
  server.listen(port, async () => {
    try {
      await connectMongo();
    } catch (error) {
      console.error("MongoDB connection failed; the site will run, but login and signup are unavailable.", error.message);
    }
    console.log(`Server listening at http://localhost:${port}`);
  });
}

module.exports = async (req, res) => {
  if (process.env.MONGO_URI && (!mongoClient.topology || !mongoClient.topology.isConnected())) {
    try {
      await connectMongo();
    } catch (error) {
      console.error("MongoDB connection failed", error.message);
    }
  }
  return requestHandler(req, res);
};
