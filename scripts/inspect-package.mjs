import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const archivePath = path.resolve(process.argv[2] || "");
if (!archivePath || !existsSync(archivePath)) {
  throw new Error("Pass the built extension ZIP path.");
}

const listing = execFileSync("unzip", ["-Z1", archivePath], { encoding: "utf8" })
  .split(/\r?\n/)
  .filter(Boolean);

const required = [
  "manifest.json",
  "src/background.js",
  "src/amazon.js",
  "icons/icon16.png",
  "icons/icon48.png",
  "icons/icon128.png"
];
for (const entry of required) {
  if (!listing.includes(entry)) throw new Error(`Extension package is missing ${entry}.`);
}
if (listing.some((entry) => /^la-poste-claim-assistant\//.test(entry))) {
  throw new Error("manifest.json must be at the root of the Chrome Web Store ZIP.");
}
if (listing.some((entry) => /(^|\/)(tests|scripts|\.github|assets)\//.test(entry))) {
  throw new Error("Development-only files were included in the store package.");
}

console.log(`Verified ${path.basename(archivePath)} (${listing.length} files).`);

