# Protocolo · Reserva de Salas

Protocolo de troca de mensagens do **Sistema Inteligente de Reserva de Salas de Reunião/Estudo em Campus**,
da disciplina de Sistemas Distribuídos (BCC, UTFPR-PG, Prof. Dr. Richard Ribeiro).
Responsáveis pelo protocolo: Pedro Silveira e Daniel Jesus.

**Documentação:** https://pedrosalvatori.github.io/protocolo-reserva-salas/

O contrato está em [`asyncapi.yaml`](asyncapi.yaml) (AsyncAPI 3.0), o equivalente do Swagger/OpenAPI para APIs
de mensagens. A página acima é montada a partir dele: editou o YAML e deu push, a documentação muda.

## Resumo

| | |
|---|---|
| Transporte | TCP. O servidor escuta numa porta digitada e usa uma thread por conexão. |
| Mensagem | 1 objeto JSON em **uma linha**, UTF-8, terminado por `\n`, até 8192 bytes. |
| Interação | Cada requisição recebe exatamente 1 resposta; o `op` da resposta é o `op` da requisição + `_response`. |
| Valores | Todos são strings: `"capacity": "12"`, `"available": "true"`. |
| Autenticação | O `login` devolve um `token` de 64 hex, que vai em toda requisição, exceto `register` e `login`. Vale 30 min sem uso. |
| Operações | 21: autenticação (3), próprio cadastro (3), administrador (4), salas (5) e reservas (6). |

## Usando a documentação

- **Busca** (tecla `/`): filtra pelo nome da operação, por campo (`room_id`), por mensagem (`Token invalido`) ou por status (`409`).
  O endereço ganha `?q=`, então dá para mandar o link da busca para o grupo.
- **Link direto:** abrir uma operação muda o endereço para `#/grupo/operacao`.
- **Try it out:** parte do exemplo da operação, valida a mensagem contra o contrato, gera o comando `nc` (Linux/macOS)
  ou PowerShell para mandar ao seu servidor e valida a resposta que ele devolveu. Cole o token do `login` em
  **Token da sessão** para ele entrar nas próximas mensagens.

## Editando o protocolo

1. Edite o `asyncapi.yaml`. No VS Code, a extensão **AsyncAPI Preview** mostra a prévia (`Ctrl+Shift+P` → `AsyncAPI: Preview`).
2. Valide com `npm install` e `npm run validate`. O script confere a estrutura com o parser oficial do AsyncAPI
   e valida todos os exemplos contra os esquemas.
3. Para ver a página na sua máquina, sirva a pasta por HTTP: `python -m http.server 8000` (ou `npm run serve`)
   e abra http://localhost:8000 (ou http://localhost:3000). Abrir o `index.html` com dois cliques não funciona:
   o navegador bloqueia os scripts em arquivos locais.
4. Faça commit e push. O GitHub Actions roda a mesma validação em todo push e pull request, e o GitHub Pages publica a página.

## Fluxos

O AsyncAPI descreve cada mensagem, mas não a ordem entre elas. Estes três diagramas cobrem isso.

### Ordem sugerida de validação no servidor

A planilha não fixa a precedência entre 400, 401, 403, 404 e 409 (pendência 6).

```mermaid
flowchart TD
  A(["linha recebida até o LF"]) --> B{"mais de 8192 bytes?"}
  B -- sim --> E1["error · 400<br/>Mensagem excede o tamanho maximo"]
  B -- não --> C{"JSON válido?"}
  C -- não --> E2["error · 400<br/>Requisicao invalida"]
  C -- sim --> D{"op conhecida?"}
  D -- não --> E3["error · 400<br/>Operacao desconhecida"]
  D -- sim --> F{"campos obrigatórios presentes,<br/>strings e aprovados na regex?"}
  F -- não --> R400["400 · mensagem da operação"]
  F -- sim --> G{"register ou login?"}
  G -- sim --> L
  G -- não --> H{"token ativo?"}
  H -- não --> R401["401 · Token invalido ou expirado"]
  H -- sim --> I["renova a validade: 30 min"]
  I --> J{"tem permissão?<br/>admin_*, criar/alterar/remover sala,<br/>scope all, reserva de terceiro"}
  J -- não --> R403["403 · Permissao insuficiente"]
  J -- sim --> K{"recurso existe?"}
  K -- não --> R404["404 · Usuario / Sala / Reserva nao encontrada"]
  K -- sim --> L{"conflito com o estado atual?<br/>reservas: dentro do lock por room_id"}
  L -- sim --> R409["409 · conflito"]
  L -- não --> OK(["executa → 200 / 201"])
  OK -. falha inesperada .-> R500["500 · Erro interno do servidor"]
```

### Sessão e token

```mermaid
stateDiagram-v2
  direction LR
  state "Sem sessão" as SemSessao
  state "Sessão ativa" as Ativa
  state "Token expirado" as Expirado
  state "Token invalidado" as Invalidado
  [*] --> SemSessao
  SemSessao --> SemSessao: register → 201, não cria sessão
  SemSessao --> Ativa: login → 200, gera token
  Ativa --> Ativa: requisição válida → renova 30 min
  Ativa --> Ativa: novo login → 409, sessão única
  Ativa --> Invalidado: logout → 200
  Ativa --> Invalidado: delete_user ou admin_delete_user
  Ativa --> Expirado: 30 min sem uso
  Expirado --> SemSessao: qualquer requisição com o token → 401
  Invalidado --> SemSessao: o token nunca é reutilizado
  note right of Ativa
    A conexão cai após 300 s inativa,
    mas o token continua válido.
    Se o cliente perder o token,
    novo login responde 409 até expirar.
  end note
```

### Concorrência: lock por sala

Verificar a disponibilidade e gravar a reserva acontecem na mesma seção crítica, com lock por `room_id`.
O primeiro a obter o lock recebe 201; o segundo, 409.

```mermaid
sequenceDiagram
  participant A as Cliente A
  participant TA as Thread A
  participant L as lock sala 1
  participant TB as Thread B
  participant B as Cliente B
  par pedido do cliente A
    A->>TA: create_reservation sala 1, 2026-09-15, 14:00 às 16:00
  and pedido do cliente B
    B->>TB: create_reservation sala 1, 2026-09-15, 14:00 às 16:00
  end
  TA->>L: acquire
  TB->>L: acquire
  Note over TB,L: a thread B fica bloqueada
  critical seção crítica da thread A
    TA->>TA: sem sobreposição, grava a reserva 27
  end
  TA->>L: release
  TA-->>A: 201 · Reserva realizada com sucesso + "reservation_id": "27"
  L-->>TB: lock concedido
  critical seção crítica da thread B
    TB->>TB: sobrepõe a reserva 27
  end
  TB->>L: release
  TB-->>B: 409 · Sala ja reservada no periodo solicitado
```

## Pendências

Pontos que a planilha v2.0 não resolve e que afetam a conversa entre implementações de grupos diferentes:

1. **Token ausente:** a regra 2.10 manda responder 400 (campo obrigatório ausente), mas a aba *Códigos de Status* lista "token ausente" como 401.
2. **`delete_user` com senha incorreta** responde 401, mas não há `message` definida para esse caso.
3. **`update_room` reduzindo `capacity`** abaixo dos `participants` de uma reserva futura responde 409, sem `message` definida.
4. **`scope` e `min_capacity`** aparecem nas mensagens, mas não no Dicionário. No contrato ficou `scope` ∈ {mine, all} e `min_capacity` no formato de `capacity`.
5. **`resources` em atualização:** a regra 2.11 (`""` = não alterar) não cobre arrays. `[]` esvazia a lista ou mantém?
6. **Precedência de erros** não definida. Um usuário comum que envia `create_room` inválido recebe 400 ou 403?
7. **Sessão presa:** se a conexão cair e o cliente perder o token, um novo login responde 409 por até 30 min, e o logout exige o token perdido.
8. **Maiúsculas:** a regra 2.12 diz que `user` e `email` são gravados em minúsculas, mas as regex rejeitam maiúsculas. Converter ou responder 400?
9. **Estados de sala:** uma nota na planilha cita "fechada para limpeza, ocupado", mas `room_status` só aceita `active` e `inactive`.
10. **`update_reservation` pelo admin:** `read_reservation` e `delete_reservation` dizem que o admin age sobre qualquer reserva; `update_reservation` não diz. No contrato ficou só o dono.

## Estrutura

```
asyncapi.yaml            contrato do protocolo (fonte da verdade)
index.html, assets/      documentação no estilo Swagger, montada no navegador a partir do YAML
assets/validator.js      validador do Try it out (o CI confere que ele concorda com o Ajv)
assets/vendor/           js-yaml e marked (licença MIT)
scripts/validate.mjs     validação da especificação e dos exemplos
.github/workflows/       CI: npm run validate em todo push e pull request
```
