// Validador JSON Schema mínimo, com mensagens em português, para o subconjunto usado no asyncapi.yaml:
// type, const, enum, pattern, required, properties, items, anyOf, oneOf, not, dependencies (forma de lista).
// O script scripts/validate.mjs confere que ele concorda com o Ajv em todos os exemplos e em variações inválidas.

const TYPE_PT = { string: 'string', object: 'objeto', array: 'array' };
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const join = (path, key) => (path ? `${path}.${key}` : key);

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

export function validate(schema, data, path = '') {
  const errs = [];
  if (!schema || typeof schema !== 'object') return errs;
  const at = path || 'mensagem';

  if (schema.type) {
    const t = typeOf(data);
    if (t !== schema.type) {
      let msg = `${at} deve ser ${TYPE_PT[schema.type] || schema.type}`;
      if (schema.type === 'string') msg += t === 'null' ? ' (null não é aceito, regra 2.10)' : ` (veio ${t}; regra 2.3: todos os valores são strings)`;
      errs.push({ path, msg });
      return errs;
    }
  }
  if (has(schema, 'const') && data !== schema.const) errs.push({ path, msg: `${at} deve ser ${JSON.stringify(schema.const)}` });
  if (Array.isArray(schema.enum) && !schema.enum.includes(data)) {
    errs.push({ path, msg: `${at} deve ser um de: ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}` });
  }
  if (schema.pattern && typeof data === 'string' && !new RegExp(schema.pattern, 'u').test(data)) {
    errs.push({ path, msg: `${at} fora do formato ${schema.pattern}` });
  }

  if (typeOf(data) === 'object') {
    for (const k of schema.required || []) {
      if (!has(data, k)) errs.push({ path: join(path, k), msg: `campo obrigatório ausente: ${k}` });
    }
    for (const [k, sub] of Object.entries(schema.properties || {})) {
      if (has(data, k)) errs.push(...validate(sub, data[k], join(path, k)));
    }
    for (const [k, deps] of Object.entries(schema.dependencies || {})) {
      if (!has(data, k) || !Array.isArray(deps)) continue;
      const missing = deps.filter((d) => !has(data, d));
      if (missing.length) errs.push({ path: join(path, k), msg: `${k} exige também: ${missing.join(', ')}` });
    }
  }
  if (typeOf(data) === 'array' && schema.items) {
    data.forEach((v, i) => errs.push(...validate(schema.items, v, `${path}[${i}]`)));
  }

  if (schema.not && validate(schema.not, data, path).length === 0) {
    const req = schema.not.required;
    errs.push({ path, msg: Array.isArray(req) ? `${req.join(', ')} não pode ser enviado` : `${at} não pode corresponder a esse formato` });
  }
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((s) => validate(s, data, path).length === 0)) {
    // Mostra o erro do ramo principal; o outro ramo costuma ser "" (não alterar)
    const main = schema.anyOf.find((s) => s.const !== '') || schema.anyOf[0];
    const keep = schema.anyOf.some((s) => s.const === '') ? ' (ou "" para não alterar)' : '';
    const sub = validate(main, data, path);
    errs.push(...(sub.length ? sub.map((e) => ({ ...e, msg: e.msg + keep })) : [{ path, msg: `${at} inválido${keep}` }]));
  }
  if (Array.isArray(schema.oneOf)) {
    const n = schema.oneOf.filter((s) => validate(s, data, path).length === 0).length;
    if (n !== 1) errs.push({ path, msg: n ? `${at} corresponde a mais de uma variante` : `${at} não corresponde a nenhuma variante permitida` });
  }
  return errs;
}
