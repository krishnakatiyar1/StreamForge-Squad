function toggleMobileNav(btn) {
  const header = btn ? btn.closest("header") : document.querySelector("header");
  if (!header) return;
  const nav = header.querySelector("nav");
  if (nav) {
    const isOpen = nav.classList.toggle("nav-open");
    btn.innerHTML = isOpen ? "✕ Close" : "☰ Menu";
  }
}

const chat = document.querySelector("#chat-body");
const input = document.querySelector("#question-input");
const send = document.querySelector("#send-question");

function addMessage(text, className = "message") {
  if (!chat) return;
  const message = document.createElement("div");
  message.className = className;
  message.textContent = text;
  chat.append(message);
  chat.scrollTop = chat.scrollHeight;
}

async function askQuestion(value = input ? input.value : "") {
  const question = value.trim();
  if (!question || (send && send.disabled)) return;
  addMessage(question, "message user-message");
  if (input) input.value = "";
  if (send) send.disabled = true;
  try {
    const response = await fetch("/api/ai/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question }) });
    const data = await response.json();
    if (response.status === 401) { location.href = "/login?next=%2Fai-assistant"; return; }
    if (!response.ok) throw new Error(data.error);
    addMessage(data.answer);
  } catch (error) {
    addMessage(error.message || "I could not answer that right now.", "message error");
  } finally {
    if (send) send.disabled = false;
    if (input) input.focus();
  }
}

if (send) send.onclick = () => askQuestion();
if (input) input.onkeydown = (event) => { if (event.key === "Enter") askQuestion(); };
document.querySelectorAll(".suggestion").forEach((button) => { button.onclick = () => askQuestion(button.textContent); });
