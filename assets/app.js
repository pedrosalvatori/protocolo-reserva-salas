// Documentação do protocolo no estilo do Swagger UI, montada no navegador a partir do asyncapi.yaml.
import { load, CORE_SCHEMA } from './vendor/js-yaml.js';
import { Marked } from './vendor/marked.js';
import { validate } from './validator.js';

const SPEC_URL = 'asyncapi.yaml';
const LIMIT = 8192;

// ───────────────────────── utilitários ─────────────────────────
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const slug = (s) => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const has = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
const bytesOf = (s) => new TextEncoder().encode(s).length;
// Uma mensagem = um objeto JSON em uma linha (mesmo estilo dos exemplos da planilha)
const oneLine = (v) => Array.isArray(v) ? `[${v.map(oneLine).join(', ')}]`
  : (v && typeof v === 'object') ? `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${oneLine(x)}`).join(', ')}}`
  : JSON.stringify(v);

function storage(kind) {
  return {
    get(k, d = '') { try { return window[kind].getItem(`protocolo:${k}`) ?? d; } catch { return d; } },
    set(k, v) { try { window[kind].setItem(`protocolo:${k}`, v); } catch { /* sem armazenamento */ } },
  };
}
const local = storage('localStorage');
const session = storage('sessionStorage');

const md = new Marked({ gfm: true });
md.use({ renderer: { html({ text }) { return esc(text); } } });
const mdBlock = (s) => md.parse(String(s || ''));
const mdInline = (s) => md.parseInline(String(s || ''));

const ICON = {
  lock: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M5 7V5a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="3" y="7" width="10" height="8" rx="1.5" fill="currentColor"/></svg>',
  unlock: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M5 7V5a3 3 0 0 1 5.8-1.1" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="3" y="7" width="10" height="8" rx="1.5" fill="currentColor"/></svg>',
  chevron: '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M5 8l5 5 5-5" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  copy: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><rect x="5" y="5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M11 3.5V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  warn: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M12 3 2 20h20L12 3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v4.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="17.3" r="1.2" fill="currentColor"/></svg>',
};

// ───────────────────────── $ref ─────────────────────────
function pointer(root, ref) {
  return ref.replace(/^#\//, '').split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce((o, k) => (o == null ? undefined : o[k]), root);
}
function deref(root) {
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

// ───────────────────────── modelo ─────────────────────────
// Cor/rótulo de cada operação, no papel do verbo HTTP do Swagger
const KINDS = { create: 'CREATE', read: 'READ', update: 'UPDATE', delete: 'DELETE', auth: 'AUTH', error: 'ERROR' };
function kindOf(id, op) {
  if (KINDS[op['x-acao']]) return op['x-acao'];
  if (id === 'login' || id === 'logout') return 'auth';
  if (id === 'register' || id.startsWith('create_')) return 'create';
  if (id.includes('update_')) return 'update';
  if (id.includes('delete_')) return 'delete';
  if (id === 'linha_invalida') return 'error';
  return 'read';
}
const ACCESS = {
  publico: { text: 'sem token', lock: false },
  logado: { text: 'qualquer usuário logado', lock: true },
  admin: { text: 'só admin', lock: true, pill: 'admin' },
  dono: { text: 'dono da reserva', lock: true, pill: 'dono' },
  'dono-ou-admin': { text: 'dono da reserva ou admin', lock: true, pill: 'dono/admin' },
};

function variantsOf(msg) {
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

let MODEL = null;
const OPS = new Map();

function buildModel(spec) {
  const tags = (spec.info?.tags || []).map((t) => ({ name: t.name, description: t.description || '', slug: slug(t.name), ops: [] }));
  const byName = new Map(tags.map((t) => [t.name, t]));
  for (const [id, op] of Object.entries(spec.operations || {})) {
    const tagName = op.tags?.[0]?.name || 'Outras';
    if (!byName.has(tagName)) { const t = { name: tagName, description: '', slug: slug(tagName), ops: [] }; tags.push(t); byName.set(tagName, t); }
    const tag = byName.get(tagName);
    const req = op.messages?.[0];
    const res = op.reply?.messages?.[0];
    const o = { id, op, req, res, tag, kind: kindOf(id, op), access: ACCESS[op['x-acesso']] ? op['x-acesso'] : 'logado' };
    const fields = Object.keys(req?.payload?.properties || {});
    const vars = variantsOf(res);
    o.sIdSum = norm(`${id} ${op.summary || ''}`);
    o.sFields = fields.map((f) => ({ label: f, n: norm(f) }));
    o.sResp = vars.map((v) => ({ label: `${v.status} · ${v.message}`, n: norm(`${v.status} ${v.message}`) }));
    o.sAll = norm([id, op.title, op.summary, op.description, tagName, KINDS[o.kind], o.access, ACCESS[o.access].text,
      fields.join(' '), vars.map((v) => `${v.status} ${v.message} ${v.extras.join(' ')}`).join(' '), req?.name, res?.name].join(' '));
    tag.ops.push(o);
    OPS.set(id, o);
  }
  return { spec, tags: tags.filter((t) => t.ops.length), ops: tags.flatMap((t) => t.ops) };
}

// ───────────────────────── HTML ─────────────────────────
function jsonHtml(s) {
  const re = /"(?:[^"\\]|\\.)*"(\s*:)?|[{}[\],]|-?\d+(?:\.\d+)?|\btrue\b|\bfalse\b|\bnull\b/g;
  let out = '', last = 0, m;
  while ((m = re.exec(s))) {
    out += esc(s.slice(last, m.index));
    const t = m[0];
    if (t[0] === '"') out += m[1] ? `<span class="j-key">${esc(t.slice(0, t.length - m[1].length))}</span>${esc(m[1])}` : `<span class="j-str">${esc(t)}</span>`;
    else if ('{}[],'.includes(t)) out += `<span class="j-pun">${esc(t)}</span>`;
    else out += `<span class="j-lit">${esc(t)}</span>`;
    last = re.lastIndex;
  }
  return out + esc(s.slice(last));
}
const codeBlock = (line, label = '') => `<div class="highlight-code">${label ? `<div class="code-label">${label}</div>` : ''}<button class="copy-to-clipboard" type="button" data-copy="${esc(line)}" title="Copiar" aria-label="Copiar">${ICON.copy}</button><pre class="microlight">${jsonHtml(line)}</pre></div>`;

function fieldInfo(s, example) {
  let main = s, keep = false;
  if (Array.isArray(s.anyOf)) { main = s.anyOf.find((x) => x.const !== '') || s.anyOf[0]; keep = s.anyOf.some((x) => x.const === ''); }
  const type = main.type === 'array' ? `array[${main.items?.type || 'object'}]` : (main.type || 'string');
  const meta = [];
  if (has(main, 'const')) meta.push(['valor', `<code>${esc(JSON.stringify(main.const))}</code>`]);
  if (main.enum) meta.push(['valores', main.enum.map((v) => `<code>${esc(JSON.stringify(v))}</code>`).join(' ')]);
  if (main.pattern) meta.push(['formato', `<code class="pattern">${esc(main.pattern)}</code>`]);
  if (has(main, 'default')) meta.push(['padrão', `<code>${esc(JSON.stringify(main.default))}</code>`]);
  if (keep) meta.push(['vazio', '<code>""</code> = não alterar']);
  if (example !== undefined && !has(main, 'const')) meta.push(['exemplo', `<code>${esc(typeof example === 'string' ? JSON.stringify(example) : oneLine(example))}</code>`]);
  return { type, desc: s.description || main.description || '', meta };
}

function modelBox(title, schema) {
  const req = new Set(schema.required || []);
  const rows = Object.entries(schema.properties || {}).map(([k, s]) => {
    const f = fieldInfo(s);
    const fmt = f.meta.map(([, v]) => v).join(' ');
    return `<tr><td class="prop-name">${esc(k)}${req.has(k) ? '<span class="star">*</span>' : ''}</td><td class="prop-type">${esc(f.type)}</td><td class="prop-format">${fmt}</td></tr>`;
  }).join('');
  return `<div class="model-box"><div class="model-title">${esc(title)} {</div><table class="model"><tbody>${rows}</tbody></table><div class="model-title">}</div></div>`;
}

function payloadNotes(p) {
  if (!p) return '';
  const notes = [];
  if (p.description) notes.push(mdInline(p.description));
  if (Array.isArray(p.not?.required)) notes.push(`${p.not.required.map((k) => `<code>${esc(k)}</code>`).join(', ')}: proibido nesta operação (responde 400).`);
  if (p.dependencies) notes.push(`${Object.keys(p.dependencies).map((k) => `<code>${esc(k)}</code>`).join(', ')}: todos juntos ou nenhum.`);
  return notes.length ? `<div class="payload-notes"><ul>${notes.map((n) => `<li>${n}</li>`).join('')}</ul></div>` : '';
}

function exampleFor(o, v) {
  const ex = (o.res.examples || []).find((e) => e.payload?.status === v.status && e.payload?.message === v.message);
  if (ex) return oneLine(ex.payload);
  const obj = { op: o.res.payload?.properties?.op?.const ?? o.res.name, status: v.status, message: v.message };
  for (const k of v.extras) obj[k] = '…';
  return oneLine(obj);
}

// Aviso de ajustes no topo, lido de info.x-novidades; recolhido por versão
function noticeHtml(spec) {
  const n = spec.info?.['x-novidades'];
  if (!n || !Array.isArray(n.itens) || !n.itens.length) return '';
  const collapsed = local.get('aviso-recolhido') === String(n.versao);
  const todo = Array.isArray(n.o_que_mudar) && n.o_que_mudar.length
    ? `<p class="notice-todo-title">O que cada grupo precisa mudar</p><ul class="notice-todo">${n.o_que_mudar.map((i) => `<li>${mdInline(i)}</li>`).join('')}</ul>`
    : '';
  return `<section class="notice wrapper${collapsed ? ' is-collapsed' : ''}" aria-labelledby="notice-title" data-versao="${esc(n.versao)}">
    <div class="notice-box">
      <div class="notice-icon">${ICON.warn}</div>
      <div class="notice-body">
        <p class="notice-kicker">Atualização do protocolo · versão ${esc(n.versao)}${n.data ? ` · ${esc(n.data)}` : ''}</p>
        <h2 id="notice-title">${esc(n.titulo || 'Ajustes no protocolo')}</h2>
        <div class="notice-details">
          <ul>${n.itens.map((i) => `<li>${mdInline(i)}</li>`).join('')}</ul>
          ${todo}
          <p class="notice-more"><a href="#regras" data-open-history>Ver o histórico de versões completo</a></p>
        </div>
      </div>
      <button class="notice-toggle" type="button" aria-expanded="${!collapsed}">${collapsed ? 'Mostrar detalhes' : 'Ocultar detalhes'}</button>
    </div>
  </section>`;
}

function infoHtml(spec) {
  const info = spec.info || {};
  const desc = String(info.description || '');
  const cut = desc.search(/^## /m);
  const intro = cut >= 0 ? desc.slice(0, cut) : desc;
  const sections = cut >= 0 ? desc.slice(cut).split(/^## /m).filter((s) => s.trim()).map((s) => {
    const nl = s.indexOf('\n');
    return { title: s.slice(0, nl).trim(), body: s.slice(nl + 1) };
  }) : [];
  const links = [];
  if (info.contact?.url) links.push(`<a href="${esc(info.contact.url)}">Repositório no GitHub</a>`);
  if (info.contact?.name) links.push(`<span>Responsáveis pelo protocolo: ${esc(info.contact.name)}</span>`);
  return `<section class="information-container wrapper"><div class="info">
    <h1 class="title">${esc(info.title)} <span class="version-stamp">${esc(info.version)}</span><span class="version-stamp spec">AsyncAPI ${esc(spec.asyncapi)}</span></h1>
    <p class="base-url">[ especificação: <a href="${SPEC_URL}">${SPEC_URL}</a> ]</p>
    <div class="description markdown">${mdBlock(intro)}</div>
    ${sections.length ? `<div class="rules">${sections.map((s) => `<details id="regra-${slug(s.title)}"><summary>${mdInline(s.title)}</summary><div class="rule-body markdown">${mdBlock(s.body)}</div></details>`).join('')}</div>` : ''}
    ${links.length ? `<div class="info__links">${links.join('')}</div>` : ''}
  </div></section>`;
}

function serversHtml(spec) {
  const srv = Object.values(spec.servers || {})[0] || {};
  const xt = srv['x-transporte'] || {};
  const label = {
    codificacao: (v) => v, delimitador: (v) => `delimitador ${v}`, tamanho_maximo_bytes: (v) => `até ${v} bytes`,
    timeout_inatividade_s: (v) => `inatividade ${v} s`, validade_token_min: (v) => `token vale ${v} min`, modelo: (v) => v,
  };
  const ip = local.get('ip', srv.variables?.ip?.examples?.[0] || '127.0.0.1');
  const port = local.get('porta', srv.variables?.porta?.examples?.[0] || '5000');
  const proto = srv.protocol || 'tcp';
  return `<section class="scheme-container"><div class="wrapper schemes">
    <div class="servers">
      <span class="schemes-title">Servidor</span>
      <div class="server-input"><span>${esc(proto)}://</span><input id="srv-ip" value="${esc(ip)}" aria-label="IP do servidor" spellcheck="false" autocomplete="off"><span>:</span><input id="srv-port" value="${esc(port)}" aria-label="Porta do servidor" inputmode="numeric" autocomplete="off"></div>
      <div class="transport">${Object.entries(xt).map(([k, v]) => `<span>${esc((label[k] || ((x) => `${k}: ${x}`))(v))}</span>`).join('')}</div>
    </div>
    <div class="auth-input">
      <label for="auth-token">${ICON.lock} Token da sessão <span class="muted">(usado no Try it out)</span></label>
      <input id="auth-token" value="${esc(session.get('token'))}" placeholder="cole aqui o token devolvido pelo login (64 hex)" spellcheck="false" autocomplete="off">
      <span class="auth-state" id="auth-state"></span>
    </div>
  </div></section>`;
}

const tagHtml = (t) => `<section class="opblock-tag-section is-open" id="tag-${t.slug}">
  <button class="opblock-tag" type="button" aria-expanded="true"><span class="tag-name">${esc(t.name)}</span><span class="tag-desc">${mdInline(t.description)}</span><span class="tag-count">${t.ops.length}</span><span class="arrow">${ICON.chevron}</span></button>
  <div class="tag-ops">${t.ops.map(opSummaryHtml).join('')}</div>
</section>`;

function opSummaryHtml(o) {
  const a = ACCESS[o.access];
  return `<div class="opblock opblock-${o.kind}" id="op-${o.id}">
  <button class="opblock-summary" type="button" aria-expanded="false" aria-controls="body-${o.id}">
    <span class="opblock-summary-method">${KINDS[o.kind]}</span>
    <span class="opblock-summary-path">${esc(o.id)}</span>
    <span class="opblock-summary-description">${mdInline(o.op.summary)}</span>
    <span class="opblock-access${a.lock ? '' : ' unlocked'}" title="Acesso: ${esc(a.text)}">${a.pill ? `<span class="pill">${esc(a.pill)}</span>` : ''}${a.lock ? ICON.lock : ICON.unlock}<span class="sr-only">Acesso: ${esc(a.text)}</span></span>
    <span class="arrow">${ICON.chevron}</span>
    <span class="match-chips" hidden></span>
  </button>
  <div class="opblock-body" id="body-${o.id}" role="region" aria-label="${esc(o.id)}" hidden></div>
</div>`;
}

function opBodyHtml(o) {
  const { id, op, req, res } = o;
  const p = req?.payload || {};
  const isText = p.type === 'string';
  const reqEx = req?.examples?.[0]?.payload;
  const reqd = new Set(p.required || []);
  const params = isText
    ? `<p class="param-text">Payload em texto (<code>${esc(req.contentType || 'text/plain')}</code>): ${mdInline(p.description)}</p>`
    : `<div class="table-container"><table class="parameters"><thead><tr><th class="col_header parameters-col_name">Campo</th><th class="col_header">Descrição</th></tr></thead><tbody>${
      Object.entries(p.properties || {}).map(([k, s]) => {
        const f = fieldInfo(s, reqEx && typeof reqEx === 'object' ? reqEx[k] : undefined);
        const r = reqd.has(k);
        return `<tr><td class="parameters-col_name"><div class="parameter__name${r ? ' required' : ''}">${esc(k)}${r ? '<span>&nbsp;*</span>' : ''}</div><div class="parameter__type">${esc(f.type)}</div><div class="parameter__in">${r ? '(obrigatório)' : '(opcional)'}</div></td><td>${f.desc ? `<div class="markdown">${mdInline(f.desc)}</div>` : ''}${f.meta.map(([l, v]) => `<div class="param-meta"><span class="param-meta-k">${l}</span>${v}</div>`).join('')}</td></tr>`;
      }).join('')}</tbody></table></div>`;
  const reqExamples = (req?.examples || []).map((e) => codeBlock(typeof e.payload === 'string' ? e.payload : oneLine(e.payload), `${esc(e.name)} · linha enviada, terminada em \\n`)).join('');
  const resConst = res?.payload?.properties?.op?.const || res?.name || '';
  const tryHtml = isText ? '' : `
    <div class="try" hidden>
      <label class="try-label" for="try-${id}">Mensagem a enviar <span class="muted">(1 objeto JSON em uma linha)</span></label>
      <textarea id="try-${id}" class="body-param__text req-text" rows="4" spellcheck="false" autocomplete="off"></textarea>
      <div class="try-meta"><span class="try-bytes"></span><span>A linha é compactada ao copiar e nos comandos.</span></div>
      <button class="btn execute" type="button" data-action="check-req">Validar requisição</button>
      <div class="req-result" aria-live="polite"></div>
      <div class="try-cmds">
        <h5>Enviar para o seu servidor</h5>
        <div class="cmd"><div class="cmd-head"><span>bash / Linux / macOS (nc) <span class="muted">· Ctrl+C para sair</span></span><button class="btn-copy" type="button" data-copy-from="cmd-sh-${id}">Copiar</button></div><pre class="cmd-code" id="cmd-sh-${id}"></pre></div>
        <div class="cmd"><div class="cmd-head"><span>PowerShell (Windows) <span class="muted">· mostra a linha de resposta</span></span><button class="btn-copy" type="button" data-copy-from="cmd-ps-${id}">Copiar</button></div><pre class="cmd-code" id="cmd-ps-${id}"></pre></div>
      </div>
      <div class="try-response">
        <label class="try-label" for="resp-${id}">Resposta recebida <span class="muted">(cole a linha que o servidor devolveu)</span></label>
        <textarea id="resp-${id}" class="body-param__text res-text" rows="3" spellcheck="false" autocomplete="off" placeholder="${esc(`{"op": "${resConst}", "status": "…", "message": "…"}`)}"></textarea>
        <button class="btn execute secondary" type="button" data-action="check-res">Validar resposta</button>
        <div class="res-result" aria-live="polite"></div>
      </div>
    </div>`;
  const responses = variantsOf(res).map((v) => {
    const shared = v.name && /^E\d/.test(v.name) ? `<a class="schema-ref" href="#schema-${esc(v.name)}" title="components.schemas.${esc(v.name)}">${esc(v.name)}</a>` : '';
    const extras = v.extras.length ? `<div class="response-extras">+ ${v.extras.map((k) => `<code>${esc(k)}${v.arrays.includes(k) ? '[]' : ''}</code>`).join(' ')}</div>` : '';
    return `<tr class="response"><td class="response-col_status"><span class="status-${String(v.status)[0]}xx">${esc(v.status)}</span></td><td><div class="response-message">${esc(v.message)}${shared}</div>${extras}${codeBlock(exampleFor(o, v))}</td></tr>`;
  }).join('');

  return `<div class="opblock-description-wrapper markdown">${mdBlock(op.description)}</div>
  <div class="opblock-section">
    <div class="opblock-section-header">
      <h4>Requisição <span class="dir">C → S</span> <code>${esc(req?.name)}</code></h4>
      ${isText ? '' : '<button class="btn try-out__btn" type="button">Try it out</button>'}
    </div>
    <div class="section-body">
      ${params}
      ${payloadNotes(isText ? null : p)}
      <div class="body-param">
        <div class="tab-list" role="tablist">
          <button type="button" role="tab" aria-selected="true" data-panel="ex-${id}">Exemplo</button>
          ${isText ? '' : `<button type="button" role="tab" aria-selected="false" data-panel="sc-${id}">Schema</button>`}
        </div>
        <div id="ex-${id}" role="tabpanel">${reqExamples}</div>
        ${isText ? '' : `<div id="sc-${id}" role="tabpanel" hidden>${modelBox(req.name, p)}</div>`}
      </div>
      ${tryHtml}
    </div>
  </div>
  <div class="opblock-section">
    <div class="opblock-section-header"><h4>Respostas <span class="dir">S → C</span> <code>${esc(res?.name)}</code></h4></div>
    <div class="section-body">
      <div class="table-container"><table class="responses-table"><thead><tr><th class="col_header response-col_status">Code</th><th class="col_header">message e exemplo</th></tr></thead><tbody>${responses}</tbody></table></div>
    </div>
  </div>`;
}

function schemasHtml(spec) {
  const S = spec.components?.schemas || {};
  const fields = Object.entries(S).filter(([k]) => /^[a-z_]+$/.test(k));
  const records = Object.entries(S).filter(([k, s]) => /^[A-Z]/.test(k) && !/^E\d/.test(k) && s.properties);
  const errors = Object.entries(S).filter(([k]) => /^E\d/.test(k));
  const usage = new Map();
  for (const o of MODEL.ops) for (const v of variantsOf(o.res)) {
    if (v.name && /^E\d/.test(v.name)) { if (!usage.has(v.name)) usage.set(v.name, []); usage.get(v.name).push(o); }
  }
  const fmt = (s) => fieldInfo(s).meta.map(([, v]) => v).join(' ');
  return `<section class="models is-open" id="schemas">
    <h2 class="models-title"><button type="button" aria-expanded="true">Schemas <span class="arrow">${ICON.chevron}</span></button></h2>
    <div class="models-body">
      <div class="model-group"><h3>Campos · dicionário <span class="muted">(${fields.length})</span></h3><div class="table-container"><table><thead><tr><th>Campo</th><th>Tipo</th><th>Formato</th><th>Descrição</th></tr></thead><tbody>
        ${fields.map(([k, s]) => `<tr id="schema-${esc(k)}" data-search="${esc(norm(`${k} ${s.description || ''} ${s.pattern || ''} ${(s.enum || []).join(' ')}`))}"><td>${esc(k)}</td><td class="prop-type">${esc(s.type === 'array' ? `array[${s.items?.type}]` : s.type)}</td><td>${fmt(s)}</td><td>${mdInline(s.description || '')}</td></tr>`).join('')}
      </tbody></table></div></div>
      <div class="model-group"><h3>Registros das listagens <span class="muted">(${records.length})</span></h3><div class="records">
        ${records.map(([k, s]) => `<div id="schema-${esc(k)}" class="record" data-search="${esc(norm(`${k} ${s.title || ''} ${Object.keys(s.properties).join(' ')}`))}">${modelBox(k, s)}<p class="model-desc">${mdInline(s.description || '')}</p></div>`).join('')}
      </div></div>
      <div class="model-group"><h3>Respostas de erro <span class="muted">(${errors.length}, cada uma definida uma vez e referenciada por <code>$ref</code>)</span></h3><div class="table-container"><table><thead><tr><th>Schema</th><th>status</th><th>message</th><th>Usado por</th></tr></thead><tbody>
        ${errors.map(([k, s]) => {
          const st = s.properties?.status?.const;
          const u = usage.get(k) || [];
          return `<tr id="schema-${esc(k)}" data-search="${esc(norm(`${k} ${st} ${s.properties?.message?.const} ${u.map((o) => o.id).join(' ')}`))}"><td>${esc(k)}</td><td><b class="status-${String(st)[0]}xx">${esc(st)}</b></td><td>${esc(s.properties?.message?.const)}</td><td class="used">${u.map((o) => `<a href="#/${o.tag.slug}/${o.id}">${esc(o.id)}</a>`).join(', ')}</td></tr>`;
        }).join('')}
      </tbody></table></div></div>
    </div>
  </section>`;
}

// ───────────────────────── Try it out ─────────────────────────
function server() {
  const ip = ($('#srv-ip')?.value || '').trim().replace(/[^A-Za-z0-9.:-]/g, '') || '127.0.0.1';
  const port = ($('#srv-port')?.value || '').replace(/\D/g, '').slice(0, 5) || '5000';
  return { ip, port };
}
const tokenValue = () => { const v = ($('#auth-token')?.value || '').trim(); return /^[a-f0-9]{64}$/.test(v) ? v : ''; };

function currentLine(text) {
  const t = text.trim();
  try { return oneLine(JSON.parse(t)); } catch { return t.replace(/\s*\r?\n\s*/g, ' '); }
}
function commands(line) {
  const { ip, port } = server();
  const sh = `printf '%s\\n' '${line.replace(/'/g, "'\\''")}' | nc ${ip} ${port}`;
  const ps = `$c=[Net.Sockets.TcpClient]::new('${ip}',${port}); $s=$c.GetStream(); $w=[IO.StreamWriter]::new($s); $w.NewLine="\`n"; $w.WriteLine('${line.replace(/'/g, "''")}'); $w.Flush(); [IO.StreamReader]::new($s).ReadLine(); $c.Close()`;
  return { sh, ps };
}
function prefill(o) {
  const ex = o.req?.examples?.[0]?.payload;
  if (!ex || typeof ex !== 'object') return '';
  const obj = { ...ex };
  const tok = tokenValue();
  if (tok && has(obj, 'token')) obj.token = tok;
  return oneLine(obj);
}
function updateTry(el) {
  const ta = $('.req-text', el);
  if (!ta) return;
  const line = currentLine(ta.value);
  const b = bytesOf(`${line}\n`);
  const out = $('.try-bytes', el);
  out.textContent = `${b} / ${LIMIT} bytes (com o \\n)`;
  out.classList.toggle('over', b > LIMIT);
  const { sh, ps } = commands(line);
  $('[id^="cmd-sh-"]', el).textContent = sh;
  $('[id^="cmd-ps-"]', el).textContent = ps;
}

function checkRequest(o, text) {
  const items = [];
  const t = text.trim();
  if (!t) return [{ level: 'info', msg: 'Escreva ou cole a mensagem JSON.' }];
  if (/\r|\n/.test(t)) items.push({ level: 'warn', msg: 'Há quebra de linha dentro da mensagem: no socket ela precisa ser uma linha única (regra 1.4). A cópia e os comandos já compactam.' });
  let data;
  try { data = JSON.parse(t); } catch (e) {
    return [...items, { level: 'err', msg: `JSON inválido (${e.message}). O servidor responde {"op": "error", "status": "400", "message": "Requisicao invalida"}.` }];
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [...items, { level: 'err', msg: 'A mensagem deve ser um objeto JSON.' }];
  const b = bytesOf(`${oneLine(data)}\n`);
  if (b > LIMIT) items.push({ level: 'err', msg: `${b} bytes com o \\n; o limite é ${LIMIT}. O servidor responde "Mensagem excede o tamanho maximo".` });
  let target = o;
  if (data.op !== o.id) {
    if (!OPS.has(data.op) || data.op === 'linha_invalida') {
      return [...items, { level: 'err', msg: `op ${JSON.stringify(data.op)} é desconhecida. O servidor responde {"op": "error", "status": "400", "message": "Operacao desconhecida"}.` }];
    }
    target = OPS.get(data.op);
    items.push({ level: 'warn', msg: `Esta mensagem é da operação ${data.op}; validei contra ela.` });
  }
  const props = target.req?.payload?.properties || {};
  for (const k of Object.keys(data)) {
    if (!has(props, k)) items.push({ level: 'warn', msg: `Campo "${k}" não existe em ${target.id}: o servidor o ignora (regra 2.9). Confira se não é erro de digitação.` });
  }
  const errs = validate(target.req.payload, data);
  errs.forEach((e) => items.push({ level: 'err', msg: e.msg }));
  if (errs.length) {
    const v400 = variantsOf(target.res).find((v) => v.status === '400');
    if (v400) items.push({ level: 'info', msg: `Resposta esperada do servidor: 400 · ${v400.message}` });
  } else if (!items.some((i) => i.level === 'err')) {
    items.unshift({ level: 'ok', msg: `Requisição válida para ${target.id} (${b} bytes).` });
  }
  return items;
}

function checkResponse(o, text) {
  const items = [];
  const t = text.trim();
  if (!t) return [{ level: 'info', msg: 'Cole a linha que o seu servidor respondeu.' }];
  if (/\r|\n/.test(t)) items.push({ level: 'warn', msg: 'A resposta tem quebra de linha interna: ela precisa ser uma linha única (regra 1.4).' });
  let data;
  try { data = JSON.parse(t); } catch (e) { return [...items, { level: 'err', msg: `JSON inválido (${e.message}).` }]; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [...items, { level: 'err', msg: 'A resposta deve ser um objeto JSON.' }];
  if (data.op === 'error') {
    const errOp = OPS.get('linha_invalida');
    const errs = errOp ? validate(errOp.res.payload, data) : [];
    if (errs.length) errs.forEach((e) => items.push({ level: 'err', msg: e.msg }));
    else items.push({ level: 'warn', msg: `Erro de protocolo: 400 · ${data.message}. Acontece com JSON inválido, op desconhecida ou mensagem acima de ${LIMIT} bytes.` });
    return items;
  }
  const opConst = o.res.payload?.properties?.op?.const;
  const vars = variantsOf(o.res);
  const known = new Set(['op', ...vars.flatMap((v) => Object.keys(v.schema?.properties || {}))]);
  for (const k of Object.keys(data)) if (!known.has(k)) items.push({ level: 'warn', msg: `Campo "${k}" não está no contrato de ${o.res.name}: o cliente o ignora (regra 2.9).` });
  const matches = vars.filter((v) => v.schema && validate(v.schema, data).length === 0);
  if (matches.length === 1) return [{ level: 'ok', msg: `Resposta válida: ${matches[0].status} · ${matches[0].message}` }, ...items];
  if (data.op !== opConst) items.push({ level: 'err', msg: `op deveria ser "${opConst}" (op da requisição + "_response"); veio ${JSON.stringify(data.op)}.` });
  for (const k of ['status', 'message']) {
    if (!has(data, k)) items.push({ level: 'err', msg: `campo obrigatório ausente: ${k}` });
    else if (typeof data[k] !== 'string') items.push({ level: 'err', msg: `${k} deve ser string (regra 2.3)` });
  }
  if (typeof data.status === 'string') {
    const same = vars.filter((v) => v.status === data.status);
    if (!same.length) {
      items.push({ level: 'err', msg: `status "${data.status}" não é resposta possível de ${o.id}. Possíveis: ${[...new Set(vars.map((v) => v.status))].join(', ')}.` });
    } else {
      const exact = same.find((v) => v.message === data.message);
      if (!exact) items.push({ level: 'err', msg: `Para o status ${data.status}, a message esperada é ${same.map((v) => `"${v.message}"`).join(' ou ')}; veio ${JSON.stringify(data.message)}.` });
      else validate(exact.schema, data).filter((e) => e.path !== 'op').forEach((e) => items.push({ level: 'err', msg: e.msg }));
    }
  }
  if (!items.some((i) => i.level === 'err')) items.push({ level: 'err', msg: 'A resposta não corresponde a nenhuma variante do contrato.' });
  return items;
}

const resultHtml = (items) => `<ul class="result-list">${items.map((i) => `<li class="r-${i.level}">${esc(i.msg)}</li>`).join('')}</ul>`;

// ───────────────────────── interação ─────────────────────────
function openOp(o, open) {
  const body = $('.opblock-body', o.el);
  const show = open ?? !o.el.classList.contains('is-open');
  if (show && !body.dataset.built) { body.innerHTML = opBodyHtml(o); body.dataset.built = '1'; }
  o.el.classList.toggle('is-open', show);
  body.hidden = !show;
  $('.opblock-summary', o.el).setAttribute('aria-expanded', String(show));
  if (show) history.replaceState(null, '', `${location.pathname}${location.search}#/${o.tag.slug}/${o.id}`);
}

function toggleTry(o) {
  const box = $('.try', o.el);
  const btn = $('.try-out__btn', o.el);
  const on = box.hidden;
  box.hidden = !on;
  btn.textContent = on ? 'Cancelar' : 'Try it out';
  btn.classList.toggle('cancel', on);
  if (on) {
    const ta = $('.req-text', box);
    if (!ta.value) ta.value = prefill(o);
    updateTry(o.el);
    ta.focus();
  }
}

async function copyText(text, btn) {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.append(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  if (!btn) return;
  btn.classList.add(ok ? 'done' : 'fail');
  const label = btn.dataset.label ?? (btn.dataset.label = btn.textContent);
  if (btn.classList.contains('btn-copy')) btn.textContent = ok ? 'Copiado' : 'Não copiou';
  setTimeout(() => { btn.classList.remove('done', 'fail'); if (btn.classList.contains('btn-copy')) btn.textContent = label; }, 1600);
}

function mark(text, terms) {
  const n = norm(text);
  if (n.length !== text.length || !terms.length) return esc(text);
  const ranges = [];
  for (const t of terms) for (let i = n.indexOf(t); i >= 0; i = n.indexOf(t, i + t.length)) ranges.push([i, i + t.length]);
  if (!ranges.length) return esc(text);
  ranges.sort((a, b) => a[0] - b[0]);
  let out = '', pos = 0;
  for (const [s, e] of ranges) {
    if (s < pos) continue;
    out += `${esc(text.slice(pos, s))}<mark>${esc(text.slice(s, e))}</mark>`;
    pos = e;
  }
  return out + esc(text.slice(pos));
}

// Termos da busca: palavras soltas ou "frase exata" entre aspas
function parseTerms(raw) {
  const terms = [];
  String(raw).replace(/"([^"]+)"|(\S+)/g, (_, phrase, word) => {
    const t = norm(phrase || word).trim().replace(/\s+/g, ' ');
    if (t) terms.push(t);
    return '';
  });
  return terms;
}

function applySearch(raw) {
  const terms = parseTerms(raw);
  const all = (s) => terms.every((t) => s.includes(t));
  let shown = 0;
  for (const o of MODEL.ops) {
    const hit = all(o.sAll);
    o.el.hidden = !hit;
    if (!hit) continue;
    shown++;
    $('.opblock-summary-path', o.el).innerHTML = mark(o.id, terms);
    // Mostra onde a busca bateu: primeiro um trecho com todos os termos, senão termo a termo
    const chips = [];
    if (terms.length && !all(o.sIdSum)) {
      const phrase = terms.join(' ');
      const pick = (list) => list.find((x) => x.n.includes(phrase)) || list.find((x) => all(x.n));
      const f = pick(o.sFields);
      const r = pick(o.sResp);
      if (f) chips.push(`campo <code>${mark(f.label, terms)}</code>`);
      if (r) chips.push(`resposta ${mark(r.label, terms)}`);
    }
    if (!chips.length) for (const t of terms) {
      if (o.sIdSum.includes(t)) continue;
      const f = o.sFields.find((x) => x.n.includes(t));
      if (f) chips.push(`campo <code>${mark(f.label, [t])}</code>`);
      const r = o.sResp.find((x) => x.n.includes(t));
      if (r) chips.push(`resposta ${mark(r.label, [t])}`);
    }
    const box = $('.match-chips', o.el);
    box.innerHTML = [...new Set(chips)].slice(0, 3).map((c) => `<span>${c}</span>`).join('');
    box.hidden = !box.innerHTML;
  }
  for (const t of MODEL.tags) {
    t.el.hidden = t.ops.every((o) => o.el.hidden);
    if (terms.length && !t.el.hidden) { t.el.classList.add('is-open'); $('.opblock-tag', t.el).setAttribute('aria-expanded', 'true'); }
  }
  let schemaHits = 0;
  for (const row of $$('#schemas [data-search]')) {
    const hit = !terms.length || terms.every((t) => row.dataset.search.includes(t));
    row.hidden = !hit;
    if (hit && terms.length) schemaHits++;
  }
  $('#search-status').textContent = terms.length
    ? `${shown} de ${MODEL.ops.length} operações${schemaHits ? ` · ${schemaHits} ${schemaHits === 1 ? 'schema' : 'schemas'}` : ''} para “${raw.trim()}”`
    : '';
  $('#empty').hidden = shown > 0 || !terms.length;
  const url = new URL(location.href);
  if (terms.length) url.searchParams.set('q', raw.trim()); else url.searchParams.delete('q');
  history.replaceState(null, '', url);
}

function setQuery(v) {
  const q = $('#q');
  q.value = v;
  applySearch(v);
}

function route() {
  const m = /^#\/([^/]+)\/([^/?#]+)$/.exec(location.hash);
  const o = m && OPS.get(decodeURIComponent(m[2]));
  if (!o) return;
  if (o.el.hidden) setQuery('');
  o.tag.el.classList.add('is-open');
  openOp(o, true);
  o.el.scrollIntoView({ block: 'start' });
}

function showTokenState() {
  const v = ($('#auth-token').value || '').trim();
  const st = $('#auth-state');
  st.className = 'auth-state';
  if (!v) { st.textContent = ''; return; }
  if (tokenValue()) { st.textContent = '✓ formato válido: entra no campo token das mensagens do Try it out'; st.classList.add('ok'); }
  else { st.textContent = 'formato inválido: são 64 caracteres hexadecimais minúsculos'; st.classList.add('bad'); }
}

function bind() {
  const app = $('#app');
  app.addEventListener('click', (e) => {
    const t = e.target;
    const sum = t.closest('.opblock-summary');
    if (sum) { openOp(OPS.get(sum.closest('.opblock').id.slice(3))); return; }
    const tag = t.closest('.opblock-tag');
    if (tag) { const open = tag.parentElement.classList.toggle('is-open'); tag.setAttribute('aria-expanded', String(open)); return; }
    const mt = t.closest('.models-title button');
    if (mt) { const open = mt.closest('.models').classList.toggle('is-open'); mt.setAttribute('aria-expanded', String(open)); return; }
    const tab = t.closest('[role="tab"]');
    if (tab) {
      for (const b of $$('[role="tab"]', tab.parentElement)) {
        const sel = b === tab;
        b.setAttribute('aria-selected', String(sel));
        document.getElementById(b.dataset.panel).hidden = !sel;
      }
      return;
    }
    const cp = t.closest('[data-copy]');
    if (cp) { copyText(cp.dataset.copy, cp); return; }
    const cpf = t.closest('[data-copy-from]');
    if (cpf) { copyText(document.getElementById(cpf.dataset.copyFrom).textContent, cpf); return; }
    const tryBtn = t.closest('.try-out__btn');
    if (tryBtn) { toggleTry(OPS.get(tryBtn.closest('.opblock').id.slice(3))); return; }
    const act = t.closest('[data-action]');
    if (act) {
      const o = OPS.get(act.closest('.opblock').id.slice(3));
      if (act.dataset.action === 'check-req') $('.req-result', o.el).innerHTML = resultHtml(checkRequest(o, $('.req-text', o.el).value));
      else $('.res-result', o.el).innerHTML = resultHtml(checkResponse(o, $('.res-text', o.el).value));
      return;
    }
    const toggle = t.closest('.notice-toggle');
    if (toggle) {
      const box = toggle.closest('.notice');
      const collapsed = box.classList.toggle('is-collapsed');
      toggle.textContent = collapsed ? 'Mostrar detalhes' : 'Ocultar detalhes';
      toggle.setAttribute('aria-expanded', String(!collapsed));
      local.set('aviso-recolhido', collapsed ? box.dataset.versao : '');
      return;
    }
    if (t.closest('[data-open-history]')) {
      e.preventDefault();
      const hist = $$('.rules details').find((d) => /hist[oó]rico/i.test(d.querySelector('summary')?.textContent || ''));
      if (hist) { hist.open = true; hist.scrollIntoView({ block: 'start' }); }
      return;
    }
    if (t.id === 'clear-search') setQuery('');
  });
  app.addEventListener('input', (e) => {
    const t = e.target;
    if (t.matches('.req-text')) updateTry(t.closest('.opblock'));
    if (t.id === 'srv-ip' || t.id === 'srv-port') {
      local.set(t.id === 'srv-ip' ? 'ip' : 'porta', t.value.trim());
      for (const el of $$('.opblock.is-open')) updateTry(el);
    }
    if (t.id === 'auth-token') { session.set('token', t.value.trim()); showTokenState(); }
  });
  const q = $('#q');
  q.addEventListener('input', () => applySearch(q.value));
  q.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setQuery(''); q.blur(); } });
  window.addEventListener('keydown', (e) => {
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) {
      e.preventDefault();
      q.focus();
      q.select();
    }
  });
  window.addEventListener('hashchange', route);
}

function showError(title, detail) {
  $('#app').innerHTML = `<div class="wrapper"><div class="errors-wrapper" role="alert"><h4>${esc(title)}</h4><p>${esc(detail)}</p></div></div>`;
}

async function main() {
  let text;
  try {
    const r = await fetch(SPEC_URL, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    text = await r.text();
  } catch (e) {
    return showError(`Não foi possível carregar ${SPEC_URL}`, `${e.message}. Abra a página por um servidor: GitHub Pages, ou "npm run serve" na pasta do repositório.`);
  }
  let spec;
  try {
    spec = deref(load(text, { schema: CORE_SCHEMA }));
  } catch (e) {
    const where = e.mark ? ` (linha ${e.mark.line + 1}, coluna ${e.mark.column + 1})` : '';
    return showError(`Erro ao ler ${SPEC_URL}${where}`, e.reason || e.message);
  }
  try {
    MODEL = buildModel(spec);
    $('#app').innerHTML = `${noticeHtml(spec)}${infoHtml(spec)}${serversHtml(spec)}
      <div class="wrapper">
        <p class="search-status" id="search-status" aria-live="polite"></p>
        <div id="ops">${MODEL.tags.map(tagHtml).join('')}</div>
        <div class="empty" id="empty" hidden>Nenhuma operação encontrada. <button class="btn-copy" type="button" id="clear-search">Limpar busca</button></div>
        ${schemasHtml(spec)}
      </div>`;
    for (const t of MODEL.tags) t.el = document.getElementById(`tag-${t.slug}`);
    for (const o of MODEL.ops) o.el = document.getElementById(`op-${o.id}`);
    window.__docsOk = true;
    bind();
    showTokenState();
    const q0 = new URLSearchParams(location.search).get('q');
    if (q0) setQuery(q0);
    route();
  } catch (e) {
    showError(`Erro ao montar a documentação a partir do ${SPEC_URL}`, e.message);
  }
}

main();
