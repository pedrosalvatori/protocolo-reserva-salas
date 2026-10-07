// Valida o asyncapi.yaml: estrutura (parser oficial do AsyncAPI) e exemplos (JSON Schema, via Ajv).
// O parser do AsyncAPI não confere exemplos na versão 3, por isso o Ajv entra aqui.
// Também confere se o validador da página (assets/validator.js) concorda com o Ajv.
// Uso: npm run validate
import { Parser, DiagnosticSeverity } from '@asyncapi/parser';
import Ajv from 'ajv';
import fs from 'node:fs';
import { validate as pageValidate } from '../assets/validator.js';

const file = process.argv[2] || 'asyncapi.yaml';
const { document, diagnostics } = await new Parser().parse(fs.readFileSync(file, 'utf8'), { source: file });

const SEVERITY = ['ERRO', 'aviso', 'info', 'dica'];
for (const d of diagnostics) console.log(`${SEVERITY[d.severity]}  ${d.code}  ${d.path.join('.')}\n      ${d.message}`);
const structural = diagnostics.filter((d) => d.severity === DiagnosticSeverity.Error);
if (!document || structural.length) {
  console.error(`\n✗ ${structural.length} erro(s) de estrutura em ${file}`);
  process.exit(1);
}

// Variações de cada exemplo: a maioria inválida, algumas válidas; as duas implementações devem concordar
function* variations(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
  for (const key of Object.keys(payload)) {
    const { [key]: _removed, ...rest } = payload;
    yield rest;
    yield { ...payload, [key]: 123 };
    yield { ...payload, [key]: null };
    yield { ...payload, [key]: '' };
    yield { ...payload, [key]: 'X#' };
  }
  // todos os campos de texto vazios (menos op e token), como numa atualização sem nada para mudar
  yield Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, k === 'op' || k === 'token' || typeof v !== 'string' ? v : '']));
  yield { ...payload, campo_extra: 'x' };
  yield { ...payload, email: 'joao@email.com' };
  yield { ...payload, date: '2026-09-15' };
  yield { ...payload, status: '999' };
}

const ajv = new Ajv({ strict: false, allErrors: true });
let examples = 0;
let compared = 0;
const invalid = [];
const diverged = [];
for (const msg of document.messages()) {
  const schema = JSON.parse(JSON.stringify(msg.payload()?.json() ?? {}));
  const check = ajv.compile(schema);
  for (const ex of msg.examples()) {
    const payload = ex.payload();
    examples++;
    if (!check(payload)) invalid.push(`${msg.id()} [${ex.name()}]: ${ajv.errorsText(check.errors)}`);
    for (const candidate of [payload, ...variations(payload)]) {
      compared++;
      if (check(candidate) !== (pageValidate(schema, candidate).length === 0)) {
        diverged.push(`${msg.id()}: ${JSON.stringify(candidate).slice(0, 140)}`);
      }
    }
  }
}

invalid.forEach((f) => console.log(`✗ exemplo inválido: ${f}`));
diverged.slice(0, 20).forEach((d) => console.log(`✗ validador da página diverge do Ajv em ${d}`));
console.log(`\n${document.operations().length} operações · ${document.messages().length} mensagens · ${examples} exemplos · ${compared} casos comparados com o validador da página`);
if (invalid.length || diverged.length) {
  console.error(`✗ ${invalid.length} exemplo(s) inválido(s), ${diverged.length} divergência(s) do validador da página`);
  process.exit(1);
}
console.log(`✓ ${file} válido`);
