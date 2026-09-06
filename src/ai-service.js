const fs = require("node:fs/promises");
const path = require("node:path");
const pdfParse = require("pdf-parse");

const knowledgeDirectory = path.join(__dirname, "..", "knowledge");

let cachedKnowledge = null;
let cachedWebRecords = null;
let webCacheTime = 0;
const WEB_CACHE_TTL = 3600000; // 1 hour

const answerCache = new Map();
const MAX_CACHE_SIZE = 100;

/* =========================================================
   TYPO CORRECTION ENGINE
========================================================= */

const TYPO_MAP = {
  "directer": "director",
  "direcor": "director",
  "dirctor": "director",
  "feee": "fee",
  "feess": "fees",
  "plassment": "placement",
  "plasment": "placement",
  "placementss": "placements",
  "facutly": "faculty",
  "faclty": "faculty",
  "profeser": "professor",
  "professer": "professor",
  "admision": "admission",
  "addmission": "admission",
  "corse": "course",
  "corses": "courses",
  "eligiblity": "eligibility",
  "eligblity": "eligibility",
  "timtabel": "timetable",
  "scheduale": "schedule"
};

function correctTypos(text) {
  return String(text || "")
    .split(/\s+/)
    .map((word) => {
      const lower = word.toLowerCase().replace(/[^a-z0-9]/g, "");
      return TYPO_MAP[lower] || word;
    })
    .join(" ");
}

/* =========================================================
   TEXT HELPERS & TOKENIZATION
========================================================= */

function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeForSearch(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[-_/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP_WORDS = new Set([
  "a", "an", "the", "in", "on", "at", "to", "for", "of", "with", "by", "from",
  "up", "about", "into", "over", "after", "is", "are", "was", "were", "be",
  "been", "being", "have", "has", "had", "do", "does", "did", "can", "could",
  "should", "would", "will", "shall", "may", "might", "must", "me", "my",
  "you", "your", "he", "him", "his", "she", "her", "it", "its", "we", "us",
  "our", "they", "them", "their", "what", "which", "who", "whom", "this",
  "that", "these", "those", "am", "give", "tell", "show", "please", "know",
  "find", "information", "detail", "details", "vsics", "kanpur", "college", "institute",
  "get", "got", "list", "name", "names", "say", "how", "when", "where", "can", "i", "my"
]);

const PLURAL_STEMS = {
  "courses": "course",
  "programs": "program",
  "degrees": "degree",
  "fees": "fee",
  "costs": "cost",
  "charges": "charge",
  "teachers": "teacher",
  "professors": "professor",
  "faculties": "faculty",
  "placements": "placement",
  "jobs": "job",
  "companies": "company",
  "recruiters": "recruiter",
  "students": "student",
  "toppers": "topper",
  "ranks": "rank",
  "subjects": "subject",
  "exams": "exam",
  "examinations": "exam",
  "schedules": "schedule",
  "dates": "date",
  "hods": "hod",
  "directors": "director",
  "principals": "principal",
  "numbers": "number",
  "emails": "email",
  "phones": "phone",
  "addresses": "address"
};

function tokenize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((term) => term.length > 1)
    .map((term) => PLURAL_STEMS[term] || term);
}

const ALIAS_MAP = {
  "bca": ["bca", "bachelor of computer applications", "bachelor computer application"],
  "mca": ["mca", "master of computer applications", "master computer application"],
  "bba": ["bba", "bachelor of business administration", "bachelor business administration"],
  "mba": ["mba", "master of business administration", "master business administration"],
  "fee": ["fee", "fees", "tuition", "cost", "charge", "amount", "structure", "dues", "payment", "pay", "paying"],
  "fees": ["fee", "fees", "tuition", "cost", "charge", "amount", "structure", "dues", "payment", "pay", "paying"],
  "pay": ["pay", "paying", "payment", "fee", "fees", "tuition", "amount", "time_to_pay", "bank", "account"],
  "payment": ["pay", "paying", "payment", "fee", "fees", "tuition", "amount", "time_to_pay", "bank", "account"],
  "hod": ["hod", "head of department", "department head", "head", "faculty", "professor", "teacher", "director", "incharge", "coordinator"],
  "head": ["hod", "head of department", "department head", "head", "faculty", "professor", "teacher", "director", "incharge", "coordinator"],
  "first year": ["first year", "1st year", "bca 1st year", "bca first year", "first sem", "1st sem"],
  "bca first year": ["bca first year", "bca 1st year", "bca 1", "bca i", "first year bca"],
  "placement": ["placement", "placements", "job", "recruitment", "recruiter", "company", "package", "salary", "placed", "training"],
  "placements": ["placement", "placements", "job", "recruitment", "recruiter", "company", "package", "salary", "placed", "training"],
  "training": ["training", "placement", "career", "development", "personality", "workshop", "skills"],
  "director": ["director", "executive director", "head", "leadership", "principal"],
  "faculty": ["faculty", "teacher", "professor", "staff", "lecturer", "instructor", "hod"],
  "contact": ["contact", "phone", "email", "address", "mobile", "call", "location", "located"],
  "admission": ["admission", "admissions", "apply", "application", "eligibility", "intake", "seat", "seats"],
  "exam": ["exam", "exams", "examination", "semester", "schedule", "timetable", "datesheet"],
  "exams": ["exam", "exams", "examination", "semester", "schedule", "timetable", "datesheet"]
};

function expandTerms(question) {
  const corrected = correctTypos(question);
  const terms = new Set(tokenize(corrected));
  const lowerQ = corrected.toLowerCase();

  for (const [key, values] of Object.entries(ALIAS_MAP)) {
    if (lowerQ.includes(key)) {
      for (const val of values) {
        tokenize(val).forEach((t) => terms.add(t));
      }
    }
  }

  return terms;
}

/* =========================================================
   JSON RECORD PROCESSING
========================================================= */

function processJsonObject(data, source = "knowledge-base.json") {
  const records = [];
  if (!data || typeof data !== "object") return records;

  // 1. College Details
  if (data.college) {
    const c = data.college;
    if (c.name || c.vision || c.mission) {
      records.push({
        source,
        section: "college",
        content: `College Overview: ${c.name || ""} (${c.short_name || ""}). Established: ${c.established || ""}. Foundation: ${c.parent_foundation || ""}. Certification: ${c.certification || ""}. AICTE ID: ${c.aicte_permanent_id || ""}. Vision: ${c.vision || ""} Mission: ${c.mission || ""}`
      });
    }
    if (c.contact) {
      const phones = Array.isArray(c.contact.phone) ? c.contact.phone.join(", ") : c.contact.phone || "";
      const mobiles = Array.isArray(c.contact.mobile) ? c.contact.mobile.join(", ") : c.contact.mobile || "";
      const emails = Array.isArray(c.contact.email) ? c.contact.email.join(", ") : c.contact.email || "";
      records.push({
        source,
        section: "contact",
        content: `VSICS Contact & Location Details: Address: ${c.contact.address || ""} | Phone: ${phones} | Mobile: ${mobiles} | Email: ${emails} | Website: ${c.contact.website || ""}`
      });
    }
  }

  // 2. Leadership
  if (Array.isArray(data.leadership)) {
    data.leadership.forEach((item) => {
      records.push({
        source,
        section: "leadership",
        content: `Leadership & Management: Name: ${item.name} | Designation: ${item.designation} | Department: ${item.department || "Executive"} | Qualification: ${item.qualification || ""} | Tenure: ${item.tenure || ""}`
      });
    });
  }

  // 3. Faculty
  if (Array.isArray(data.faculty)) {
    data.faculty.forEach((item) => {
      records.push({
        source,
        section: "faculty",
        content: `Faculty Member: Name: ${item.name} | Designation: ${item.designation || ""} | Qualification: ${item.qualification || ""} | Experience: ${item.experience || ""}`
      });
    });
  }

  // 4. Courses
  if (data.courses && typeof data.courses === "object") {
    for (const [code, details] of Object.entries(data.courses)) {
      if (typeof details === "object" && details !== null) {
        const highlights = Array.isArray(details.key_highlights) ? details.key_highlights.join("; ") : "";
        const specs = Array.isArray(details.specializations) ? details.specializations.join(", ") : "";
        records.push({
          source,
          section: "courses",
          content: `Course Details (${code} - ${details.name || code}): Degree Level: ${details.degree_level || ""} | Affiliation: ${details.affiliation || ""} | Approval: ${details.approval || ""} | Seat Intake: ${details.seat_intake || ""} seats | Description: ${details.description || ""} | Eligibility: ${details.eligibility || ""}${specs ? ` | Specializations: ${specs}` : ""}${highlights ? ` | Highlights: ${highlights}` : ""}`
        });
      }
    }
  }

  // 5. Fees & Payment Options
  if (data.fees && typeof data.fees === "object") {
    if (data.fees.payment_mode) {
      records.push({
        source,
        section: "fees",
        content: `Fee Payment Modes & Accepted Methods: ${data.fees.payment_mode}`
      });
    }

    for (const [courseCode, feeData] of Object.entries(data.fees)) {
      if (courseCode === "payment_mode") continue;

      if (typeof feeData === "object" && feeData !== null && !Array.isArray(feeData)) {
        const yearly = Array.isArray(feeData.yearly_breakdown)
          ? feeData.yearly_breakdown.map((y) => `${y.year}: ${y.annual_fee} (${y.semester_fee})`).join(" | ")
          : "";
        records.push({
          source,
          section: "fees",
          content: `Official Fee Structure for ${courseCode} (${feeData.course || courseCode}): Fee per Semester: ${feeData.fee_per_semester || ""} | Annual Breakdown: ${yearly} | Payment Mode: Online via UPI, Net Banking, and Bank Transfer only.`
        });
      } else if (Array.isArray(feeData)) {
        feeData.forEach((item) => {
          records.push({
            source,
            section: "fees",
            content: `Fee Structure & Payment Schedule (${courseCode}): Semester: ${item.semester || ""} | Fee Heads: ${item.heads || ""} | Amount: ${item.amount || ""} | Time to Pay: ${item.time_to_pay || ""}`
          });
        });
      } else if (typeof feeData === "string" || typeof feeData === "number") {
        records.push({
          source,
          section: "fees",
          content: `Fee Info (${courseCode}): ${feeData}`
        });
      }
    }
  }

  // 6. Placement & Placement Training
  if (data.placement && typeof data.placement === "object") {
    const p = data.placement;
    if (p.statistics) {
      const highest = p.statistics.highest_package ? ` Highest Package: ${p.statistics.highest_package}.` : "";
      records.push({
        source,
        section: "placements",
        content: `Placement & Career Development Support: VSICS has 27+ Years of Placement Legacy with an Average Placement Rate of 75% and 3500+ Strong Alumni Network.${highest} VSICS provides comprehensive Placement Training, Soft-Skill & Personality Development Workshops, Industrial Visits, Mock Interviews, and Corporate Placement Support across MCA, MBA, BCA, and BBA programs.`
      });
    }
    if (Array.isArray(p.top_alumni)) {
      p.top_alumni.forEach((alumnus) => {
        records.push({
          source,
          section: "placements",
          content: `Top Placed Candidate / Alumni Record: Name: ${alumnus.name} | Course: ${alumnus.course} | Designation / Role: ${alumnus.role} | Company: ${alumnus.company} | Location: ${alumnus.location} | Package Offered: ${alumnus.package}`
        });
      });
    }
    if (Array.isArray(p.companies)) {
      for (let i = 0; i < p.companies.length; i += 15) {
        const chunk = p.companies.slice(i, i + 15).join(", ");
        records.push({
          source,
          section: "placements",
          content: `VSICS Top Recruiting Companies & Placement Partners: ${chunk}`
        });
      }
    }
    if (Array.isArray(p.students)) {
      for (let i = 0; i < p.students.length; i += 10) {
        const chunk = p.students.slice(i, i + 10).map((s) => `${s.student} (${s.course}) placed at ${s.company}`).join("; ");
        records.push({
          source,
          section: "placements",
          content: `Placed Students Records: ${chunk}`
        });
      }
    }
  }

  // 7. Department Heads & HODs
  if (Array.isArray(data.department_heads)) {
    data.department_heads.forEach((item) => {
      records.push({
        source,
        section: "department_heads",
        content: `Department Head / HOD Details (${item.course || "General"} Department): HOD Designation: ${item.hod || "Head of Department (HOD)"} | Year / Semester: ${item.year || "All Years"} | Department Details: ${item.description || ""}`
      });
    });
  }

  // 8. Events & Campus Activities
  if (Array.isArray(data.events)) {
    data.events.forEach((ev) => {
      const title = ev.title || ev.category || "Campus Event";
      const cat = ev.category || "General";
      const desc = ev.description || ev.highlights || "";
      const dates = ev.dates ? ` | Date: ${ev.dates}` : "";
      const loc = ev.location ? ` | Location: ${ev.location}` : "";
      const prizes = ev.cash_prizes ? ` | Prizes: ${ev.cash_prizes}` : "";
      records.push({
        source,
        section: "events",
        content: `VSICS Campus Event (${cat}): Event Title: ${title}${dates}${loc} | Overview & Highlights: ${desc}${prizes}`
      });
    });
  }

  // Generic fallback for any other keys
  for (const [key, value] of Object.entries(data)) {
    if (["metadata", "college", "leadership", "faculty", "department_heads", "courses", "fees", "placement", "events"].includes(key)) continue;

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 5) {
        const chunk = value.slice(i, i + 5).map((item) => (typeof item === "object" ? Object.entries(item).map(([k, v]) => `${k}: ${v}`).join(" | ") : String(item))).join("\n");
        records.push({
          source,
          section: key,
          content: `${key.toUpperCase()} Info:\n${chunk}`
        });
      }
    } else if (typeof value === "object" && value !== null) {
      const str = Object.entries(value).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join(" | ");
      records.push({
        source,
        section: key,
        content: `${key.toUpperCase()}: ${str}`
      });
    }
  }

  return records;
}

/* =========================================================
   PDF CHUNKING
========================================================= */

function chunkText(text, source) {
  const words = normalizeText(text).split(" ");
  const chunkSize = 150;
  const overlap = 30;
  const chunks = [];

  for (let start = 0; start < words.length; start += chunkSize - overlap) {
    const content = words.slice(start, start + chunkSize).join(" ").trim();
    if (!content) continue;
    chunks.push({
      content,
      source,
      section: "document"
    });
  }

  return chunks;
}

/* =========================================================
   LIVE OFFICIAL WEBSITE FALLBACK (https://www.vsicskanpur.org/)
========================================================= */

async function fetchWebsiteKnowledge() {
  const now = Date.now();
  if (cachedWebRecords && (now - webCacheTime < WEB_CACHE_TTL)) {
    return cachedWebRecords;
  }

  const webRecords = [];
  const urlsToFetch = [
    "https://www.vsicskanpur.org/",
    "https://www.vsicskanpur.org/contact.php",
    "https://www.vsicskanpur.org/courses.php",
    "https://www.vsicskanpur.org/faculty.php",
    "https://www.vsicskanpur.org/placement.php"
  ];

  console.log("Searching live content from official VSICS website (https://www.vsicskanpur.org/)...");

  for (const url of urlsToFetch) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (res.ok) {
        const html = await res.text();
        const text = html
          .replace(/<script\b[^<]*>([\s\S]*?)<\/script>/gi, "")
          .replace(/<style\b[^<]*>([\s\S]*?)<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();

        if (text.length > 50) {
          const chunks = chunkText(text, url);
          webRecords.push(...chunks);
          console.log(`Fetched live site page: ${url} (${chunks.length} chunks)`);
        }
      }
    } catch (err) {
      console.warn(`Could not fetch website page ${url}: ${err.message}`);
    }
  }

  if (webRecords.length > 0) {
    cachedWebRecords = webRecords;
    webCacheTime = now;
  }

  return webRecords;
}

/* =========================================================
   BUILD KNOWLEDGE BASE
========================================================= */

async function buildKnowledgeBase() {
  let files;
  try {
    files = await fs.readdir(knowledgeDirectory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      console.warn("Knowledge directory does not exist.");
      return [];
    }
    throw error;
  }

  const records = [];

  for (const file of files.filter((entry) => entry.isFile())) {
    const extension = path.extname(file.name).toLowerCase();
    const filePath = path.join(knowledgeDirectory, file.name);

    try {
      if (extension === ".json") {
        const raw = await fs.readFile(filePath, "utf8");
        const jsonData = JSON.parse(raw);
        const jsonRecs = processJsonObject(jsonData, file.name);
        records.push(...jsonRecs);
        console.log(`Loaded JSON: ${file.name} (${jsonRecs.length} records)`);
      }

      if (extension === ".pdf") {
        const buffer = await fs.readFile(filePath);
        const parsed = await pdfParse(buffer);
        const pdfText = normalizeText(parsed.text);
        if (pdfText) {
          const pdfRecs = chunkText(pdfText, file.name);
          records.push(...pdfRecs);
          console.log(`Loaded PDF: ${file.name} (${pdfRecs.length} chunks)`);
        }
      }
    } catch (error) {
      console.warn(`Skipping unreadable knowledge file ${file.name}: ${error.message}`);
    }
  }

  console.log(`Total knowledge base records loaded: ${records.length}`);
  return records;
}

async function knowledgeBase() {
  if (!cachedKnowledge) {
    cachedKnowledge = await buildKnowledgeBase();
  }
  return cachedKnowledge;
}

/* =========================================================
   UNIFIED RETRIEVAL ENGINE
========================================================= */

function retrieve(question, records, limit = 6) {
  const correctedQuestion = correctTypos(question);
  const normQuestion = normalizeForSearch(correctedQuestion);
  const rawTokens = tokenize(correctedQuestion);
  const coreQueryTerms = rawTokens.filter((t) => t.length > 1 && !STOP_WORDS.has(t));

  const expandedQuerySet = expandTerms(correctedQuestion);
  const aliasTerms = [...expandedQuerySet].filter((t) => t.length > 1 && !STOP_WORDS.has(t) && !coreQueryTerms.includes(t));

  const courseCodes = ["bca", "mca", "bba", "mba"];
  const matchedCourse = courseCodes.find((c) => normQuestion.includes(c));

  const scored = records.map((record) => {
    const textNorm = normalizeForSearch(record.content);
    const recordTerms = new Set(tokenize(record.content));

    let score = 0;
    let coreMatches = 0;

    // 1. Primary weighting for core query terms (+6 for word match, +3 for substring)
    for (const term of coreQueryTerms) {
      if (recordTerms.has(term)) {
        score += 6;
        coreMatches++;
      } else if (textNorm.includes(term)) {
        score += 3;
        coreMatches++;
      }
    }

    // 2. Secondary weighting for expanded alias terms (+2)
    for (const term of aliasTerms) {
      if (recordTerms.has(term) || textNorm.includes(term)) {
        score += 2;
      }
    }

    // 3. Exact query sub-phrase match (+20)
    if (normQuestion.length > 4 && textNorm.includes(normQuestion)) {
      score += 20;
    }

    // 4. Specific Course match (+10)
    if (matchedCourse && textNorm.includes(matchedCourse)) {
      score += 10;
    }

    // 5. Structure & Section Boost: Give JSON structured records a preference (+5)
    if (record.source.endsWith(".json")) {
      score += 5;
    }

    // 5b. Specialized Intent Boosts
    if (record.section === "leadership" && (normQuestion.includes("director") || normQuestion.includes("executive") || normQuestion.includes("leadership"))) {
      score += 15;
    }
    if (record.section === "department_heads" && (normQuestion.includes("hod") || normQuestion.includes("head") || normQuestion.includes("coordinator"))) {
      score += 15;
    }
    if (record.section === "placements" && (normQuestion.includes("placement") || normQuestion.includes("training") || normQuestion.includes("job") || normQuestion.includes("recruitment"))) {
      score += 15;
    }
    if (record.section === "events" && (normQuestion.includes("event") || normQuestion.includes("fest") || normQuestion.includes("srijan") || normQuestion.includes("hackathon") || normQuestion.includes("sports") || normQuestion.includes("workshop") || normQuestion.includes("cultural"))) {
      score += 15;
    }
    if (record.section === "fees" && (normQuestion.includes("fee") || normQuestion.includes("pay") || normQuestion.includes("cost") || normQuestion.includes("charge"))) {
      score += 10;
    }

    // 6. Core Term Coverage Multiplier
    if (coreQueryTerms.length > 0) {
      const coverageRatio = coreMatches / coreQueryTerms.length;
      score += coverageRatio * 15;
    }

    return { ...record, score };
  });

  return scored
    .filter((r) => r.score >= 2.0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/* =========================================================
   GREETING DETECTOR (SAVING API CALLS)
========================================================= */

function isGreeting(question) {
  const q = question.toLowerCase().trim();
  const greetingPattern = /^(hi|hello|hey|greetings|good morning|good afternoon|good evening|who are you|what can you do|help)$/i;
  return greetingPattern.test(q) || (q.length <= 3 && !["bca", "mca", "bba", "mba", "fee", "hod"].includes(q));
}

/* =========================================================
   GENERATIVE AI SERVICE WITH MULTI-STAGE MODEL FAILOVER
========================================================= */

async function generateAnswer(question, matches) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GROQ_API_KEY;

  if (!apiKey) {
    return {
      status: 503,
      error: "Campus AI has not been configured yet (API key missing)."
    };
  }

  const contextStr = matches
    .map((match, idx) => `[SOURCE ${idx + 1}: ${match.source}]\n${match.content}`)
    .join("\n\n");

  const systemInstruction = `You are Campus AI for Dr. Virendra Swarup Institute of Computer Studies (VSICS), Kanpur.
Answer the student's question using ONLY the provided information below.

Rules:
1. Never use outside knowledge or hallucinate.
2. If the answer is present in the context, answer directly, clearly, and concisely.
3. At the end of every effective/successful answer, always say "Thank you!"
4. Do NOT mention source citations, file names, internal details, URLs, or disclaimers like "Source: Official VSICS Website" or "PDF/JSON" inside your answer.
5. If the answer is NOT present or NOT available in the context, say strictly:
   "This information is currently not available in our knowledge base or official website. Sorry!"`;

  const userPrompt = `Question:\n${question}\n\nVSICS Information Context:\n${contextStr}`;

  // Custom user-defined models from env variable OR ordered model list from main models -> high capacity -> unlimited capacity
  const customModels = (process.env.GEMINI_MODELS_LIST || "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);

  const GEMINI_MODELS = [
    ...customModels,
    process.env.GEMINI_MODEL,
    // Stage 1: Main High-Quality Models
    "gemini-3.7-flash",
    "gemini-3.8-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3-flash",
    "gemini-2.5-flash",

    // Stage 2: High Daily Capacity Models (500 RPD)
    "gemini-3.1-flash-lite",
    "gemini-3.5-flash-lite",
    "gemini-2.5-flash-lite",

    // Stage 3: Massive / Unlimited Daily Capacity Models (14,400 RPD & Unlimited RPM)
    "gemma-4-26b",
    "gemma-4-31b",
    "gemini-3-flash-live",
    "gemini-2.5-flash-native-audio-dialog",
    "gemini-1.5-flash",
    "gemini-1.5-flash-lite"
  ].filter((val, index, self) => val && self.indexOf(val) === index);

  let answer = "";

  if (process.env.GEMINI_API_KEY || (!process.env.GROQ_API_KEY && apiKey.startsWith("AIza"))) {
    // Try models in strict priority order
    for (const model of GEMINI_MODELS) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": apiKey
            },
            signal: controller.signal,
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: systemInstruction }] },
              contents: [{ role: "user", parts: [{ text: userPrompt }] }]
            })
          }
        );

        const data = await response.json();
        if (response.ok) {
          answer = data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
          if (answer) {
            console.log(`Gemini API succeeded using model: ${model}`);
            break;
          }
        } else {
          console.warn(`Model ${model} returned HTTP ${response.status}: ${data.error?.message || "Rate limit reached"}`);
        }
      } catch (err) {
        console.warn(`Fetch error for model ${model}:`, err.message);
      } finally {
        clearTimeout(timeout);
      }
    }
  } else {
    // Call Groq API
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const groqModel = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: groqModel,
          messages: [
            { role: "system", content: systemInstruction },
            { role: "user", content: userPrompt }
          ],
          temperature: 0.2
        })
      });

      const data = await response.json();
      if (response.ok) {
        answer = data.choices?.[0]?.message?.content?.trim();
      }
    } catch (err) {
      console.warn("Groq API request failed:", err.message);
    } finally {
      clearTimeout(timeout);
    }
  }

  // ZERO-ERROR DIRECT RAG FALLBACK: If all API models hit daily quota (429), use retrieved knowledge context directly!
  if (!answer) {
    console.log("All AI models rate-limited/unavailable. Serving formatted RAG knowledge context directly.");
    const mainMatch = matches[0]?.content || "";
    if (mainMatch) {
      answer = `${mainMatch}\n\nThank you!`;
    } else {
      answer = "This information is currently not available in our knowledge base or official website. Sorry!";
    }
  }

  // Ensure effective answers end politely with "Thank you!"
  if (!answer.toLowerCase().includes("thank you") && !answer.toLowerCase().includes("sorry")) {
    answer += "\n\nThank you!";
  }

  return {
    status: 200,
    answer,
    sources: []
  };
}

/* =========================================================
   MAIN ENTRY POINT
========================================================= */

async function answerQuestion(question) {
  const cleanQuestion = String(question || "").trim();

  if (!cleanQuestion || cleanQuestion.length > 1500) {
    return { status: 400, error: "Ask a question between 1 and 1,500 characters." };
  }

  // 1. Check Response Cache (Saves API Key Quota)
  const normKey = normalizeForSearch(cleanQuestion);
  if (answerCache.has(normKey)) {
    console.log(`[CACHE HIT] Serving cached response for: "${cleanQuestion}"`);
    return answerCache.get(normKey);
  }

  // 2. Check Greeting (0 API calls)
  if (isGreeting(cleanQuestion)) {
    const greetingRes = {
      status: 200,
      answer: "Hello! I am Campus AI for Dr. Virendra Swarup Institute of Computer Studies (VSICS), Kanpur. How can I help you today? You can ask me about courses (BCA, MCA, BBA, MBA), fee structures, faculty, placements, admissions, or contact details.\n\nThank you!",
      sources: []
    };
    answerCache.set(normKey, greetingRes);
    return greetingRes;
  }

  // 3. Local Search (JSON + PDF)
  const localRecords = await knowledgeBase();
  let matches = retrieve(cleanQuestion, localRecords, 6);

  console.log(`Query: "${cleanQuestion}" (Typo corrected: "${correctTypos(cleanQuestion)}") | Local records: ${localRecords.length} | Local Matches: ${matches.length}`);

  // 4. Fallback to Official Website Search if local score is low (< 3.0) or no matches
  if (!matches.length || matches[0].score < 3.0) {
    console.log(`Local RAG score low (${matches[0]?.score || 0}). Fallback search on official website (https://www.vsicskanpur.org/)...`);
    const webRecords = await fetchWebsiteKnowledge();
    if (webRecords.length > 0) {
      const webMatches = retrieve(cleanQuestion, webRecords, 6);
      if (webMatches.length > 0 && webMatches[0].score >= 2.0) {
        matches = webMatches;
        console.log(`Found relevant answer on official website! Matches: ${matches.length} | Top score: ${matches[0].score}`);
      }
    }
  }

  if (matches.length > 0) {
    console.log(`Top match score: ${matches[0].score} | Content snippet: "${matches[0].content.slice(0, 100)}..."`);
  }

  // 5. If answer is NOT in PDF, JSON, OR Website -> Final Fallback
  if (!matches.length || matches[0].score < 2.0) {
    const fallbackRes = {
      status: 200,
      answer: "This information is currently not available in our knowledge base or official website. Sorry!",
      sources: []
    };
    answerCache.set(normKey, fallbackRes);
    return fallbackRes;
  }

  // 6. Generate answer via AI API (with model failover & zero-error fallback)
  const result = await generateAnswer(cleanQuestion, matches);
  if (result.status === 200) {
    if (answerCache.size >= MAX_CACHE_SIZE) {
      const firstKey = answerCache.keys().next().value;
      answerCache.delete(firstKey);
    }
    answerCache.set(normKey, result);
  }

  return result;
}

module.exports = {
  answerQuestion
};