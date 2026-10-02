import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));

const js  = await readFile(join(root, "extension.js"),  "utf8");
const css = await readFile(join(root, "style.css"),     "utf8");

const bundle = {
  name: "Marinara NPC Manager",
  version: "1.0.0",
  description: "Persistent NPC tracking for roleplay and game chats. Extract NPCs from conversation, manage their profiles, and inject memory into prompts via {{npc_memory}}.",
  capabilities: ["full_page_access"],
  js,
  css,
};

const json = JSON.stringify(bundle, null, 2) + "\n";
const hash = createHash("sha256").update(json).digest("hex");

await writeFile(join(root, "npc-manager.json"), json, "utf8");

console.log("Built npc-manager.json");
console.log(`SHA-256: ${hash}`);
console.log(`JS: ${(Buffer.byteLength(js, "utf8") / 1024).toFixed(1)} KB  CSS: ${(Buffer.byteLength(css, "utf8") / 1024).toFixed(1)} KB`);
