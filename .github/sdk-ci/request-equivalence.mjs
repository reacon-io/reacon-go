// Only declared date-time fields and explicit optional defaults are equivalent.
export function requestEquivalence(schema, body, schemas) {
  const dates = [], defaults = [];
  function visit(node, value, path, depth = 0) {
    if (!node || depth > 64) return;
    if (node.$ref) {
      const name = node.$ref.replace('#/components/schemas/', '');
      if (node.$ref !== '#/components/schemas/' + name || !schemas[name]) throw Error('Unknown request schema');
      visit(schemas[name], value, path, depth + 1); return;
    }
    // Do not guess which alternative of a union the server selected.
    if (node.anyOf || node.oneOf || node.allOf) return;
    if (node.type === 'string' && node.format === 'date-time' && typeof value === 'string') dates.push(path);
    if (Array.isArray(value)) value.forEach((entry, i) => visit(node.items, entry, [...path, i], depth + 1));
    else if (value && typeof value === 'object') {
      for (const [key, property] of Object.entries(node.properties ?? {})) {
        if (Object.hasOwn(value, key)) visit(property, value[key], [...path, key], depth + 1);
        else if (!(node.required ?? []).includes(key) && Object.hasOwn(property, 'default'))
          defaults.push({path: [...path, key], value: property.default});
      }
    }
  }
  visit(schema, body, []);
  return {dates, defaults};
}
function instant(value) {
  if (typeof value !== 'string') return value;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return value;
  const [year, month, day, hour, minute, second] = match[1].split(/[-T:]/).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59) return value;
  const time = Date.parse(match[1] + match[3]);
  if (!Number.isFinite(time)) return value;
  const fraction = (match[2] ?? '').replace(/0+$/, '');
  // Preserve sub-millisecond precision rather than truncating it with JS Date.
  return new Date(time).toISOString().slice(0, 19) + (fraction ? '.' + fraction : '') + 'Z';
}
export function canonicalRequest(value, equivalence) {
  const result = structuredClone(value);
  function parent(path) {
    let node = result;
    for (const key of path.slice(0, -1)) {
      if (!node || typeof node !== 'object' || !Object.hasOwn(node, key)) return;
      node = node[key];
    }
    return node && typeof node === 'object' ? node : undefined;
  }
  for (const {path, value} of equivalence?.defaults ?? []) {
    const node = parent(path), key = path.at(-1);
    if (node && !Object.hasOwn(node, key)) node[key] = structuredClone(value);
  }
  for (const path of equivalence?.dates ?? []) {
    const node = parent(path), key = path.at(-1);
    if (node && Object.hasOwn(node, key)) node[key] = instant(node[key]);
  }
  return result;
}
