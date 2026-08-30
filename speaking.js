/* CELPIP-LS Speaking Task Rehearsal, application logic.
   A two-phase (prep -> response) countdown timer per task, matching the real
   test's exact prep-time/response-time pairs. There is no way for a website
   to listen to or grade spoken audio, so after the response timer ends this
   reveals a model answer to compare against instead of a score. */

let spGroups = {};
let spQueue = [];
let spIndex = 0;
let spTimerInterval = null;
let spPhase = "idle"; // "idle" | "prep" | "response" | "done"
let spRemaining = 0;

function groupSpeakingTasks() {
  spGroups = {};
  (window.SPEAKING_TASKS || []).forEach(t => {
    if (!spGroups[t.task_number]) spGroups[t.task_number] = [];
    spGroups[t.task_number].push(t);
  });
}

function shuffleArr(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function initSpeakingMenu() {
  groupSpeakingTasks();
  document.getElementById("speaking-menu").style.display = "flex";
  document.getElementById("speaking-play").style.display = "none";
  const list = document.getElementById("speaking-task-list");
  list.innerHTML = "";
  const nums = Object.keys(spGroups).map(Number).sort((a, b) => a - b);
  nums.forEach(num => {
    const tasks = spGroups[num];
    const first = tasks[0];
    const btn = document.createElement("button");
    btn.className = "station-card";
    btn.innerHTML =
      `<span class="station-card-section">Task ${num}</span>` +
      `<span class="station-card-title">${escapeHTML(first.task_title)}</span>` +
      `<span class="station-card-meta">${tasks.length} prompts, ${first.prep_seconds}s prep / ${first.response_seconds}s speak</span>`;
    btn.addEventListener("click", () => startSpeakingTask(num));
    list.appendChild(btn);
  });
  document.getElementById("speaking-menu-back").onclick = () => {
    document.getElementById("speaking-menu").style.display = "none";
    document.getElementById("mode-select").style.display = "flex";
  };
}

function startSpeakingTask(num) {
  spQueue = shuffleArr(spGroups[num]);
  spIndex = 0;
  document.getElementById("speaking-menu").style.display = "none";
  document.getElementById("speaking-play").style.display = "flex";
  document.getElementById("speaking-back").onclick = () => {
    stopSpTimer();
    document.getElementById("speaking-play").style.display = "none";
    initSpeakingMenu();
  };
  renderSpeakingPrompt();
}

function updateSpTimerDisplay() {
  const m = Math.floor(spRemaining / 60);
  const s = spRemaining % 60;
  document.getElementById("speaking-timer-display").textContent = `${m}:${String(s).padStart(2, "0")}`;
}

function stopSpTimer() {
  if (spTimerInterval) { clearInterval(spTimerInterval); spTimerInterval = null; }
}

function renderSpeakingPrompt() {
  stopSpTimer();
  const t = spQueue[spIndex];
  if (!t) return;
  spPhase = "idle";
  spRemaining = t.prep_seconds;

  document.getElementById("speaking-title-bar").textContent = `Task ${t.task_number}: ${t.task_title}`;
  document.getElementById("speaking-prompt-text").textContent = t.prompt_text;
  document.getElementById("speaking-phase-label").textContent = "Preparation";
  document.getElementById("speaking-instructions").textContent =
    `You get ${t.prep_seconds} seconds to prepare, then you must speak out loud for the full ${t.response_seconds} seconds, just like the real test. Tap Start when you are ready to begin the prep clock.`;

  const imgWrap = document.getElementById("speaking-image-wrap");
  const imgs = [t.image, t.image_2].filter(Boolean);
  if (imgs.length) {
    imgWrap.innerHTML = imgs.map(src => `<img src="${src}" alt="" class="q-image">`).join("");
    imgWrap.style.display = "block";
  } else {
    imgWrap.innerHTML = "";
    imgWrap.style.display = "none";
  }

  document.getElementById("speaking-model-wrap").style.display = "none";
  const startBtn = document.getElementById("speaking-start-btn");
  startBtn.style.display = "block";
  startBtn.disabled = false;
  startBtn.textContent = "Start Prep Timer";
  document.getElementById("speaking-skip-btn").style.display = "inline-block";
  updateSpTimerDisplay();

  startBtn.onclick = () => beginSpTimer(t);
  document.getElementById("speaking-skip-btn").onclick = () => { stopSpTimer(); startResponsePhase(t); };
}

function beginSpTimer(t) {
  document.getElementById("speaking-start-btn").disabled = true;
  spPhase = "prep";
  spRemaining = t.prep_seconds;
  updateSpTimerDisplay();
  spTimerInterval = setInterval(() => spTick(t), 1000);
}

function spTick(t) {
  spRemaining--;
  if (spRemaining <= 0) {
    if (spPhase === "prep") { startResponsePhase(t); return; }
    stopSpTimer();
    spPhase = "done";
    spRemaining = 0;
    updateSpTimerDisplay();
    revealModelAnswer(t);
    return;
  }
  updateSpTimerDisplay();
}

function startResponsePhase(t) {
  spPhase = "response";
  spRemaining = t.response_seconds;
  document.getElementById("speaking-phase-label").textContent = "Speaking Now";
  document.getElementById("speaking-instructions").textContent =
    "Speak out loud now. Keep talking until the timer reaches zero, just like the real test, there is no pausing and no second take.";
  document.getElementById("speaking-skip-btn").style.display = "none";
  // "Start Prep Timer" must also disappear here, not just get disabled: the
  // "Skip to Speaking" path jumps straight to this phase WITHOUT ever calling
  // beginSpTimer(), so the button's disabled flag was never set. Left visible
  // and enabled, tapping it restarts the prep clock from underneath the
  // "Speaking Now" label with no visible explanation, desyncing the display.
  document.getElementById("speaking-start-btn").style.display = "none";
  updateSpTimerDisplay();
  if (!spTimerInterval) spTimerInterval = setInterval(() => spTick(t), 1000);
}

function revealModelAnswer(t) {
  document.getElementById("speaking-phase-label").textContent = "Time's Up";
  document.getElementById("speaking-instructions").textContent = "Compare what you said out loud to the model answer below.";
  document.getElementById("speaking-start-btn").style.display = "none";
  const modelWrap = document.getElementById("speaking-model-wrap");
  modelWrap.style.display = "block";
  document.getElementById("speaking-model-answer").textContent = t.model_answer || "";
  document.getElementById("speaking-tips").textContent = t.tips || "";
  document.getElementById("speaking-next-btn").onclick = () => {
    spIndex = (spIndex + 1) % spQueue.length;
    renderSpeakingPrompt();
  };
}
