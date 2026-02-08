# RSO Exam Simulator (Rebuild)

A lightweight, GitHub Pages–friendly exam simulator inspired by real testing flows:
- Choose one or multiple question banks (JSON)
- No repetition (dedup within attempt; optional avoid repeats across attempts via localStorage)
- Timer
- Flag for review
- Score report + full review

## Run locally
Because this uses `fetch()`, use a local server:

```bash
python -m http.server 8000
# then open http://localhost:8000
```

## Deploy on GitHub Pages
- Push the folder contents to a repo
- Settings → Pages → Deploy from branch (`main`) → Root
- Open the GitHub Pages URL

## Add a new bank
1. Put your file in `/banks/<name>.json`
2. Add an entry to `/banks/banks.json`

Bank format (array of questions):
```json
[
  {
    "id": 1,
    "question": "…",
    "options": ["A","B","C","D"],
    "answer_index": 2,
    "topic": "optional",
    "difficulty": "optional"
  }
]
```

This project also accepts wrapper format:
```json
{ "meta": {...}, "questions": [ ... ] }
```