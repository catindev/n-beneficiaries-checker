const express = require("express");
const { buildContextAndValidate } = require("./context-builder");

const app = express();
app.use(express.json());

// ─── Audit Log ────────────────────────────────────────────────────────────────

function writeAuditLog(entry) {
  // В прототипе — просто консоль. В проде — отдельный сервис/таблица [Д-021]
  console.log(
    "[AUDIT]",
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        ...entry,
      },
      null,
      2,
    ),
  );
}

// ─── POST /beneficiaries/validate ────────────────────────────────────────────
// Внутренний endpoint — вызывается оркестратором, не мерчантом [Д-031]

app.post("/beneficiaries/validate", async (req, res) => {
  // 1. X-Merchant-Id — сохранен для выбора конфига обязательных полей [Д-032]
  const merchantId = req.headers["x-merchant-id"];
  if (!merchantId) {
    // Unified error format (even for 400) to simplify tracing and Postman tests
    return res.status(400).json({
      status: "FAILED",
      rulesetVersion:
        require("./config/merchant_config.json").default?.ruleset_version ||
        "v1",
      errorDesc: "Bad request",
      errors: [
        {
          field: "X-Merchant-Id",
          code: "HEADER_REQUIRED",
          category: "REQUIRED",
          message: "Заголовок X-Merchant-Id обязателен",
          ruleId: "header_x_merchant_id_present",
        },
      ],
      warnings: [],
    });
  }

  // X-Request-Id — идентификатор заявки оркестратора для корреляции в audit log
  const requestId = req.headers["x-request-id"];

  const payload = req.body;

  // 2. Прогоняем через context-builder
  let result;
  try {
    result = await buildContextAndValidate(payload, merchantId);
  } catch (err) {
    writeAuditLog({
      event: "INTERNAL_ERROR",
      requestId,
      merchantId,
      beneficiary_type: payload?.beneficiary_type,
      error: err.message,
    });
    return res.status(500).json({
      message: "Внутренняя ошибка сервера. Повторите запрос позже.",
    });
  }

  // 3. Audit log для любого исхода
  // Приоритет (BLOCK > ERROR > WARNING) влияет только на HTTP-ответ.
  // В audit log пишутся ВСЕ сработавшие события: основной статус + escalations рядом.
  // Это дает комплаенсу полный контекст для мониторинга и принятия решений [Д-034]
  writeAuditLog({
    event: result.status,
    requestId,
    merchantId,
    beneficiary_type: payload?.beneficiary_type,
    inn: payload?.inn,
    // escalations только в audit log — оркестратору не отдаем [Д-021]
    escalations:
      result.escalations?.length > 0 ? result.escalations : undefined,
  });

  // 4. Формируем ответ (internal checker API)

  const baseResponse = {
    status: result.status === "OK" ? "OK" : "FAILED",
    rulesetVersion: result.rulesetVersion || "v1",
  };

  if (result.status === "COMPLIANCE_BLOCK") {
    return res.status(403).json({
      ...baseResponse,
      errorDesc: "Compliance block triggered",
      errors: result.errors || [],
      warnings: result.warnings || [],
    });
  }

  if (result.status === "VALIDATION_ERROR") {
    return res.status(422).json({
      ...baseResponse,
      errorDesc: "Validation failed",
      errors: result.errors || [],
      warnings: result.warnings || [],
    });
  }

  // Успех
  return res.status(200).json({
    ...baseResponse,
    errorDesc: "Ok",
    warnings: result.warnings || [],
  });
});

// ─── Старт ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервис валидации запущен на порту ${PORT}`);
});
