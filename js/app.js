import { Storage } from "./storage.js";
import { dedupQuestions, pickNoRepeat, shuffle, shuffleOptions, scoreAttempt, formatTime, qKey } from "./engine.js";

const $ = (sel) => document.querySelector(sel);

const state = {
  manifest: null,
  banksData: new Map(),   // bankId -> questions array
  config: {
    mode: "exam",          // practice | exam
    bankIds: [],
    count: 75,
    shuffleOptions: true,
    avoidAcrossAttempts: true,
    timerMinutes: 90,      // default NRRC-style, user can change
    showReviewAfter: true
  },
  attempt: null,          // {questions, answersMap, flaggedSet, startTs, timeLimitSec}
  ui: {
    current: 0,
    locked: false,
    inReview: false
  }
};

async function loadManifest(){
  const res = await fetch("./banks/banks.json");
  if (!res.ok) throw new Error("Cannot load banks manifest");
  return res.json();
}

async function loadBankFile(file){
  const res = await fetch(`./banks/${file}`);
  if (!res.ok) throw new Error("Cannot load bank file: " + file);
  return res.json();
}

function normalizeBankQuestions(bankId, raw){
  // Support either array or {meta,questions} wrapper
  const arr = Array.isArray(raw) ? raw : (raw && raw.questions ? raw.questions : []);
  return arr.map((q, idx) => ({
    bank_id: bankId,
    id: q.id ?? (idx+1),
    question: q.question,
    options: q.options,
    answer_index: q.answer_index,
    explain: q.explain || "",
    difficulty: q.difficulty || "",
    topic: q.topic || ""
  })).filter(q => q.question && Array.isArray(q.options) && q.options.length === 4 && Number.isInteger(q.answer_index));
}

function renderStart(){
  $("#view-start").classList.remove("hidden");
  $("#view-exam").classList.add("hidden");
  $("#view-report").classList.add("hidden");

  const banksWrap = $("#banks-list");
  banksWrap.innerHTML = "";
  for (const b of state.manifest.banks){
    const id = b.id;
    const item = document.createElement("label");
    item.style.display = "flex";
    item.style.gap = "10px";
    item.style.alignItems = "center";
    item.style.padding = "8px 10px";
    item.style.border = "1px solid rgba(255,255,255,.08)";
    item.style.borderRadius = "12px";
    item.style.background = "rgba(0,0,0,.20)";
    item.innerHTML = `
      <input type="checkbox" value="${id}" />
      <div style="flex:1">
        <div style="font-weight:700">${b.title}</div>
        <div style="color:#a9b4c2;font-size:12px">${b.count ?? ""} questions</div>
      </div>
    `;
    banksWrap.appendChild(item);
  }

  // Defaults
  $("#mode").value = state.config.mode;
  $("#count").value = state.config.count;
  $("#timer").value = state.config.timerMinutes;
  $("#shuffleOptions").checked = state.config.shuffleOptions;
  $("#avoidAcross").checked = state.config.avoidAcrossAttempts;

  // Quick select first bank
  const first = banksWrap.querySelector("input[type=checkbox]");
  if (first) first.checked = true;
}

function getSelectedBanks(){
  return Array.from(document.querySelectorAll("#banks-list input[type=checkbox]:checked")).map(i => i.value);
}

async function ensureBanksLoaded(bankIds){
  for (const bankId of bankIds){
    if (state.banksData.has(bankId)) continue;
    const meta = state.manifest.banks.find(b => b.id === bankId);
    if (!meta) throw new Error("Unknown bank: " + bankId);
    const raw = await loadBankFile(meta.file);
    const qs = normalizeBankQuestions(bankId, raw);
    state.banksData.set(bankId, qs);
  }
}

function buildAttempt(){
  const bankIds = getSelectedBanks();
  if (!bankIds.length) throw new Error("Select at least one bank");

  const count = Math.max(5, Math.min(200, Number($("#count").value || 75)));
  const timerMin = Math.max(5, Math.min(240, Number($("#timer").value || 90)));
  const mode = $("#mode").value;
  const shuffleOpts = $("#shuffleOptions").checked;
  const avoidAcross = $("#avoidAcross").checked;

  state.config = { ...state.config, bankIds, count, timerMinutes: timerMin, mode, shuffleOptions: shuffleOpts, avoidAcrossAttempts: avoidAcross };

  let all = [];
  for (const id of bankIds){
    all = all.concat(state.banksData.get(id) || []);
  }
  all = dedupQuestions(all);

  const seenGlobal = avoidAcross ? Storage.loadSeenSet() : new Set();
  let picked = pickNoRepeat(all, count, seenGlobal);

  // Shuffle questions
  picked = shuffle(picked);

  // Shuffle options if requested
  if (shuffleOpts){
    picked = picked.map(q => shuffleOptions(q));
  }

  const answersMap = new Map();      // index -> chosen option index
  const flaggedSet = new Set();      // indices flagged for review
  const startTs = Date.now();
  const timeLimitSec = timerMin * 60;

  state.attempt = { questions: picked, answersMap, flaggedSet, startTs, timeLimitSec, mode };
  state.ui.current = 0;
  state.ui.locked = false;
  state.ui.inReview = false;

  // update global seen set immediately for picked keys
  if (avoidAcross){
    for (const q of picked){
      seenGlobal.add(qKey(q));
    }
    Storage.saveSeenSet(seenGlobal);
  }
}

function showExam(){
  $("#view-start").classList.add("hidden");
  $("#view-exam").classList.remove("hidden");
  $("#view-report").classList.add("hidden");
  renderQuestion();
  startTimerLoop();
}

let timerHandle = null;
function startTimerLoop(){
  if (timerHandle) clearInterval(timerHandle);
  timerHandle = setInterval(() => {
    if (!state.attempt) return;
    const elapsed = (Date.now() - state.attempt.startTs)/1000;
    const left = state.attempt.timeLimitSec - elapsed;
    $("#timerBox").textContent = formatTime(left);
    if (left <= 0){
      clearInterval(timerHandle);
      finishExam(true);
    }
  }, 250);
}

function renderQuestion(){
  const a = state.attempt;
  const idx = state.ui.current;
  const q = a.questions[idx];

  $("#qNum").textContent = `Q${idx+1} / ${a.questions.length}`;
  $("#qText").textContent = q.question;

  const chosen = a.answersMap.get(idx);
  const flagged = a.flaggedSet.has(idx);
  $("#flagBtn").textContent = flagged ? "Unflag" : "Flag for review";

  const wrap = $("#choices");
  wrap.innerHTML = "";
  q.options.forEach((opt, i) => {
    const div = document.createElement("div");
    div.className = "choice" + (chosen === i ? " selected" : "");
    div.tabIndex = 0;
    div.setAttribute("role","button");
    div.innerHTML = `<div class="letter">${String.fromCharCode(65+i)})</div><div>${opt}</div>`;
    div.addEventListener("click", () => choose(i));
    div.addEventListener("keydown", (e)=>{
      if (e.key === "Enter" || e.key === " "){ e.preventDefault(); choose(i); }
    });
    wrap.appendChild(div);
  });

  $("#prevBtn").disabled = idx === 0;
  $("#nextBtn").disabled = idx === a.questions.length-1;
}

function choose(i){
  const a = state.attempt;
  const idx = state.ui.current;
  a.answersMap.set(idx, i);
  renderQuestion();
}

function nav(delta){
  const a = state.attempt;
  state.ui.current = Math.max(0, Math.min(a.questions.length-1, state.ui.current + delta));
  renderQuestion();
}

function toggleFlag(){
  const a = state.attempt;
  const idx = state.ui.current;
  if (a.flaggedSet.has(idx)) a.flaggedSet.delete(idx);
  else a.flaggedSet.add(idx);
  renderQuestion();
}

function finishExam(auto=false){
  const a = state.attempt;
  if (!a) return;
  const res = scoreAttempt(a.questions, a.answersMap);
  const elapsedSec = (Date.now() - a.startTs)/1000;
  const attemptRecord = {
    date: new Date().toISOString(),
    mode: a.mode,
    banks: state.config.bankIds,
    count: a.questions.length,
    correct: res.correct,
    pct: Math.round(res.pct*10)/10,
    elapsed_sec: Math.round(elapsedSec),
    flagged: Array.from(a.flaggedSet),
  };
  Storage.saveAttempt(attemptRecord);

  // Render report
  $("#view-start").classList.add("hidden");
  $("#view-exam").classList.add("hidden");
  $("#view-report").classList.remove("hidden");

  $("#scoreLine").innerHTML = `<span class="pill"><b>Score:</b> ${res.correct}/${res.total} (${attemptRecord.pct}%)</span> <span class="pill"><b>Time:</b> ${formatTime(elapsedSec)}</span> <span class="pill"><b>Mode:</b> ${a.mode}</span>`;
  $("#reportMeta").textContent = `Banks: ${state.config.bankIds.join(", ")} • Questions: ${res.total}`;

  // Build review list
  const list = $("#reviewList");
  list.innerHTML = "";
  res.details.forEach(d => {
    const q = a.questions[d.index];
    const chosen = d.chosen;
    const ok = d.ok;

    const item = document.createElement("div");
    item.className = "panel";
    item.style.padding = "14px";
    item.innerHTML = `
      <div class="pill"><b>Q${d.index+1}</b> • ${ok ? "<span style='color:#57d39c'>Correct</span>" : "<span style='color:#ff6b6b'>Wrong</span>"} • <span style="color:#a9b4c2">${q.bank_id}</span></div>
      <div class="question" style="margin-top:8px">${q.question}</div>
    `;
    const choices = document.createElement("div");
    choices.className = "choices";
    q.options.forEach((opt, i) => {
      const c = document.createElement("div");
      c.className = "choice";
      if (i === q.answer_index) c.classList.add("correct");
      if (!ok && chosen === i && i !== q.answer_index) c.classList.add("wrong");
      c.innerHTML = `<div class="letter">${String.fromCharCode(65+i)})</div><div>${opt}</div>`;
      choices.appendChild(c);
    });
    item.appendChild(choices);

    list.appendChild(item);
  });

  if (timerHandle) clearInterval(timerHandle);
  state.attempt = null;
}

function wireEvents(){
  $("#startBtn").addEventListener("click", async ()=>{
    try{
      const bankIds = getSelectedBanks();
      await ensureBanksLoaded(bankIds);
      buildAttempt();
      showExam();
    }catch(e){
      alert(e.message || String(e));
    }
  });
  $("#prevBtn").addEventListener("click", ()=>nav(-1));
  $("#nextBtn").addEventListener("click", ()=>nav(1));
  $("#flagBtn").addEventListener("click", toggleFlag);
  $("#finishBtn").addEventListener("click", ()=>{
    const ok = confirm("Finish and submit the exam?");
    if (ok) finishExam(false);
  });
  $("#newAttemptBtn").addEventListener("click", ()=>renderStart());
  $("#clearStorageBtn").addEventListener("click", ()=>{
    const ok = confirm("Clear saved attempts + seen-question history?");
    if (ok){ Storage.clearAll(); alert("Cleared."); }
  });

  // Keyboard shortcuts
  document.addEventListener("keydown", (e)=>{
    if ($("#view-exam").classList.contains("hidden")) return;
    if (e.key === "ArrowLeft") nav(-1);
    if (e.key === "ArrowRight") nav(1);
    if (e.key.toLowerCase() === "f") toggleFlag();
    if (["1","2","3","4"].includes(e.key)){
      choose(Number(e.key)-1);
    }
  });
}

async function main(){
  state.manifest = await loadManifest();
  renderStart();
  wireEvents();
}
main();