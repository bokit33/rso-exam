export function normalizeText(s){
  return (s || "")
    .toLowerCase()
    .replace(/[\u2000-\u200F\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function qKey(q){
  // Prefer stable IDs if provided, otherwise use normalized question text
  if (q && q.id !== undefined && q.id !== null) return String(q.bank_id || "") + "::" + String(q.id);
  return String(q.bank_id || "") + "::" + normalizeText(q.question);
}

export function shuffle(arr){
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function shuffleOptions(q){
  const idx = [0,1,2,3];
  const shuffledIdx = shuffle(idx);
  const newOpts = shuffledIdx.map(i => q.options[i]);
  const newAns = shuffledIdx.indexOf(q.answer_index);
  return { ...q, options: newOpts, answer_index: newAns };
}

export function dedupQuestions(questions){
  const seen = new Set();
  const out = [];
  for (const q of questions){
    const k = qKey(q);
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(q);
  }
  return out;
}

export function pickNoRepeat(questions, n, seenGlobalSet){
  // prefer unseen; if not enough, fall back to remaining
  const unseen = [];
  const seen = [];
  for (const q of questions){
    const k = qKey(q);
    if (seenGlobalSet && seenGlobalSet.has(k)) seen.push(q);
    else unseen.push(q);
  }
  const picked = [];
  const pool1 = shuffle(unseen);
  const pool2 = shuffle(seen);
  for (const q of pool1){
    if (picked.length >= n) break;
    picked.push(q);
  }
  for (const q of pool2){
    if (picked.length >= n) break;
    picked.push(q);
  }
  return picked;
}

export function scoreAttempt(questions, answersMap){
  let correct = 0;
  const details = questions.map((q, i) => {
    const chosen = answersMap.get(i);
    const ok = chosen === q.answer_index;
    if (ok) correct += 1;
    return { index: i, ok, chosen, answer: q.answer_index };
  });
  return { correct, total: questions.length, pct: questions.length ? (correct/questions.length)*100 : 0, details };
}

export function formatTime(seconds){
  const s = Math.max(0, Math.floor(seconds));
  const mm = String(Math.floor(s/60)).padStart(2,"0");
  const ss = String(s%60).padStart(2,"0");
  return `${mm}:${ss}`;
}