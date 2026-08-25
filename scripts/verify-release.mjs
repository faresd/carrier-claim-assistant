import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const projectDir = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(path.join(projectDir, "manifest.json"), "utf8"));
const packageJson = JSON.parse(readFileSync(path.join(projectDir, "package.json"), "utf8"));
const suppliedTag = process.argv[2] || process.env.GITHUB_REF_NAME || `v${manifest.version}`;

if (manifest.version !== packageJson.version) {
  throw new Error(`Version mismatch: manifest ${manifest.version}, package ${packageJson.version}.`);
}
if (suppliedTag !== `v${manifest.version}`) {
  throw new Error(`Release tag ${suppliedTag} must equal v${manifest.version}.`);
}
if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(manifest.version)) {
  throw new Error(`Manifest version ${manifest.version} is not Chrome Web Store compatible.`);
}

console.log(`Release ${suppliedTag} matches the extension manifest.`);

