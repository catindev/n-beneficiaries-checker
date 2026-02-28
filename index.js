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
  // 1. X-Merchant-Id — сохранён для выбора конфига обязательных полей [Д-032]
  const merchantId = req.headers["x-merchant-id"];
  if (!merchantId) {
    return res.status(400).json({
      message: "Заголовок X-Merchant-Id обязателен",
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
  writeAuditLog({
    event: result.status,
    requestId,
    merchantId,
    beneficiary_type: payload?.beneficiary_type,
    inn: payload?.inn,
    // escalations только в audit log — оркестратору не отдаём [Д-021]
    escalations:
      result.escalations?.length > 0 ? result.escalations : undefined,
  });

  // 4. Формируем ответ

  // Комплаенс-блок — оркестратор останавливает заявку [Д-031]
  if (result.status === "COMPLIANCE_BLOCK") {
    return res.status(403).json({
      message: "Регистрация данного бенефициара невозможна",
    });
  }

  // Ошибки валидации — оркестратор останавливает заявку [Д-031]
  if (result.status === "VALIDATION_ERROR") {
    const response = {
      message: "Ошибка валидации данных бенефициара",
      errors: result.errors,
    };
    if (result.warnings?.length > 0) {
      response.warnings = result.warnings;
    }
    return res.status(422).json(response);
  }

  // Успех [Д-031] — оркестратор продолжает процесс
  // warnings передаются оркестратору — он решает как с ними поступить [Д-013]
  const response = { message: "Ok" };
  if (result.warnings?.length > 0) {
    response.warnings = result.warnings;
  }

  return res.status(200).json(response);
});

// ─── Старт ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервис валидации запущен на порту ${PORT}`);
});
