# POST /beneficiaries/validate

## Headers

```
X-Merchant-Id: <string> // обязательный
X-Request-Id: <string> // опциональный, для корреляции в audit log
```

## Тело запроса

Важно: `passport.doc_type_name` обязателен (при отсутствии — 422).

```
{
  "beneficiary_type": "fl_resident",
  "inn": "771234567859",
  "last_name": "Иванов",
  "first_name": "Иван",
  "middle_name": "Иванович",
  "birth_date": "1990-01-01",
  "birth_place": "Москва",
  "citizenship": "RU",
  "passport": {
    "doc_type_code": 21,
    "doc_type_name": "Паспорт гражданина Российской Федерации",
    "series": "4510",
    "number": "123456",
    "issue_date": "2010-01-01",
    "expiry_date": null,
    "issued_by": "ОВД Пресненского района г. Москвы",
    "division_code": "770-001",
    "foreign_doc": "НЕТ"
  },
  "registration_address": {
    "country_code": 643,
    "region": "Москва",
    "city": "Москва",
    "street": "Ленина",
    "house": "1",
    "flat": "1"
  },
  "residence_address": null,
  "contacts": {
    "phone_ru": "+79001234567",
    "email": "ivanov@example.com",
    "postal_address": null
  },
  "beneficiary_id": "BNF-001",
  "fatca_resident": "НЕТ",
  "usa_resident": "НЕТ",
  "beneficiary_date": "2024-01-01"
}
```

## Форматы дат

Сервис принимает даты в форматах:

- `YYYY-MM-DD`

Нераспознанный формат → `422` (VALIDATION_ERROR).

## Правила контактов

По умолчанию требуется **хотя бы один** контакт:

- `contacts.phone_ru` или `contacts.email` или `contacts.postal_address`

Дополнительно мерчант может потребовать конкретные контакты через `config/merchant_config.json` (см. раздел ниже).

## Конфигурация обязательных полей per-merchant

Полнота payload управляется конфигом по `X-Merchant-Id` (`config/merchant_config.json`).

- Если мерчант найден, то применяется его `required_fields_by_type[beneficiary_type]` (или legacy `required_fields`)
- Если мерчант не найден, то применяется `default.required_fields_by_type[beneficiary_type]` (или legacy `default.required_fields`)

Поддерживаются алиасы полей (для удобства конфига):

- `address` → `registration_address`
- `email` → `contacts.email`
- `phone_ru` → `contacts.phone_ru`
- `postal_address` → `contacts.postal_address`

Presence-правила включаются по точному совпадению или префиксу (например, `passport` включает `passport.*`).

## Ответы

> Важно! API валидатора для "внутреннего" использования (вызывается оркестратором). Сейчас отдаем максимальную детализацию для трассировки. Что из этого будет прокидываться мерчанту уже решит оркестратор.

### 400 Bad Request (заголовок отсутствует)

```json
{ "message": "Заголовок X-Merchant-Id обязателен" }
```

### 200 OK

```json
{
  "status": "OK",
  "rulesetVersion": "v1",
  "errorDesc": "Ok",
  "warnings": []
}
```

### 422 Unprocessable Entity (VALIDATION_ERROR)

```json
{
  "status": "FAILED",
  "rulesetVersion": "v1",
  "errorDesc": "Validation failed",
  "errors": [
    {
      "field": "inn",
      "code": "INN_MISSING",
      "category": "REQUIRED",
      "message": "ИНН обязателен",
      "ruleId": "inn_present"
    }
  ],
  "warnings": []
}
```

### 403 Forbidden (COMPLIANCE_BLOCK)

```json
{
  "status": "FAILED",
  "rulesetVersion": "v1",
  "errorDesc": "Compliance block triggered",
  "errors": [
    {
      "field": null,
      "code": "USA_BIRTH_PLACE",
      "category": "REGULATORY",
      "message": "Регистрация данного бенефициара невозможна",
      "ruleId": "usa_birth_place"
    }
  ],
  "warnings": []
}
```

> При 403 валидатор также может вернуть не‑regulatory ошибки в `errors[]` (агрегация по Variant A).
