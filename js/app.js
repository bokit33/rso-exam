import { Storage } from "./storage.js";
import {
  dedupQuestions,
  pickNoRepeat,
  shuffle,
  shuffleOptions,
  scoreAttempt,
  formatTime,
  qKey
} from "./engine.js";

/**
 * This app.js is aligned to the Pearson-like HTML you shared:
 * - Progress: #pvProgress
 * - Track label: #pvTrackLabel
 * - Top time pill: #pvTimePill
 * - Timer in exam header: #timerBox
 * - Views: #view-start, #view-exam, #view-review, #view-report
 * - Navigator: #nav
 */

const $ = (sel) => document.querySelector(sel);

// Safe element getter by id with aliases (prevents null textContent crashes)
const ID_ALIAS = {
  qNum: "pvProgress",
  trackName: "pvTrackLabel",
  timerPill: "pvTimePill"
};
function byId(id) {
  return document.getElementById(id) || document.getElementById(ID_ALIAS[id] || "");
}
function setText(id, text) {
  const el = byId(id);
  if (el) el.textContent = text;
}
function setHTML(id, html) {
  const el = byId(id);
  if (el) el.innerHTML = html;
}

const state = {
  manifest: null,
  banksData: new Map(), // bankId -> questions array
  config: {
    mode: "exam", // practice | exam
    bankIds: [],
    count: 75,
    shuffleOptions: true,
    avoidAcrossAttempts: true,
    timerMinutes: 90,
    showReviewAfter: true,
    difficulty: "mixed" // matches your HTML select
  },
  attempt: null, // {questions, answersMap, flaggedSet, startTs, timeLimitSec, mode, meta}
  ui: {
    current: 0,
    locked: false,
    inReview: false
  }
};

async function loadManifest() {
  const res = await fetch("./banks/banks.json", { cache: "no-store" });
  if (!res.ok) throw new Error("Cannot load banks manifest");
  return res.json();
}

async function loadBankFile(file) {
  const res = await fetch(`./banks/${file}`, { cache: "no-store" });
  if (!res.ok) throw new Error("Cannot load bank file: " + file);
  return res.json();
}

function normalizeBankQuestions(bankId, raw) {
  // Support either array or {meta,questions} wrapper
  const arr = Array.isArray(raw) ? raw : raw && raw.questions ? raw.questions : [];
  return arr
    .map((q, idx) => ({
      bank_id: bankId,
      id: q.id ?? idx + 1,
      question: q.question,
      options: q.options,
      answer_index: q.answer_index,
      explain: q.explain || "",
      difficulty: (q.difficulty || "").toString(),
      topic: (q.topic || "").toString(),
      tags: Array.isArray(q.tags) ? q.tags : []
    }))
    .filter(
      (q) =>
        q.question &&
        Array.isArray(q.options) &&
        q.options.length === 4 &&
        Number.isInteger(q.answer_index) &&
        q.answer_index >= 0 &&
        q.answer_index <= 3
    );
}

function renderStart() {
  $("#view-start")?.classList.remove("hidden");
  $("#view-exam")?.classList.add("hidden");
  $("#view-review")?.classList.add("hidden");
  $("#view-report")?.classList.add("hidden");

  // Reset current attempt state view-only
  state.ui.current = 0;
  state.ui.locked = false;
  state.ui.inReview = false;

  const banksWrap = $("#banks-list");
  if (!banksWrap) return;

  banksWrap.innerHTML = "";
  for (const b of state.manifest.banks) {
    const id = b.id;

    const item = document.createElement("label");
    item.style.display = "flex";
    item.style.gap = "10px";
    item.style.alignItems = "center";
    item.style.padding = "10px 12px";
    item.style.border = "1px solid #cfd8e3";
    item.style.borderRadius = "12px";
    item.style.background = "#ffffff";
    item.style.cursor = "pointer";

    item.innerHTML = `
      <input type="checkbox" value="${id}" />
      <div style="flex:1">
        <div style="font-weight:900; color:#0f172a">${b.title}</div>
        <div style="color:#64748b;font-size:12px;font-weight:800">${b.count ?? ""} questions</div>
      </div>
    `;
    banksWrap.appendChild(item);
  }

  // Defaults
  const modeEl = $("#mode");
  const countEl = $("#count");
  const timerEl = $("#timer");
  const shuffleEl = $("#shuffleOptions");
  const avoidEl = $("#avoidAcross");
  const diffEl = $("#difficulty");

  if (modeEl) modeEl.value = state.config.mode;
  if (countEl) countEl.value = state.config.count;
  if (timerEl) timerEl.value = state.config.timerMinutes;
  if (shuffleEl) shuffleEl.checked = state.config.shuffleOptions;
  if (avoidEl) avoidEl.checked = state.config.avoidAcrossAttempts;
  if (diffEl) diffEl.value = state.config.difficulty;

  // Quick select first bank
  const first = banksWrap.querySelector("input[type=checkbox]");
  if (first) first.checked = true;

  // Reset timer texts
  setText("pvTimePill", "Time Remaining: --:--");
  setText("timerBox", "--:--");
  setText("pvProgress", "");
  setText("pvTrackLabel", "Track: --");
}

function getSelectedBanks() {
  return Array.from(
    document.querySelectorAll("#banks-list input[type=checkbox]:checked")
  ).map((i) => i.value);
}

async function ensureBanksLoaded(bankIds) {
  for (const bankId of bankIds) {
    if (state.banksData.has(bankId)) continue;
    const meta = state.manifest.banks.find((b) => b.id === bankId);
    if (!meta) throw new Error("Unknown bank: " + bankId);
    const raw = await loadBankFile(meta.file);
    const qs = normalizeBankQuestions(bankId, raw);
    state.banksData.set(bankId, qs);
  }
}

/* -------------------------
   Difficulty handling
-------------------------- */
function normDiff(s) {
  return (s || "").toString().trim().toLowerCase();
}

function splitByDifficulty(all) {
  const standard = [];
  const advanced = [];
  const easy = [];
  const medium = [];
  const hard = [];

  for (const q of all) {
    const d = normDiff(q.difficulty);

    // map typical tags
    if (d.includes("easy")) easy.push(q);
    else if (d.includes("medium")) medium.push(q);
    else if (d.includes("advanced") || d.includes("hard_advanced")) advanced.push(q);
    else if (d.includes("standard") || d.includes("hard_standard")) standard.push(q);
    else if (d.includes("hard")) hard.push(q);
    else {
      // unknown -> treat as standard pool to avoid starving selection
      standard.push(q);
    }
  }
  return { easy, medium, standard, advanced, hard };
}

function applyDifficulty(all, difficulty, count) {
  // If there is no meaningful difficulty in bank, do nothing
  const hasAny = all.some((q) => normDiff(q.difficulty));
  if (!hasAny) return all;

  const pools = splitByDifficulty(all);

  const takeFrom = (arr, n) => shuffle(arr).slice(0, Math.min(n, arr.length));

  if (difficulty === "easy") return pools.easy.length ? pools.easy : all;
  if (difficulty === "medium") return pools.medium.length ? pools.medium : all;
  if (difficulty === "hard_standard") {
    // prefer standard + hard
    const mix = [...pools.standard, ...pools.hard];
    return mix.length ? mix : all;
  }
  if (difficulty === "hard_advanced") {
    // prefer advanced + hard
    const mix = [...pools.advanced, ...pools.hard];
    return mix.length ? mix : all;
  }
  if (difficulty === "hard_mix") {
    // 70% standard/hard_standard + 30% advanced/hard_advanced
    const nStd = Math.round(count * 0.7);
    const nAdv = count - nStd;
    const stdPool = [...pools.standard, ...pools.hard, ...pools.medium];
    const advPool = [...pools.advanced, ...pools.hard];

    const pickedStd = takeFrom(stdPool, nStd);
    const pickedAdv = takeFrom(advPool, nAdv);

    const merged = dedupQuestions([...pickedStd, ...pickedAdv]);
    return merged.length ? merged : all;
  }

  // mixed (exam-like) or unknown
  return all;
}

/* -------------------------
   Build attempt
-------------------------- */
function buildAttempt() {
  const bankIds = getSelectedBanks();
  if (!bankIds.length) throw new Error("Select at least one bank");

  const count = Math.max(5, Math.min(200, Number($("#count")?.value || 75)));
  const timerMin = Math.max(5, Math.min(240, Number($("#timer")?.value || 90)));
  const mode = $("#mode")?.value || "exam";
  const shuffleOpts = !!$("#shuffleOptions")?.checked;
  const avoidAcross = !!$("#avoidAcross")?.checked;
  const difficulty = $("#difficulty")?.value || "mixed";

  state.config = {
    ...state.config,
    bankIds,
    count,
    timerMinutes: timerMin,
    mode,
    shuffleOptions: shuffleOpts,
    avoidAcrossAttempts: avoidAcross,
    difficulty
  };

  let all = [];
  for (const id of bankIds) {
    all = all.concat(state.banksData.get(id) || []);
  }

  all = dedupQuestions(all);

  // Apply difficulty (filter/weight pools)
  const allForPick = applyDifficulty(all, difficulty, count);

  const seenGlobal = avoidAcross ? Storage.loadSeenSet() : new Set();
  let picked = pickNoRepeat(allForPick, count, seenGlobal);

  // Shuffle questions order
  picked = shuffle(picked);

  // Shuffle options if requested (keeps correct mapping)
  if (shuffleOpts) {
    picked = picked.map((q) => shuffleOptions(q));
  }

  const answersMap = new Map(); // index -> chosen option index
  const flaggedSet = new Set(); // indices flagged for review
  const startTs = Date.now();
  const timeLimitSec = timerMin * 60;

  state.attempt = {
    questions: picked,
    answersMap,
    flaggedSet,
    startTs,
    timeLimitSec,
    mode,
    meta: {
      banks: bankIds.slice(),
      difficulty
    }
  };
  state.ui.current = 0;
  state.ui.locked = false;
  state.ui.inReview = false;

  // update global seen set immediately for picked keys
  if (avoidAcross) {
    for (const q of picked) seenGlobal.add(qKey(q));
    Storage.saveSeenSet(seenGlobal);
  }
}

/* -------------------------
   Views
-------------------------- */
function showExam() {
  $("#view-start")?.classList.add("hidden");
  $("#view-review")?.classList.add("hidden");
  $("#view-exam")?.classList.remove("hidden");
  $("#view-report")?.classList.add("hidden");

  renderNavigator();
  renderQuestion();
  startTimerLoop();

  // Track label
  const banks = state.config.bankIds.join(", ");
  setText("pvTrackLabel", `Track: ${banks}`);
}

function showReview() {
  $("#view-start")?.classList.add("hidden");
  $("#view-exam")?.classList.add("hidden");
  $("#view-report")?.classList.add("hidden");
  $("#view-review")?.classList.remove("hidden");

  renderReviewGrid();
}

function showReport(res, elapsedSec, autoTimeExpired = false) {
  $("#view-start")?.classList.add("hidden");
  $("#view-exam")?.classList.add("hidden");
  $("#view-review")?.classList.add("hidden");
  $("#view-report")?.classList.remove("hidden");

  const pct = Math.round(res.pct * 10) / 10;
  const banks = state.config.bankIds.join(", ");
  const diff = state.config.difficulty;

  const timePill = autoTimeExpired ? `<span class="pill"><b>Status:</b> TIME EXPIRED</span>` : "";

  // scoreLine/reportMeta exist in your HTML
  setHTML(
    "scoreLine",
    `<span class="pill"><b>Score:</b> ${res.correct}/${res.total} (${pct}%)</span>
     <span class="pill"><b>Time:</b> ${formatTime(elapsedSec)}</span>
     <span class="pill"><b>Mode:</b> ${state.config.mode}</span>
     <span class="pill"><b>Difficulty:</b> ${diff}</span>
     ${timePill}`
  );
  setText("reportMeta", `Banks: ${banks} • Questions: ${res.total}`);

  // Build review list (with explanations, tags, topics)
  const list = $("#reviewList");
  if (!list) return;
  list.innerHTML = "";

  const a = state.attempt_snapshot; // stored snapshot for report
  res.details.forEach((d) => {
    const q = a.questions[d.index];
    const chosen = d.chosen;
    const ok = d.ok;

    const item = document.createElement("div");
    item.className = "pv-panel";
    item.style.padding = "14px";

    const tagText =
      (q.tags && q.tags.length ? q.tags.join(", ") : (q.topic || "")) || "";
    const diffText = q.difficulty ? ` • <span style="color:#64748b">${q.difficulty}</span>` : "";

    item.innerHTML = `
      <div class="pill" style="display:inline-block;margin-bottom:8px;">
        <b>Q${d.index + 1}</b> • ${
          ok
            ? "<span style='color:#10b981;font-weight:900'>Correct</span>"
            : "<span style='color:#ef4444;font-weight:900'>Wrong</span>"
        }
        • <span style="color:#64748b;font-weight:900">${q.bank_id}</span>${diffText}
      </div>
      <div style="font-weight:900;font-size:15px;margin:6px 0 10px 0;">${q.question}</div>
      ${
        tagText
          ? `<div style="color:#475569;font-weight:800;font-size:12px;margin-bottom:8px;">Tags/Topic: ${tagText}</div>`
          : ""
      }
    `;

    const choices = document.createElement("div");
    choices.className = "pv-choices";
    q.options.forEach((opt, i) => {
      const c = document.createElement("div");
      c.className = "pv-opt";
      c.style.margin = "8px 0";
      // highlight correct/wrong like Pearson review
      if (i === q.answer_index) {
        c.style.borderColor = "#10b981";
        c.style.background = "#ecfdf5";
      }
      if (!ok && chosen === i && i !== q.answer_index) {
        c.style.borderColor = "#ef4444";
        c.style.background = "#fff1f2";
      }
      c.innerHTML = `<div style="font-weight:900;width:28px;">${String.fromCharCode(
        65 + i
      )})</div><div>${opt}</div>`;
      choices.appendChild(c);
    });
    item.appendChild(choices);

    if (q.explain) {
      const exp = document.createElement("div");
      exp.style.marginTop = "10px";
      exp.style.padding = "10px 12px";
      exp.style.border = "1px dashed #cbd5e1";
      exp.style.borderRadius = "10px";
      exp.style.background = "#f8fafc";
      exp.innerHTML = `<div style="font-weight:900;margin-bottom:6px;">Explanation</div>
                       <div style="color:#0f172a;font-weight:700;line-height:1.5;">${q.explain}</div>`;
      item.appendChild(exp);
    }

    list.appendChild(item);
  });
}

/* -------------------------
   Timer
-------------------------- */
let timerHandle = null;

function updateTimeUI(leftSec) {
  const t = formatTime(leftSec);
  setText("timerBox", t);
  setText("pvTimePill", `Time Remaining: ${t}`);
}

function startTimerLoop() {
  if (timerHandle) clearInterval(timerHandle);
  timerHandle = setInterval(() => {
    if (!state.attempt) return;
    const elapsed = (Date.now() - state.attempt.startTs) / 1000;
    const left = state.attempt.timeLimitSec - elapsed;

    updateTimeUI(Math.max(0, left));

    if (left <= 0) {
      clearInterval(timerHandle);
      finishExam(true);
    }
  }, 250);

  // initial render
  updateTimeUI(state.attempt.timeLimitSec);
}

/* -------------------------
   Navigator + Question render
-------------------------- */
function renderNavigator() {
  const navWrap = $("#nav");
  if (!navWrap) return;
  navWrap.innerHTML = "";

  const a = state.attempt;
  a.questions.forEach((_, i) => {
    const b = document.createElement("button");
    b.className = "pv-qbtn";
    b.textContent = String(i + 1);
    b.type = "button";
    b.addEventListener("click", () => {
      state.ui.current = i;
      renderQuestion();
      updateNavigatorState();
    });
    navWrap.appendChild(b);
  });

  updateNavigatorState();
}

function updateNavigatorState() {
  const a = state.attempt;
  const buttons = Array.from(document.querySelectorAll("#nav .pv-qbtn"));
  buttons.forEach((b, i) => {
    b.classList.toggle("active", i === state.ui.current);
    b.classList.toggle("answered", a.answersMap.has(i));
    b.classList.toggle("flagged", a.flaggedSet.has(i));
  });
}

function renderQuestion() {
  const a = state.attempt;
  const idx = state.ui.current;
  const q = a.questions[idx];

  // Progress / track label
  setText("pvProgress", `${idx + 1} of ${a.questions.length}`);
  setText("pvTrackLabel", `Track: ${state.config.bankIds.join(", ")}`);

  // Question text
  const qTextEl = $("#qText");
  if (qTextEl) qTextEl.textContent = q.question;

  const chosen = a.answersMap.get(idx);
  const flagged = a.flaggedSet.has(idx);
  const flagBtn = $("#flagBtn");
  if (flagBtn) flagBtn.textContent = flagged ? "Unflag" : "Flag for Review";

  const wrap = $("#choices");
  if (!wrap) return;
  wrap.innerHTML = "";

  q.options.forEach((opt, i) => {
    const row = document.createElement("div");
    row.className = "pv-opt" + (chosen === i ? " selected" : "");
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.innerHTML = `
      <input type="radio" name="opt" ${chosen === i ? "checked" : ""} />
      <div><b style="margin-right:6px">${String.fromCharCode(65 + i)})</b> ${opt}</div>
    `;
    row.addEventListener("click", () => choose(i));
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        choose(i);
      }
    });
    wrap.appendChild(row);
  });

  const prevBtn = $("#prevBtn");
  const nextBtn = $("#nextBtn");
  if (prevBtn) prevBtn.disabled = idx === 0;
  if (nextBtn) nextBtn.disabled = idx === a.questions.length - 1;

  updateNavigatorState();
}

function choose(i) {
  const a = state.attempt;
  const idx = state.ui.current;
  a.answersMap.set(idx, i);
  renderQuestion();
}

function nav(delta) {
  const a = state.attempt;
  state.ui.current = Math.max(0, Math.min(a.questions.length - 1, state.ui.current + delta));
  renderQuestion();
}

function toggleFlag() {
  const a = state.attempt;
  const idx = state.ui.current;
  if (a.flaggedSet.has(idx)) a.flaggedSet.delete(idx);
  else a.flaggedSet.add(idx);
  renderQuestion();
}

/* -------------------------
   Review screen
-------------------------- */
function renderReviewGrid() {
  const a = state.attempt;
  const grid = $("#reviewGrid");
  const summary = $("#reviewSummary");
  if (!grid) return;

  grid.innerHTML = "";

  let unanswered = 0;
  let flagged = 0;

  a.questions.forEach((_, i) => {
    const answered = a.answersMap.has(i);
    const isFlag = a.flaggedSet.has(i);
    if (!answered) unanswered++;
    if (isFlag) flagged++;

    const b = document.createElement("button");
    b.type = "button";
    b.className = "pv-qbtn";
    b.textContent = String(i + 1);

    if (answered) b.classList.add("answered");
    if (isFlag) b.classList.add("flagged");

    b.addEventListener("click", () => {
      // jump back to exam question
      state.ui.current = i;
      $("#view-review")?.classList.add("hidden");
      $("#view-exam")?.classList.remove("hidden");
      renderQuestion();
    });

    grid.appendChild(b);
  });

  if (summary) {
    summary.textContent = `Unanswered: ${unanswered} • Flagged: ${flagged} • You can click any question number to return.`;
  }
}

/* -------------------------
   Finish / Report
-------------------------- */
function finishExam(auto = false) {
  const a = state.attempt;
  if (!a) return;

  // Snapshot attempt for report (because we null it after)
  state.attempt_snapshot = {
    questions: a.questions,
    answersMap: new Map(a.answersMap),
    flaggedSet: new Set(a.flaggedSet),
    startTs: a.startTs,
    timeLimitSec: a.timeLimitSec,
    mode: a.mode,
    meta: a.meta
  };

  const res = scoreAttempt(a.questions, a.answersMap);
  const elapsedSec = (Date.now() - a.startTs) / 1000;

  const attemptRecord = {
    date: new Date().toISOString(),
    mode: a.mode,
    banks: state.config.bankIds,
    count: a.questions.length,
    correct: res.correct,
    pct: Math.round(res.pct * 10) / 10,
    elapsed_sec: Math.round(elapsedSec),
    flagged: Array.from(a.flaggedSet),
    difficulty: state.config.difficulty,
    auto_time_expired: !!auto
  };
  Storage.saveAttempt(attemptRecord);

  if (timerHandle) clearInterval(timerHandle);

  // destroy attempt (we keep snapshot for report)
  state.attempt = null;

  showReport(res, elapsedSec, auto);
}

/* -------------------------
   Events
-------------------------- */
function wireEvents() {
  $("#startBtn")?.addEventListener("click", async () => {
    try {
      const bankIds = getSelectedBanks();
      await ensureBanksLoaded(bankIds);
      buildAttempt();
      showExam();
    } catch (e) {
      alert(e.message || String(e));
    }
  });

  $("#prevBtn")?.addEventListener("click", () => nav(-1));
  $("#nextBtn")?.addEventListener("click", () => nav(1));
  $("#flagBtn")?.addEventListener("click", toggleFlag);

  // End Exam -> go Review screen (Pearson-like)
  $("#finishBtn")?.addEventListener("click", () => {
    if (!state.attempt) return;
    showReview();
  });

  $("#returnToExamBtn")?.addEventListener("click", () => {
    $("#view-review")?.classList.add("hidden");
    $("#view-exam")?.classList.remove("hidden");
    renderQuestion();
  });

  $("#submitExamBtn")?.addEventListener("click", () => {
    if (!state.attempt) return;

    // Pearson-like modal if available
    if (window.PVModal?.open) {
      window.PVModal.open({
        title: "Submit Exam",
        body: "Are you sure you want to submit your exam? You will see your score report and explanations.",
        buttons: [
          { label: "Cancel", cls: "pv-btn secondary", onClick: () => window.PVModal.close() },
          {
            label: "Submit",
            cls: "pv-btn danger",
            onClick: () => {
              window.PVModal.close();
              finishExam(false);
            }
          }
        ]
      });
      return;
    }

    const ok = confirm("Submit the exam?");
    if (ok) finishExam(false);
  });

  $("#newAttemptBtn")?.addEventListener("click", () => {
    // Go back to start view (do not clear seen-history unless user hits Reset)
    renderStart();
  });

  $("#clearStorageBtn")?.addEventListener("click", () => {
    const ok = confirm("Clear saved attempts + seen-question history?");
    if (ok) {
      Storage.clearAll();
      alert("Cleared.");
      renderStart();
    }
  });

  // Change Track (top bar)
  $("#pvChangeTrackBtn")?.addEventListener("click", () => {
    // cancel running attempt + timer
    if (timerHandle) clearInterval(timerHandle);
    state.attempt = null;
    state.attempt_snapshot = null;
    renderStart();
  });

  // Keyboard shortcuts (only in exam view)
  document.addEventListener("keydown", (e) => {
    if ($("#view-exam")?.classList.contains("hidden")) return;
    if (!state.attempt) return;

    if (e.key === "ArrowLeft") nav(-1);
    if (e.key === "ArrowRight") nav(1);
    if (e.key.toLowerCase() === "f") toggleFlag();
    if (["1", "2", "3", "4"].includes(e.key)) choose(Number(e.key) - 1);
  });
}

/* -------------------------
   Main
-------------------------- */
async function main() {
  state.manifest = await loadManifest();
  renderStart();
  wireEvents();
}
main();
