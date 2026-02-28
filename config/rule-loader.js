const fs = require("fs");
const path = require("path");

// Загружаем все справочники один раз при старте
function loadDictionaries() {
  const dir = path.resolve("./dictionaries");
  const result = {};
  for (const file of fs.readdirSync(dir)) {
    const name = file.replace(".json", "");
    result[name] = JSON.parse(fs.readFileSync(`${dir}/${file}`, "utf-8"));
  }
  return result;
}

// Рекурсивно резолвим все $ref в правилах
function resolveRefs(obj, dictionaries) {
  if (typeof obj !== "object" || obj === null) return obj;

  if (obj.$ref) {
    // "$ref": "dictionaries.citizenship.blocked"
    const parts = obj.$ref.split(".");
    let value = { dictionaries };
    for (const part of parts) value = value[part];
    return value;
  }

  for (const key of Object.keys(obj)) {
    obj[key] = resolveRefs(obj[key], dictionaries);
  }
  return obj;
}

function loadRules(rulePaths) {
  const dictionaries = loadDictionaries();
  return rulePaths
    .map((p) => JSON.parse(fs.readFileSync(p, "utf-8")))
    .flatMap((f) => f.rules)
    .map((rule) => resolveRefs(rule, dictionaries));
}

module.exports = { loadRules };
