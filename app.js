/* CELPIPLS Exam Simulator, Application Logic */

const ACCESS_CODE  = "CELPIPLS9000";
const EXAM_SECONDS = 3060;  // 51 min, the midpoint of the real 46-55 min Listening sitting
const STORAGE_KEY  = "celpipls_exam_state_v1";
const SIM_Q_COUNT  = 38;   // matches the real CELPIP-LS Listening sitting: 6 parts, 38 scored questions
const CLUSTER_LABEL = "Case";

// CELPIP does not use a fixed pass/fail percentage. Your real Listening score
// is converted to a CLB (Canadian Language Benchmark, 1-12) level by CELPIP's
// own proprietary scoring model, and Canadian citizenship (ages 18-54) needs
// CLB 4 or higher in Listening. These bands are an unofficial estimate built
// from publicly published CELPIP score-conversion patterns, not an official
// CELPIP score. Never claim a real pass/fail percentage for this exam.
// Deliberately conservative: CELPIP does not publish a real raw-score-to-CLB
// table (it's a proprietary scaled model), so this is, and always was, a
// disclosed estimate rather than ground truth. The floor for "meets CLB 4"
// was raised well above the naive linear-percentage guess so the site errs
// toward caution on a claim this high-stakes (Canadian citizenship
// eligibility) rather than risk reassuring someone who missed most of the
// test. The specific raw-score cutoffs are intentionally never surfaced in
// the UI, only the resulting CLB band and a plain "X / 38 correct" count.
const CLB_BANDS = [
  { min: 0,  max: 22, clb: "Below CLB 4" },
  { min: 23, max: 25, clb: "CLB 4" },
  { min: 26, max: 28, clb: "CLB 5" },
  { min: 29, max: 30, clb: "CLB 6" },
  { min: 31, max: 32, clb: "CLB 7" },
  { min: 33, max: 34, clb: "CLB 8" },
  { min: 35, max: 36, clb: "CLB 9" },
  { min: 37, max: 38, clb: "CLB 10+" },
];
function estimateCLB(correct, total) {
  const scaled = Math.round(correct / total * 38);
  const band = CLB_BANDS.find(b => scaled >= b.min && scaled <= b.max) || CLB_BANDS[0];
  return band.clb;
}
const DOMAIN_LABELS = {"listening_to_problem_solving": "Listening to Problem Solving", "listening_to_a_daily_life_conversation": "Listening to a Daily Life Conversation", "listening_for_information": "Listening for Information", "listening_to_a_news_item": "Listening to a News Item", "listening_to_a_discussion": "Listening to a Discussion", "listening_for_viewpoints": "Listening for Viewpoints"};  // maps domain key -> human-readable label for display
function domainLabel(key) { return DOMAIN_LABELS[key] || key || ""; }

let questions = [];
let state = {
  phase: "gate", answers: {}, flags: {},
  current: 1, timeLeft: EXAM_SECONDS,
  submitted: false, startTime: null,
};
let timerInterval = null;

// ── boot ──────────────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  const allQ = (window.EXAM_QUESTIONS || []).slice();
  questions = pickQuestions(allQ, SIM_Q_COUNT);
  restoreState();

  document.getElementById("access-gate").style.display = "flex";
  document.getElementById("app").style.display = "none";
  setupAccessGate();

  document.getElementById("mode-listening").addEventListener("click", () => {
    document.getElementById("mode-select").style.display = "none";
    startExam();
  });
  document.getElementById("mcq-back").addEventListener("click", () => {
    // The submit flow always confirms before anything destructive happens
    // (blocking dialog on an incomplete submit, confirm dialog on a real
    // submit) — leaving mid-test through Back was the one exit with no such
    // guard, silently dropping an in-progress, unsubmitted attempt.
    const midTest = document.getElementById("app").style.display !== "none" && !state.submitted;
    if (midTest && !confirm("Leave this practice test? Your progress on this attempt will be lost.")) {
      return;
    }
    clearInterval(timerInterval);
    document.getElementById("app").style.display = "none";
    document.getElementById("results-screen").style.display = "none";
    document.getElementById("mode-select").style.display = "flex";
  });
  document.getElementById("mode-speaking").addEventListener("click", () => {
    document.getElementById("mode-select").style.display = "none";
    if (typeof initSpeakingMenu === "function") initSpeakingMenu();
  });
});

// Shuffle by UNIT, never by individual question. A cluster is several
// questions sharing one case or passage: they must stay together and in their
// authored order, because later questions refer back to the same material.
// Shuffling every question individually scatters them across the exam, so a
// candidate meets question 6 about a passage before ever seeing the passage.
// That bug reached CNPLE's LIVE site and only a real browser found it.
// Truncation is done on a unit boundary too, so a cluster is never cut in half.
function clusterId(q) {
  return q.cluster_id || q.case_id || q.passage_id || null;
}

function pickQuestions(all, limit) {
  const units = [], byId = new Map();
  for (const q of all) {
    const c = clusterId(q);
    if (!c) { units.push([q]); continue; }
    if (!byId.has(c)) { const u = []; byId.set(c, u); units.push(u); }
    byId.get(c).push(q);
  }
  shuffleUnits(units);

  const out = [];
  for (const u of units) {
    if (out.length + u.length > limit) continue;   // never split a cluster
    for (const q of u) out.push(q);
  }
  breakAnswerRuns(out);
  return out;
}

function shuffleUnits(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// Prevent 3+ consecutive same correct answer. Only ever swaps two STANDALONE
// questions: swapping a clustered one would undo the grouping above.
function breakAnswerRuns(arr) {
  const free = i => arr[i] && !clusterId(arr[i]);
  for (let i = 2; i < arr.length; i++) {
    if (arr[i].correct === arr[i-1].correct && arr[i].correct === arr[i-2].correct) {
      if (!free(i)) continue;
      for (let j = i + 1; j < arr.length; j++) {
        if (free(j) && arr[j].correct !== arr[i-1].correct) {
          [arr[i], arr[j]] = [arr[j], arr[i]];
          break;
        }
      }
    }
  }
}

// ── access gate ───────────────────────────────────────────────────────────────
function setupAccessGate() {
  const attempt = () => {
    const val = document.getElementById("access-code-input").value.trim().toUpperCase();
    if (val === ACCESS_CODE) {
      document.getElementById("access-gate").style.display = "none";
      document.getElementById("mode-select").style.display = "flex";
    } else {
      const err = document.getElementById("access-error");
      err.textContent = "Incorrect access code. Please try again.";
      document.getElementById("access-code-input").value = "";
      document.getElementById("access-code-input").focus();
    }
  };
  document.getElementById("access-btn").addEventListener("click", attempt);
  document.getElementById("access-code-input").addEventListener("keydown",
    e => { if (e.key === "Enter") attempt(); });
}

// ── exam start ────────────────────────────────────────────────────────────────
let examListenersBound = false;
function startExam() {
  if (state.submitted) {
    localStorage.removeItem(STORAGE_KEY);
    state = { phase: "gate", answers: {}, flags: {}, current: 1, timeLeft: EXAM_SECONDS, submitted: false, startTime: null };
  }
  document.getElementById("app").style.display = "flex";
  if (!state.startTime) state.startTime = Date.now();
  renderQuestion();
  startTimer();
  buildGrid();
  if (!examListenersBound) {
    examListenersBound = true;
    document.getElementById("submit-btn").addEventListener("click", confirmSubmit);
    document.getElementById("flag-btn").addEventListener("click",   toggleFlag);
    document.getElementById("prev-btn").addEventListener("click",   () => navigate(-1));
    document.getElementById("next-btn").addEventListener("click",   () => navigate(1));
    document.getElementById("map-btn").addEventListener("click",    openMapModal);
    document.getElementById("map-close").addEventListener("click",  closeMapModal);
    document.getElementById("map-backdrop").addEventListener("click", closeMapModal);
    document.addEventListener("keydown", keyHandler);
  }
}

// ── timer ─────────────────────────────────────────────────────────────────────
function startTimer() {
  updateTimerDisplay();
  timerInterval = setInterval(() => {
    if (state.submitted) return;
    state.timeLeft = Math.max(0, EXAM_SECONDS - Math.floor((Date.now() - state.startTime) / 1000));
    updateTimerDisplay();
    if (state.timeLeft === 0) submitExam();
    saveState();
  }, 1000);
}

function updateTimerDisplay() {
  const h = Math.floor(state.timeLeft / 3600);
  const m = Math.floor((state.timeLeft % 3600) / 60);
  const s = state.timeLeft % 60;
  document.getElementById("timer-display").textContent =
    h > 0 ? `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`
           : `${m}:${String(s).padStart(2,"0")}`;
}

// ── render ─────────────────────────────────────────────────────────────────────
// Any renderer that injects content as HTML must escape it first. This helper
// was missing from the scaffold entirely, so every cluster/passage renderer
// copied in from a finished project threw ReferenceError on its first item.
function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// A cluster's shared text is shown above EVERY question in that cluster, so a
// candidate never has to page backwards to reread it. It scrolls inside its own
// box: unbounded, a 450 word passage pushes the stem and options below the fold.
function renderCluster(q) {
  const wrap = document.getElementById("q-cluster-wrap");
  if (!wrap) return;
  const text = q.cluster_text || q.case_text || q.passage_text || "";
  if (!text) { wrap.innerHTML = ""; wrap.style.display = "none"; return; }
  const body = String(text).split("\n").filter(l => l.trim())
    .map(l => `<p>${escapeHTML(l.trim())}</p>`).join("");
  wrap.innerHTML = `<div class="cluster-label">${CLUSTER_LABEL} `
                 + `${escapeHTML(clusterId(q) || "")}</div>`
                 + `<div class="cluster-body">${body}</div>`;
  wrap.style.display = "block";
}

// ── listening audio ──────────────────────────────────────────────────────────
// Plays a REAL, pre-baked recording of each question's transcript (Piper TTS,
// voice en_US-lessac-high, rendered once offline with generate_listening_audio.py
// and hosted as a static file). No pause, no replay, matching the real test's
// "audio plays once, automatically" rule.
//
// This replaced an earlier version that synthesized speech live in each
// visitor's own browser via speechSynthesis. That approach depended entirely
// on whatever voice happened to be installed on that visitor's own device --
// direct measurement found it could pick anything from a macOS novelty/comedy
// voice ("Albert") to a mismatched British accent ("Daniel"), with pacing
// gaps up to 1000ms+ even on a legitimate, non-joke voice. A pre-baked static
// file means every single customer hears the IDENTICAL, good-quality
// recording, regardless of their own device -- see
// feedback_piper_tts_voice_choice.md for the full comparison and reasoning.
//
// If a question somehow has no audio file (a build gap, or a browser that
// can't play the format), fall back to showing the transcript as text
// immediately rather than leaving the learner with a dead button.
let currentAudio = null;
function stopAudio() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.oncanplaythrough = currentAudio.onended = currentAudio.onerror = null;
    currentAudio = null;
  }
}

function setupAudioForQuestion(q) {
  const btn    = document.getElementById("play-audio-btn");
  const status = document.getElementById("audio-status");
  btn.disabled = false;
  btn.textContent = "▶ Play Audio";
  if (!q.audio) {
    status.textContent = "Audio unavailable for this question, showing script below";
    document.getElementById("q-transcript-wrap").innerHTML =
      `<div class="transcript-label">Listening Script</div><p>${escapeHTML(q.transcript || "")}</p>`;
    document.getElementById("q-transcript-wrap").style.display = q.transcript ? "block" : "none";
    btn.disabled = true;
    return;
  }
  status.textContent = "Not played yet";
  btn.onclick = () => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = "▶ Playing…";
    status.textContent = "Playing, listen carefully, it only plays once";
    stopAudio();
    currentAudio = new Audio(q.audio);
    currentAudio.onended = () => {
      btn.textContent = "✓ Played";
      status.textContent = "Audio already played once, just like the real test";
    };
    currentAudio.onerror = () => {
      btn.textContent = "✓ Played";
      status.textContent = "Audio playback failed, transcript is available in review after you submit";
    };
    currentAudio.play().catch(() => {
      // Autoplay-policy rejection or similar -- don't leave the learner
      // stuck on a button that says "Playing..." forever with nothing
      // audibly happening and no way to retry.
      btn.disabled = false;
      btn.textContent = "▶ Play Audio";
      status.textContent = "Playback couldn't start, tap Play Audio again";
    });
  };
}

function renderQuestion() {
  const q = questions[state.current - 1];
  if (!q) return;
  stopAudio(); // never let a previous question's audio keep playing into a new one
  renderCluster(q);
  document.getElementById("q-counter").textContent = `Question ${state.current} of ${questions.length}`;
  document.getElementById("q-domain").textContent  = domainLabel(q.domain);
  document.getElementById("question-text").textContent = q.question;
  document.getElementById("q-transcript-wrap").style.display = "none";
  const audioWrap = document.getElementById("q-audio-wrap");
  if (q.transcript) {
    audioWrap.style.display = "flex";
    setupAudioForQuestion(q);
  } else {
    audioWrap.style.display = "none";
  }
  const imgWrap = document.getElementById("q-image-wrap");
  if (q.image) {
    imgWrap.innerHTML = `<img src="${q.image}" alt="" class="q-image">`;
    imgWrap.style.display = "block";
  } else {
    imgWrap.innerHTML = "";
    imgWrap.style.display = "none";
  }
  const fi = document.getElementById("q-flag-indicator");
  fi.style.display = state.flags[state.current] ? "inline-block" : "none";

  document.getElementById("explanation-box").style.display = "none";

  const ol = document.getElementById("options-list");
  ol.innerHTML = "";
  const chosen = state.answers[state.current];
  ["A", "B", "C", "D", "E"].forEach(letter => {
    const text = q.options?.[letter];
    if (!text) return;
    const div = document.createElement("div");
    div.className = "option" + (chosen === letter ? " selected" : "");
    div.innerHTML = `<span class="opt-letter">${letter}</span><span class="opt-text">${text}</span>`;
    div.addEventListener("click", () => selectAnswer(state.current, letter));
    ol.appendChild(div);
  });

  // Scroll question panel to top on navigation
  const panel = document.querySelector(".question-panel");
  if (panel) panel.scrollTop = 0;

  updateProgress();
  updateGrid();
}

function selectAnswer(qNum, letter) {
  if (state.submitted) return;
  state.answers[qNum] = letter;
  renderQuestion();
  saveState();
}

function navigate(dir) {
  const next = state.current + dir;
  if (next >= 1 && next <= questions.length) {
    state.current = next;
    renderQuestion();
  }
}

function toggleFlag() {
  state.flags[state.current] = !state.flags[state.current];
  renderQuestion();
  saveState();
}

function updateProgress() {
  const pct = Object.keys(state.answers).length / questions.length * 100;
  document.getElementById("progress-bar").style.width = pct + "%";
}

// ── question map modal ────────────────────────────────────────────────────────
function openMapModal() {
  updateGrid();
  document.getElementById("map-modal").style.display = "flex";
}

function closeMapModal() {
  document.getElementById("map-modal").style.display = "none";
}

// ── grid ──────────────────────────────────────────────────────────────────────
function buildGrid() {
  const grid = document.getElementById("q-grid");
  grid.innerHTML = "";
  for (let i = 1; i <= questions.length; i++) {
    const btn = document.createElement("button");
    btn.className = "grid-btn";
    btn.id = `gb-${i}`;
    btn.textContent = i;
    btn.addEventListener("click", () => {
      state.current = i;
      closeMapModal();
      renderQuestion();
    });
    grid.appendChild(btn);
  }
}

function updateGrid() {
  for (let i = 1; i <= questions.length; i++) {
    const btn = document.getElementById(`gb-${i}`);
    if (!btn) continue;
    btn.className = "grid-btn" +
      (state.answers[i]  ? " answered" : "") +
      (state.flags[i]    ? " flagged"  : "") +
      (state.current===i ? " active"   : "");
  }
}

// ── submit ────────────────────────────────────────────────────────────────────
function confirmSubmit() {
  const unanswered = questions.length - Object.keys(state.answers).length;
  if (unanswered > 0) {
    alert(`You must answer all ${questions.length} questions before submitting.\n\n${unanswered} question${unanswered > 1 ? "s" : ""} still unanswered.\n\nTap "Question Map" to find unanswered questions.`);
    return;
  }
  if (confirm("Submit your exam now?")) submitExam();
}

function submitExam() {
  clearInterval(timerInterval);
  state.submitted = true;
  saveState();
  showResults();
}

// ── results ───────────────────────────────────────────────────────────────────
function showResults() {
  document.getElementById("app").style.display = "none";
  document.getElementById("results-screen").style.display = "flex";

  let correct = 0;
  const domainStats = {};
  questions.forEach((q, idx) => {
    const num = idx + 1;
    const userAns = state.answers[num];
    const isRight = userAns === q.correct;
    if (isRight) correct++;
    const dom = q.domain || "Other";
    if (!domainStats[dom]) domainStats[dom] = { correct: 0, total: 0 };
    domainStats[dom].total++;
    if (isRight) domainStats[dom].correct++;
  });

  const clb = estimateCLB(correct, questions.length);
  const meetsCitizenship = !clb.startsWith("Below");
  document.getElementById("res-status").textContent = `Estimated ${clb}`;
  document.getElementById("res-status").style.color = meetsCitizenship ? "#059669" : "#DC2626";
  document.getElementById("res-score").textContent  = `${correct} / ${questions.length} correct`;
  const noteId = "res-clb-note";
  let note = document.getElementById(noteId);
  if (!note) {
    note = document.createElement("p");
    note.id = noteId;
    note.className = "res-clb-note";
    document.getElementById("res-score").insertAdjacentElement("afterend", note);
  }
  note.textContent = meetsCitizenship
    ? "This meets the CLB 4 level IRCC requires for Canadian citizenship (ages 18-54). This is an unofficial estimate, not a real CELPIP score. Only CELPIP's own scoring determines your real result."
    : "CLB 4 is the level IRCC requires for Canadian citizenship (ages 18-54). This is an unofficial estimate, not a real CELPIP score. Only CELPIP's own scoring determines your real result.";

  // A 38-question sitting is deliberately real-exam-sized, but on its own
  // gives no visible sign that it was drawn from a much larger 494-question
  // pool (13 full tests) — leave that unclear and a candidate could
  // reasonably wonder whether the book's advertised question count is real.
  const poolNoteId = "res-pool-note";
  let poolNote = document.getElementById(poolNoteId);
  if (!poolNote) {
    poolNote = document.createElement("p");
    poolNote.id = poolNoteId;
    poolNote.className = "res-clb-note";
    note.insertAdjacentElement("afterend", poolNote);
  }
  poolNote.textContent = "This sitting drew 38 questions at random from all 494 Listening questions in this book. Retake for a fresh mix, or work through all 13 full practice tests in the printed/PDF study guide.";

  const domDiv = document.getElementById("res-domains");
  domDiv.innerHTML = "";
  Object.entries(domainStats).forEach(([dom, s]) => {
    const dp = Math.round(s.correct / s.total * 100);
    domDiv.innerHTML += `<div class="res-domain-row">
      <span class="res-domain-name">${domainLabel(dom)}</span>
      <div class="res-domain-bar-wrap"><div class="res-domain-bar" style="width:${dp}%;background:#1B3A6B"></div></div>
      <span class="res-domain-pct">${dp}%</span>
    </div>`;
  });

  document.getElementById("res-review-btn").addEventListener("click", () => {
    state.submitted = true;
    document.getElementById("results-screen").style.display = "none";
    document.getElementById("app").style.display = "flex";
    renderReview();
  });
  document.getElementById("res-restart-btn").addEventListener("click", () => {
    localStorage.removeItem(STORAGE_KEY);
    location.reload();
  });
}

function renderReview() {
  const ol = document.getElementById("options-list");
  const q  = questions[state.current - 1];
  if (!q) return;
  document.getElementById("q-counter").textContent = `Review, Question ${state.current} of ${questions.length}`;
  document.getElementById("question-text").textContent = q.question;
  document.getElementById("q-audio-wrap").style.display = "none";
  const transWrap = document.getElementById("q-transcript-wrap");
  if (q.transcript) {
    transWrap.innerHTML = `<div class="transcript-label">Listening Script (for review)</div><p>${escapeHTML(q.transcript)}</p>`;
    transWrap.style.display = "block";
  } else {
    transWrap.style.display = "none";
  }
  const revImgWrap = document.getElementById("q-image-wrap");
  if (q.image) {
    revImgWrap.innerHTML = `<img src="${q.image}" alt="" class="q-image">`;
    revImgWrap.style.display = "block";
  } else {
    revImgWrap.innerHTML = "";
    revImgWrap.style.display = "none";
  }
  ol.innerHTML = "";
  const userAns = state.answers[state.current];
  ["A", "B", "C", "D", "E"].forEach(letter => {
    const text = q.options?.[letter];
    if (!text) return;
    const div = document.createElement("div");
    let cls = "option";
    if (letter === q.correct)      cls += " correct";
    else if (letter === userAns)   cls += " incorrect";
    div.className = cls;
    div.innerHTML = `<span class="opt-letter">${letter}</span><span class="opt-text">${text}</span>`;
    ol.appendChild(div);
  });

  const box  = document.getElementById("explanation-box");
  const expl = document.getElementById("explanation-text");
  if (q.explanation) {
    expl.textContent = q.explanation;
    box.style.display = "block";
  } else {
    box.style.display = "none";
  }

  document.getElementById("prev-btn").onclick = () => { navigate(-1); renderReview(); };
  document.getElementById("next-btn").onclick = () => { navigate(1);  renderReview(); };
}

// ── persistence ───────────────────────────────────────────────────────────────
function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch(e) {}
}
function restoreState() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) { const s = JSON.parse(saved); Object.assign(state, s); }
  } catch(e) {}
}

// ── keyboard ──────────────────────────────────────────────────────────────────
function keyHandler(e) {
  const letter = e.key.toUpperCase();
  const q = questions[state.current - 1];
  if (["A", "B", "C", "D", "E"].includes(letter) && !e.ctrlKey && !e.metaKey && q?.options?.[letter]) {
    selectAnswer(state.current, letter);
  }
  if (e.key === "ArrowRight" && state.current < questions.length) navigate(1);
  if (e.key === "ArrowLeft"  && state.current > 1)                navigate(-1);
  if (e.key === "Escape") closeMapModal();
}
