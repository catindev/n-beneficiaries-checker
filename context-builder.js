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

  // Добавляем values_keys для doc_types — список допустимых числовых кодов
  if (result.doc_types && result.doc_types.values) {
    result.doc_types.values_keys = Object.keys(result.doc_types.values).map(
      Number,
    );
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
    // versioning
    ruleset_version: override.ruleset_version || base.ruleset_version,
    required_fields: [...(base.required_fields || [])],
    required_fields_by_type: JSON.parse(
      JSON.stringify(base.required_fields_by_type || {}),
    ),
  };

  // overrides can be absent for demo merchants
  const overrides = override.overrides || [];
  for (const item of overrides) {
    const types = item.beneficiary_type
      ? [item.beneficiary_type]
      : Object.keys(merged.required_fields_by_type || {});

    const applyToList = (list) => {
      if (item.required === false) {
        return list.filter((f) => f !== item.field);
      }
      if (item.required === true && !list.includes(item.field)) {
        return [...list, item.field];
      }
      return list;
    };

    merged.required_fields = applyToList(merged.required_fields || []);

    for (const t of types) {
      const current = merged.required_fields_by_type?.[t] || [];
      merged.required_fields_by_type[t] = applyToList(current);
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

function loadRules(
  beneficiaryType,
  dictionaries,
  rulesetVersion,
  defaultRulesetVersion,
) {
  // Реальное версионирование правил: правила лежат в rulesets/<version>/...
  // Выбор версии: merchant.ruleset_version || default.ruleset_version. [Д-0V1]
  // Фолбэк: если файла нет в выбранной версии, пытаемся взять из defaultRulesetVersion.
  const regulatoryFiles = [
    "regulatory/usa_links.json",
    "regulatory/fatca.json",
  ];

  const typeFiles = [
    `${beneficiaryType}/format.json`,
    `${beneficiaryType}/cross_fields.json`,
  ];

  const rules = [];

  const tryLoad = (version, relPath) => {
    const fp = path.resolve(`./rulesets/${version}/${relPath}`);
    if (!fs.existsSync(fp)) return null;
    return loadJson(fp);
  };

  for (const relPath of [...regulatoryFiles, ...typeFiles]) {
    // 1) Пытаемся загрузить из выбранной версии
    let file = tryLoad(rulesetVersion, relPath);

    // 2) Фолбэк на дефолтную версию (если отличалась)
    if (
      !file &&
      defaultRulesetVersion &&
      defaultRulesetVersion !== rulesetVersion
    ) {
      file = tryLoad(defaultRulesetVersion, relPath);
    }

    if (!file) {
      throw new Error(
        `Файл правил не найден: rulesets/${rulesetVersion}/${relPath}` +
          (defaultRulesetVersion && defaultRulesetVersion !== rulesetVersion
            ? ` (и нет фолбэка в rulesets/${defaultRulesetVersion}/${relPath})`
            : ""),
      );
    }

    for (const rule of file.rules) {
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
  // Канонический формат API: только YYYY-MM-DD (ISO)
  if (!value) return value;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
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
          code: "DATE_INVALID_FORMAT",
          category: "FORMAT",
          message: "Неверный формат даты. Ожидается YYYY-MM-DD",
          ruleId: "date_format",
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
      rulesetVersion:
        loadJson("./config/merchant_config.json")?.default?.ruleset_version ||
        "v1",
      errors: [
        {
          field: "beneficiary_type",
          code: "BENEFICIARY_TYPE_MISSING",
          category: "REQUIRED",
          message: "Тип бенефициара обязателен",
          ruleId: "beneficiary_type_present",
        },
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
      rulesetVersion:
        loadJson("./config/merchant_config.json")?.default?.ruleset_version ||
        "v1",
      errors: dateErrors,
      warnings: [],
      escalations: [],
    };
  }

  // 3. Загружаем справочники (включая country_codes.values_keys) [Д-028]
  const dictionaries = loadDictionaries();

  // 4. Загружаем конфиг мерчанта [Д-005]
  const merchantConfig = loadMerchantConfig(merchantId);
  const configAll = loadJson("./config/merchant_config.json");
  const defaultRulesetVersion = configAll?.default?.ruleset_version || "v1";
  const rulesetVersion =
    merchantConfig?.ruleset_version || defaultRulesetVersion;

  // 5. Загружаем правила и резолвим $ref на справочники (учет версий + фолбэк)
  const rules = loadRules(
    beneficiaryType,
    dictionaries,
    rulesetVersion,
    defaultRulesetVersion,
  );

  // 6. Строим факты
  // Адрес РФ — плоский объект, flattenPayload разворачивает стандартно [Д-026]
  const facts = flattenPayload(payload);

  // ─── Derived facts (минимальная нормализация без внешних интеграций)
  const docTypeCode = facts["passport.doc_type_code"];
  if (
    docTypeCode !== null &&
    docTypeCode !== undefined &&
    dictionaries?.doc_types?.values
  ) {
    const expectedName = dictionaries.doc_types.values[String(docTypeCode)];
    if (expectedName) facts["passport.doc_type_expected_name"] = expectedName;
    const foreignGroup = dictionaries.doc_types.foreign_iddoc_codes || [];
    facts["passport.isForeignIdDoc"] = foreignGroup.includes(
      Number(docTypeCode),
    );
  }

  // 7. Резолвим $fact ссылки между полями [Д-019]
  const resolvedRules = resolveFactRefs(rules, facts);

  // 8. Нормализуем факты — проставляем null для всех полей упомянутых в правилах
  // но отсутствующих в запросе. Без этого движок падает на "Undefined fact".
  // Список фактов выводится автоматически из правил — не хардкодится.
  const factPaths = collectFactPaths(resolvedRules);
  for (const path of factPaths) {
    if (!(path in facts)) facts[path] = null;
  }

  // 9. Создаем движок и регистрируем операторы
  const engine = new Engine();
  registerOperators(engine);

  // 10. Добавляем правила с учетом конфига мерчанта [Д-020]
  // Presence-правила включаем динамически по merchant_config.required_fields.
  // Важно: используем ЯВНОЕ сопоставление, без substring-матча, чтобы избежать коллизий
  // вроде "address" → "contacts_postal_address". [Д-036]
  const requiredFieldAliases = {
    address: "registration_address",
    email: "contacts_email",
    phone_ru: "contacts_phone_ru",
    postal_address: "contacts_postal_address",
  };

  const rawRequiredFields =
    merchantConfig.required_fields_by_type &&
    merchantConfig.required_fields_by_type[beneficiaryType]
      ? merchantConfig.required_fields_by_type[beneficiaryType]
      : merchantConfig.required_fields || [];

  const effectiveRequiredFields = (rawRequiredFields || []).map(
    (f) => requiredFieldAliases[f] || f,
  );

  for (const rule of resolvedRules) {
    const isPresenceRule = rule.name?.endsWith("_present");
    if (isPresenceRule) {
      // Соглашение именования presence-правил: {field_name}_present, где field_name — snake_case
      // Например: passport_series_present → passport_series
      const fieldName = rule.name.replace("_present", "");

      const shouldInclude = effectiveRequiredFields.some(
        (f) => fieldName === f || fieldName.startsWith(`${f}_`),
      );

      if (!shouldInclude) continue;
    }

    engine.addRule(rule);
  }

  // 11. Прогоняем движок
  const { events } = await engine.run(facts);

  // 12. Агрегируем события и формируем детерминированный список ошибок

  const CATEGORY_ORDER = {
    REQUIRED: 1,
    FORMAT: 2,
    DICT: 3,
    CROSS: 4,
    REGULATORY: 5,
  };

  function normalizeEvent(e) {
    const p = e.params || {};
    return {
      field: p.field || null,
      code: p.code || e.type,
      category:
        p.category ||
        (e.type.startsWith("COMPLIANCE") ? "REGULATORY" : "FORMAT"),
      message: p.message || p.errorDesc || "Ошибка валидации",
      ruleId: p.ruleId || null,
    };
  }

  function dedupe(list) {
    const seen = new Set();
    const out = [];
    for (const item of list) {
      const key = `${item.field ?? ""}|${item.code}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  }

  function suppress(list) {
    // REQUIRED подавляет FORMAT/DICT/CROSS по тому же field
    // FORMAT подавляет CROSS по тому же field
    const byField = new Map();
    for (const item of list) {
      const f = item.field ?? "__no_field__";
      if (!byField.has(f)) byField.set(f, []);
      byField.get(f).push(item);
    }

    const out = [];
    for (const [f, items] of byField.entries()) {
      if (f === "__no_field__") {
        out.push(...items);
        continue;
      }
      const hasRequired = items.some((i) => i.category === "REQUIRED");
      const hasFormat = items.some((i) => i.category === "FORMAT");
      for (const it of items) {
        if (hasRequired && ["FORMAT", "DICT", "CROSS"].includes(it.category))
          continue;
        if (hasFormat && it.category === "CROSS") continue;
        out.push(it);
      }
    }
    return out;
  }

  function sortErrors(list) {
    return list.sort((a, b) => {
      const ao = CATEGORY_ORDER[a.category] || 99;
      const bo = CATEGORY_ORDER[b.category] || 99;
      if (ao !== bo) return ao - bo;
      const af = a.field || "";
      const bf = b.field || "";
      if (af !== bf) return af.localeCompare(bf);
      return (a.code || "").localeCompare(b.code || "");
    });
  }

  const normalized = events.map(normalizeEvent);

  const complianceBlocks = events.filter((e) => e.type === "COMPLIANCE_BLOCK");
  const complianceEscalations = events
    .filter((e) => e.type === "COMPLIANCE_ESCALATION")
    .map((e) => e.params);

  const validationErrors = events
    .filter((e) => e.type === "VALIDATION_ERROR")
    .map(normalizeEvent);

  const validationWarnings = events
    .filter((e) => e.type === "VALIDATION_WARNING")
    .map(normalizeEvent);

  const allErrorsRaw = dedupe(suppress(normalized));
  const allErrors = sortErrors(allErrorsRaw);

  // 13. Возвращаем результат.
  // ВАЖНО: при COMPLIANCE_BLOCK возвращаем полный массив ошибок (Variant A),
  // чтобы у оркестратора/тестов был полный контекст. Что отдавать мерчанту — решит оркестратор.

  if (complianceBlocks.length > 0) {
    return {
      status: "COMPLIANCE_BLOCK",
      rulesetVersion: rulesetVersion,
      errors: allErrors,
      warnings: validationWarnings,
      escalations: complianceEscalations,
    };
  }

  if (validationErrors.length > 0) {
    return {
      status: "VALIDATION_ERROR",
      rulesetVersion: rulesetVersion,
      errors: allErrors.filter((e) => e.category !== "REGULATORY"),
      warnings: validationWarnings,
      escalations: complianceEscalations,
    };
  }

  return {
    status: "OK",
    rulesetVersion: rulesetVersion,
    warnings: validationWarnings,
    escalations: complianceEscalations,
  };
}

module.exports = { buildContextAndValidate };
