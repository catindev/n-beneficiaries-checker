# POST /beneficiaries/validate

## Headers

```
X-Merchant-Id: <string> // обязательный
X-Request-Id: <string> // опциональный, для корреляции в audit log
```

## Тело запроса

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

## Ответы

### 400 Bad Request (заголовок отсутствует)

```
{ "message": "Заголовок X-Merchant-Id обязателен" }
```

### 403 Forbidden (комплаенс-триггер)

```
{ "message": "Регистрация данного бенефициара невозможна" }
```

### 422 Unprocessable Entity (ошибки валидации)

```
{
    "message": "Ошибка валидации данных бенефициара",
    "errors": [ { "field": "passport.series", "message": "..." } ],
    "warnings": [ { "field": "passport.series", "message": "..." } ]
}
```

### 200 OK (успех)

```
{ "message": "Ok" }
```
