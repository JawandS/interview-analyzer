export class ThinkParser {
  constructor(onThink, onResponse) {
    this.onThink    = onThink;
    this.onResponse = onResponse;
    this.inThink    = false;
    this.buf        = '';
  }

  push(token) {
    this.buf += token;
    this._drain();
  }

  flush() {
    if (!this.buf) return;
    (this.inThink ? this.onThink : this.onResponse)(this.buf);
    this.buf = '';
  }

  _drain() {
    const open = '<think>', close = '</think>';
    while (this.buf) {
      const tag = this.inThink ? close : open;
      const idx = this.buf.indexOf(tag);

      if (idx !== -1) {
        const before = this.buf.slice(0, idx);
        if (before) (this.inThink ? this.onThink : this.onResponse)(before);
        this.buf     = this.buf.slice(idx + tag.length);
        this.inThink = !this.inThink;
        continue;
      }

      // Hold back a possible partial tag at the tail
      let hold = 0;
      for (let i = tag.length - 1; i >= 1; i--) {
        if (this.buf.endsWith(tag.slice(0, i))) { hold = i; break; }
      }
      const safe = this.buf.slice(0, this.buf.length - hold);
      if (safe) (this.inThink ? this.onThink : this.onResponse)(safe);
      this.buf = hold ? this.buf.slice(-hold) : '';
      break;
    }
  }
}
