export const Storage = {
  keyAttempts: "rso_attempts_v1",
  keySeen: "rso_seen_keys_v1",

  loadSeenSet(){
    try{
      const raw = localStorage.getItem(this.keySeen);
      const arr = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(arr) ? arr : []);
    }catch{ return new Set(); }
  },
  saveSeenSet(set){
    const arr = Array.from(set).slice(0, 20000);
    localStorage.setItem(this.keySeen, JSON.stringify(arr));
  },

  loadAttempts(){
    try{
      const raw = localStorage.getItem(this.keyAttempts);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    }catch{ return []; }
  },
  saveAttempt(attempt){
    const prev = this.loadAttempts();
    prev.unshift(attempt);
    localStorage.setItem(this.keyAttempts, JSON.stringify(prev.slice(0, 30)));
  },
  clearAll(){
    localStorage.removeItem(this.keyAttempts);
    localStorage.removeItem(this.keySeen);
  }
};