/**
 * The hands and eyes on Windows: one long-lived `powershell.exe` per MCP server, started on first use, that compiles
 * a small C# class (user32 SendInput, screen capture with System.Drawing, window / process lookups) and then answers
 * JSON lines over stdio — one request `{id, op, …}`, one response `{id, ok, …}`.
 *
 * The script lives in this file as text (the server is built with plain tsc: nothing but .js reaches dist) and is
 * written to `<dataDir>/runtime/computer/helper-<sha8>.ps1` before use, like the spawn guard's preload. It is pure
 * ASCII — Windows PowerShell reads a BOM-less file in the ANSI code page — and holds no backslash and no backtick.
 *
 * What the helper does on its own, whatever it is asked:
 *  - makes the process per-monitor DPI aware before anything else, so a screenshot is in real pixels and the pointer
 *    coordinates are the same pixels;
 *  - before any input it checks that the window in front (and the window under each target point) is still the one
 *    the caller looked at when it decided — and is not Claude Web itself. Otherwise it sends nothing and says so.
 *
 * Every spawn passes windowsHide.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';

/** C# 5 (what Windows PowerShell's Add-Type compiles): no interpolation, no `?.`, no `out var`. */
const CSHARP = [
  'using System;',
  'using System.Collections;',
  'using System.Collections.Generic;',
  'using System.Diagnostics;',
  'using System.Drawing;',
  'using System.Drawing.Drawing2D;',
  'using System.Drawing.Imaging;',
  'using System.IO;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'using System.Threading;',
  'using System.Web.Script.Serialization;',
  '',
  'namespace CW {',
  '  public static class Native {',
  '    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X; public int Y; }',
  '    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }',
  '    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }',
  '    [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }',
  '    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }',
  '    delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);',
  '',
  '    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);',
  '    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);',
  '    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);',
  '    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();',
  '    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);',
  '    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder sb, int max);',
  '    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder sb, int max);',
  '    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);',
  '    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hwnd);',
  '    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);',
  '    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);',
  '    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);',
  '    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);',
  '    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);',
  '    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);',
  '    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);',
  '    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hwnd, int index);',
  '    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);',
  '    [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint type);',
  '    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);',
  '    [DllImport("user32.dll")] static extern void SwitchToThisWindow(IntPtr hwnd, bool altTab);',
  '    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);',
  '    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr lParam);',
  '    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);',
  '    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);',
  '    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();',
  '    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();',
  '    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);',
  '    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, uint flags, StringBuilder sb, ref uint size);',
  '    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);',
  '    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int value, int size);',
  '',
  '    static JavaScriptSerializer J;',
  '    static string dpi = "unaware";',
  '    static string selfExe = "";',
  '    static string selfTitle = "";',
  '    static bool held = false;',
  '    static Dictionary<string, string[]> labels = new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase);',
  '',
  '    // before anything that touches a window or the screen: real pixels everywhere',
  '    public static void Init() {',
  '      J = new JavaScriptSerializer();',
  '      J.MaxJsonLength = Int32.MaxValue;',
  '      try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) dpi = "per-monitor-v2"; } catch (Exception) { }',
  '      if (dpi == "unaware") { try { if (SetThreadDpiAwarenessContext(new IntPtr(-4)) != IntPtr.Zero) dpi = "thread-per-monitor-v2"; } catch (Exception) { } }',
  '      if (dpi == "unaware") { try { if (SetProcessDPIAware()) dpi = "system"; } catch (Exception) { } }',
  '    }',
  '',
  '    // a held button must not outlive us',
  '    public static void Shutdown() {',
  '      if (held) { try { MouseEvent(Buttons("left")[1], 0); } catch (Exception) { } held = false; }',
  '    }',
  '',
  '    public static object Parse(string line) { return J.DeserializeObject(line); }',
  '    public static string Json(object o) { return J.Serialize(o); }',
  '',
  '    // "!" = an op the script answers itself (it needs cmdlets)',
  '    public static string Handle(string line) {',
  '      object id = null;',
  '      try {',
  '        Dictionary<string, object> q = (Dictionary<string, object>)J.DeserializeObject(line);',
  '        q.TryGetValue("id", out id);',
  '        Dictionary<string, object> r = Dispatch(S(q, "op"), q);',
  '        if (r == null) return "!";',
  '        r["id"] = id;',
  '        if (!r.ContainsKey("ok")) r["ok"] = true;',
  '        return J.Serialize(r);',
  '      } catch (Exception e) {',
  '        Dictionary<string, object> r = new Dictionary<string, object>();',
  '        r["id"] = id; r["ok"] = false; r["error"] = e.Message;',
  '        return J.Serialize(r);',
  '      }',
  '    }',
  '',
  '    static string S(Dictionary<string, object> q, string k) { object v; if (q.TryGetValue(k, out v) && v != null) return Convert.ToString(v); return ""; }',
  '    static long L(object v) { return (long)Math.Floor(Convert.ToDouble(v) + 0.5); }',
  '    static int I(Dictionary<string, object> q, string k, int d) { object v; if (q.TryGetValue(k, out v) && v != null) return (int)L(v); return d; }',
  '    static bool B(Dictionary<string, object> q, string k) { object v; if (q.TryGetValue(k, out v) && v != null) return Convert.ToBoolean(v); return false; }',
  '    static object[] Arr(object v) { object[] a = v as object[]; if (a != null) return a; ArrayList l = v as ArrayList; if (l != null) return l.ToArray(); return new object[0]; }',
  '    static object[] A(Dictionary<string, object> q, string k) { object v; if (q.TryGetValue(k, out v) && v != null) return Arr(v); return new object[0]; }',
  '    static Dictionary<string, object> Ok() { return new Dictionary<string, object>(); }',
  '    static Dictionary<string, object> Pt(int x, int y) { Dictionary<string, object> d = new Dictionary<string, object>(); d["x"] = x; d["y"] = y; return d; }',
  '',
  '    // ---- windows and the programs behind them ----',
  '',
  '    static string Title(IntPtr h) { StringBuilder sb = new StringBuilder(512); GetWindowText(h, sb, sb.Capacity); return sb.ToString(); }',
  '',
  '    static string ExePath(uint pid) {',
  '      if (pid == 0) return "";',
  '      IntPtr p = OpenProcess(0x1000, false, pid);',
  '      if (p == IntPtr.Zero) return "";',
  '      try {',
  '        StringBuilder sb = new StringBuilder(1024);',
  '        uint n = (uint)sb.Capacity;',
  '        if (QueryFullProcessImageName(p, 0, sb, ref n)) return sb.ToString();',
  '        return "";',
  '      } finally { CloseHandle(p); }',
  '    }',
  '',
  '    // a UWP app draws inside a frame window that belongs to ApplicationFrameHost: the app is the child from another process',
  '    static uint AppPid(IntPtr hwnd) {',
  '      uint pid;',
  '      GetWindowThreadProcessId(hwnd, out pid);',
  '      uint frame = pid;',
  '      string exe = ExePath(pid);',
  '      if (exe.EndsWith("ApplicationFrameHost.exe", StringComparison.OrdinalIgnoreCase)) {',
  '        uint found = 0;',
  '        EnumProc cb = delegate(IntPtr c, IntPtr l) { uint p; GetWindowThreadProcessId(c, out p); if (p != 0 && p != frame) { found = p; return false; } return true; };',
  '        EnumChildWindows(hwnd, cb, IntPtr.Zero);',
  '        GC.KeepAlive(cb);',
  '        if (found != 0) return found;',
  '      }',
  '      return pid;',
  '    }',
  '',
  '    static string[] Labels(string exe) {',
  '      string[] r;',
  '      if (exe.Length == 0) return new string[] { "", "" };',
  '      if (labels.TryGetValue(exe, out r)) return r;',
  '      r = new string[] { "", "" };',
  '      try { FileVersionInfo v = FileVersionInfo.GetVersionInfo(exe); r[0] = v.FileDescription ?? ""; r[1] = v.ProductName ?? ""; } catch (Exception) { }',
  '      labels[exe] = r;',
  '      return r;',
  '    }',
  '',
  '    static Dictionary<string, object> Info(IntPtr hwnd) {',
  '      if (hwnd == IntPtr.Zero) return null;',
  '      uint pid = AppPid(hwnd);',
  '      string exe = ExePath(pid);',
  '      string name = "";',
  '      if (exe.Length > 0) name = Path.GetFileNameWithoutExtension(exe);',
  '      else { try { name = Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { } }',
  '      string[] l = Labels(exe);',
  '      Dictionary<string, object> d = new Dictionary<string, object>();',
  '      d["hwnd"] = hwnd.ToInt64(); d["pid"] = (long)pid; d["name"] = name; d["exe"] = exe;',
  '      d["description"] = l[0]; d["product"] = l[1]; d["title"] = Title(hwnd);',
  '      return d;',
  '    }',
  '',
  '    static IntPtr RootAt(int x, int y) {',
  '      POINT p = new POINT(); p.X = x; p.Y = y;',
  '      IntPtr h = WindowFromPoint(p);',
  '      if (h == IntPtr.Zero) return IntPtr.Zero;',
  '      IntPtr r = GetAncestor(h, 2);',
  '      return r == IntPtr.Zero ? h : r;',
  '    }',
  '',
  '    // Claude Web itself: its own executable, or any window titled like it (the web version is a browser tab)',
  '    static bool IsSelf(IntPtr hwnd) {',
  '      if (hwnd == IntPtr.Zero) return false;',
  '      if (selfTitle.Length > 0 && Title(hwnd).IndexOf(selfTitle, StringComparison.OrdinalIgnoreCase) >= 0) return true;',
  '      if (selfExe.Length > 0) {',
  '        string exe = ExePath(AppPid(hwnd));',
  '        if (exe.Length > 0 && String.Equals(exe, selfExe, StringComparison.OrdinalIgnoreCase)) return true;',
  '      }',
  '      return false;',
  '    }',
  '',
  '    static List<IntPtr> TopWindows() {',
  '      List<IntPtr> list = new List<IntPtr>();',
  '      EnumProc cb = delegate(IntPtr h, IntPtr l) {',
  '        if (list.Count >= 120) return false;',
  '        if (!IsWindowVisible(h)) return true;',
  '        if (GetWindow(h, 4) != IntPtr.Zero) return true;',
  '        int ex = GetWindowLong(h, -20);',
  '        if ((ex & 0x80) != 0 && (ex & 0x40000) == 0) return true;',
  '        int cloaked = 0;',
  '        try { DwmGetWindowAttribute(h, 14, out cloaked, 4); } catch (Exception) { }',
  '        if (cloaked != 0) return true;',
  '        if (Title(h).Length == 0) return true;',
  '        // the desktop itself is not a window of an application to bring forward',
  '        StringBuilder cls = new StringBuilder(64);',
  '        GetClassName(h, cls, cls.Capacity);',
  '        string cn = cls.ToString();',
  '        if (cn == "Progman" || cn == "WorkerW") return true;',
  '        list.Add(h);',
  '        return true;',
  '      };',
  '      EnumWindows(cb, IntPtr.Zero);',
  '      GC.KeepAlive(cb);',
  '      return list;',
  '    }',
  '',
  '    // no synthetic key press to win the foreground: that would be input to whatever is in front',
  '    static bool Activate(IntPtr h) {',
  '      if (!IsWindow(h)) throw new Exception("that window no longer exists");',
  '      if (IsIconic(h)) ShowWindow(h, 9);',
  '      SetForegroundWindow(h);',
  '      Thread.Sleep(60);',
  '      if (GetForegroundWindow() == h) return true;',
  '      IntPtr fg = GetForegroundWindow();',
  '      uint other;',
  '      uint fgThread = fg == IntPtr.Zero ? 0 : GetWindowThreadProcessId(fg, out other);',
  '      uint me = GetCurrentThreadId();',
  '      if (fgThread != 0 && fgThread != me) {',
  '        bool attached = AttachThreadInput(me, fgThread, true);',
  '        try { BringWindowToTop(h); SetForegroundWindow(h); } finally { if (attached) AttachThreadInput(me, fgThread, false); }',
  '        Thread.Sleep(60);',
  '        if (GetForegroundWindow() == h) return true;',
  '      }',
  '      SwitchToThisWindow(h, true);',
  '      Thread.Sleep(150);',
  '      return GetForegroundWindow() == h;',
  '    }',
  '',
  '    // ---- the last look before input ----',
  '',
  '    // null: go ahead. Otherwise why not: "changed" (not what the caller looked at), "self", "unchecked" (no expectation given)',
  '    static string Check(Dictionary<string, object> q, int[] pts) {',
  '      object eo;',
  '      if (!q.TryGetValue("expect", out eo) || eo == null) return "unchecked";',
  '      Dictionary<string, object> e = (Dictionary<string, object>)eo;',
  '      object want;',
  '      if (!e.TryGetValue("fg", out want) || want == null) return "unchecked";',
  '      IntPtr fg = GetForegroundWindow();',
  '      if (fg == IntPtr.Zero || fg.ToInt64() != L(want)) return "changed";',
  '      if (IsSelf(fg)) return "self";',
  '      if (pts != null) {',
  '        object[] under = A(e, "under");',
  '        if (under.Length * 2 < pts.Length) return "unchecked";',
  '        for (int k = 0; k * 2 < pts.Length; k++) {',
  '          IntPtr root = RootAt(pts[k * 2], pts[k * 2 + 1]);',
  '          if (root == IntPtr.Zero) return "changed";',
  '          if (IsSelf(root)) return "self";',
  '          Dictionary<string, object> u = (Dictionary<string, object>)under[k];',
  '          if (root.ToInt64() != L(u["hwnd"]) && (long)AppPid(root) != L(u["pid"])) return "changed";',
  '        }',
  '      }',
  '      return null;',
  '    }',
  '',
  '    static Dictionary<string, object> Blocked(string why, int sent) {',
  '      Dictionary<string, object> r = new Dictionary<string, object>();',
  '      r["ok"] = false; r[why] = true; r["sent"] = sent;',
  '      r["error"] = why == "self" ? "Claude Web itself is in the way" : why == "changed" ? "the window in front changed" : "no expectation given";',
  '      return r;',
  '    }',
  '',
  '    // ---- input ----',
  '',
  '    static void Send(INPUT[] a) {',
  '      uint n = SendInput((uint)a.Length, a, Marshal.SizeOf(typeof(INPUT)));',
  '      if (n != (uint)a.Length) throw new Exception("Windows did not accept the input (" + n + " of " + a.Length + " events): the screen may be locked, or another program is blocking input");',
  '    }',
  '',
  '    static void MouseEvent(uint flags, int data) {',
  '      INPUT i = new INPUT(); i.type = 0;',
  '      i.u.mi.dwFlags = flags; i.u.mi.mouseData = unchecked((uint)data);',
  '      Send(new INPUT[] { i });',
  '    }',
  '',
  '    // down / up flags; the left and right buttons trade places when the user swapped them',
  '    static uint[] Buttons(string b) {',
  '      bool swap = GetSystemMetrics(23) != 0;',
  '      if (b == "middle") return new uint[] { 0x20, 0x40 };',
  '      if ((b == "right") != swap) return new uint[] { 0x8, 0x10 };',
  '      return new uint[] { 0x2, 0x4 };',
  '    }',
  '',
  '    static void KeyEvent(object k, bool up) {',
  '      Dictionary<string, object> d = (Dictionary<string, object>)k;',
  '      ushort vk = (ushort)I(d, "vk", 0);',
  '      if (vk == 0) throw new Exception("a key without a code");',
  '      INPUT i = new INPUT(); i.type = 1;',
  '      i.u.ki.wVk = vk; i.u.ki.wScan = (ushort)MapVirtualKey(vk, 0);',
  '      i.u.ki.dwFlags = (uint)((B(d, "ext") ? 1 : 0) | (up ? 2 : 0));',
  '      Send(new INPUT[] { i });',
  '    }',
  '',
  '    static void Press(object[] keys) { for (int i = 0; i < keys.Length; i++) { KeyEvent(keys[i], false); Thread.Sleep(8); } }',
  '    static void Release(object[] keys) { for (int i = keys.Length - 1; i >= 0; i--) { try { KeyEvent(keys[i], true); } catch (Exception) { } Thread.Sleep(4); } }',
  '',
  '    static void Tap(ushort vk) {',
  '      INPUT d = new INPUT(); d.type = 1; d.u.ki.wVk = vk; d.u.ki.wScan = (ushort)MapVirtualKey(vk, 0);',
  '      INPUT u = d; u.u.ki.dwFlags = 2;',
  '      Send(new INPUT[] { d, u });',
  '    }',
  '',
  '    static INPUT Uni(char c, bool up) {',
  '      INPUT i = new INPUT(); i.type = 1;',
  '      i.u.ki.wVk = 0; i.u.ki.wScan = (ushort)c; i.u.ki.dwFlags = (uint)(4 | (up ? 2 : 0));',
  '      return i;',
  '    }',
  '',
  '    static string Flush(Dictionary<string, object> q, List<INPUT> buf) {',
  '      if (buf.Count == 0) return null;',
  '      string c = Check(q, null);',
  '      if (c != null) { buf.Clear(); return c; }',
  '      Send(buf.ToArray());',
  '      buf.Clear();',
  '      Thread.Sleep(12);',
  '      return null;',
  '    }',
  '',
  '    // text as Unicode characters: no layout, no input method in the way. A newline is Enter, a tab is Tab.',
  '    static Dictionary<string, object> TypeText(Dictionary<string, object> q) {',
  '      string text = S(q, "text");',
  '      string c = Check(q, null);',
  '      if (c != null) return Blocked(c, 0);',
  '      List<INPUT> buf = new List<INPUT>();',
  '      int sent = 0;',
  '      for (int i = 0; i < text.Length; i++) {',
  '        char ch = text[i];',
  '        ushort special = 0;',
  '        if (ch == 13) { if (i + 1 < text.Length && text[i + 1] == 10) continue; special = 13; }',
  '        else if (ch == 10) special = 13;',
  '        else if (ch == 9) special = 9;',
  '        else if (ch < 32 || ch == 127) continue;',
  '        if (special != 0) {',
  '          c = Flush(q, buf); if (c != null) return Blocked(c, sent);',
  '          c = Check(q, null); if (c != null) return Blocked(c, i);',
  '          Tap(special);',
  '          sent = i + 1;',
  '          Thread.Sleep(25);',
  '          continue;',
  '        }',
  '        buf.Add(Uni(ch, false)); buf.Add(Uni(ch, true));',
  '        if (buf.Count >= 16 && !Char.IsHighSurrogate(ch)) { c = Flush(q, buf); if (c != null) return Blocked(c, sent); sent = i + 1; }',
  '      }',
  '      c = Flush(q, buf); if (c != null) return Blocked(c, sent);',
  '      Dictionary<string, object> r = Ok();',
  '      r["sent"] = text.Length;',
  '      return r;',
  '    }',
  '',
  '    static Dictionary<string, object> PressChords(Dictionary<string, object> q) {',
  '      object[] chords = A(q, "chords");',
  '      int done = 0;',
  '      for (int k = 0; k < chords.Length; k++) {',
  '        string c = Check(q, null);',
  '        if (c != null) return Blocked(c, done);',
  '        object[] chord = Arr(chords[k]);',
  '        try { Press(chord); Thread.Sleep(20); } finally { Release(chord); }',
  '        done++;',
  '        Thread.Sleep(35);',
  '      }',
  '      Dictionary<string, object> r = Ok();',
  '      r["sent"] = done;',
  '      return r;',
  '    }',
  '',
  '    // held like a finger on the key: after the usual delay the last key repeats; another window in front ends it at once',
  '    static Dictionary<string, object> Hold(Dictionary<string, object> q) {',
  '      object[] chord = A(q, "chord");',
  '      int ms = Math.Max(0, Math.Min(100000, I(q, "ms", 0)));',
  '      string c = Check(q, null);',
  '      if (c != null) return Blocked(c, 0);',
  '      IntPtr want = GetForegroundWindow();',
  '      object rep = null;',
  '      q.TryGetValue("rep", out rep);',
  '      bool cut = false;',
  '      Stopwatch sw = Stopwatch.StartNew();',
  '      try {',
  '        Press(chord);',
  '        while (sw.ElapsedMilliseconds < ms) {',
  '          Thread.Sleep((int)Math.Max(1, Math.Min(30, ms - sw.ElapsedMilliseconds)));',
  '          if (GetForegroundWindow() != want) { cut = true; break; }',
  '          if (rep != null && sw.ElapsedMilliseconds > 450 && sw.ElapsedMilliseconds < ms) KeyEvent(rep, false);',
  '        }',
  '      } finally { Release(chord); }',
  '      Dictionary<string, object> r = Ok();',
  '      r["heldMs"] = sw.ElapsedMilliseconds;',
  '      if (cut) r["cut"] = true;',
  '      return r;',
  '    }',
  '',
  '    // put the pointer on the target and see that it stays: a button press lands wherever the pointer is at that instant,',
  '    // and the user may be moving the mouse',
  '    static bool Settle(int x, int y) {',
  '      POINT c;',
  '      for (int i = 0; i < 3; i++) {',
  '        SetCursorPos(x, y);',
  '        Thread.Sleep(i == 0 ? 30 : 15);',
  '        GetCursorPos(out c);',
  '        if (Math.Abs(c.X - x) <= 1 && Math.Abs(c.Y - y) <= 1) return true;',
  '      }',
  '      return false;',
  '    }',
  '',
  '    static bool Near(int x, int y) { POINT c; GetCursorPos(out c); return Math.Abs(c.X - x) <= 1 && Math.Abs(c.Y - y) <= 1; }',
  '',
  '    static Dictionary<string, object> Moved() {',
  '      Dictionary<string, object> r = new Dictionary<string, object>();',
  '      r["ok"] = false; r["moved"] = true; r["sent"] = 0;',
  '      r["error"] = "The pointer would not stay on the target (the user may be moving the mouse), so nothing was sent";',
  '      return r;',
  '    }',
  '',
  '    static Dictionary<string, object> Click(Dictionary<string, object> q) {',
  '      int x = I(q, "x", 0), y = I(q, "y", 0);',
  '      int count = Math.Max(1, Math.Min(3, I(q, "count", 1)));',
  '      int[] pts = new int[] { x, y };',
  '      string c = Check(q, pts);',
  '      if (c != null) return Blocked(c, 0);',
  '      if (!Settle(x, y)) return Moved();',
  '      c = Check(q, pts);',
  '      if (c != null) return Blocked(c, 0);',
  '      uint[] f = Buttons(S(q, "button"));',
  '      object[] mods = A(q, "mods");',
  '      int done = 0;',
  '      try {',
  '        Press(mods);',
  '        for (int i = 0; i < count; i++) {',
  '          if (!Near(x, y) && !Settle(x, y)) break;',
  '          MouseEvent(f[0], 0);',
  '          Thread.Sleep(18);',
  '          MouseEvent(f[1], 0);',
  '          done++;',
  '          if (i + 1 < count) Thread.Sleep(70);',
  '        }',
  '      } finally { Release(mods); }',
  '      if (done == 0) return Moved();',
  '      Dictionary<string, object> r = Ok();',
  '      r["clicks"] = done;',
  '      return r;',
  '    }',
  '',
  '    static Dictionary<string, object> Drag(Dictionary<string, object> q) {',
  '      POINT cur;',
  '      GetCursorPos(out cur);',
  '      bool from = q.ContainsKey("fx") && q["fx"] != null;',
  '      int fx = from ? I(q, "fx", 0) : cur.X, fy = from ? I(q, "fy", 0) : cur.Y;',
  '      int tx = I(q, "x", 0), ty = I(q, "y", 0);',
  '      int[] pts = new int[] { fx, fy, tx, ty };',
  '      string c = Check(q, pts);',
  '      if (c != null) return Blocked(c, 0);',
  '      if (!Settle(fx, fy)) return Moved();',
  '      c = Check(q, pts);',
  '      if (c != null) return Blocked(c, 0);',
  '      uint[] f = Buttons("left");',
  '      bool landed = false;',
  '      MouseEvent(f[0], 0);',
  '      try {',
  '        Thread.Sleep(90);',
  '        int steps = 16;',
  '        for (int s = 1; s <= steps; s++) { SetCursorPos(fx + (tx - fx) * s / steps, fy + (ty - fy) * s / steps); Thread.Sleep(14); }',
  '        landed = Settle(tx, ty);',
  '        Thread.Sleep(70);',
  '      } finally { MouseEvent(f[1], 0); }',
  '      Dictionary<string, object> r = Ok();',
  '      if (!landed) r["astray"] = true;',
  '      return r;',
  '    }',
  '',
  '    static Dictionary<string, object> Scroll(Dictionary<string, object> q) {',
  '      int x = I(q, "x", 0), y = I(q, "y", 0);',
  '      int[] pts = new int[] { x, y };',
  '      string c = Check(q, pts);',
  '      if (c != null) return Blocked(c, 0);',
  '      if (!Settle(x, y)) return Moved();',
  '      c = Check(q, pts);',
  '      if (c != null) return Blocked(c, 0);',
  '      int dx = I(q, "dx", 0), dy = I(q, "dy", 0);',
  '      object[] mods = A(q, "mods");',
  '      int turned = 0;',
  '      try {',
  '        Press(mods);',
  '        // the wheel turns whatever is under the pointer: stop if the pointer has left the target',
  '        for (int i = 0; i < Math.Abs(dy) && Near(x, y); i++) { MouseEvent(0x800, dy > 0 ? 120 : -120); turned++; Thread.Sleep(12); }',
  '        for (int i = 0; i < Math.Abs(dx) && Near(x, y); i++) { MouseEvent(0x1000, dx > 0 ? 120 : -120); turned++; Thread.Sleep(12); }',
  '      } finally { Release(mods); }',
  '      Dictionary<string, object> r = Ok();',
  '      r["turned"] = turned;',
  '      return r;',
  '    }',
  '',
  '    // ---- the screen ----',
  '',
  '    static Dictionary<string, object> Shot(int x, int y, int w, int h, int maxEdge, int quality) {',
  '      double scale = Math.Min(1.0, (double)maxEdge / Math.Max(w, h));',
  '      int ow = Math.Max(1, (int)Math.Floor(w * scale + 0.5));',
  '      int oh = Math.Max(1, (int)Math.Floor(h * scale + 0.5));',
  '      Dictionary<string, object> r = Ok();',
  '      using (Bitmap full = new Bitmap(w, h, PixelFormat.Format24bppRgb)) {',
  '        using (Graphics g = Graphics.FromImage(full)) { g.CopyFromScreen(x, y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy); }',
  '        Bitmap small = full;',
  '        try {',
  '          if (ow != w || oh != h) {',
  '            small = new Bitmap(ow, oh, PixelFormat.Format24bppRgb);',
  '            using (Graphics g2 = Graphics.FromImage(small))',
  '            using (ImageAttributes ia = new ImageAttributes()) {',
  '              g2.InterpolationMode = InterpolationMode.HighQualityBicubic;',
  '              g2.PixelOffsetMode = PixelOffsetMode.HighQuality;',
  '              ia.SetWrapMode(WrapMode.TileFlipXY);',
  '              g2.DrawImage(full, new Rectangle(0, 0, ow, oh), 0, 0, w, h, GraphicsUnit.Pixel, ia);',
  '            }',
  '          }',
  '          ImageCodecInfo codec = null;',
  '          foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders()) { if (c.FormatID == ImageFormat.Jpeg.Guid) codec = c; }',
  '          using (MemoryStream ms = new MemoryStream())',
  '          using (EncoderParameters ep = new EncoderParameters(1)) {',
  '            ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);',
  '            small.Save(ms, codec, ep);',
  '            r["data"] = Convert.ToBase64String(ms.ToArray());',
  '          }',
  '        } finally { if (!Object.ReferenceEquals(small, full)) small.Dispose(); }',
  '      }',
  '      Dictionary<string, object> rect = new Dictionary<string, object>();',
  '      rect["x"] = x; rect["y"] = y; rect["width"] = w; rect["height"] = h;',
  '      r["w"] = ow; r["h"] = oh; r["rect"] = rect;',
  '      return r;',
  '    }',
  '',
  '    // ---- the clipboard (needs an STA thread) ----',
  '',
  '    static string ClipGet() {',
  '      string text = null;',
  '      Exception err = null;',
  '      Thread t = new Thread(delegate() {',
  '        try { if (System.Windows.Forms.Clipboard.ContainsText()) text = System.Windows.Forms.Clipboard.GetText(); } catch (Exception e) { err = e; }',
  '      });',
  '      t.SetApartmentState(ApartmentState.STA);',
  '      t.Start();',
  '      t.Join();',
  '      if (err != null) throw err;',
  '      return text;',
  '    }',
  '',
  '    static void ClipSet(string text) {',
  '      Exception err = null;',
  '      Thread t = new Thread(delegate() {',
  '        try {',
  '          if (text.Length == 0) System.Windows.Forms.Clipboard.Clear();',
  '          else System.Windows.Forms.Clipboard.SetDataObject(text, true, 10, 50);',
  '        } catch (Exception e) { err = e; }',
  '      });',
  '      t.SetApartmentState(ApartmentState.STA);',
  '      t.Start();',
  '      t.Join();',
  '      if (err != null) throw err;',
  '    }',
  '',
  '    // ---- one request ----',
  '',
  '    static Dictionary<string, object> Dispatch(string op, Dictionary<string, object> q) {',
  '      Dictionary<string, object> r = Ok();',
  '      string c;',
  '      POINT cur;',
  '      if (op == "hello") {',
  '        selfExe = S(q, "selfExe"); selfTitle = S(q, "selfTitle");',
  '        Dictionary<string, object> screen = new Dictionary<string, object>();',
  '        screen["width"] = GetSystemMetrics(0); screen["height"] = GetSystemMetrics(1);',
  '        r["dpi"] = dpi; r["screen"] = screen; r["pid"] = Process.GetCurrentProcess().Id; r["v"] = 1;',
  '        return r;',
  '      }',
  '      if (op == "probe") {',
  '        GetCursorPos(out cur);',
  '        r["fg"] = Info(GetForegroundWindow());',
  '        r["cursor"] = Pt(cur.X, cur.Y);',
  '        List<object> under = new List<object>();',
  '        foreach (object p in A(q, "points")) {',
  '          object[] xy = Arr(p);',
  '          if (xy.Length == 2) under.Add(Info(RootAt((int)L(xy[0]), (int)L(xy[1]))));',
  '          else under.Add(Info(RootAt(cur.X, cur.Y)));',
  '        }',
  '        r["under"] = under;',
  '        return r;',
  '      }',
  '      if (op == "screenshot") {',
  '        r = Shot(0, 0, GetSystemMetrics(0), GetSystemMetrics(1), I(q, "maxEdge", 1568), I(q, "quality", 75));',
  '        r["fg"] = Info(GetForegroundWindow());',
  '        return r;',
  '      }',
  '      if (op == "zoom") {',
  '        int sw = GetSystemMetrics(0), sh = GetSystemMetrics(1);',
  '        int zx = Math.Max(0, Math.Min(sw - 1, I(q, "x", 0))), zy = Math.Max(0, Math.Min(sh - 1, I(q, "y", 0)));',
  '        int zw = Math.Max(1, Math.Min(sw - zx, I(q, "width", 1))), zh = Math.Max(1, Math.Min(sh - zy, I(q, "height", 1)));',
  '        return Shot(zx, zy, zw, zh, I(q, "maxEdge", 1568), I(q, "quality", 80));',
  '      }',
  '      if (op == "cursor") { GetCursorPos(out cur); r["x"] = cur.X; r["y"] = cur.Y; return r; }',
  '      if (op == "move") {',
  '        int mx = I(q, "x", 0), my = I(q, "y", 0);',
  '        if (q.ContainsKey("expect")) { c = Check(q, new int[] { mx, my }); if (c != null) return Blocked(c, 0); }',
  '        SetCursorPos(mx, my);',
  '        GetCursorPos(out cur); r["x"] = cur.X; r["y"] = cur.Y;',
  '        return r;',
  '      }',
  '      if (op == "click") return Click(q);',
  '      if (op == "drag") return Drag(q);',
  '      if (op == "scroll") return Scroll(q);',
  '      if (op == "down") {',
  '        GetCursorPos(out cur);',
  '        c = Check(q, new int[] { cur.X, cur.Y }); if (c != null) return Blocked(c, 0);',
  '        MouseEvent(Buttons("left")[0], 0);',
  '        held = true;',
  '        return r;',
  '      }',
  '      if (op == "up") {',
  '        if (!B(q, "force")) { GetCursorPos(out cur); c = Check(q, new int[] { cur.X, cur.Y }); if (c != null) return Blocked(c, 0); }',
  '        MouseEvent(Buttons("left")[1], 0);',
  '        held = false;',
  '        return r;',
  '      }',
  '      if (op == "type") return TypeText(q);',
  '      if (op == "keys") return PressChords(q);',
  '      if (op == "hold") return Hold(q);',
  '      if (op == "apps") {',
  '        List<object> list = new List<object>();',
  '        foreach (IntPtr h in TopWindows()) list.Add(Info(h));',
  '        r["apps"] = list;',
  '        r["fg"] = Info(GetForegroundWindow());',
  '        return r;',
  '      }',
  '      if (op == "activate") {',
  '        IntPtr h = new IntPtr(L(q["hwnd"]));',
  '        if (IsSelf(h)) throw new Exception("Claude Web itself is never brought forward");',
  '        r["front"] = Activate(h);',
  '        r["fg"] = Info(GetForegroundWindow());',
  '        return r;',
  '      }',
  '      if (op == "clipget") { r["text"] = ClipGet(); return r; }',
  '      if (op == "clipset") {',
  '        c = Check(q, null); if (c != null) return Blocked(c, 0);',
  '        ClipSet(S(q, "text"));',
  '        return r;',
  '      }',
  '      if (op == "startapps" || op == "launch") return null;',
  '      throw new Exception("unknown op " + op);',
  '    }',
  '  }',
  '}',
];

/** The script around it: UTF-8 on both pipes whatever the console code page is, then one line in, one line out. */
const SCRIPT_HEAD = [
  '# claude-web computer-use helper: JSON lines over stdin / stdout. Written by server/src/computer/helper-win.ts.',
  '$ErrorActionPreference = \'Stop\'',
  '$ProgressPreference = \'SilentlyContinue\'',
  '$utf8 = New-Object System.Text.UTF8Encoding($false)',
  '$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)',
  '$stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)',
  '$stdout.AutoFlush = $true',
  '$src = @\'',
];

const SCRIPT_TAIL = [
  '\'@',
  'Add-Type -TypeDefinition $src -ReferencedAssemblies \'System.Drawing\', \'System.Windows.Forms\', \'System.Web.Extensions\'',
  '[CW.Native]::Init()',
  'while ($true) {',
  '  $line = $stdin.ReadLine()',
  '  if ($null -eq $line) { break }',
  '  if ($line.Length -eq 0) { continue }',
  '  $resp = [CW.Native]::Handle($line)',
  '  if ($resp -eq \'!\') {',
  '    $q = [CW.Native]::Parse($line)',
  '    $r = @{ id = $q[\'id\']; ok = $true }',
  '    try {',
  '      $op = [string]$q[\'op\']',
  '      if ($op -eq \'startapps\') {',
  '        $list = New-Object System.Collections.ArrayList',
  '        foreach ($a in @(Get-StartApps)) { [void]$list.Add(@{ name = [string]$a.Name; appId = [string]$a.AppID }) }',
  '        $r[\'apps\'] = $list.ToArray()',
  '      } elseif ($op -eq \'launch\') {',
  '        if ($q.ContainsKey(\'appId\')) { $target = \'shell:AppsFolder\' + [char]92 + [string]$q[\'appId\'] } else { $target = [string]$q[\'file\'] }',
  '        if ([string]::IsNullOrWhiteSpace($target)) { throw \'nothing to start\' }',
  '        Start-Process -FilePath $target | Out-Null',
  '      } else {',
  '        throw (\'unknown op \' + $op)',
  '      }',
  '    } catch {',
  '      $r[\'ok\'] = $false',
  '      $r[\'error\'] = [string]$_.Exception.Message',
  '    }',
  '    $resp = [CW.Native]::Json($r)',
  '  }',
  '  $stdout.WriteLine($resp)',
  '}',
  '[CW.Native]::Shutdown()',
];

export const HELPER_SCRIPT = `${[...SCRIPT_HEAD, ...CSHARP, ...SCRIPT_TAIL].join('\n')}\n`;

const SCRIPT_BYTES = Buffer.from(HELPER_SCRIPT, 'utf8');
const SCRIPT_HASH = createHash('sha256').update(SCRIPT_BYTES).digest('hex');
export const HELPER_SCRIPT_NAME = `helper-${SCRIPT_HASH.slice(0, 8)}.ps1`;

/** Same resolution as files/service `dataDir()` — duplicated (as the spawn guard does) so this process loads nothing else of ours. */
function dataDir(): string {
  return process.env.CLAUDE_WEB_DIR ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.claude-web');
}

/** Where the helper's files go: `<dataDir>/runtime/computer`. */
export function computerDir(): string {
  return path.join(dataDir(), 'runtime', 'computer');
}

function isScript(file: string): boolean {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size !== SCRIPT_BYTES.length) return false;
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex') === SCRIPT_HASH;
  } catch {
    return false;
  }
}

/**
 * The script as a file in `dir`, content-addressed: reused only when its bytes are exactly ours, otherwise written
 * to a .tmp and renamed into place. Null when it cannot be put there. Scripts of earlier versions are removed.
 */
export function helperScriptFile(dir: string): string | null {
  const file = path.join(dir, HELPER_SCRIPT_NAME);
  if (isScript(file)) return file;
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, SCRIPT_BYTES);
    fs.renameSync(tmp, file);
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    return isScript(file) ? file : null; // another process may have put the same bytes there first
  }
  try {
    for (const f of fs.readdirSync(dir)) {
      if (/^helper-[0-9a-f]{8}\.ps1$/.test(f) && f !== HELPER_SCRIPT_NAME) fs.rmSync(path.join(dir, f), { force: true });
    }
  } catch { /* an old script left behind harms nothing */ }
  return file;
}

/** `<dataDir>/runtime/computer`, else the OS temp dir (a read-only or redirected profile). */
export function helperScriptPath(): string {
  const tmpDir = path.join(os.tmpdir(), 'claude-web-runtime', 'computer');
  const f = helperScriptFile(computerDir()) ?? helperScriptFile(tmpDir);
  if (!f) throw new HelperError(`写不了辅助脚本（试过 ${computerDir()} 和 ${tmpDir}）`);
  return f;
}

/** Windows PowerShell by its own address (not whatever `powershell` on PATH is). */
export function powershellExe(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot ?? env.windir ?? 'C:\\Windows';
  const exe = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(exe) ? exe : 'powershell.exe';
}

/** The helper could not be started, died, or did not answer in time. */
export class HelperError extends Error {}

/** What the service needs from the helper; tests hand in a fake. */
export interface HelperLike {
  /** One request. Resolves with the helper's answer (`ok: false` included); rejects only when there is no answer. */
  call(op: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, any>>;
  close(): void;
}

export interface HelperHello { dpi: string; screen: { width: number; height: number }; pid: number; startMs: number }

interface Waiter { resolve: (r: Record<string, any>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; op: string; at: number }

const START_TIMEOUT_MS = 45_000;
const CALL_TIMEOUT_MS = 15_000;

/** Requests go out as pure ASCII: no code page between us and the helper can touch them. */
function asciiJson(v: unknown): string {
  return JSON.stringify(v).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export class WinHelper implements HelperLike {
  private child: ChildProcess | null = null;
  private ready: Promise<HelperHello> | null = null;
  private readonly waiters = new Map<number, Waiter>();
  private seq = 0;
  private stderrTail = '';
  private closed = false;
  hello: HelperHello | null = null;

  constructor(private readonly opts: { selfExe?: string; selfTitle?: string; debug?: boolean; log?: (line: string) => void } = {}) {}

  private log(line: string) { (this.opts.log ?? ((l: string) => process.stderr.write(`${l}\n`)))(`[computer] ${line}`); }

  async call(op: string, args: Record<string, unknown> = {}, timeoutMs = CALL_TIMEOUT_MS): Promise<Record<string, any>> {
    await this.start();
    return this.send(op, args, timeoutMs);
  }

  /** Start the helper if it is not running. The first call pays for PowerShell and the C# compile (about a second). */
  start(): Promise<HelperHello> {
    if (this.closed) return Promise.reject(new HelperError('已经关闭'));
    if (this.ready && this.child) return this.ready;
    const t0 = Date.now();
    let script: string;
    try { script = helperScriptPath(); } catch (e) { return Promise.reject(e); }
    const env = { ...process.env };
    // a PowerShell 7 parent leaves its own module path here, and Windows PowerShell then fails to load its cmdlets
    for (const k of Object.keys(env)) if (k.toLowerCase() === 'psmodulepath') delete env[k];
    let child: ChildProcess;
    try {
      child = spawn(powershellExe(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
    } catch (e) {
      return Promise.reject(new HelperError(`启动不了 PowerShell：${(e as Error).message}`));
    }
    this.child = child;
    this.stderrTail = '';
    let buf = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) this.onLine(line);
      }
    });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (d: string) => { this.stderrTail = (this.stderrTail + d).slice(-3000); });
    child.stdin!.on('error', () => { /* the exit handler reports it */ });
    const gone = (why: string) => {
      if (this.child !== child) return;
      this.child = null;
      this.ready = null;
      this.hello = null;
      const said = this.stderrTail.replace(/\s+/g, ' ').trim().slice(-600);
      const err = new HelperError(`${why}${said ? `（PowerShell 输出：${said}）` : ''}`);
      for (const [id, w] of this.waiters) { clearTimeout(w.timer); w.reject(err); this.waiters.delete(id); }
    };
    child.on('error', (e) => gone(`启动不了 PowerShell：${e.message}`));
    child.on('exit', (code) => gone(`辅助进程退出了（${code ?? '被结束'}）`));
    // the helper compares the path as Windows reports it: backslashes, no quotes
    const selfExe = (this.opts.selfExe ?? '').trim().replace(/^"|"$/g, '').replace(/\//g, '\\');
    this.ready = this.send('hello', { selfExe, selfTitle: this.opts.selfTitle ?? '' }, START_TIMEOUT_MS).then((r) => {
      if (!r.ok) throw new HelperError(String(r.error ?? 'hello failed'));
      const hello: HelperHello = { dpi: String(r.dpi), screen: { width: Number(r.screen?.width), height: Number(r.screen?.height) }, pid: Number(r.pid), startMs: Date.now() - t0 };
      this.hello = hello;
      this.log(`helper ready in ${hello.startMs} ms (${hello.dpi}, ${hello.screen.width}x${hello.screen.height})`);
      return hello;
    });
    // nobody may be listening yet when it fails; call() awaits it and reports
    this.ready.catch(() => { if (this.child === child) this.kill(); });
    return this.ready;
  }

  private onLine(line: string) {
    let msg: Record<string, any>;
    try { msg = JSON.parse(line); } catch { this.stderrTail = (this.stderrTail + line).slice(-3000); return; }
    const w = typeof msg?.id === 'number' ? this.waiters.get(msg.id) : undefined;
    if (!w) return;
    this.waiters.delete(msg.id);
    clearTimeout(w.timer);
    if (this.opts.debug) this.log(`${w.op} ${Date.now() - w.at} ms${msg.ok === false ? ` (${msg.error ?? 'failed'})` : ''}`);
    w.resolve(msg);
  }

  private send(op: string, args: Record<string, unknown>, timeoutMs: number): Promise<Record<string, any>> {
    const child = this.child;
    if (!child || !child.stdin || child.stdin.destroyed) return Promise.reject(new HelperError('辅助进程没有在运行'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        // it may be stuck in the middle of something: a fresh one next time
        if (this.child === child) this.kill();
        reject(new HelperError(`辅助进程 ${Math.round(timeoutMs / 1000)} 秒没有回答（${op}）`));
      }, timeoutMs);
      this.waiters.set(id, { resolve, reject, timer, op, at: Date.now() });
      child.stdin!.write(`${asciiJson({ id, op, ...args })}\n`);
    });
  }

  /** End it now (a timeout, our own exit). */
  kill() {
    const child = this.child;
    if (!child) return;
    try { child.kill(); } catch { /* already gone */ }
  }

  /** Let it finish what it is doing and go: closing its stdin ends its loop (and releases a held mouse button). */
  close() {
    this.closed = true;
    const child = this.child;
    if (!child) return;
    try { child.stdin?.end(); } catch { /* ignore */ }
    const t = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 1500);
    t.unref();
    child.once('exit', () => clearTimeout(t));
  }
}
