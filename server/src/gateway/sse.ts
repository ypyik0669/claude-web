// Incremental Server-Sent Events parsing / writing (text/event-stream, per the WHATWG spec:
// events separated by a blank line, `event:` / `data:` fields, multi-line data joined with \n,
// `:` comments ignored, CRLF / CR / LF all accepted — Gemini uses \r\n\r\n).

export interface SseEvent { event?: string; data: string }

export class SseParser {
  private buf = '';
  private event: string | undefined;
  private data: string[] = [];

  feed(chunk: string): SseEvent[] {
    this.buf += chunk;
    const out: SseEvent[] = [];
    let i: number;
    // keep a trailing lone \r in the buffer: it may be the first half of a \r\n split across chunks
    while ((i = this.nextBreak()) >= 0) {
      const line = this.buf.slice(0, i);
      const len = this.buf[i] === '\r' && this.buf[i + 1] === '\n' ? 2 : 1;
      this.buf = this.buf.slice(i + len);
      this.line(line, out);
    }
    return out;
  }

  /** Flush a final event that was not followed by a blank line. */
  end(): SseEvent[] {
    const out: SseEvent[] = [];
    if (this.buf) { this.line(this.buf, out); this.buf = ''; }
    this.line('', out);
    return out;
  }

  private nextBreak(): number {
    for (let i = 0; i < this.buf.length; i++) {
      const c = this.buf[i];
      if (c === '\n') return i;
      if (c === '\r') return i + 1 < this.buf.length ? i : -1;
    }
    return -1;
  }

  private line(line: string, out: SseEvent[]) {
    if (line === '') {
      if (this.data.length || this.event) out.push({ event: this.event, data: this.data.join('\n') });
      this.event = undefined;
      this.data = [];
      return;
    }
    if (line.startsWith(':')) return;
    const c = line.indexOf(':');
    const field = c < 0 ? line : line.slice(0, c);
    let value = c < 0 ? '' : line.slice(c + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
  }
}

export const sse = (data: unknown, event?: string) => `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
