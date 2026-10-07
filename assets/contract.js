// Leitura do contrato (asyncapi.yaml já convertido em objeto), compartilhada pela página e pelo testador.

function pointer(root, ref) {
  return ref.replace(/^#\//, '').split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce((o, k) => (o == null ? undefined : o[k]), root);
}

// Troca cada {$ref} pelo objeto apontado; o nome do componente fica em $name (não enumerável)
export function deref(root) {
  const cache = new Map();
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    if (typeof node.$ref === 'string') {
      const ref = node.$ref;
      if (cache.has(ref)) return cache.get(ref);
      const target = pointer(root, ref);
      if (target === undefined) throw new Error(`$ref não encontrado: ${ref}`);
      const out = {};
      cache.set(ref, out);
      Object.assign(out, walk(target));
      Object.defineProperty(out, '$name', { value: ref.split('/').pop(), enumerable: false });
      return out;
    }
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = walk(v);
    return out;
  };
  return walk(root);
}

// Respostas possíveis de uma mensagem: uma por combinação status + message
export function variantsOf(msg) {
  const p = msg?.payload;
  if (!p) return [];
  if (Array.isArray(p.oneOf)) {
    return p.oneOf.map((v) => ({
      status: v.properties?.status?.const,
      message: v.properties?.message?.const,
      extras: Object.keys(v.properties || {}).filter((k) => k !== 'status' && k !== 'message'),
      arrays: Object.entries(v.properties || {}).filter(([, s]) => s.type === 'array').map(([k]) => k),
      // restrições do envelope + da variante, para validar uma resposta contra esta variante
      schema: { ...v, required: [...new Set([...(p.required || []), ...(v.required || [])])], properties: { ...p.properties, ...v.properties } },
      name: v.$name || null,
    }));
  }
  const st = p.properties?.status?.const;
  return (p.properties?.message?.enum || []).map((m) => ({ status: st, message: m, extras: [], arrays: [], schema: null, name: null }));
}

// Operações do contrato indexadas pelo valor de "op": { id, op, req, res }
export function operationsOf(spec) {
  const ops = new Map();
  for (const [id, op] of Object.entries(spec.operations || {})) {
    ops.set(id, { id, op, req: op.messages?.[0], res: op.reply?.messages?.[0] });
  }
  return ops;
}

// Uma mensagem = um objeto JSON em uma linha (mesmo estilo dos exemplos da planilha)
export const oneLine = (v) => Array.isArray(v) ? `[${v.map(oneLine).join(', ')}]`
  : (v && typeof v === 'object') ? `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${oneLine(x)}`).join(', ')}}`
  : JSON.stringify(v);
