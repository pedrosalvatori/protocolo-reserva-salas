#!/usr/bin/env node
// Testador do protocolo de Reserva de Salas.
// Conecta por TCP no servidor, executa as operações do protocolo e confere cada resposta contra o asyncapi.yaml.
//
//   node scripts/testar-servidor.mjs                         pergunta IP, porta e conta de admin
//   node scripts/testar-servidor.mjs 127.0.0.1 5000          testa direto (sem os testes de admin)
//   node scripts/testar-servidor.mjs 127.0.0.1 5000 --admin admin@email.com:senha123
//   node scripts/testar-servidor.mjs 127.0.0.1 5000 --interativo
//
// Precisa só do Node 18 ou mais novo; não precisa de npm install.
import net from 'node:net';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { load, CORE_SCHEMA } from '../assets/vendor/js-yaml.js';
import { deref, variantsOf, operationsOf, oneLine } from '../assets/contract.js';
import { validate } from '../assets/validator.js';

const LIMIT = 8192;

// ───────────────────────── argumentos ─────────────────────────
const args = process.argv.slice(2);
function opcao(nome, comValor) {
  const i = args.indexOf(nome);
  if (i < 0) return undefined;
  const [, valor] = args.splice(i, comValor ? 2 : 1);
  return comValor ? valor : true;
}
const ajuda = opcao('--ajuda', false) || opcao('--help', false) || opcao('-h', false);
const modoInterativo = opcao('--interativo', false);
let adminTexto = opcao('--admin', true);
const TIMEOUT = Number(opcao('--timeout', true)) || 5000;
let [host, porta] = args;

if (ajuda) {
  console.log(`Uso: node scripts/testar-servidor.mjs [ip] [porta] [opções]

  --admin email:senha   conta de admin já cadastrada no servidor (habilita os testes de admin e de salas)
  --interativo          você digita as mensagens e vê cada resposta validada
  --timeout ms          espera máxima por resposta (padrão 5000)

Sem ip e porta, o testador pergunta.`);
  process.exit(0);
}

// ───────────────────────── saída ─────────────────────────
const comCor = process.stdout.isTTY && !process.env.NO_COLOR;
const pinta = (c) => (s) => (comCor ? `\x1b[${c}m${s}\x1b[0m` : String(s));
const verde = pinta('32');
const vermelho = pinta('31');
const amarelo = pinta('33');
const cinza = pinta('90');
const negrito = pinta('1');
const bytes = (s) => Buffer.byteLength(s, 'utf8');
const trecho = (s) => (s.length > 120 ? `${s.slice(0, 120)}…` : s);

// ───────────────────────── contrato ─────────────────────────
const SPEC = deref(load(fs.readFileSync(new URL('../asyncapi.yaml', import.meta.url), 'utf8'), { schema: CORE_SCHEMA }));
const OPS = operationsOf(SPEC);

// ───────────────────────── conexão TCP ─────────────────────────
class Conexao {
  constructor() { this.sock = null; this.aberturas = 0; }

  abrir() {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host, port: Number(porta) });
      let conectou = false;
      this.sock = sock;
      this.buf = '';
      this.esperando = [];
      sock.setEncoding('utf8');
      sock.on('connect', () => { conectou = true; this.aberturas++; resolve(); });
      sock.on('error', (e) => {
        if (!conectou) reject(new Error(`não foi possível conectar em ${host}:${porta} (${e.code || e.message})`));
        this.encerrar(new Error(`erro na conexão: ${e.code || e.message}`), sock);
      });
      sock.on('close', () => this.encerrar(new Error('o servidor fechou a conexão sem responder'), sock));
      sock.on('data', (d) => {
        this.buf += d;
        for (let i = this.buf.indexOf('\n'); i >= 0; i = this.buf.indexOf('\n')) {
          const bruta = this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 1);
          this.esperando.shift()?.ok({ linha: bruta.replace(/\r$/, ''), crlf: bruta.endsWith('\r') });
        }
      });
    });
  }

  encerrar(erro, sock = this.sock) {
    if (!sock || sock !== this.sock) return;
    this.sock = null;
    sock.destroy();
    for (const w of this.esperando.splice(0)) w.falha(erro);
  }

  // Manda uma linha e espera a próxima linha de resposta; reconecta se o servidor fechou (regra 1.11)
  async enviar(texto) {
    if (!this.sock) await this.abrir();
    return new Promise((ok, falha) => {
      const timer = setTimeout(() => this.encerrar(new Error(`sem resposta em ${TIMEOUT / 1000} s`)), TIMEOUT);
      this.esperando.push({ ok: (r) => { clearTimeout(timer); ok(r); }, falha: (e) => { clearTimeout(timer); falha(e); } });
      this.sock.write(`${texto}\n`);
    });
  }

  fechar() { this.encerrar(new Error('conexão encerrada pelo testador')); }
}

// ───────────────────────── checagem de uma resposta ─────────────────────────
const falha = (texto) => ({ texto });
const aviso = (texto) => ({ texto, aviso: true });
let avisouCrlf = false;

// Envia `req` (objeto ou texto cru) e confere a resposta: formato, op, contrato e o status/message esperados
async function chamar(con, req, esperado = {}) {
  const texto = typeof req === 'string' ? req : JSON.stringify(req);
  const r = await con.enviar(texto);
  const problemas = [];
  if (r.crlf && !avisouCrlf) {
    avisouCrlf = true;
    problemas.push(aviso('as respostas terminam com \\r\\n; o protocolo usa só \\n (regra 1.5). Em Java no Windows, println manda \\r\\n'));
  }
  if (bytes(r.linha) + 1 > LIMIT) problemas.push(falha(`resposta com ${bytes(r.linha) + 1} bytes; o limite é ${LIMIT}`));
  let data;
  try { data = JSON.parse(r.linha); } catch { data = undefined; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    problemas.push(falha(`a resposta não é um objeto JSON: ${trecho(r.linha)}`));
    return { data: null, problemas, linha: r.linha };
  }
  const opReq = typeof req === 'string' ? null : req.op;
  const conhecida = Boolean(opReq) && OPS.has(opReq) && opReq !== 'linha_invalida';
  const opEsperada = esperado.op || (conhecida ? `${opReq}_response` : 'error');
  if (data.op !== opEsperada) problemas.push(falha(`op ${JSON.stringify(data.op)}; esperado ${JSON.stringify(opEsperada)}`));

  if (data.op === 'error') {
    for (const e of validate(OPS.get('linha_invalida').res.payload, data)) problemas.push(falha(`fora do contrato: ${e.msg}`));
  } else if (conhecida && data.op === opEsperada) {
    const v = variantsOf(OPS.get(opReq).res).find((x) => x.status === data.status && x.message === data.message);
    if (!v) problemas.push(falha(`"${data.status} · ${data.message}" não é uma resposta prevista de ${opReq}`));
    else for (const e of validate(v.schema, data)) problemas.push(falha(`fora do contrato: ${e.msg}`));
  }

  const status = [].concat(esperado.status ?? []);
  if (status.length && !status.includes(data.status)) {
    problemas.unshift(falha(`recebeu ${data.status} · ${data.message}; esperado ${status.join(' ou ')}${esperado.message ? ` · ${esperado.message}` : ''}`));
  } else if (esperado.message && data.message !== esperado.message) {
    problemas.unshift(falha(`message ${JSON.stringify(data.message)}; esperado ${JSON.stringify(esperado.message)}`));
  }
  return { data, problemas, linha: r.linha };
}

// ───────────────────────── execução e relatório ─────────────────────────
class Pulo extends Error {}
const precisa = (valor, motivo) => { if (!valor) throw new Pulo(motivo); };
const resultados = [];
let grupoAtual = '';

function grupo(nome) {
  grupoAtual = nome;
  console.log(`\n${negrito(nome)}`);
}

async function teste(nome, fn) {
  let problemas = [];
  let status;
  try {
    problemas = (await fn()) || [];
    status = problemas.some((p) => !p.aviso) ? 'falhou' : 'passou';
  } catch (e) {
    status = e instanceof Pulo ? 'pulado' : 'falhou';
    problemas = [e instanceof Pulo ? aviso(e.message) : falha(e.message)];
  }
  resultados.push({ grupo: grupoAtual, nome, status, problemas });
  const marca = { passou: verde('✓'), falhou: vermelho('✗'), pulado: cinza('–') }[status];
  console.log(`  ${marca} ${status === 'pulado' ? cinza(nome) : nome}`);
  for (const p of problemas) {
    const linha = status === 'pulado' ? cinza(`pulado: ${p.texto}`) : p.aviso ? amarelo(`aviso: ${p.texto}`) : vermelho(p.texto);
    console.log(`      ${linha}`);
  }
}

const letras = (n) => Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz'[crypto.randomInt(26)]).join('');
function dia(desloc) {
  const d = new Date();
  d.setDate(d.getDate() + desloc);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ───────────────────────── bateria de testes ─────────────────────────
async function bateria(admin) {
  const sufixo = letras(6);
  const A = { user: `testea${sufixo}`, email: `testea.${sufixo}@teste.com.br`, senha: 'senha123' };
  const B = { user: `testeb${sufixo}`, email: `testeb.${sufixo}@alunos.utfpr.edu.br`, senha: 'senha123' };
  const ADM = admin;
  const cA = new Conexao();
  const cB = new Conexao();
  const cAdm = new Conexao();
  const cX = new Conexao();
  const sala = {};
  const reservas = [];
  const data1 = dia(30 + crypto.randomInt(60));
  const conexoes = [cA, cB, cAdm, cX];

  try {
    grupo('Formato e erros de protocolo (regras 1.x e 4.x)');
    await teste('JSON inválido → error 400 "Requisicao invalida"', async () =>
      (await chamar(cX, '{"op": "login", "email": ', { op: 'error', status: '400', message: 'Requisicao invalida' })).problemas);
    await teste('op desconhecida → error 400 "Operacao desconhecida"', async () =>
      (await chamar(cX, JSON.stringify({ op: 'reservar_tudo' }), { op: 'error', status: '400', message: 'Operacao desconhecida' })).problemas);
    await teste(`mensagem acima de ${LIMIT} bytes → error 400`, async () =>
      (await chamar(cX, JSON.stringify({ op: 'login', email: 'a'.repeat(9000), password: 'x' }), { op: 'error', status: '400', message: 'Mensagem excede o tamanho maximo' })).problemas);
    await teste('a conexão continua de pé depois de um erro (regra 4.5)', async () => {
      const antes = cX.aberturas;
      const { problemas } = await chamar(cX, { op: 'login', email: `ninguem.${sufixo}@teste.com.br`, password: 'senha123' }, { status: '401' });
      if (cX.aberturas !== antes) problemas.push(falha('o servidor fechou a conexão depois do erro; ele deve responder e continuar atendendo'));
      return problemas;
    });
    await teste('número no lugar de string → 400 (regra 2.3)', async () =>
      (await chamar(cX, { op: 'login', email: A.email, password: 123 }, { status: '400', message: 'Email ou senha em formato invalido' })).problemas);

    grupo('Cadastro e login');
    await teste('register → 201', async () => {
      const r = await chamar(cA, { op: 'register', email: A.email, user: A.user, password: A.senha }, { status: '201', message: 'Usuario cadastrado com sucesso' });
      A.cadastrado = r.data?.status === '201';
      return r.problemas;
    });
    await teste('register repetido → 409', async () => {
      precisa(A.cadastrado, 'o cadastro anterior falhou');
      return (await chamar(cA, { op: 'register', email: A.email, user: A.user, password: A.senha }, { status: '409', message: 'Usuario ou email ja cadastrado' })).problemas;
    });
    await teste('register com user fora do formato (com número) → 400', async () =>
      (await chamar(cA, { op: 'register', email: `outro.${sufixo}@teste.com.br`, user: `teste${sufixo}1`, password: 'senha123' }, { status: '400', message: 'Dados de cadastro em formato invalido' })).problemas);
    await teste('register com e-mail de vários níveis (alunos.utfpr.edu.br) → 201 (v2.1)', async () => {
      const r = await chamar(cB, { op: 'register', email: B.email, user: B.user, password: B.senha }, { status: '201' });
      B.cadastrado = r.data?.status === '201';
      return r.problemas;
    });
    await teste('login com senha errada → 401', async () => {
      precisa(A.cadastrado, 'o cadastro falhou');
      return (await chamar(cA, { op: 'login', email: A.email, password: 'senhaerrada9' }, { status: '401', message: 'Email ou senha incorretos' })).problemas;
    });
    await teste('login com e-mail inexistente → o mesmo 401', async () =>
      (await chamar(cA, { op: 'login', email: `ninguem.${sufixo}@teste.com.br`, password: 'senha123' }, { status: '401', message: 'Email ou senha incorretos' })).problemas);
    await teste('login → 200 com token e role "user"', async () => {
      precisa(A.cadastrado, 'o cadastro falhou');
      const { data, problemas } = await chamar(cA, { op: 'login', email: A.email, password: A.senha }, { status: '200' });
      if (data?.status === '200') {
        A.token = data.token;
        A.senhaAtual = A.senha;
        if (data.role !== 'user') problemas.push(falha(`role ${JSON.stringify(data.role)}; todo register nasce "user"`));
      }
      return problemas;
    });
    await teste('login com sessão ativa → 409', async () => {
      precisa(A.token, 'o login falhou');
      return (await chamar(cA, { op: 'login', email: A.email, password: A.senha }, { status: '409', message: 'Usuario ja possui sessao ativa' })).problemas;
    });
    await teste('login com sessão ativa e senha errada → 401, não 409 (v2.2, regra 3.12)', async () => {
      precisa(A.token, 'o login falhou');
      return (await chamar(cA, { op: 'login', email: A.email, password: 'senhaerrada9' }, { status: '401', message: 'Email ou senha incorretos' })).problemas;
    });
    await teste('login do segundo usuário → 200', async () => {
      precisa(B.cadastrado, 'o cadastro do segundo usuário falhou');
      const { data, problemas } = await chamar(cB, { op: 'login', email: B.email, password: B.senha }, { status: '200' });
      if (data?.status === '200') B.token = data.token;
      return problemas;
    });

    grupo('Token');
    await teste('token fora do formato → 400', async () =>
      (await chamar(cX, { op: 'read_user', token: 'abc' }, { status: '400', message: 'Token em formato invalido' })).problemas);
    await teste('token que não existe → 401', async () =>
      (await chamar(cX, { op: 'read_user', token: crypto.randomBytes(32).toString('hex') }, { status: '401', message: 'Token invalido ou expirado' })).problemas);
    await teste('requisição sem token → 400 ou 401 (pendência 1)', async () =>
      (await chamar(cX, { op: 'read_user' }, { status: ['400', '401'] })).problemas);

    grupo('Próprio cadastro');
    await teste('read_user → 200 com os próprios dados e sem senha', async () => {
      precisa(A.token, 'o login falhou');
      const { data, problemas } = await chamar(cA, { op: 'read_user', token: A.token }, { status: '200' });
      if (data?.status === '200') {
        if (data.user !== A.user) problemas.push(falha(`user ${JSON.stringify(data.user)}; esperado ${JSON.stringify(A.user)}`));
        if (data.email !== A.email) problemas.push(falha(`email ${JSON.stringify(data.email)}; esperado ${JSON.stringify(A.email)}`));
        if ('password' in data) problemas.push(falha('a resposta devolveu a senha'));
      }
      return problemas;
    });
    await teste('update_user com a chave email → 400 (RNF 5.c)', async () => {
      precisa(A.token, 'o login falhou');
      return (await chamar(cA, { op: 'update_user', token: A.token, user: A.user, password: '', email: `novo.${sufixo}@teste.com.br` }, { status: '400', message: 'Dados em formato invalido' })).problemas;
    });
    await teste('update_user com user e password vazios → 400 "Nenhum dado para atualizar" (v2.4)', async () => {
      precisa(A.token, 'o login falhou');
      return (await chamar(cA, { op: 'update_user', token: A.token, user: '', password: '' }, { status: '400', message: 'Nenhum dado para atualizar' })).problemas;
    });
    await teste('update_user para um user que já existe → 409', async () => {
      precisa(A.token && B.cadastrado, 'faltam os dois usuários de teste');
      return (await chamar(cA, { op: 'update_user', token: A.token, user: B.user, password: '' }, { status: '409', message: 'Usuario ja esta em uso' })).problemas;
    });
    await teste('update_user trocando só a senha → 200', async () => {
      precisa(A.token, 'o login falhou');
      const r = await chamar(cA, { op: 'update_user', token: A.token, user: '', password: 'novasenha1' }, { status: '200', message: 'Dados atualizados com sucesso' });
      if (r.data?.status === '200') A.senhaAtual = 'novasenha1';
      return r.problemas;
    });
    await teste('delete_user com senha errada → 403 "Senha incorreta" (v2.1)', async () => {
      precisa(A.token, 'o login falhou');
      return (await chamar(cA, { op: 'delete_user', token: A.token, password: 'senhaerrada9' }, { status: '403', message: 'Senha incorreta' })).problemas;
    });
    await teste('a sessão continua depois da senha errada (v2.1, regra 3.9)', async () => {
      precisa(A.token, 'o login falhou');
      const r = await chamar(cA, { op: 'read_user', token: A.token }, { status: '200' });
      if (r.data?.status === '401') r.problemas.push(falha('o servidor encerrou a sessão por causa da senha errada'));
      return r.problemas;
    });

    grupo('Administrador');
    if (!ADM) {
      await teste('testes de admin', () => precisa(false, 'sem conta de admin; rode com --admin email:senha'));
    } else {
      await teste('login do admin → 200 com role "admin"', async () => {
        const { data, problemas } = await chamar(cAdm, { op: 'login', email: ADM.email, password: ADM.senha }, { status: '200' });
        if (data?.status === '200') {
          if (data.role === 'admin') ADM.token = data.token;
          else problemas.push(falha(`a conta informada tem role ${JSON.stringify(data.role)}, não "admin"`));
        } else if (data?.status === '409') {
          problemas.push(aviso('o admin já tem sessão ativa: faça logout dele antes de rodar o testador'));
        }
        return problemas;
      });
      await teste('usuário comum em admin_list_users → 403', async () => {
        precisa(A.token, 'o login falhou');
        return (await chamar(cA, { op: 'admin_list_users', token: A.token }, { status: '403', message: 'Permissao insuficiente' })).problemas;
      });
      await teste('admin_list_users → 200 com o usuário de teste', async () => {
        precisa(ADM.token, 'o login do admin falhou');
        const { data, problemas } = await chamar(cAdm, { op: 'admin_list_users', token: ADM.token }, { status: '200' });
        if (data?.status === '200') {
          if (!data.users?.some((u) => u.user === A.user)) problemas.push(falha('o usuário de teste não apareceu na lista'));
          if (Array.isArray(data.users) && data.count !== String(data.users.length)) problemas.push(falha(`count ${data.count}, mas a lista tem ${data.users.length} itens`));
        }
        return problemas;
      });
      await teste('admin_read_user → 200', async () => {
        precisa(ADM.token && A.cadastrado, 'faltam o admin ou o usuário de teste');
        return (await chamar(cAdm, { op: 'admin_read_user', token: ADM.token, target_user: A.user }, { status: '200' })).problemas;
      });
      await teste('admin_read_user de usuário inexistente → 404', async () => {
        precisa(ADM.token, 'o login do admin falhou');
        return (await chamar(cAdm, { op: 'admin_read_user', token: ADM.token, target_user: `naoexiste${sufixo}` }, { status: '404', message: 'Usuario nao encontrado' })).problemas;
      });
      await teste('admin_update_user com user, password e role vazios → 400 "Nenhum dado para atualizar" (v2.4)', async () => {
        precisa(ADM.token && B.cadastrado, 'faltam o admin ou o usuário de teste');
        return (await chamar(cAdm, { op: 'admin_update_user', token: ADM.token, target_user: B.user, user: '', password: '', role: '' }, { status: '400', message: 'Nenhum dado para atualizar' })).problemas;
      });
      await teste('admin_update_user trocando só a senha → 200', async () => {
        precisa(ADM.token && B.cadastrado, 'faltam o admin ou o usuário de teste');
        return (await chamar(cAdm, { op: 'admin_update_user', token: ADM.token, target_user: B.user, user: '', password: 'outrasenha2', role: '' }, { status: '200', message: 'Dados atualizados com sucesso' })).problemas;
      });
    }

    grupo('Salas');
    if (ADM?.token) {
      await teste('create_room → 201 com room_id', async () => {
        const { data, problemas } = await chamar(cAdm, { op: 'create_room', token: ADM.token, name: `Sala Teste ${sufixo}`, capacity: '10', location: 'Bloco T - teste', resources: ['projetor'] }, { status: '201', message: 'Sala cadastrada com sucesso' });
        if (data?.status === '201') Object.assign(sala, { id: data.room_id, capacidade: 10, criada: true });
        return problemas;
      });
      await teste('create_room com nome repetido → 409', async () => {
        precisa(sala.criada, 'a sala de teste não foi criada');
        return (await chamar(cAdm, { op: 'create_room', token: ADM.token, name: `Sala Teste ${sufixo}`, capacity: '10', location: 'Bloco T - teste', resources: [] }, { status: '409', message: 'Sala ja cadastrada' })).problemas;
      });
      await teste('usuário comum em create_room → 403', async () => {
        precisa(A.token, 'o login falhou');
        return (await chamar(cA, { op: 'create_room', token: A.token, name: `Sala Outra ${sufixo}`, capacity: '10', location: 'Bloco T', resources: [] }, { status: '403', message: 'Permissao insuficiente' })).problemas;
      });
    } else {
      await teste('escolher uma sala ativa já cadastrada para os testes', async () => {
        precisa(A.token, 'o login falhou');
        const { data, problemas } = await chamar(cA, { op: 'list_rooms', token: A.token }, { status: '200' });
        const s = data?.rooms?.find((r) => r.room_status === 'active');
        precisa(s, 'nenhuma sala ativa no servidor; rode com --admin para o testador criar uma');
        Object.assign(sala, { id: s.room_id, capacidade: Number(s.capacity) });
        return problemas;
      });
    }
    await teste('read_room → 200', async () => {
      precisa(sala.id && A.token, 'não há sala para testar');
      const { data, problemas } = await chamar(cA, { op: 'read_room', token: A.token, room_id: sala.id }, { status: '200' });
      if (data?.status === '200' && data.room_id !== sala.id) problemas.push(falha(`room_id ${JSON.stringify(data.room_id)}; esperado ${JSON.stringify(sala.id)}`));
      return problemas;
    });
    await teste('read_room de sala inexistente → 404', async () => {
      precisa(A.token, 'o login falhou');
      return (await chamar(cA, { op: 'read_room', token: A.token, room_id: '999999999' }, { status: '404', message: 'Sala nao encontrada' })).problemas;
    });
    await teste('list_rooms sem filtros → 200, sem o campo available', async () => {
      precisa(A.token, 'o login falhou');
      const { data, problemas } = await chamar(cA, { op: 'list_rooms', token: A.token }, { status: '200' });
      if (data?.status === '200') {
        if (sala.id && !data.rooms?.some((r) => r.room_id === sala.id)) problemas.push(falha('a sala de teste não apareceu na lista'));
        if (data.rooms?.some((r) => 'available' in r)) problemas.push(falha('sem date/start_time/end_time, o campo available deve ser omitido'));
      }
      return problemas;
    });
    await teste('list_rooms só com date → 400', async () => {
      precisa(A.token, 'o login falhou');
      return (await chamar(cA, { op: 'list_rooms', token: A.token, date: data1 }, { status: '400', message: 'Filtros em formato invalido' })).problemas;
    });
    await teste('list_rooms com date, start_time e end_time → 200 com available', async () => {
      precisa(A.token, 'o login falhou');
      const { data, problemas } = await chamar(cA, { op: 'list_rooms', token: A.token, date: data1, start_time: '14:00', end_time: '16:00' }, { status: '200' });
      if (data?.status === '200' && data.rooms?.some((r) => !('available' in r))) problemas.push(falha('com o trio de horário, toda sala deve trazer available'));
      return problemas;
    });
    if (sala.criada) {
      await teste('update_room mudando a capacidade → 200', async () => {
        const r = await chamar(cAdm, { op: 'update_room', token: ADM.token, room_id: sala.id, name: '', capacity: '12', location: '', resources: ['projetor'], room_status: '' }, { status: '200', message: 'Sala atualizada com sucesso' });
        if (r.data?.status === '200') sala.capacidade = 12;
        return r.problemas;
      });
    }

    grupo('Reservas');
    const reserva = (tok, ini, fim, extra = {}) => ({ op: 'create_reservation', token: tok, room_id: sala.id, date: data1, start_time: ini, end_time: fim, topic: 'Teste automatico', participants: '4', ...extra });
    const guardar = (data, dono) => { if (data?.status === '201') reservas.push({ id: data.reservation_id, dono }); return data?.reservation_id; };
    await teste('check_availability num horário livre → available "true"', async () => {
      precisa(sala.id && A.token, 'não há sala para testar');
      const { data, problemas } = await chamar(cA, { op: 'check_availability', token: A.token, room_id: sala.id, date: data1, start_time: '14:00', end_time: '16:00' }, { status: '200' });
      if (data?.status === '200' && data.available !== 'true') {
        if (!sala.criada) throw new Pulo(`o horário ${data1} 14:00 já está ocupado nessa sala; rode de novo`);
        problemas.push(falha(`available ${JSON.stringify(data.available)}; a sala de teste está vazia`));
      }
      return problemas;
    });
    await teste('create_reservation → 201 com reservation_id', async () => {
      precisa(sala.id && A.token, 'não há sala para testar');
      const r = await chamar(cA, reserva(A.token, '14:00', '16:00'), { status: '201', message: 'Reserva realizada com sucesso' });
      sala.reservaA = guardar(r.data, A);
      return r.problemas;
    });
    await teste('check_availability no horário reservado → available "false"', async () => {
      precisa(sala.reservaA, 'a reserva não foi criada');
      const { data, problemas } = await chamar(cA, { op: 'check_availability', token: A.token, room_id: sala.id, date: data1, start_time: '15:00', end_time: '15:30' }, { status: '200' });
      if (data?.status === '200' && data.available !== 'false') problemas.push(falha(`available ${JSON.stringify(data.available)}; o horário está reservado`));
      return problemas;
    });
    await teste('outra reserva no mesmo horário → 409', async () => {
      precisa(sala.reservaA && B.token, 'falta a reserva ou o segundo usuário');
      const r = await chamar(cB, reserva(B.token, '15:00', '17:00'), { status: '409', message: 'Sala ja reservada no periodo solicitado' });
      guardar(r.data, B);
      return r.problemas;
    });
    await teste('reserva que começa no fim da outra → 201 (regra 5.4)', async () => {
      precisa(sala.reservaA && B.token, 'falta a reserva ou o segundo usuário');
      const r = await chamar(cB, reserva(B.token, '16:00', '17:00'), { status: '201' });
      sala.reservaB = guardar(r.data, B);
      return r.problemas;
    });
    await teste('end_time antes do start_time → 400', async () => {
      precisa(sala.id && A.token, 'não há sala para testar');
      const r = await chamar(cA, reserva(A.token, '12:00', '11:00'), { status: '400', message: 'Dados da reserva em formato invalido' });
      guardar(r.data, A);
      return r.problemas;
    });
    await teste('data passada → 400', async () => {
      precisa(sala.id && A.token, 'não há sala para testar');
      const r = await chamar(cA, reserva(A.token, '10:00', '11:00', { date: dia(-1) }), { status: '400', message: 'Dados da reserva em formato invalido' });
      guardar(r.data, A);
      return r.problemas;
    });
    await teste('participants acima da capacity → 400', async () => {
      precisa(sala.id && A.token, 'não há sala para testar');
      const r = await chamar(cA, reserva(A.token, '12:00', '13:00', { participants: String(sala.capacidade + 1) }), { status: '400', message: 'Dados da reserva em formato invalido' });
      guardar(r.data, A);
      return r.problemas;
    });
    await teste('list_reservations (minhas) → 200 com a reserva', async () => {
      precisa(sala.reservaA, 'a reserva não foi criada');
      const { data, problemas } = await chamar(cA, { op: 'list_reservations', token: A.token, scope: 'mine' }, { status: '200' });
      if (data?.status === '200') {
        if (!data.reservations?.some((r) => r.reservation_id === sala.reservaA)) problemas.push(falha('a reserva de teste não apareceu'));
        if (data.reservations?.some((r) => r.user !== A.user)) problemas.push(falha('scope "mine" trouxe reserva de outro usuário'));
      }
      return problemas;
    });
    await teste('usuário comum com scope "all" → 403', async () => {
      precisa(A.token, 'o login falhou');
      return (await chamar(cA, { op: 'list_reservations', token: A.token, scope: 'all' }, { status: '403', message: 'Permissao insuficiente' })).problemas;
    });
    if (ADM?.token) {
      await teste('admin com scope "all" → 200', async () => {
        precisa(sala.reservaA, 'a reserva não foi criada');
        const { data, problemas } = await chamar(cAdm, { op: 'list_reservations', token: ADM.token, scope: 'all', room_id: sala.id }, { status: '200' });
        if (data?.status === '200' && !data.reservations?.some((r) => r.reservation_id === sala.reservaA)) problemas.push(falha('a reserva de teste não apareceu'));
        return problemas;
      });
    }
    await teste('read_reservation do dono → 200', async () => {
      precisa(sala.reservaA, 'a reserva não foi criada');
      return (await chamar(cA, { op: 'read_reservation', token: A.token, reservation_id: sala.reservaA }, { status: '200' })).problemas;
    });
    await teste('read_reservation de outro usuário → 403', async () => {
      precisa(sala.reservaA && B.token, 'falta a reserva ou o segundo usuário');
      return (await chamar(cB, { op: 'read_reservation', token: B.token, reservation_id: sala.reservaA }, { status: '403', message: 'Permissao insuficiente' })).problemas;
    });
    await teste('read_reservation inexistente → 404', async () => {
      precisa(A.token, 'o login falhou');
      return (await chamar(cA, { op: 'read_reservation', token: A.token, reservation_id: '999999999' }, { status: '404', message: 'Reserva nao encontrada' })).problemas;
    });
    await teste('update_reservation estendendo por cima de outra reserva → 409', async () => {
      precisa(sala.reservaA && sala.reservaB, 'faltam as duas reservas');
      return (await chamar(cA, { op: 'update_reservation', token: A.token, reservation_id: sala.reservaA, start_time: '', end_time: '16:30', topic: '', participants: '' }, { status: '409', message: 'Sala ja reservada no periodo solicitado' })).problemas;
    });
    await teste('update_reservation encurtando ("" no resto) → 200', async () => {
      precisa(sala.reservaA, 'a reserva não foi criada');
      return (await chamar(cA, { op: 'update_reservation', token: A.token, reservation_id: sala.reservaA, start_time: '', end_time: '15:30', topic: '', participants: '' }, { status: '200', message: 'Reserva atualizada com sucesso' })).problemas;
    });
    if (sala.criada) {
      await teste('delete_room com reservas futuras → 409', async () => {
        precisa(sala.reservaA, 'a reserva não foi criada');
        return (await chamar(cAdm, { op: 'delete_room', token: ADM.token, room_id: sala.id }, { status: '409', message: 'Sala possui reservas ativas' })).problemas;
      });
    }
    await teste('duas reservas simultâneas no mesmo horário → uma 201 e uma 409 (regra 5.1, 5 rodadas)', async () => {
      precisa(sala.id && A.token && B.token, 'faltam a sala ou os dois usuários');
      const problemas = [];
      for (const [ini, fim] of [['07:00', '08:00'], ['09:00', '10:00'], ['11:00', '12:00'], ['18:00', '19:00'], ['20:00', '21:00']]) {
        const c1 = new Conexao();
        const c2 = new Conexao();
        await Promise.all([c1.abrir(), c2.abrir()]);
        const [r1, r2] = await Promise.all([chamar(c1, reserva(A.token, ini, fim, { participants: '2' })), chamar(c2, reserva(B.token, ini, fim, { participants: '2' }))]);
        c1.fechar();
        c2.fechar();
        guardar(r1.data, A);
        guardar(r2.data, B);
        problemas.push(...r1.problemas, ...r2.problemas);
        const st = [r1.data?.status, r2.data?.status].sort().join(' e ');
        if (st === '201 e 201') { problemas.push(falha(`${ini}–${fim}: as duas foram aceitas. Verificar e gravar não estão na mesma seção crítica (lock por room_id)`)); break; }
        if (st !== '201 e 409') { problemas.push(falha(`${ini}–${fim}: respostas ${st}; esperado uma 201 e uma 409`)); break; }
      }
      return problemas;
    });
    await teste('delete_reservation do dono → 200', async () => {
      precisa(sala.reservaA, 'a reserva não foi criada');
      const r = await chamar(cA, { op: 'delete_reservation', token: A.token, reservation_id: sala.reservaA }, { status: '200', message: 'Reserva cancelada com sucesso' });
      const i = reservas.findIndex((x) => x.id === sala.reservaA);
      if (r.data?.status === '200' && i >= 0) reservas.splice(i, 1);
      return r.problemas;
    });
    await teste('delete_reservation de novo → 404', async () => {
      precisa(sala.reservaA, 'a reserva não foi criada');
      return (await chamar(cA, { op: 'delete_reservation', token: A.token, reservation_id: sala.reservaA }, { status: '404', message: 'Reserva nao encontrada' })).problemas;
    });

    grupo('Sessão e logout (v2.2)');
    await teste('o token continua valendo numa conexão nova (regra 1.11)', async () => {
      precisa(A.token, 'o login falhou');
      cA.fechar();
      return (await chamar(cA, { op: 'read_user', token: A.token }, { status: '200' })).problemas;
    });
    await teste('logout → 200', async () => {
      precisa(A.token, 'o login falhou');
      const r = await chamar(cA, { op: 'logout', token: A.token }, { status: '200', message: 'Logout realizado com sucesso' });
      if (r.data?.status === '200') A.saiu = true;
      return r.problemas;
    });
    await teste('token depois do logout → 401', async () => {
      precisa(A.saiu, 'o logout falhou');
      return (await chamar(cA, { op: 'read_user', token: A.token }, { status: '401', message: 'Token invalido ou expirado' })).problemas;
    });
    await teste('logout repetido → 401', async () => {
      precisa(A.saiu, 'o logout falhou');
      return (await chamar(cA, { op: 'logout', token: A.token }, { status: '401', message: 'Token invalido ou expirado' })).problemas;
    });
    await teste('dois logins simultâneos na mesma conta → um 200 e um 409 (regra 3.11)', async () => {
      precisa(A.saiu, 'o logout falhou');
      const c1 = new Conexao();
      const c2 = new Conexao();
      await Promise.all([c1.abrir(), c2.abrir()]);
      const login = { op: 'login', email: A.email, password: A.senhaAtual };
      const [r1, r2] = await Promise.all([chamar(c1, login), chamar(c2, login)]);
      c1.fechar();
      c2.fechar();
      const tokens = [r1, r2].filter((r) => r.data?.status === '200').map((r) => r.data.token);
      A.token = tokens[0];
      A.extras = tokens.slice(1);
      const problemas = [...r1.problemas, ...r2.problemas];
      const st = [r1.data?.status, r2.data?.status].sort().join(' e ');
      if (st === '200 e 200') problemas.push(falha('as duas sessões foram criadas. Checar e criar a sessão não estão na mesma seção crítica'));
      else if (st !== '200 e 409') problemas.push(falha(`respostas ${st}; esperado um 200 e um 409`));
      return problemas;
    });

    grupo('Remoção de conta e limpeza (v2.3)');
    await teste('apagar as reservas que sobraram', async () => {
      const problemas = [];
      for (const r of reservas.splice(0)) {
        const tok = r.dono.token;
        if (!tok) continue;
        problemas.push(...(await chamar(r.dono === A ? cA : cB, { op: 'delete_reservation', token: tok, reservation_id: r.id }, { status: '200' })).problemas);
      }
      return problemas;
    });
    if (sala.criada) {
      await teste('delete_room sem reservas → 200', async () =>
        (await chamar(cAdm, { op: 'delete_room', token: ADM.token, room_id: sala.id }, { status: '200', message: 'Sala removida com sucesso' })).problemas);
    }
    await teste('delete_user com a senha certa → 200', async () => {
      precisa(A.token, 'não há sessão do usuário de teste');
      const r = await chamar(cA, { op: 'delete_user', token: A.token, password: A.senhaAtual }, { status: '200', message: 'Usuario removido com sucesso' });
      if (r.data?.status === '200') A.removido = true;
      return r.problemas;
    });
    await teste('token de usuário removido → 401', async () => {
      precisa(A.removido, 'o usuário não foi removido');
      return (await chamar(cA, { op: 'read_user', token: A.token }, { status: '401' })).problemas;
    });
    await teste('user e email ficam livres: register com os mesmos dados → 201 (v2.3, regra 3.13)', async () => {
      precisa(A.removido, 'o usuário não foi removido');
      const r = await chamar(cA, { op: 'register', email: A.email, user: A.user, password: A.senha }, { status: '201' });
      if (r.data?.status === '201') A.recadastrado = true;
      else if (r.data?.status === '409') r.problemas.push(falha('o servidor guardou os dados da conta removida'));
      return r.problemas;
    });
    if (ADM?.token) {
      await teste('admin_delete_user do segundo usuário → 200', async () => {
        precisa(B.cadastrado, 'o segundo usuário não foi cadastrado');
        const r = await chamar(cAdm, { op: 'admin_delete_user', token: ADM.token, target_user: B.user }, { status: '200', message: 'Usuario removido com sucesso' });
        if (r.data?.status === '200') B.removido = true;
        return r.problemas;
      });
      await teste('sessão de quem foi removido pelo admin → 401', async () => {
        precisa(B.removido && B.token, 'o segundo usuário não foi removido');
        return (await chamar(cB, { op: 'read_user', token: B.token }, { status: '401' })).problemas;
      });
    } else {
      await teste('delete_user do segundo usuário → 200', async () => {
        precisa(B.token, 'não há sessão do segundo usuário');
        const r = await chamar(cB, { op: 'delete_user', token: B.token, password: B.senha }, { status: '200' });
        if (r.data?.status === '200') B.removido = true;
        return r.problemas;
      });
    }
    await teste('o e-mail do segundo usuário também fica livre → 201', async () => {
      precisa(B.removido, 'o segundo usuário não foi removido');
      const r = await chamar(cB, { op: 'register', email: B.email, user: B.user, password: B.senha }, { status: '201' });
      if (r.data?.status === '201') B.recadastrado = true;
      return r.problemas;
    });
    await teste('remover os cadastros refeitos', async () => {
      const problemas = [];
      for (const [p, con] of [[A, cA], [B, cB]]) {
        if (!p.recadastrado) continue;
        const l = await chamar(con, { op: 'login', email: p.email, password: p.senha }, { status: '200' });
        problemas.push(...l.problemas);
        if (l.data?.status === '200') problemas.push(...(await chamar(con, { op: 'delete_user', token: l.data.token, password: p.senha }, { status: '200' })).problemas);
      }
      return problemas;
    });
    if (ADM?.token) {
      await teste('logout do admin → 200', async () => (await chamar(cAdm, { op: 'logout', token: ADM.token }, { status: '200' })).problemas);
    }
  } finally {
    for (const c of conexoes) c.fechar();
  }
}

// ───────────────────────── modo interativo ─────────────────────────
async function interativo() {
  const con = new Conexao();
  await con.abrir();
  console.log(`Conectado em ${host}:${porta}. Digite uma mensagem JSON, ou só o nome de uma operação (ex.: login)
para mandar o exemplo do contrato. "ops" lista as operações e "sair" encerra.`);
  // Iterar o readline guarda as linhas que chegam enquanto esperamos o servidor (ex.: várias linhas coladas)
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  let aberto = true;
  rl.on('close', () => { aberto = false; });
  rl.setPrompt('> ');
  rl.prompt();
  let token = '';
  try {
    for await (const linhaDigitada of rl) {
      const entrada = linhaDigitada.trim();
      if (entrada === 'sair' || entrada === 'exit') break;
      await processar(entrada);
      if (aberto) rl.prompt();
    }
  } finally {
    rl.close();
    con.fechar();
  }

  async function processar(entrada) {
    if (!entrada) return;
    if (entrada === 'ops') { console.log([...OPS.keys()].filter((k) => k !== 'linha_invalida').join('  ')); return; }
    let req = entrada;
    if (/^[a-z_]+$/.test(entrada)) {
      const ex = OPS.get(entrada)?.req?.examples?.[0]?.payload;
      if (!ex || typeof ex !== 'object') { console.log(amarelo('operação desconhecida; digite "ops" para ver a lista')); return; }
      const obj = { ...ex };
      if (token && 'token' in obj) obj.token = token;
      req = oneLine(obj);
      console.log(cinza(`enviando: ${req}`));
    }
    let obj = null;
    try { obj = JSON.parse(req); } catch { obj = null; }
    try {
      const { data, problemas, linha } = await chamar(con, obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : req);
      console.log(`< ${linha}`);
      if (data?.op === 'login_response' && data.status === '200') { token = data.token; console.log(cinza('token guardado para as próximas mensagens')); }
      for (const p of problemas) console.log(p.aviso ? amarelo(`  aviso: ${p.texto}`) : vermelho(`  ✗ ${p.texto}`));
      if (!problemas.some((p) => !p.aviso)) console.log(verde('  ✓ resposta dentro do contrato'));
    } catch (e) {
      console.log(vermelho(`  ✗ ${e.message}`));
    }
  }
}

// ───────────────────────── início ─────────────────────────
async function main() {
  if (!host || !porta || (!modoInterativo && adminTexto === undefined && process.stdin.isTTY)) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      if (!host) host = (await rl.question('IP do servidor [127.0.0.1]: ')).trim() || '127.0.0.1';
      if (!porta) porta = (await rl.question('Porta do servidor: ')).trim();
      if (!modoInterativo && adminTexto === undefined) {
        adminTexto = (await rl.question('Conta de admin para os testes de admin e salas (email:senha, Enter para pular): ')).trim();
      }
    } finally {
      rl.close();
    }
  }
  if (!/^\d{1,5}$/.test(String(porta)) || Number(porta) > 65535) {
    console.error(vermelho(`Porta inválida: ${porta}`));
    process.exit(2);
  }
  let admin = null;
  if (adminTexto) {
    const i = adminTexto.indexOf(':');
    if (i < 1) { console.error(vermelho('Use --admin email:senha')); process.exit(2); }
    admin = { email: adminTexto.slice(0, i), senha: adminTexto.slice(i + 1) };
  }

  const teste1 = new Conexao();
  try {
    await teste1.abrir();
  } catch (e) {
    console.error(vermelho(`${e.message}. O servidor está rodando? O IP e a porta estão certos?`));
    process.exit(2);
  } finally {
    teste1.fechar();
  }

  if (modoInterativo) return interativo();

  console.log(`Testando ${negrito(`${host}:${porta}`)} contra o contrato ${negrito(`v${SPEC.info.version}`)} (asyncapi.yaml)`);
  await bateria(admin);
  const n = (st) => resultados.filter((r) => r.status === st).length;
  console.log(`\n${negrito('Resultado:')} ${verde(`${n('passou')} passaram`)}, ${n('falhou') ? vermelho(`${n('falhou')} falharam`) : '0 falharam'}, ${cinza(`${n('pulado')} pulados`)} (de ${resultados.length} testes)`);
  if (n('falhou')) {
    console.log(`\n${negrito('Falhas:')}`);
    for (const r of resultados.filter((x) => x.status === 'falhou')) {
      console.log(`  ${vermelho('✗')} ${r.grupo} › ${r.nome}`);
      for (const p of r.problemas.filter((x) => !x.aviso)) console.log(`      ${p.texto}`);
    }
  }
  process.exitCode = n('falhou') ? 1 : 0;
}

main().catch((e) => {
  console.error(vermelho(e.stack || e.message));
  process.exit(2);
});
