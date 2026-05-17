const thread = document.getElementById("thread");
const form = document.getElementById("composer");
const input = document.getElementById("input");
const sendBtn = document.getElementById("sendBtn");
const micBtn = document.getElementById("micBtn");
const muteBtn = document.getElementById("muteBtn");
const endBtn = document.getElementById("endBtn");
const disclaimer = document.getElementById("disclaimer");
const dismissDisclaimer = document.getElementById("dismissDisclaimer");

let muted = localStorage.getItem("val.muted") === "1";
let serverTts = false;
let recognizing = false;
let recognition = null;
let currentAudio = null;

function setMuteUi() {
  muteBtn.textContent = muted ? "voice off" : "voice on";
}
setMuteUi();

muteBtn.addEventListener("click", () => {
  muted = !muted;
  localStorage.setItem("val.muted", muted ? "1" : "0");
  setMuteUi();
  if (muted && currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  if (muted && "speechSynthesis" in window) speechSynthesis.cancel();
});

if (!localStorage.getItem("val.disclaimerDismissed")) {
  disclaimer.hidden = false;
}
dismissDisclaimer.addEventListener("click", () => {
  disclaimer.hidden = true;
  localStorage.setItem("val.disclaimerDismissed", "1");
});

input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 200) + "px";
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

function addBubble(role, text = "") {
  const div = document.createElement("div");
  div.className = `bubble ${role}`;
  div.textContent = text;
  thread.appendChild(div);
  scrollToBottom();
  return div;
}

function addNotice(text) {
  const div = document.createElement("div");
  div.className = "notice";
  div.textContent = text;
  thread.appendChild(div);
  scrollToBottom();
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  });
}

async function loadHistory() {
  const cfg = await fetch("/api/config").then((r) => r.json());
  serverTts = cfg.serverTts;
  const data = await fetch("/api/history").then((r) => r.json());
  thread.innerHTML = "";
  for (const m of data.messages) addBubble(m.role, m.content);
}

async function speak(text) {
  if (muted || !text) return;
  if (serverTts) {
    try {
      const r = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!r.ok) throw new Error("tts request failed");
      const blob = await r.blob();
      if (currentAudio) currentAudio.pause();
      currentAudio = new Audio(URL.createObjectURL(blob));
      currentAudio.play().catch(() => {});
    } catch (e) {
      console.warn("server TTS failed, falling back to browser:", e);
      browserSpeak(text);
    }
  } else {
    browserSpeak(text);
  }
}

function browserSpeak(text) {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  const voices = speechSynthesis.getVoices();
  const preferred =
    voices.find((v) => /samantha|victoria|karen|serena/i.test(v.name)) ||
    voices.find((v) => v.lang === "en-US" && v.name.toLowerCase().includes("female")) ||
    voices.find((v) => v.lang === "en-US") ||
    voices[0];
  if (preferred) utter.voice = preferred;
  utter.rate = 0.95;
  utter.pitch = 1.0;
  speechSynthesis.speak(utter);
}

async function send(text) {
  if (!text.trim()) return;
  addBubble("user", text);
  input.value = "";
  input.style.height = "auto";
  sendBtn.disabled = true;

  const bubble = addBubble("assistant", "");
  bubble.classList.add("streaming");

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    });
    if (!res.ok || !res.body) throw new Error("chat request failed");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const lines = frame.split("\n");
        let event = "message";
        let data = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) event = line.slice(7);
          else if (line.startsWith("data: ")) data += line.slice(6);
        }
        if (!data) continue;
        let payload;
        try { payload = JSON.parse(data); } catch { continue; }
        if (event === "delta") {
          full += payload.text;
          bubble.textContent = full;
          scrollToBottom();
        } else if (event === "done") {
          full = payload.text || full;
          bubble.textContent = full;
        } else if (event === "error") {
          bubble.textContent = "(connection error: " + payload.message + ")";
        }
      }
    }
    bubble.classList.remove("streaming");
    if (full) speak(full);
  } catch (e) {
    bubble.textContent = "(connection error)";
    bubble.classList.remove("streaming");
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  send(input.value);
});

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let userWantsMicOn = false;
let committedText = "";
let restartAttempts = 0;

if (SR) {
  recognition = new SR();
  recognition.lang = "en-US";
  recognition.interimResults = true;
  recognition.continuous = true;

  recognition.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) {
        committedText = (committedText + " " + t).trim();
      } else {
        interim += t;
      }
    }
    input.value = (committedText + " " + interim).trim();
    input.dispatchEvent(new Event("input"));
    restartAttempts = 0;
  };

  recognition.onend = () => {
    if (userWantsMicOn && restartAttempts < 10) {
      restartAttempts++;
      try {
        recognition.start();
        return;
      } catch {}
    }
    recognizing = false;
    userWantsMicOn = false;
    restartAttempts = 0;
    micBtn.classList.remove("recording");
  };

  recognition.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "audio-capture" || e.error === "service-not-allowed") {
      userWantsMicOn = false;
    }
  };

  micBtn.addEventListener("click", () => {
    if (recognizing) {
      userWantsMicOn = false;
      recognition.stop();
      return;
    }
    try {
      committedText = input.value;
      restartAttempts = 0;
      userWantsMicOn = true;
      recognition.start();
      recognizing = true;
      micBtn.classList.add("recording");
    } catch {}
  });
} else {
  micBtn.style.display = "none";
}

endBtn.addEventListener("click", async () => {
  if (!confirm("End the session? I'll save notes from what we talked about.")) return;
  endBtn.disabled = true;
  const r = await fetch("/api/session/end", { method: "POST" });
  const data = await r.json().catch(() => ({}));
  await fetch("/api/session/new", { method: "POST" });
  thread.innerHTML = "";
  addNotice(data.summarized ? "Session ended. Notes saved." : "Session ended.");
  endBtn.disabled = false;
  setTimeout(loadHistory, 400);
});

if ("speechSynthesis" in window) {
  speechSynthesis.onvoiceschanged = () => {};
}

loadHistory();
