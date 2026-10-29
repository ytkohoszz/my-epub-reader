import { readFileSync, writeFileSync, existsSync } from "fs";

const targetVersion = process.argv[2] || process.env.npm_package_version;

if (!targetVersion || !/^\d+\.\d+\.\d+$/.test(targetVersion)) {
  console.error("Использование: npm run bump <версия> (например: npm run bump 0.2.5)");
  process.exit(1);
}

// 1. Обновляем manifest.json
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t") + "\n");

// 2. Обновляем package.json
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
pkg.version = targetVersion;
writeFileSync("package.json", JSON.stringify(pkg, null, "\t") + "\n");

// 3. Обновляем versions.json
let versions = {};
if (existsSync("versions.json")) {
  try {
    versions = JSON.parse(readFileSync("versions.json", "utf8"));
  } catch {
    versions = {};
  }
}
versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, "\t") + "\n");

console.log(`Версия успешно обновлена до ${targetVersion} (minAppVersion: ${minAppVersion})`);