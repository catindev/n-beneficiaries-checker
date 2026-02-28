// context-builder.js v1.4
// Изменения: поддержка country_code в адресах [Д-026, Д-027, Д-028]
//            добавлен справочник country_codes в loadDictionaries
//            адрес РФ — плоский объект (region/city/street/house/flat)

const fs = require("fs");
const path = require("path");
const { Engine } = require("json-rules-engine");
const { resolveFactRefs } = require("./operators/fact-resolver");

// ─── Загрузка конфигов ────────────────────────────────────────────────────────

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf-8"));
}

function loadDictionaries() {
  const dir = path.resolve("./dictionaries");
  const result = {};
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const name = file.replace(".json", "");
    result[name] = loadJson(`./dictionaries/${file}`);
  }

  // Добавляем values_keys для country_codes — список допустимых числовых кодов
  // Нужен для оператора notIn в правиле registration_address_country_code_valid [Д-028]
  if (result.country_codes && result.country_codes.values) {
    result.country_codes.values_keys = Object.keys(
      result.country_codes.values,
    ).map(Number);
  }

  return result;
}

function loadMerchantConfig(merchantId) {
  const config = loadJson("./config/merchant_config.json");
  const base = { ...config.default };
  const override = config.merchants?.[merchantId];

  if (!override) return base; // [Д-005] — неизвестный мерчант → дефолт

  const merged = {
    ...base,
    required_fields: [...base.required_fields],
  };

  for (const item of override.overrides) {
    if (item.required === false) {
      merged.required_fields = merged.required_fields.filter(
        (f) => f !== item.field,
      );
    } else if (
      item.required === true &&
      !merged.required_fields.includes(item.field)
    ) {
      merged.required_fields.push(item.field);
    }
  }

  return merged;
}

// ─── Резолвинг $ref на справочники ───────────────────────────────────────────

function resolveRefs(obj, dictionaries) {
  if (typeof obj !== "object" || obj === null) return obj;

  if (obj.$ref) {
    // Путь вида "dictionaries.citizenship.blocked"
    // dictionaries уже = { citizenship: {...}, country_codes: {...} }
    // поэтому первый сегмент "dictionaries" пропускаем и стартуем с самого объекта
    const parts = obj.$ref.split(".");
    if (parts[0] !== "dictionaries") {
      throw new Error(`$ref должен начинаться с "dictionaries": ${obj.$ref}`);
    }
    let value = dictionaries;
    for (const part of parts.slice(1)) {
      value = value[part];
      if (value === undefined) throw new Error(`$ref не найден: ${obj.$ref}`);
    }
    return value;
  }

  const result = Array.isArray(obj) ? [] : {};
  for (const key of Object.keys(obj)) {
    result[key] = resolveRefs(obj[key], dictionaries);
  }
  return result;
}

// ─── Загрузка правил по типу бенефициара ─────────────────────────────────────

function loadRules(beneficiaryType, dictionaries) {
  const regulatoryFiles = [
    "./rules/regulatory/usa_links.json",
    "./rules/regulatory/fatca.json",
  ];

  const typeFiles = [
    `./rules/${beneficiaryType}/format.json`,
    `./rules/${beneficiaryType}/cross_fields.json`,
  ];

  const rules = [];

  for (const filePath of [...regulatoryFiles, ...typeFiles]) {
    if (!fs.existsSync(path.resolve(filePath))) {
      throw new Error(`Файл правил не найден: ${filePath}`);
    }
    const file = loadJson(filePath);
    for (const rule of file.rules) {
      // Глубокая копия перед резолвингом чтобы не мутировать оригинал
      const ruleCopy = JSON.parse(JSON.stringify(rule));
      rules.push(resolveRefs(ruleCopy, dictionaries));
    }
  }

  return rules;
}

// ─── Кастомные операторы ──────────────────────────────────────────────────────

function registerOperators(engine) {
  engine.addOperator("fieldPresent", (factValue, expected) => {
    const present =
      factValue !== null && factValue !== undefined && factValue !== "";
    return present === expected;
  });

  // Срабатывает если формат НЕ совпадает с regex
  engine.addOperator("matchesRegex", (factValue, regex) => {
    if (!factValue) return false;
    return !new RegExp(regex).test(factValue);
  });

  engine.addOperator("allSameDigits", (factValue, expected) => {
    const result = /^(\d)\1+$/.test(String(factValue));
    return result === expected;
  });

  // Контрольный разряд ИНН физлица — алгоритм ФНС
  engine.addOperator("validInnChecksum", (factValue, expected) => {
    const inn = String(factValue);
    if (inn.length !== 12) return false === expected;

    const n = (inn, coeffs) =>
      (coeffs.reduce((sum, c, i) => sum + c * parseInt(inn[i]), 0) % 11) % 10;

    const n11 = n(inn, [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]);
    const n12 = n(inn, [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]);

    const valid = parseInt(inn[10]) === n11 && parseInt(inn[11]) === n12;
    return valid === expected;
  });

  engine.addOperator("notIn", (factValue, array) => {
    return !array.includes(factValue);
  });

  // Проверка вхождения подстроки — используется в usa_birth_place и escalation-правилах
  engine.addOperator("contains", (factValue, substring) => {
    if (!factValue || typeof factValue !== "string") return false;
    return factValue.includes(substring);
  });

  engine.addOperator("containsGarbageChars", (factValue, expected) => {
    const result = /[()[\]{}<>,;:#!%?«»"_+=$*|~`&^@]/.test(String(factValue));
    return result === expected;
  });

  engine.addOperator("dateAfterToday", (factValue, expected) => {
    const result = new Date(factValue) > new Date();
    return result === expected;
  });

  // value резолвится в реальное значение факта через fact-resolver [Д-019]
  engine.addOperator("dateBefore", (factValue, compareValue) => {
    if (!factValue || !compareValue) return false;
    return new Date(factValue) < new Date(compareValue);
  });

  engine.addOperator("validDateFormat", (factValue, expected) => {
    const result =
      /^\d{4}-\d{2}-\d{2}$/.test(String(factValue)) &&
      !isNaN(new Date(factValue).getTime());
    return result === expected;
  });
}

// ─── Нормализация дат ─────────────────────────────────────────────────────────

function normalizeDate(value) {
  if (!value) return value;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const match = value.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (match) return `${match[3]}-${match[2]}-${match[1]}`;
  return null;
}

function normalizeDates(payload) {
  const dateFields = [
    "birth_date",
    "beneficiary_date",
    "passport.issue_date",
    "passport.expiry_date",
  ];

  const errors = [];
  const result = JSON.parse(JSON.stringify(payload)); // глубокая копия [Д-022]

  for (const fieldPath of dateFields) {
    const parts = fieldPath.split(".");
    let obj = result;
    for (let i = 0; i < parts.length - 1; i++) {
      obj = obj?.[parts[i]];
    }
    const lastKey = parts[parts.length - 1];
    if (obj && obj[lastKey]) {
      const normalized = normalizeDate(obj[lastKey]);
      if (normalized === null) {
        errors.push({
          field: fieldPath,
          message: "Неверный формат даты. Ожидается YYYY-MM-DD или ДД.ММ.ГГГГ",
        });
      } else {
        obj[lastKey] = normalized;
      }
    }
  }

  return { payload: result, dateErrors: errors };
}

// ─── Флаттенинг payload для facts движка ─────────────────────────────────────
// Адрес РФ — плоский объект, разворачивается стандартно [Д-026]

function flattenPayload(obj, prefix = "") {
  const result = {};
  for (const key of Object.keys(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const value = obj[key];

    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      Object.assign(result, flattenPayload(value, fullKey));
    } else {
      result[fullKey] = value;
    }
  }
  return result;
}

// ─── Сбор всех путей фактов из правил ────────────────────────────────────────
// Рекурсивно обходит правила и собирает все упомянутые факты.
// Позволяет проставить null для отсутствующих полей без хардкода [Д-019]

function collectFactPaths(rules) {
  const paths = new Set();
  const walk = (obj) => {
    if (!obj || typeof obj !== "object") return;
    if (obj.fact && typeof obj.fact === "string") paths.add(obj.fact);
    Object.values(obj).forEach(walk);
  };
  rules.forEach(walk);
  return paths;
}

// ─── Главная функция ──────────────────────────────────────────────────────────

async function buildContextAndValidate(rawPayload, merchantId) {
  // 1. Определяем тип бенефициара
  const beneficiaryType = rawPayload.beneficiary_type;
  if (!beneficiaryType) {
    return {
      status: "VALIDATION_ERROR",
      errors: [
        { field: "beneficiary_type", message: "Тип бенефициара обязателен" },
      ],
      warnings: [],
      escalations: [],
    };
  }

  // 2. Нормализуем даты [Д-003]
  const { payload, dateErrors } = normalizeDates(rawPayload);
  if (dateErrors.length > 0) {
    return {
      status: "VALIDATION_ERROR",
      errors: dateErrors,
      warnings: [],
      escalations: [],
    };
  }

  // 3. Загружаем справочники (включая country_codes.values_keys) [Д-028]
  const dictionaries = loadDictionaries();

  // 4. Загружаем правила и резолвим $ref на справочники
  const rules = loadRules(beneficiaryType, dictionaries);

  // 5. Загружаем конфиг мерчанта [Д-005]
  const merchantConfig = loadMerchantConfig(merchantId);

  // 6. Строим факты
  // Адрес РФ — плоский объект, flattenPayload разворачивает стандартно [Д-026]
  const facts = flattenPayload(payload);

  // 7. Резолвим $fact ссылки между полями [Д-019]
  const resolvedRules = resolveFactRefs(rules, facts);

  // 8. Нормализуем факты — проставляем null для всех полей упомянутых в правилах
  // но отсутствующих в запросе. Без этого движок падает на "Undefined fact".
  // Список фактов выводится автоматически из правил — не хардкодится.
  const factPaths = collectFactPaths(resolvedRules);
  for (const path of factPaths) {
    if (!(path in facts)) facts[path] = null;
  }

  // 9. Создаём движок и регистрируем операторы
  const engine = new Engine();
  registerOperators(engine);

  // 10. Добавляем правила с учётом конфига мерчанта [Д-020]
  for (const rule of resolvedRules) {
    const isPresenceRule = rule.name?.endsWith("_present");
    if (isPresenceRule) {
      const fieldName = rule.name.replace("_present", "").replace(/_/g, ".");
      if (!merchantConfig.required_fields.some((f) => fieldName.includes(f))) {
        continue;
      }
    }
    engine.addRule(rule);
  }

  // 11. Прогоняем движок
  const { events } = await engine.run(facts);

  // 12. Агрегируем по типу события
  const complianceBlocks = events.filter((e) => e.type === "COMPLIANCE_BLOCK");
  const complianceEscalations = events.filter(
    (e) => e.type === "COMPLIANCE_ESCALATION",
  );
  const validationErrors = events.filter((e) => e.type === "VALIDATION_ERROR");
  const validationWarnings = events.filter(
    (e) => e.type === "VALIDATION_WARNING",
  );

  // 13. Возвращаем результат
  if (complianceBlocks.length > 0) {
    return {
      status: "COMPLIANCE_BLOCK",
      escalations: complianceEscalations.map((e) => e.params), // только в audit log [Д-021]
    };
  }

  if (validationErrors.length > 0) {
    return {
      status: "VALIDATION_ERROR",
      errors: validationErrors.map((e) => ({
        field: e.params.field,
        message: e.params.message,
      })),
      warnings: validationWarnings.map((e) => ({
        field: e.params.field,
        message: e.params.message,
      })),
      escalations: complianceEscalations.map((e) => e.params),
    };
  }

  return {
    status: "OK",
    warnings: validationWarnings.map((e) => ({
      field: e.params.field,
      message: e.params.message,
    })),
    escalations: complianceEscalations.map((e) => e.params),
  };
}

module.exports = { buildContextAndValidate };
