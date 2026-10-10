// Runs INSIDE a page of the built-in browser (injected as text before each operation an Agent asks for — see ops.ts;
// imported with `?raw`, never bundled as code). Plain script, no imports, idempotent: it installs `window.__cwAgent`
// once per document.
//
// What it gives back is the page's own content — the server marks it as untrusted before a model sees it. Everything
// returned is plain JSON.
(() => {
  if (window.__cwAgent && window.__cwAgent.v === 1) return;

  /** ref → element (weakly: a removed element's ref just stops resolving), element → ref (stable while it lives). */
  const byRef = new Map();
  const refOf = new WeakMap();
  let seq = 0;
  // Every document has its own three letters in front of its refs (`kqz12`): a ref the model kept from the page
  // before must not point at whatever happens to be number 12 on this one.
  const TAG = (() => {
    let n = Math.floor(Math.random() * 17576);
    let s = '';
    for (let i = 0; i < 3; i++) { s += String.fromCharCode(97 + (n % 26)); n = Math.floor(n / 26); }
    return s;
  })();

  const SEL = [
    'a[href]', 'button', 'input:not([type="hidden"])', 'textarea', 'select', 'summary',
    '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]', '[role="option"]', '[role="checkbox"]',
    '[role="radio"]', '[role="switch"]', '[role="combobox"]', '[role="textbox"]', '[role="searchbox"]',
    '[contenteditable=""]', '[contenteditable="true"]', '[onclick]',
  ].join(',');
  const MAX_ELEMENTS = 600;
  const MAX_TEXT = 2000000;

  const clean = (s, max) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);

  function shown(el) {
    if (!el.isConnected) return false;
    if (typeof el.checkVisibility === 'function') {
      try { return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }); } catch (e) { /* older signature */ }
    }
    if (!el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  function roleOf(el) {
    const r = el.getAttribute('role');
    if (r) return r;
    const t = el.tagName.toLowerCase();
    if (t === 'a') return 'link';
    if (t === 'summary') return 'button';
    if (t === 'input') {
      const ty = (el.getAttribute('type') || 'text').toLowerCase();
      if (ty === 'submit' || ty === 'button' || ty === 'reset' || ty === 'image') return 'button';
      if (ty === 'checkbox' || ty === 'radio') return ty;
      return 'input';
    }
    if (t !== 'textarea' && t !== 'select' && t !== 'button' && el.isContentEditable) return 'textbox';
    return t;
  }

  function labelText(el) {
    try {
      if (el.labels && el.labels.length) return el.labels[0].innerText;
      const by = el.getAttribute('aria-labelledby');
      if (by) return by.split(/\s+/).map((id) => { const n = document.getElementById(id); return n ? n.innerText : ''; }).join(' ');
    } catch (e) { /* no label */ }
    return '';
  }

  function nameOf(el) {
    const t = el.tagName;
    const field = t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT';
    const img = el.querySelector ? el.querySelector('img[alt], svg[aria-label]') : null;
    return clean(
      el.getAttribute('aria-label') || labelText(el)
      || (field ? el.getAttribute('placeholder') || el.getAttribute('name') : el.innerText || el.textContent)
      || el.getAttribute('title') || (img ? img.getAttribute('alt') || img.getAttribute('aria-label') : '')
      || (t === 'INPUT' && roleOf(el) === 'button' ? el.value : '') || (t === 'A' ? el.getAttribute('href') : ''),
      160,
    );
  }

  function valueOf(el) {
    const t = el.tagName;
    if (t === 'INPUT') {
      const ty = (el.getAttribute('type') || 'text').toLowerCase();
      if (ty === 'checkbox' || ty === 'radio') return el.checked ? 'checked' : 'unchecked';
      if (ty === 'password') return el.value ? '(hidden)' : '';
      if (ty === 'submit' || ty === 'button' || ty === 'reset' || ty === 'image' || ty === 'file') return undefined;
      return clean(el.value, 120);
    }
    if (t === 'TEXTAREA') return clean(el.value, 120);
    if (t === 'SELECT') return clean(el.selectedOptions && el.selectedOptions[0] ? el.selectedOptions[0].text : el.value, 120);
    const ch = el.getAttribute('aria-checked') || el.getAttribute('aria-selected') || el.getAttribute('aria-expanded');
    if (ch === 'true') return el.hasAttribute('aria-expanded') ? 'expanded' : 'checked';
    return undefined;
  }

  function describe(el) {
    let ref = refOf.get(el);
    if (!ref) {
      ref = TAG + (++seq);
      refOf.set(el, ref);
      byRef.set(ref, new WeakRef(el));
    }
    const out = { ref, role: roleOf(el), name: nameOf(el) };
    const v = valueOf(el);
    if (v !== undefined && v !== '') out.value = v;
    if (el.tagName === 'A') {
      const h = el.href;
      if (typeof h === 'string' && /^https?:/i.test(h)) out.href = h.slice(0, 400);
    }
    return out;
  }

  function elements() {
    const out = [];
    const seen = new Set();
    for (const el of document.querySelectorAll(SEL)) {
      if (out.length >= MAX_ELEMENTS) break;
      if (seen.has(el) || el.disabled || el.getAttribute('aria-disabled') === 'true' || el.getAttribute('aria-hidden') === 'true') continue;
      if (!shown(el)) continue;
      const d = describe(el);
      // a thing with no name says nothing to a reader — except a field, which is still somewhere to type
      if (!d.name && d.role !== 'input' && d.role !== 'textarea' && d.role !== 'textbox' && d.role !== 'select') continue;
      seen.add(el);
      out.push(d);
    }
    return out;
  }

  function fullText() {
    const raw = document.body ? document.body.innerText : (document.documentElement ? document.documentElement.textContent : '') || '';
    return String(raw).replace(/\r/g, '').replace(/[ \t\f\v\u00a0]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_TEXT);
  }

  const where = () => ({ url: location.href, title: clean(document.title, 300) });

  function get(ref) {
    const key = String(ref == null ? '' : ref).trim().replace(/^\[|\]$/g, '');
    const w = byRef.get(key) || byRef.get(TAG + key);
    const el = w ? w.deref() : null;
    if (!el || !el.isConnected) throw new Error('元素 [' + key + '] 不在页面上了（页面变过）。用 browser_read 或 browser_find 重新看一下现在有什么。');
    return el;
  }

  function fire(el, type, init) {
    const r = el.getBoundingClientRect();
    const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    const Ctor = type.indexOf('pointer') === 0 && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
    el.dispatchEvent(new Ctor(type, Object.assign(base, init || {})));
  }

  function setValue(el, text) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const d = Object.getOwnPropertyDescriptor(proto, 'value');
    if (d && d.set) d.set.call(el, text); else el.value = text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: text, inputType: 'insertText' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** The element that scrolls the page: the document, or — on app-like pages — the biggest scrolling box. */
  function scroller() {
    const doc = document.scrollingElement || document.documentElement;
    if (doc.scrollHeight > doc.clientHeight + 40) return doc;
    let best = null;
    let area = 0;
    for (const el of document.querySelectorAll('main, [role="main"], div, section, article')) {
      if (el.scrollHeight <= el.clientHeight + 40) continue;
      const oy = getComputedStyle(el).overflowY;
      if (oy !== 'auto' && oy !== 'scroll') continue;
      const a = el.clientWidth * el.clientHeight;
      if (a > area) { area = a; best = el; }
    }
    return best || doc;
  }

  window.__cwAgent = {
    v: 1,

    /** The page as text from `offset`, at most `maxChars`; the things to act on go with the start of the page. */
    read(o) {
      const offset = Math.max(0, Math.floor((o && o.offset) || 0));
      const max = Math.max(200, Math.floor((o && o.maxChars) || 12000));
      const all = fullText();
      const from = Math.min(offset, all.length);
      const text = all.slice(from, from + max);
      const page = Object.assign(where(), { text });
      if (from + text.length < all.length) { page.truncated = true; page.nextOffset = from + text.length; }
      if (from === 0) page.elements = elements();
      return { page, length: all.length };
    },

    /** Things to act on whose name / value / address has the words, and where the words occur in the text. */
    find(o) {
      const q = clean(o && o.query, 200).toLowerCase();
      if (!q) throw new Error('browser_find 需要参数 query');
      const hits = elements().filter((e) => e.name.toLowerCase().includes(q) || (e.value || '').toLowerCase().includes(q) || (e.href || '').toLowerCase().includes(q)).slice(0, 40);
      const all = fullText();
      const lower = all.toLowerCase();
      const spots = [];
      for (let at = lower.indexOf(q); at >= 0 && spots.length < 8; at = lower.indexOf(q, at + q.length)) {
        const from = Math.max(0, at - 80);
        const to = Math.min(all.length, at + q.length + 120);
        spots.push('第 ' + at + ' 个字符附近：' + (from > 0 ? '…' : '') + all.slice(from, to).replace(/\s+/g, ' ') + (to < all.length ? '…' : ''));
      }
      const out = { page: Object.assign(where(), { text: '' }), elements: hits };
      if (spots.length) out.note = spots.join('\n') + '\n（读某一处的上下文：browser_read {"offset": 那个位置}）';
      return out;
    },

    click(o) {
      const el = get(o && o.ref);
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) { /* not scrollable into view */ }
      // a link that would open another window opens here instead: the Agent has this one tab
      const link = el.closest ? el.closest('a[target]') : null;
      if (link && link.target && link.target !== '_self') link.target = '_self';
      try { if (typeof el.focus === 'function') el.focus({ preventScroll: true }); } catch (e) { /* not focusable */ }
      fire(el, 'pointerover'); fire(el, 'pointerdown'); fire(el, 'mousedown'); fire(el, 'pointerup'); fire(el, 'mouseup');
      el.click();
      return {};
    },

    /** Put `text` into a field (replacing what is there). `submit`: send the form — `enter: true` when the caller should press Enter instead. */
    type(o) {
      const el = get(o && o.ref);
      const text = String(o && o.text != null ? o.text : '');
      const t = el.tagName;
      try { el.scrollIntoView({ block: 'center' }); } catch (e) { /* fine */ }
      try { el.focus({ preventScroll: true }); } catch (e) { /* fine */ }
      if (t === 'SELECT') {
        const want = text.trim().toLowerCase();
        const opt = Array.from(el.options).find((x) => x.text.trim().toLowerCase() === want || x.value.toLowerCase() === want) || Array.from(el.options).find((x) => x.text.toLowerCase().includes(want));
        // (the options themselves are the page's words: they are read with browser_read, not put into an error)
        if (!opt) throw new Error('这个下拉框里没有这一项。先用 browser_click 点开它，或者用 browser_find 找到要选的那一项。');
        el.value = opt.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (t === 'INPUT' || t === 'TEXTAREA') {
        const ty = (el.getAttribute('type') || 'text').toLowerCase();
        if (ty === 'checkbox' || ty === 'radio' || ty === 'file' || ty === 'submit' || ty === 'button') throw new Error('[' + refOf.get(el) + '] 不是能输入文字的地方（' + ty + '）：用 browser_click。');
        setValue(el, text);
      } else if (el.isContentEditable) {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
        if (!document.execCommand('insertText', false, text)) el.textContent = text;
      } else {
        throw new Error('[' + refOf.get(el) + '] 不是能输入文字的地方：先用 browser_click 点开它，再找输入框。');
      }
      const out = {};
      if (o && o.submit) {
        const form = el.form || (el.closest ? el.closest('form') : null);
        if (form && t !== 'TEXTAREA') {
          if (typeof form.requestSubmit === 'function') form.requestSubmit(); else form.submit();
          out.submitted = true;
        } else {
          out.enter = true;
        }
      }
      return out;
    },

    scroll(o) {
      const el = scroller();
      const view = el === document.scrollingElement || el === document.documentElement ? (window.innerHeight || 700) : (el.clientHeight || 700);
      const by = Math.round(view * 0.85) * Math.max(1, Math.min(20, Math.floor((o && o.amount) || 1))) * (o && o.direction === 'up' ? -1 : 1);
      const before = el.scrollTop;
      el.scrollTop = before + by;
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      return { moved: Math.round(el.scrollTop - before), top: Math.round(el.scrollTop), max: Math.round(max), length: fullText().length };
    },

    /** Selected text, for 「发给对话」. */
    selection() {
      return clean(String(window.getSelection ? window.getSelection() : ''), 4000);
    },
  };
})();
