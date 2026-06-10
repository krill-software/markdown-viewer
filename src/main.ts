import "@krill-software/desktop-ui/styles";
import "katex/dist/katex.min.css";
import "highlight.js/styles/github.css";
import "./styles.css";
import { mountChrome, showBootError } from "@krill-software/desktop-ui";
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
// as woff2 (bundled by desktop-ui) and always render
// crisply; the rest rely on the user's system having them (or a
// reasonable substitute).
const FONTS: FontChoice[] = [
  { label: "Charter",         css: '"Charter", Georgia, "Times New Roman", serif' },
  { label: "Inter",           css: '"Inter", system-ui, -apple-system, sans-serif' },
  { label: "JetBrains Mono", css: '"JetBrains Mono", ui-monospace, monospace' },
  { label: "Georgia",         css: 'Georgia, "Times New Roman", serif' },
  { label: "Times New Roman", css: '"Times New Roman", Times, serif' },
  { label: "Helvetica",       css: 'Helvetica, "Liberation Sans", Arial, sans-serif' },
  { label: "Arial",           css: 'Arial, "Liberation Sans", sans-serif' },
  { label: "system-ui",       css: 'system-ui, -apple-system, sans-serif' },
];

const DEFAULTS: Typography = {
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

// ---- Sidebar (typography controls) ---------------------------------

function renderAux() {
  // The aux strip (hamburger) is owned by desktop-ui's app layout — leave it
  // in place and re-render only our own content below it.
  auxEl.querySelector(".type-controls")?.remove();

  const section = el("div", { class: "type-controls" });
  section.append(el("h2", { class: "type-section" }, "Typography"));

  section.append(buildControlGroup("Heading", "headingFont", "headingSize"));
  section.append(buildControlGroup("Body",    "bodyFont",    "bodySize"));

  const reset = el("button", { class: "type-reset", type: "button" }, "Reset to defaults");
  reset.addEventListener("click", () => {
    typography = { ...DEFAULTS };
    applyAndPersist();
    renderAux();
  });
  section.append(reset);

  auxEl.append(section);
}

function buildControlGroup(
  label: string,
  fontKey: "headingFont" | "bodyFont",
  sizeKey: "headingSize" | "bodySize",
): HTMLElement {
  const wrap = el("div", { class: "type-group" });
  wrap.append(el("div", { class: "type-label" }, label));

  const row = el("div", { class: "type-row" });

  // Font picker — `appearance: none` strips the system chevron; the
  // chevron in styles.css is a CSS background-image so it picks up
  // the palette.
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
    applyAndPersist();
  });
  row.append(fontSel);

  // Size — compact input with embedded "px" unit, to the right of
  // the font select on the same row.
  const min = label === "Heading" ? 12 : 10;
  const max = label === "Heading" ? 64 : 32;
  const sizeBox = el("div", { class: "type-size-box" });
  const sizeNum = el("input", {
    class: "type-size-input",
    type: "number",
    min: String(min),
    max: String(max),
    value: String(typography[sizeKey]),
  }) as HTMLInputElement;
  const unit = el("span", { class: "type-unit" }, "px");
  const commitSize = (n: number) => {
    const clamped = Math.max(min, Math.min(max, n));
    typography[sizeKey] = clamped;
    sizeNum.value = String(clamped);
    applyAndPersist();
  };
  sizeNum.addEventListener("change", () =>
    commitSize(parseInt(sizeNum.value, 10) || typography[sizeKey]),
  );
  // Scroll-wheel to nudge — quiet but discoverable.
  sizeNum.addEventListener("wheel", (e) => {
    if (document.activeElement !== sizeNum) return;
    e.preventDefault();
    commitSize(typography[sizeKey] + (e.deltaY < 0 ? 1 : -1));
  }, { passive: false });
  sizeBox.append(sizeNum, unit);
  row.append(sizeBox);

  wrap.append(row);
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

/// Apply + persist. Call from user-driven change handlers; boot just
/// uses applyTypography() so we don't write back what we just loaded.
function applyAndPersist() {
  applyTypography();
  schedulePersist();
}

// Debounced settings save. The size stepper can fire 10+ times in
// quick succession (scroll wheel, +/- holding) — one disk write per
// settled value is plenty.
let persistTimer: number | null = null;
function schedulePersist() {
  if (persistTimer != null) clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    invoke("save_settings", { settings: typography }).catch((e) =>
      console.warn("save_settings failed:", e),
    );
  }, 250);
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
    version: __APP_VERSION__,
    layout: "app",
    showAuxPane: true,
    actions: {
      "open": openViaDialog,
    },
    updater: true,
  });
  auxEl = chrome.aux!;
  auxEl.classList.add("typography-aux");

  // Shell chrome (main-topbar + aux hamburger) comes from desktop-ui's app
  // layout; we just render into the scroll area it provides.
  mainContentEl = chrome.mainContent!;
  renderRoot = el("article", { class: "render" });
  mainContentEl.append(renderRoot);

  // Load persisted typography choices, if any. Falls back to defaults
  // when the file is missing or malformed.
  try {
    const loaded = await invoke<Typography>("load_settings");
    typography = { ...DEFAULTS, ...loaded };
  } catch (e) {
    console.warn("load_settings failed:", e);
  }
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
