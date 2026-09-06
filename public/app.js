const chat = document.querySelector("#chat-body");
const input = document.querySelector("#question-input");
const send = document.querySelector("#send-question");

function addMessage(text, className = "message") {
  const message = document.createElement("div");
  message.className = className;
  message.textContent = text;
  chat.append(message);
  chat.scrollTop = chat.scrollHeight;
}

async function askQuestion(value = input.value) {
  const question = value.trim();
  if (!question || send.disabled) return;
  addMessage(question, "message user-message");
  input.value = "";
  send.disabled = true;
  try {
    const response = await fetch("/api/ai/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question }) });
    const data = await response.json();
    if (response.status === 401) { location.href = "/login?next=%2Fai-assistant"; return; }
    if (!response.ok) throw new Error(data.error);
    addMessage(data.answer);
  } catch (error) {
    addMessage(error.message || "I could not answer that right now.", "message error");
  } finally {
    send.disabled = false;
    input.focus();
  }
}

send.onclick = () => askQuestion();
input.onkeydown = (event) => { if (event.key === "Enter") askQuestion(); };
document.querySelectorAll(".suggestion").forEach((button) => { button.onclick = () => askQuestion(button.textContent); });
