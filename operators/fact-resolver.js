function resolveFactRefs(rules, facts) {
  return rules.map((rule) => {
    const resolved = JSON.parse(JSON.stringify(rule)); // глубокая копия
    resolveConditions(resolved.conditions, facts);
    return resolved;
  });
}

function resolveConditions(conditions, facts) {
  const all = conditions.all || conditions.any || [];
  for (const condition of all) {
    if (condition.value && condition.value.$fact) {
      // подставляем реальное значение факта
      const factName = condition.value.$fact;
      condition.value = facts[factName];
    }
    // рекурсивно для вложенных условий
    if (condition.all || condition.any) {
      resolveConditions(condition, facts);
    }
  }
}

module.exports = { resolveFactRefs };
