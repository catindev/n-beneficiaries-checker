# Контекст проекта (для продолжения разработки)

## Назначение

Прототип сервиса-валидатора (checker) для регистрации бенефициаров номинальных счетов.
Текущий реализованный сценарий: `fl_resident`. Следующий: `fl_nonresident`.

Сервис принимает payload, валидирует по правилам и возвращает:

- `200 OK` — валидно
- `422 VALIDATION_ERROR` — ошибки данных/формата/справочников/кросс-полей
- `403 COMPLIANCE_BLOCK` — блокирующие regulatory-триггеры  
  (при этом чекер возвращает **полный массив ошибок** для внутренней трассировки)

## Движок

- `json-rules-engine` как rule engine.
- `merchant_config` управляет required-fields и overrides.
- `dictionaries` содержат справочники (doc_types, country_codes и т.п.).
- Ошибки агрегируются детерминированно (подавления и сортировка).

## Структура репозитория

- `index.js` — HTTP API, валидация заголовков, единый формат 400.
- `context-builder.js` — сбор фактов, загрузка правил/словарей, запуск движка, агрегация.
- `config/merchant_config.json` — дефолт + мерчантные overrides + выбор версии правил.
- `rulesets/<version>/...` — версии правил (regulatory + per-beneficiary_type).
- `dictionaries/*` — словари.
- `postman/*.json` — Postman-коллекция.

## Версионирование правил (реализовано)

- `default.ruleset_version` лежит в `config/merchant_config.json`.
- Для мерчанта можно задать `merchants[merchantId].ruleset_version`.
- Загрузка правил идет из `rulesets/<rulesetVersion>/...`.
- **Фолбэк**: если файла нет в выбранной версии, берем файл из дефолтной версии.

## Принятые решения (важные)

1. Даты во входном API — **строго `YYYY-MM-DD`**. Иные форматы → `422`.
2. `fatca_resident` / `usa_resident` отсутствуют → `422` (ошибка данных), не `403`.
3. Если есть блокирующий regulatory-триггер → HTTP `403`, но чекер возвращает **весь массив ошибок** (regulatory + validation).
4. Адреса:
   - РФ (`country_code=643`) — структурированные элементы
   - иностранный адрес — строка
   - USA-триггер по адресу — по `country_code=840`, без парсинга строк.
5. `isForeignIdDoc` определяется по `passport.doc_type_code` (31–37, 99); входной флаг — только консистентность.
   Триггер включения CRS/foreign tax блока: `isForeignIdDoc=ДА` и/или адрес не РФ.
6. Миграционная карта и ЕАЭС (для fl_nonresident):
   - чекер не считает 30 суток
   - Беларусь: migration_card не обязательна
   - иные ЕАЭС: допускаем отсутствие migration_card без расчетов
   - если нет stay_document и migration_card (и нет исключения) → `422`
   - передача обеих веток одновременно — допустима

> Все решения фиксируются в `docs/decisions_register.md` после стабилизации изменений.

## Что уже стабилизировано по fl_resident перед fl_nonresident

- Единый формат ошибок для 400/422/403.
- Перевод “missing FATCA/USA flags” в 422.
- Строгий ISO-only формат дат.
- Подготовлены демо-тесты в Postman для проверки ruleset versioning + fallback.

## Следующий этап

- Реализация `fl_nonresident` на базе:
  - shared rules для ФЛ
  - OR-ветки stay_document / migration_card
  - расширенных словарей doc_types/countries
