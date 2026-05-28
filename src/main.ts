import "@krill-software/desktop-ui/styles";
import "katex/dist/katex.min.css";
import "highlight.js/styles/github.css";
import "./styles.css";
import { mountChrome, showBootError, checkForUpdates } from "@krill-software/desktop-ui";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getMatches } from "@tauri-apps/plugin-cli";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { icons as lucideIcons, createElement as createLucide } from "lucide";

import { renderMarkdown, renderMermaidBlocks } from "./preview";

// ---- Curated font list — same 8 for headings and body. -------------
//
// Each entry is (label shown to user, CSS font-family value with
// fallbacks). Anything in the user's system that doesn't have the
// chosen face degrades down the fallback chain quietly.

interface FontChoice { label: string; css: string }
// All choices fall back through reasonable system substitutes so a
// missing face never collapses to DejaVu. The first three are bundled
// as woff2 (see @font-face entries in styles.css) and always render
// crisply; the rest rely on the user's system having them (or a
// reasonable substitute).
const FONTS: FontChoice[] = [
  { label: "Charter",         css: '"Charter", Georgia, "Times New Roman", serif' },
  { label: "Inter",           css: '"Inter", system-ui, -apple-system, sans-serif' },
  { label: "Hasklig",         css: '"Hasklig", ui-monospace, SFMono-Regular, monospace' },
  { label: "Georgia",         css: 'Georgia, "Times New Roman", serif' },
  { label: "Times New Roman", css: '"Times New Roman", Times, serif' },
  { label: "Helvetica",       css: 'Helvetica, "Liberation Sans", Arial, sans-serif' },
  { label: "Arial",           css: 'Arial, "Liberation Sans", sans-serif' },
  { label: "system-ui",       css: 'system-ui, -apple-system, sans-serif' },
];

const DEFAULTS = {
  headingFont: "Charter",
  headingSize: 28,
  bodyFont: "Inter",
  bodySize: 16,
};

interface Typography {
  headingFont: string;
  headingSize: number;
  bodyFont: string;
  bodySize: number;
}
let typography: Typography = { ...DEFAULTS };

// ---- App state ------------------------------------------------------

let viewportEl: HTMLElement;
let mainContentEl: HTMLElement;
let auxEl: HTMLElement;
let renderRoot: HTMLElement;
let currentPath: string | null = null;
let currentSource: string = "";

// ---- Lucide ---------------------------------------------------------

function pascal(name: string): string {
  return name.split("-").map(s => s[0].toUpperCase() + s.slice(1)).join("");
}
function iconSvg(name: string, size = 16): SVGElement {
  const node = (lucideIcons as Record<string, any>)[pascal(name)] ?? lucideIcons.FileText;
  const el = createLucide(node);
  el.setAttribute("width", String(size));
  el.setAttribute("height", String(size));
  return el;
}

// ---- DOM helpers ----------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    node.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

// ---- Shell chrome (mirrors file-drop / photo-importer) ------------

function buildMainTopbar(): HTMLElement {
  const bar = el("div", { class: "main-topbar", "data-tauri-drag-region": "true" });
  const min = el("button", { class: "main-topbar-btn", type: "button", title: "Minimize" });
  min.append(iconSvg("minus", 16));
  min.addEventListener("click", () => { void getCurrentWindow().minimize(); });
  const max = el("button", { class: "main-topbar-btn", type: "button", title: "Maximize" });
  max.append(iconSvg("square", 14));
  max.addEventListener("click", () => { void getCurrentWindow().toggleMaximize(); });
  const close = el("button", {
    class: "main-topbar-btn",
    type: "button",
    title: "Close",
    "data-kind": "close",
  });
  close.append(iconSvg("x", 16));
  close.addEventListener("click", () => { void getCurrentWindow().close(); });
  bar.append(min, max, close);
  return bar;
}

function buildAuxTopbar(): HTMLElement {
  const bar = el("div", { class: "aux-topbar", "data-tauri-drag-region": "true" });
  const hamburger = el("button", { class: "main-topbar-btn", type: "button", title: "Menu" });
  hamburger.append(iconSvg("menu", 16));
  hamburger.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleHamburgerMenu(bar);
  });
  bar.append(hamburger);
  return bar;
}

function toggleHamburgerMenu(anchor: HTMLElement) {
  const existing = document.querySelector(".menu-popover");
  if (existing) { existing.remove(); return; }
  const pop = el("div", { class: "menu-popover" });
  const items: Array<{ label: string; action: () => void } | { sep: true }> = [
    { label: "Open .md…",      action: () => void openViaDialog() },
    { sep: true },
    { label: "Check for updates…", action: () => void checkForUpdates("Markdown Viewer") },
    { sep: true },
    { label: "Quit",          action: () => void getCurrentWindow().close() },
  ];
  for (const it of items) {
    if ("sep" in it) {
      pop.append(el("div", { class: "menu-popover-sep" }));
    } else {
      const btn = el("button", { class: "menu-popover-item", type: "button" }, it.label);
      btn.addEventListener("click", () => { pop.remove(); it.action(); });
      pop.append(btn);
    }
  }
  anchor.parentElement?.append(pop);
  setTimeout(() => {
    const handler = (ev: MouseEvent) => {
      if (!pop.contains(ev.target as Node)) {
        pop.remove();
        document.removeEventListener("click", handler);
      }
    };
    document.addEventListener("click", handler);
  }, 0);
}

// ---- Sidebar (typography controls) ---------------------------------

function renderAux() {
  auxEl.replaceChildren();
  auxEl.append(buildAuxTopbar());

  const section = el("div", { class: "type-controls" });
  section.append(el("h2", { class: "type-section" }, "Typography"));

  section.append(buildControlGroup("Heading", "headingFont", "headingSize"));
  section.append(buildControlGroup("Body",    "bodyFont",    "bodySize"));

  const reset = el("button", { class: "type-reset", type: "button" }, "Reset to defaults");
  reset.addEventListener("click", () => {
    typography = { ...DEFAULTS };
    applyTypography();
    renderAux();
  });
  section.append(reset);

  auxEl.append(section);
  auxEl.append(el("div", { class: "aux-version" }, `v${__APP_VERSION__}`));
}

function buildControlGroup(
  label: string,
  fontKey: "headingFont" | "bodyFont",
  sizeKey: "headingSize" | "bodySize",
): HTMLElement {
  const wrap = el("div", { class: "type-group" });
  wrap.append(el("div", { class: "type-label" }, label));

  // Font picker
  const fontSel = el("select", { class: "type-select" }) as HTMLSelectElement;
  for (const f of FONTS) {
    const opt = el("option", { value: f.label }, f.label) as HTMLOptionElement;
    if (f.label === typography[fontKey]) opt.selected = true;
    opt.style.fontFamily = f.css;
    fontSel.append(opt);
  }
  fontSel.style.fontFamily = FONTS.find(f => f.label === typography[fontKey])?.css ?? "";
  fontSel.addEventListener("change", () => {
    typography[fontKey] = fontSel.value;
    fontSel.style.fontFamily = FONTS.find(f => f.label === fontSel.value)?.css ?? "";
    applyTypography();
  });
  wrap.append(fontSel);

  // Size stepper
  const sizeWrap = el("div", { class: "type-size" });
  const minus = el("button", { class: "type-step", type: "button" }, "−");
  const sizeNum = el("input", {
    class: "type-size-input",
    type: "number",
    min: label === "Heading" ? "12" : "10",
    max: label === "Heading" ? "64" : "32",
    value: String(typography[sizeKey]),
  }) as HTMLInputElement;
  const plus = el("button", { class: "type-step", type: "button" }, "+");
  const commitSize = (n: number) => {
    const clamped = Math.max(
      label === "Heading" ? 12 : 10,
      Math.min(label === "Heading" ? 64 : 32, n),
    );
    typography[sizeKey] = clamped;
    sizeNum.value = String(clamped);
    applyTypography();
  };
  minus.addEventListener("click", () => commitSize(typography[sizeKey] - 1));
  plus.addEventListener("click", () => commitSize(typography[sizeKey] + 1));
  sizeNum.addEventListener("change", () => commitSize(parseInt(sizeNum.value, 10) || typography[sizeKey]));
  sizeWrap.append(minus, sizeNum, plus, el("span", { class: "type-unit" }, "px"));
  wrap.append(sizeWrap);

  return wrap;
}

function applyTypography() {
  const hf = FONTS.find(f => f.label === typography.headingFont)?.css ?? "";
  const bf = FONTS.find(f => f.label === typography.bodyFont)?.css ?? "";
  renderRoot.style.setProperty("--mv-heading-font", hf);
  renderRoot.style.setProperty("--mv-body-font",    bf);
  renderRoot.style.setProperty("--mv-heading-size", `${typography.headingSize}px`);
  renderRoot.style.setProperty("--mv-body-size",    `${typography.bodySize}px`);
}

// ---- Main pane: render the current document ------------------------

function renderEmpty() {
  renderRoot.replaceChildren();
  const empty = el("div", { class: "empty-state" });
  empty.append(iconSvg("book-open", 56));
  empty.append(el("h2", {}, "Open a markdown file"));
  empty.append(el("p", {},
    "Drag a .md file onto the window, use Ctrl+O, or pass a path on the command line."));
  renderRoot.append(empty);
}

function renderCurrent() {
  if (!currentPath) { renderEmpty(); return; }
  renderRoot.innerHTML = renderMarkdown(currentSource);
  void renderMermaidBlocks(renderRoot);
}

// ---- File I/O ------------------------------------------------------

async function openPath(path: string) {
  try {
    const abs = await invoke<string>("absolute_path", { path });
    const text = await invoke<string>("read_md", { path: abs });
    currentPath = abs;
    currentSource = text;
    const title = `${basename(abs)} — Markdown Viewer`;
    document.title = title;
    void getCurrentWindow().setTitle(title).catch(() => {});
    renderCurrent();
    mainContentEl.scrollTop = 0;
    // Start watching the new file. Backend drops the previous watcher
    // so swapping files doesn't leak listeners.
    try {
      await invoke("watch_file", { path: abs });
    } catch (e) {
      console.warn("watch_file failed (live updates disabled):", e);
    }
  } catch (e) {
    console.error("openPath failed:", e);
    renderRoot.replaceChildren();
    const err = el("div", { class: "empty-state error" });
    err.append(iconSvg("triangle-alert", 56));
    err.append(el("h2", {}, "Couldn't open this file"));
    err.append(el("p", { class: "mono" }, String(e)));
    renderRoot.append(err);
  }
}

// Live re-render path. Debounced: editors often save in bursts (atomic
// rename produces multiple notify events in quick succession), and we
// want exactly one re-fetch per quiet period.
let reloadTimer: number | null = null;
async function scheduleReload() {
  if (reloadTimer != null) {
    clearTimeout(reloadTimer);
  }
  reloadTimer = window.setTimeout(async () => {
    reloadTimer = null;
    if (!currentPath) return;
    try {
      const text = await invoke<string>("read_md", { path: currentPath });
      if (text === currentSource) return; // no-op if nothing actually changed
      currentSource = text;
      const top = mainContentEl.scrollTop;
      renderCurrent();
      // Best-effort scroll preservation. Edits above the viewport
      // shift things and there's no anchor to fix it; this at least
      // keeps you near where you were.
      mainContentEl.scrollTop = top;
    } catch (e) {
      console.warn("reload failed (file may have been removed):", e);
    }
  }, 80);
}

async function openViaDialog() {
  const picked = await openDialog({
    multiple: false,
    directory: false,
    filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
  });
  if (typeof picked === "string") await openPath(picked);
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

async function installDragDrop() {
  const wv = getCurrentWebview();
  await wv.onDragDropEvent(async (e) => {
    if (e.payload.type === "drop") {
      const path = e.payload.paths.find((p) => /\.(md|markdown)$/i.test(p));
      if (path) await openPath(path);
    }
  });
}

// ---- Boot ----------------------------------------------------------

async function boot() {
  const chrome = mountChrome({
    productName: "Markdown Viewer",
    actions: {
      "open": openViaDialog,
    },
    bindings: {
      "Ctrl+O": openViaDialog,
    },
    showStatusLine: false,
    showAuxPane: true,
    updater: true,
  });
  viewportEl = chrome.viewport;
  auxEl = chrome.aux!;
  auxEl.classList.add("typography-aux");

  const topbar = buildMainTopbar();
  mainContentEl = el("div", { class: "main-content" });
  renderRoot = el("article", { class: "render" });
  mainContentEl.append(renderRoot);
  viewportEl.replaceChildren(topbar, mainContentEl);

  applyTypography();
  renderAux();
  renderEmpty();

  // Live re-renders on file change. Path filtering happens here too:
  // the backend already filters, but if we ever watch multiple files
  // this gate becomes useful.
  await listen<string>("file-changed", (e) => {
    if (!currentPath || e.payload !== currentPath) return;
    void scheduleReload();
  });

  await installDragDrop();

  // Try CLI arg first.
  let opened = false;
  try {
    const matches = await getMatches();
    const arg = matches.args.file?.value;
    if (typeof arg === "string" && arg.length > 0) {
      await openPath(arg);
      opened = true;
    }
  } catch { /* cli plugin unavailable */ }

  // Dev convenience: open a fixture if one exists.
  if (!opened && import.meta.env.DEV) {
    try {
      const dev = await invoke<string | null>("dev_test_file");
      if (dev) await openPath(dev);
    } catch { /* none */ }
  }
}

boot().catch((e) => {
  console.error("boot failed:", e);
  showBootError(e);
});
