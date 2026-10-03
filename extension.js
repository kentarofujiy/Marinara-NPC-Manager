// Marinara NPC Manager — full-page Personal Extension
// Runs inside: run(extension, async (marinara) => { ... })

const EXT_ID = marinara.extension.id;
const PANEL_ID = `npc-mgr-panel-${EXT_ID}`;
const BTN_ID   = `npc-mgr-btn-${EXT_ID}`;

// ─── Storage helpers ────────────────────────────────────────────────────────

async function loadStore() {
  const raw = await marinara.storage.get();
  return {
    npcs:          Array.isArray(raw?.npcs) ? raw.npcs : [],
    chatSelections: (raw?.chatSelections && typeof raw.chatSelections === "object") ? raw.chatSelections : {},
    settings: {
      extractionMessageCount: typeof raw?.settings?.extractionMessageCount === "number"
        ? raw.settings.extractionMessageCount : 20,
      syncFormat: raw?.settings?.syncFormat === "brief" ? "brief" : "full",
      extractionPrompt: typeof raw?.settings?.extractionPrompt === "string"
        ? raw.settings.extractionPrompt : "",
    },
  };
}

async function saveStore(patch) {
  await marinara.storage.patch(patch);
}

function makeId() {
  return `npc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// ─── Chat ID detection ───────────────────────────────────────────────────────

function detectChatId() {
  return localStorage.getItem("marinara-active-chat-id") || null;
}

// ─── API helpers ─────────────────────────────────────────────────────────────

async function apiFetch(path, options = {}) {
  const res = await marinara.fetch(`/api/${path.replace(/^\/+/, "")}`, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err?.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

async function getMessages(chatId, count) {
  const data = await apiFetch(`chats/${chatId}/messages`);
  const msgs = Array.isArray(data) ? data : (Array.isArray(data?.messages) ? data.messages : []);
  return msgs.slice(-count);
}

function buildExtractionPrompt(basePrompt, existingNpcs, excludedNames) {
  const npcsBlock = existingNpcs.length > 0
    ? `<existing_npcs>\n${existingNpcs.map(n =>
        `id=${n.id} name="${n.name}"${n.aliases?.length ? ` aliases="${n.aliases.join(", ")}"` : ""}`
      ).join("\n")}\n</existing_npcs>`
    : "<existing_npcs>(none)</existing_npcs>";
  const excludedBlock = excludedNames.length > 0
    ? `<excluded_characters>\n${excludedNames.join("\n")}\n</excluded_characters>`
    : "<excluded_characters>(none)</excluded_characters>";
  return `${basePrompt}\n\n${npcsBlock}\n\n${excludedBlock}`;
}

async function runExtraction(chatId, existingNpcs, chatCharacterNames, settings) {
  const basePrompt = settings.extractionPrompt || DEFAULT_EXTRACTION_PROMPT;
  const prompt = buildExtractionPrompt(basePrompt, existingNpcs, chatCharacterNames);
  console.log("[NPC Manager] runExtraction — chatId:", chatId, "existing:", existingNpcs.length, "excluded:", chatCharacterNames);
  const data = await apiFetch(`generate/dryRun`, {
    method: "POST",
    body: JSON.stringify({
      chatId,
      promptParts: {
        presetText: prompt,
        includePersona: false,
        includeCharacters: false,
        includeHistory: true,
      },
      userMessage: "Perform the NPC extraction as instructed. Output only valid JSON.",
      streaming: false,
    }),
  });
  console.log("[NPC Manager] dryRun raw response:", data);
  const content = typeof data?.content === "string" ? data.content : "";
  console.log("[NPC Manager] extracted content string:", content || "(empty)");
  const updates = parseExtractionResult(content, existingNpcs, chatCharacterNames);
  console.log("[NPC Manager] parsed updates:", updates);
  return updates;
}

async function syncMacro(chatId, npcs, format) {
  const text = formatNpcMemory(npcs, format);
  await apiFetch(`chats/${chatId}/metadata`, {
    method: "PATCH",
    body: JSON.stringify({ macroVariables: { npc_memory: text } }),
  });
  return text;
}

async function createCharacterCard(npc) {
  return apiFetch("characters", {
    method: "POST",
    body: JSON.stringify({
      data: {
        name: npc.name,
        description: npc.description || "",
        personality: npc.personality || "",
        creator_notes: npc.aliases?.length ? `Aliases: ${npc.aliases.join(", ")}` : "",
        extensions: {
          appearance: npc.appearance || "",
        },
      },
    }),
  });
}

async function getChatCharacterNames(chatId) {
  try {
    const chat = await apiFetch(`chats/${chatId}`);
    const charIds = Array.isArray(chat?.characterIds) ? chat.characterIds
      : (typeof chat?.characterIds === "string" ? JSON.parse(chat.characterIds) : []);
    if (!charIds.length) return [];
    const chars = await apiFetch(`characters?ids=${charIds.join(",")}`);
    const list = Array.isArray(chars) ? chars : (Array.isArray(chars?.characters) ? chars.characters : []);
    return list.map(c => {
      try {
        const data = typeof c.data === "string" ? JSON.parse(c.data) : c.data;
        return data?.name ?? c.name ?? "";
      } catch { return c.name ?? ""; }
    }).filter(Boolean);
  } catch (err) {
    console.warn("[NPC Manager] getChatCharacterNames error:", err);
    return [];
  }
}

// ─── NPC memory formatting ───────────────────────────────────────────────────

function formatNpcMemory(npcs, format) {
  if (!npcs.length) return "";
  if (format === "brief") {
    return npcs.map(n => {
      const parts = [n.name];
      if (n.aliases?.length) parts.push(`(${n.aliases.join(", ")})`);
      if (n.appearance) parts.push(`Appearance: ${n.appearance}`);
      if (n.personality) parts.push(`Personality: ${n.personality}`);
      if (n.description) parts.push(n.description);
      return parts.join(" — ");
    }).join("\n");
  }
  return npcs.map(n => {
    const lines = [`## ${n.name}`];
    if (n.aliases?.length) lines.push(`Aliases: ${n.aliases.join(", ")}`);
    if (n.appearance) lines.push(`Appearance: ${n.appearance}`);
    if (n.personality) lines.push(`Personality: ${n.personality}`);
    if (n.description) lines.push(`Background: ${n.description}`);
    return lines.join("\n");
  }).join("\n\n");
}

// ─── Extraction prompt ───────────────────────────────────────────────────────

const DEFAULT_EXTRACTION_PROMPT = `You maintain a persistent NPC gallery from conversation content.

Analyze the recent conversation and return only valid JSON:
{"updates":[{"action":"create|update","matchId":"existing NPC id or null","name":"NPC name","aliases":[],"appearance":"durable physical appearance or null","personality":"durable personality traits or null","description":"role, relationships, background or null"}]}

Rules:
1. Track named NPCs and non-player characters only. Never include the user persona or player character.
2. Do not create entries for characters already listed in <excluded_characters>.
3. Existing NPCs are in <existing_npcs>. Match before creating. Use the exact id in matchId for updates.
4. Record only durable facts. Ignore temporary states.
5. If nothing changed, return {"updates":[]}.
6. Output JSON only, no markdown fences.`;

// ─── Extraction result parser ────────────────────────────────────────────────

function normalizeString(v) {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function parseExtractionResult(content, existingNpcs, excludedNames) {
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn("[NPC Manager] parseExtractionResult — no JSON object found in content");
      return [];
    }
    const parsed = JSON.parse(jsonMatch[0]);
    const updates = Array.isArray(parsed?.updates) ? parsed.updates : [];
    const excluded = new Set(excludedNames.map(n => n.toLowerCase().trim()));

    return updates.flatMap(u => {
      if (!u || typeof u !== "object") return [];
      const name = normalizeString(u.name);
      if (!name) return [];
      if (excluded.has(name.toLowerCase())) return [];

      const action = u.action === "update" ? "update" : "create";
      const matchId = action === "update" && typeof u.matchId === "string" ? u.matchId : null;
      const matched = matchId ? existingNpcs.find(n => n.id === matchId) : null;

      if (action === "update" && !matched) return [];

      return [{
        action,
        matchId: matched?.id ?? null,
        name: normalizeString(u.name) ?? (matched?.name ?? ""),
        aliases: Array.isArray(u.aliases) ? u.aliases.filter(a => typeof a === "string" && a.trim()) : (matched?.aliases ?? []),
        appearance: normalizeString(u.appearance) ?? (action === "update" ? null : ""),
        personality: normalizeString(u.personality) ?? (action === "update" ? null : ""),
        description: normalizeString(u.description) ?? (action === "update" ? null : ""),
      }];
    });
  } catch (err) {
    console.error("[NPC Manager] parseExtractionResult error:", err);
    return [];
  }
}

function applyUpdates(existingNpcs, updates) {
  const result = existingNpcs.map(npc => {
    const update = updates.find(u => u.action === "update" && u.matchId === npc.id);
    if (!update) return npc;
    return {
      ...npc,
      name: update.name || npc.name,
      aliases: update.aliases ?? npc.aliases,
      appearance: update.appearance ?? npc.appearance,
      personality: update.personality ?? npc.personality,
      description: update.description ?? npc.description,
    };
  });
  const toCreate = updates.filter(u => u.action === "create");
  for (const u of toCreate) {
    const duplicate = result.find(n => n.name.toLowerCase() === u.name.toLowerCase());
    if (duplicate) continue;
    result.push({
      id: makeId(),
      name: u.name,
      aliases: u.aliases ?? [],
      appearance: u.appearance ?? "",
      personality: u.personality ?? "",
      description: u.description ?? "",
    });
  }
  return result;
}

// ─── State ───────────────────────────────────────────────────────────────────

let state = {
  open: false,
  view: "list",        // "list" | "edit" | "settings" | "extract"
  npcs: [],
  chatSelections: {},
  settings: { extractionMessageCount: 20, syncFormat: "full", extractionPrompt: "" },
  editingNpc: null,    // null = new NPC
  draftNpc: { name: "", aliases: "", appearance: "", personality: "", description: "" },
  extractUpdates: [],  // pending extraction results
  busy: false,
  error: "",
  syncedChatId: null,
};

function chatId() { return detectChatId(); }

function selectedNpcsForChat() {
  const id = chatId();
  if (!id) return state.npcs;
  const sel = state.chatSelections[id];
  if (!Array.isArray(sel)) return state.npcs;
  return state.npcs.filter(n => sel.includes(n.id));
}

// ─── UI rendering ────────────────────────────────────────────────────────────

function render() {
  const panel = document.getElementById(PANEL_ID);
  if (!panel) return;
  panel.style.display = state.open ? "flex" : "none";
  if (!state.open) return;

  panel.innerHTML = "";
  panel.appendChild(buildPanel());
}

function buildPanel() {
  const wrap = el("div", { class: "nm-wrap" });

  // Header
  const header = el("div", { class: "nm-header" });
  const title = el("span", { class: "nm-title" }, navTitle());
  const closeBtn = btn("✕", () => { state.open = false; render(); }, "nm-close");
  header.append(title, closeBtn);
  wrap.appendChild(header);

  // Error banner
  if (state.error) {
    const errBanner = el("div", { class: "nm-error" }, state.error);
    wrap.appendChild(errBanner);
  }

  // Body
  const body = el("div", { class: "nm-body" });
  if (state.view === "list") body.appendChild(buildListView());
  else if (state.view === "edit") body.appendChild(buildEditView());
  else if (state.view === "settings") body.appendChild(buildSettingsView());
  else if (state.view === "extract") body.appendChild(buildExtractView());
  wrap.appendChild(body);

  return wrap;
}

function navTitle() {
  if (state.view === "edit") return state.editingNpc ? "Edit NPC" : "New NPC";
  if (state.view === "settings") return "Settings";
  if (state.view === "extract") return "Review Extraction";
  return "NPC Manager";
}

// ── List view ─────────────────────────────────────────────────────────────────

function buildListView() {
  const wrap = el("div", { class: "nm-list-view" });

  const toolbar = el("div", { class: "nm-toolbar" });
  const addBtn = btn("+ New NPC", () => {
    state.editingNpc = null;
    state.draftNpc = { name: "", aliases: "", appearance: "", personality: "", description: "" };
    state.view = "edit";
    state.error = "";
    render();
  }, "nm-btn-primary");
  const extractBtn = btn(state.busy ? "Extracting…" : "⟳ Extract", async () => {
    await doExtract();
  }, "nm-btn-secondary");
  extractBtn.disabled = state.busy;
  const syncBtn = btn("↑ Sync {{npc_memory}}", async () => {
    await doSync();
  }, "nm-btn-secondary");
  const settingsBtn = btn("⚙", () => {
    state.view = "settings";
    state.error = "";
    render();
  }, "nm-btn-icon");
  toolbar.append(addBtn, extractBtn, syncBtn, settingsBtn);
  wrap.appendChild(toolbar);

  // Per-chat selection note
  const cid = chatId();
  if (cid) {
    const note = el("div", { class: "nm-note" },
      `Showing all NPCs. ✓ marks active in this chat for {{npc_memory}}.`);
    wrap.appendChild(note);
  }

  if (!state.npcs.length) {
    wrap.appendChild(el("div", { class: "nm-empty" }, "No NPCs yet. Add one or extract from the current chat."));
    return wrap;
  }

  const list = el("div", { class: "nm-npc-list" });
  const sel = cid ? (state.chatSelections[cid] ?? state.npcs.map(n => n.id)) : [];

  for (const npc of state.npcs) {
    const row = el("div", { class: "nm-npc-row" });

    const check = el("input");
    check.type = "checkbox";
    check.checked = sel.includes(npc.id);
    check.title = "Include in {{npc_memory}} for this chat";
    check.addEventListener("change", async () => {
      if (!cid) return;
      const current = Array.isArray(state.chatSelections[cid])
        ? [...state.chatSelections[cid]]
        : state.npcs.map(n => n.id);
      const next = check.checked
        ? [...new Set([...current, npc.id])]
        : current.filter(id => id !== npc.id);
      state.chatSelections = { ...state.chatSelections, [cid]: next };
      await saveStore({ chatSelections: state.chatSelections });
    });

    const info = el("div", { class: "nm-npc-info" });
    const name = el("strong", {}, npc.name);
    const meta = el("span", { class: "nm-npc-meta" },
      [npc.aliases?.join(", "), npc.appearance].filter(Boolean).join(" · ").slice(0, 80));
    info.append(name, meta);

    const editBtn = btn("Edit", () => {
      state.editingNpc = npc;
      state.draftNpc = {
        name: npc.name,
        aliases: (npc.aliases ?? []).join(", "),
        appearance: npc.appearance ?? "",
        personality: npc.personality ?? "",
        description: npc.description ?? "",
      };
      state.view = "edit";
      state.error = "";
      render();
    }, "nm-btn-small");

    const delBtn = btn("✕", async () => {
      if (!confirm(`Delete "${npc.name}"?`)) return;
      state.npcs = state.npcs.filter(n => n.id !== npc.id);
      await saveStore({ npcs: state.npcs });
      render();
    }, "nm-btn-small nm-btn-danger");

    row.append(check, info, editBtn, delBtn);
    list.appendChild(row);
  }
  wrap.appendChild(list);
  return wrap;
}

// ── Edit view ─────────────────────────────────────────────────────────────────

function buildEditView() {
  const wrap = el("div", { class: "nm-edit-view" });

  const backBtn = btn("← Back", () => { state.view = "list"; state.error = ""; render(); }, "nm-btn-secondary");
  wrap.appendChild(backBtn);

  const form = el("div", { class: "nm-form" });
  form.appendChild(field("Name *", "name", state.draftNpc.name, v => state.draftNpc.name = v));
  form.appendChild(field("Aliases (comma-separated)", "aliases", state.draftNpc.aliases, v => state.draftNpc.aliases = v));
  form.appendChild(textarea("Appearance", state.draftNpc.appearance, v => state.draftNpc.appearance = v));
  form.appendChild(textarea("Personality", state.draftNpc.personality, v => state.draftNpc.personality = v));
  form.appendChild(textarea("Description / Background", state.draftNpc.description, v => state.draftNpc.description = v));

  const actions = el("div", { class: "nm-actions" });
  const saveBtn = btn("Save", async () => {
    const name = state.draftNpc.name.trim();
    if (!name) { state.error = "Name is required."; render(); return; }
    const aliases = state.draftNpc.aliases.split(",").map(a => a.trim()).filter(Boolean);
    if (state.editingNpc) {
      state.npcs = state.npcs.map(n => n.id === state.editingNpc.id
        ? { ...n, name, aliases, appearance: state.draftNpc.appearance.trim(), personality: state.draftNpc.personality.trim(), description: state.draftNpc.description.trim() }
        : n);
    } else {
      state.npcs = [...state.npcs, { id: makeId(), name, aliases, appearance: state.draftNpc.appearance.trim(), personality: state.draftNpc.personality.trim(), description: state.draftNpc.description.trim() }];
    }
    await saveStore({ npcs: state.npcs });
    state.view = "list";
    state.error = "";
    render();
  }, "nm-btn-primary");

  const cardBtn = btn("Create Character Card", async () => {
    const name = state.draftNpc.name.trim();
    if (!name) { state.error = "Name is required before creating a card."; render(); return; }
    if (!confirm(`Create a Marinara character card for "${name}"? This will appear in your character library.`)) return;
    const npc = {
      name,
      aliases: state.draftNpc.aliases.split(",").map(a => a.trim()).filter(Boolean),
      appearance: state.draftNpc.appearance.trim(),
      personality: state.draftNpc.personality.trim(),
      description: state.draftNpc.description.trim(),
    };
    state.busy = true;
    state.error = "";
    render();
    try {
      await createCharacterCard(npc);
      state.error = "";
      alert(`Character card for "${name}" created successfully.`);
    } catch (err) {
      state.error = `Failed to create card: ${err.message}`;
    } finally {
      state.busy = false;
      render();
    }
  }, "nm-btn-secondary");

  actions.append(saveBtn, cardBtn);
  form.appendChild(actions);
  wrap.appendChild(form);
  return wrap;
}

// ── Settings view ──────────────────────────────────────────────────────────────

function buildSettingsView() {
  const wrap = el("div", { class: "nm-settings-view" });
  wrap.appendChild(btn("← Back", () => { state.view = "list"; render(); }, "nm-btn-secondary"));

  const form = el("div", { class: "nm-form" });

  form.appendChild(field("Messages to extract from (last N)", "extractionMessageCount",
    String(state.settings.extractionMessageCount), v => {
      const n = parseInt(v, 10);
      if (Number.isFinite(n) && n > 0) state.settings.extractionMessageCount = n;
    }));

  const fmtWrap = el("div", { class: "nm-field" });
  fmtWrap.appendChild(el("label", { class: "nm-label" }, "Macro format"));
  const fmtSel = el("select", { class: "nm-input" });
  ["full", "brief"].forEach(v => {
    const opt = el("option", { value: v }, v === "full" ? "Full (multi-line)" : "Brief (one-liner)");
    if (state.settings.syncFormat === v) opt.selected = true;
    fmtSel.appendChild(opt);
  });
  fmtSel.addEventListener("change", () => { state.settings.syncFormat = fmtSel.value; });
  fmtWrap.appendChild(fmtSel);
  form.appendChild(fmtWrap);

  const promptWrap = el("div", { class: "nm-field" });
  promptWrap.appendChild(el("label", { class: "nm-label" }, "Extraction prompt override (blank = default)"));
  const promptTA = el("textarea", { class: "nm-input nm-textarea-tall" });
  promptTA.value = state.settings.extractionPrompt;
  promptTA.placeholder = DEFAULT_EXTRACTION_PROMPT;
  promptTA.addEventListener("input", () => { state.settings.extractionPrompt = promptTA.value; });
  promptWrap.appendChild(promptTA);
  form.appendChild(promptWrap);

  const saveBtn = btn("Save settings", async () => {
    await saveStore({ settings: state.settings });
    state.view = "list";
    render();
  }, "nm-btn-primary");
  form.appendChild(saveBtn);

  const clearBtn = btn("Clear all NPCs", async () => { await doClearAllNpcs(); }, "nm-btn-danger nm-btn-clear");
  form.appendChild(clearBtn);

  wrap.appendChild(form);
  return wrap;
}

// ── Extract review view ────────────────────────────────────────────────────────

function buildExtractView() {
  const wrap = el("div", { class: "nm-extract-view" });
  wrap.appendChild(btn("← Discard", () => { state.view = "list"; state.extractUpdates = []; render(); }, "nm-btn-secondary"));

  if (!state.extractUpdates.length) {
    wrap.appendChild(el("div", { class: "nm-empty" }, "No NPC changes detected in the recent messages."));
    const backBtn = btn("Back", () => { state.view = "list"; render(); }, "nm-btn-primary");
    wrap.appendChild(backBtn);
    return wrap;
  }

  wrap.appendChild(el("div", { class: "nm-note" }, "Review and accept NPC changes detected in the conversation."));

  const list = el("div", { class: "nm-npc-list" });
  state.extractUpdates.forEach((u, i) => {
    const row = el("div", { class: "nm-extract-row" });
    const badge = el("span", { class: `nm-badge nm-badge-${u.action}` }, u.action === "create" ? "NEW" : "UPDATE");
    const name = el("strong", {}, u.name);
    const detail = el("div", { class: "nm-extract-detail" });
    if (u.appearance) detail.appendChild(el("div", {}, `Appearance: ${u.appearance}`));
    if (u.personality) detail.appendChild(el("div", {}, `Personality: ${u.personality}`));
    if (u.description) detail.appendChild(el("div", {}, `Background: ${u.description}`));

    const rejectBtn = btn("Skip", () => {
      state.extractUpdates = state.extractUpdates.filter((_, j) => j !== i);
      render();
    }, "nm-btn-small nm-btn-danger");

    row.append(badge, name, detail, rejectBtn);
    list.appendChild(row);
  });
  wrap.appendChild(list);

  const acceptBtn = btn("Accept all", async () => {
    state.npcs = applyUpdates(state.npcs, state.extractUpdates);
    await saveStore({ npcs: state.npcs });
    state.extractUpdates = [];
    state.view = "list";
    state.error = "";
    render();
  }, "nm-btn-primary");
  wrap.appendChild(acceptBtn);
  return wrap;
}

// ─── Actions ──────────────────────────────────────────────────────────────────

async function doExtract() {
  const cid = chatId();
  if (!cid) { state.error = "No active chat detected. Open a chat first."; render(); return; }
  state.busy = true;
  state.error = "";
  render();
  try {
    const charNames = await getChatCharacterNames(cid);
    const updates = await runExtraction(cid, state.npcs, charNames, state.settings);
    state.extractUpdates = updates;
    state.view = "extract";
  } catch (err) {
    state.error = `Extraction failed: ${err.message}`;
  } finally {
    state.busy = false;
    render();
  }
}

async function doClearAllNpcs() {
  if (!confirm(`Delete all ${state.npcs.length} NPC${state.npcs.length !== 1 ? "s" : ""}? This cannot be undone.`)) return;
  state.npcs = [];
  state.chatSelections = {};
  await saveStore({ npcs: [], chatSelections: {} });
  state.view = "list";
  render();
}

async function doSync() {
  const cid = chatId();
  if (!cid) { state.error = "No active chat detected."; render(); return; }
  const active = selectedNpcsForChat();
  state.busy = true;
  state.error = "";
  render();
  try {
    await syncMacro(cid, active, state.settings.syncFormat);
    state.syncedChatId = cid;
    state.error = "";
  } catch (err) {
    state.error = `Sync failed: ${err.message}`;
  } finally {
    state.busy = false;
    render();
  }
}

// ─── DOM helpers ──────────────────────────────────────────────────────────────

function el(tag, attrs = {}, text = null) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  if (typeof text === "string") node.textContent = text;
  return node;
}

function btn(label, onClick, cls = "nm-btn") {
  const b = el("button", { class: cls }, label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

function field(label, id, value, onChange) {
  const wrap = el("div", { class: "nm-field" });
  const lbl = el("label", { class: "nm-label", for: `nm-${id}` }, label);
  const input = el("input", { class: "nm-input", id: `nm-${id}` });
  input.value = value;
  input.addEventListener("input", () => onChange(input.value));
  wrap.append(lbl, input);
  return wrap;
}

function textarea(label, value, onChange) {
  const wrap = el("div", { class: "nm-field" });
  wrap.appendChild(el("label", { class: "nm-label" }, label));
  const ta = el("textarea", { class: "nm-input nm-textarea" });
  ta.value = value;
  ta.addEventListener("input", () => onChange(ta.value));
  wrap.appendChild(ta);
  return wrap;
}

// ─── Mount ───────────────────────────────────────────────────────────────────

async function mount() {
  // Load stored state
  const store = await loadStore();
  state.npcs = store.npcs;
  state.chatSelections = store.chatSelections;
  state.settings = store.settings;

  // Floating toggle button
  const toggleBtn = document.createElement("button");
  toggleBtn.id = BTN_ID;
  toggleBtn.type = "button";
  toggleBtn.textContent = "NPC";
  toggleBtn.title = "Marinara NPC Manager";
  toggleBtn.className = "nm-toggle-btn";
  toggleBtn.addEventListener("click", () => {
    state.open = !state.open;
    state.error = "";
    render();
  });
  document.body.appendChild(toggleBtn);

  // Panel container
  const panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.className = "nm-panel";
  panel.style.display = "none";
  document.body.appendChild(panel);

  marinara.onCleanup(() => {
    toggleBtn.remove();
    panel.remove();
  });
}

mount().catch(err => {
  console.error("[NPC Manager] mount error:", err);
});
